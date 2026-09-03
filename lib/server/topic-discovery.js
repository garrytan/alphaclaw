const kDefaultSweepIntervalMs = 15 * 60 * 1000;
const kInitialSweepDelayMs = 20 * 1000;
const kSweepBatchSize = 5000;
const kNoteDebounceMs = 10 * 60 * 1000;

// Kill switch (default on): ALPHACLAW_TOPIC_DISCOVERY=false/0/off disables the
// poller, the label-path bonus upserts, and name enrichment in one place.
const isTopicDiscoveryEnabled = (env = process.env) => {
  const raw = String(env.ALPHACLAW_TOPIC_DISCOVERY ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no", "disabled"].includes(raw);
};

// Discovers telegram topics from agent replies: openclaw's usage-tracker
// writes usage_events rows (session_key) only on llm_output, so this sees
// topics the agent has REPLIED in — that is the intended signal. The Bot API
// has no list-forum-topics call, so activity + openclaw's name cache is the
// whole discovery surface.
const createTopicDiscoveryService = ({
  openclawDir,
  topicRegistry,
  usageDb,
  readConfig,
  readNameCache,
  resolveAccountIdForGroup,
  parseTelegramSessionKey,
  syncPromptFiles = () => {},
  notify = null,
  logEvent = () => {},
  intervalMs = kDefaultSweepIntervalMs,
  env = process.env,
  now = () => Date.now(),
}) => {
  const state = {
    timer: null,
    initialTimer: null,
    sweeping: false,
    lastSweepAt: 0,
    lastResult: null,
    diagnosticLogged: false,
    recentlyNoted: new Map(),
  };

  const collectTopicSightings = (afterId) => {
    const sightings = new Map();
    let cursor = afterId;
    let maxId = afterId;
    for (;;) {
      const rows = usageDb.getTelegramSessionKeysAfterId({
        afterId: cursor,
        limit: kSweepBatchSize,
      });
      for (const row of rows) {
        cursor = row.id;
        if (row.id > maxId) maxId = row.id;
        const parsed = parseTelegramSessionKey(row.sessionKey);
        if (!parsed || parsed.scope !== "group" || !parsed.threadId) continue;
        sightings.set(`${parsed.groupId}:${parsed.threadId}`, {
          groupId: parsed.groupId,
          threadId: parsed.threadId,
          agentId: parsed.agentId,
        });
      }
      if (rows.length < kSweepBatchSize) break;
    }
    return { sightings, maxId };
  };

  // Name unnamed (discovered) topics from openclaw's topic-name cache. The
  // cache is scoped per telegram account, so read once per account involved.
  const enrichNamesFromCache = (cfg) => {
    const unnamed = topicRegistry
      .listTopics()
      .filter((row) => !row.deleted && !row.name);
    if (unnamed.length === 0) return { named: 0, names: [] };

    const accountIds = [
      ...new Set(unnamed.map((row) => row.accountId || "default")),
    ];
    const caches = new Map();
    for (const accountId of accountIds) {
      const cache = readNameCache({ openclawDir, cfg, accountId, env });
      caches.set(accountId, cache);
      if (cache.diagnostic && !state.diagnosticLogged) {
        state.diagnosticLogged = true;
        logEvent({
          status: "ok",
          source: "name-cache",
          details: {
            diagnostic: cache.diagnostic,
            namespace: cache.namespace,
            accountId,
          },
        });
      }
    }

    let named = 0;
    const names = [];
    for (const row of unnamed) {
      const cache = caches.get(row.accountId || "default");
      const entry = cache?.entries?.get(`${row.groupId}:${row.threadId}`);
      if (!entry?.name) continue;
      topicRegistry.updateTopic(
        row.groupId,
        row.threadId,
        {
          name: entry.name,
          nameSource: "cache",
          ...(entry.iconColor !== undefined ? { iconColor: entry.iconColor } : {}),
        },
        { source: "cache" },
      );
      named += 1;
      names.push(entry.name);
    }
    return { named, names };
  };

  const sweep = async () => {
    if (!isTopicDiscoveryEnabled(env)) {
      return { skipped: true, reason: "disabled" };
    }
    if (state.sweeping) return { skipped: true, reason: "in_progress" };
    state.sweeping = true;
    try {
      const watermark = topicRegistry.getSweepWatermark();
      // Watermark 0 means this is the cold-start backfill: ingest everything
      // but stay notification-silent (E4.9/10) — one giant "47 new topics"
      // blast on first boot helps nobody.
      const firstSweep = watermark === 0;

      let sightings;
      let maxId;
      try {
        ({ sightings, maxId } = collectTopicSightings(watermark));
      } catch (error) {
        // Usage db locked or not initialized yet — skip this tick cleanly.
        logEvent({
          status: "failed",
          source: "discovery",
          details: { error: error.message },
        });
        return { skipped: true, reason: "usage_db_unavailable" };
      }

      const cfg = readConfig();
      let discovered = 0;
      const discoveredLabels = [];
      for (const sighting of sightings.values()) {
        const accountId = resolveAccountIdForGroup({
          cfg,
          groupId: sighting.groupId,
        });
        const result = topicRegistry.recordDiscoveredTopic(
          {
            groupId: sighting.groupId,
            threadId: sighting.threadId,
            agentId: sighting.agentId,
            accountId,
            seenAtMs: now(),
          },
          { source: "discovery" },
        );
        if (result.discovered) {
          discovered += 1;
          discoveredLabels.push(`${sighting.groupId}#${sighting.threadId}`);
        }
      }

      const { named, names } = enrichNamesFromCache(cfg);

      if (discovered > 0 || named > 0) {
        try {
          syncPromptFiles();
        } catch (error) {
          logEvent({
            status: "failed",
            source: "discovery",
            details: { error: `prompt sync: ${error.message}` },
          });
        }
      }

      if (maxId > watermark) {
        topicRegistry.setSweepWatermark(maxId, { source: "discovery" });
      }

      const summary = {
        firstSweep,
        scannedTo: maxId,
        sightings: sightings.size,
        discovered,
        named,
      };
      logEvent({ status: "ok", source: "discovery", details: summary });

      if (!firstSweep && notify && (discovered > 0 || named > 0)) {
        const parts = [];
        if (discovered > 0) {
          parts.push(
            `${discovered} new topic${discovered === 1 ? "" : "s"} discovered (${discoveredLabels.slice(0, 10).join(", ")}${discoveredLabels.length > 10 ? ", …" : ""})`,
          );
        }
        if (named > 0) {
          parts.push(
            `${named} named from openclaw's cache (${names.slice(0, 10).join(", ")}${names.length > 10 ? ", …" : ""})`,
          );
        }
        try {
          await notify(`📌 Topic discovery: ${parts.join("; ")}.`, {
            eventType: "topic_discovery",
            verbose: true,
          });
        } catch {}
      }

      state.lastSweepAt = now();
      state.lastResult = summary;
      return summary;
    } finally {
      state.sweeping = false;
    }
  };

  // Label-path bonus (dashboard request already parsed a session key):
  // fire-and-forget upsert, no prompt sync, no notification — the next sweep
  // consolidates.
  const noteSessionSeen = (sessionKey) => {
    if (!isTopicDiscoveryEnabled(env)) return;
    const parsed = parseTelegramSessionKey(sessionKey);
    if (!parsed || parsed.scope !== "group" || !parsed.threadId) return;
    // Dashboard label paths call this per session row per request; each upsert
    // is a locked registry write, so debounce repeats per topic.
    const noteKey = `${parsed.groupId}:${parsed.threadId}`;
    const lastNotedAt = state.recentlyNoted.get(noteKey) || 0;
    if (now() - lastNotedAt < kNoteDebounceMs) return;
    state.recentlyNoted.set(noteKey, now());
    if (state.recentlyNoted.size > 4096) state.recentlyNoted.clear();
    setImmediate(() => {
      try {
        const cfg = readConfig();
        topicRegistry.recordDiscoveredTopic(
          {
            groupId: parsed.groupId,
            threadId: parsed.threadId,
            agentId: parsed.agentId,
            accountId: resolveAccountIdForGroup({ cfg, groupId: parsed.groupId }),
            seenAtMs: now(),
          },
          { source: "label-path" },
        );
      } catch {}
    });
  };

  const start = () => {
    if (state.timer) return;
    state.initialTimer = setTimeout(() => {
      sweep().catch(() => {});
    }, kInitialSweepDelayMs);
    state.initialTimer.unref?.();
    state.timer = setInterval(() => {
      sweep().catch(() => {});
    }, intervalMs);
    state.timer.unref?.();
  };

  const stop = () => {
    if (state.timer) clearInterval(state.timer);
    if (state.initialTimer) clearTimeout(state.initialTimer);
    state.timer = null;
    state.initialTimer = null;
  };

  const getStatus = () => ({
    enabled: isTopicDiscoveryEnabled(env),
    running: !!state.timer,
    lastSweepAt: state.lastSweepAt,
    lastResult: state.lastResult,
  });

  return { sweep, start, stop, noteSessionSeen, getStatus };
};

module.exports = {
  kDefaultSweepIntervalMs,
  isTopicDiscoveryEnabled,
  createTopicDiscoveryService,
};
