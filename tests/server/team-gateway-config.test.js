const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createTeamGatewayConfig,
  buildTrustedProxyAuth,
  kIdentityHeaderName,
} = require("../../lib/server/team/gateway-config");
const { createTeamStateStore } = require("../../lib/server/team/state");
const { createTeamPresence } = require("../../lib/server/team/presence");

const kMembers = [
  { email: "owner@example.com", role: "admin", disabled: false },
  { email: "member@example.com", role: "member", disabled: false },
  { email: "gone@example.com", role: "member", disabled: true },
];

describe("server/team/gateway-config (4.4)", () => {
  it("builds trusted-proxy auth from the ACTIVE roster only", () => {
    const auth = buildTrustedProxyAuth({ members: kMembers });
    expect(auth.mode).toBe("trusted-proxy");
    expect(auth.trustedProxy.userHeader).toBe(kIdentityHeaderName);
    expect(auth.trustedProxy.allowLoopback).toBe(true);
    // A disabled member loses GATEWAY authority, not just AlphaClaw login (E-C8).
    expect(auth.trustedProxy.allowUsers).toEqual([
      "owner@example.com",
      "member@example.com",
    ]);
    expect(auth.trustedProxy.identityScopes["owner@example.com"]).toContain(
      "operator.admin",
    );
    expect(
      auth.trustedProxy.identityScopes["member@example.com"],
    ).not.toContain("operator.admin");
    expect(auth.trustedProxy.identityScopes["gone@example.com"]).toBeUndefined();
    // Upstream CRITICAL finding: device auto-approve never grants admin.
    expect(auth.trustedProxy.deviceAutoApprove.scopes).not.toContain(
      "operator.admin",
    );
    expect(auth.trustedProxy.deviceAutoApprove.enabled).toBe(true);
  });

  it("intersects scope names against the advertised set (CEO finding 8)", () => {
    const auth = buildTrustedProxyAuth({
      members: kMembers,
      advertisedScopes: ["read", "operator.admin"],
    });
    expect(auth.trustedProxy.identityScopes["owner@example.com"]).toEqual([
      "read",
      "operator.admin",
    ]);
    expect(auth.trustedProxy.identityScopes["member@example.com"]).toEqual([
      "read",
    ]);
    expect(auth.trustedProxy.deviceAutoApprove.scopes).toEqual(["read"]);
    // Unknown advertised set → defaults written unchanged.
    const unknown = buildTrustedProxyAuth({
      members: kMembers,
      advertisedScopes: null,
    });
    expect(unknown.trustedProxy.identityScopes["member@example.com"]).toEqual([
      "read",
      "write",
      "approvals",
    ]);
  });

  describe("apply/revert against a real state store", () => {
    let rootDir;
    let stateStore;
    let configDoc;
    let updateCalls;

    const updateOpenclawConfig = ({ mutate }) => {
      configDoc = mutate(configDoc);
      updateCalls += 1;
      return { config: configDoc };
    };

    const makeService = (members) =>
      createTeamGatewayConfig({
        openclawDir: rootDir,
        updateOpenclawConfig,
        teamStateStore: stateStore,
        membersStore: { listMembers: () => members },
        getAdvertisedScopes: async () => null,
        nowFn: () => 1_000_000,
      });

    beforeEach(() => {
      rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-team-state-"));
      stateStore = createTeamStateStore({ rootDir });
      updateCalls = 0;
      configDoc = {
        gateway: { auth: { mode: "token", token: "legacy-secret" } },
        agents: { list: [] },
      };
    });

    afterEach(() => {
      fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("captures the pre-team auth subtree once and reconciles on every call", async () => {
      const service = makeService(kMembers);
      await service.applyTeamGatewayConfig();
      expect(configDoc.gateway.auth.mode).toBe("trusted-proxy");
      expect(stateStore.read().previousGatewayAuth).toEqual({
        mode: "token",
        token: "legacy-secret",
      });

      // Roster change → reconciliation rebuilds allowUsers; the preserved
      // pre-team subtree is NOT overwritten with our own trusted-proxy blob.
      const smaller = makeService([kMembers[0]]);
      await smaller.applyTeamGatewayConfig();
      expect(configDoc.gateway.auth.trustedProxy.allowUsers).toEqual([
        "owner@example.com",
      ]);
      expect(stateStore.read().previousGatewayAuth).toEqual({
        mode: "token",
        token: "legacy-secret",
      });
      expect(updateCalls).toBe(2);
    });

    it("revert restores the preserved auth subtree exactly", async () => {
      const service = makeService(kMembers);
      await service.applyTeamGatewayConfig();
      service.revertTeamGatewayConfig();
      expect(configDoc.gateway.auth).toEqual({
        mode: "token",
        token: "legacy-secret",
      });
      expect(stateStore.read().enabledAt).toBeNull();
    });

    it("revert deletes gateway.auth when there was none before enable", async () => {
      configDoc = { gateway: {}, agents: { list: [] } };
      const service = makeService(kMembers);
      await service.applyTeamGatewayConfig();
      expect(stateStore.read().previousGatewayAuth).toBeNull();
      service.revertTeamGatewayConfig();
      expect(configDoc.gateway.auth).toBeUndefined();
    });
  });
});

describe("server/team/presence (4.5)", () => {
  it("tracks member activity with TTL expiry and never legacy sessions", () => {
    let now = 0;
    const presence = createTeamPresence({ nowFn: () => now, ttlMs: 30_000 });
    presence.touch({ kind: "member", email: "a@example.com", role: "member" });
    presence.touch({ kind: "legacy", role: "admin", email: null });
    now = 10_000;
    presence.touch({
      kind: "member",
      email: "b@example.com",
      displayName: "B",
      role: "admin",
    });
    expect(presence.list().map((entry) => entry.email)).toEqual([
      "b@example.com",
      "a@example.com",
    ]);
    // ~3 missed heartbeats: a's entry expires, b's survives (CEO finding 5).
    now = 31_000;
    expect(presence.list().map((entry) => entry.email)).toEqual([
      "b@example.com",
    ]);
    now = 100_000;
    expect(presence.list()).toEqual([]);
  });
});
