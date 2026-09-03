const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// Real-process e2e for installCrashGuards(): the in-process suite
// (tests/server/server-lifecycle.test.js) intentionally never calls
// installCrashGuards because removeAllListeners() would clobber vitest's own
// handlers. Here each scenario runs in a REAL child node process that builds
// a real lifecycle around a real http.Server, installs the guards, and then
// suffers a real unhandled rejection / rejection storm / uncaught exception /
// SIGTERM — proving the actual process.on wiring, drain ordering, and exit
// codes end to end.
const kLifecyclePath = path.join(
  __dirname,
  "..",
  "..",
  "lib",
  "server",
  "init",
  "server-lifecycle.js",
);

// Markers use fs.writeSync(1, ...) in the fixture: console.log to a pipe is
// async on POSIX, so lines written just before process.exit could be lost.
const buildFixtureSource = () => `
const http = require("http");
const fs = require("fs");
const { createServerLifecycle } = require(${JSON.stringify(kLifecyclePath)});

const scenario = process.argv[2];
const out = (line) => {
  try {
    fs.writeSync(1, String(line) + "\\n");
  } catch {}
};
const logger = { log: out, warn: out, error: out };

const server = http.createServer((_req, res) => {
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain");
  res.end("ok");
});

const lifecycle = createServerLifecycle({
  server,
  PORT: 0,
  isOnboarded: () => false,
  stopWatchdog: () => out("MARK watchdog-stop"),
  stopGateway: async () => out("MARK gateway-stop"),
  killGatewayNow: () => out("MARK kill-gateway-now"),
  disposeServices: () => out("MARK service-dispose"),
  flushLogs: () => out("MARK log-flush"),
  logger,
});

lifecycle.installCrashGuards();

server.on("listening", () => {
  out("CHILD_PORT=" + server.address().port);
  if (scenario === "rejection") {
    setTimeout(() => {
      Promise.reject(new Error("boom-single-rejection"));
    }, 25);
  } else if (scenario === "storm") {
    setTimeout(() => {
      // Default threshold is 50 within a 5-minute window; 55 real rejections
      // trip the storm brake with margin, and the post-trip stragglers
      // exercise the log-only-while-exiting guard.
      for (let i = 0; i < 55; i += 1) {
        Promise.reject(new Error("boom-storm-" + i));
      }
    }, 25);
  } else if (scenario === "uncaught") {
    setTimeout(() => {
      throw new Error("boom-uncaught-exception");
    }, 25);
  }
  // scenario === "sigterm": idle until the parent sends the real signal.
});

lifecycle.startListening();
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const httpGet = (port, reqPath = "/health") =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, timeout: 2000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });

const markerLines = (stdout) =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("MARK "))
    .map((line) => line.slice("MARK ".length).trim());

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

describe("server lifecycle crash guards (real child process)", () => {
  let tmpDir = null;
  let fixturePath = null;
  const children = [];

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-crash-guards-"));
    fixturePath = path.join(tmpDir, "crash-guard-fixture.js");
    fs.writeFileSync(fixturePath, buildFixtureSource());
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    while (children.length > 0) {
      const record = children.pop();
      if (record.child.exitCode === null && record.child.signalCode === null) {
        record.child.kill("SIGKILL");
      }
      await record.exited;
    }
  });

  const startChild = (scenario) => {
    const child = spawn(process.execPath, [fixturePath, scenario], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = { child, stdout: "", stderr: "", exit: null };
    child.stdout.on("data", (chunk) => {
      record.stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      record.stderr += chunk;
    });
    record.exited = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        record.exit = { code, signal };
        resolve(record.exit);
      });
    });
    children.push(record);
    return record;
  };

  const debugContext = (record) =>
    `\n--- child stdout ---\n${record.stdout}\n--- child stderr ---\n${record.stderr}`;

  const waitForStdout = async (record, predicate, label, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate(record.stdout);
      if (value) return value;
      if (record.exit !== null && !predicate(record.stdout)) {
        throw new Error(
          `child exited (${JSON.stringify(record.exit)}) before ${label}${debugContext(record)}`,
        );
      }
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${label}${debugContext(record)}`);
  };

  const waitForPort = async (record) => {
    const match = await waitForStdout(
      record,
      (stdout) => /CHILD_PORT=(\d+)/.exec(stdout),
      "child port line",
    );
    return Number(match[1]);
  };

  const waitForExit = async (record, timeoutMs = 8000) => {
    const result = await Promise.race([
      record.exited,
      sleep(timeoutMs).then(() => "timeout"),
    ]);
    if (result === "timeout") {
      record.child.kill("SIGKILL");
      await record.exited;
      throw new Error(`child did not exit within ${timeoutMs}ms${debugContext(record)}`);
    }
    return result;
  };

  it("survives a single unhandled rejection: logs it and keeps serving", async () => {
    const record = startChild("rejection");
    const port = await waitForPort(record);

    await waitForStdout(
      record,
      (stdout) =>
        stdout.includes("Unhandled rejection (continuing)") &&
        stdout.includes("boom-single-rejection"),
      "unhandled rejection log line",
    );

    // The process must still be alive and answering on the real socket —
    // the real process.on('unhandledRejection') handler swallowed the event
    // instead of letting Node's default (throw) kill the process.
    const response = await httpGet(port);
    expect(response.status).toBe(200);
    expect(response.body).toBe("ok");
    expect(record.exit).toBeNull();
    // No drain ran: a single rejection must never trigger a shutdown.
    expect(markerLines(record.stdout)).toEqual([]);
  });

  it("exits 1 through the full drain on an unhandled rejection storm", async () => {
    const record = startChild("storm");
    await waitForPort(record);

    const exit = await waitForExit(record);
    expect(exit).toEqual({ code: 1, signal: null });

    expect(record.stdout).toContain("Shutting down: unhandled rejection storm");
    // Every rejection is logged, including the post-trip stragglers that hit
    // the log-only-while-exiting guard instead of re-entering gracefulExit.
    expect(
      countOccurrences(record.stdout, "Unhandled rejection (continuing)"),
    ).toBeGreaterThanOrEqual(50);
    expect(markerLines(record.stdout)).toEqual([
      "watchdog-stop",
      "gateway-stop",
      "service-dispose",
      "log-flush",
    ]);
    // A clean single drain never takes the reentrancy/deadline escape hatch.
    expect(record.stdout).not.toContain("kill-gateway-now");
  });

  it("exits 1 through the full drain on an uncaught exception", async () => {
    const record = startChild("uncaught");
    await waitForPort(record);

    const exit = await waitForExit(record);
    expect(exit).toEqual({ code: 1, signal: null });

    expect(record.stdout).toContain("Uncaught exception");
    expect(record.stdout).toContain("boom-uncaught-exception");
    expect(record.stdout).toContain("Shutting down: uncaught exception");
    expect(markerLines(record.stdout)).toEqual([
      "watchdog-stop",
      "gateway-stop",
      "service-dispose",
      "log-flush",
    ]);
    expect(record.stdout).not.toContain("kill-gateway-now");
  });

  it("exits 0 through the full drain on a real SIGTERM", async () => {
    const record = startChild("sigterm");
    await waitForPort(record);
    expect(record.stdout).toContain("Express listening");

    record.child.kill("SIGTERM");
    const exit = await waitForExit(record);
    // code 0 / signal null proves the installed handler ran process.exit(0);
    // the default SIGTERM disposition would report { code: null,
    // signal: 'SIGTERM' } instead.
    expect(exit).toEqual({ code: 0, signal: null });

    expect(record.stdout).toContain("Shutting down: SIGTERM");
    expect(markerLines(record.stdout)).toEqual([
      "watchdog-stop",
      "gateway-stop",
      "service-dispose",
      "log-flush",
    ]);
    expect(record.stdout).not.toContain("kill-gateway-now");
  });
});
