const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// Shared plumbing for the LIVE e2e tiers (tests/live/**). These suites talk to
// the real npm registry and the real GitHub API on purpose: their job is to
// scream when upstream reality drifts away from the assumptions the hermetic
// suites encode (dist-tag shape, prerelease naming, engines, updater JSON,
// dist layout). They are excluded from `npm test` via vitest.config.js and run
// through `npm run test:live` / `npm run test:live:dev`.

const kLiveEnabled = process.env.OPENCLAW_LIVE_E2E === "1";
const kLiveDevEnabled = process.env.OPENCLAW_LIVE_E2E_DEV === "1";

const kSilentLogger = { log() {}, warn() {}, error() {} };

// TEMP-DIR HYGIENE (incident 2026-09-02: 46 GB of /tmp debris in one
// afternoon, `alphaclaw-live-downgrade-*` alone 21 GB over 15 runs). One live
// run stages multiple GBs (real npm installs, overlay stores, a dev checkout),
// so every temp root this tier creates is tracked here and swept:
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
//
// Roots that must OUTLIVE a run (the per-version install cache below) live
// outside the `alphaclaw-live-*` / `openclaw-prepare-*` namespaces on
// purpose, so an operator's prefix sweep between runs never deletes them.
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

// Fail FAST when the disk is already too full for a heavy live suite, with the
// sweep instruction in the message, instead of dying mid-run with ENOSPC
// (which is how the 2026-09-02 incident surfaced: 12 files red at once, /
// at 100 %). Default floor 4 GiB — one real install (~0.7 GB) × the two or
// three copies a heavy suite keeps live (staged + overlay + activated) plus
// the archive under test. Returns the free bytes, or null when the platform
// has no statfs (never blocks there).
const kDefaultFreeDiskFloorBytes = 4 * 1024 ** 3;
const assertFreeDiskBytes = (
  minBytes = kDefaultFreeDiskFloorBytes,
  { dir = os.tmpdir(), label = "this live suite" } = {},
) => {
  if (typeof fs.statfsSync !== "function") return null;
  let stat;
  try {
    stat = fs.statfsSync(dir);
  } catch {
    return null;
  }
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  if (!Number.isFinite(freeBytes)) return null;
  if (freeBytes < minBytes) {
    const gib = (bytes) => (bytes / 1024 ** 3).toFixed(1);
    throw new Error(
      `free disk below ${gib(minBytes)} GiB (${gib(freeBytes)} GiB free under ${dir}) — ` +
        `${label} stages real OpenClaw installs there; sweep /tmp/alphaclaw-live-* and ` +
        `/tmp/openclaw-prepare-* (leftovers of interrupted live runs) and check \`df -h /\` before retrying`,
    );
  }
  return freeBytes;
};

// The REAL installer (lib/server/openclaw-version.js) mints its own
// `openclaw-prepare-*` dir and removes it only when the caller's cleanup()
// runs — a run interrupted mid-`npm install` leaked ~0.7 GB per call before
// this wrapper. Same contract as installOpenclawVersionToTempDir, but the
// prepare dir is tracked for the sweep the moment it is created. Callers
// still call `staged.cleanup()` in a finally (the sweep is the backstop).
const stageTempInstall = (opts = {}) => {
  const {
    installOpenclawVersionToTempDir,
  } = require("../../lib/server/openclaw-version");
  const trackingFs = {
    ...fs,
    mkdtempSync: (prefix, ...rest) => trackTempDir(fs.mkdtempSync(prefix, ...rest)),
  };
  return installOpenclawVersionToTempDir({ fsModule: trackingFs, ...opts });
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
// reinstalled. Set ALPHACLAW_LIVE_OPENCLAW_CACHE to relocate the cache. The
// default, `$TMPDIR/alphaclaw-openclaw-cache/<version>`, is deliberately NOT
// swept at exit and deliberately NOT under the `alphaclaw-live-*` prefix: the
// operator's between-runs sweep (`rm -rf /tmp/alphaclaw-live-*
// /tmp/openclaw-prepare-*`) must not throw away the ~0.7 GB-per-version cache
// the whole tier warms once.
const kOpenclawVersionCacheDirName = "alphaclaw-openclaw-cache";
const stageOpenclawVersion = async (
  version,
  { timeoutMs = 8 * 60 * 1000, logger = kSilentLogger } = {},
) => {
  const { execFileSync } = require("child_process");
  if (!kVersionShape.test(String(version))) {
    throw new Error(`stageOpenclawVersion needs an exact version, got ${version}`);
  }
  const cacheRoot =
    process.env.ALPHACLAW_LIVE_OPENCLAW_CACHE ||
    path.join(os.tmpdir(), kOpenclawVersionCacheDirName);
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
  // Tracked install: an interruption mid-`npm install` leaves the prepare dir
  // to the sweep instead of on disk; after the rename below the tracked path
  // no longer exists, so the sweep never touches the cache.
  const staged = await stageTempInstall({
    versionSpec: version,
    timeoutMs,
    logger,
  });
  fs.mkdirSync(cacheRoot, { recursive: true });
  try {
    fs.renameSync(staged.tmpDir, cacheDir);
  } catch {
    // Cross-device temp dirs: copy, then let the installer's cleanup run.
    try {
      fs.cpSync(staged.tmpDir, cacheDir, { recursive: true });
    } finally {
      staged.cleanup();
    }
  }
  if (!runsAsVersion()) {
    // Never leave a broken tree where the next run would trust-then-reject it.
    fs.rmSync(cacheDir, { recursive: true, force: true });
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

// Faithful to the real CLI's output contract (see the hermetic suites'
// defaultRunnerImpl): the --output path IS the archive file unless it names
// an existing directory, an existing file is refused, and the artifact is a
// REAL gzip'd tar in upstream's layout — `<archiveRoot>/manifest.json`
// (schemaVersion 1, ONE directory-level `kind: "state"` asset) above
// `<archiveRoot>/payload/posix<stateDir>` holding a copy of the state dir.
// The product's usable check (`gzip -t` + depth-1 manifest coverage) judges
// this archive exactly as it judges a real one — a plain-text stub made every
// hard-gated live apply refuse honestly with `not in gzip format`. Hard-gated
// applies (prerelease/dev/downgrade) verify an artifact exists at the exact
// path, so the stub must write one. `stateDir` is the box's OpenClaw dir
// (what channel-sync's stateDir() resolves: OPENCLAW_STATE_DIR, else the
// openclaw dir); with neither the option nor the env the stub fails LOUDLY
// rather than fabricate an archive that covers nothing.
const kStubArchiveRoot = "2026-09-02T00-00-00.000+00-00-openclaw-backup";
// Runtime trees the store keeps under the openclaw dir (overlays, caches,
// logs) are not state and would make every stub backup copy gigabytes.
const kStubPayloadSkipPattern = /(^|[\\/])(\.alphaclaw|backups|node_modules|logs|overlays)([\\/]|$)/;
const toPosixPath = (value) => String(value).split(path.sep).join("/");

const writeStubBackupArchive = ({ outFile, stateDir }) => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-live-backup-stub-"));
  try {
    const root = path.join(staging, kStubArchiveRoot);
    const posixStateDir = toPosixPath(path.resolve(stateDir));
    const payloadDir = path.join(root, "payload", `posix${posixStateDir}`);
    fs.mkdirSync(payloadDir, { recursive: true });
    if (fs.existsSync(stateDir)) {
      fs.cpSync(stateDir, payloadDir, {
        recursive: true,
        filter: (src) => !kStubPayloadSkipPattern.test(path.relative(stateDir, src)),
      });
    }
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      archiveRoot: kStubArchiveRoot,
      runtimeVersion: "live-backup-stub",
      platform: process.platform,
      nodeVersion: process.version,
      options: { includeWorkspace: false, onlyConfig: false },
      paths: { stateDir: posixStateDir, configPath: `${posixStateDir}/openclaw.json` },
      assets: [
        {
          kind: "state",
          sourcePath: posixStateDir,
          archivePath: `${kStubArchiveRoot}/payload/posix${posixStateDir}`,
        },
      ],
      skipped: [],
    };
    fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const tar = spawnSync("tar", ["-czf", outFile, "-C", staging, kStubArchiveRoot], {
      stdio: "pipe",
    });
    if (tar.error) throw tar.error;
    if (tar.status !== 0) {
      throw new Error(
        `tar exited ${tar.status ?? tar.signal}: ${String(tar.stderr || "").trim()}`,
      );
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
};

const createBackupStubRunner = (realRunner, { stateDir = null } = {}) => ({
  runStreamed: (opts) => {
    if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
      const outIdx = opts.args.indexOf("--output");
      const out = outIdx >= 0 ? opts.args[outIdx + 1] : null;
      if (out) {
        try {
          const resolvedStateDir =
            stateDir || opts.env?.OPENCLAW_STATE_DIR || opts.env?.OPENCLAW_DIR || null;
          if (!resolvedStateDir) {
            throw new Error(
              "backup stub needs the state dir — pass { stateDir } or set OPENCLAW_STATE_DIR in the spawn env",
            );
          }
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
          writeStubBackupArchive({ outFile, stateDir: resolvedStateDir });
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
  kOpenclawVersionCacheDirName,
  kDefaultFreeDiskFloorBytes,
  readDeclaredPin,
  resolvePackageBin,
  stageOpenclawVersion,
  stageTempInstall,
  writePinFixture,
  createBackupStubRunner,
  mkTemp,
  trackTempDir,
  sweepLiveTempDirs,
  assertFreeDiskBytes,
  createCountingFetch,
  repoOpenclawBin,
  repoBinDir,
  scrubTestRunnerEnv,
  waitFor,
};
