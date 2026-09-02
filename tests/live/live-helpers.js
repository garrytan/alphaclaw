const fs = require("fs");
const os = require("os");
const path = require("path");

// Shared plumbing for the LIVE e2e tiers (tests/live/**). These suites talk to
// the real npm registry and the real GitHub API on purpose: their job is to
// scream when upstream reality drifts away from the assumptions the hermetic
// suites encode (dist-tag shape, prerelease naming, engines, updater JSON,
// dist layout). They are excluded from `npm test` via vitest.config.js and run
// through `npm run test:live` / `npm run test:live:dev`.

const kLiveEnabled = process.env.OPENCLAW_LIVE_E2E === "1";
const kLiveDevEnabled = process.env.OPENCLAW_LIVE_E2E_DEV === "1";

const kSilentLogger = { log() {}, warn() {}, error() {} };

// Every temp dir is swept at process exit: one live run stages multiple GBs
// (overlay stores, npm caches, a dev checkout) and on tmpfs /tmp that is RAM.
const kCreatedTempDirs = [];
process.once("exit", () => {
  for (const dir of kCreatedTempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

const mkTemp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  kCreatedTempDirs.push(dir);
  return dir;
};

// Real fetch, wrapped so tests can assert HOW MANY network calls happened
// (cache honoring, offline-boot invariants) without faking any of them.
const createCountingFetch = () => {
  const calls = [];
  const fetchImpl = (url, options) => {
    calls.push(String(url));
    return global.fetch(url, options);
  };
  return { fetchImpl, calls };
};

// The repo's own pinned OpenClaw CLI — the dev tier drives the real updater
// through it, exactly like production does.
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

const waitFor = async (predicate, timeoutMs, label = "condition") => {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
};

const kVersionShape = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const kFullShaShape = /^[0-9a-f]{40}$/;

// The three upstream lines the #54 hardening was verified against (tarballs
// unpacked and read; see the plan's §2). The pin comes from package.json —
// the other two are the exact versions issue #54 downgraded between. Bump
// deliberately: every contract below is stamped against these.
const readDeclaredPin = () =>
  JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
  ).dependencies.openclaw;
const kOpenclawLines = Object.freeze({
  pin: readDeclaredPin(),
  stable: "2026.8.2",
  beta: "2026.9.1-beta.1",
});

// bin entry of an installed openclaw package dir (string or map form).
const resolvePackageBin = (openclawPackageDir) => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(openclawPackageDir, "package.json"), "utf8"),
  );
  const rel =
    typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin || {})[0];
  return path.join(openclawPackageDir, rel);
};

// Real `npm install` of an exact upstream version, cached across live files
// and runs under one per-version directory (the package is immutable on the
// registry, so the cache key is the version). A cached tree is trusted only
// when its bin actually runs and reports the version; anything else is
// reinstalled. Set ALPHACLAW_LIVE_OPENCLAW_CACHE to relocate the cache (the
// default lives in the temp dir and is NOT swept at exit — that is the point).
const stageOpenclawVersion = async (
  version,
  { timeoutMs = 8 * 60 * 1000, logger = kSilentLogger } = {},
) => {
  const {
    installOpenclawVersionToTempDir,
  } = require("../../lib/server/openclaw-version");
  const { execFileSync } = require("child_process");
  if (!kVersionShape.test(String(version))) {
    throw new Error(`stageOpenclawVersion needs an exact version, got ${version}`);
  }
  const cacheRoot =
    process.env.ALPHACLAW_LIVE_OPENCLAW_CACHE ||
    path.join(os.tmpdir(), "alphaclaw-live-openclaw-cache");
  const cacheDir = path.join(cacheRoot, version);
  const packageDir = path.join(cacheDir, "node_modules", "openclaw");
  const runsAsVersion = () => {
    try {
      const out = String(
        execFileSync(process.execPath, [resolvePackageBin(packageDir), "--version"], {
          timeout: 60_000,
          stdio: "pipe",
          env: { ...scrubTestRunnerEnv(), OPENCLAW_NO_AUTO_UPDATE: "1" },
        }),
      );
      return out
        .split(/[\s()]+/)
        .map((token) => token.replace(/^v/, ""))
        .includes(version);
    } catch {
      return false;
    }
  };
  if (fs.existsSync(packageDir) && runsAsVersion()) {
    return { version, packageDir, bin: resolvePackageBin(packageDir), fromCache: true };
  }
  fs.rmSync(cacheDir, { recursive: true, force: true });
  const staged = await installOpenclawVersionToTempDir({
    versionSpec: version,
    timeoutMs,
    logger,
  });
  fs.mkdirSync(cacheRoot, { recursive: true });
  try {
    fs.renameSync(staged.tmpDir, cacheDir);
  } catch {
    // Cross-device temp dirs: copy, then let the installer's cleanup run.
    fs.cpSync(staged.tmpDir, cacheDir, { recursive: true });
    staged.cleanup();
  }
  if (!runsAsVersion()) {
    throw new Error(`staged openclaw ${version} does not report its own version`);
  }
  return { version, packageDir, bin: resolvePackageBin(packageDir), fromCache: false };
};

// Shared pin fixture + backup stub used by the apply and dev tiers: a
// minimal plausible pin tree (production ships the real image tree) and a
// runner that intercepts ONLY `openclaw backup` (needs a live gateway).
const kFixturePin = "0.0.1";

const writePinFixture = (installDir) => {
  const packageDir = path.join(installDir, "node_modules", "openclaw");
  fs.mkdirSync(path.join(packageDir, "dist", "extensions"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: kFixturePin, bin: { openclaw: "bin/entry.js" } })}\n`,
  );
  fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "bin", "entry.js"),
    `#!/usr/bin/env node\nconsole.log("${kFixturePin}");\n`,
  );
  fs.writeFileSync(
    path.join(packageDir, "dist", "thinking-levels.js"),
    "exports.listThinkingLevelOptions = () => [];\n",
  );
};

// Faithful to the real CLI's --output contract (see the hermetic suites'
// defaultRunnerImpl): the path IS the archive file unless it names an
// existing directory. Hard-gated applies (prerelease/dev/downgrade) verify an
// artifact exists at the exact path, so the stub must write one.
const createBackupStubRunner = (realRunner) => ({
  runStreamed: (opts) => {
    if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
      const outIdx = opts.args.indexOf("--output");
      const out = outIdx >= 0 ? opts.args[outIdx + 1] : null;
      if (out) {
        try {
          const isDirTarget =
            out.endsWith(path.sep) ||
            (fs.existsSync(out) && fs.statSync(out).isDirectory());
          const outFile = isDirTarget
            ? path.join(out, `${Date.now()}-openclaw-backup.tar.gz`)
            : out;
          if (fs.existsSync(outFile)) {
            return Promise.resolve({
              ok: false,
              code: 1,
              tail: `Error: Refusing to overwrite existing backup archive: ${outFile}\n`,
              timedOut: false,
            });
          }
          fs.mkdirSync(path.dirname(outFile), { recursive: true });
          fs.writeFileSync(outFile, "stub backup archive\n");
          return Promise.resolve({
            ok: true,
            code: 0,
            tail: `Created ${outFile}\nArchive verification: passed\n`,
            timedOut: false,
          });
        } catch (error) {
          return Promise.resolve({
            ok: false,
            code: 1,
            tail: `Error: ${error.message}\n`,
            timedOut: false,
          });
        }
      }
      return Promise.resolve({ ok: true, code: 0, tail: "", timedOut: false });
    }
    return realRunner.runStreamed(opts);
  },
});

module.exports = {
  kLiveEnabled,
  kLiveDevEnabled,
  kSilentLogger,
  kVersionShape,
  kFullShaShape,
  kFixturePin,
  kOpenclawLines,
  readDeclaredPin,
  resolvePackageBin,
  stageOpenclawVersion,
  writePinFixture,
  createBackupStubRunner,
  mkTemp,
  createCountingFetch,
  repoOpenclawBin,
  repoBinDir,
  scrubTestRunnerEnv,
  waitFor,
};
