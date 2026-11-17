#!/usr/bin/env node
// Capy reporter for AgentRun (GST-2907, PR 2): reads finished Capy thread
// and subagent turns with a read-only Capy API key and posts each one to
// AgentRun as an SDK run, through the same body builder, client and sender as
// AlphaClaw's OpenClaw reporter. Run once, or with --watch for a pass every
// 60 s until the minutes are up, from a Capy automation:
//
//   node scripts/capy-agentrun-reporter.mjs --state <path to state.json> [--watch <minutes>]
//
// One run at a time holds a lease beside the state file; a run that finds
// another's live lease exits 0 (watch_skipped). The state file is merged on
// every write, never overwritten blind.
//
// Env: CAPY_REPORTER_API_KEY (read-only Capy service user), AGENTRUN_BASE_URL
// (AgentRun's API base ending /v2), AGENTRUN_CAPY_REPORTER_TOKEN,
// AGENTRUN_CAPY_PRIVATE_CAPTAINS (comma-separated thread or Captain ids whose
// threads are always private), AGENTRUN_CAPY_RUNTIME (default
// claude-agent-sdk), AGENTRUN_CAPY_STATE (instead of --state).
//
// Privacy: a thread is private unless both it and its project have visibility
// org, and it is private whenever it or its Captain is listed; a private
// thread sends metadata without its title. Only the first user entry of a
// thread that a threadMode "new" automation run made, inside the run's time
// window, sends its input, replies and one-line tool summaries; a standing
// (single) automation thread's turns and every other turn send metadata plus
// the thread title. A title or contents goes only when the same pass's
// complete listing proved the thread not private; otherwise the turn stays
// queued. A subagent's turns are always metadata only, with a title only
// when its thread may send one. Private threads report under one shared agent
// with no crew in its name; a crew agent is named after its Captain only at
// send, from this pass's live Captain when it and its project are org and it
// is not listed, and otherwise by id; the name is never stored. Tool inputs and outputs are never
// read into a row. Values of keys and tokens are never printed. Exit 0 on success, 1 on a failed pass, 2 on a usage error.
// Contract and log codes: docs/designs/agentrun-reporter.md, "Capy reporter".
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const { createAgentrunClient } = require("../lib/server/agentrun-reporter/agentrun-client.js");
const { createSender } = require("../lib/server/agentrun-reporter/sender.js");
const { agentDefinition, cut, eventBatches, completeBody } = require("../lib/server/agentrun-reporter/bodies.js");

const kCapyBaseUrl = "https://api.capy.ai/api/v1";
const kDefaultRuntime = "claude-agent-sdk";
const kRuntimePattern = /^[a-z][a-z0-9-]{1,63}$/;
const kClosedStatuses = new Set(["idle", "failed", "archived"]);
const kSubagentClosedStatuses = new Set(["idle", "done", "failed"]);
const kFirstSightMs = 24 * 60 * 60 * 1000;
const kMaxRateLimitWaits = 5;
const kMaxRetryAfterMs = 120000;
const kMaxUnsentRows = 20000;
const kStuckAttempts = 6;
const kAutomationRunsRead = 100;
const kAutomationRunStatuses = new Set(["running", "completed", "failed"]);
const kAutomationEarlyMs = 2 * 60 * 1000;
const kAutomationLateMs = 10 * 60 * 1000;
const kRetryRounds = 5;
const kMaxRetryWaitMs = 60000;
const kWatchIntervalMs = 60000;
const kWatchMaxIntervalMs = 5 * 60 * 1000;
const kWatchMaxMinutes = 24 * 60;
const kLeaseFile = "capy-reporter.lease.json";
const kLeaseMs = 3 * 60 * 1000;
const kLeaseRenewMs = 60000;
const kCapabilitiesMs = 60 * 60 * 1000;
const kHeartbeatMs = 10 * 60 * 1000;
const kCrewPrefix = "capy-captain-";
const kCrewDescription = "A Capy Captain crew's thread turns, reported by AlphaClaw's Capy reporter.";
const kPrivateAgent = { id: "capy-private-threads", name: "Capy private threads", description: "Private Capy threads' turns, metadata only, reported by AlphaClaw's Capy reporter." };
const hashOf = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

const listOf = (value) =>
  String(value || "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
const describeDuration = (ms) => (Number.isFinite(ms) && ms > 0 ? `${Math.round(ms / 100) / 10}s` : "unknown duration");
const timeOf = (value) => Date.parse(String(value || "")) || 0;

// A GET against Capy's public API. A 429 waits retry-after seconds and sends
// the same request again (docs.capy.ai/api-reference/overview, "Rate limits").
// stats counts this pass's requests and 429s, so watch mode can log its
// polling cost and stretch its interval.
const createCapyClient = ({ apiKey, fetchImpl, sleep, baseUrl = kCapyBaseUrl }) => {
  const stats = { pages: 0, rateLimited: 0, retryAfterMs: 0 };
  const get = async (pathname, query = {}) => {
    const url = new URL(baseUrl + pathname);
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
    for (let waits = 0; ; waits += 1) {
      stats.pages += 1;
      const response = await fetchImpl(url.toString(), { headers: { accept: "application/json", authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30000) });
      if (response.status === 429) stats.rateLimited += 1;
      if (response.status === 429 && waits < kMaxRateLimitWaits) {
        const seconds = Number(response.headers.get("retry-after"));
        const waitMs = Math.min(kMaxRetryAfterMs, (Number.isFinite(seconds) && seconds >= 0 ? seconds : 5) * 1000);
        stats.retryAfterMs = Math.max(stats.retryAfterMs, waitMs);
        await sleep(waitMs);
        continue;
      }
      const body = await response.json().catch(() => null);
      if (response.status >= 200 && response.status < 300) return body;
      throw Object.assign(new Error(`capy ${response.status} ${body?._tag || ""} on ${pathname.split("/").slice(0, 2).join("/")}`), { status: response.status, tag: String(body?._tag || "") });
    }
  };
  // Threads, automations and Captains take the cursor as cursor; subagents
  // take it as after (docs.capy.ai/api-reference/overview, "Pagination").
  const all = async (pathname, query, cursorParam = "cursor") => {
    const items = [];
    let cursor = null;
    do {
      const page = await get(pathname, { ...query, [cursorParam]: cursor });
      items.push(...(page?.items || []));
      cursor = page?.cursor || null;
    } while (cursor);
    return items;
  };
  return { get, all, stats };
};

// A thread's or a subagent's transcript from an after cursor. Each entry
// remembers the after value of the page it came from, so the next pass can
// start at the page that holds the first unfinished turn. Messages page forward with after and end at
// a null cursor; an unchanged cursor means unsettled messages block the rest
// (docs.capy.ai/api-reference/schemas/TranscriptPageEncoded).
const readTranscript = async (capy, pathname, after) => {
  const entries = [];
  let pageStart = after || null;
  for (;;) {
    const page = await capy.get(pathname, { after: pageStart });
    for (const item of page?.items || []) entries.push({ ...item, pageStart });
    if (!page?.cursor) return { entries, lastPageStart: pageStart, complete: true };
    if (page.cursor === pageStart) return { entries, lastPageStart: pageStart, complete: false };
    pageStart = page.cursor;
  }
};

// A turn is a user entry and every entry after it up to the next user entry.
// In a subagent's transcript the user entries are its parent's instructions:
// the opening task has no sender and later ones carry relation parent, and
// every one of them starts a turn.
const splitTurns = (entries) => {
  const turns = [];
  for (const entry of entries) {
    if (entry.source === "user") turns.push({ user: entry, entries: [entry] });
    else if (turns.length) turns[turns.length - 1].entries.push(entry);
  }
  return turns;
};

// The state file is the queue: rows wait in it until sent, and the sender
// sees it through the same small interface as the SQLite outbox.
// nameOf gives the agent name a row goes out with; it lives only on the copy
// the sender gets, so a resolved crew name never reaches the state file.
const createStateOutbox = ({ getState, save, now, sendable = () => true, nameOf = (row) => row.agent_name }) => ({
  due: (limit = 50) =>
    getState().rows
      .filter((row) => row.state === "queued" && row.next_attempt_at <= now() && sendable(row))
      .slice(0, limit)
      .map((row) => ({ ...row, agent_name: nameOf(row) })),
  update: (id, fields) => {
    const row = getState().rows.find((entry) => entry.id === id);
    if (row) Object.assign(row, fields);
    save();
  },
  agentOf: (agentKey) => getState().agents[agentKey] || null,
  saveAgent: ({ agentKey, agentId, runtime, definitionHash }) => {
    getState().agents[agentKey] = { agent_id: agentId, runtime, definition_hash: definitionHash };
    save();
  },
  forgetAgent: (agentKey) => {
    delete getState().agents[agentKey];
    save();
  },
});

const emptyState = () => ({ version: 1, threads: {}, subagents: {}, agents: {}, rows: [] });
const parseState = (text) => {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && Array.isArray(parsed.rows) ? { ...emptyState(), ...parsed } : null;
  } catch {
    return null;
  }
};

// Returns the state and the file's text as read, the base of the next merge.
const loadState = (statePath, log) => {
  let text;
  try {
    text = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") log("state_reset op=load (unreadable; starting empty, turns re-send under their old keys)");
    return { state: emptyState(), text: null };
  }
  const state = parseState(text);
  if (state) return { state, text };
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  log(`state_reset op=load (${parsed ? "not a reporter state file" : "unreadable"}; starting empty, turns re-send under their old keys)`);
  return { state: emptyState(), text };
};

// A three-way merge against the file as this process last read or wrote it:
// an entry this process changed since then wins (a removal included), every
// other entry comes from the file, so a second writer's cursors and turns
// are kept (F13).
const mergeEntries = (base = {}, ours = {}, theirs = {}) => {
  const merged = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const pick = JSON.stringify(ours[key]) !== JSON.stringify(base[key]) ? ours : theirs;
    if (pick[key] !== undefined) merged[key] = pick[key];
  }
  return merged;
};
const byId = (rows = []) => Object.fromEntries(rows.map((row) => [row.id, row]));
const mergeState = (base, ours, theirs) => {
  const merged = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    if (key === "rows") continue;
    if (key === "threads" || key === "subagents" || key === "agents") merged[key] = mergeEntries(base[key], ours[key], theirs[key]);
    else merged[key] = JSON.stringify(ours[key]) !== JSON.stringify(base[key]) ? ours[key] : theirs[key];
  }
  const rows = mergeEntries(byId(base.rows), byId(ours.rows), byId(theirs.rows));
  merged.rows = [...new Set([...ours.rows, ...theirs.rows].map((row) => row.id))].filter((id) => rows[id]).map((id) => rows[id]);
  return merged;
};

// One run at a time (F13): a lease file beside the state file names its
// holder and expiry, renewed every loop and at least every minute while the
// run writes. A run that finds another's live lease exits 0; one past its
// expiry is taken over. A file on a shared drive is no mutex, so the state
// file is merged on every write as well.
const createLease = ({ dir, holder, now, log }) => {
  const file = path.join(dir, kLeaseFile);
  let renewedAt = 0;
  let lost = false;
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  const write = () => {
    fs.mkdirSync(dir, { recursive: true });
    renewedAt = now();
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ holder, renewed_at: new Date(renewedAt).toISOString(), expires_at: new Date(renewedAt + kLeaseMs).toISOString() }), { mode: 0o600 });
    fs.renameSync(temp, file);
  };
  const ageOf = (lease) => Math.max(0, Math.round((now() - timeOf(lease?.renewed_at)) / 1000));
  const heldByOther = (lease) => Boolean(lease?.holder) && lease.holder !== holder && timeOf(lease.expires_at) > now();
  const take = () => {
    const current = read();
    if (heldByOther(current)) {
      log(`watch_skipped holder=${current.holder} age=${ageOf(current)}s (another run holds the lease; nothing read or sent)`);
      return false;
    }
    if (current?.holder && current.holder !== holder) log(`watch_takeover holder=${current.holder} age=${ageOf(current)}s (its lease expired; this run takes it over)`);
    write();
    const after = read();
    if (after?.holder === holder) return true;
    log(`watch_skipped holder=${after?.holder || "unknown"} age=0s (another run took the lease at the same moment; nothing read or sent)`);
    return false;
  };
  const renew = () => {
    if (lost) return false;
    const current = read();
    if (heldByOther(current)) {
      lost = true;
      log(`watch_lost holder=${current.holder} (another run took the lease; this run stops after its pass)`);
      return false;
    }
    write();
    return true;
  };
  const renewIfDue = () => (now() - renewedAt >= kLeaseRenewMs ? renew() : !lost);
  const release = () => {
    if (read()?.holder === holder) fs.rmSync(file, { force: true });
  };
  return { take, renew, renewIfDue, release, isLost: () => lost };
};

export const runCapyReporter = async ({
  env = process.env,
  statePath = env.AGENTRUN_CAPY_STATE,
  fetchImpl = globalThis.fetch,
  capyFetchImpl = fetchImpl,
  capyBaseUrl = kCapyBaseUrl,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
  watchMinutes = 0,
  holder = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
} = {}) => {
  const log = (line) => logger.warn?.(`[alphaclaw] agentrun-reporter ${line}`);
  const missing = ["CAPY_REPORTER_API_KEY", "AGENTRUN_BASE_URL", "AGENTRUN_CAPY_REPORTER_TOKEN"].filter((name) => !String(env[name] || "").trim());
  if (!statePath) missing.push("--state (or AGENTRUN_CAPY_STATE)");
  if (missing.length) {
    log(`config_missing op=capy fix=set ${missing.join(", ")} (nothing read or sent)`);
    return 2;
  }
  const minutes = Number(watchMinutes ?? 0);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > kWatchMaxMinutes) {
    log(`config_invalid op=capy fix=--watch takes minutes from 1 to ${kWatchMaxMinutes} (nothing read or sent)`);
    return 2;
  }
  const watch = minutes > 0;
  const runtimeSetting = String(env.AGENTRUN_CAPY_RUNTIME || "").trim() || kDefaultRuntime;
  const runtime = kRuntimePattern.test(runtimeSetting) ? runtimeSetting : kDefaultRuntime;
  if (runtime !== runtimeSetting) log("runtime_invalid op=capy fix=AGENTRUN_CAPY_RUNTIME must be a runtime name; using claude-agent-sdk");
  const privateIds = new Set(listOf(env.AGENTRUN_CAPY_PRIVATE_CAPTAINS));
  const lease = createLease({ dir: path.dirname(path.resolve(statePath)), holder, now, log });
  if (!lease.take()) return 0;
  // Each pass reads the state file again; baseText is the file as this
  // process last read or wrote it, the base of the merge on write.
  let state = emptyState();
  let baseText = null;
  const save = () => {
    lease.renewIfDue();
    let text = null;
    try {
      text = fs.readFileSync(statePath, "utf8");
    } catch {}
    const theirs = text !== null && text !== baseText ? parseState(text) : null;
    if (theirs) Object.assign(state, mergeState(parseState(baseText) || emptyState(), state, theirs));
    fs.mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true });
    const out = JSON.stringify(state);
    const temp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, out, { mode: 0o600 });
    fs.renameSync(temp, statePath);
    baseText = out;
  };
  const capy = createCapyClient({
    apiKey: String(env.CAPY_REPORTER_API_KEY).trim(),
    fetchImpl: capyFetchImpl,
    sleep: async (ms) => {
      await sleep(ms);
      lease.renewIfDue();
    },
    baseUrl: capyBaseUrl,
  });
  const client = createAgentrunClient({ baseUrl: String(env.AGENTRUN_BASE_URL).trim().replace(/\/+$/, ""), fetchImpl });
  const token = String(env.AGENTRUN_CAPY_REPORTER_TOKEN).trim();
  let counts = {};
  let seenIds = new Set();
  let privateNow = new Set();
  let listedOpen = new Set();
  let projectsById = new Map();
  let captains = new Map();
  let failed = false;
  let live = false;
  let listedAll = false;

  // Agent ids are stable. A private thread (it or its project not org, or the
  // thread listed) goes under one shared agent with no crew in its name. A
  // crew row stores only the id-based name; the readable one is resolved at
  // send from this pass's live Captain (crewNameOf) and never stored.
  const agentOf = (thread, project) => {
    if (thread.visibility !== "org" || project?.visibility !== "org" || privateIds.has(thread.id)) return kPrivateAgent;
    const captainId = String((typeof thread.captain === "string" ? thread.captain : thread.captain?.jamId) || "");
    if (captainId) return { id: `${kCrewPrefix}${captainId}`, name: `Capy crew ${captainId}`, description: kCrewDescription };
    const projectId = String(thread.projectId || project.id || "none");
    const name = project.visibility === "org" && project.name ? `Capy project: ${project.name}` : `Capy project ${projectId}`;
    return { id: `capy-project-${projectId}`, name, description: "A Capy project's thread turns outside any crew, reported by AlphaClaw's Capy reporter." };
  };

  // A private project limits everything in it (docs.capy.ai/admin/security),
  // so a thread is shared only when it and its project are both org-visible.
  // "Capy crew: <name>" only when this pass read the Captain, it is not
  // listed, and it and its project are org; otherwise the id.
  const crewNameOf = (captainId) => {
    const captain = captains.get(captainId);
    const name = String(captain?.name || "").trim();
    const shared = captain && !privateIds.has(captainId) && captain.visibility === "org" && projectsById.get(captain.projectId)?.visibility === "org";
    return shared && name ? `Capy crew: ${name}` : `Capy crew ${captainId}`;
  };
  const sendNameOf = (row) =>
    row.agent_key.startsWith(kCrewPrefix) && (row.class === "thread" || row.class === "automation" || row.class === "subagent")
      ? crewNameOf(row.agent_key.slice(kCrewPrefix.length))
      : row.agent_name;

  const isPrivate = (thread, project) => {
    const captainId = typeof thread.captain === "string" ? thread.captain : thread.captain?.jamId;
    return thread.visibility !== "org" || project?.visibility !== "org" || privateIds.has(thread.id) || (captainId && privateIds.has(captainId));
  };

  // A subagent's turn (subagent set) is keyed under its thread and is never a
  // contents turn, whatever its thread's class (F6). A live row is a turn
  // still working, started early in AgentRun when it advertises sdk_runs;
  // startFields adds the start fields that capability brings.
  const rowOf = ({ thread, turn, failed: turnFailed = false, cls, agent, creditsNote = "", subagent = null, live: working = false, startFields = false }) => {
    const sourceRunId = subagent ? `${thread.id}:sub:${subagent.id}:${turn.user.id}` : `${thread.id}:${turn.user.id}`;
    const startedAt = timeOf(turn.user.createdAt) || null;
    const endedAt = working ? null : timeOf(turn.entries[turn.entries.length - 1].createdAt) || startedAt;
    const status = working ? "working" : turnFailed ? "failed" : "completed";
    const contents = cls === "automation" && !subagent;
    const texts = [];
    const tools = [];
    for (const entry of turn.entries) {
      if (entry.source === "assistant" && entry.text) texts.push(String(entry.text));
      if (entry.source !== "tool") continue;
      const calls = Array.isArray(entry.calls) && entry.calls.length ? entry.calls : [{ tool: entry.tool, durationMs: null }];
      for (const call of calls) {
        const name = String(call.tool || "tool");
        tools.push({ name, ok: true });
        texts.push(`Tool call: ${name}${Number(call.durationMs) > 0 ? ` (${describeDuration(Number(call.durationMs))})` : ""}`);
      }
    }
    const replies = turn.entries.filter((entry) => entry.source === "assistant" && entry.text);
    const threadTitle = String(thread.title || "").trim();
    const title =
      cls === "private" ? "" : subagent ? `Subagent ${subagent.subagentPath} of ${threadTitle || thread.id}: ${String(subagent.title || "").trim() || subagent.id}` : threadTitle;
    const where = subagent ? `Capy ${cls} turn of subagent ${subagent.id} in thread ${thread.id}.` : `Capy ${cls} turn in thread ${thread.id}.`;
    const head = title ? cut(title, 60) : `Private Capy ${subagent ? "subagent" : "thread"}`;
    const started = startedAt ? new Date(startedAt).toISOString() : "unknown";
    // AgentRun titles an SDK run with the first 80 characters of its input,
    // whitespace collapsed: what ran, how long and how it ended come first.
    const metadataLine = working
      ? `${head} · working — started ${started}; ${where}`
      : `${head} · ${describeDuration(endedAt - startedAt)} · ${status} — ` +
        `${replies.length} repl${replies.length === 1 ? "y" : "ies"}, ${tools.length} tool call${tools.length === 1 ? "" : "s"}; started ${started}; ` +
        `${where}${creditsNote}`;
    const { id: agent_key } = agent;
    return {
      id: crypto.createHash("sha256").update(sourceRunId).digest("hex").slice(0, 16),
      source: "capy",
      source_run_id: sourceRunId,
      agent_key,
      agent_name: agent.name,
      agent_description: agent.description,
      class: cls,
      contents: contents ? 1 : 0,
      session_label: thread.id,
      started_at: startedAt,
      ended_at: endedAt,
      status,
      model: String(turn.user.model || (subagent ? "" : thread.lastModelId) || ""),
      input_text: contents && turn.user.text ? `${metadataLine}\n\n${turn.user.text}` : metadataLine,
      texts_json: JSON.stringify(contents ? texts : []),
      answer_text: contents && replies.length ? String(replies[replies.length - 1].text) : "",
      error_text: status === "failed" ? `The ${subagent ? "subagent" : "thread"} failed (details withheld).` : "",
      tools_json: JSON.stringify(tools),
      usage_json: "null",
      evidence_complete: 0,
      start_fields_json: startFields
        ? JSON.stringify({ ...(startedAt ? { started_at: started } : {}), ...(title ? { title: cut(title, 200) } : {}), labels: ["source:capy", `class:${cls}`] })
        : "",
      state: working ? "live" : "queued",
      live_started: 0,
      heartbeat_at: 0,
      start_body: null,
      batches_json: null,
      complete_body: null,
      batches_sent: 0,
      agentrun_run_id: null,
      attempts: 0,
      next_attempt_at: 0,
      last_error: "",
    };
  };

  // Automation runs by thread: only a run of a `threadMode: "new"` automation
  // that started (running, completed or failed) has a turn, and its turn is
  // the first user entry of the thread the run made, from 2 minutes before to
  // 10 minutes after the run's startedAt. A `single` thread mixes people's
  // messages with runs that no field tells apart, so its turns, and anything
  // else, fail closed to `thread` (docs.capy.ai/api-reference/schemas/AutomationRunEncoded).
  const readAutomationRuns = async (projectId) => {
    const byThread = new Map();
    for (const automation of await capy.all("/automations", { projectId })) {
      if (automation.threadMode !== "new") continue;
      const page = await capy.get(`/automations/${encodeURIComponent(automation.id)}/runs`, { limit: kAutomationRunsRead });
      for (const run of page?.items || []) {
        if (!run.jamId || !kAutomationRunStatuses.has(run.status) || !timeOf(run.startedAt)) continue;
        byThread.set(run.jamId, [...(byThread.get(run.jamId) || []), timeOf(run.startedAt)]);
      }
    }
    return byThread;
  };

  // Reads a thread's or subagent's transcript from its saved cursor and
  // returns its turns, the open (last, unfinished) turn, the turns not yet
  // reported and the cursor and reported ids to save. openNew says the open
  // turn was never reported and is inside the window, so it may go live: a
  // thread woken with no new user entry reopens a turn already sent.
  const followTranscript = async (pathname, known, { closed, lastActivityAt }) => {
    const { entries, lastPageStart, complete } = await readTranscript(capy, pathname, known.after);
    const turns = splitTurns(entries);
    // A transcript that moved after the listing (an entry newer than its
    // lastActivityAt) keeps its last turn open until the next pass.
    const newest = timeOf(entries[entries.length - 1]?.createdAt);
    const settled = complete && closed && !(timeOf(lastActivityAt) && newest > timeOf(lastActivityAt));
    const open = turns.find((turn, index) => index === turns.length - 1 && !settled) || null;
    const reported = new Set(known.reported);
    const fresh = [];
    turns.forEach((turn, index) => {
      if (turn === open || reported.has(turn.user.id)) return;
      reported.add(turn.user.id);
      if (timeOf(turn.user.createdAt) < timeOf(known.since)) return;
      fresh.push({ turn, last: index === turns.length - 1 });
    });
    const nextAfter = open ? open.user.pageStart : lastPageStart;
    const keepFrom = entries.findIndex((entry) => entry.pageStart === nextAfter);
    const kept = keepFrom < 0 ? [] : entries.slice(keepFrom).filter((entry) => entry.source === "user" && reported.has(entry.id)).map((entry) => entry.id);
    const openNew = Boolean(open) && !new Set(known.reported).has(open.user.id) && timeOf(open.user.createdAt) >= timeOf(known.since);
    return { turns, open, openNew, fresh, nextAfter, kept };
  };

  // The credit change since the previous report goes on the last reported
  // turn's metadata line as an estimate, never as cost_usd.
  const creditsOf = (usage, known, fresh, label) => {
    const credits = Number(usage?.totalCredits);
    const delta = Number.isFinite(credits) && Number.isFinite(known.credits) ? credits - known.credits : null;
    return {
      noteAt: (index) =>
        index === fresh.length - 1 && delta !== null && delta >= 0 ? ` ${label} credits used since the previous report: about ${Math.round(delta * 100) / 100} (an estimate).` : "",
      next: fresh.length || !Number.isFinite(known.credits) ? (Number.isFinite(credits) ? credits : null) : known.credits,
    };
  };

  // A finished turn joins the queue once. A live row of the same turn whose
  // start was built (it may have reached AgentRun) keeps that start and every
  // heartbeat it stored, sent or not; its events and completion follow them.
  // One never built is replaced.
  const queue = (rows) => {
    for (const row of rows) {
      const index = state.rows.findIndex((entry) => entry.id === row.id);
      if (index < 0) {
        state.rows.push(row);
        continue;
      }
      const known = state.rows[index];
      if (known.state !== "live") continue;
      if (known.start_body === null || known.start_body === undefined) {
        state.rows[index] = row;
        continue;
      }
      const beats = JSON.parse(known.beats_json || "[]");
      const contents = row.contents === 1;
      const events = eventBatches({ rowId: `${row.source}-${row.id}`, sessionLabel: row.session_label, texts: contents ? JSON.parse(row.texts_json) : [], tools: JSON.parse(row.tools_json) });
      Object.assign(known, {
        ...row,
        live_started: 1,
        heartbeat_at: known.heartbeat_at,
        start_body: known.start_body,
        agentrun_run_id: known.agentrun_run_id,
        batches_sent: Number(known.batches_sent || 0),
        batches_json: JSON.stringify([...beats, ...events.map((batch, offset) => ({ ...batch, sequence: beats.length + offset + 1 }))]),
        complete_body: JSON.stringify(
          completeBody({ status: row.status, answer: contents ? row.answer_text : "", error: row.error_text, model: row.model, sessionLabel: row.session_label, usage: null, evidenceComplete: false }),
        ),
      });
    }
  };

  const queueLive = (args) => {
    const row = rowOf({ ...args, live: true, startFields: true });
    if (!state.rows.some((entry) => entry.id === row.id)) state.rows.push(row);
  };

  const processThread = async (thread, project, automationRuns) => {
    const known = state.threads[thread.id] || { after: null, reported: [], since: new Date(now() - kFirstSightMs).toISOString(), credits: null };
    const { turns, open, openNew, fresh, nextAfter, kept } = await followTranscript(`/threads/${encodeURIComponent(thread.id)}/messages`, known, {
      closed: kClosedStatuses.has(thread.status),
      lastActivityAt: thread.lastActivityAt,
    });
    const first = known.first ?? (known.after === null ? turns[0]?.user.id ?? null : null);
    const automationTurns = new Set();
    for (const runAt of automationRuns.get(thread.id) || []) {
      const turn = turns.find((candidate) => candidate.user.id === first);
      const at = timeOf(turn?.user.createdAt);
      if (turn && !turn.user.sender && at >= runAt - kAutomationEarlyMs && at <= runAt + kAutomationLateMs) automationTurns.add(turn.user.id);
    }
    const credits = creditsOf(thread.usage, known, fresh, "Thread");
    const agent = agentOf(thread, project);
    const classOf = (turn) => (isPrivate(thread, project) ? "private" : automationTurns.has(turn.user.id) ? "automation" : "thread");
    queue(
      fresh.map(({ turn, last }, index) =>
        rowOf({ thread, turn, failed: last && thread.status === "failed", cls: classOf(turn), agent, creditsNote: credits.noteAt(index), startFields: live }),
      ),
    );
    if (live && openNew && thread.status === "working") queueLive({ thread, turn: open, cls: classOf(open), agent });
    state.threads[thread.id] = {
      activity: thread.lastActivityAt || thread.updatedAt || "",
      status: thread.status,
      after: nextAfter,
      reported: kept,
      since: known.since,
      first,
      credits: credits.next,
    };
    counts.queued += fresh.length;
    save();
  };

  // A thread's subagents are read when the thread changed, or while one of
  // its subagents was last seen unfinished. Each subagent's own transcript is
  // split into turns like a thread's, keyed under the thread. A subagent turn
  // is metadata only (class subagent, or private with its thread), with the
  // title only when its thread may send one (F6, F12).
  const processSubagents = async (thread, project) => {
    const cls = isPrivate(thread, project) ? "private" : "subagent";
    const agent = agentOf(thread, project);
    for (const subagent of await capy.all(`/threads/${encodeURIComponent(thread.id)}/subagents`, {}, "after")) {
      const activity = subagent.lastActivityAt || subagent.updatedAt || "";
      const known = state.subagents[subagent.id];
      if (known && known.activity === activity && known.status === subagent.status) continue;
      if (!known && timeOf(activity) < now() - kFirstSightMs) {
        state.subagents[subagent.id] = { thread: thread.id, activity, status: subagent.status, after: null, reported: [], since: new Date(now()).toISOString(), credits: null };
        continue;
      }
      const prior = known || { after: null, reported: [], since: new Date(now() - kFirstSightMs).toISOString(), credits: null };
      try {
        const { open, openNew, fresh, nextAfter, kept } = await followTranscript(`/subagents/${encodeURIComponent(subagent.id)}/messages`, prior, {
          closed: subagent.archived === true || kSubagentClosedStatuses.has(subagent.status),
          lastActivityAt: subagent.lastActivityAt,
        });
        const credits = creditsOf(subagent.usage, prior, fresh, "Subagent");
        queue(
          fresh.map(({ turn, last }, index) =>
            rowOf({ thread, subagent, turn, failed: last && subagent.status === "failed", cls, agent, creditsNote: credits.noteAt(index), startFields: live }),
          ),
        );
        if (live && openNew && subagent.status === "working") queueLive({ thread, subagent, turn: open, cls, agent });
        state.subagents[subagent.id] = { thread: thread.id, activity, status: subagent.status, after: nextAfter, reported: kept, since: prior.since, credits: credits.next };
        counts.subagents += 1;
        counts.queued += fresh.length;
        save();
      } catch (error) {
        if (error?.status !== 404) readFailed("subagent", subagent.id, error);
      }
    }
  };

  // Every page of a project's threads is compared by lastActivityAt and
  // status; list order is never trusted to stop early.
  const collect = async () => {
    const projects = (await capy.get("/projects"))?.items || [];
    for (const project of projects) projectsById.set(project.id, project);
    try {
      for (const captain of await capy.all("/captains")) captains.set(captain.id, captain);
    } catch (error) {
      readFailed("captains", "all", error);
    }
    let complete = true;
    listedAll = false;
    for (const project of projects) {
      try {
        await collectProject(project);
      } catch (error) {
        complete = false;
        readFailed("project", project.id, error);
      }
    }
    save();
    if (!complete) return;
    listedAll = true;
    for (const id of privateIds) {
      if (!seenIds.has(id)) log(`private_unmatched op=capy entry=${id} (no thread or Captain id this key can see matches it; list jam_ ids)`);
    }
  };

  // One failing project or thread read skips only that project or thread;
  // the pass goes on and exits 1.
  const readFailed = (op, id, error) => {
    failed = true;
    log(`capy_error op=${op} id=${id} status=${error?.status || "network"}${error?.tag ? ` tag=${error.tag}` : ""} (skipped this pass; the next pass reads it again)`);
  };

  const collectProject = async (project) => {
    const threads = await capy.all("/threads", { projectId: project.id });
    for (const thread of threads) {
      seenIds.add(thread.id);
      const captainId = typeof thread.captain === "string" ? thread.captain : thread.captain?.jamId;
      if (captainId) seenIds.add(captainId);
      if (isPrivate(thread, project)) privateNow.add(thread.id);
    }
    const changed = threads.filter((thread) => {
      const known = state.threads[thread.id];
      const activity = thread.lastActivityAt || thread.updatedAt || "";
      if (known) return known.activity !== activity || known.status !== thread.status;
      if (timeOf(activity) >= now() - kFirstSightMs) return true;
      state.threads[thread.id] = { activity, status: thread.status, after: null, reported: [], since: new Date(now()).toISOString(), credits: null };
      return false;
    });
    const automationRuns = changed.length ? await readAutomationRuns(project.id) : null;
    for (const thread of threads) if (!isPrivate(thread, project)) listedOpen.add(thread.id);
    const readable = new Set();
    for (const thread of changed) {
      try {
        await processThread(thread, project, automationRuns);
        counts.threads += 1;
        readable.add(thread.id);
      } catch (error) {
        listedOpen.delete(thread.id);
        if (error?.status !== 404) readFailed("thread", thread.id, error);
      }
    }
    const watched = new Set(
      Object.values(state.subagents)
        .filter((known) => !kSubagentClosedStatuses.has(known.status))
        .map((known) => known.thread),
    );
    const changedIds = new Set(changed.map((thread) => thread.id));
    for (const thread of threads) {
      if (!readable.has(thread.id) && (changedIds.has(thread.id) || !watched.has(thread.id))) continue;
      try {
        await processSubagents(thread, project);
      } catch (error) {
        listedOpen.delete(thread.id);
        if (error?.status !== 404) readFailed("subagents", thread.id, error);
      }
    }
  };

  // Live turns need AgentRun's sdk_runs capability (started_at, title and
  // labels on a start, and empty event batches as heartbeats). It is read at
  // most once an hour and kept in the state file; without it nothing starts
  // before its turn ends.
  const liveOn = async () => {
    const known = state.capabilities;
    if (known && now() - timeOf(known.checked_at) < kCapabilitiesMs) return known.sdk_runs === true;
    const got = await client.call({ method: "GET", path: "/capabilities", token });
    const flag = got.body?.features?.sdk_runs;
    const sdkRuns = got.kind === "ok" ? flag === true || (Boolean(flag) && typeof flag === "object" && flag.enabled !== false) : known?.sdk_runs === true;
    state.capabilities = { checked_at: new Date(now()).toISOString(), sdk_runs: sdkRuns };
    return sdkRuns;
  };

  // A turn that carries a title or contents is sent only when this pass's
  // complete listing of its project showed its thread as not private and its
  // transcript read succeeded. A missing thread, a failed or partial listing
  // or a failed read leaves it held in the queue for a later pass.
  const sendable = (row) => row.class === "private" || listedOpen.has(row.session_label);
  const sender = createSender({
    outbox: createStateOutbox({ getState: () => state, save, now, sendable, nameOf: sendNameOf }),
    client,
    token,
    getRuntime: () => runtime,
    contentAllowed: (row) => row.class === "automation",
    now,
    logger,
    source: "capy",
  });

  // A live turn starts in AgentRun as soon as it is seen working and sends an
  // empty event batch at most every 10 minutes while it works; its events and
  // completion go with the finished turn.
  const sendLive = async () => {
    for (const row of state.rows.filter((entry) => entry.state === "live" && Number(entry.next_attempt_at || 0) <= now() && sendable(entry))) {
      const started = await sender.startOnly({ ...row, agent_name: sendNameOf(row) });
      if (started.outcome !== "started") continue;
      if (!row.live_started) {
        Object.assign(row, { live_started: 1, heartbeat_at: now() });
        counts.live += 1;
        save();
        continue;
      }
      // A beat is stored before it is posted, so one whose answer was lost
      // is posted again before anything else and the finished turn's events
      // are numbered after it.
      const beats = JSON.parse(row.beats_json || "[]");
      const confirmed = Number(row.batches_sent || 0);
      if (beats.length <= confirmed) {
        if (now() - Number(row.heartbeat_at || 0) < kHeartbeatMs) continue;
        beats.push({ sequence: beats.length + 1, events: [] });
        row.beats_json = JSON.stringify(beats);
        save();
      }
      const beat = beats[confirmed];
      const result = await client.call({ method: "POST", path: `/sdk-runs/${encodeURIComponent(row.agentrun_run_id)}/events`, token: started.runToken, body: beat });
      if (result.kind !== "ok") continue;
      Object.assign(row, { batches_sent: beat.sequence, heartbeat_at: now() });
      save();
    }
  };

  // One pass: read, then send. Watch mode runs it every loop with in-pass
  // retries off, since the next loop retries within a minute.
  const runPass = async (retryRounds) => {
    ({ state, text: baseText } = loadState(statePath, log));
    Object.assign(capy.stats, { pages: 0, rateLimited: 0, retryAfterMs: 0 });
    counts = { threads: 0, subagents: 0, queued: 0, live: 0 };
    seenIds = new Set();
    privateNow = new Set();
    listedOpen = new Set();
    projectsById = new Map();
    captains = new Map();
    failed = false;
    listedAll = false;
    live = watch && (await liveOn());

    try {
      await collect();
    } catch (error) {
      failed = true;
      if (error?.status === 401 || error?.status === 403) log(`capy_rejected op=read status=${error.status} fix=check CAPY_REPORTER_API_KEY and the service user's project access (queued metadata-only turns are still sent)`);
      else log(`capy_error op=read ${String(error?.message || error).slice(0, 200)} (the next pass reads again from the saved cursors)`);
    }

    // Private wins at send too: a queued turn whose thread is now private, or
    // whose thread or crew is now listed, is dropped, never rebuilt (a rebuilt
    // start under the same key would not match one AgentRun may already hold).
    const revoked = state.rows.filter(
      (row) =>
        row.class !== "private" &&
        (privateNow.has(row.session_label) || privateIds.has(row.session_label) || privateIds.has(row.agent_key.replace(/^capy-captain-/, ""))),
    );
    if (revoked.length) {
      state.rows = state.rows.filter((row) => !revoked.includes(row));
      log(`content_revoked op=capy count=${revoked.length} (the thread became private before these turns were sent; not sent)`);
    }
    // A live turn whose thread a complete listing no longer shows, or that has
    // been working for 24 hours, is dropped rather than kept beating forever.
    const stale = state.rows.filter((row) => row.state === "live" && ((listedAll && !seenIds.has(row.session_label)) || now() - Number(row.started_at || 0) > kFirstSightMs));
    if (stale.length) {
      state.rows = state.rows.filter((row) => !stale.includes(row));
      log(`live_dropped op=capy count=${stale.length} (their thread is gone or the turn ran past 24 hours; not completed)`);
    }
    const unsent = state.rows.filter((row) => row.state === "queued");
    if (unsent.length > kMaxUnsentRows) {
      const drop = new Set(unsent.slice(0, unsent.length - kMaxUnsentRows).map((row) => row.id));
      state.rows = state.rows.filter((row) => !drop.has(row.id));
      log(`queue_overflow op=capy count=${drop.size} (oldest unsent turns gone; check that AgentRun is reachable)`);
    }
    const sent = await sender.sendDue({ limit: state.rows.length || 1 });
    // The one-shot pass runs hourly, past AgentRun's one-hour window, so a
    // turn that met a passing failure is retried here while a started or
    // failed turn falls due within the wait limit, at most retryRounds rounds.
    for (let round = 0; round < retryRounds && !sent.paused; round += 1) {
      const waiting = state.rows.filter((row) => row.state === "queued" && row.attempts > 0 && sendable(row)).map((row) => row.next_attempt_at);
      const waitMs = Math.max(0, Math.min(...waiting) - now());
      if (!waiting.length || waitMs > kMaxRetryWaitMs) break;
      await sleep(waitMs);
      const again = await sender.sendDue({ limit: state.rows.length || 1 });
      for (const key of Object.keys(sent)) sent[key] = key === "retry" ? again.retry : sent[key] + again[key];
    }
    if (live && !sent.paused) await sendLive();
    const held = state.rows.filter((row) => row.state === "queued" && !sendable(row)).length;
    if (held) log(`row_held op=send count=${held} (their threads were not listed as not private this pass; kept for a later pass)`);
    // Every pass, each known crew agent whose name must be its id is read back
    // from AgentRun and renamed if AgentRun shows any other name (a Captain gone
    // private, listed or unreadable), without waiting for that crew's next turn.
    // The cached hash never decides this: a rename whose answer was lost leaves
    // it stale. A readable name only ever goes out with a turn.
    for (const [agentKey, known] of Object.entries(state.agents)) {
      if (sent.paused || !agentKey.startsWith(kCrewPrefix)) continue;
      const captainId = agentKey.slice(kCrewPrefix.length);
      if (crewNameOf(captainId) !== `Capy crew ${captainId}`) continue;
      const definition = agentDefinition({ agentId: agentKey, name: `Capy crew ${captainId}`, description: kCrewDescription, runtime });
      const definitionHash = hashOf(definition);
      const path = `/agents/${encodeURIComponent(agentKey)}`;
      const got = await client.call({ method: "GET", path, token });
      if (got.kind === "not_found") {
        delete state.agents[agentKey];
        continue;
      }
      const current = got.body?.definition || {};
      const stale = current.sdk?.runtime !== runtime || current.name !== definition.name || current.learning !== false;
      const put =
        got.kind === "ok" && stale
          ? await client.call({ method: "PUT", path: `${path}/definition`, token, ifMatch: got.etag, body: { definition: { ...definition, description: String(current.description ?? definition.description) } } })
          : got;
      if (put.kind === "ok") {
        state.agents[agentKey] = { ...known, definition_hash: definitionHash };
        continue;
      }
      failed = true;
      log(`agent_rename_error op=agent agent=${agentKey} status=${put.status || put.kind} (name kept; the next pass tries again)`);
    }
    state.rows = state.rows.filter((row) => row.state === "queued" || row.state === "live");
    save();
    const stuck = state.rows.filter((row) => row.attempts >= kStuckAttempts).length;
    if (stuck) log(`rows_waiting op=send count=${stuck} (AgentRun has refused or missed these ${kStuckAttempts}+ times; check AGENTRUN_BASE_URL)`);
    logger.log?.(
      `[alphaclaw] agentrun-reporter capy_pass threads=${counts.threads} subagents=${counts.subagents} queued=${counts.queued} live=${counts.live} sent=${sent.sent} retry=${sent.retry} dropped=${sent.dropped} expired=${sent.expired} waiting=${state.rows.length} pages=${capy.stats.pages} rate_limited=${capy.stats.rateLimited}`,
    );
    return failed || sent.paused || stuck ? 1 : 0;
  };

  // Sleeps in steps of at most a minute, renewing the lease after each.
  const nap = async (ms) => {
    for (let left = ms; left > 0 && !lease.isLost(); left -= kLeaseRenewMs) {
      await sleep(Math.min(left, kLeaseRenewMs));
      lease.renew();
    }
  };

  let code = 0;
  try {
    if (!watch) code = await runPass(kRetryRounds);
    else {
      // Watch mode (F13): a pass every 60 s until the minutes are up. A pass
      // that met a Capy 429 doubles the interval, at least the retry-after
      // it waited past a minute and at most 5 minutes; a clean pass resets it.
      const deadline = now() + minutes * 60000;
      let interval = kWatchIntervalMs;
      for (;;) {
        const loopStart = now();
        if (!lease.renew()) break;
        code = Math.max(code, await runPass(0));
        if (lease.isLost()) break;
        const { rateLimited, retryAfterMs } = capy.stats;
        interval = rateLimited ? Math.min(kWatchMaxIntervalMs, Math.max(interval * 2, kWatchIntervalMs + retryAfterMs)) : kWatchIntervalMs;
        if (rateLimited) log(`watch_slowed op=capy interval=${Math.round(interval / 1000)}s rate_limited=${rateLimited} (Capy answered 429; the next loop waits longer)`);
        if (loopStart + interval >= deadline) break;
        await nap(loopStart + interval - now());
      }
    }
  } finally {
    lease.release();
  }
  return code;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { state: { type: "string" }, watch: { type: "string" } }, strict: true });
  process.exitCode = await runCapyReporter({ statePath: values.state || process.env.AGENTRUN_CAPY_STATE, watchMinutes: values.watch });
}
