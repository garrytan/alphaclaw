const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  disableTeamMode,
  enableTeamMode,
  readTeamAuthSnapshot,
  resolveTeamAuthSnapshotPath,
  syncTeamAllowUsers,
} = require("../../lib/server/team-auth-transition");
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
  const kOperators = [{ id: "garry" }, { id: "diana" }];
  const env = { OPENCLAW_GATEWAY_TOKEN: "shared-token" };

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
      acceptInvoke: (headers) => headers["x-alphaclaw-user"] === "garry",
    });

    const result = await enableTeamMode({
      openclawDir,
      env,
      operators: kOperators,
      restartGateway,
      getGatewayUrl: () => kGatewayUrl,
      request,
      probeOptions: kFastProbe,
    });

    expect(result.ok).toBe(true);
    expect(restartGateway).toHaveBeenCalledTimes(1);

    const config = readConfig(openclawDir);
    expect(config.gateway.auth).toEqual({
      mode: "trusted-proxy",
      password: "${OPENCLAW_GATEWAY_PASSWORD}",
      trustedProxy: {
        userHeader: "x-alphaclaw-user",
        allowLoopback: true,
        allowUsers: ["garry", "diana"],
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

  it("refuses to enable without operators", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {});
    const result = await enableTeamMode({
      openclawDir,
      env,
      operators: [],
      restartGateway: vi.fn(),
      getGatewayUrl: () => kGatewayUrl,
      probeOptions: kFastProbe,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/operator/i);
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

    const result = await enableTeamMode({
      openclawDir,
      env,
      operators: kOperators,
      restartGateway,
      getGatewayUrl: () => kGatewayUrl,
      request,
      probeOptions: kFastProbe,
      logger: { warn: vi.fn() },
    });

    expect(result.ok).toBe(false);
    expect(result.restored).toBe(true);
    expect(result.error).toMatch(/rejected/i);
    // Restart happened twice: apply + restore.
    expect(restartGateway).toHaveBeenCalledTimes(2);

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
      operators: kOperators,
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
      operators: kOperators,
      restartGateway,
      getGatewayUrl: () => kGatewayUrl,
      request,
      probeOptions: kFastProbe,
      logger: { warn: vi.fn() },
    });

    expect(result.ok).toBe(false);
    expect(result.restored).toBe(true);
    expect(result.error).toMatch(/restart failed/i);
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
      operators: kOperators,
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

  describe("syncTeamAllowUsers", () => {
    it("updates allowUsers while trusted-proxy mode is active", () => {
      const openclawDir = createTempOpenclawDir();
      writeConfig(openclawDir, {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: { userHeader: "x-alphaclaw-user", allowUsers: ["old"] },
          },
        },
      });
      const result = syncTeamAllowUsers({
        openclawDir,
        operators: [{ id: "new-1" }, { id: "new-2" }],
      });
      expect(result.changed).toBe(true);
      expect(
        readConfig(openclawDir).gateway.auth.trustedProxy.allowUsers,
      ).toEqual(["new-1", "new-2"]);
    });

    it("is a no-op in token mode", () => {
      const openclawDir = createTempOpenclawDir();
      const config = { gateway: { auth: { token: "abc" } } };
      writeConfig(openclawDir, config);
      const before = fs.readFileSync(
        path.join(openclawDir, "openclaw.json"),
        "utf8",
      );
      const result = syncTeamAllowUsers({
        openclawDir,
        operators: [{ id: "someone" }],
      });
      expect(result.changed).toBe(false);
      const after = fs.readFileSync(
        path.join(openclawDir, "openclaw.json"),
        "utf8",
      );
      expect(after).toBe(before);
    });
  });
});
