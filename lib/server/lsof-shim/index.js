// Ask-scoped lsof resolution for the gateway stop ladder (bug #137).
//
// The pinned OpenClaw CLI finds the listener on the gateway port through
// lsof (`resolveLsofCommandSync` in ports-lsof-*.mjs: /usr/bin/lsof,
// /usr/sbin/lsof, else bare `lsof` through PATH) and reads ENOENT as "no
// listeners", so `openclaw gateway restart --wait` refuses on an image
// without lsof and AlphaClaw's graceful ask never runs. The Dockerfile now
// ships lsof; for boxes built before that, `./lsof` is a /proc-backed shim
// that answers the CLI's exact call shape.
//
// SCOPE — the shim is for the ask spawn ONLY. `withAskLsofPath(env)` is
// applied to the environment of the one `openclaw gateway restart` child in
// gateway.js; it must never be folded into gatewayEnv() itself. The gateway
// and every other `openclaw` CLI call run with the same lsof-less PATH they
// have today, where OpenClaw's stale-pid cleanup (`terminateStaleGatewayPids`
// — it SIGTERMs/SIGKILLs listeners it verifies as gateways) and its port
// polling (`pollPortOnce`) are inert because lsof is absent. A partial lsof
// on the gateway's PATH would switch those on with answers the shim never
// promised (no `-iTCP` snapshot, no ESTABLISHED, exit 2 for every other
// form) and hand OpenClaw a second supervisor over the port AlphaClaw's stop
// ladder already owns.
//
// The shim directory is APPENDED to PATH, never prepended: a real lsof
// anywhere on the box always wins, and the shim can be disabled outright with
// ALPHACLAW_LSOF_SHIM=0.
const fs = require("fs");
const path = require("path");

const kShimDir = __dirname;
const kShimPath = path.join(kShimDir, "lsof");

// The pin's own candidate order (ports-lsof-*.mjs LSOF_CANDIDATES).
const lsofCandidatesFor = (platform) =>
  platform === "darwin" ? ["/usr/sbin/lsof", "/usr/bin/lsof"] : ["/usr/bin/lsof", "/usr/sbin/lsof"];

const isExecutable = (fsModule, filePath) => {
  try {
    fsModule.accessSync(filePath, fsModule.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const isShimEnabled = (env, platform) => platform === "linux" && env.ALPHACLAW_LSOF_SHIM !== "0";

// Which lsof will the ask CLI run under `env`? Mirrors the pin's lookup
// (fixed candidates, then PATH left to right) so the answer is what
// spawnSync(lsof) would actually execute.
//   { path, kind: "real" }  an lsof binary the CLI resolves on its own
//   { path, kind: "shim" }  nothing real; the shim (enabled, Linux)
//   { path: null, kind: "none" }  nothing, and the shim is off or unavailable
const resolveAskLsofPath = ({ env = process.env, platform = process.platform, fsModule = fs } = {}) => {
  for (const candidate of lsofCandidatesFor(platform)) {
    if (isExecutable(fsModule, candidate)) return { path: candidate, kind: "real" };
  }
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "lsof");
    if (!isExecutable(fsModule, candidate)) continue;
    if (path.resolve(dir) !== kShimDir) return { path: candidate, kind: "real" };
    if (isShimEnabled(env, platform)) return { path: kShimPath, kind: "shim" };
  }
  if (isShimEnabled(env, platform) && isExecutable(fsModule, kShimPath)) return { path: kShimPath, kind: "shim" };
  return { path: null, kind: "none" };
};

// A copy of `env` whose PATH ends with the shim directory when, and only
// when, the shim is what the ask CLI should find. Identity-preserving
// otherwise (a real lsof resolves, the shim is disabled, or it is already on
// PATH). Call it on the ask spawn's env only — see the header.
const withAskLsofPath = (env, { platform = process.platform, fsModule = fs } = {}) => {
  const next = { ...env };
  const resolved = resolveAskLsofPath({ env: next, platform, fsModule });
  if (resolved.kind !== "shim") return next;
  const entries = String(next.PATH || "").split(path.delimiter).filter(Boolean);
  if (entries.some((dir) => path.resolve(dir) === kShimDir)) return next;
  next.PATH = [...entries, kShimDir].join(path.delimiter);
  return next;
};

module.exports = {
  kShimDir,
  kShimPath,
  resolveAskLsofPath,
  withAskLsofPath,
};
