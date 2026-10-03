const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// Shared plumbing for the LIVE e2e tiers (tests/live/**). These suites drive
// the REAL pinned OpenClaw (package.json dependencies.openclaw, installed in
// node_modules) and, for a few, a real browser, docker or an external
// service: their job is to scream when a pin bump drifts away from the
// assumptions the hermetic suites encode (CLI flags, JSON contracts, dist
// layout, gateway boot). They are excluded from `npm test` via
// vitest.config.js and run through `npm run test:live`.

const kLiveEnabled = process.env.OPENCLAW_LIVE_E2E === "1";

const kSilentLogger = { log() {}, warn() {}, error() {} };

// TEMP-DIR HYGIENE (incident 2026-09-02: 46 GB of /tmp debris in one
// afternoon from the since-removed version-switching tiers). Every temp root
// this tier creates is tracked here and swept:
//
//   1. in an `afterAll` registered on the test file's root suite — the
//      PRIMARY path. Vitest 4's forks pool tears a worker down with
//      `fork.kill()` (SIGTERM, then SIGKILL 500 ms later — ForksPoolWorker
//      .stop()), and Node's default SIGTERM disposition terminates WITHOUT
//      emitting `exit`, so a `process.on("exit")` sweep alone never ran on a
//      completed file. afterAll runs before that teardown, on pass AND fail
//      (also after a failed beforeAll);
//   2. on SIGTERM/SIGINT/SIGHUP — best effort inside the 500 ms SIGKILL
//      window for a cancelled run (Ctrl-C, orchestrator abort);
//   3. at `exit` — for the plain-node / `process.exit()` paths.
const kCreatedTempDirs = [];

// Register a directory this process created for the sweep (idempotent).
const trackTempDir = (dir) => {
  if (dir && !kCreatedTempDirs.includes(dir)) kCreatedTempDirs.push(dir);
  return dir;
};

// Remove every tracked directory now. Synchronous and best-effort: a dir that
// is already gone (cleanup() ran, or the staging rename moved it into the
// cache) is a no-op, and one failure never blocks the rest. Returns the
// number of directories that still existed and were removed.
const sweepLiveTempDirs = () => {
  let removed = 0;
  while (kCreatedTempDirs.length > 0) {
    const dir = kCreatedTempDirs.pop();
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
        removed += 1;
      }
    } catch {}
  }
  return removed;
};

process.once("exit", () => {
  sweepLiveTempDirs();
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  try {
    process.once(signal, () => {
      sweepLiveTempDirs();
      process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGHUP" ? 1 : 15));
    });
  } catch {}
}
// Vitest exposes the hooks as globals (vitest.config.js `globals: true`);
// registering here attaches the sweep to whichever live file required us,
// after that file's own afterAll hooks (stack order), so a suite that kills
// its spawned server/gateway in afterAll does so before its root vanishes.
if (typeof globalThis.afterAll === "function") {
  globalThis.afterAll(() => {
    sweepLiveTempDirs();
  }, 5 * 60 * 1000);
}

const mkTemp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return trackTempDir(dir);
};

// The repo's own pinned OpenClaw CLI — the build production runs.
const repoOpenclawBin = () => {
  const bin = path.resolve(__dirname, "../../node_modules/.bin/openclaw");
  if (!fs.existsSync(bin)) {
    throw new Error(
      `pinned openclaw CLI not found at ${bin} — run npm install first`,
    );
  }
  return bin;
};

const repoBinDir = () => path.resolve(__dirname, "../../node_modules/.bin");

// The pinned CLI enforces its Node engines at runtime (the vitest process may
// satisfy AlphaClaw's floor but not OpenClaw's). Suites that boot the REAL
// gateway preflight it so an incompatible runner skips loudly instead of
// failing on a boot timeout. Shared by dashboard-launch and control-ui-styles.
const openclawCliUsable = () => {
  try {
    const res = spawnSync(process.execPath, [repoOpenclawBin(), "--version"], {
      encoding: "utf8",
      timeout: 60_000,
      env: scrubTestRunnerEnv(),
    });
    return res.status === 0;
  } catch {
    return false;
  }
};

// Env for spawning the REAL openclaw CLI (or a real AlphaClaw server that
// spawns it) from inside vitest. Verified against openclaw 2026.9.1-beta.1:
// the CLI treats an inherited `VITEST` variable as "running under a test
// runner" and suppresses its stdout entirely (`approvals get --json` exits 0
// with zero bytes), and vitest's NODE_OPTIONS loader flags perturb child
// startup. Scrub both so the child runs like a normal CLI invocation.
const scrubTestRunnerEnv = (base = process.env) => {
  const env = { ...base };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST")) delete env[key];
  }
  return env;
};

// `<cli> ... --json` contract (fix wave F222/F115): stdout must be EXACTLY one
// JSON document. The old `JSON.parse(String(execFileSync(...)))` swallowed the
// two ways upstream drift shows up — a banner/log line before the document
// (parse error with no context) and an EMPTY stdout (the beta silences stdout
// when it inherits `VITEST`) — and could never tell them apart from a broken
// contract. This parser names the failure and quotes the evidence.
const kStdoutQuoteBytes = 600;
const kStderrQuoteBytes = 1200;
const quoteHead = (text, bytes) => {
  const value = String(text || "");
  return value.length > bytes ? `${value.slice(0, bytes)}…(+${value.length - bytes} more)` : value;
};
const quoteTail = (text, bytes) => {
  const value = String(text || "");
  return value.length > bytes ? `…(${value.length - bytes} earlier)${value.slice(-bytes)}` : value;
};
const countJsonDocuments = (text) => {
  // Cheap diagnosis only (never used to pick a "winner"): how many
  // whitespace-separated lines parse as JSON on their own.
  let count = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      JSON.parse(trimmed);
      count += 1;
    } catch {}
  }
  return count;
};
const parseSingleJsonDocument = (stdout, { label = "cli", stderr = "" } = {}) => {
  const raw = String(stdout ?? "");
  const trimmed = raw.trim();
  const evidence = () =>
    `stdout(${raw.length}B): ${JSON.stringify(quoteHead(raw, kStdoutQuoteBytes))}` +
    (stderr ? `\nstderr: ${JSON.stringify(quoteTail(stderr, kStderrQuoteBytes))}` : "");
  if (!trimmed) {
    throw new Error(
      `${label}: expected exactly one JSON document on stdout but stdout was EMPTY ` +
        `(a CLI that inherits VITEST/NODE_OPTIONS silences itself — spawn through scrubTestRunnerEnv()).\n${evidence()}`,
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const documents = countJsonDocuments(trimmed);
    const shape =
      documents >= 2
        ? `${documents} JSON documents (the CLI printed more than one object)`
        : documents === 1
          ? "a JSON document surrounded by non-JSON text (a banner or log line leaked onto stdout)"
          : "no parseable JSON document";
    throw new Error(
      `${label}: stdout is not a single JSON document — found ${shape}: ${error?.message || error}.\n${evidence()}`,
    );
  }
};

// Spawn `node <bin> ...args` with stdout and stderr captured SEPARATELY, the
// test-runner env scrubbed, and the stdout held to the single-document
// contract above. A non-zero exit fails with the command, status/signal and
// the stderr tail — never a bare parse error.
// `env` is the caller's base env (defaults to the process env INSIDE
// scrubTestRunnerEnv — never spread raw here; live-tier-conventions.test.js
// scans for that).
const runCliJson = (bin, args, { env = undefined, input = null, timeoutMs = 120_000, label = "openclaw" } = {}) => {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: scrubTestRunnerEnv(env),
    ...(input === null ? {} : { input }),
  });
  const command = `${label}: node ${path.basename(String(bin))} ${args.join(" ")}`;
  if (result.error) {
    throw new Error(`${command} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${result.status === null ? `on signal ${result.signal}` : `with status ${result.status}`}.\n` +
        `stderr: ${JSON.stringify(quoteTail(result.stderr, kStderrQuoteBytes))}\n` +
        `stdout: ${JSON.stringify(quoteHead(result.stdout, kStdoutQuoteBytes))}`,
    );
  }
  return parseSingleJsonDocument(result.stdout, { label: command, stderr: result.stderr });
};

const waitFor = async (predicate, timeoutMs, label = "condition") => {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
};

const readDeclaredPin = () =>
  JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
  ).dependencies.openclaw;

module.exports = {
  kLiveEnabled,
  kSilentLogger,
  readDeclaredPin,
  mkTemp,
  repoOpenclawBin,
  repoBinDir,
  openclawCliUsable,
  scrubTestRunnerEnv,
  parseSingleJsonDocument,
  runCliJson,
  waitFor,
};
