const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  createGatewayDowntimeNote,
  buildDowntimeNoteText,
  isServingObservation,
  causeFromRestartSource,
  kDowntimeNoteThresholdMs,
} = require("../../lib/server/gateway-downtime-note");

const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-downtime-note-"));
let dirSeq = 0;
const makeStampPath = () => path.join(fs.mkdtempSync(path.join(kTempRoot, `case-${(dirSeq += 1)}-`)), "gateway-last-serving.json");

afterAll(() => {
  fs.rmSync(kTempRoot, { recursive: true, force: true });
});

const kT0 = Date.parse("2026-10-25T13:52:00Z");
const ready = { ok: true, kind: "ready", status: "started", unreadyReason: null };
const starting = { ok: true, kind: "not_ready", status: "starting", unreadyReason: "starting" };
const draining = { ok: true, kind: "not_ready", status: "draining", unreadyReason: "draining" };
const down = { ok: false, kind: "unavailable" };

const makeNote = ({ stampPath = makeStampPath(), clock = { value: kT0 }, probes = [ready], clawResult = { ok: true, stdout: "{}" }, ...rest } = {}) => {
  const queue = [...probes];
  const probeReadiness = vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0]));
  const clawCmd = vi.fn(async () => (typeof clawResult === "function" ? clawResult() : clawResult));
  const insertEvent = vi.fn();
  const note = createGatewayDowntimeNote({
    clawCmd,
    stampPath,
    insertEvent,
    resolveReadyzUrl: () => "http://127.0.0.1:18789/readyz",
    probeReadiness,
    sleep: async (ms) => {
      clock.value += ms;
    },
    now: () => clock.value,
    readyTimeoutMs: 60_000,
    restartBudgetMs: 600_000,
    ...rest,
  });
  const setProbes = (next) => {
    queue.splice(0, queue.length, ...next);
  };
  return { note, clawCmd, insertEvent, probeReadiness, setProbes, stampPath, clock };
};

// Brings a fresh instance to "serving, no episode open" at clock.value.
const bootServing = async (ctx) => {
  ctx.setProbes([ready]);
  await ctx.note.onGatewayLaunch({ generation: 1 });
  ctx.clawCmd.mockClear();
  ctx.insertEvent.mockClear();
};

const decodeShellWords = (cmd) =>
  execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${cmd}`], { encoding: "utf8" }).split("\n").slice(0, -1);

describe("server/gateway-downtime-note", () => {
  let logs;
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats one short note with the duration, the UTC window and the cause", () => {
    expect(buildDowntimeNoteText({ downAtMs: kT0, readyAtMs: kT0 + 11 * 60_000 + 40_000, cause: "crash" })).toBe(
      "The gateway was down for 12 min (13:52–14:03 UTC) after a crash; messages queued during that time may be stale, and their timestamps show when they were sent.",
    );
    expect(buildDowntimeNoteText({ downAtMs: Date.parse("2026-10-24T23:10:00Z"), readyAtMs: Date.parse("2026-10-25T01:40:00Z") })).toBe(
      "The gateway was down for 2 h 30 min (2026-10-24 23:10 – 2026-10-25 01:40 UTC); messages queued during that time may be stale, and their timestamps show when they were sent.",
    );
    expect(buildDowntimeNoteText({
      downAtMs: kT0,
      readyAtMs: kT0 + 5 * 60_000,
      cause: "repair",
      restarts: ["watchdog:repair_replace", "api:restart", "api:restart"],
      launches: 4,
      doctor: { source: "medic", status: "failed" },
    })).toBe(
      "The gateway was down for 5 min (13:52–13:57 UTC) during a watchdog repair; messages queued during that time may be stale, and their timestamps show when they were sent. AlphaClaw ran during it: 3 restarts (watchdog:repair_replace, api:restart), 4 gateway launches, Doctor --fix (medic, failed).",
    );
  });

  it("maps restart sources to causes and treats a failing channel as serving, starting and draining as not", () => {
    expect(causeFromRestartSource("api:restart")).toBe("restart");
    expect(causeFromRestartSource("channels:create")).toBe("restart");
    expect(causeFromRestartSource("watchdog:repair_replace")).toBe("repair");
    expect(causeFromRestartSource("watchdog:memory_mitigation")).toBe("memory");
    expect(causeFromRestartSource(null)).toBe("restart");
    expect(isServingObservation(ready)).toBe(true);
    expect(isServingObservation({ ok: true, kind: "not_ready", status: null, unreadyReason: "components" })).toBe(true);
    expect(isServingObservation(starting)).toBe(false);
    expect(isServingObservation(draining)).toBe(false);
    expect(isServingObservation({ ok: true, kind: "not_ready", status: null, unreadyReason: "explicit" })).toBe(false);
    expect(isServingObservation(down)).toBe(false);
  });

  it("a crash that kept the gateway down past the threshold sends one system event through the CLI once the relaunch serves", async () => {
    const ctx = makeNote();
    await bootServing(ctx);
    ctx.clock.value += 30_000;
    await ctx.note.tick();
    const crashedAt = ctx.clock.value + 5_000;
    ctx.clock.value = crashedAt;
    ctx.note.onGatewayExit({ code: 1, signal: null, expectedExit: false, generation: 1 });

    ctx.clock.value += 10 * 60_000;
    ctx.setProbes([down, starting, starting, ready]);
    const result = await ctx.note.onGatewayLaunch({ generation: 2 });

    const downMs = ctx.clock.value - crashedAt;
    expect(result).toEqual({ sent: true, downMs, cause: "crash" });
    expect(ctx.clawCmd).toHaveBeenCalledTimes(1);
    const [cmd, opts] = ctx.clawCmd.mock.calls[0];
    expect(opts).toEqual({ quiet: true, timeoutMs: 20_000 });
    const text = buildDowntimeNoteText({ downAtMs: crashedAt, readyAtMs: ctx.clock.value, cause: "crash" });
    expect(text).toMatch(/^The gateway was down for 10 min \(13:5\d–14:0\d UTC\) after a crash; messages queued during that time may be stale, and their timestamps show when they were sent\.$/);
    expect(decodeShellWords(cmd)).toEqual(["system", "event", "--text", text, "--mode", "next-heartbeat", "--json"]);
    expect(logs).toEqual([`[alphaclaw] downtime-note sent down_ms=${downMs} cause=crash restarts=0 launches=1 doctor=no generation=2`]);
    expect(ctx.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "downtime_note",
      status: "sent",
      details: expect.objectContaining({ downMs, cause: "crash", generation: 2 }),
    }));
  });

  it("a routine restart that came back quickly sends nothing", async () => {
    const ctx = makeNote();
    await bootServing(ctx);
    ctx.clock.value += 10 * 60_000;
    await ctx.note.tick();
    ctx.note.onRestartRequested({ opId: "op1", source: "api:restart" });
    ctx.note.onGatewayExit({ expectedExit: true, generation: 1 });
    ctx.clock.value += 40_000;
    ctx.setProbes([starting, ready]);
    const result = await ctx.note.onGatewayLaunch({ generation: 2 });
    expect(result).toEqual({ sent: false, downMs: 41_000 });
    expect(ctx.clawCmd).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("a restart whose drain and relaunch took longer than the threshold is noted as a restart; a watchdog repair as a repair", async () => {
    const ctx = makeNote();
    await bootServing(ctx);
    await ctx.note.tick();
    const requestedAt = ctx.clock.value;
    ctx.note.onRestartRequested({ source: "api:restart" });
    ctx.clock.value += 3 * 60_000;
    const restart = await ctx.note.onGatewayLaunch({ generation: 2 });
    expect(restart).toEqual({ sent: true, downMs: ctx.clock.value - requestedAt, cause: "restart" });
    expect(decodeShellWords(ctx.clawCmd.mock.calls[0][0])[3]).toMatch(/^The gateway was down for 3 min \(.+ UTC\) during a restart; .+ AlphaClaw ran during it: 1 restart \(api:restart\)\.$/);

    await ctx.note.tick();
    ctx.note.onRestartRequested({ source: "watchdog:repair_replace" });
    ctx.clock.value += 5 * 60_000;
    const repair = await ctx.note.onGatewayLaunch({ generation: 3 });
    expect(repair.cause).toBe("repair");
    expect(decodeShellWords(ctx.clawCmd.mock.calls[1][0])[3]).toContain(" during a watchdog repair; ");
  });

  it("measures from the last serving probe when the gateway stopped answering before the repair", async () => {
    const ctx = makeNote();
    await bootServing(ctx);
    await ctx.note.tick();
    const lastServing = ctx.clock.value;
    ctx.setProbes([down]);
    ctx.clock.value += 30_000;
    await ctx.note.tick();
    ctx.clock.value += 30_000;
    await ctx.note.tick();
    ctx.clock.value += 60_000;
    ctx.note.onRestartRequested({ source: "watchdog:repair_replace" });
    ctx.clock.value += 30_000;
    ctx.setProbes([ready]);
    const result = await ctx.note.onGatewayLaunch({ generation: 2 });
    expect(result).toEqual({ sent: true, downMs: ctx.clock.value - lastServing, cause: "repair" });
  });

  it("notes once per episode: a crash loop of several launches, the duplicate launch notice and later ticks send one note", async () => {
    const ctx = makeNote();
    await bootServing(ctx);
    await ctx.note.tick();
    ctx.note.onGatewayExit({ expectedExit: false, generation: 1 });
    for (const generation of [2, 3, 4]) {
      ctx.setProbes([down]);
      ctx.clock.value += 60_000;
      const failed = ctx.note.onGatewayLaunch({ generation });
      ctx.note.onGatewayExit({ expectedExit: false, generation });
      expect(await failed).toEqual({ skipped: "not_ready" });
    }
    ctx.setProbes([ready]);
    const first = ctx.note.onGatewayLaunch({ generation: 5 });
    const second = ctx.note.onGatewayLaunch({ generation: 5 });
    expect(second).toBe(first);
    expect((await first).sent).toBe(true);
    await ctx.note.tick();
    ctx.clock.value += 30_000;
    await ctx.note.tick();
    expect(await ctx.note.onGatewayLaunch({ generation: 6 })).toEqual({ skipped: "no_episode" });
    expect(ctx.clawCmd).toHaveBeenCalledTimes(1);
  });

  it("ignores an expected exit and a late exit from an older generation", async () => {
    const ctx = makeNote();
    await bootServing(ctx);
    await ctx.note.onGatewayLaunch({ generation: 2 });
    ctx.note.onGatewayExit({ expectedExit: true, generation: 2 });
    ctx.note.onGatewayExit({ expectedExit: false, generation: 1 });
    ctx.clock.value += 10 * 60_000;
    await ctx.note.tick();
    expect(JSON.parse(fs.readFileSync(ctx.stampPath, "utf8"))).toEqual({ lastServingAt: ctx.clock.value, cause: null, restarts: [], launches: 0 });
    expect(ctx.clawCmd).not.toHaveBeenCalled();
  });

  it("does not settle on the old gateway's answers between the restart request and the new launch", async () => {
    const ctx = makeNote();
    await bootServing(ctx);
    await ctx.note.tick();
    const requestedAt = ctx.clock.value;
    ctx.note.onRestartRequested({ source: "api:restart" });
    ctx.clock.value += 60_000;
    expect(await ctx.note.tick()).toBeNull();
    ctx.setProbes([draining]);
    ctx.clock.value += 90_000;
    expect(await ctx.note.tick()).toBeNull();
    ctx.setProbes([ready]);
    const result = await ctx.note.onGatewayLaunch({ generation: 2 });
    expect(result).toEqual({ sent: true, downMs: ctx.clock.value - requestedAt, cause: "restart" });
  });

  it("a restart that never launched (the old gateway kept serving) is dropped silently after the restart budget", async () => {
    const ctx = makeNote();
    await bootServing(ctx);
    await ctx.note.tick();
    ctx.note.onRestartRequested({ source: "api:restart" });
    ctx.clock.value += 601_000;
    await ctx.note.tick();
    expect(logs).toEqual(["[alphaclaw] downtime-note dropped reason=no_launch cause=restart"]);
    expect(await ctx.note.onGatewayLaunch({ generation: 2 })).toEqual({ skipped: "no_episode" });
    expect(ctx.clawCmd).not.toHaveBeenCalled();
  });

  it("a boot slower than the ready budget is noted by the next stamp tick", async () => {
    const ctx = makeNote();
    await bootServing(ctx);
    await ctx.note.tick();
    ctx.note.onGatewayExit({ expectedExit: false, generation: 1 });
    ctx.setProbes([starting]);
    expect(await ctx.note.onGatewayLaunch({ generation: 2 })).toEqual({ skipped: "not_ready" });
    ctx.clock.value += 120_000;
    expect(await ctx.note.tick()).toBeNull();
    ctx.setProbes([ready]);
    const result = await ctx.note.tick();
    expect(result).toEqual(expect.objectContaining({ sent: true, cause: "crash" }));
    expect(ctx.clawCmd).toHaveBeenCalledTimes(1);
  });

  it("survives an AlphaClaw restart: the next process measures from the persisted stamp and carries the crash cause", async () => {
    const stampPath = makeStampPath();
    const first = makeNote({ stampPath });
    await bootServing(first);
    await first.note.tick();
    const crashedAt = first.clock.value + 20_000;
    first.clock.value = crashedAt;
    first.note.onGatewayExit({ expectedExit: false, generation: 1 });
    expect(JSON.parse(fs.readFileSync(stampPath, "utf8"))).toEqual({ lastServingAt: crashedAt, cause: "crash", restarts: [], launches: 0 });

    const second = makeNote({ stampPath, clock: { value: crashedAt + 15 * 60_000 } });
    const result = await second.note.onGatewayLaunch({ generation: 1 });
    expect(result).toEqual({ sent: true, downMs: 15 * 60_000, cause: "crash" });
    expect(decodeShellWords(second.clawCmd.mock.calls[0][0])[3]).toContain("down for 15 min (13:52–14:07 UTC) after a crash;");

    const third = makeNote({ stampPath, clock: { value: second.clock.value + 30_000 } });
    expect(await third.note.onGatewayLaunch({ generation: 1 })).toEqual({ sent: false, downMs: 30_000 });
    expect(third.clawCmd).not.toHaveBeenCalled();
  });

  it("names what AlphaClaw ran during the episode: the restart sources, every launch of a crash loop, and a Doctor run inside the window only", async () => {
    const stampPath = makeStampPath();
    const doctorRuns = [];
    const first = makeNote({ stampPath, readLastDoctorRun: () => doctorRuns[doctorRuns.length - 1] ?? null });
    await bootServing(first);
    doctorRuns.push({ source: "boot", status: "ok", at: first.clock.value - 60_000 });
    await first.note.tick();
    const crashedAt = first.clock.value;
    first.note.onGatewayExit({ expectedExit: false, generation: 1 });
    for (const generation of [2, 3]) {
      first.setProbes([down]);
      first.clock.value += 30_000;
      await first.note.onGatewayLaunch({ generation });
      first.note.onGatewayExit({ expectedExit: false, generation });
    }
    first.note.onRestartRequested({ source: "watchdog:repair_replace" });
    expect(JSON.parse(fs.readFileSync(stampPath, "utf8"))).toEqual({
      lastServingAt: crashedAt,
      cause: "crash",
      restarts: ["watchdog:repair_replace"],
      launches: 2,
    });

    const clock = { value: first.clock.value + 2 * 60_000 };
    doctorRuns.push({ source: "medic", status: "ok", at: clock.value - 30_000 });
    const second = makeNote({ stampPath, clock, readLastDoctorRun: () => doctorRuns[doctorRuns.length - 1] });
    const result = await second.note.onGatewayLaunch({ generation: 1 });
    expect(result).toEqual(expect.objectContaining({ sent: true, cause: "crash" }));
    expect(decodeShellWords(second.clawCmd.mock.calls[0][0])[3]).toMatch(
      / after a crash; .+ AlphaClaw ran during it: 1 restart \(watchdog:repair_replace\), 3 gateway launches, Doctor --fix \(medic, ok\)\.$/,
    );
    expect(second.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ restarts: ["watchdog:repair_replace"], launches: 3, doctor: { source: "medic", status: "ok" } }),
    }));

    await second.note.tick();
    second.note.onGatewayExit({ expectedExit: false, generation: 1 });
    second.clock.value += 5 * 60_000;
    await second.note.onGatewayLaunch({ generation: 2 });
    expect(decodeShellWords(second.clawCmd.mock.calls[1][0])[3]).not.toContain("AlphaClaw ran during it");
  });

  it("a server restart with no recorded cause says how long without a cause, and a fresh install says nothing", async () => {
    const stampPath = makeStampPath();
    const first = makeNote({ stampPath });
    await bootServing(first);
    await first.note.tick();
    const lastServing = first.clock.value;

    const second = makeNote({ stampPath, clock: { value: lastServing + 4 * 60_000 } });
    await second.note.onGatewayLaunch({ generation: 1 });
    expect(decodeShellWords(second.clawCmd.mock.calls[0][0])[3]).toBe(
      "The gateway was down for 4 min (13:52–13:56 UTC); messages queued during that time may be stale, and their timestamps show when they were sent.",
    );

    const fresh = makeNote();
    expect(await fresh.note.onGatewayLaunch({ generation: 1 })).toEqual({ sent: false, downMs: null });
    expect(fresh.clawCmd).not.toHaveBeenCalled();
  });

  it("an unreadable stamp file reads as no history", async () => {
    const stampPath = makeStampPath();
    fs.writeFileSync(stampPath, "{not json");
    const ctx = makeNote({ stampPath });
    expect(await ctx.note.onGatewayLaunch({ generation: 1 })).toEqual({ sent: false, downMs: null });
    expect(JSON.parse(fs.readFileSync(stampPath, "utf8")).lastServingAt).toBe(ctx.clock.value);
  });

  it("a failed or throwing send logs one line with the duration only and never retries", async () => {
    for (const clawResult of [
      { ok: false, code: 1, stdout: "", stderr: "gateway closed (1006)" },
      () => {
        throw new Error("spawn failed");
      },
    ]) {
      logs.length = 0;
      const ctx = makeNote({ clawResult });
      await bootServing(ctx);
      await ctx.note.tick();
      ctx.note.onGatewayExit({ expectedExit: false, generation: 1 });
      ctx.clock.value += kDowntimeNoteThresholdMs + 1_000;
      const result = await ctx.note.onGatewayLaunch({ generation: 2 });
      expect(result).toEqual(expect.objectContaining({ sent: false, cause: "crash" }));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^\[alphaclaw\] downtime-note send failed down_ms=\d+ cause=crash restarts=0 launches=1 doctor=no generation=2 exit=/);
      expect(logs[0]).not.toContain("stale");
      expect(logs[0]).not.toContain("gateway closed");
      expect(ctx.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "downtime_note", status: "failed" }));
      await ctx.note.tick();
      expect(ctx.clawCmd).toHaveBeenCalledTimes(1);
    }
  });
});
