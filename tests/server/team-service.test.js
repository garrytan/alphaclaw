const fs = require("fs");
const os = require("os");
const path = require("path");

const { createTeamService } = require("../../lib/server/team-service");
const {
  createTeamGatewayConfig,
} = require("../../lib/server/team/gateway-config");
const { updateOpenclawConfig } = require("../../lib/server/openclaw-config");
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

// Roster + the real gateway.auth writer over it — the service takes both as
// injected collaborators.
const kMembers = [
  { id: "m1", email: "garry@example.com", role: "admin", disabled: 0 },
];
const createWriterDeps = (openclawDir) => {
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
  const membersStore = { listMembers: () => kMembers };
  const writer = createTeamGatewayConfig({
    openclawDir,
    updateOpenclawConfig,
    teamStateStore,
    membersStore,
    env: {},
  });
  return {
    membersStore,
    applyTeamGatewayConfig: () => writer.applyTeamGatewayConfig(),
  };
};

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
        ...createWriterDeps(openclawDir),
      });

      // enableTeamMode reaches `await restartGateway()` after the async
      // config write settles; the first call is parked mid-transition there.
      const firstTransition = teamService.setEnabled(true);
      await vi.waitFor(() => expect(restartGateway).toHaveBeenCalledTimes(1));

      const second = await teamService.setEnabled(true);
      expect(second).toEqual({
        ok: false,
        code: "transition_in_flight",
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
        ...createWriterDeps(openclawDir),
      });

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
        ...createWriterDeps(openclawDir),
      });
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

    it("re-probes after invalidateIdentityProbe (roster mutations)", async () => {
      const { teamService, request } = createEnabledService();

      await teamService.getIdentityProbe();
      await teamService.getIdentityProbe();
      expect(countHealthProbes(request)).toBe(1);

      teamService.invalidateIdentityProbe();

      const refreshed = await teamService.getIdentityProbe();
      expect(countHealthProbes(request)).toBe(2);
      expect(refreshed).toEqual(expect.objectContaining({ ok: true }));
    });

    it("probes with an ACTIVE ADMIN's email first, regardless of roster order", async () => {
      const openclawDir = createTempOpenclawDir();
      updateTeamConfig({ openclawDir, enabled: true });
      const request = createProbeRequest();
      const members = [
        { id: "m1", email: "member@example.com", role: "member", disabled: 0 },
        { id: "m2", email: "gone@example.com", role: "admin", disabled: 1 },
        { id: "m3", email: "admin@example.com", role: "admin", disabled: 0 },
      ];
      const writerDeps = createWriterDeps(openclawDir);
      const teamService = createTeamService({
        fsModule: fs,
        openclawDir,
        env: {},
        getGatewayUrl: () => kGatewayUrl,
        request,
        probeOptions: { healthRetryDelayMs: 0 },
        logger: kSilentLogger,
        applyTeamGatewayConfig: writerDeps.applyTeamGatewayConfig,
        membersStore: { listMembers: () => members },
      });

      await teamService.getIdentityProbe();
      const invokeCall = request.mock.calls.find(
        (call) => !String(call[0]?.url || "").endsWith("/health"),
      );
      // The disabled admin is filtered; the active admin wins over the
      // roster-first member.
      expect(invokeCall[0].headers["x-alphaclaw-user"]).toBe(
        "admin@example.com",
      );
    });
  });
});
