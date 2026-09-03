const fs = require("fs");
const os = require("os");
const path = require("path");

// Real registry in a temp workspace: set the root BEFORE requiring modules so
// constants-derived paths (registry file, lockfile) land in a disposable dir.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-discovery-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const topicRegistry = require("../../lib/server/topic-registry");
const { kRegistryPath } = topicRegistry;
const {
  isTopicDiscoveryEnabled,
  createTopicDiscoveryService,
} = require("../../lib/server/topic-discovery");
const { parseTelegramSessionKey } = require("../../lib/server/utils/session-keys");

const createFakeUsageDb = (rows = []) => ({
  rows,
  getTelegramSessionKeysAfterId: vi.fn(({ afterId = 0, limit = 5000 } = {}) =>
    rows.filter((row) => row.id > afterId).slice(0, limit),
  ),
});

const flushImmediates = () => new Promise((resolve) => setImmediate(resolve));

const createService = ({ usageDb, env = {}, nameCache = null, ...overrides } = {}) => {
  const deps = {
    openclawDir: path.join(kTempRoot, ".openclaw"),
    topicRegistry,
    usageDb,
    readConfig: vi.fn(() => ({})),
    readNameCache: vi.fn(
      () =>
        nameCache || {
          entries: new Map(),
          source: null,
          namespace: "ns",
          storePath: "sp",
          diagnostic: "cache_empty",
        },
    ),
    resolveAccountIdForGroup: vi.fn(() => null),
    parseTelegramSessionKey,
    syncPromptFiles: vi.fn(),
    notify: vi.fn(async () => {}),
    logEvent: vi.fn(),
    env,
    ...overrides,
  };
  return { service: createTopicDiscoveryService(deps), deps };
};

describe("server/topic-discovery", () => {
  beforeEach(() => {
    fs.rmSync(path.dirname(kRegistryPath), { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(kTempRoot, { recursive: true, force: true });
  });

  describe("isTopicDiscoveryEnabled", () => {
    it("defaults on and honors the kill switch values", () => {
      expect(isTopicDiscoveryEnabled({})).toBe(true);
      expect(isTopicDiscoveryEnabled({ ALPHACLAW_TOPIC_DISCOVERY: "true" })).toBe(true);
      for (const value of ["false", "0", "off", "no", "disabled", " OFF "]) {
        expect(isTopicDiscoveryEnabled({ ALPHACLAW_TOPIC_DISCOVERY: value })).toBe(false);
      }
    });
  });

  describe("sweep", () => {
    it("is a clean no-op on an empty usage db: no writes, watermark unchanged", async () => {
      const usageDb = createFakeUsageDb([]);
      const { service, deps } = createService({ usageDb });

      const result = await service.sweep();

      expect(result).toMatchObject({
        firstSweep: true,
        sightings: 0,
        discovered: 0,
        named: 0,
      });
      expect(topicRegistry.getSweepWatermark()).toBe(0);
      // No registry file was ever created — zero writes.
      expect(fs.existsSync(kRegistryPath)).toBe(false);
      expect(deps.syncPromptFiles).not.toHaveBeenCalled();
      expect(deps.notify).not.toHaveBeenCalled();
    });

    it("cold start (watermark 0) ingests everything but stays notification-silent", async () => {
      const usageDb = createFakeUsageDb([
        { id: 1, sessionKey: "agent:main:telegram:group:-100:topic:7" },
        { id: 2, sessionKey: "agent:main:telegram:group:-100:topic:7:heartbeat" },
        { id: 3, sessionKey: "agent:scout:telegram:group:-200:topic:9" },
        { id: 4, sessionKey: "agent:main:telegram:group:-100" }, // no thread → skipped
        { id: 5, sessionKey: "agent:main:telegram:direct:55" }, // direct → skipped
      ]);
      const { service, deps } = createService({ usageDb });

      const result = await service.sweep();

      expect(result).toMatchObject({
        firstSweep: true,
        scannedTo: 5,
        sightings: 2,
        discovered: 2,
        named: 0,
      });
      expect(deps.notify).not.toHaveBeenCalled();
      expect(deps.syncPromptFiles).toHaveBeenCalledTimes(1);
      expect(topicRegistry.getSweepWatermark()).toBe(5);

      const topics = topicRegistry.listTopics();
      expect(topics).toHaveLength(2);
      expect(topics.every((t) => t.discovered)).toBe(true);
      const scoutRow = topics.find((t) => t.groupId === "-200");
      expect(scoutRow.seenAgentId).toBe("scout");
    });

    it("notifies once with a digest on later sweeps and advances the watermark", async () => {
      // Prior state: a completed first sweep.
      topicRegistry.setSweepWatermark(10);

      const usageDb = createFakeUsageDb([
        { id: 11, sessionKey: "agent:main:telegram:group:-100:topic:7" },
        { id: 12, sessionKey: "agent:main:telegram:group:-100:topic:8" },
      ]);
      const nameCache = {
        entries: new Map([
          [
            "-100:7",
            { chatId: "-100", threadId: "7", name: "Deploys", updatedAt: 1 },
          ],
        ]),
        source: "sqlite",
        namespace: "ns",
        storePath: "sp",
        diagnostic: "",
      };
      const { service, deps } = createService({ usageDb, nameCache });

      const result = await service.sweep();

      expect(result).toMatchObject({
        firstSweep: false,
        scannedTo: 12,
        discovered: 2,
        named: 1,
      });
      expect(topicRegistry.getSweepWatermark()).toBe(12);
      expect(deps.syncPromptFiles).toHaveBeenCalledTimes(1);
      expect(deps.notify).toHaveBeenCalledTimes(1);
      const [digest, options] = deps.notify.mock.calls[0];
      expect(digest).toContain("2 new topics discovered");
      expect(digest).toContain("-100#7");
      expect(digest).toContain("1 named from openclaw's cache (Deploys)");
      // Sweep digests are informational: classified verbose so Important-only
      // mode suppresses them (plan Phase-3 pin list).
      expect(options).toEqual({ eventType: "topic_discovery", verbose: true });

      // Enrichment cleared the discovered flag by naming the topic.
      const named = topicRegistry
        .listTopics()
        .find((t) => t.groupId === "-100" && t.threadId === "7");
      expect(named.name).toBe("Deploys");
      expect(named.discovered).toBe(false);
    });

    it("does not rewrite the watermark when no new rows appear", async () => {
      topicRegistry.setSweepWatermark(20);
      const usageDb = createFakeUsageDb([]);
      const { service } = createService({ usageDb });
      const watermarkSpy = vi.spyOn(topicRegistry, "setSweepWatermark");

      const result = await service.sweep();

      expect(result).toMatchObject({ firstSweep: false, discovered: 0 });
      expect(watermarkSpy).not.toHaveBeenCalled();
    });

    it("never resurrects a tombstoned topic", async () => {
      topicRegistry.addTopic("-100", "7", { name: "Doomed" });
      topicRegistry.removeTopic("-100", "7");
      topicRegistry.setSweepWatermark(1);

      const usageDb = createFakeUsageDb([
        { id: 2, sessionKey: "agent:main:telegram:group:-100:topic:7" },
      ]);
      const { service, deps } = createService({ usageDb });

      const result = await service.sweep();

      expect(result).toMatchObject({ discovered: 0, sightings: 1 });
      const row = topicRegistry.listTopics()[0];
      expect(row.deleted).toBe(true);
      // Nothing new → no prompt sync, no notification.
      expect(deps.syncPromptFiles).not.toHaveBeenCalled();
      expect(deps.notify).not.toHaveBeenCalled();
      expect(topicRegistry.getSweepWatermark()).toBe(2);
    });

    it("kill switch: sweep skips, registry never written, noteSessionSeen no-ops", async () => {
      const usageDb = createFakeUsageDb([
        { id: 1, sessionKey: "agent:main:telegram:group:-100:topic:7" },
      ]);
      const { service, deps } = createService({
        usageDb,
        env: { ALPHACLAW_TOPIC_DISCOVERY: "false" },
      });

      const result = await service.sweep();
      expect(result).toEqual({ skipped: true, reason: "disabled" });
      expect(usageDb.getTelegramSessionKeysAfterId).not.toHaveBeenCalled();

      service.noteSessionSeen("agent:main:telegram:group:-100:topic:7");
      await flushImmediates();

      expect(fs.existsSync(kRegistryPath)).toBe(false);
      expect(deps.syncPromptFiles).not.toHaveBeenCalled();
      expect(service.getStatus().enabled).toBe(false);
    });

    it("skips the tick cleanly when the usage db throws", async () => {
      const usageDb = {
        getTelegramSessionKeysAfterId: vi.fn(() => {
          throw new Error("database is locked");
        }),
      };
      const { service, deps } = createService({ usageDb });

      const result = await service.sweep();

      expect(result).toEqual({ skipped: true, reason: "usage_db_unavailable" });
      expect(deps.logEvent).toHaveBeenCalledWith({
        status: "failed",
        source: "discovery",
        details: { error: "database is locked" },
      });
      expect(fs.existsSync(kRegistryPath)).toBe(false);
      expect(deps.notify).not.toHaveBeenCalled();
    });

    it("paginates the usage db in batches until a short page", async () => {
      const rows = [];
      for (let i = 1; i <= 5001; i += 1) {
        rows.push({ id: i, sessionKey: "agent:main:telegram:group:-9:topic:1" });
      }
      const usageDb = createFakeUsageDb(rows);
      const { service } = createService({ usageDb });

      const result = await service.sweep();

      expect(usageDb.getTelegramSessionKeysAfterId).toHaveBeenCalledTimes(2);
      expect(usageDb.getTelegramSessionKeysAfterId).toHaveBeenLastCalledWith({
        afterId: 5000,
        limit: 5000,
      });
      expect(result).toMatchObject({ scannedTo: 5001, sightings: 1, discovered: 1 });
    });

    it("logs the name-cache diagnostic once", async () => {
      topicRegistry.setSweepWatermark(1);
      const usageDb = createFakeUsageDb([
        { id: 2, sessionKey: "agent:main:telegram:group:-100:topic:7" },
        { id: 3, sessionKey: "agent:main:telegram:group:-100:topic:8" },
      ]);
      const { service, deps } = createService({ usageDb });

      await service.sweep();
      // Second sweep with more unnamed topics — diagnostic must not repeat.
      usageDb.rows.push({
        id: 4,
        sessionKey: "agent:main:telegram:group:-100:topic:9",
      });
      await service.sweep();

      const diagnosticEvents = deps.logEvent.mock.calls.filter(
        ([event]) => event.source === "name-cache",
      );
      expect(diagnosticEvents).toHaveLength(1);
      expect(diagnosticEvents[0][0].details.diagnostic).toBe("cache_empty");
    });
  });

  describe("noteSessionSeen (label-path bonus)", () => {
    it("upserts fire-and-forget after the immediate-queue flush", async () => {
      const { service, deps } = createService({ usageDb: createFakeUsageDb([]) });

      service.noteSessionSeen("agent:main:telegram:group:-300:topic:12:heartbeat");
      // Fire-and-forget: nothing written synchronously.
      expect(fs.existsSync(kRegistryPath)).toBe(false);

      await flushImmediates();

      const rows = topicRegistry.listTopics();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        groupId: "-300",
        threadId: "12",
        discovered: true,
        seenAgentId: "main",
      });
      // No prompt sync or notification on the label path.
      expect(deps.syncPromptFiles).not.toHaveBeenCalled();
      expect(deps.notify).not.toHaveBeenCalled();
    });

    it("ignores non-topic and malformed keys", async () => {
      const { service } = createService({ usageDb: createFakeUsageDb([]) });
      service.noteSessionSeen("agent:main:telegram:direct:55");
      service.noteSessionSeen("agent:main:telegram:group:-300");
      service.noteSessionSeen("agent:main:cron:sync");
      service.noteSessionSeen("");
      await flushImmediates();
      expect(fs.existsSync(kRegistryPath)).toBe(false);
    });

    it("swallows registry errors (corrupt file) without crashing", async () => {
      fs.mkdirSync(path.dirname(kRegistryPath), { recursive: true });
      fs.writeFileSync(kRegistryPath, "{ corrupt");
      const { service } = createService({ usageDb: createFakeUsageDb([]) });
      service.noteSessionSeen("agent:main:telegram:group:-300:topic:12");
      await flushImmediates();
      expect(fs.readFileSync(kRegistryPath, "utf8")).toBe("{ corrupt");
    });
  });

  describe("start/stop", () => {
    it("starts idempotently and stops cleanly", () => {
      const { service } = createService({ usageDb: createFakeUsageDb([]) });
      service.start();
      expect(service.getStatus().running).toBe(true);
      service.start();
      service.stop();
      expect(service.getStatus().running).toBe(false);
      service.stop();
    });
  });
});
