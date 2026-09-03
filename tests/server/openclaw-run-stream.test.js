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
