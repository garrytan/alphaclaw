const fs = require("fs");
const os = require("os");
const path = require("path");

const { createRunStream } = require("../../lib/server/openclaw-run-stream");

const kNodeBin = "node";
const kTwoMegabytes = 2 * 1024 * 1024;

const runNodeScript = (script, overrides = {}) => {
  const runStream = createRunStream();
  return runStream.runStreamed({
    command: kNodeBin,
    args: ["-e", script, ...(overrides.extraArgs || [])],
    ...overrides.options,
  });
};

describe("server/openclaw-run-stream", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-run-stream-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("survives >2MB of stdout and keeps only the tail in memory", async () => {
    const logFile = path.join(tempDir, "big-output.log");
    const script = [
      'process.stdout.write("FIRST-MARKER-LINE\\n");',
      'const line = "x".repeat(1023) + "\\n";',
      "for (let i = 0; i < 2100; i += 1) process.stdout.write(line);",
      'process.stdout.write("FINAL-MARKER-LINE\\n");',
    ].join("\n");

    const result = await runNodeScript(script, { options: { logFile } });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.logFile).toBe(logFile);
    expect(result.tail).toContain("FINAL-MARKER-LINE");
    expect(result.tail).not.toContain("FIRST-MARKER-LINE");
    expect(result.tail.length).toBeLessThanOrEqual(64 * 1024);
    expect(fs.statSync(logFile).size).toBeGreaterThan(kTwoMegabytes);
  });

  it("calls onOutput with chunks for both stdout and stderr", async () => {
    const chunks = [];
    const script =
      'process.stdout.write("out-chunk-data");' +
      'process.stderr.write("err-chunk-data");';

    const result = await runNodeScript(script, {
      options: {
        onOutput: (chunk, streamName) => chunks.push({ chunk, streamName }),
      },
    });

    expect(result.ok).toBe(true);
    const streamNames = new Set(chunks.map((entry) => entry.streamName));
    expect(streamNames.has("stdout")).toBe(true);
    expect(streamNames.has("stderr")).toBe(true);
    const textFor = (streamName) =>
      chunks
        .filter((entry) => entry.streamName === streamName)
        .map((entry) => entry.chunk)
        .join("");
    expect(textFor("stdout")).toContain("out-chunk-data");
    expect(textFor("stderr")).toContain("err-chunk-data");
  });

  it("escalates SIGTERM to SIGKILL when the child ignores SIGTERM", async () => {
    // timeoutMs is generous so even a slow CI node startup installs the
    // SIGTERM handler before SIGTERM lands; the readiness marker in the tail
    // proves the handler was in place when the escalation ran.
    const script =
      'process.on("SIGTERM", () => {});' +
      "setInterval(() => {}, 1000);" +
      'process.stdout.write("sigterm-handler-ready\\n");';
    const startedAt = Date.now();

    const result = await runNodeScript(script, {
      options: { timeoutMs: 2000, killGraceMs: 400 },
    });

    expect(result.tail).toContain("sigterm-handler-ready");
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.killed).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(result.durationMs).toBeLessThan(5000);
  });

  it("honors a raised tailBytes budget beyond the 64KB default", async () => {
    const runner = createRunStream({});
    const result = await runner.runStreamed({
      command: "node",
      args: [
        "-e",
        'process.stdout.write("y".repeat(100 * 1024) + "END");',
      ],
      timeoutMs: 15_000,
      tailBytes: 256 * 1024,
    });
    expect(result.ok).toBe(true);
    // Full 100KB survives (default 64KB budget would have truncated it).
    expect(result.tail.length).toBeGreaterThan(100 * 1024);
    expect(result.tail.endsWith("END")).toBe(true);
  });

  it("propagates non-zero exit codes", async () => {
    const result = await runNodeScript("process.exit(3);");

    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.killed).toBe(false);
  });

  it("reports ok for a clean exit 0", async () => {
    const result = await runNodeScript("process.exit(0);");

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.signal).toBe(null);
    expect(result.timedOut).toBe(false);
    expect(typeof result.durationMs).toBe("number");
  });

  it("passes args verbatim without shell interpretation", async () => {
    const injectionArg = '; echo INJECTED';
    const script = "console.log(JSON.stringify(process.argv.slice(1)));";

    const result = await runNodeScript(script, {
      extraArgs: [injectionArg],
    });

    expect(result.ok).toBe(true);
    // The whole arg arrives as a single argv element, uninterpreted.
    expect(JSON.parse(result.tail.trim())).toEqual([injectionArg]);
    expect(result.tail).toContain(JSON.stringify([injectionArg]));
    // Nothing named INJECTED ran: no bare INJECTED line in the output.
    const lines = result.tail.split("\n").map((line) => line.trim());
    expect(lines).not.toContain("INJECTED");
  });

  it("resolves (not rejects) with an error when the binary does not exist", async () => {
    const runStream = createRunStream();

    const result = await runStream.runStreamed({
      command: "definitely-not-a-real-binary-xyz",
      args: ["--whatever"],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(null);
    expect(result.signal).toBe(null);
    expect(result.timedOut).toBe(false);
    expect(result.killed).toBe(false);
    expect(result.error).toContain("ENOENT");
  });

  it("creates missing parent directories for the log file", async () => {
    const logFile = path.join(tempDir, "does-not-exist", "nested", "run.log");

    const result = await runNodeScript(
      'process.stdout.write("nested-log-line\\n");',
      { options: { logFile } },
    );

    expect(result.ok).toBe(true);
    expect(result.logFile).toBe(logFile);
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.readFileSync(logFile, "utf8")).toContain("nested-log-line");
  });
});

// v0.9.81 (cross-model D15): the inactivity policy. A child that neither
// prints nor moves the progress probe for `inactivityTimeoutMs` is stopped like
// a timeout, but the result says `stalled`, not `timedOut`.
describe("server/openclaw-run-stream inactivity policy", () => {
  // Keeps the event loop alive without printing; exits on its own after `ms`.
  const silentFor = (ms) => `setTimeout(() => process.exit(0), ${ms});`;

  it("kills a silent child after the window and reports stalled (not timedOut)", async () => {
    const started = Date.now();
    const result = await runNodeScript(silentFor(10_000), {
      options: { inactivityTimeoutMs: 200, killGraceMs: 500 },
    });
    expect(result.ok).toBe(false);
    expect(result.stalled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.killed).toBe(true);
    expect(result.signal).toBe("SIGTERM");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("output chunks reset the window: a child that keeps talking is never cut", async () => {
    const script = [
      "let n = 0;",
      "const t = setInterval(() => { process.stdout.write('tick ' + n + '\\n'); n += 1; if (n >= 8) { clearInterval(t); process.exit(0); } }, 60);",
    ].join("\n");
    const result = await runNodeScript(script, { options: { inactivityTimeoutMs: 250 } });
    expect(result.ok).toBe(true);
    expect(result.stalled).toBe(false);
    expect(result.tail).toContain("tick 7");
  });

  it("a changing progressProbe value resets the window (a silent-but-writing child lives); once it stops changing the stall fires", async () => {
    const started = Date.now();
    let calls = 0;
    // Grows for ~600 ms of polls, then freezes.
    const probe = () => (Date.now() - started < 600 ? (calls += 1) : 999_999);
    const result = await runNodeScript(silentFor(10_000), {
      options: { inactivityTimeoutMs: 200, killGraceMs: 500, progressProbe: probe },
    });
    expect(result.stalled).toBe(true);
    expect(result.timedOut).toBe(false);
    // Lived through the growing phase: the kill came after it, not at 200 ms.
    expect(result.durationMs).toBeGreaterThanOrEqual(600);
    expect(calls).toBeGreaterThan(1);
  });

  it("a constant probe plus silence is a stall; a throwing probe counts as no change (never breaks the run)", async () => {
    const constant = await runNodeScript(silentFor(10_000), {
      options: { inactivityTimeoutMs: 150, killGraceMs: 500, progressProbe: () => 42 },
    });
    expect(constant.stalled).toBe(true);
    const throwing = await runNodeScript(silentFor(10_000), {
      options: {
        inactivityTimeoutMs: 150,
        killGraceMs: 500,
        progressProbe: () => {
          throw new Error("probe broke");
        },
      },
    });
    expect(throwing.stalled).toBe(true);
    expect(throwing.error).toBeUndefined();
  });

  it("inactivityTimeoutMs: 0 (the default) turns the policy off — a silent child runs to its own exit", async () => {
    const result = await runNodeScript(silentFor(300), { options: { inactivityTimeoutMs: 0 } });
    expect(result.ok).toBe(true);
    expect(result.stalled).toBe(false);
    const implicit = await runNodeScript(silentFor(300));
    expect(implicit.ok).toBe(true);
    expect(implicit.stalled).toBe(false);
  });

  it("the hard ceiling still wins when it is the smaller bound: timedOut, not stalled", async () => {
    const result = await runNodeScript(silentFor(10_000), {
      options: { timeoutMs: 150, inactivityTimeoutMs: 5_000, killGraceMs: 500 },
    });
    expect(result.timedOut).toBe(true);
    expect(result.stalled).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("a stall escalates SIGTERM → SIGKILL after killGraceMs when the child ignores SIGTERM", async () => {
    const script = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 20000);";
    const started = Date.now();
    const result = await runNodeScript(script, {
      options: { inactivityTimeoutMs: 150, killGraceMs: 200 },
    });
    expect(result.stalled).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
