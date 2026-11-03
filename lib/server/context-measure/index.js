const { callGateway } = require("../gateway-call");
const { normalizeContextWeight, classifySessionKind } = require("./normalize");

// Measured per-turn context (GST-176): what OpenClaw actually put in an
// agent's system prompt on its last run, read from the run report OpenClaw
// stores per session (sessions.usage includeContextWeight). The Doctor's
// estimate models the loader; this is the loader's own record.
//
// One sessions.list (compact, newest first) picks the session, then one
// key-scoped sessions.usage over 7 days reads its report: a list-style
// sessions.usage would summarize every session in the window. Main and direct
// sessions go first because cron, group and subagent runs inject a
// different set of files; another kind is used only when an agent has no
// main or direct run, and the result names the kind.
const kSuccessTtlMs = 60_000;
const kFailureTtlMs = 5_000;
const kListLimit = 20;
const kMaxCandidates = 3;
const kUsageRange = "7d";
const kUnsupportedPattern = /includeContextWeight|unexpected propert|additional propert|unknown propert/i;

const kKindPreference = { main: 0, direct: 1, group: 2, cron: 3, subagent: 4 };

const pickCandidates = (rows, agentId) =>
  (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row.key === "string" && (!row.agentId || row.agentId === agentId))
    .map((row) => ({ row, kind: classifySessionKind(row), updatedAt: Number(row.updatedAt) || 0 }))
    .sort((a, b) => {
      const aPreferred = a.kind === "main" || a.kind === "direct" ? 0 : 1;
      const bPreferred = b.kind === "main" || b.kind === "direct" ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return kKindPreference[a.kind] - kKindPreference[b.kind];
    })
    .slice(0, kMaxCandidates);

const createMeasuredContextReader = ({ clawCmd, now = () => Date.now() } = {}) => {
  const cache = new Map();
  const inFlight = new Map();
  let queueTail = Promise.resolve();

  const runQueued = (task) => {
    const run = queueTail.then(task, task);
    queueTail = run.catch(() => {});
    return run;
  };

  const unavailable = (reason) => ({ available: false, reason });

  const readUncached = async (agentId) => {
    const list = await callGateway(clawCmd, "sessions.list", {
      agentId,
      limit: kListLimit,
      rowMode: "compact",
      sortBy: "updatedAt",
      excludeSystem: true,
    });
    if (!list.ok || !list.body) return unavailable("gateway");
    const candidates = pickCandidates(list.body.sessions, agentId);
    if (candidates.length === 0) return unavailable("no_run");
    for (const { row, kind } of candidates) {
      const usage = await callGateway(clawCmd, "sessions.usage", {
        agentId,
        key: row.key,
        range: kUsageRange,
        includeContextWeight: true,
      });
      if (!usage.ok || !usage.body) {
        const detail = `${usage.stderr} ${JSON.stringify(usage.body || "")}`;
        return unavailable(kUnsupportedPattern.test(detail) ? "unsupported" : "gateway");
      }
      const session = (Array.isArray(usage.body.sessions) ? usage.body.sessions : []).find(
        (entry) => entry?.key === row.key,
      );
      if (session && !("hasContextWeight" in session)) return unavailable("unsupported");
      const measured = normalizeContextWeight(session?.contextWeight, { sessionKind: kind });
      if (measured) return { available: true, agentId, ...measured };
    }
    return unavailable("no_run");
  };

  const read = async (agentId) => {
    const cached = cache.get(agentId);
    if (cached && cached.expiresAt > now()) return cached.value;
    if (inFlight.has(agentId)) return inFlight.get(agentId);
    const pending = (async () => {
      let value;
      try {
        value = await runQueued(() => readUncached(agentId));
      } catch {
        value = unavailable("gateway");
      }
      const writtenAt = now();
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= writtenAt) cache.delete(key);
      }
      cache.set(agentId, {
        value,
        expiresAt: writtenAt + (value.available ? kSuccessTtlMs : kFailureTtlMs),
      });
      return value;
    })();
    inFlight.set(agentId, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(agentId);
    }
  };

  return { read, cacheSize: () => cache.size };
};

module.exports = { createMeasuredContextReader, pickCandidates, kSuccessTtlMs, kFailureTtlMs };
