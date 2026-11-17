const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { createFakeAgentrun } = require("./fake-agentrun");

const kScript = path.resolve(__dirname, "../../../scripts/capy-agentrun-reporter.mjs");
const kMarker = "SECRET-MARKER-c4py";
const kBase = "http://agentrun.test/v2";
const kNow = Date.parse("2026-11-17T12:00:00Z");

const at = (minutesAgo) => new Date(kNow - minutesAgo * 60000).toISOString();
let seq = 0;
const entry = (source, text, minutesAgo, extra = {}) => ({ id: "E" + String((seq += 1)).padStart(25, "0"), source, text, createdAt: at(minutesAgo), ...extra });
const user = (text, minutesAgo, extra) => entry("user", text, minutesAgo, extra);
const reply = (text, minutesAgo) => entry("assistant", text, minutesAgo);
const tool = (name, minutesAgo) => entry("tool", "input " + kMarker + " output " + kMarker, minutesAgo, { tool: name, calls: [{ tool: name, durationMs: 1200 }] });
const thread = (id, fields = {}) => ({
  id,
  projectId: "p1",
  title: "Title " + id,
  status: "idle",
  visibility: "org",
  lastActivityAt: at(5),
  updatedAt: at(5),
  lastModelId: "claude-opus-5-5",
  usage: { llmCredits: 0, imageCredits: 0, vmCredits: 0, totalCredits: 10 },
  ...fields,
});

// Capy's public API as documented (docs.capy.ai/api-reference): bearer auth,
// keyset cursors for threads and automations, after cursors for messages,
// subagents and subagent messages that end in null, 429 with retry-after.
const createFakeCapy = ({
  projects = [{ id: "p1", name: "Alpha", visibility: "org" }],
  threads = [],
  messages = {},
  automations = [],
  runs = {},
  captains = [],
  subagents = {},
  subagentMessages = {},
  pageSize = 2,
} = {}) => {
  const requests = [];
  const state = { rateLimit: 0, fail: null };
  const answer = (status, body, headers = {}) => ({ status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body });
  const page = (list, start) => ({ items: list.slice(start, start + pageSize), next: start + pageSize < list.length ? start + pageSize : null });
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const route = parsed.pathname.replace(/^\/api\/v1/, "");
    const query = Object.fromEntries(parsed.searchParams);
    requests.push({ route, query, authorized: init.headers?.authorization === "Bearer capy-key" });
    if (state.rateLimit > 0) {
      state.rateLimit -= 1;
      return answer(429, { _tag: "capy/RateLimited", retryAfterSeconds: 3 }, { "retry-after": "3" });
    }
    const failed = state.fail?.(route, query);
    if (failed) return answer(failed, { _tag: "capy/InternalError" });
    if (route === "/projects") return answer(200, { items: projects });
    if (route === "/captains") {
      const { items, next } = page(captains, Number((query.cursor || "0:x").split(":")[0]));
      return answer(200, { items, cursor: next === null ? null : next + ":x" });
    }
    if (route === "/threads" || route === "/automations") {
      const list = (route === "/threads" ? threads : automations).filter((item) => item.projectId === query.projectId);
      const { items, next } = page(list, Number((query.cursor || "0:x").split(":")[0]));
      return answer(200, { items, cursor: next === null ? null : next + ":x" });
    }
    let match;
    if ((match = /^\/automations\/([^/]+)\/runs$/.exec(route))) return answer(200, { items: runs[match[1]] || [] });
    if ((match = /^\/threads\/([^/]+)\/subagents$/.exec(route))) {
      const list = subagents[match[1]] || [];
      const from = query.after ? list.findIndex((item) => item.id === query.after) + 1 : 0;
      const { items, next } = page(list, from);
      return answer(200, { items, cursor: next === null ? null : items[items.length - 1].id });
    }
    if ((match = /^\/subagents\/([^/]+)\/messages$/.exec(route))) {
      const list = subagentMessages[match[1]];
      if (!list) return answer(404, { _tag: "capy/SubagentNotFound" });
      const from = query.after ? list.findIndex((item) => item.id === query.after) + 1 : 0;
      const { items, next } = page(list, from);
      return answer(200, { items, cursor: next === null ? null : items[items.length - 1].id });
    }
    if ((match = /^\/threads\/([^/]+)\/messages$/.exec(route))) {
      const list = messages[match[1]];
      if (!list) return answer(404, { _tag: "capy/ThreadNotFound" });
      const from = query.after ? list.findIndex((item) => item.id === query.after) + 1 : 0;
      const { items, next } = page(list, from);
      return answer(200, { items, cursor: next === null ? null : items[items.length - 1].id, beforeCursor: null });
    }
    return answer(404, { _tag: "capy/NotFound" });
  };
  return { fetchImpl, requests, state, threads, messages, captains, subagents, subagentMessages };
};

describe("scripts/capy-agentrun-reporter.mjs", () => {
  let runCapyReporter;
  let dir;
  let statePath;
  let fake;
  let sleeps;
  let clock;

  beforeAll(async () => {
    ({ runCapyReporter } = await import(kScript));
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "capy-reporter-"));
    statePath = path.join(dir, "state.json");
    clock = kNow;
    fake = createFakeAgentrun({ now: () => clock });
    sleeps = [];
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = async (capy, env = {}, options = {}) => {
    const lines = [];
    const code = await runCapyReporter({
      ...options,
      env: { CAPY_REPORTER_API_KEY: "capy-key", AGENTRUN_BASE_URL: kBase, AGENTRUN_CAPY_REPORTER_TOKEN: fake.token, AGENTRUN_CAPY_PRIVATE_CAPTAINS: "jam_privatecrew, jam_P4", ...env },
      statePath,
      fetchImpl: fake.fetchImpl,
      capyFetchImpl: capy.fetchImpl,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      logger: { warn: (line) => lines.push(line), log: (line) => lines.push(line) },
    });
    return { code, lines };
  };
  const starts = () => fake.requests.filter((request) => /\/sdk-runs$/.test(request.path));
  const runFor = (threadId, userEntry) => [...fake.runs.values()].find((item) => item.start.input.includes(threadId) && starts().some((request) => request.headers["idempotency-key"] === "alphaclaw:capy:" + threadId + ":" + userEntry.id && JSON.parse(request.body).input === item.start.input));
  const allBodies = () => fake.requests.map((request) => request.body).join("\n");

  it("pages threads and transcripts, holds a waiting thread's open turn and reports each turn once", async () => {
    const a = [user("a1", 60), reply("r1", 59), tool("bash", 58), reply("r1b", 57), user("a2", 50), reply("r2", 49), user("a3", 40), reply("r3", 39)];
    const b = [user("b1", 30), reply("rb1", 29), user("b2", 20)];
    const capy = createFakeCapy({
      threads: [thread("jam_C", { lastActivityAt: at(3 * 24 * 60) }), thread("jam_B", { status: "waiting" }), thread("jam_A")],
      messages: { jam_A: a, jam_B: b, jam_C: [user("old", 3 * 24 * 60)] },
    });
    const first = await run(capy);
    expect(first.code).toBe(0);
    expect(fake.runs.size).toBe(4);
    expect(starts().map((request) => request.headers["idempotency-key"])).toEqual(
      expect.arrayContaining([a[0], a[4], a[6]].map((item) => "alphaclaw:capy:jam_A:" + item.id).concat("alphaclaw:capy:jam_B:" + b[0].id)),
    );
    expect(capy.requests.some((request) => request.route === "/threads/jam_C/messages")).toBe(false);
    expect(capy.requests.every((request) => request.authorized)).toBe(true);
    const firstRun = runFor("jam_A", a[0]);
    expect(firstRun.start.input).toMatch(/^Title jam_A · 180s · completed — 2 replies, 1 tool call; started 2026-11-17T11:00:00.000Z; Capy thread turn in thread jam_A\.$/);
    expect(firstRun.batches.flatMap((batch) => batch.events).filter((event) => event.type === "tool").map((event) => event.name)).toEqual(["bash", "bash"]);
    expect(fake.agents.get("capy-project-p1").definition).toMatchObject({ name: "Capy project: Alpha", learning: false, sdk: { runtime: "claude-agent-sdk" } });

    b.push(reply("rb2", 10));
    Object.assign(capy.threads[1], { status: "idle", lastActivityAt: at(9), usage: { totalCredits: 12.5 } });
    const readsBefore = capy.requests.length;
    const second = await run(capy);
    expect(second.code).toBe(0);
    expect(fake.runs.size).toBe(5);
    expect(starts()).toHaveLength(5);
    expect(capy.requests.slice(readsBefore).some((request) => request.route === "/threads/jam_A/messages")).toBe(false);
    expect(runFor("jam_B", b[2]).start.input).toContain("Thread credits used since the previous report: about 2.5 (an estimate).");
  });

  it("sends contents only for the turn an automation started, and never a tool's input or output", async () => {
    const d = [user("AUTO-INPUT", 30), reply("AUTO-REPLY", 29), tool("bash", 28), user("HUMAN " + kMarker, 20), reply("REPLY " + kMarker, 19), tool("read", 18)];
    const e = [user("plain " + kMarker, 15), reply("answer " + kMarker, 14)];
    const capy = createFakeCapy({
      threads: [thread("jam_D", { captain: { jamId: "jam_crew1", name: "Crew One", avatar: {} } }), thread("jam_E", { title: "VISIBLE-TITLE" })],
      captains: [{ id: "jam_crew1", projectId: "p1", visibility: "org", name: "Crew One" }],
      messages: { jam_D: d, jam_E: e },
      automations: [{ id: "au1", projectId: "p1", threadMode: "new" }],
      runs: { au1: [{ id: "run1", automationId: "au1", status: "completed", jamId: "jam_D", createdAt: at(32), startedAt: at(31) }] },
    });
    expect((await run(capy)).code).toBe(0);
    const auto = runFor("jam_D", d[0]);
    expect(auto.start.input).toMatch(/^Title jam_D · [\d.]+s · completed — .*; Capy automation turn in thread jam_D\.\n\nAUTO-INPUT$/);
    expect(auto.batches.flatMap((batch) => batch.events).filter((event) => event.type === "text").map((event) => event.text)).toEqual(["AUTO-REPLY", "Tool call: bash (1.2s)"]);
    expect(auto.completion).toMatchObject({ status: "completed", answer: "AUTO-REPLY", session_id: "jam_D", evidence_complete: false });
    expect(runFor("jam_D", d[3]).start.input).toMatch(/^Title jam_D · .*; Capy thread turn in thread jam_D\.$/);
    expect(runFor("jam_E", e[0]).start.input).toMatch(/^VISIBLE-TITLE · /);
    expect(fake.agents.get("capy-captain-jam_crew1").definition.name).toBe("Capy crew: Crew One");
    expect(allBodies()).not.toContain(kMarker);
  });

  it("keeps private threads, private crews and threads with no visibility to metadata without a title", async () => {
    const turn = () => [user("ask " + kMarker, 30), reply("answer " + kMarker, 29), tool("bash", 28)];
    const missing = thread("jam_P2", { title: "PRIVATE-TITLE " + kMarker });
    delete missing.visibility;
    const threads = [
      thread("jam_P1", { visibility: "private", title: "PRIVATE-TITLE " + kMarker }),
      missing,
      thread("jam_P3", { title: "PRIVATE-TITLE " + kMarker, captain: { jamId: "jam_privatecrew", name: "Crew " + kMarker, avatar: {} } }),
      thread("jam_P4", { title: "PRIVATE-TITLE " + kMarker }),
    ];
    const capy = createFakeCapy({
      threads,
      messages: Object.fromEntries(threads.map((item) => [item.id, turn()])),
      automations: [{ id: "au1", projectId: "p1", threadMode: "new" }],
      runs: { au1: [{ id: "run1", automationId: "au1", status: "completed", jamId: "jam_P3", createdAt: at(32), startedAt: at(31) }] },
    });
    expect((await run(capy)).code).toBe(0);
    expect(fake.runs.size).toBe(4);
    for (const item of fake.runs.values()) expect(item.start.input).toMatch(/^Private Capy thread · .*; Capy private turn in thread jam_P\d\.$/);
    expect(fake.agents.get("capy-captain-jam_privatecrew").definition.name).toBe("Capy crew jam_privatecrew");
    expect(allBodies()).not.toContain(kMarker);
    expect(allBodies()).not.toContain("PRIVATE-TITLE");
  });

  it("keeps an org thread in a private project to metadata without a title or contents", async () => {
    const capy = createFakeCapy({
      projects: [{ id: "p1", name: "Hidden", visibility: "private" }],
      threads: [thread("jam_Q", { title: "PRIVATE-TITLE" })],
      messages: { jam_Q: [user("AUTO-INPUT " + kMarker, 30), reply("AUTO-REPLY " + kMarker, 29)] },
      automations: [{ id: "au1", projectId: "p1", threadMode: "new" }],
      runs: { au1: [{ id: "run1", automationId: "au1", status: "completed", jamId: "jam_Q", createdAt: at(32), startedAt: at(31) }] },
    });
    expect((await run(capy)).code).toBe(0);
    expect(fake.runs.size).toBe(1);
    expect([...fake.runs.values()][0].start.input).toMatch(/^Private Capy thread · .*; Capy private turn in thread jam_Q\.$/);
    expect(allBodies()).not.toMatch(/PRIVATE-TITLE|Hidden|AUTO-/);
    expect(allBodies()).not.toContain(kMarker);
  });

  it("sends no contents for a person's message in a standing automation thread, even inside the run window", async () => {
    const s = [user("PERSON-TEXT", 32), reply("PERSON-REPLY", 31.5), user("STANDING-PROMPT", 30), reply("STANDING-REPLY", 29)];
    const capy = createFakeCapy({
      threads: [thread("jam_S")],
      messages: { jam_S: s },
      automations: [{ id: "au1", projectId: "p1", threadMode: "single" }],
      runs: { au1: [{ id: "run1", automationId: "au1", status: "completed", jamId: "jam_S", createdAt: at(31), startedAt: at(31) }] },
    });
    expect((await run(capy)).code).toBe(0);
    expect(fake.runs.size).toBe(2);
    for (const item of fake.runs.values()) expect(item.start.input).toMatch(/^Title jam_S · .*; Capy thread turn in thread jam_S\.$/);
    expect(allBodies()).not.toMatch(/PERSON-|STANDING-/);
  });

  it("keeps turns while AgentRun is down, and drops a queued automation turn whose crew became private", async () => {
    const d = [user("AUTO-INPUT", 30), reply("AUTO-REPLY", 29)];
    const capy = createFakeCapy({
      threads: [thread("jam_D", { captain: { jamId: "jam_crew1", name: "Crew One", avatar: {} } })],
      messages: { jam_D: d },
      automations: [{ id: "au1", projectId: "p1", threadMode: "new" }],
      runs: { au1: [{ id: "run1", automationId: "au1", status: "completed", jamId: "jam_D", createdAt: at(32), startedAt: at(31) }] },
    });
    fake.state.down = true;
    expect((await run(capy)).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).rows).toHaveLength(1);
    fake.state.down = false;
    clock += 60 * 60 * 1000;
    const later = await run(capy, { AGENTRUN_CAPY_PRIVATE_CAPTAINS: "jam_crew1" });
    expect(later.lines.join("\n")).toContain("content_revoked op=capy count=1");
    expect(fake.runs.size).toBe(0);
    expect(allBodies()).not.toContain("AUTO-");
  });

  it("drops a queued title once its thread turns private, and never claims a person's turn for an automation", async () => {
    const a = [user("a1", 30), reply("r1", 29)];
    const h = [user("PERSON-TEXT", 40), reply("PERSON-REPLY", 39), user("LATE-PERSON", 5), reply("late reply", 4)];
    const capy = createFakeCapy({
      threads: [thread("jam_A", { title: "SECRET-TITLE" }), thread("jam_H", { lastActivityAt: at(3) })],
      messages: { jam_A: a, jam_H: h },
      automations: [{ id: "au1", projectId: "p1", threadMode: "new" }],
      runs: {
        au1: [
          { id: "skipped", automationId: "au1", status: "skipped", jamId: "jam_H", createdAt: at(41), startedAt: null },
          { id: "early", automationId: "au1", status: "completed", jamId: "jam_H", createdAt: at(31), startedAt: at(30) },
        ],
      },
    });
    fake.state.down = true;
    expect((await run(capy)).code).toBe(0);
    fake.state.down = false;
    clock += 60 * 60 * 1000;
    capy.threads[0].visibility = "private";
    const later = await run(capy);
    expect(later.lines.join("\n")).toContain("content_revoked op=capy count=1");
    expect(allBodies()).not.toContain("SECRET-TITLE");
    expect(fake.runs.size).toBe(2);
    expect(allBodies()).not.toMatch(/PERSON-TEXT|PERSON-REPLY|LATE-PERSON/);
  });

  it("holds the last turn of a thread that moved after the listing, and names private entries that match nothing", async () => {
    const a = [user("a1", 30), reply("r1", 29), user("a2", 2)];
    const capy = createFakeCapy({ threads: [thread("jam_A", { lastActivityAt: at(29) })], messages: { jam_A: a } });
    const result = await run(capy, { AGENTRUN_CAPY_PRIVATE_CAPTAINS: "XYZ-1" });
    expect(result.code).toBe(0);
    expect(starts().map((request) => request.headers["idempotency-key"])).toEqual(["alphaclaw:capy:jam_A:" + a[0].id]);
    expect(result.lines.join("\n")).toContain("private_unmatched op=capy entry=XYZ-1");
  });

  it("logs capy_rejected and exits 1 on a refused key, holds queued titles and still sends metadata-only turns", async () => {
    const capy = createFakeCapy({
      threads: [thread("jam_A", { title: "SECRET-TITLE" }), thread("jam_P", { visibility: "private" })],
      messages: { jam_A: [user("a1", 30), reply("r1", 29)], jam_P: [user("p1", 30), reply("rp1", 29)] },
    });
    fake.state.down = true;
    await run(capy);
    fake.state.down = false;
    clock += 60 * 60 * 1000;
    const refused = { fetchImpl: async () => ({ status: 401, headers: { get: () => null }, json: async () => ({ _tag: "capy/Unauthorized" }) }) };
    const result = await run(refused);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("capy_rejected op=read status=401");
    expect(result.lines.join("\n")).toContain("row_held op=send count=1");
    expect(fake.runs.size).toBe(1);
    expect(allBodies()).not.toContain("SECRET-TITLE");
    expect((await run(capy)).code).toBe(0);
    expect(fake.runs.size).toBe(2);
  });

  it("holds a queued title whose thread dropped out of the listing", async () => {
    const capy = createFakeCapy({ threads: [thread("jam_A", { title: "SECRET-TITLE" })], messages: { jam_A: [user("a1", 30), reply("r1", 29)] } });
    fake.state.down = true;
    await run(capy);
    fake.state.down = false;
    clock += 60 * 60 * 1000;
    capy.threads.splice(0);
    const result = await run(capy);
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("row_held op=send count=1");
    expect(fake.runs.size).toBe(0);
    expect(allBodies()).not.toContain("SECRET-TITLE");
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).rows).toHaveLength(1);
  });

  it("holds queued titles of a project whose listing failed part way, and still reports the next project", async () => {
    const capy = createFakeCapy({
      projects: [
        { id: "p1", name: "Alpha", visibility: "org" },
        { id: "p2", name: "Beta", visibility: "org" },
      ],
      threads: [thread("jam_A", { title: "SECRET-A" }), thread("jam_B", { title: "SECRET-B" }), thread("jam_C", { title: "SECRET-C" }), thread("jam_Z", { projectId: "p2" })],
      messages: Object.fromEntries(["jam_A", "jam_B", "jam_C", "jam_Z"].map((id) => [id, [user(id + "-1", 30), reply(id + "-r1", 29)]])),
    });
    fake.state.down = true;
    await run(capy);
    fake.state.down = false;
    clock += 60 * 60 * 1000;
    capy.state.fail = (route, query) => (route === "/threads" && query.projectId === "p1" && query.cursor ? 500 : null);
    const result = await run(capy);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("capy_error op=project id=p1 status=500");
    expect(result.lines.join("\n")).toContain("row_held op=send count=3");
    expect(fake.runs.size).toBe(1);
    expect(allBodies()).not.toMatch(/SECRET-[ABC]/);
  });

  it("skips a thread whose read fails and still reports the threads after it", async () => {
    const capy = createFakeCapy({
      threads: [thread("jam_A"), thread("jam_B", { title: "SECRET-B" }), thread("jam_C")],
      messages: { jam_A: [user("a1", 30), reply("ra1", 29)], jam_B: [user("b1", 30), reply("rb1", 29)], jam_C: [user("c1", 30), reply("rc1", 29)] },
    });
    capy.state.fail = (route) => (route === "/threads/jam_B/messages" ? 500 : null);
    const result = await run(capy);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("capy_error op=thread id=jam_B status=500");
    expect(result.lines.join("\n")).not.toContain("capy-key");
    expect(starts().map((request) => request.headers["idempotency-key"].split(":")[2])).toEqual(["jam_A", "jam_C"]);
    capy.state.fail = null;
    clock += 60 * 60 * 1000;
    expect((await run(capy)).code).toBe(0);
    expect(fake.runs.size).toBe(3);
  });

  it("retries a passing AgentRun failure within the same pass while AgentRun answers", async () => {
    const capy = createFakeCapy({ threads: [thread("jam_A"), thread("jam_B")], messages: { jam_A: [user("a1", 30), reply("r1", 29)], jam_B: [user("b1", 30), reply("rb1", 29)] } });
    fake.state.failNext.push({ status: 503, body: { error: { code: "unavailable", message: "busy" } } });
    expect((await run(capy)).code).toBe(0);
    expect(fake.runs.size).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeLessThanOrEqual(60000);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).rows).toEqual([]);
  });

  it("completes two turns that each met a 503 in the same round within one pass", async () => {
    const capy = createFakeCapy({ threads: [thread("jam_A"), thread("jam_B")], messages: { jam_A: [user("a1", 30), reply("r1", 29)], jam_B: [user("b1", 30), reply("rb1", 29)] } });
    for (let i = 0; i < 2; i += 1) fake.state.failNext.push({ path: /\/events$/, status: 503, body: { error: { code: "unavailable", message: "busy" } } });
    expect((await run(capy)).code).toBe(0);
    expect([...fake.runs.values()].map((item) => item.completion?.status)).toEqual(["completed", "completed"]);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).rows).toEqual([]);
  });

  const captain = (id, name, fields = {}) => ({ id, projectId: "p1", visibility: "org", name, ...fields });
  const inCrew = (id, crewId, fields = {}) => thread(id, { captain: { jamId: crewId, name: "THREAD-SIDE-NAME", avatar: {} }, ...fields });
  const turnOf = (id) => [user(id + "-1", 30), reply(id + "-r1", 29)];

  it("names an org crew from its live Captain at send, never stores the name, and puts private threads under one shared agent", async () => {
    const capy = createFakeCapy({
      captains: [captain("jam_crewR", "READABLE-CREW")],
      threads: [inCrew("jam_R", "jam_crewR"), inCrew("jam_V", "jam_crewR", { visibility: "private" })],
      messages: { jam_R: turnOf("jam_R"), jam_V: turnOf("jam_V") },
    });
    fake.state.down = true;
    await run(capy);
    expect(fs.readFileSync(statePath, "utf8")).not.toContain("READABLE-CREW");
    fake.state.down = false;
    clock += 60 * 60 * 1000;
    expect((await run(capy)).code).toBe(0);
    expect(fake.agents.get("capy-captain-jam_crewR").definition.name).toBe("Capy crew: READABLE-CREW");
    expect(fake.agents.get("capy-private-threads").definition.name).toBe("Capy private threads");
    expect(starts().map((request) => request.path).sort()).toEqual(["/agents/capy-captain-jam_crewR/sdk-runs", "/agents/capy-private-threads/sdk-runs"]);
    expect(fs.readFileSync(statePath, "utf8")).not.toContain("READABLE-CREW");
    expect(allBodies()).not.toContain("THREAD-SIDE-NAME");
  });

  it("sends no crew name for queued rows whose Captain is listed before they go, and never stores it", async () => {
    const capy = createFakeCapy({
      captains: [captain("jam_crewR", "SECRET-CREW")],
      threads: [inCrew("jam_R", "jam_crewR"), inCrew("jam_V", "jam_crewR", { visibility: "private" })],
      messages: { jam_R: turnOf("jam_R"), jam_V: turnOf("jam_V") },
    });
    fake.state.down = true;
    await run(capy);
    fake.state.down = false;
    clock += 60 * 60 * 1000;
    const later = await run(capy, { AGENTRUN_CAPY_PRIVATE_CAPTAINS: "jam_crewR" });
    expect(later.lines.join("\n")).toContain("content_revoked op=capy count=1");
    expect(fake.runs.size).toBe(1);
    expect(allBodies()).not.toContain("SECRET-CREW");
    expect(fs.readFileSync(statePath, "utf8")).not.toContain("SECRET-CREW");
  });

  it("falls back to the crew id for a listed Captain, a private Captain, a Captain in a private project and a Captain the key cannot see", async () => {
    const capy = createFakeCapy({
      projects: [
        { id: "p1", name: "Alpha", visibility: "org" },
        { id: "p9", name: "Hidden", visibility: "private" },
      ],
      captains: [captain("jam_crewL", "NAME-L"), captain("jam_crewP", "NAME-P", { visibility: "private" }), captain("jam_crewQ", "NAME-Q", { projectId: "p9" })],
      threads: [inCrew("jam_L1", "jam_crewL"), inCrew("jam_P1", "jam_crewP"), inCrew("jam_Q1", "jam_crewQ"), inCrew("jam_N1", "jam_crewN")],
      messages: Object.fromEntries(["jam_L1", "jam_P1", "jam_Q1", "jam_N1"].map((id) => [id, turnOf(id)])),
    });
    expect((await run(capy, { AGENTRUN_CAPY_PRIVATE_CAPTAINS: "jam_crewL" })).code).toBe(0);
    for (const id of ["L", "P", "Q", "N"]) expect(fake.agents.get("capy-captain-jam_crew" + id).definition.name).toBe("Capy crew jam_crew" + id);
    expect(allBodies()).not.toMatch(/NAME-[LPQ]/);
  });

  it("falls back to the crew id when the Captain lookup fails", async () => {
    const capy = createFakeCapy({ captains: [captain("jam_crewR", "NAME-R")], threads: [inCrew("jam_R", "jam_crewR")], messages: { jam_R: turnOf("jam_R") } });
    capy.state.fail = (route) => (route === "/captains" ? 500 : null);
    const result = await run(capy);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("capy_error op=captains id=all status=500");
    expect(fake.agents.get("capy-captain-jam_crewR").definition.name).toBe("Capy crew jam_crewR");
    expect(allBodies()).not.toContain("NAME-R");
  });

  it("falls back to the crew id for a row of an unknown class", async () => {
    const capy = createFakeCapy({ captains: [captain("jam_crewR", "NAME-R")], threads: [inCrew("jam_R", "jam_crewR")], messages: { jam_R: turnOf("jam_R") } });
    fake.state.down = true;
    await run(capy);
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    saved.rows[0].class = "mystery";
    fs.writeFileSync(statePath, JSON.stringify(saved));
    fake.state.down = false;
    clock += 60 * 60 * 1000;
    expect((await run(capy)).code).toBe(0);
    expect(fake.agents.get("capy-captain-jam_crewR").definition.name).toBe("Capy crew jam_crewR");
    expect(allBodies()).not.toContain("NAME-R");
  });

  it("renames a crew agent to its id in the next pass after its Captain turns private, with no new turn", async () => {
    const capy = createFakeCapy({ captains: [captain("jam_crewR", "NAME-R")], threads: [inCrew("jam_R", "jam_crewR")], messages: { jam_R: turnOf("jam_R") } });
    expect((await run(capy)).code).toBe(0);
    expect(fake.agents.get("capy-captain-jam_crewR").definition.name).toBe("Capy crew: NAME-R");
    capy.captains[0].visibility = "private";
    clock += 60 * 60 * 1000;
    expect((await run(capy)).code).toBe(0);
    expect(fake.runs.size).toBe(1);
    expect(fake.agents.get("capy-captain-jam_crewR").definition.name).toBe("Capy crew jam_crewR");
    const puts = () => fake.requests.filter((request) => request.method === "PUT").length;
    const before = puts();
    clock += 60 * 60 * 1000;
    await run(capy);
    expect(puts()).toBe(before);
  });

  it("renames a crew agent to its id after a readable-name update whose answer was lost, once its Captain turns private", async () => {
    const capy = createFakeCapy({ captains: [captain("jam_crewR", "LOST-NAME", { visibility: "private" })], threads: [inCrew("jam_R", "jam_crewR")], messages: { jam_R: turnOf("jam_R") } });
    expect((await run(capy)).code).toBe(0);
    expect(fake.agents.get("capy-captain-jam_crewR").definition.name).toBe("Capy crew jam_crewR");
    capy.captains[0].visibility = "org";
    clock += 60 * 60 * 1000;
    capy.messages.jam_R.push(user("jam_R-2", -50), reply("jam_R-r2", -51));
    capy.threads[0].lastActivityAt = at(-51);
    fake.state.loseAnswer = /\/definition$/;
    await run(capy);
    expect(fake.agents.get("capy-captain-jam_crewR").definition.name).toBe("Capy crew: LOST-NAME");
    fake.state.down = false;
    capy.captains[0].visibility = "private";
    clock += 60 * 60 * 1000;
    await run(capy);
    expect(fake.agents.get("capy-captain-jam_crewR").definition.name).toBe("Capy crew jam_crewR");
  });

  it("logs a failed crew rename, exits 1 and renames on the next pass", async () => {
    const capy = createFakeCapy({ captains: [captain("jam_crewR", "NAME-R")], threads: [inCrew("jam_R", "jam_crewR")], messages: { jam_R: turnOf("jam_R") } });
    expect((await run(capy)).code).toBe(0);
    capy.captains[0].visibility = "private";
    clock += 60 * 60 * 1000;
    fake.state.failNext.push({ path: /^\/agents\/capy-captain-jam_crewR$/, status: 503, body: { error: { code: "unavailable", message: "busy" } } });
    const failedPass = await run(capy);
    expect(failedPass.code).toBe(1);
    expect(failedPass.lines.join("\n")).toContain("agent_rename_error op=agent agent=capy-captain-jam_crewR status=503");
    expect(fake.agents.get("capy-captain-jam_crewR").definition.name).toBe("Capy crew: NAME-R");
    clock += 60 * 60 * 1000;
    expect((await run(capy)).code).toBe(0);
    expect(fake.agents.get("capy-captain-jam_crewR").definition.name).toBe("Capy crew jam_crewR");
  });

  it("renames a crew agent to its id in the next pass after its Captain is listed", async () => {
    const capy = createFakeCapy({ captains: [captain("jam_crewR", "NAME-R")], threads: [inCrew("jam_R", "jam_crewR")], messages: { jam_R: turnOf("jam_R") } });
    expect((await run(capy)).code).toBe(0);
    expect(fake.agents.get("capy-captain-jam_crewR").definition.name).toBe("Capy crew: NAME-R");
    clock += 60 * 60 * 1000;
    expect((await run(capy, { AGENTRUN_CAPY_PRIVATE_CAPTAINS: "jam_crewR" })).code).toBe(0);
    expect(fake.agents.get("capy-captain-jam_crewR").definition.name).toBe("Capy crew jam_crewR");
  });

  it("retries a started turn through two failed rounds within the same pass", async () => {
    const capy = createFakeCapy({ threads: [thread("jam_A")], messages: { jam_A: [user("a1", 30), reply("r1", 29)] } });
    for (let i = 0; i < 2; i += 1) fake.state.failNext.push({ path: /\/events$/, status: 503, body: { error: { code: "unavailable", message: "busy" } } });
    expect((await run(capy)).code).toBe(0);
    expect(fake.requests.filter((request) => /\/events$/.test(request.path))).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect([...fake.runs.values()][0].completion).toMatchObject({ status: "completed" });
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).rows).toEqual([]);
  });

  it("retries a single started turn within the same pass when no other turn moves", async () => {
    const capy = createFakeCapy({ threads: [thread("jam_A")], messages: { jam_A: [user("a1", 30), reply("r1", 29)] } });
    fake.state.failNext.push({ path: /\/events$/, status: 503, body: { error: { code: "unavailable", message: "busy" } } });
    expect((await run(capy)).code).toBe(0);
    expect(fake.requests.filter((request) => /\/events$/.test(request.path))).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).rows).toEqual([]);
  });

  it("waits out a Capy 429 for its retry-after and sends the same request again", async () => {
    const capy = createFakeCapy({ threads: [thread("jam_A")], messages: { jam_A: [user("a1", 30), reply("r1", 29)] } });
    capy.state.rateLimit = 1;
    expect((await run(capy)).code).toBe(0);
    expect(sleeps).toEqual([3000]);
    expect(capy.requests.filter((request) => request.route === "/projects")).toHaveLength(2);
    expect(fake.runs.size).toBe(1);
  });

  it("re-sends under the same keys after the state file is lost, and drops a rebuilt start AgentRun refuses as a mismatch", async () => {
    const a = [user("a1", 30), reply("r1", 29), user("a2", 20), reply("r2", 19)];
    const capy = createFakeCapy({ threads: [thread("jam_A")], messages: { jam_A: a } });
    expect((await run(capy)).code).toBe(0);
    expect(fake.runs.size).toBe(2);

    fs.rmSync(statePath);
    const again = await run(capy);
    expect(again.code).toBe(0);
    expect(starts()).toHaveLength(4);
    expect(fake.runs.size).toBe(2);
    expect(again.lines.join("\n")).not.toContain("row_dropped");

    fs.rmSync(statePath);
    capy.threads[0].title = "Renamed";
    const renamed = await run(capy);
    expect(renamed.code).toBe(0);
    expect(fake.runs.size).toBe(2);
    expect(renamed.lines.filter((line) => line.includes("row_dropped op=start source=capy code=idempotency_mismatch"))).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).rows).toEqual([]);
  });

  const sub = (id, threadId, fields = {}) => ({
    id,
    threadId,
    parentId: threadId,
    subagentPath: "1",
    taskPath: "1",
    projectId: "p1",
    title: "Sub " + id,
    status: "idle",
    archived: false,
    usage: { llmCredits: 0, imageCredits: 0, vmCredits: 0, totalCredits: 4 },
    createdAt: at(60),
    updatedAt: at(5),
    lastActivityAt: at(5),
    ...fields,
  });
  const fromParent = (threadId) => ({ sender: { id: threadId, relation: "parent" } });
  const keys = () => starts().map((request) => request.headers["idempotency-key"]);
  const leasePath = () => path.join(dir, "capy-reporter.lease.json");
  const eventsOf = (item) => item.batches.flatMap((batch) => batch.events);
  const runByKey = (key) => {
    const request = starts().find((item) => item.headers["idempotency-key"] === key);
    return request && [...fake.runs.values()].find((item) => JSON.stringify(item.start) === request.body);
  };
  // Calls hook(n) before the nth /projects read, the start of each pass.
  const onPass = (capy, hook) => {
    let passes = 0;
    return { ...capy, fetchImpl: async (url, init) => (new URL(url).pathname.endsWith("/projects") && hook((passes += 1)), capy.fetchImpl(url, init)) };
  };

  it("reports each subagent turn from paged subagents and transcripts as metadata with a title, under its thread's agent", async () => {
    const s1 = [
      user("TASK-1 " + kMarker, 30),
      reply("SUB-REPLY " + kMarker, 29),
      tool("bash", 28),
      user("FOLLOW-UP " + kMarker, 25, fromParent("jam_A")),
      reply("SUB-REPLY-2 " + kMarker, 24),
    ];
    const s2 = [user("TASK-2", 30), reply("done", 29)];
    const s3 = [user("TASK-3", 30), reply("done", 29)];
    const capy = createFakeCapy({
      threads: [thread("jam_A")],
      messages: { jam_A: [user("a1", 40), reply("r1", 39)] },
      subagents: { jam_A: [sub("s1", "jam_A"), sub("s2", "jam_A", { subagentPath: "2" }), sub("s3", "jam_A", { subagentPath: "2.1", title: null })] },
      subagentMessages: { s1, s2, s3 },
    });
    expect((await run(capy)).code).toBe(0);
    expect(capy.requests.some((request) => request.route === "/threads/jam_A/subagents" && request.query.after === "s2")).toBe(true);
    expect(capy.requests.filter((request) => request.route === "/subagents/s1/messages").length).toBe(3);
    const subKeys = keys().filter((key) => key.includes(":sub:"));
    expect(subKeys).toEqual(["alphaclaw:capy:jam_A:sub:s1:" + s1[0].id, "alphaclaw:capy:jam_A:sub:s1:" + s1[3].id, "alphaclaw:capy:jam_A:sub:s2:" + s2[0].id, "alphaclaw:capy:jam_A:sub:s3:" + s3[0].id]);
    const first = runByKey("alphaclaw:capy:jam_A:sub:s1:" + s1[0].id);
    expect(first.start.input).toMatch(/^Subagent 1 of Title jam_A: Sub s1 · 120s · completed — 1 reply, 1 tool call; started .*; Capy subagent turn of subagent s1 in thread jam_A\.$/);
    expect(eventsOf(first).filter((event) => event.type === "text")).toEqual([]);
    expect(eventsOf(first).filter((event) => event.type === "tool").map((event) => event.name)).toEqual(["bash", "bash"]);
    expect(first.completion).toMatchObject({ status: "completed", answer: "", session_id: "jam_A" });
    expect([...fake.runs.values()].find((item) => item.start.input.includes("subagent s3")).start.input).toMatch(/^Subagent 2\.1 of Title jam_A: s3 · /);
    expect(starts().every((request) => request.path === "/agents/capy-project-p1/sdk-runs")).toBe(true);

    s1.push(user("THIRD " + kMarker, 10, fromParent("jam_A")), reply("SUB-REPLY-3 " + kMarker, 9));
    Object.assign(capy.threads[0], { lastActivityAt: at(9) });
    Object.assign(capy.subagents.jam_A[0], { lastActivityAt: at(9), usage: { totalCredits: 6.5 } });
    clock += 60 * 60 * 1000;
    expect((await run(capy)).code).toBe(0);
    expect(runByKey("alphaclaw:capy:jam_A:sub:s1:" + s1[5].id).start.input).toContain("Subagent credits used since the previous report: about 2.5 (an estimate).");
    expect(fake.runs.size).toBe(6);
    expect(allBodies()).not.toContain(kMarker);
    expect(allBodies()).not.toContain("cost_usd");
  });

  it("keeps a private thread's subagent to metadata without its thread's or its own title", async () => {
    const capy = createFakeCapy({
      threads: [thread("jam_P", { visibility: "private", title: "PRIVATE-TITLE" })],
      messages: { jam_P: [user("p1 " + kMarker, 40), reply("rp1 " + kMarker, 39)] },
      subagents: { jam_P: [sub("sP", "jam_P", { title: "SUB-SECRET" })] },
      subagentMessages: { sP: [user("TASK " + kMarker, 30), reply("REPLY " + kMarker, 29)] },
    });
    expect((await run(capy)).code).toBe(0);
    const subRun = runByKey(keys().find((key) => key.includes(":sub:sP:")));
    expect(subRun.start.input).toMatch(/^Private Capy subagent · .*; Capy private turn of subagent sP in thread jam_P\.$/);
    expect(starts().every((request) => request.path === "/agents/capy-private-threads/sdk-runs")).toBe(true);
    expect(allBodies()).not.toMatch(/PRIVATE-TITLE|SUB-SECRET/);
    expect(allBodies()).not.toContain(kMarker);
  });

  it("sends no contents for an automation thread's subagent: no text event, no input text and no answer", async () => {
    const capy = createFakeCapy({
      threads: [thread("jam_D", { captain: { jamId: "jam_crew1", name: "Crew One", avatar: {} } })],
      captains: [{ id: "jam_crew1", projectId: "p1", visibility: "org", name: "Crew One" }],
      messages: { jam_D: [user("AUTO-INPUT", 30), reply("AUTO-REPLY", 29)] },
      automations: [{ id: "au1", projectId: "p1", threadMode: "new" }],
      runs: { au1: [{ id: "run1", automationId: "au1", status: "completed", jamId: "jam_D", createdAt: at(32), startedAt: at(31) }] },
      subagents: { jam_D: [sub("sD", "jam_D")] },
      subagentMessages: { sD: [user("SUB-INPUT " + kMarker, 28), reply("SUB-REPLY " + kMarker, 27), tool("bash", 26), user("SUB-AGAIN " + kMarker, 25, fromParent("jam_D")), reply("SUB-LAST " + kMarker, 24)] },
    });
    expect((await run(capy)).code).toBe(0);
    expect(runByKey(keys().find((key) => /:jam_D:E/.test(key))).start.input).toMatch(/Capy automation turn in thread jam_D\.\n\nAUTO-INPUT$/);
    const subRuns = keys().filter((key) => key.includes(":sub:sD:")).map(runByKey);
    expect(subRuns).toHaveLength(2);
    for (const item of subRuns) {
      expect(item.start.input).toMatch(/^Subagent 1 of Title jam_D: Sub sD · .*; Capy subagent turn of subagent sD in thread jam_D\.$/);
      expect(eventsOf(item).filter((event) => event.type === "text")).toEqual([]);
      expect(item.completion.answer).toBe("");
    }
    expect(fake.agents.get("capy-captain-jam_crew1").definition.name).toBe("Capy crew: Crew One");
    expect(allBodies()).not.toMatch(/SUB-(INPUT|REPLY|AGAIN|LAST)/);
    expect(allBodies()).not.toContain(kMarker);
  });

  it("keys a subagent turn the same way across processes and after a lost state file", async () => {
    const s1 = [user("t1", 30), reply("r1", 29), user("t2", 20, fromParent("jam_A")), reply("r2", 19)];
    const capy = createFakeCapy({
      threads: [thread("jam_A", { status: "waiting" })],
      messages: { jam_A: [user("a1", 40)] },
      subagents: { jam_A: [sub("s1", "jam_A", { status: "working", usage: {} })] },
      subagentMessages: { s1 },
    });
    expect((await run(capy)).code).toBe(0);
    expect(keys()).toEqual(["alphaclaw:capy:jam_A:sub:s1:" + s1[0].id]);
    Object.assign(capy.subagents.jam_A[0], { status: "done", lastActivityAt: at(4) });
    clock += 60 * 1000;
    expect((await run(capy)).code).toBe(0);
    expect(keys()).toEqual(["alphaclaw:capy:jam_A:sub:s1:" + s1[0].id, "alphaclaw:capy:jam_A:sub:s1:" + s1[2].id]);
    fs.rmSync(statePath);
    const again = await run(capy);
    expect(again.code).toBe(0);
    expect(keys().slice(2)).toEqual(["alphaclaw:capy:jam_A:sub:s1:" + s1[0].id, "alphaclaw:capy:jam_A:sub:s1:" + s1[2].id]);
    expect(fake.runs.size).toBe(2);
    expect(again.lines.join("\n")).not.toContain("row_dropped");
  });

  it("watches with a pass every 60 s until its minutes are up, sends a turn within a minute of its end and releases the lease", async () => {
    const a = [user("a1", 30), reply("r1", 29)];
    const capy = createFakeCapy({ threads: [thread("jam_A")], messages: { jam_A: a } });
    const watched = onPass(capy, (pass) => {
      if (pass !== 2) return;
      a.push(user("a2", -0.5), reply("r2", -0.9));
      capy.threads[0].lastActivityAt = new Date(clock - 100).toISOString();
    });
    const result = await run(watched, {}, { watchMinutes: 3 });
    expect(result.code).toBe(0);
    expect(capy.requests.filter((request) => request.route === "/projects")).toHaveLength(3);
    expect(sleeps).toEqual([60000, 60000]);
    expect(result.lines.filter((line) => /capy_pass .* pages=\d+ rate_limited=0$/.test(line))).toHaveLength(3);
    expect(keys()).toEqual(["alphaclaw:capy:jam_A:" + a[0].id, "alphaclaw:capy:jam_A:" + a[2].id]);
    expect(runByKey("alphaclaw:capy:jam_A:" + a[2].id).startedAt).toBe(kNow + 60000);
    expect(fs.existsSync(leasePath())).toBe(false);
    expect(fake.requests.filter((request) => request.path === "/capabilities")).toHaveLength(1);
  });

  it("exits 0 with watch_skipped and reads nothing while another run's lease is live", async () => {
    const lease = { holder: "other-run", renewed_at: at(1), expires_at: at(-2) };
    fs.writeFileSync(leasePath(), JSON.stringify(lease));
    const capy = createFakeCapy({ threads: [thread("jam_A")], messages: { jam_A: [user("a1", 30), reply("r1", 29)] } });
    const result = await run(capy, {}, { watchMinutes: 55 });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("watch_skipped holder=other-run age=60s");
    expect(capy.requests).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(leasePath(), "utf8"))).toEqual(lease);
    expect((await run(capy)).code).toBe(0);
    expect(capy.requests).toHaveLength(0);
  });

  it("refuses a --watch that is not a number of minutes, reading nothing", async () => {
    const capy = createFakeCapy({ threads: [thread("jam_A")], messages: { jam_A: [user("a1", 30), reply("r1", 29)] } });
    const result = await run(capy, {}, { watchMinutes: "abc" });
    expect(result.code).toBe(2);
    expect(result.lines.join("\n")).toContain("config_invalid op=capy fix=--watch takes minutes from 1 to 1440");
    expect(capy.requests).toHaveLength(0);
    expect(fs.existsSync(leasePath())).toBe(false);
  });

  it("takes over a lease past its expiry with watch_takeover", async () => {
    fs.writeFileSync(leasePath(), JSON.stringify({ holder: "other-run", renewed_at: at(4), expires_at: at(1) }));
    const capy = createFakeCapy({ threads: [thread("jam_A")], messages: { jam_A: [user("a1", 30), reply("r1", 29)] } });
    const result = await run(capy, {}, { watchMinutes: 1 });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("watch_takeover holder=other-run age=240s");
    expect(fake.runs.size).toBe(1);
    expect(fs.existsSync(leasePath())).toBe(false);
  });

  it("merges the state file on write, keeping another writer's cursors", async () => {
    const capy = createFakeCapy({ threads: [thread("jam_A")], messages: { jam_A: [user("a1", 30), reply("r1", 29)] } });
    const other = { activity: at(50), status: "idle", after: "E-OTHER", reported: [], since: at(60), credits: null };
    const writer = {
      ...capy,
      fetchImpl: async (url, init) => {
        if (new URL(url).pathname.endsWith("/threads") && !fs.existsSync(statePath)) fs.writeFileSync(statePath, JSON.stringify({ version: 1, threads: { jam_OTHER: other }, agents: {}, rows: [] }));
        return capy.fetchImpl(url, init);
      },
    };
    expect((await run(writer)).code).toBe(0);
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(saved.threads.jam_OTHER).toEqual(other);
    expect(saved.threads.jam_A.status).toBe("idle");
    expect(fake.runs.size).toBe(1);
  });

  it("honours a Capy 429's retry-after in watch mode and stretches the next interval", async () => {
    const capy = createFakeCapy({ threads: [thread("jam_A")], messages: { jam_A: [user("a1", 30), reply("r1", 29)] } });
    capy.state.rateLimit = 1;
    const result = await run(capy, {}, { watchMinutes: 3 });
    expect(result.code).toBe(0);
    expect(sleeps).toEqual([3000, 60000, 57000]);
    expect(result.lines.join("\n")).toContain("watch_slowed op=capy interval=120s rate_limited=1");
    expect(result.lines.filter((line) => line.includes("capy_pass"))).toHaveLength(2);
    expect(result.lines.find((line) => line.includes("capy_pass"))).toContain("rate_limited=1");
    expect(fake.runs.size).toBe(1);
  });

  it("starts no working turn early while AgentRun does not advertise sdk_runs", async () => {
    const capy = createFakeCapy({ threads: [thread("jam_W", { status: "working" })], messages: { jam_W: [user("w1", 30), reply("rw1", 29)] } });
    expect((await run(capy, {}, { watchMinutes: 3 })).code).toBe(0);
    expect(fake.requests.filter((request) => request.path === "/capabilities")).toHaveLength(1);
    expect(starts()).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).rows).toEqual([]);
    expect((await run(capy)).code).toBe(0);
    expect(fake.requests.filter((request) => request.path === "/capabilities")).toHaveLength(1);
  });

  it("starts a working turn at once when AgentRun advertises sdk_runs, sends a heartbeat every 10 minutes and finishes the same run", async () => {
    fake.state.capabilities = { features: { sdk_runs: true } };
    const w = [user("w1", 0), reply("rw1", -0.5), tool("bash", -0.6)];
    const capy = createFakeCapy({ threads: [thread("jam_W", { status: "working", lastActivityAt: at(0) })], messages: { jam_W: w } });
    const watched = onPass(capy, (pass) => {
      if (pass === 12) Object.assign(capy.threads[0], { status: "idle", lastActivityAt: at(-10.5) });
    });
    expect((await run(watched, {}, { watchMinutes: 12 })).code).toBe(0);
    expect(fake.runs.size).toBe(1);
    const [item] = [...fake.runs.values()];
    expect(item.startedAt).toBe(kNow);
    expect(item.start).toMatchObject({ started_at: at(0), title: "Title jam_W", labels: ["source:capy", "class:thread"] });
    expect(item.start.input).toMatch(/^Title jam_W · working — started .*; Capy thread turn in thread jam_W\.$/);
    expect(item.batches[0]).toEqual({ sequence: 1, events: [] });
    expect(item.batches.slice(1).flatMap((batch) => batch.events).map((event) => event.type)).toEqual(["session", "tool", "tool"]);
    expect(item.completion).toMatchObject({ status: "completed", session_id: "jam_W" });
    expect(fake.requests.filter((request) => request.path === "/capabilities")).toHaveLength(1);
    expect(keys().every((key) => key === "alphaclaw:capy:jam_W:" + w[0].id)).toBe(true);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).rows).toEqual([]);
  });

  it("never reopens a reported turn as live when its thread wakes with no new message", async () => {
    fake.state.capabilities = { features: { sdk_runs: true } };
    const w = [user("w1", 30), reply("rw1", 29)];
    const capy = createFakeCapy({ threads: [thread("jam_W")], messages: { jam_W: w } });
    const watched = onPass(capy, (pass) => {
      if (pass === 2) Object.assign(capy.threads[0], { status: "working", lastActivityAt: at(-0.5) });
      if (pass === 3) Object.assign(capy.threads[0], { status: "idle", lastActivityAt: at(-1.5) });
    });
    const result = await run(watched, {}, { watchMinutes: 3 });
    expect(result.code).toBe(0);
    expect(keys()).toEqual(["alphaclaw:capy:jam_W:" + w[0].id]);
    expect([...fake.runs.values()][0].completion).toMatchObject({ status: "completed" });
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).rows).toEqual([]);
  });

  it("drops a live turn whose thread turns private before it finishes, and sends nothing more for it", async () => {
    fake.state.capabilities = { features: { sdk_runs: true } };
    const capy = createFakeCapy({ threads: [thread("jam_W", { status: "working", lastActivityAt: at(0) })], messages: { jam_W: [user("w1", 0), reply("rw1", -0.5)] } });
    const watched = onPass(capy, (pass) => {
      if (pass === 2) Object.assign(capy.threads[0], { visibility: "private", lastActivityAt: at(-0.7) });
    });
    const result = await run(watched, {}, { watchMinutes: 3 });
    expect(result.lines.join("\n")).toContain("content_revoked op=capy count=1");
    expect(fake.runs.size).toBe(1);
    const [item] = [...fake.runs.values()];
    expect(item.batches).toEqual([]);
    expect(item.completion).toBeNull();
    expect(starts()).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).rows).toEqual([]);
  });

  it("drops a live start AgentRun refuses instead of resending it every loop", async () => {
    fake.state.capabilities = { features: { sdk_runs: true } };
    fake.state.failNext.push({ path: /\/sdk-runs$/, status: 422, body: { error: { code: "input_invalid", message: "bad start" } } });
    const capy = createFakeCapy({ threads: [thread("jam_W", { status: "working", lastActivityAt: at(0) })], messages: { jam_W: [user("w1", 0), reply("rw1", -0.5)] } });
    const result = await run(capy, {}, { watchMinutes: 3 });
    expect(result.lines.join("\n")).toContain("row_dropped op=start source=capy code=input_invalid");
    expect(starts()).toHaveLength(1);
    expect(fake.runs.size).toBe(0);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).rows).toEqual([]);
  });

  it("exits non-zero with one line naming what is missing, never a value", () => {
    const result = spawnSync(process.execPath, [kScript, "--state", path.join(dir, "state.json")], {
      env: { PATH: process.env.PATH, AGENTRUN_CAPY_REPORTER_TOKEN: "tok-VALUE-123" },
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("config_missing op=capy fix=set CAPY_REPORTER_API_KEY, AGENTRUN_BASE_URL");
    expect(result.stderr).not.toContain("tok-VALUE-123");
    expect(fs.existsSync(path.join(dir, "state.json"))).toBe(false);
  });
});
