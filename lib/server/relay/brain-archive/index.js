const crypto = require("crypto");
const { buildHistoryMessages } = require("../../chat/history");
const { openArchiveStore } = require("./store");
const { createGbrainRunner, resolveGbrainBin } = require("./gbrain");
const { buildEntries, renderPage, planParts, hashPage, conversationSlug, partSlug } = require("./render");
const { findSecretResidue } = require("./privacy");
const { kRelaySessionPrefix } = require("../constants");

// Relay brain archive (ALPH-68 PR3): every relay DM conversation, with the
// box agent's session work, saved as a gbrain page in the "relay" source.
//
//   timer (30 s, one tick at a time)
//     -> gbrain present and the relay source exists, not federated
//        (checked, never created: GBRA-295 owns the source)
//     -> scan: conversations whose engine mark or bridge state moved are due
//     -> due 2 min after their last change (15 min at most while busy)
//     -> render (masked, private classes withheld) -> unchanged hash: skip
//     -> one serial gbrain put per part page, 2 s apart
//          0 committed · 10 pending: poll write-request, never resubmit
//          3 stop: parked until a person presses Retry
//          75 / retryable 1 (queue_capacity, lock busy): backoff, same request
//          revision_required: re-read the page's revision, write once
//          revision_conflict: parked (the page changed in the brain)
//     -> one gbrain git commit-push per batch for the committed pages
//
// The bridge never waits on any of it: the archive only reads the engine,
// the bridge's store and the session, on its own timer.
const kTickMs = 30 * 1000;
const kFirstTickMs = 15 * 1000;
const kDebounceMs = 2 * 60 * 1000;
const kBusyCapMs = 15 * 60 * 1000;
const kBackoffMinMs = 60 * 1000;
const kBackoffMaxMs = 6 * 60 * 60 * 1000;
const kPendingPollMinMs = 2 * 1000;
const kPendingPollMaxMs = 5 * 60 * 1000;
const kUnavailableRecheckMs = 10 * 60 * 1000;
const kReadyRecheckMs = 60 * 60 * 1000;
const kRevisitWindowMs = 24 * 60 * 60 * 1000;
const kRevisitEveryMs = 60 * 60 * 1000;
const kBatchMax = 10;
const kWriteGapMs = 2000;
const kMaxReplans = 8;
const kDefaultPeerDailyBytes = 8 * 1024 * 1024;
const kDefaultPeerTotalBytes = 512 * 1024 * 1024;
const kDayMs = 24 * 60 * 60 * 1000;
const kCommitBatchMax = 100;
const kTranscriptPageSize = 50;
const kTranscriptPagesMax = 400;
const kHistoryPageSize = 1000;
const kHistoryPagesMax = 20;
const kHistoryTimeoutMs = 30 * 1000;
const kRetryableCodes = new Set(["queue_capacity", "write_pending", "lock_busy", "commit_lock_busy", "writer_busy", "pglite_busy", "maintenance_lock_busy"]);

const describeRun = (result) => {
  if (result.spawnError) return "spawn " + result.spawnError;
  if (result.timedOut) return "timed out";
  return "exit " + result.exitCode + (result.json?.code ? " " + result.json.code : "");
};

const resultCode = (json) => String(json?.code || json?.write_error || json?.error || "").trim() || null;

// One gbrain run, in AlphaClaw's words.
const classifyWrite = (result) => {
  if (result.spawnError === "ENOENT" || result.spawnError === "EACCES") return { kind: "missing" };
  if (result.spawnError || result.timedOut || result.exitCode === null) return { kind: "busy", code: "gbrain_failed", sameRequest: true, ambiguous: true };
  const json = result.json || {};
  const state = String(json.state || json.write_request?.state || "");
  if (result.exitCode === 0) {
    if (state === "queued" || state === "running" || state === "pending") return { kind: "pending", retryAfterMs: json.retry_after_ms };
    if (state === "conflict" || state === "failed" || state === "cancelled") return classifyFailure(json);
    return { kind: "committed", revision: json.revision || json.outcome?.revision || json.write_request?.revision || null };
  }
  if (result.exitCode === 10) return { kind: "pending", retryAfterMs: json.retry_after_ms ?? json.write_request?.retry_after_ms };
  if (result.exitCode === 3) return { kind: "stop", code: "gbrain_stopped" };
  if (result.exitCode === 75) return { kind: "busy", code: "gbrain_busy", sameRequest: true };
  if (result.exitCode === 124) return { kind: "busy", code: "gbrain_failed", sameRequest: true, ambiguous: true };
  if (result.exitCode === 1) return classifyFailure(json);
  return { kind: "failed", code: "gbrain_failed", sameRequest: false };
};

const classifyFailure = (json) => {
  const code = resultCode(json);
  if (code === "revision_required") return { kind: "revision_required" };
  if (code === "revision_conflict") return { kind: "revision_conflict" };
  if (json?.retryable === true || kRetryableCodes.has(code)) return { kind: "busy", code: "gbrain_busy", sameRequest: true, gbrainCode: code };
  return { kind: "failed", code: "gbrain_failed", sameRequest: false, gbrainCode: code };
};

const createRelayBrainArchive = ({
  config,
  paths,
  engine,
  getAuth,
  conversations,
  getBridgeStore = () => null,
  requestGateway = null,
  resolveAgentId = () => "main",
  maskText,
  collectSecrets = () => [],
  runner = null,
  env = process.env,
  fsModule = undefined,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
}) => {
  const enabled = config.brainMode !== "off";
  const peerDailyBytes = config.brainPeerDailyBytes || kDefaultPeerDailyBytes;
  const peerTotalBytes = config.brainPeerTotalBytes || kDefaultPeerTotalBytes;
  const bin = runner ? null : resolveGbrainBin({ configured: config.brainBin, ...(fsModule ? { fsModule } : {}) });
  const gbrain = runner || (bin ? createGbrainRunner({ bin, env }) : null);
  const state = {
    phase: enabled ? "checking" : "off",
    code: null,
    checkout: null,
    checkedAt: 0,
    lastSavedAt: null,
    lastError: null,
    lastCommitAt: null,
    commitError: null,
    commitRetryAt: 0,
    commitAttempts: 0,
    commitStopped: false,
    running: false,
    timer: null,
    stopped: false,
    store: null,
    lastScanError: null,
  };

  const log = (line) => logger.log("[relay-archive] " + line);
  const warn = (line) => logger.warn("[relay-archive] " + line);
  const tail = (text) => String(maskText(String(text || "")) || "").trim().split("\n").slice(-3).join(" | ").slice(-300);
  const store = () => {
    if (!state.store) state.store = openArchiveStore({ dbPath: paths.archiveDb, now });
    return state.store;
  };
  const noteError = (code) => {
    state.lastError = { code, at: new Date(now()).toISOString() };
  };

  const checkAvailability = async () => {
    state.checkedAt = now();
    if (!gbrain) {
      state.phase = "unavailable";
      state.code = "gbrain_missing";
      return;
    }
    const result = await gbrain.listSources();
    if (result.spawnError === "ENOENT" || result.spawnError === "EACCES") {
      state.phase = "unavailable";
      state.code = "gbrain_missing";
      return;
    }
    const sources = Array.isArray(result.json?.sources) ? result.json.sources : null;
    if (result.exitCode !== 0 || !sources) {
      state.phase = "unavailable";
      state.code = "gbrain_failed";
      warn("gbrain sources list failed (" + describeRun(result) + "): " + tail(result.stderr));
      return;
    }
    const relay = sources.find((source) => source?.id === "relay");
    if (!relay || !relay.local_path || relay.archived) {
      state.phase = "unavailable";
      state.code = "source_missing";
      return;
    }
    if (relay.federated !== false) {
      state.phase = "unavailable";
      state.code = "source_federated";
      return;
    }
    if (state.phase !== "ready") log("ready: gbrain source relay (not federated)");
    state.phase = "ready";
    state.code = null;
    state.checkout = String(relay.local_path);
  };

  // A conversation is due when its engine mark (message count, last
  // message) or its newest bridge row moved. Thread replies do not always
  // move the engine mark, so a conversation active in the last day is also
  // looked at again once an hour; an unchanged page is never rewritten.
  const scan = async () => {
    const { workspaceKey, agentName } = getAuth();
    const list = await engine.conversations(workspaceKey);
    const bridgeLatest = new Map();
    for (const row of getBridgeStore()?.latestPerConversation?.() || []) bridgeLatest.set(String(row.conversationId), row);
    const archive = store();
    for (const conversation of Array.isArray(list) ? list : []) {
      const participants = Array.isArray(conversation?.participants) ? conversation.participants.map(String) : [];
      if (!conversation?.id || participants.length !== 2) continue;
      const boxAgent = participants.includes(agentName);
      const [first, second] = [...participants].sort();
      const relayAgent = boxAgent ? agentName : first;
      const relayPeer = boxAgent ? participants.find((name) => name !== agentName) : second;
      const bridge = bridgeLatest.get(String(conversation.id));
      const sourceMark = [
        Number(conversation.message_count) || 0,
        conversation.last_message?.id || "",
        conversation.last_message?.created_at || "",
        bridge ? bridge.messageId + ":" + bridge.state + ":" + bridge.updatedAt : "",
      ].join("|");
      archive.noteActivity({ conversationId: String(conversation.id), relayAgent, relayPeer, boxAgent, sourceMark });
      const stored = archive.getConversation(conversation.id);
      if (
        stored.state === "idle" &&
        now() - stored.lastActivityAt < kRevisitWindowMs &&
        now() - (stored.lastSavedAt || 0) >= kRevisitEveryMs &&
        now() - (stored.nextAttemptAt || 0) >= kRevisitEveryMs
      ) {
        archive.updateConversation(stored.conversationId, { state: "due", nextAttemptAt: now() });
      }
    }
  };

  const readEngineMessages = async (conversationId) => {
    const messages = [];
    let before = null;
    for (let page = 0; page < kTranscriptPagesMax; page += 1) {
      const result = await conversations.transcript(conversationId, { before, limit: kTranscriptPageSize, strict: true });
      messages.push(...result.messages);
      if (!result.nextBefore) break;
      before = result.nextBefore;
    }
    return messages;
  };

  const readSession = async (sessionKey) => {
    if (typeof requestGateway !== "function") return [];
    const rows = [];
    let cursor = null;
    for (let page = 0; page < kHistoryPagesMax; page += 1) {
      const history = await requestGateway("chat.history", { sessionKey, limit: kHistoryPageSize, ...(cursor ? { cursor } : {}) }, kHistoryTimeoutMs);
      rows.unshift(...buildHistoryMessages({ history, sessionKey }).messages);
      cursor = String(history?.olderCursor || "");
      if (!cursor) break;
    }
    return rows;
  };

  const backoff = (conversation, code, { attempts = conversation.attempts + 1, delayMs = null } = {}) => {
    const delay = delayMs ?? Math.min(kBackoffMaxMs, kBackoffMinMs * 2 ** Math.min(attempts - 1, 16));
    store().updateConversation(conversation.conversationId, { state: "backoff", code, attempts, nextAttemptAt: now() + delay });
  };
  const park = (conversation, code) => {
    store().updateConversation(conversation.conversationId, { state: "parked", code, nextAttemptAt: 0 });
    noteError(code);
    warn("conversation " + conversation.conversationId + " parked: " + code + " (waits for Retry on the Relay page)");
  };

  const utcDay = () => new Date(now()).toISOString().slice(0, 10);

  const markCommitted = (conversation, part, slug, hash, revision) => {
    const row = store().listParts(conversation.conversationId).find((candidate) => candidate.part === part.part);
    const bytes = row?.pendingMarkdown ? Buffer.byteLength(row.pendingMarkdown) : row?.savedBytes || 0;
    store().addPeerBytes(conversation.relayPeer, utcDay(), bytes - (row?.savedBytes || 0));
    store().updatePart(conversation.conversationId, part.part, {
      savedBytes: bytes,
      savedHash: hash,
      revision,
      pendingMarkdown: null,
      pendingHash: null,
      requestId: null,
      requestPending: false,
      savedAt: now(),
    });
    store().queueCommit(slug + ".md");
    state.lastSavedAt = new Date(now()).toISOString();
  };

  // A queued write commits when gbrain's writer gets to it; the receipt is
  // read again after gbrain's retry_after_ms, then less often (30 s doubling
  // to 5 min) while it stays queued.
  const pendingDelay = (retryAfterMs, polls) =>
    Math.min(kPendingPollMaxMs, Math.max(kPendingPollMinMs, Number(retryAfterMs) || 0, polls ? kTickMs * 2 ** Math.min(polls - 1, 8) : 0));

  // Returns "done" when this part needs nothing more now, else the
  // conversation's state was set and processing stops.
  const settleOutcome = (conversation, part, slug, outcome, hash) => {
    if (outcome.kind === "committed") {
      markCommitted(conversation, part, slug, hash, outcome.revision);
      return "done";
    }
    if (outcome.kind === "pending") {
      store().updatePart(conversation.conversationId, part.part, { requestPending: true });
      backoff(conversation, "write_pending", { attempts: conversation.attempts + 1, delayMs: pendingDelay(outcome.retryAfterMs, conversation.attempts) });
      return "stop";
    }
    if (outcome.kind === "missing") {
      state.phase = "unavailable";
      state.code = "gbrain_missing";
      state.checkedAt = now();
      return "stop";
    }
    if (outcome.kind === "stop") {
      store().updatePart(conversation.conversationId, part.part, { requestPending: false, requestId: null });
      park(conversation, "gbrain_stopped");
      return "stop";
    }
    if (outcome.kind === "revision_conflict") {
      store().updatePart(conversation.conversationId, part.part, { requestPending: false, requestId: null });
      park(conversation, "revision_conflict");
      return "stop";
    }
    if (outcome.kind === "busy") {
      // A put that timed out or was killed may still have been accepted, so
      // its request is read back before any other write to this page.
      store().updatePart(conversation.conversationId, part.part, { requestPending: Boolean(outcome.ambiguous), ...(outcome.sameRequest ? {} : { requestId: null }) });
      backoff(conversation, outcome.code);
      if (outcome.code !== "gbrain_busy") noteError(outcome.code);
      return "stop";
    }
    store().updatePart(conversation.conversationId, part.part, { requestPending: false, requestId: null });
    backoff(conversation, outcome.code || "gbrain_failed");
    noteError(outcome.code || "gbrain_failed");
    return "stop";
  };

  // The page already exists and this box holds no revision for it: read it,
  // and use it only when its frontmatter names this conversation.
  const readOwnPage = async (conversation, slug) => {
    const result = await gbrain.getPage(slug);
    if (result.exitCode !== 0 || !result.json?.revision) return null;
    const frontmatter = result.json.frontmatter || {};
    if (frontmatter.conversation_id === undefined || String(frontmatter.conversation_id) !== String(conversation.conversationId)) return null;
    return { revision: String(result.json.revision), body: String(result.json.compiled_truth || "") + "\n" + String(result.json.timeline || "") };
  };

  // An entry is on a found page when the page holds its heading up to the
  // author (a status label may have changed since) followed by its body,
  // each place on the page counted for one entry only. Only a heading at
  // the start of a line outside every fence counts: a message that quotes
  // another entry carries that copy inside its own fence.
  const entriesOnPage = (entries, body) => {
    const topLevel = new Set();
    let fenceMarks = "";
    for (let at = 0; at <= body.length; ) {
      const lineEnd = body.indexOf("\n", at);
      const line = body.slice(at, lineEnd === -1 ? body.length : lineEnd);
      if (fenceMarks) {
        if (line === fenceMarks) fenceMarks = "";
      } else {
        const open = /^(\x60{3,})text$/.exec(line);
        if (open) fenceMarks = open[1];
        else topLevel.add(at);
      }
      if (lineEnd === -1) break;
      at = lineEnd + 1;
    }
    const used = new Set();
    const found = [];
    for (const entry of entries) {
      if (!entry.block) {
        found.push(entry.id);
        continue;
      }
      const [heading, ...rest] = entry.block.split("\n");
      const key = heading.split(" · ").slice(0, 2).join(" · ");
      const tail = rest.join("\n");
      for (let at = body.indexOf(key); at !== -1; at = body.indexOf(key, at + 1)) {
        const lineEnd = body.indexOf("\n", at);
        if (used.has(at) || !topLevel.has(at) || lineEnd === -1 || !body.startsWith(tail, lineEnd + 1)) continue;
        used.add(at);
        found.push(entry.id);
        break;
      }
    }
    return found;
  };

  const currentPart = (conversation, part) => store().listParts(conversation.conversationId).find((row) => row.part === part.part);

  // Checked right before a put, after any pending write of the part is
  // resolved, so the growth is measured against what the brain holds.
  const overBudget = (conversation, markdown, savedBytes) => {
    const growth = Buffer.byteLength(markdown) - (savedBytes || 0);
    if (growth <= 0) return false;
    const usage = store().peerUsage(conversation.relayPeer, utcDay());
    if (usage.totalBytes + growth > peerTotalBytes) {
      park(conversation, "peer_budget_total");
      warn("@" + conversation.relayPeer + " is past its brain archive budget (" + usage.totalBytes + " of " + peerTotalBytes + " bytes); its conversations wait until the budget is raised and Retry is pressed");
      return true;
    }
    if (usage.dayBytes > 0 && usage.dayBytes + growth > peerDailyBytes) {
      backoff(conversation, "peer_budget_daily", { delayMs: Math.ceil((now() + 1) / kDayMs) * kDayMs - now() });
      log("@" + conversation.relayPeer + " reached today's brain archive budget (" + usage.dayBytes + " of " + peerDailyBytes + " bytes); saving resumes after 00:00 UTC");
      return true;
    }
    return false;
  };

  const writePart = async (conversation, part, slug, markdown, hash, partEntries) => {
    let current = currentPart(conversation, part);
    if (current.requestPending && current.requestId) {
      const result = await gbrain.readWriteRequest(current.requestId);
      const outcome = classifyWrite(result);
      if (outcome.kind === "committed") {
        markCommitted(conversation, part, slug, current.pendingHash, outcome.revision);
        current = currentPart(conversation, part);
      } else if (outcome.kind === "failed" && outcome.gbrainCode === "not_found") {
        store().updatePart(conversation.conversationId, part.part, { requestPending: false });
        current = currentPart(conversation, part);
      } else if (outcome.kind === "busy") {
        backoff(conversation, outcome.code);
        return "stop";
      } else {
        if (outcome.kind !== "pending") warn("write request for " + slug + " ended " + describeRun(result));
        return settleOutcome(conversation, part, slug, outcome, hash);
      }
    }
    if (current.savedHash === hash) return "done";
    if (overBudget(conversation, markdown, current.savedBytes)) return "stop";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestId = current.pendingHash === hash && current.requestId ? current.requestId : crypto.randomUUID();
      store().updatePart(conversation.conversationId, part.part, { pendingMarkdown: markdown, pendingHash: hash, requestId });
      const result = await gbrain.putPage({ slug, markdown, requestId, expectedRevision: current.revision });
      const outcome = classifyWrite(result);
      if (outcome.kind !== "committed") log("put " + slug + ": " + describeRun(result) + (result.stderr && outcome.kind !== "pending" ? " " + tail(result.stderr) : ""));
      if (outcome.kind !== "revision_required") return settleOutcome(conversation, part, slug, outcome, hash);
      const page = attempt === 0 ? await readOwnPage(conversation, slug) : null;
      if (!page) return settleOutcome(conversation, part, slug, { kind: "revision_conflict" }, hash);
      if (!current.savedHash) {
        // This box never wrote this part (archive.db lost or replaced), so the
        // page may hold messages the engine no longer has: it is kept as it
        // is, and entries it does not hold continue on the next part.
        const onPage = entriesOnPage(partEntries, page.body);
        store().upsertPart({ conversationId: conversation.conversationId, part: part.part, slug, entryIds: onPage, closed: true });
        store().updatePart(conversation.conversationId, part.part, { frozen: true, revision: page.revision, pendingMarkdown: null, pendingHash: null, requestId: null });
        log("kept " + slug + " as found (written before this archive.db); new messages continue on the next part");
        return "replan";
      }
      store().updatePart(conversation.conversationId, part.part, { revision: page.revision, requestId: null });
      current = currentPart(conversation, part);
    }
    return "stop";
  };

  const processConversation = async (conversation, replans = 0) => {
    const archive = store();
    let entries;
    try {
      const { agentName } = getAuth();
      const messages = await readEngineMessages(conversation.conversationId);
      const sessionRows = conversation.boxAgent
        ? await readSession("agent:" + resolveAgentId() + ":" + kRelaySessionPrefix + conversation.relayPeer.toLowerCase())
        : [];
      entries = buildEntries({ boxAgent: conversation.boxAgent ? agentName : null, messages, sessionRows, maskText }).entries;
    } catch (error) {
      backoff(conversation, "relay_read_failed");
      warn("could not read conversation " + conversation.conversationId + ": " + tail(error?.message || error));
      return;
    }
    const baseSlug = conversationSlug(conversation);
    const stored = archive.listParts(conversation.conversationId);
    const plan = planParts({ storedParts: stored, entries });
    for (const part of plan) {
      if (part.changed) archive.upsertPart({ conversationId: conversation.conversationId, part: part.part, slug: partSlug(baseSlug, part.part), entryIds: part.entryIds, closed: part.closed });
    }
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    let wrote = false;
    for (const part of plan) {
      const slug = partSlug(baseSlug, part.part);
      const row = archive.listParts(conversation.conversationId).find((candidate) => candidate.part === part.part);
      if (row.frozen) continue;
      const markdown = part.complete
        ? renderPage({ conversation, part: part.part, entries: part.entryIds.map((id) => byId.get(id)) })
        : row.pendingMarkdown;
      if (!markdown) continue;
      const hash = hashPage(markdown);
      if (hash === row.savedHash && !row.requestPending) continue;
      const residue = findSecretResidue(markdown, { secrets: collectSecrets() });
      if (residue) {
        archive.updatePart(conversation.conversationId, part.part, { pendingMarkdown: null, pendingHash: null, requestId: null });
        park(conversation, "masked_refused");
        warn("page " + slug + " refused: it still matched the secret scanner (" + residue + ") after masking; nothing was written");
        return;
      }
      if (wrote) await sleep(kWriteGapMs);
      const outcome = await writePart(conversation, part, slug, markdown, hash, part.entryIds.map((id) => byId.get(id)).filter(Boolean));
      wrote = true;
      if (outcome === "replan" && replans < kMaxReplans) return processConversation(conversation, replans + 1);
      if (outcome !== "done") return;
    }
    archive.updateConversation(conversation.conversationId, {
      state: "idle",
      code: null,
      attempts: 0,
      nextAttemptAt: now(),
      dirtySince: null,
      ...(wrote ? { lastSavedAt: now() } : {}),
    });
  };

  const commitBatch = async () => {
    if (state.commitStopped || now() < state.commitRetryAt || !state.checkout) return;
    const archive = store();
    const pagePaths = archive.listCommits(kCommitBatchMax);
    if (!pagePaths.length) return;
    const result = await gbrain.commitPush({
      checkout: state.checkout,
      message: "relay archive: " + pagePaths.length + " page" + (pagePaths.length === 1 ? "" : "s"),
      paths: pagePaths,
    });
    if (result.exitCode === 0 || result.exitCode === 4) {
      archive.clearCommits(pagePaths);
      state.lastCommitAt = new Date(now()).toISOString();
      state.commitError = null;
      state.commitAttempts = 0;
      log("committed " + pagePaths.length + " page(s): " + (result.json?.outcome || "ok"));
      return;
    }
    if (result.spawnError === "ENOENT" || result.spawnError === "EACCES") {
      state.phase = "unavailable";
      state.code = "gbrain_missing";
      state.checkedAt = now();
      return;
    }
    const code = resultCode(result.json);
    if (result.exitCode === 3) {
      state.commitStopped = true;
      state.commitError = { code: "gbrain_stopped", at: new Date(now()).toISOString() };
      warn("gbrain git commit-push asked for a person (exit 3); commits wait for Retry");
      return;
    }
    const busy = result.exitCode === 75 || result.json?.retryable === true || kRetryableCodes.has(code);
    state.commitAttempts += 1;
    state.commitRetryAt = now() + Math.min(kBackoffMaxMs, kBackoffMinMs * 2 ** Math.min(state.commitAttempts - 1, 16));
    if (!busy) state.commitError = { code: "commit_failed", at: new Date(now()).toISOString() };
    log("gbrain git commit-push: " + describeRun(result) + (busy ? " (busy, retrying)" : " " + tail(result.stderr)));
  };

  const isEligible = (conversation) => {
    if (conversation.state !== "due") return true;
    const at = now();
    return at - conversation.lastActivityAt >= kDebounceMs || (conversation.dirtySince && at - conversation.dirtySince >= kBusyCapMs);
  };

  const tick = async () => {
    if (state.stopped || state.running || !enabled) return;
    state.running = true;
    try {
      const recheckAfter = state.phase === "ready" ? kReadyRecheckMs : kUnavailableRecheckMs;
      if (state.phase === "checking" || now() - state.checkedAt >= recheckAfter) await checkAvailability();
      if (state.phase !== "ready") return;
      try {
        await scan();
        state.lastScanError = null;
      } catch (error) {
        if (state.lastScanError !== String(error?.message || error)) warn("scan failed: " + tail(error?.message || error));
        state.lastScanError = String(error?.message || error);
        return;
      }
      const workable = store().listWorkable(now()).filter(isEligible).slice(0, kBatchMax);
      for (const [index, conversation] of workable.entries()) {
        if (state.stopped || state.phase !== "ready") break;
        if (index) await sleep(kWriteGapMs);
        await processConversation(conversation);
      }
      if (state.phase === "ready") await commitBatch();
    } catch (error) {
      warn("tick failed: " + tail(error?.message || error));
    } finally {
      state.running = false;
    }
  };

  const schedule = (delay) => {
    if (state.stopped) return;
    if (state.timer) clearTimer(state.timer);
    state.timer = setTimer(async () => {
      state.timer = null;
      await tick();
      schedule(kTickMs);
    }, delay);
    state.timer?.unref?.();
  };

  const start = () => {
    if (!enabled) {
      log("off (ALPHACLAW_RELAY_BRAIN=off)");
      return;
    }
    schedule(kFirstTickMs);
  };

  const stop = () => {
    state.stopped = true;
    if (state.timer) clearTimer(state.timer);
    state.timer = null;
    try {
      state.store?.close();
    } catch {}
    state.store = null;
  };

  const retry = () => {
    if (!enabled) return { retried: 0 };
    const retried = store().retryAll();
    state.commitStopped = false;
    state.commitRetryAt = 0;
    state.commitAttempts = 0;
    state.checkedAt = 0;
    state.lastError = null;
    schedule(0);
    return { retried };
  };

  const getStatus = () => {
    if (!enabled) return { enabled: false, phase: "off", code: null };
    let counts = null;
    let parked = [];
    let overBudget = [];
    try {
      counts = store().counts();
      parked = store().parkedCodes();
      overBudget = store().overBudget().map((row) => ({ ...row, resumesAt: row.resumesAt ? new Date(row.resumesAt).toISOString() : null }));
    } catch {}
    return {
      enabled: true,
      phase: state.phase,
      code: state.code,
      checkedAt: state.checkedAt ? new Date(state.checkedAt).toISOString() : null,
      lastSavedAt: state.lastSavedAt,
      lastError: state.lastError,
      lastCommitAt: state.lastCommitAt,
      commitError: state.commitError,
      commitsWaitForRetry: state.commitStopped,
      counts,
      parked,
      overBudget,
      budget: { peerDailyBytes, peerTotalBytes },
    };
  };

  return { start, stop, retry, getStatus, _internal: { tick, scan, checkAvailability, processConversation, commitBatch, state, store } };
};

module.exports = { createRelayBrainArchive, classifyWrite };
