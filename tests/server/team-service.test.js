const fs = require("fs");
const os = require("os");
const path = require("path");

const { createTeamService } = require("../../lib/server/team-service");
const { updateTeamConfig } = require("../../lib/server/alphaclaw-config");

const kGatewayUrl = "http://127.0.0.1:18789";

const kSilentLogger = { log() {}, warn() {}, error() {} };

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-team-service-test-"));

// Loopback probe double: health and /tools/invoke both succeed, so the
// enable-team-mode identity handshake passes without a real gateway.
const createProbeRequest = () => vi.fn(async () => ({ status: 200, error: null }));

const countHealthProbes = (request) =>
  request.mock.calls.filter((call) => String(call[0]?.url || "").endsWith("/health"))
    .length;

describe("server/team-service", () => {
  describe("setEnabled transition guard", () => {
    it("rejects a second transition while the first is mid-restart", async () => {
      const openclawDir = createTempOpenclawDir();
      let releaseRestart;
      const restartGateway = vi.fn(
        () =>
          new Promise((resolve) => {
            releaseRestart = resolve;
          }),
      );
      const request = createProbeRequest();
      const teamService = createTeamService({
        fsModule: fs,
        openclawDir,
        env: {},
        restartGateway,
        getGatewayUrl: () => kGatewayUrl,
        request,
        probeOptions: { healthAttempts: 1, healthRetryDelayMs: 0 },
        logger: kSilentLogger,
      });
      teamService.setOperators([{ id: "garry", name: "Garry" }]);

      // enableTeamMode runs synchronously up to `await restartGateway()`, so
      // the first call is parked mid-transition here.
      const firstTransition = teamService.setEnabled(true);
      expect(restartGateway).toHaveBeenCalledTimes(1);

      const second = await teamService.setEnabled(true);
      expect(second).toEqual({
        ok: false,
        error: "A team-mode transition is already running.",
      });

      releaseRestart();
      await expect(firstTransition).resolves.toEqual({
        ok: true,
        enabled: true,
        changed: true,
      });
      expect(teamService.isTeamEnabled()).toBe(true);
      // The rejected call never triggered a second gateway restart.
      expect(restartGateway).toHaveBeenCalledTimes(1);
    });

    it("allows a new transition once the previous one settles", async () => {
      const openclawDir = createTempOpenclawDir();
      const restartGateway = vi.fn(async () => {});
      const request = createProbeRequest();
      const teamService = createTeamService({
        fsModule: fs,
        openclawDir,
        env: {},
        restartGateway,
        getGatewayUrl: () => kGatewayUrl,
        request,
        probeOptions: { healthAttempts: 1, healthRetryDelayMs: 0 },
        logger: kSilentLogger,
      });
      teamService.setOperators([{ id: "garry", name: "Garry" }]);

      await expect(teamService.setEnabled(true)).resolves.toEqual({
        ok: true,
        enabled: true,
        changed: true,
      });
      // Guard released: disabling afterwards is not blocked.
      await expect(teamService.setEnabled(false)).resolves.toEqual({
        ok: true,
        enabled: false,
        changed: true,
      });
    });
  });

  describe("identity probe cache", () => {
    const createEnabledService = () => {
      const openclawDir = createTempOpenclawDir();
      updateTeamConfig({ openclawDir, enabled: true });
      const request = createProbeRequest();
      const teamService = createTeamService({
        fsModule: fs,
        openclawDir,
        env: {},
        getGatewayUrl: () => kGatewayUrl,
        request,
        probeOptions: { healthRetryDelayMs: 0 },
        logger: kSilentLogger,
      });
      teamService.setOperators([{ id: "garry", name: "Garry" }]);
      return { teamService, request };
    };

    it("serves repeat calls within 60s from the cache and re-probes after expiry", async () => {
      vi.useFakeTimers();
      try {
        const { teamService, request } = createEnabledService();

        const first = await teamService.getIdentityProbe();
        expect(first).toEqual(
          expect.objectContaining({ ok: true, error: null }),
        );
        const second = await teamService.getIdentityProbe();
        expect(second).toBe(first);
        expect(countHealthProbes(request)).toBe(1);

        // Past the 60s window the cached result is stale.
        vi.setSystemTime(Date.now() + 60_001);
        await teamService.getIdentityProbe();
        expect(countHealthProbes(request)).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-probes after setOperators invalidates the cache", async () => {
      const { teamService, request } = createEnabledService();

      await teamService.getIdentityProbe();
      await teamService.getIdentityProbe();
      expect(countHealthProbes(request)).toBe(1);

      teamService.setOperators([
        { id: "garry", name: "Garry" },
        { id: "alice", name: "Alice" },
      ]);

      const refreshed = await teamService.getIdentityProbe();
      expect(countHealthProbes(request)).toBe(2);
      expect(refreshed).toEqual(expect.objectContaining({ ok: true }));
    });
  });
});
