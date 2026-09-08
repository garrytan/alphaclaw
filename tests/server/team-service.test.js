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
const createWriterDeps = (openclawDir, options = {}) => {
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
    ...options,
  });
  return {
    membersStore,
    applyTeamGatewayConfig: (options) => writer.applyTeamGatewayConfig(options),
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


it("a team disable queued behind another operation refuses before changing auth or team state", async () => {
  const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
  const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");
  const openclawDir = createTempOpenclawDir();
  updateTeamConfig({ openclawDir, enabled: true });
  updateOpenclawConfig({ openclawDir, mutate: (config) => {
    config.gateway = { auth: { mode: "trusted-proxy" } };
  } });
  const original = fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8");
  const lock = createGatewayLifecycleLock();
  const prior = lock.tryAcquire("repair");
  let info = {};
  const policy = createGatewayMutationPolicy({ lock, getChannelInfo: () => info });
  const restartGateway = vi.fn();
  const service = createTeamService({ openclawDir, restartGateway,
    getGatewayUrl: () => kGatewayUrl,
    withGatewayTransition: async (run) => {
      const hold = await lock.acquire("team_transition");
      try {
        policy.assert({ hold });
        return await run({ restartGateway, assertCanMutate: () => policy.assert({ hold }) });
      } finally { hold(); }
    },
  });
  const pending = service.setEnabled(false);
  info = { gatewayHold: { reason: "config_migration_failed" } };
  prior();
  expect(await pending).toMatchObject({ ok: false, blocked: true, code: "gateway_held",
    changed: false, enabled: true });
  expect(service.isTeamEnabled()).toBe(true);
  expect(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8")).toBe(original);
  expect(restartGateway).not.toHaveBeenCalled();
  expect(lock.getActiveOperation()).toBeNull();
});

describe("team transition ownership at the actual auth write", () => {
  const makeAuthority = () => {
    const { GatewayMutationBlockedError } = require("../../lib/server/gateway-mutation-policy");
    let held = true;
    const assertCanMutate = () => {
      if (!held) throw new GatewayMutationBlockedError({ code: "lease_expired", error: "Lease expired", hint: "Retry" });
    };
    return { expire: () => { held = false; }, assertCanMutate,
      scope: (restartGateway) => (run) => run({ restartGateway, assertCanMutate }) };
  };

  it("a disable that loses ownership during restart keeps the already-restored auth and flag aligned", async () => {
    const openclawDir = createTempOpenclawDir();
    updateTeamConfig({ openclawDir, enabled: true });
    updateOpenclawConfig({ openclawDir, mutate: (cfg) => { cfg.gateway = { auth: { mode: "trusted-proxy" } }; } });
    const authority = makeAuthority();
    const restartGateway = vi.fn(async () => { authority.expire(); authority.assertCanMutate(); });
    const service = createTeamService({ openclawDir, env: { OPENCLAW_GATEWAY_TOKEN: "fixture-token" },
      restartGateway, getGatewayUrl: () => kGatewayUrl, withGatewayTransition: authority.scope(restartGateway) });
    expect(await service.setEnabled(false)).toMatchObject({ ok: false, blocked: true, enabled: false,
      changed: true, configRestored: true, gatewayRestored: false, code: "lease_expired" });
    expect(service.isTeamEnabled()).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8")).gateway.auth.mode).not.toBe("trusted-proxy");
    expect(restartGateway).toHaveBeenCalledTimes(1);
  });

  it("ownership lost during advertised-scope discovery prevents the auth write itself", async () => {
    const openclawDir = createTempOpenclawDir();
    updateOpenclawConfig({ openclawDir, mutate: (cfg) => { cfg.gateway = { auth: { token: "original" } }; } });
    const before = fs.readFileSync(path.join(openclawDir, "openclaw.json"));
    const authority = makeAuthority();
    let resolveScopes;
    const getAdvertisedScopes = vi.fn(() => new Promise((resolve) => { resolveScopes = resolve; }));
    const restartGateway = vi.fn();
    const service = createTeamService({ openclawDir, restartGateway, getGatewayUrl: () => kGatewayUrl,
      withGatewayTransition: authority.scope(restartGateway), logger: kSilentLogger,
      ...createWriterDeps(openclawDir, { getAdvertisedScopes }) });
    const pending = service.setEnabled(true);
    await vi.waitFor(() => expect(getAdvertisedScopes).toHaveBeenCalledTimes(1));
    authority.expire();
    resolveScopes([]);
    expect(await pending).toMatchObject({ ok: false, blocked: true, enabled: false, changed: false, configApplied: false });
    expect(fs.readFileSync(path.join(openclawDir, "openclaw.json"))).toEqual(before);
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("a late successful identity response cannot hide applied auth or restore after lease loss", async () => {
    const { readTeamSettings } = require("../../lib/server/alphaclaw-config");
    const openclawDir = createTempOpenclawDir();
    const authority = makeAuthority();
    const restartGateway = vi.fn(async () => {});
    const request = vi.fn(async ({ url }) => {
      if (url.endsWith("/health")) return { status: 200 };
      authority.expire();
      return { status: 400 };
    });
    const service = createTeamService({ openclawDir, restartGateway, getGatewayUrl: () => kGatewayUrl,
      request, probeOptions: { healthAttempts: 1, healthRetryDelayMs: 0 }, logger: kSilentLogger,
      withGatewayTransition: authority.scope(restartGateway), ...createWriterDeps(openclawDir) });
    expect(await service.setEnabled(true)).toMatchObject({ ok: false, blocked: true, code: "lease_expired",
      enabled: true, changed: true, configApplied: true, gatewayApplied: true, configRestored: false, gatewayRestored: false });
    expect(JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8")).gateway.auth.mode).toBe("trusted-proxy");
    expect(readTeamSettings({ openclawDir })).toMatchObject({ enabled: true, disableLegacyLogin: false });
    expect(restartGateway).toHaveBeenCalledTimes(1);
  });

  it("failed identity proof restores the persisted team flag with auth before the compensating restart", async () => {
    const { readTeamSettings } = require("../../lib/server/alphaclaw-config");
    const openclawDir = createTempOpenclawDir();
    updateOpenclawConfig({ openclawDir, mutate: (cfg) => { cfg.gateway = { auth: { token: "original-token" } }; } });
    const authority = makeAuthority();
    const modesAtRestart = [];
    let service;
    const restartGateway = vi.fn(async () => { modesAtRestart.push(service.isTeamEnabled()); });
    const request = vi.fn(async ({ url, headers = {} }) => {
      if (url.endsWith("/health")) return { status: 200 };
      return { status: headers["x-alphaclaw-user"] ? 401 : headers.authorization === "Bearer original-token" ? 400 : 401 };
    });
    service = createTeamService({ openclawDir, restartGateway, getGatewayUrl: () => kGatewayUrl,
      request, probeOptions: { healthAttempts: 1, healthRetryDelayMs: 0 }, logger: kSilentLogger,
      withGatewayTransition: authority.scope(restartGateway), ...createWriterDeps(openclawDir) });
    expect(await service.setEnabled(true)).toMatchObject({ ok: false, restored: true, enabled: false, changed: false,
      configApplied: true, gatewayApplied: true, configRestored: true, gatewayRestored: true });
    expect(modesAtRestart).toEqual([true, false]);
    expect(readTeamSettings({ openclawDir })).toMatchObject({ enabled: false, disableLegacyLogin: false });
  });
});

describe("roster reconciliation shares transition ownership", () => {
  const fixture = (getAdvertisedScopes = async () => null) => {
    const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
    const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");
    const openclawDir = createTempOpenclawDir();
    updateTeamConfig({ openclawDir, enabled: true });
    updateOpenclawConfig({ openclawDir, mutate: (config) => {
      config.gateway = { auth: { mode: "trusted-proxy" } };
    } });
    const lock = createGatewayLifecycleLock();
    const policy = createGatewayMutationPolicy({ lock });
    const restartGateway = vi.fn(async () => {});
    let activeHold;
    const service = createTeamService({ openclawDir, env: { OPENCLAW_GATEWAY_TOKEN: "original-token" },
      restartGateway, getGatewayUrl: () => kGatewayUrl, request: createProbeRequest(),
      probeOptions: { healthAttempts: 1, healthRetryDelayMs: 0 }, logger: kSilentLogger,
      ...createWriterDeps(openclawDir, { getAdvertisedScopes }),
      withGatewayTransition: async (run) => {
        const hold = await lock.acquire("team_transition");
        activeHold = hold;
        try {
          policy.assert({ hold });
          return await run({ restartGateway, assertCanMutate: () => policy.assert({ hold }) });
        } finally { hold(); }
      },
    });
    return { service, lock, retireCurrentLease: () => activeHold(),
      readAuth: () => JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8")).gateway.auth };
  };

  it("a roster refresh queued after disable rechecks team mode under its lease and skips auth rewriting", async () => {
    const getAdvertisedScopes = vi.fn(async () => null);
    const { service, lock, readAuth } = fixture(getAdvertisedScopes);
    const prior = lock.tryAcquire("repair");
    const disable = service.setEnabled(false);
    const queuedRoster = service.reconcileRoster();
    prior();
    expect(await disable).toMatchObject({ ok: true, enabled: false });
    expect(await queuedRoster).toBe(false);
    expect(getAdvertisedScopes).not.toHaveBeenCalled();
    expect(readAuth()).toEqual({ mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" });
    expect(lock.getActiveOperation()).toBeNull();
  });

  it("a roster discovery response arriving after lease loss and disable cannot restore trusted-proxy auth", async () => {
    let resolveScopes;
    const getAdvertisedScopes = vi.fn(() => new Promise((resolve) => { resolveScopes = resolve; }));
    const { service, lock, retireCurrentLease, readAuth } = fixture(getAdvertisedScopes);
    const roster = service.reconcileRoster();
    await vi.waitFor(() => expect(getAdvertisedScopes).toHaveBeenCalledTimes(1));
    retireCurrentLease();
    expect(await service.setEnabled(false)).toMatchObject({ ok: true, enabled: false });
    const refusal = expect(roster).rejects.toMatchObject({ code: "lease_expired", blocked: true });
    resolveScopes([]);
    await refusal;
    expect(readAuth()).toEqual({ mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" });
    expect(lock.getActiveOperation()).toBeNull();
  });

  it("a team-disabled observation after async discovery skips even while ownership is valid", async () => {
    const openclawDir = createTempOpenclawDir();
    updateTeamConfig({ openclawDir, enabled: true });
    updateOpenclawConfig({ openclawDir, mutate: (config) => { config.gateway = { auth: { mode: "token", token: "original" } }; } });
    const service = createTeamService({ openclawDir,
      ...createWriterDeps(openclawDir, { getAdvertisedScopes: async () => {
        updateTeamConfig({ openclawDir, enabled: false });
        return null;
      } }),
    });
    expect(await service.reconcileRoster()).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8")).gateway.auth)
      .toEqual({ mode: "token", token: "original" });
  });
});
