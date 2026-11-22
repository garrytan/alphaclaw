const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { createFixProbes, normalizeFixProbesConfig, nextDailyAt } = require("../../lib/server/fix-probes");
const kinds = require("../../lib/server/fix-probes/kinds");
const { classifyLongReply } = require("../../lib/server/relay/bridge");
const { openBridgeStore } = require("../../lib/server/relay/bridge-store");
const webhooksDb = require("../../lib/server/db/webhooks");

// GST-3436: fix probes prove on the live box that a fix is still in. Every
// fixture here is synthetic.
const kNow = Date.parse("2026-11-22T12:00:00.000Z");
const kMarker = "fixMarkerUniqueName";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "fix-probes-"));
const logLine = (text, at) => JSON.stringify({ 0: text, time: new Date(at).toISOString() });

const setup = ({ probes = [], extra = {} } = {}) => {
  const root = tempRoot();
  const openclawDir = path.join(root, ".openclaw");
  const workspaceDir = path.join(openclawDir, "workspace");
  const logDir = path.join(root, "logs");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const config = { probes, ...extra };
  const notify = vi.fn(async () => ({ ok: true }));
  const insertEvent = vi.fn();
  let now = kNow;
  const timers = [];
  const deps = {
    openclawDir,
    workspaceDir,
    readConfig: () => config,
    readLogFile: () => path.join(logDir, "openclaw.log"),
    summarizeHookDeliveries: vi.fn(() => ({ signed2xx: 3, admittedUnsigned: 0, rejected: 0, failed: 0, rowCount: 3, oldestAt: "2026-11-01T00:00:00.000Z" })),
    readRelayLongReplies: vi.fn(() => ({ seen: 1, whole: 1, cut: 0 })),
    notify,
    insertEvent,
    nowFn: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    logger: { log() {}, warn() {} },
  };
  return {
    root,
    openclawDir,
    workspaceDir,
    logDir,
    config,
    notify,
    insertEvent,
    timers,
    deps,
    setNow: (value) => {
      now = value;
    },
    writeLog: (lines) => fs.writeFileSync(path.join(logDir, "openclaw.log"), lines.join("\n") + "\n"),
    probes: () => createFixProbes(deps),
  };
};

const pushState = (ctx, summary) => {
  fs.mkdirSync(path.join(ctx.openclawDir, ".alphaclaw"), { recursive: true });
  fs.writeFileSync(path.join(ctx.openclawDir, ".alphaclaw", "git-push-checks.json"), JSON.stringify({ checkouts: {}, summary }));
};

const kPushSummary = { finishedAt: new Date(kNow - 5 * 60_000).toISOString(), listed: 2, listedProbed: 2, listedWriteOk: 2, discovered: 4, discoveredProbed: 1, discoveredWriteOk: 1, problems: 0, untold: 0 };

describe("fix probes config", () => {
  it("runs valid probes and lists invalid ones with the field and a fix line", () => {
    const workspaceDir = "/srv/ws";
    const { probes, invalid, dailyAtUtc, fileRoots } = normalizeFixProbesConfig({
      dailyAtUtc: "07:30",
      fileRoots: ["/srv/plugins", "relative/not-allowed"],
      probes: [
        { name: "push", issue: "GST-1", kind: "push_checks", expect: { maxAgeMinutes: 30 } },
        { name: "push", issue: "GST-2", kind: "push_checks", expect: { maxAgeMinutes: 30 } },
        { name: "writer", issue: "GST-3", kind: "push_checks", allowWrite: true, expect: { maxAgeMinutes: 30 } },
        { name: "silent-log", issue: "GST-4", kind: "log_count", match: ["refused x"], expect: { max: 0 } },
        { name: "long-window", issue: "GST-5", kind: "log_count", match: ["refused x"], windowHours: 48, expect: { max: 0, liveness: "plugin up" } },
        { name: "outside", issue: "GST-6", kind: "file_check", file: "/etc/passwd", expect: { maxChars: 10 } },
        { name: "plugin-file", issue: "GST-7", kind: "file_check", file: "/srv/plugins/guard.js", expect: { containsAll: [kMarker] } },
        { name: "bad issue", issue: "nope", kind: "push_checks" },
        { name: "short-marker", issue: "GST-8", kind: "file_check", file: "/srv/ws/AGENTS.md", expect: { containsAll: ["short"] } },
        { name: "hook", issue: "GST-9", kind: "webhook_deliveries", hook: "verkada", expect: {} },
        { name: "unknown", issue: "GST-10", kind: "gateway_ready" },
      ],
    }, { workspaceDir });
    expect(dailyAtUtc).toBe("07:30");
    expect(fileRoots).toEqual(["/srv/ws", "/srv/plugins"]);
    expect(probes.map((probe) => probe.name)).toEqual(["push", "plugin-file"]);
    const byIndex = Object.fromEntries(invalid.map((entry) => [entry.index, entry]));
    expect(byIndex[1]).toMatchObject({ code: "fix_probe_invalid", field: "name" });
    expect(byIndex[2]).toMatchObject({ field: "allowWrite" });
    expect(byIndex[3]).toMatchObject({ field: "expect.liveness" });
    expect(byIndex[3].fix).toContain("silent log is not read as a pass");
    expect(byIndex[4]).toMatchObject({ field: "windowHours" });
    expect(byIndex[5]).toMatchObject({ field: "file" });
    expect(byIndex[7]).toMatchObject({ field: "name" });
    expect(byIndex[8]).toMatchObject({ field: "expect.containsAll" });
    expect(byIndex[9]).toMatchObject({ field: "expect" });
    expect(byIndex[10]).toMatchObject({ field: "kind" });
  });

  it("schedules the daily run at the next UTC time", () => {
    expect(new Date(nextDailyAt("15:00", kNow)).toISOString()).toBe("2026-11-22T15:00:00.000Z");
    expect(new Date(nextDailyAt("09:00", kNow)).toISOString()).toBe("2026-11-23T09:00:00.000Z");
  });
});

describe("fix probe kinds", () => {
  const logProbe = (expect) => ({ name: "refusals", issue: "GST-1", kind: "log_count", match: ["guard refused", "staged-inbound"], windowHours: 24, expect: { sourceMin: 1, liveness: "guard decision", ...expect } });

  it("log_count counts matching lines in the window and is no_coverage when the liveness line is missing", () => {
    const ctx = setup();
    ctx.writeLog([
      logLine("guard decision allow", kNow - 3_600_000),
      logLine("guard refused path staged-inbound/a", kNow - 2 * 3_600_000),
      logLine("guard refused path staged-inbound/b", kNow - 30 * 3_600_000),
      logLine("guard refused path other", kNow - 3_600_000),
      "not json and no time: guard refused staged-inbound",
    ]);
    const logFile = path.join(ctx.logDir, "openclaw.log");
    const probe = logProbe({ max: 0 });
    const { counts } = kinds.scanLogs({ probes: [probe], logFile, nowMs: kNow });
    expect(counts[0]).toEqual({ matches: 1, liveness: 1 });
    const result = kinds.judgeLogCount(probe, counts[0]);
    expect(result).toMatchObject({ ok: false, code: "above_max", expected: { kind: "max", limit: 0, found: 1 } });
    expect(JSON.stringify(result)).not.toContain("staged-inbound");
    expect(kinds.judgeLogCount(probe, { matches: 0, liveness: 0 })).toMatchObject({ ok: false, code: "no_coverage" });
    expect(kinds.judgeLogCount(probe, { matches: 0, liveness: 4 })).toMatchObject({ ok: true, code: "ok" });
  });

  it("webhook_deliveries never counts a delivery AlphaClaw refused as unsigned or failed, and needs the window retained", () => {
    const root = tempRoot();
    webhooksDb.initWebhooksDb({ rootDir: root });
    try {
      const add = (authMethod, gatewayStatus) => webhooksDb.insertRequest({ hookName: "cameras", method: "POST", headers: {}, payload: "{}", payloadSize: 2, sourceIp: "", gatewayStatus, gatewayBody: "", authMethod });
      add("signed", 200);
      add("signed", 200);
      add("rejected:signature", 401);
      add("rejected:missing_signature", 401);
      add("signed", 502);
      add("shared_token", 200);
      const summary = webhooksDb.summarizeHookDeliveries({ hookName: "cameras", sinceIso: "2000-01-01T00:00:00.000Z" });
      expect(summary).toMatchObject({ signed2xx: 2, admittedUnsigned: 1, rejected: 2, failed: 1, rowCount: 6 });
      const probe = { name: "cameras", issue: "GST-2", kind: "webhook_deliveries", hook: "cameras", windowHours: 72, expect: { minSigned2xx: 1, maxAdmittedUnsigned: 0, maxFailed: 3 } };
      const windowStart = new Date(kNow - 72 * 3_600_000).toISOString();
      expect(kinds.judgeWebhookDeliveries(probe, { ...summary, windowStart }, { minRowsNeverTrimmed: 25 })).toMatchObject({ ok: false, code: "admitted_unsigned" });
      const clean = { ...summary, admittedUnsigned: 0 };
      expect(kinds.judgeWebhookDeliveries(probe, { ...clean, windowStart }, { minRowsNeverTrimmed: 25 })).toMatchObject({ ok: true });
      const trimmed = { ...clean, rowCount: 500, oldestAt: new Date(kNow - 3_600_000).toISOString(), windowStart };
      expect(kinds.judgeWebhookDeliveries(probe, trimmed, { minRowsNeverTrimmed: 25 })).toMatchObject({ ok: false, code: "no_coverage" });
    } finally {
      webhooksDb.closeWebhooksDb();
    }
  });

  it("push_checks reads the checker's liveness and coverage, never its verdicts", () => {
    const probe = { name: "push", issue: "GST-3", kind: "push_checks", expect: { maxAgeMinutes: 30, minListedProbed: 2, maxUntold: 0 } };
    expect(kinds.judgePushChecks(probe, kPushSummary, kNow)).toMatchObject({ ok: true });
    expect(kinds.judgePushChecks(probe, { ...kPushSummary, problems: 3 }, kNow)).toMatchObject({ ok: true });
    expect(kinds.judgePushChecks(probe, { ...kPushSummary, finishedAt: new Date(kNow - 3 * 3_600_000).toISOString() }, kNow)).toMatchObject({ code: "checker_stale" });
    expect(kinds.judgePushChecks(probe, { ...kPushSummary, listedProbed: 1 }, kNow)).toMatchObject({ code: "write_path_unprobed" });
    expect(kinds.judgePushChecks(probe, { ...kPushSummary, untold: 1 }, kNow)).toMatchObject({ code: "problems_untold" });
    expect(kinds.judgePushChecks(probe, null, kNow)).toMatchObject({ code: "no_coverage" });
  });

  it("file_check reads only regular files inside allowed roots and refuses protected files before opening them", () => {
    const root = tempRoot();
    const ws = path.join(root, "workspace");
    const plugins = path.join(root, "plugins");
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(path.join(plugins, "guard"), { recursive: true });
    fs.writeFileSync(path.join(plugins, "guard", "index.js"), "const " + kMarker + " = true;\n");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "x".repeat(300));
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=abc\n");
    fs.writeFileSync(path.join(ws, "auth-profiles.json"), "{}");
    fs.writeFileSync(path.join(ws, "openclaw.json"), "{}");
    fs.symlinkSync(path.join(root, ".env"), path.join(ws, "notes.md"));
    fs.writeFileSync(path.join(ws, "big.md"), Buffer.alloc(3 * 1024 * 1024, 97));
    execFileSync("mkfifo", [path.join(ws, "pipe.md")]);
    const roots = [ws, plugins];
    const check = (file, expect) => kinds.runFileCheck({ name: "f", issue: "GST-4", kind: "file_check", file, expect }, { roots });
    expect(check(path.join(plugins, "guard", "index.js"), { containsAll: [kMarker] })).toMatchObject({ ok: true, observed: { markersFound: 1 } });
    expect(check(path.join(plugins, "guard", "index.js"), { containsAll: ["anotherMarkerName"] })).toMatchObject({ ok: false, code: "marker_missing" });
    expect(check(path.join(ws, "AGENTS.md"), { maxChars: 200 })).toMatchObject({ ok: false, code: "above_max_chars", observed: { chars: 300 } });
    expect(check(path.join(ws, "AGENTS.md"), { maxChars: 400 })).toMatchObject({ ok: true });
    expect(check(path.join(ws, "missing.md"), { maxChars: 400 })).toMatchObject({ ok: false, code: "file_missing" });
    for (const name of ["auth-profiles.json", "openclaw.json", "notes.md", "big.md", "pipe.md"]) {
      const result = check(path.join(ws, name), { maxChars: 10 });
      expect(result, name).toMatchObject({ ok: false, code: "file_refused" });
      expect(JSON.stringify(result)).not.toContain("TOKEN");
    }
    expect(kinds.resolveCheckedFile({ file: path.join(root, ".env"), roots })).toEqual({ refused: "outside_roots" });
    expect(JSON.stringify(check(path.join(plugins, "guard", "index.js"), { containsAll: [kMarker] }))).not.toContain(kMarker);
  });

  it("relay_long_replies counts cut answers by outcome, and is not checked with the relay off", () => {
    expect(classifyLongReply({ text: "x".repeat(7000), wholeRead: false })).toBeNull();
    expect(classifyLongReply({ text: "x".repeat(8000) + "\n...(truncated)...", wholeRead: false })).toBe("cut");
    expect(classifyLongReply({ text: "x".repeat(8050), wholeRead: false })).toBe("cut");
    expect(classifyLongReply({ text: "x".repeat(8050), wholeRead: true })).toBe("whole");
    expect(classifyLongReply({ text: "x".repeat(20000), wholeRead: false })).toBe("whole");
    const root = tempRoot();
    let now = kNow;
    const store = openBridgeStore({ dbPath: path.join(root, "bridge.db"), now: () => now });
    try {
      store.bumpLongReply("whole");
      store.bumpLongReply("cut");
      now = kNow - 10 * 86_400_000;
      store.bumpLongReply("cut");
      now = kNow;
      store.bumpLongReply("whole");
      expect(store.readLongReplies({ days: 7, nowMs: kNow })).toEqual({ seen: 3, whole: 2, cut: 1 });
      expect(store.getMeta("long_replies:" + new Date(kNow - 10 * 86_400_000).toISOString().slice(0, 10))).toBeNull();
    } finally {
      store.close();
    }
    const probe = { name: "relay", issue: "GST-5", kind: "relay_long_replies", windowDays: 7, expect: { maxCut: 0 } };
    expect(kinds.judgeRelayLongReplies(probe, { seen: 3, whole: 2, cut: 1 })).toMatchObject({ ok: false, code: "replies_cut" });
    expect(kinds.judgeRelayLongReplies(probe, { seen: 0, whole: 0, cut: 0 })).toMatchObject({ ok: true });
    expect(kinds.judgeRelayLongReplies(probe, null)).toMatchObject({ ok: true, code: "not_checked" });
    expect(kinds.judgeRelayLongReplies(probe, undefined)).toMatchObject({ ok: false, code: "probe_error" });
  });
});

describe("fix probe runner", () => {
  const probesFor = (ctx) => [
    { name: "push-alive", issue: "GST-11", kind: "push_checks", expect: { maxAgeMinutes: 30, minListedProbed: 2 } },
    { name: "refusals", issue: "GST-12", kind: "log_count", match: ["guard refused", "staged-inbound"], expect: { max: 0, liveness: "guard decision" } },
    { name: "fix-loaded", issue: "GST-12", kind: "file_check", file: path.join(ctx.workspaceDir, "guard.js"), expect: { containsAll: [kMarker] } },
    { name: "relay", issue: "GST-13", kind: "relay_long_replies", expect: { maxCut: 0 } },
  ];

  const healthy = (ctx) => {
    pushState(ctx, kPushSummary);
    ctx.writeLog([logLine("guard decision allow", kNow - 3_600_000)]);
    fs.writeFileSync(path.join(ctx.workspaceDir, "guard.js"), "const " + kMarker + " = 1;\n");
  };

  it("sends one day-one summary of issue codes and states only, then tells the owner once per cause and once when it clears", async () => {
    const ctx = setup();
    ctx.config.probes = probesFor(ctx);
    healthy(ctx);
    ctx.deps.readRelayLongReplies.mockReturnValue({ seen: 2, whole: 1, cut: 1 });
    const probes = ctx.probes();
    const first = await probes.runNow();
    expect(first.status).toBe(200);
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    const summary = ctx.notify.mock.calls[0][0];
    expect(summary).toBe("🔎 Fix checks now watching: GST-11 passing, GST-12 passing, GST-13 failing.");
    expect(summary).not.toMatch(/\d+ (deliveries|lines|replies)/);

    // A failure covered by the day-one summary is not sent again.
    ctx.setNow(kNow + 2 * 60_000);
    await probes.runNow();
    expect(ctx.notify).toHaveBeenCalledTimes(1);

    // A new cause: the log shows a refusal again.
    ctx.writeLog([logLine("guard decision allow", kNow), logLine("guard refused staged-inbound/a", kNow)]);
    ctx.setNow(kNow + 4 * 60_000);
    await probes.runNow();
    expect(ctx.notify).toHaveBeenCalledTimes(2);
    const alert = ctx.notify.mock.calls[1][0];
    expect(alert).toContain("Fix check failing: refusals (GST-12)");
    expect(alert).toContain("found 1");
    expect(alert).toContain("alphaclaw admin POST /api/fix-probes/run");
    expect(alert).not.toContain("staged-inbound");
    ctx.setNow(kNow + 6 * 60_000);
    await probes.runNow();
    expect(ctx.notify).toHaveBeenCalledTimes(2);

    ctx.writeLog([logLine("guard decision allow", kNow)]);
    ctx.deps.readRelayLongReplies.mockReturnValue({ seen: 2, whole: 2, cut: 0 });
    ctx.setNow(kNow + 8 * 60_000);
    await probes.runNow();
    expect(ctx.notify.mock.calls.slice(2).map((call) => call[0]).sort()).toEqual([
      "✅ Fix check passing again: refusals (GST-12).",
      "✅ Fix check passing again: relay (GST-13).",
    ]);

    // A threshold edit keeps the watched set, so no new summary.
    ctx.config.probes[1].expect.max = 2;
    ctx.setNow(kNow + 10 * 60_000);
    await probes.runNow();
    expect(ctx.notify).toHaveBeenCalledTimes(4);
  });

  it("reports a dead source as no data, never a pass, and keeps substrings, markers and paths out of status and events", async () => {
    const ctx = setup();
    ctx.config.probes = probesFor(ctx);
    healthy(ctx);
    ctx.writeLog([logLine("unrelated line", kNow - 3_600_000)]);
    const probes = ctx.probes();
    await probes.runNow();
    expect(ctx.notify.mock.calls[0][0]).toContain("GST-12 no data");
    const status = probes.getStatus();
    expect(status.probes.find((probe) => probe.name === "refusals")).toMatchObject({ state: "no data", code: "no_coverage" });
    const text = JSON.stringify([status, ctx.insertEvent.mock.calls, fs.readFileSync(path.join(ctx.openclawDir, ".alphaclaw", "fix-probes.json"), "utf8")]);
    for (const secret of [kMarker, "guard refused", "staged-inbound", "guard decision", ctx.workspaceDir]) expect(text).not.toContain(secret);
    expect(ctx.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "fix_probe", source: "fix-probes", details: expect.objectContaining({ states: expect.any(Object) }) }));
  });

  it("retries a failed summary next run, and alerts on its own once the summary goes through", async () => {
    const ctx = setup();
    ctx.config.probes = [probesFor(ctx)[0]];
    pushState(ctx, { ...kPushSummary, listedProbed: 0 });
    ctx.notify.mockImplementationOnce(async () => ({ ok: false, reason: "telegram down" }));
    const probes = ctx.probes();
    await probes.runNow();
    ctx.setNow(kNow + 2 * 60_000);
    await probes.runNow();
    const messages = ctx.notify.mock.calls.map((call) => call[0]);
    expect(messages[0]).toContain("Fix checks now watching");
    expect(messages.slice(1).some((message) => message.startsWith("🔎 Fix checks now watching: GST-11 failing"))).toBe(true);
  });

  it("runs one at a time, at most once a minute on demand", async () => {
    const ctx = setup();
    ctx.config.probes = [{ name: "relay", issue: "GST-13", kind: "relay_long_replies", expect: { maxCut: 0 } }];
    let release;
    ctx.deps.readRelayLongReplies.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ seen: 0, whole: 0, cut: 0 });
    }));
    const probes = ctx.probes();
    const first = probes.runNow();
    await new Promise((resolve) => setImmediate(resolve));
    const busy = await probes.runNow();
    expect(busy).toMatchObject({ status: 409, body: { error: "fix_probe_run_in_progress" } });
    expect(busy.body.runId).toMatch(/^fp_/);
    release();
    expect((await first).status).toBe(200);
    const limited = await probes.runNow();
    expect(limited).toMatchObject({ status: 429, retryAfterSeconds: 60, body: { error: "fix_probe_rate_limited" } });
  });

  it("first runs 10 minutes after the gateway is ready, or 20 minutes after start when it never is, then daily", async () => {
    const ctx = setup();
    ctx.config.probes = [{ name: "relay", issue: "GST-13", kind: "relay_long_replies", expect: { maxCut: 0 } }];
    const probes = ctx.probes();
    probes.start();
    expect(ctx.timers.map((timer) => timer.ms)).toEqual([20 * 60_000]);
    probes.onGatewayReady();
    expect(ctx.timers.map((timer) => timer.ms)).toEqual([10 * 60_000]);
    await ctx.timers.shift().fn();
    expect(ctx.deps.readRelayLongReplies).toHaveBeenCalledTimes(1);
    expect(ctx.timers.map((timer) => timer.ms)).toEqual([3 * 3_600_000]);
    expect(probes.getStatus().nextRunAt).toBe("2026-11-22T15:00:00.000Z");
  });
});
