const loadTopicHelpers = async () =>
  import("../../lib/public/js/components/telegram-workspace/helpers.js");

const kNowMs = Date.UTC(2026, 7, 25, 12, 0, 0);
const kDayMs = 24 * 60 * 60 * 1000;

describe("frontend/telegram-topic-helpers", () => {
  describe("formatRelativeTimestamp", () => {
    it("formats each relative bucket", async () => {
      const { formatRelativeTimestamp } = await loadTopicHelpers();

      expect(formatRelativeTimestamp(kNowMs - 30 * 1000, kNowMs)).toBe("just now");
      expect(formatRelativeTimestamp(kNowMs - 5 * 60 * 1000, kNowMs)).toBe("5m ago");
      expect(formatRelativeTimestamp(kNowMs - 3 * 60 * 60 * 1000, kNowMs)).toBe("3h ago");
      expect(formatRelativeTimestamp(kNowMs - 12 * kDayMs, kNowMs)).toBe("12d ago");
    });

    it("returns never for missing or invalid timestamps", async () => {
      const { formatRelativeTimestamp } = await loadTopicHelpers();

      expect(formatRelativeTimestamp(0, kNowMs)).toBe("never");
      expect(formatRelativeTimestamp(null, kNowMs)).toBe("never");
      expect(formatRelativeTimestamp("garbage", kNowMs)).toBe("never");
    });
  });

  describe("buildTopicRowModel", () => {
    it("builds a plain named row without badges", async () => {
      const { buildTopicRowModel } = await loadTopicHelpers();

      const model = buildTopicRowModel(
        {
          groupId: "-100123",
          threadId: "42",
          name: "Ops",
          lastSeenAt: kNowMs - kDayMs,
          seenAgentId: "",
        },
        { nowMs: kNowMs },
      );

      expect(model.displayName).toBe("Ops");
      expect(model.discovered).toBe(false);
      expect(model.stale).toBe(false);
      expect(model.deleted).toBe(false);
      expect(model.unattributed).toBe(false);
      expect(model.health.lastSeenLabel).toBe("last seen 1d ago");
      expect(model.health.quiet).toBe(false);
      expect(model.health.seenByLabel).toBe("");
    });

    it("marks discovered, stale, and seen-by-agent state", async () => {
      const { buildTopicRowModel } = await loadTopicHelpers();

      const model = buildTopicRowModel(
        {
          groupId: "-100123",
          threadId: "9",
          name: "",
          discovered: true,
          stale: true,
          lastSeenAt: kNowMs - 2 * kDayMs,
          seenAgentId: "ops-agent",
        },
        { nowMs: kNowMs },
      );

      expect(model.displayName).toBe("Topic 9");
      expect(model.discovered).toBe(true);
      expect(model.stale).toBe(true);
      expect(model.health.seenByLabel).toBe("seen by agent ops-agent");
    });

    it("goes quiet only past the 30-day threshold", async () => {
      const { buildTopicRowModel, kTopicQuietThresholdMs } = await loadTopicHelpers();

      const atThreshold = buildTopicRowModel(
        { threadId: "1", lastSeenAt: kNowMs - kTopicQuietThresholdMs },
        { nowMs: kNowMs },
      );
      const pastThreshold = buildTopicRowModel(
        { threadId: "1", lastSeenAt: kNowMs - kTopicQuietThresholdMs - 1 },
        { nowMs: kNowMs },
      );
      const neverSeen = buildTopicRowModel({ threadId: "1" }, { nowMs: kNowMs });

      expect(kTopicQuietThresholdMs).toBe(30 * kDayMs);
      expect(atThreshold.health.quiet).toBe(false);
      expect(pastThreshold.health.quiet).toBe(true);
      expect(neverSeen.health.quiet).toBe(false);
      expect(neverSeen.health.lastSeenLabel).toBe("—");
    });

    it("labels cache-sourced names as last seen by openclaw", async () => {
      const { buildTopicRowModel } = await loadTopicHelpers();

      const model = buildTopicRowModel(
        {
          threadId: "7",
          name: "Standup",
          nameSource: "cache",
          lastSeenAt: kNowMs - 4 * 60 * 60 * 1000,
        },
        { nowMs: kNowMs },
      );

      expect(model.health.lastSeenLabel).toBe("last seen by openclaw 4h ago");
    });

    it("flags unattributed accounts only in accounts-mode", async () => {
      const { buildTopicRowModel } = await loadTopicHelpers();

      const row = { threadId: "5", accountId: null };
      expect(
        buildTopicRowModel(row, { nowMs: kNowMs, accountsMode: true }).unattributed,
      ).toBe(true);
      expect(
        buildTopicRowModel(row, { nowMs: kNowMs, accountsMode: false }).unattributed,
      ).toBe(false);
      expect(
        buildTopicRowModel(
          { threadId: "5", accountId: "alerts" },
          { nowMs: kNowMs, accountsMode: true },
        ).unattributed,
      ).toBe(false);
    });

    it("suppresses discovered/stale badges on tombstoned rows", async () => {
      const { buildTopicRowModel } = await loadTopicHelpers();

      const model = buildTopicRowModel(
        {
          threadId: "3",
          name: "Old",
          discovered: true,
          stale: true,
          deleted: true,
          deletedAt: kNowMs - kDayMs,
        },
        { nowMs: kNowMs },
      );

      expect(model.deleted).toBe(true);
      expect(model.deletedAt).toBe(kNowMs - kDayMs);
      expect(model.discovered).toBe(false);
      expect(model.stale).toBe(false);
    });
  });

  describe("splitTopicRows", () => {
    it("routes rows into active, discovered, and deleted sections", async () => {
      const { splitTopicRows } = await loadTopicHelpers();

      const sections = splitTopicRows(
        [
          { threadId: "1", name: "Named" },
          { threadId: "2", name: "", discovered: true },
          { threadId: "3", name: "Cache Named", discovered: true },
          { threadId: "4", name: "Gone", deleted: true, deletedAt: kNowMs - kDayMs },
          { threadId: "5", name: "Gone later", deleted: true, deletedAt: kNowMs },
          { threadId: "", name: "no thread id" },
        ],
        { nowMs: kNowMs },
      );

      expect(sections.active.map((m) => m.threadId)).toEqual(["1", "3"]);
      expect(sections.discovered.map((m) => m.threadId)).toEqual(["2"]);
      expect(sections.deleted.map((m) => m.threadId)).toEqual(["5", "4"]);
    });

    it("handles non-array input", async () => {
      const { splitTopicRows } = await loadTopicHelpers();

      expect(splitTopicRows(null)).toEqual({
        active: [],
        discovered: [],
        deleted: [],
      });
    });
  });

  describe("buildDiscoveryStatusModel", () => {
    it("returns null when discovery status is absent", async () => {
      const { buildDiscoveryStatusModel } = await loadTopicHelpers();

      expect(buildDiscoveryStatusModel(null)).toBeNull();
      expect(buildDiscoveryStatusModel("nope")).toBeNull();
    });

    it("summarizes an enabled discovery service with a last result", async () => {
      const { buildDiscoveryStatusModel } = await loadTopicHelpers();

      const model = buildDiscoveryStatusModel(
        {
          enabled: true,
          running: true,
          lastSweepAt: kNowMs - 10 * 60 * 1000,
          lastResult: { discovered: 3, named: 1 },
        },
        { nowMs: kNowMs },
      );

      expect(model.enabled).toBe(true);
      expect(model.enabledLabel).toBe("on");
      expect(model.lastSweepLabel).toBe("10m ago");
      expect(model.resultLabel).toBe("3 discovered, 1 named");
    });

    it("reports off/never and hides skipped results", async () => {
      const { buildDiscoveryStatusModel } = await loadTopicHelpers();

      const model = buildDiscoveryStatusModel(
        {
          enabled: false,
          lastSweepAt: 0,
          lastResult: { skipped: true, reason: "disabled" },
        },
        { nowMs: kNowMs },
      );

      expect(model.enabledLabel).toBe("off");
      expect(model.lastSweepLabel).toBe("never");
      expect(model.resultLabel).toBe("");
    });
  });

  describe("buildRegistryErrorBanner", () => {
    it("builds a banner for both unreadable codes", async () => {
      const { buildRegistryErrorBanner } = await loadTopicHelpers();

      const registryBanner = buildRegistryErrorBanner({
        ok: false,
        code: "TOPIC_REGISTRY_UNREADABLE",
        error: "registry file is corrupt",
      });
      const configBanner = buildRegistryErrorBanner({
        ok: false,
        code: "OPENCLAW_CONFIG_UNREADABLE",
        error: "config parse failed",
      });

      expect(registryBanner.title).toBe("Topic registry is unreadable");
      expect(registryBanner.text).toBe("registry file is corrupt");
      expect(configBanner.title).toBe("OpenClaw config is unreadable");
      expect(configBanner.text).toBe("config parse failed");
    });

    it("falls back to a default banner text when error is empty", async () => {
      const { buildRegistryErrorBanner } = await loadTopicHelpers();

      const banner = buildRegistryErrorBanner({
        ok: false,
        code: "TOPIC_REGISTRY_UNREADABLE",
        error: "",
      });

      expect(banner.text).toContain("Registry writes are paused");
    });

    it("returns null for ok payloads and unknown codes", async () => {
      const { buildRegistryErrorBanner } = await loadTopicHelpers();

      expect(buildRegistryErrorBanner(null)).toBeNull();
      expect(buildRegistryErrorBanner({ ok: true })).toBeNull();
      expect(
        buildRegistryErrorBanner({ ok: false, code: "SOMETHING_ELSE" }),
      ).toBeNull();
      expect(buildRegistryErrorBanner({ ok: false })).toBeNull();
    });
  });

  describe("rename state (recoverable failure)", () => {
    it("keeps the typed value after a failed save so retry is possible", async () => {
      const {
        createTopicRenameState,
        topicRenameStateWithValue,
        topicRenameStateSaving,
        topicRenameStateFailed,
      } = await loadTopicHelpers();

      let state = createTopicRenameState("42");
      expect(state).toEqual({ threadId: "42", value: "", saving: false, error: null });

      state = topicRenameStateWithValue(state, "Ops room");
      state = topicRenameStateSaving(state);
      expect(state.saving).toBe(true);
      expect(state.error).toBeNull();

      state = topicRenameStateFailed(state, new Error("registry locked"));
      expect(state.value).toBe("Ops room");
      expect(state.saving).toBe(false);
      expect(state.error).toBe("registry locked");

      // Editing after a failure clears the error but keeps typing intact.
      state = topicRenameStateWithValue(state, "Ops room 2");
      expect(state.value).toBe("Ops room 2");
      expect(state.error).toBeNull();
    });

    it("falls back to a default error message", async () => {
      const { createTopicRenameState, topicRenameStateFailed } =
        await loadTopicHelpers();

      const state = topicRenameStateFailed(createTopicRenameState("1", "x"), "");
      expect(state.error).toBe("Failed to save topic name");
    });
  });

  describe("verify/restore row updates", () => {
    const kRows = [
      { groupId: "-100123", threadId: "42", stale: true, deleted: false },
      { groupId: "-100123", threadId: "43", stale: false, deleted: true, deletedAt: 5 },
    ];

    it("applyVerifyResult clears or keeps the stale flag from the response", async () => {
      const { applyVerifyResult } = await loadTopicHelpers();

      const cleared = applyVerifyResult(kRows, "-100123", "42", "ok");
      expect(cleared[0].stale).toBe(false);
      expect(cleared[1]).toEqual(kRows[1]);

      const kept = applyVerifyResult(kRows, "-100123", "42", "stale");
      expect(kept[0].stale).toBe(true);
    });

    it("applyRestoreResult clears the tombstone on the matching row", async () => {
      const { applyRestoreResult } = await loadTopicHelpers();

      const restored = applyRestoreResult(kRows, "-100123", "43");
      expect(restored[1].deleted).toBe(false);
      expect(restored[1].deletedAt).toBe(0);
      expect(restored[0]).toEqual(kRows[0]);
    });

    it("tolerates non-array rows", async () => {
      const { applyVerifyResult, applyRestoreResult } = await loadTopicHelpers();

      expect(applyVerifyResult(null, "g", "1", "ok")).toEqual([]);
      expect(applyRestoreResult(undefined, "g", "1")).toEqual([]);
    });
  });
});

describe("frontend/telegram-api resetWorkspace modes", () => {
  const loadTelegramApi = async () =>
    import("../../lib/public/js/lib/telegram-api.js");

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ ok: true }),
      text: async () => JSON.stringify({ ok: true }),
    });
    global.window = { location: { href: "http://localhost/" } };
  });

  afterEach(() => {
    delete global.fetch;
    delete global.window;
  });

  it("defaults to keep mode", async () => {
    const api = await loadTelegramApi();

    await api.resetWorkspace({ accountId: "alerts" });

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("/api/telegram/workspace/reset?accountId=alerts");
    expect(options.method).toBe("POST");
    expect(options.body).toBe(JSON.stringify({ mode: "keep" }));
  });

  it("passes rediscover mode through and normalizes unknown modes", async () => {
    const api = await loadTelegramApi();

    await api.resetWorkspace({ mode: "rediscover" });
    await api.resetWorkspace({ mode: "nuke-everything" });

    expect(global.fetch.mock.calls[0][1].body).toBe(
      JSON.stringify({ mode: "rediscover" }),
    );
    expect(global.fetch.mock.calls[1][1].body).toBe(
      JSON.stringify({ mode: "keep" }),
    );
  });
});
