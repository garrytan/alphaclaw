const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  disableTeamMode,
  enableTeamMode,
  readTeamAuthSnapshot,
  resolveTeamAuthSnapshotPath,
} = require("../../lib/server/team-auth-transition");
const {
  createTeamGatewayConfig,
} = require("../../lib/server/team/gateway-config");
const { updateOpenclawConfig } = require("../../lib/server/openclaw-config");
const { getGatewayCredential } = require("../../lib/server/gateway-credential");

const kGatewayUrl = "http://127.0.0.1:18789";

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-team-auth-test-"));

const writeConfig = (openclawDir, config) => {
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    JSON.stringify(config, null, 2),
  );
};

const readConfig = (openclawDir) =>
  JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"));

// Fake gateway: /health always live; /tools/invoke enforces the given check.
const createProbeRequest = ({ acceptInvoke }) =>
  vi.fn(async ({ url, headers = {} }) => {
    if (url.endsWith("/health")) return { status: 200, error: null };
    if (url.endsWith("/tools/invoke")) {
      return acceptInvoke(headers)
        ? { status: 400, error: null } // auth passed, bogus tool rejected
        : { status: 401, error: null };
    }
    return { status: 404, error: null };
  });

const kFastProbe = { healthAttempts: 2, healthRetryDelayMs: 1 };

describe("server/team-auth-transition", () => {
  const kMembers = [
    { id: "m1", email: "garry@example.com", role: "admin", disabled: 0 },
    { id: "m2", email: "diana@example.com", role: "member", disabled: 0 },
  ];
  const kProbeUser = "garry@example.com";
  const env = { OPENCLAW_GATEWAY_TOKEN: "shared-token" };

  // The REAL single writer (team/gateway-config.js) over a fake roster — the
  // transition delegates the gateway.auth shape to it, so these tests assert
  // the live-verified subtree lands on disk end to end.
  const createApplyAuthConfig = ({ openclawDir, testEnv = env }) => {
    const stateFile = path.join(openclawDir, "team-state.json");
    const teamStateStore = {
      read: () =>
        fs.existsSync(stateFile)
          ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
          : {},
      update(fn) {
        const next = fn(this.read());
        fs.writeFileSync(stateFile, JSON.stringify(next));
        return next;
      },
    };
    const writer = createTeamGatewayConfig({
      openclawDir,
      updateOpenclawConfig,
      teamStateStore,
      membersStore: { listMembers: () => kMembers },
      env: testEnv,
    });
    return () => writer.applyTeamGatewayConfig();
  };

  it("enable happy path writes the trusted-proxy config and snapshots the old auth", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: {
        auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" },
        trustedProxies: ["127.0.0.1"],
      },
    });
    const restartGateway = vi.fn(async () => {});
    const request = createProbeRequest({
      acceptInvoke: (headers) => headers["x-alphaclaw-user"] === kProbeUser,
    });

    const result = await enableTeamMode({
      openclawDir,
      env,
      applyAuthConfig: createApplyAuthConfig({ openclawDir }),
      probeUser: kProbeUser,
      restartGateway,
      getGatewayUrl: () => kGatewayUrl,
      request,
      probeOptions: kFastProbe,
    });

    expect(result.ok).toBe(true);
    expect(restartGateway).toHaveBeenCalledTimes(1);

    const config = readConfig(openclawDir);
    // The live-verified beta subtree: identityScopes at AUTH level (the
    // strict trustedProxy object rejects it), member EMAILS as identity keys,
    // deviceAutoApprove without operator.admin, and the internal-caller
    // password as an env reference.
    expect(config.gateway.auth).toEqual({
      mode: "trusted-proxy",
      password: "${OPENCLAW_GATEWAY_PASSWORD}",
      identityScopes: {
        "garry@example.com": [
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.admin",
        ],
        "diana@example.com": [
          "operator.read",
          "operator.write",
          "operator.approvals",
        ],
      },
      trustedProxy: {
        userHeader: "x-alphaclaw-user",
        allowLoopback: true,
        deviceAutoApprove: {
          enabled: true,
          scopes: ["operator.read", "operator.write", "operator.approvals"],
        },
        allowUsers: ["garry@example.com", "diana@example.com"],
      },
    });
    // Token removed (mutually exclusive with trusted-proxy).
    expect(config.gateway.auth.token).toBeUndefined();
    expect(config.gateway.trustedProxies).toEqual(
      expect.arrayContaining(["127.0.0.1", "::1"]),
    );

    const snapshot = readTeamAuthSnapshot({ openclawDir });
    expect(snapshot.gatewayAuth).toEqual({ token: "${OPENCLAW_GATEWAY_TOKEN}" });
    expect(snapshot.trustedProxies).toEqual(["127.0.0.1"]);

    // Internal clients now resolve the password credential (same secret).
    expect(getGatewayCredential({ openclawDir, env })).toEqual({
      mode: "password",
      value: "shared-token",
    });
  });

  it("refuses to enable without a member account or a writer", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {});

    const noMember = await enableTeamMode({
      openclawDir,
      env,
      applyAuthConfig: createApplyAuthConfig({ openclawDir }),
      probeUser: "",
      restartGateway: vi.fn(),
      getGatewayUrl: () => kGatewayUrl,
      probeOptions: kFastProbe,
    });
    expect(noMember.ok).toBe(false);
    expect(noMember.error).toMatch(/admin account/i);

    const noWriter = await enableTeamMode({
      openclawDir,
      env,
      probeUser: kProbeUser,
      restartGateway: vi.fn(),
      getGatewayUrl: () => kGatewayUrl,
      probeOptions: kFastProbe,
    });
    expect(noWriter.ok).toBe(false);
    expect(noWriter.error).toMatch(/writer/i);
  });

  it("auto-restores the snapshot and restarts again when the probe fails", async () => {
    const openclawDir = createTempOpenclawDir();
    const originalConfig = {
      gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
      channels: { telegram: { enabled: true } },
    };
    writeConfig(openclawDir, originalConfig);
    const restartGateway = vi.fn(async () => {});
    const request = createProbeRequest({ acceptInvoke: () => false });
    const notify = vi.fn(async () => ({ ok: true }));

    const result = await enableTeamMode({
      openclawDir,
      env,
      applyAuthConfig: createApplyAuthConfig({ openclawDir }),
      probeUser: kProbeUser,
      restartGateway,
      getGatewayUrl: () => kGatewayUrl,
      request,
      probeOptions: kFastProbe,
      logger: { warn: vi.fn() },
      notify,
    });

    expect(result.ok).toBe(false);
    expect(result.restored).toBe(true);
    expect(result.error).toMatch(/rejected/i);
    // Restart happened twice: apply + restore.
    expect(restartGateway).toHaveBeenCalledTimes(2);
    // The automatic restore is an auto-fix on the operator's gateway config —
    // it announces itself (important class, per-attempt id).
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain(
      "previous gateway auth was restored automatically",
    );
    expect(notify.mock.calls[0][1]).toEqual(
      expect.objectContaining({ eventType: "health" }),
    );
    expect(notify.mock.calls[0][1].id).toMatch(/^team-auth-restored-\d+$/);

    const config = readConfig(openclawDir);
    expect(config.gateway.auth).toEqual({ token: "${OPENCLAW_GATEWAY_TOKEN}" });
    expect(config.channels).toEqual({ telegram: { enabled: true } });
  });

  it("restores health-probe failures too", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, { gateway: { auth: { token: "abc" } } });
    const restartGateway = vi.fn(async () => {});
    const request = vi.fn(async () => ({ status: 0, error: "ECONNREFUSED" }));

    const result = await enableTeamMode({
      openclawDir,
      env,
      applyAuthConfig: createApplyAuthConfig({ openclawDir }),
      probeUser: kProbeUser,
      restartGateway,
      getGatewayUrl: () => kGatewayUrl,
      request,
      probeOptions: kFastProbe,
      logger: { warn: vi.fn() },
    });

    expect(result.ok).toBe(false);
    expect(result.restored).toBe(true);
    expect(readConfig(openclawDir).gateway.auth).toEqual({ token: "abc" });
  });

  it("treats a rejecting restartGateway like a failed probe and restores the snapshot", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    });
    // First restart (apply) throws; second restart (restore) succeeds.
    const restartGateway = vi
      .fn()
      .mockRejectedValueOnce(new Error("spawn EAGAIN"))
      .mockResolvedValue(undefined);
    const request = createProbeRequest({ acceptInvoke: () => true });

    const result = await enableTeamMode({
      openclawDir,
      env,
      applyAuthConfig: createApplyAuthConfig({ openclawDir }),
      probeUser: kProbeUser,
      restartGateway,
      getGatewayUrl: () => kGatewayUrl,
      request,
      probeOptions: kFastProbe,
      logger: { warn: vi.fn() },
    });

    expect(result.ok).toBe(false);
    expect(result.restored).toBe(true);
    expect(result.error).toMatch(/enable failed/i);
    // Restart happened twice: the throwing apply + the restore.
    expect(restartGateway).toHaveBeenCalledTimes(2);
    // openclaw.json is back to token auth — the trusted-proxy flip did not
    // strand on disk.
    expect(readConfig(openclawDir).gateway.auth).toEqual({
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    });
  });

  it("disable restores the snapshot, probes the token path, and removes the snapshot", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    });
    const restartGateway = vi.fn(async () => {});
    const enableRequest = createProbeRequest({ acceptInvoke: () => true });

    const enabled = await enableTeamMode({
      openclawDir,
      env,
      applyAuthConfig: createApplyAuthConfig({ openclawDir }),
      probeUser: kProbeUser,
      restartGateway,
      getGatewayUrl: () => kGatewayUrl,
      request: enableRequest,
      probeOptions: kFastProbe,
    });
    expect(enabled.ok).toBe(true);

    const disableRequest = createProbeRequest({
      acceptInvoke: (headers) =>
        headers.authorization === "Bearer shared-token",
    });
    const disabled = await disableTeamMode({
      openclawDir,
      env,
      restartGateway,
      getGatewayUrl: () => kGatewayUrl,
      request: disableRequest,
      probeOptions: kFastProbe,
    });

    expect(disabled.ok).toBe(true);
    expect(readConfig(openclawDir).gateway.auth).toEqual({
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    });
    expect(fs.existsSync(resolveTeamAuthSnapshotPath({ openclawDir }))).toBe(false);
  });

  it("disable survives a throwing restart: token auth restored on disk, failure reported", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          password: "${OPENCLAW_GATEWAY_PASSWORD}",
          trustedProxy: { userHeader: "x-alphaclaw-user" },
        },
      },
    });

    const disabled = await disableTeamMode({
      openclawDir,
      env,
      // restartGateway now THROWS when the gateway never becomes ready
      // (GatewayRestartError contract on this branch). Disable must treat
      // that as a failed probe — never rethrow (the route would crash) and
      // never leave trusted-proxy config behind.
      restartGateway: vi.fn(async () => {
        throw new Error("Gateway did not become ready within 120s");
      }),
      getGatewayUrl: () => kGatewayUrl,
      request: vi.fn(async () => ({ ok: false, status: 503 })),
      probeOptions: kFastProbe,
    });

    expect(disabled.ok).toBe(false);
    expect(disabled.error).toContain("did not become ready");
    // The config restore happened BEFORE the restart — token auth is on disk.
    expect(readConfig(openclawDir).gateway.auth.mode).not.toBe("trusted-proxy");
  });

  it("disable without a snapshot reconstructs env-backed token auth", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          password: "${OPENCLAW_GATEWAY_PASSWORD}",
          trustedProxy: { userHeader: "x-alphaclaw-user" },
        },
      },
    });
    const request = createProbeRequest({
      acceptInvoke: (headers) => headers.authorization === "Bearer shared-token",
    });

    const disabled = await disableTeamMode({
      openclawDir,
      env,
      restartGateway: vi.fn(async () => {}),
      getGatewayUrl: () => kGatewayUrl,
      request,
      probeOptions: kFastProbe,
    });

    expect(disabled.ok).toBe(true);
    expect(readConfig(openclawDir).gateway.auth).toEqual({
      mode: "token",
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    });
  });

  it("reports a failed disable probe without stranding config changes", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    });
    const request = vi.fn(async ({ url }) =>
      url.endsWith("/health")
        ? { status: 200, error: null }
        : { status: 401, error: null },
    );
    const disabled = await disableTeamMode({
      openclawDir,
      env,
      restartGateway: vi.fn(async () => {}),
      getGatewayUrl: () => kGatewayUrl,
      request,
      probeOptions: kFastProbe,
    });
    expect(disabled.ok).toBe(false);
    expect(disabled.error).toMatch(/rejected/i);
    // Token config is still in place — a failed probe never rewrites it back.
    expect(readConfig(openclawDir).gateway.auth.token).toBe(
      "${OPENCLAW_GATEWAY_TOKEN}",
    );
  });
});
