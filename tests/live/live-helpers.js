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

module.exports = {
  kLiveEnabled,
  kLiveDevEnabled,
  kSilentLogger,
  kVersionShape,
  kFullShaShape,
  mkTemp,
  createCountingFetch,
  repoOpenclawBin,
  repoBinDir,
  waitFor,
};
