#!/usr/bin/env node
// Capy reporter for AgentRun (GST-2907, PR 2): reads finished Capy thread
// turns with a read-only Capy API key and posts each one to AgentRun as an SDK
// run, through the same body builder, client and sender as AlphaClaw's
// OpenClaw reporter. Meant to run once an hour from a Capy automation:
//
//   node scripts/capy-agentrun-reporter.mjs --state <path to state.json>
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
// queued. Private threads report under one shared agent with no crew in its
// name; a crew agent is named after its Captain only at send, from this pass's
// live Captain when it and its project are org and it is not listed, and
// otherwise by id; the name is never stored. Tool inputs and outputs are never
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
const { agentDefinition, cut } = require("../lib/server/agentrun-reporter/bodies.js");

const kCapyBaseUrl = "https://api.capy.ai/api/v1";
const kDefaultRuntime = "claude-agent-sdk";
const kRuntimePattern = /^[a-z][a-z0-9-]{1,63}$/;
const kClosedStatuses = new Set(["idle", "failed", "archived"]);
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
const createCapyClient = ({ apiKey, fetchImpl, sleep, baseUrl = kCapyBaseUrl }) => {
  const get = async (pathname, query = {}) => {
    const url = new URL(baseUrl + pathname);
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
    for (let waits = 0; ; waits += 1) {
      const response = await fetchImpl(url.toString(), { headers: { accept: "application/json", authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30000) });
      if (response.status === 429 && waits < kMaxRateLimitWaits) {
        const seconds = Number(response.headers.get("retry-after"));
        await sleep(Math.min(kMaxRetryAfterMs, (Number.isFinite(seconds) && seconds >= 0 ? seconds : 5) * 1000));
        continue;
      }
      const body = await response.json().catch(() => null);
      if (response.status >= 200 && response.status < 300) return body;
      throw Object.assign(new Error(`capy ${response.status} ${body?._tag || ""} on ${pathname.split("/").slice(0, 2).join("/")}`), { status: response.status, tag: String(body?._tag || "") });
    }
  };
  const all = async (pathname, query) => {
    const items = [];
    let cursor = null;
    do {
      const page = await get(pathname, { ...query, cursor });
      items.push(...(page?.items || []));
      cursor = page?.cursor || null;
    } while (cursor);
    return items;
  };
  return { get, all };
};

// A thread's transcript from an after cursor. Each entry remembers the after
// value of the page it came from, so the next pass can start at the page that
// holds the first unfinished turn. Messages page forward with after and end at
// a null cursor; an unchanged cursor means unsettled messages block the rest
// (docs.capy.ai/api-reference/schemas/TranscriptPageEncoded).
const readTranscript = async (capy, threadId, after) => {
  const entries = [];
  let pageStart = after || null;
  for (;;) {
    const page = await capy.get(`/threads/${encodeURIComponent(threadId)}/messages`, { after: pageStart });
    for (const item of page?.items || []) entries.push({ ...item, pageStart });
    if (!page?.cursor) return { entries, lastPageStart: pageStart, complete: true };
    if (page.cursor === pageStart) return { entries, lastPageStart: pageStart, complete: false };
    pageStart = page.cursor;
  }
};

// A turn is a user entry and every entry after it up to the next user entry.
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
const createStateOutbox = ({ state, save, now, sendable = () => true, nameOf = (row) => row.agent_name }) => ({
  due: (limit = 50) =>
    state.rows
      .filter((row) => row.state === "queued" && row.next_attempt_at <= now() && sendable(row))
      .slice(0, limit)
      .map((row) => ({ ...row, agent_name: nameOf(row) })),
  update: (id, fields) => {
    const row = state.rows.find((entry) => entry.id === id);
    if (row) Object.assign(row, fields);
    save();
  },
  agentOf: (agentKey) => state.agents[agentKey] || null,
  saveAgent: ({ agentKey, agentId, runtime, definitionHash }) => {
    state.agents[agentKey] = { agent_id: agentId, runtime, definition_hash: definitionHash };
    save();
  },
  forgetAgent: (agentKey) => {
    delete state.agents[agentKey];
    save();
  },
});

const loadState = (statePath, log) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.rows)) return { threads: {}, agents: {}, ...parsed };
    log("state_reset op=load (not a reporter state file; starting empty, turns re-send under their old keys)");
  } catch (error) {
    if (error?.code !== "ENOENT") log("state_reset op=load (unreadable; starting empty, turns re-send under their old keys)");
  }
  return { version: 1, threads: {}, agents: {}, rows: [] };
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
} = {}) => {
  const log = (line) => logger.warn?.(`[alphaclaw] agentrun-reporter ${line}`);
  const missing = ["CAPY_REPORTER_API_KEY", "AGENTRUN_BASE_URL", "AGENTRUN_CAPY_REPORTER_TOKEN"].filter((name) => !String(env[name] || "").trim());
  if (!statePath) missing.push("--state (or AGENTRUN_CAPY_STATE)");
  if (missing.length) {
    log(`config_missing op=capy fix=set ${missing.join(", ")} (nothing read or sent)`);
    return 2;
  }
  const runtimeSetting = String(env.AGENTRUN_CAPY_RUNTIME || "").trim() || kDefaultRuntime;
  const runtime = kRuntimePattern.test(runtimeSetting) ? runtimeSetting : kDefaultRuntime;
  if (runtime !== runtimeSetting) log("runtime_invalid op=capy fix=AGENTRUN_CAPY_RUNTIME must be a runtime name; using claude-agent-sdk");
  const privateIds = new Set(listOf(env.AGENTRUN_CAPY_PRIVATE_CAPTAINS));
  const state = loadState(statePath, log);
  const save = () => {
    fs.mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true });
    const temp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, statePath);
  };
  const capy = createCapyClient({ apiKey: String(env.CAPY_REPORTER_API_KEY).trim(), fetchImpl: capyFetchImpl, sleep, baseUrl: capyBaseUrl });
  const counts = { threads: 0, queued: 0 };
  const seenIds = new Set();
  const privateNow = new Set();
  const listedOpen = new Set();
  const projectsById = new Map();
  const captains = new Map();
  let failed = false;

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
    row.agent_key.startsWith(kCrewPrefix) && (row.class === "thread" || row.class === "automation") ? crewNameOf(row.agent_key.slice(kCrewPrefix.length)) : row.agent_name;

  const isPrivate = (thread, project) => {
    const captainId = typeof thread.captain === "string" ? thread.captain : thread.captain?.jamId;
    return thread.visibility !== "org" || project?.visibility !== "org" || privateIds.has(thread.id) || (captainId && privateIds.has(captainId));
  };

  const rowOf = ({ thread, turn, last, cls, agent, creditsNote }) => {
    const sourceRunId = `${thread.id}:${turn.user.id}`;
    const startedAt = timeOf(turn.user.createdAt) || null;
    const endedAt = timeOf(turn.entries[turn.entries.length - 1].createdAt) || startedAt;
    const status = last && thread.status === "failed" ? "failed" : "completed";
    const contents = cls === "automation";
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
    const title = cls === "private" ? "" : String(thread.title || "").trim();
    const metadataLine =
      `Capy ${cls} turn in thread ${thread.id}${title ? ` "${cut(title, 200)}"` : ""}; ` +
      `started ${startedAt ? new Date(startedAt).toISOString() : "unknown"}, ${describeDuration(endedAt - startedAt)}, status ${status}; ` +
      `${replies.length} replies, ${tools.length} tool calls.${creditsNote}`;
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
      model: String(turn.user.model || thread.lastModelId || ""),
      input_text: contents && turn.user.text ? `${turn.user.text}\n\n(${metadataLine})` : metadataLine,
      texts_json: JSON.stringify(contents ? texts : []),
      answer_text: contents && replies.length ? String(replies[replies.length - 1].text) : "",
      error_text: status === "failed" ? "The thread failed (details withheld)." : "",
      tools_json: JSON.stringify(tools),
      usage_json: "null",
      evidence_complete: 0,
      state: "queued",
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

  const processThread = async (thread, project, automationRuns) => {
    const known = state.threads[thread.id] || { after: null, reported: [], since: new Date(now() - kFirstSightMs).toISOString(), credits: null };
    const { entries, lastPageStart, complete } = await readTranscript(capy, thread.id, known.after);
    const turns = splitTurns(entries);
    // A thread that moved after the listing (an entry newer than its
    // lastActivityAt) keeps its last turn open until the next pass.
    const newest = timeOf(entries[entries.length - 1]?.createdAt);
    const settled = complete && kClosedStatuses.has(thread.status) && !(timeOf(thread.lastActivityAt) && newest > timeOf(thread.lastActivityAt));
    const open = turns.find((turn, index) => index === turns.length - 1 && !settled) || null;
    const reported = new Set(known.reported);
    const first = known.first ?? (known.after === null ? turns[0]?.user.id ?? null : null);
    const automationTurns = new Set();
    for (const runAt of automationRuns.get(thread.id) || []) {
      const turn = turns.find((candidate) => candidate.user.id === first);
      const at = timeOf(turn?.user.createdAt);
      if (turn && !turn.user.sender && at >= runAt - kAutomationEarlyMs && at <= runAt + kAutomationLateMs) automationTurns.add(turn.user.id);
    }
    const fresh = [];
    turns.forEach((turn, index) => {
      if (turn === open || reported.has(turn.user.id)) return;
      reported.add(turn.user.id);
      if (timeOf(turn.user.createdAt) < timeOf(known.since)) return;
      fresh.push({ turn, last: index === turns.length - 1 });
    });
    const credits = Number(thread.usage?.totalCredits);
    const delta = Number.isFinite(credits) && Number.isFinite(known.credits) ? credits - known.credits : null;
    const agent = agentOf(thread, project);
    const rows = fresh.map(({ turn, last }, index) => {
      const cls = isPrivate(thread, project) ? "private" : automationTurns.has(turn.user.id) ? "automation" : "thread";
      const creditsNote =
        index === fresh.length - 1 && delta !== null && delta >= 0 ? ` Thread credits used since the previous report: about ${Math.round(delta * 100) / 100} (an estimate).` : "";
      return rowOf({ thread, turn, last, cls, agent, creditsNote });
    });
    for (const row of rows) if (!state.rows.some((entry) => entry.id === row.id)) state.rows.push(row);
    const nextAfter = open ? open.user.pageStart : lastPageStart;
    const keepFrom = entries.findIndex((entry) => entry.pageStart === nextAfter);
    const kept = keepFrom < 0 ? [] : entries.slice(keepFrom).filter((entry) => entry.source === "user" && reported.has(entry.id)).map((entry) => entry.id);
    state.threads[thread.id] = {
      activity: thread.lastActivityAt || thread.updatedAt || "",
      status: thread.status,
      after: nextAfter,
      reported: kept,
      since: known.since,
      first,
      credits: rows.length || !Number.isFinite(known.credits) ? (Number.isFinite(credits) ? credits : null) : known.credits,
    };
    counts.queued += rows.length;
    save();
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
    for (const thread of changed) {
      try {
        await processThread(thread, project, automationRuns);
        counts.threads += 1;
      } catch (error) {
        listedOpen.delete(thread.id);
        if (error?.status !== 404) readFailed("thread", thread.id, error);
      }
    }
  };

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
  const unsent = state.rows.filter((row) => row.state === "queued");
  if (unsent.length > kMaxUnsentRows) {
    const drop = new Set(unsent.slice(0, unsent.length - kMaxUnsentRows).map((row) => row.id));
    state.rows = state.rows.filter((row) => !drop.has(row.id));
    log(`queue_overflow op=capy count=${drop.size} (oldest unsent turns gone; check that AgentRun is reachable)`);
  }
  // A turn that carries a title or contents is sent only when this pass's
  // complete listing of its project showed its thread as not private and its
  // transcript read succeeded. A missing thread, a failed or partial listing
  // or a failed read leaves it held in the queue for a later pass.
  const sendable = (row) => row.class === "private" || listedOpen.has(row.session_label);
  const client = createAgentrunClient({ baseUrl: String(env.AGENTRUN_BASE_URL).trim().replace(/\/+$/, ""), fetchImpl });
  const token = String(env.AGENTRUN_CAPY_REPORTER_TOKEN).trim();
  const sender = createSender({
    outbox: createStateOutbox({ state, save, now, sendable, nameOf: sendNameOf }),
    client,
    token,
    getRuntime: () => runtime,
    contentAllowed: (row) => row.class === "automation",
    now,
    logger,
    source: "capy",
  });
  const sent = await sender.sendDue({ limit: state.rows.length || 1 });
  // The pass runs hourly, past AgentRun's one-hour window, so a turn that met
  // a passing failure is retried here while a started or failed turn falls
  // due within the wait limit, at most kRetryRounds rounds.
  for (let round = 0; round < kRetryRounds && !sent.paused; round += 1) {
    const waiting = state.rows.filter((row) => row.state === "queued" && row.attempts > 0 && sendable(row)).map((row) => row.next_attempt_at);
    const waitMs = Math.max(0, Math.min(...waiting) - now());
    if (!waiting.length || waitMs > kMaxRetryWaitMs) break;
    await sleep(waitMs);
    const again = await sender.sendDue({ limit: state.rows.length || 1 });
    for (const key of Object.keys(sent)) sent[key] = key === "retry" ? again.retry : sent[key] + again[key];
  }
  const held = state.rows.filter((row) => row.state === "queued" && !sendable(row)).length;
  if (held) log(`row_held op=send count=${held} (their threads were not listed as not private this pass; kept for a later pass)`);
  // A crew agent AgentRun already holds is renamed to its id as soon as its
  // readable name is no longer allowed (a Captain gone private, listed or
  // unreadable), without waiting for that crew's next turn. A readable name
  // only ever goes out with a turn.
  for (const [agentKey, known] of Object.entries(state.agents)) {
    if (sent.paused || !agentKey.startsWith(kCrewPrefix)) continue;
    const captainId = agentKey.slice(kCrewPrefix.length);
    if (crewNameOf(captainId) !== `Capy crew ${captainId}`) continue;
    const definition = agentDefinition({ agentId: agentKey, name: `Capy crew ${captainId}`, description: kCrewDescription, runtime });
    const definitionHash = hashOf(definition);
    if (known.definition_hash === definitionHash) continue;
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
    if (put.kind === "ok") state.agents[agentKey] = { ...known, definition_hash: definitionHash };
    else log(`agent_rename_error op=agent agent=${agentKey} status=${put.status || put.kind} (name kept; the next pass tries again)`);
  }
  state.rows = state.rows.filter((row) => row.state === "queued");
  save();
  const stuck = state.rows.filter((row) => row.attempts >= kStuckAttempts).length;
  if (stuck) log(`rows_waiting op=send count=${stuck} (AgentRun has refused or missed these ${kStuckAttempts}+ times; check AGENTRUN_BASE_URL)`);
  logger.log?.(
    `[alphaclaw] agentrun-reporter capy_pass threads=${counts.threads} queued=${counts.queued} sent=${sent.sent} retry=${sent.retry} dropped=${sent.dropped} expired=${sent.expired} waiting=${state.rows.length}`,
  );
  return failed || sent.paused || stuck ? 1 : 0;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { state: { type: "string" } }, strict: true });
  process.exitCode = await runCapyReporter({ statePath: values.state || process.env.AGENTRUN_CAPY_STATE });
}
