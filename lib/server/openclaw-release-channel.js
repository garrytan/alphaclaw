const fs = require("fs");
const path = require("path");
const constants = require("./constants");

const kManagedDirName = ".alphaclaw";
const kChannelStateFileName = "openclaw-channel-state.json";
const kRollbackMarkerFileName = "openclaw-rollback-pending.json";
const kServerPidFileName = "alphaclaw-server.pid";
const kBinShimDirName = "bin";
const kBinShimName = "openclaw";
const kOverlayStoreDirName = "openclaw-overlay";
const kOverlayCompleteFileName = ".overlay-complete.json";
const kOpenclawPackageName = "openclaw";
const kOpenclawActivationSentinelName = constants.kOpenclawActivationSentinelName;
const kBinShimTargetPattern = /^exec node "(.+)" "\$@"\s*$/m;

const normalizeApplied = (applied) => {
  if (!applied || typeof applied !== "object" || Array.isArray(applied)) {
    return null;
  }
  return {
    channel: typeof applied.channel === "string" ? applied.channel : null,
    version: typeof applied.version === "string" ? applied.version : null,
    sha: typeof applied.sha === "string" ? applied.sha : null,
    at: applied.at ?? null,
    acceptedAt: applied.acceptedAt ?? null,
    // "manual" (Mark as good now) disarms the stabilization window entirely;
    // "acceptance" (auto, 120s of health) keeps the 24h window armed.
    acceptedSource:
      typeof applied.acceptedSource === "string" ? applied.acceptedSource : null,
  };
};

const normalizeLastKnownGood = (lastKnownGood) => {
  const base =
    lastKnownGood && typeof lastKnownGood === "object" && !Array.isArray(lastKnownGood)
      ? lastKnownGood
      : {};
  return {
    package: typeof base.package === "string" ? base.package : null,
    dev: typeof base.dev === "string" ? base.dev : null,
  };
};

const normalizeBlocklistEntry = (entry) => {
  if (
    !entry ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    typeof entry.id !== "string" ||
    entry.id === ""
  ) {
    return null;
  }
  return {
    id: entry.id,
    reason: typeof entry.reason === "string" ? entry.reason : null,
    exitCode: Number.isFinite(entry.exitCode) ? entry.exitCode : null,
    at: entry.at ?? null,
  };
};

const normalizeBlocklist = (blocklist) => {
  if (!Array.isArray(blocklist)) return [];
  const seen = new Set();
  const entries = [];
  for (const raw of blocklist) {
    const entry = normalizeBlocklistEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
};

const normalizePlainObjectOrNull = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;

const normalizeState = (raw) => {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  // `corrupted` is a read-time-only flag; it must never round-trip to disk.
  const { corrupted, ...rest } = base;
  return {
    ...rest,
    applied: normalizeApplied(base.applied),
    pinVersion: typeof base.pinVersion === "string" ? base.pinVersion : null,
    lastKnownGood: normalizeLastKnownGood(base.lastKnownGood),
    blocklist: normalizeBlocklist(base.blocklist),
    lastUpdateRun: normalizePlainObjectOrNull(base.lastUpdateRun),
    lastBoot: normalizePlainObjectOrNull(base.lastBoot),
    backups: Array.isArray(base.backups) ? base.backups : [],
  };
};

const createOpenclawReleaseChannelStore = ({
  fsModule = fs,
  rootDir = constants.kRootDir,
  openclawDir = constants.OPENCLAW_DIR,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  const managedDir = path.join(openclawDir, kManagedDirName);
  const statePath = path.join(managedDir, kChannelStateFileName);
  const serverPidPath = path.join(managedDir, kServerPidFileName);
  const markerPath = path.join(managedDir, kRollbackMarkerFileName);
  const shimDir = path.join(managedDir, kBinShimDirName);
  const shimPath = path.join(shimDir, kBinShimName);
  const overlayStoreDir = path.join(rootDir, kOverlayStoreDirName);

  // Atomic write: state/marker files are rewritten constantly (step progress,
  // health acceptance) and a torn write must never surface — a corrupted state
  // file silently discards the blocklist/LKG/pin, and a torn rollback marker
  // parses as null, re-running the broken build. Temp file lives in the SAME
  // directory (cross-device rename is EXDEV on Docker volumes).
  const writeJsonFile = (filePath, value) => {
    const dir = path.dirname(filePath);
    fsModule.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.tmp`,
    );
    fsModule.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    try {
      fsModule.renameSync(tempPath, filePath);
    } catch (error) {
      try {
        fsModule.rmSync(tempPath, { force: true });
      } catch {}
      throw error;
    }
  };

  // --- server pid (single-instance guard for the destructive boot sync) ------

  const writeServerPid = () => {
    try {
      // Never clobber a LIVE foreign owner: a second start that loses the
      // port race would otherwise replace the real server's claim and then
      // clear it on exit, leaving the live server unguarded for a third start.
      const owner = readLiveServerPid();
      if (owner) return;
      writeJsonFile(serverPidPath, { pid: process.pid, at: nowFn() });
    } catch {}
  };

  const clearServerPid = () => {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(serverPidPath, "utf8"));
      if (parsed?.pid === process.pid) fsModule.unlinkSync(serverPidPath);
    } catch {}
  };

  // Returns the pid of a LIVE alphaclaw server other than this process, or
  // null. A dead/absent/self pid means the boot sync may proceed.
  const readLiveServerPid = () => {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(serverPidPath, "utf8"));
      const pid = Number(parsed?.pid);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  };

  // --- state -----------------------------------------------------------------

  // getChannelInfo() sits on hot paths (status SSE every 2s per client,
  // watchdog probes), so identical re-reads are served from a parsed copy
  // keyed by the file's mtime — a stat per call instead of read+parse.
  let stateCache = null;

  const cloneState = (state) => JSON.parse(JSON.stringify(state));

  const readState = () => {
    let stat = null;
    try {
      stat = fsModule.statSync(statePath);
    } catch {
      stateCache = null;
      return normalizeState({});
    }
    if (
      stateCache &&
      stateCache.mtimeMs === stat.mtimeMs &&
      stateCache.size === stat.size
    ) {
      return cloneState(stateCache.state);
    }
    let raw = null;
    try {
      raw = fsModule.readFileSync(statePath, "utf8");
    } catch {
      stateCache = null;
      return normalizeState({});
    }
    try {
      const state = normalizeState(JSON.parse(raw));
      stateCache = { mtimeMs: stat.mtimeMs, size: stat.size, state };
      return cloneState(state);
    } catch (error) {
      stateCache = null;
      logger.warn?.(
        `[release-channel] corrupted channel state at ${statePath}: ${error.message}`,
      );
      return { ...normalizeState({}), corrupted: true };
    }
  };

  const writeState = (state) => {
    const normalized = normalizeState(state);
    writeJsonFile(statePath, normalized);
    try {
      const stat = fsModule.statSync(statePath);
      stateCache = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        state: cloneState(normalized),
      };
    } catch {
      stateCache = null;
    }
    return normalized;
  };

  const updateState = (mutatorFn) => {
    const state = readState();
    const returned = typeof mutatorFn === "function" ? mutatorFn(state) : undefined;
    const next =
      returned && typeof returned === "object" && !Array.isArray(returned)
        ? returned
        : state;
    return writeState(next);
  };

  const isBlocklisted = (id) =>
    readState().blocklist.some((entry) => entry.id === id);

  const addBlocklist = ({ id, reason, exitCode = null } = {}) =>
    updateState((state) => {
      if (state.blocklist.some((entry) => entry.id === id)) return state;
      state.blocklist.push({
        id,
        reason: typeof reason === "string" ? reason : null,
        exitCode,
        at: nowFn(),
      });
      return state;
    });

  const clearBlocklist = (id) =>
    updateState((state) => {
      state.blocklist =
        id === undefined
          ? []
          : state.blocklist.filter((entry) => entry.id !== id);
      return state;
    });

  // --- rollback marker ---------------------------------------------------------

  const readMarker = () => {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(markerPath, "utf8"));
      return normalizePlainObjectOrNull(parsed);
    } catch {
      return null;
    }
  };

  const writeMarker = (marker) => {
    try {
      writeJsonFile(markerPath, marker);
      return { ok: true };
    } catch (error) {
      logger.error?.(
        `[release-channel] failed to write rollback marker: ${error.message}`,
      );
      return { ok: false, error: error.message };
    }
  };

  const clearMarker = () => {
    try {
      fsModule.unlinkSync(markerPath);
    } catch {
      // Best effort: a missing marker is the desired end state anyway.
    }
  };

  // --- overlay store -----------------------------------------------------------

  // Versions reach this from API input; the route allowlist is the first line,
  // but a traversal-shaped name ("..", "a/b") aimed at rmSync/cpSync must be
  // structurally impossible here too.
  const assertSafeOverlayName = (version) => {
    const name = String(version || "");
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\0")
    ) {
      throw new Error(`unsafe overlay name: ${JSON.stringify(version)}`);
    }
    const resolved = path.resolve(overlayStoreDir, name);
    if (!resolved.startsWith(overlayStoreDir + path.sep)) {
      throw new Error(`overlay path escapes the store: ${JSON.stringify(version)}`);
    }
    return name;
  };

  const overlayDir = (version) =>
    path.join(overlayStoreDir, assertSafeOverlayName(version));

  const overlayPackageDir = (version) =>
    path.join(overlayDir(version), kOpenclawPackageName);

  const overlayCompletePath = (version) =>
    path.join(overlayDir(version), kOverlayCompleteFileName);

  const hasOverlay = (version) => {
    if (typeof version !== "string" || version === "") return false;
    try {
      if (!fsModule.existsSync(overlayPackageDir(version))) return false;
      const complete = JSON.parse(
        fsModule.readFileSync(overlayCompletePath(version), "utf8"),
      );
      return complete?.version === version;
    } catch {
      return false;
    }
  };

  const saveOverlayFromTempInstall = ({ openclawPackageDir, version } = {}) => {
    try {
      const entryDir = overlayDir(version);
      // Tombstone first: rm's traversal order is unspecified, so the
      // completion file must be gone before the tree starts disappearing —
      // hasOverlay trusts it as proof of a complete copy.
      fsModule.rmSync(overlayCompletePath(version), { force: true });
      // A partial entry (mid-copy crash) must never be mistaken for a good one.
      fsModule.rmSync(entryDir, { recursive: true, force: true });
      fsModule.mkdirSync(entryDir, { recursive: true });
      fsModule.cpSync(openclawPackageDir, overlayPackageDir(version), {
        recursive: true,
      });
      // Completion file is written LAST so its presence proves a full copy.
      writeJsonFile(overlayCompletePath(version), {
        version,
        savedAt: nowFn(),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  // Async variants for the LIVE apply path: cpSync of a multi-hundred-MB tree
  // blocks the event loop (SSE progress, /api/status, proxied gateway traffic)
  // for tens of seconds. Boot activation stays sync — it runs pre-server.
  const fsp = fsModule.promises || fs.promises;

  const saveOverlayFromTempInstallAsync = async ({
    openclawPackageDir,
    version,
  } = {}) => {
    try {
      const entryDir = overlayDir(version);
      // Tombstone first — see saveOverlayFromTempInstall.
      await fsp.rm(overlayCompletePath(version), { force: true });
      await fsp.rm(entryDir, { recursive: true, force: true });
      await fsp.mkdir(entryDir, { recursive: true });
      await fsp.cp(openclawPackageDir, overlayPackageDir(version), {
        recursive: true,
      });
      writeJsonFile(overlayCompletePath(version), {
        version,
        savedAt: nowFn(),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  const snapshotPinFromInstallAsync = async ({ installDir, pinVersion } = {}) => {
    if (hasOverlay(pinVersion)) {
      return { ok: true, alreadyPresent: true };
    }
    const result = await saveOverlayFromTempInstallAsync({
      openclawPackageDir: path.join(
        installDir,
        "node_modules",
        kOpenclawPackageName,
      ),
      version: pinVersion,
    });
    return result.ok ? { ok: true, alreadyPresent: false } : result;
  };

  const snapshotPinFromInstall = ({ installDir, pinVersion } = {}) => {
    if (hasOverlay(pinVersion)) {
      return { ok: true, alreadyPresent: true };
    }
    const result = saveOverlayFromTempInstall({
      openclawPackageDir: path.join(
        installDir,
        "node_modules",
        kOpenclawPackageName,
      ),
      version: pinVersion,
    });
    return result.ok ? { ok: true, alreadyPresent: false } : result;
  };

  // Async prune for the LIVE apply path — an overlay entry is a
  // multi-hundred-MB tree and rmSync would block SSE/status/proxy traffic.
  const pruneOverlaysAsync = async ({ keep = [] } = {}) => {
    const keepSet = new Set(keep);
    const removed = [];
    let entries = [];
    try {
      entries = fsModule.readdirSync(overlayStoreDir);
    } catch {
      return { removed };
    }
    for (const name of entries) {
      if (keepSet.has(name)) continue;
      try {
        // Tombstone first — a crash mid-delete must not leave a completion
        // file over a gutted tree that boot would then activate.
        await fsp.rm(path.join(overlayStoreDir, name, kOverlayCompleteFileName), {
          force: true,
        });
        await fsp.rm(path.join(overlayStoreDir, name), {
          recursive: true,
          force: true,
        });
        removed.push(name);
      } catch (error) {
        logger.warn?.(
          `[release-channel] failed to prune overlay ${name}: ${error.message}`,
        );
      }
    }
    return { removed };
  };

  const pruneOverlays = ({ keep = [] } = {}) => {
    const keepSet = new Set(keep);
    const removed = [];
    let entries = [];
    try {
      entries = fsModule.readdirSync(overlayStoreDir);
    } catch {
      return { removed };
    }
    for (const name of entries) {
      if (keepSet.has(name)) continue;
      try {
        // Tombstone first — see pruneOverlaysAsync.
        fsModule.rmSync(path.join(overlayStoreDir, name, kOverlayCompleteFileName), {
          force: true,
        });
        fsModule.rmSync(path.join(overlayStoreDir, name), {
          recursive: true,
          force: true,
        });
        removed.push(name);
      } catch (error) {
        logger.warn?.(
          `[release-channel] failed to prune overlay ${name}: ${error.message}`,
        );
      }
    }
    return { removed };
  };

  // --- live tree ------------------------------------------------------------

  const liveOpenclawDir = (installDir) =>
    path.join(installDir, "node_modules", kOpenclawPackageName);

  const sentinelPath = ({ installDir } = {}) =>
    path.join(installDir, "node_modules", kOpenclawActivationSentinelName);

  // Hot path: getChannelInfo() runs on the 2s status SSE tick per client.
  // The live package.json only changes on apply/boot — serve repeats from an
  // mtime-keyed cache like readState does.
  const installedVersionCache = new Map();

  const readInstalledVersion = ({ installDir } = {}) => {
    const pkgPath = path.join(liveOpenclawDir(installDir), "package.json");
    let stat = null;
    try {
      stat = fsModule.statSync(pkgPath);
    } catch {
      installedVersionCache.delete(pkgPath);
      return null;
    }
    const cached = installedVersionCache.get(pkgPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.version;
    }
    try {
      const pkg = JSON.parse(
        fsModule.readFileSync(pkgPath, "utf8"),
      );
      const version = typeof pkg?.version === "string" ? pkg.version : null;
      installedVersionCache.set(pkgPath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        version,
      });
      return version;
    } catch {
      installedVersionCache.delete(pkgPath);
      return null;
    }
  };

  const readSentinel = ({ installDir } = {}) => {
    try {
      const parsed = JSON.parse(
        fsModule.readFileSync(sentinelPath({ installDir }), "utf8"),
      );
      return normalizePlainObjectOrNull(parsed);
    } catch {
      return null;
    }
  };

  // A mid-copy crash leaves a plausible package.json behind, so the live tree's
  // version alone is never trusted: only the sentinel proves a completed copy.
  const needsActivation = ({ installDir, expectedVersion } = {}) => {
    const sentinel = readSentinel({ installDir });
    return !sentinel || sentinel.version !== expectedVersion;
  };

  const writeSentinel = ({ installDir, version } = {}) => {
    try {
      writeJsonFile(sentinelPath({ installDir }), {
        version,
        completedAt: nowFn(),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  const activateOverlay = ({ installDir, version } = {}) => {
    if (!hasOverlay(version)) {
      return {
        ok: false,
        error: `no complete overlay for openclaw@${version} in ${overlayStoreDir}`,
      };
    }
    try {
      // Re-activations start with a MATCHING sentinel on disk (drift repair);
      // it must be gone before the destructive copy or a mid-copy crash
      // leaves sentinel + plausible package.json validating a gutted tree.
      try {
        fsModule.unlinkSync(sentinelPath({ installDir }));
      } catch {}
      const liveDir = liveOpenclawDir(installDir);
      fsModule.rmSync(liveDir, { recursive: true, force: true });
      fsModule.cpSync(overlayPackageDir(version), liveDir, { recursive: true });
    } catch (error) {
      return { ok: false, error: error.message };
    }
    // Sentinel is written LAST so a crash mid-copy leaves no sentinel behind.
    return writeSentinel({ installDir, version });
  };

  // --- bin shim ---------------------------------------------------------------

  const writeBinShim = ({ targetBin, label = "" } = {}) => {
    // The target path is embedded in a double-quoted sh string where $(), ``
    // and ${} still evaluate — a bin path shaped by a package's own
    // package.json must not be able to smuggle shell into the shim.
    const target = String(targetBin || "");
    if (!target || /["`$\\\n\r]/.test(target)) {
      return {
        ok: false,
        error: `refusing to write shim: unsafe target path ${JSON.stringify(target)}`,
      };
    }
    // Temp file lives in shimDir itself: renaming across the /data volume
    // boundary would fail with EXDEV on Docker.
    const tempPath = path.join(
      shimDir,
      `.${kBinShimName}-shim-${process.pid}-${Date.now()}.tmp`,
    );
    try {
      fsModule.mkdirSync(shimDir, { recursive: true });
      const safeLabel = String(label || "").replace(/[^0-9A-Za-z.\-_@ ]/g, "");
      const content = `#!/bin/sh\n# alphaclaw release-channel shim (${safeLabel})\nexec node "${target}" "$@"\n`;
      fsModule.writeFileSync(tempPath, content);
      fsModule.chmodSync(tempPath, 0o755);
      fsModule.renameSync(tempPath, shimPath);
      return { ok: true };
    } catch (error) {
      try {
        fsModule.rmSync(tempPath, { force: true });
      } catch {
        // Best effort cleanup of the temp file.
      }
      return { ok: false, error: error.message };
    }
  };

  const removeBinShim = () => {
    try {
      fsModule.unlinkSync(shimPath);
      return { removed: true };
    } catch {
      return { removed: false };
    }
  };

  const readBinShimTarget = () => {
    try {
      const content = fsModule.readFileSync(shimPath, "utf8");
      const match = content.match(kBinShimTargetPattern);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  };

  // Standalone impostor sweep so the apply path can re-run it cheaply — the
  // shim dir sits first on PATH for the whole uptime, and a boot-only sweep
  // leaves the full uptime as a planting window.
  const sweepShimDir = () => {
    try {
      for (const name of fsModule.readdirSync(shimDir)) {
        if (name === kBinShimName) continue;
        try {
          fsModule.rmSync(path.join(shimDir, name), {
            recursive: true,
            force: true,
          });
          logger.warn?.(
            `[release-channel] removed unexpected file from shim dir: ${name}`,
          );
        } catch {}
      }
    } catch {}
  };

  const validateBinShim = () => {
    sweepShimDir();
    if (!fsModule.existsSync(shimPath)) {
      return { present: false, valid: false, removed: false };
    }
    const target = readBinShimTarget();
    // Shape alone is not enough: a planted shim pointing at any existing
    // file would pass an existence check. The target must live inside the
    // managed roots (overlay store or the dev checkout).
    const targetAllowed = (candidate) => {
      const resolved = path.resolve(String(candidate || ""));
      const checkoutRoot = path.resolve(rootDir, "openclaw");
      return (
        resolved.startsWith(path.resolve(overlayStoreDir) + path.sep) ||
        resolved.startsWith(checkoutRoot + path.sep)
      );
    };
    if (!target || !fsModule.existsSync(target) || !targetAllowed(target)) {
      const { removed } = removeBinShim();
      return { present: true, valid: false, removed };
    }
    return { present: true, valid: true, removed: false };
  };

  const resolvePackageBin = (packageDir) => {
    try {
      const pkg = JSON.parse(
        fsModule.readFileSync(path.join(packageDir, "package.json"), "utf8"),
      );
      const bin = pkg?.bin;
      let relative = null;
      if (typeof bin === "string") {
        relative = bin;
      } else if (bin && typeof bin === "object" && !Array.isArray(bin)) {
        relative =
          typeof bin[kOpenclawPackageName] === "string"
            ? bin[kOpenclawPackageName]
            : Object.values(bin).find((value) => typeof value === "string") ??
              null;
      }
      if (!relative) return null;
      const resolved = path.resolve(packageDir, relative);
      // A bin entry must stay inside its own package — "../" escapes get no shim.
      if (!resolved.startsWith(path.resolve(packageDir) + path.sep)) {
        return null;
      }
      return resolved;
    } catch {
      return null;
    }
  };

  return {
    statePath,
    markerPath,
    shimDir,
    shimPath,
    overlayStoreDir,
    normalizeState,
    readState,
    writeState,
    updateState,
    isBlocklisted,
    addBlocklist,
    clearBlocklist,
    readMarker,
    writeMarker,
    clearMarker,
    overlayDir,
    overlayPackageDir,
    hasOverlay,
    saveOverlayFromTempInstall,
    saveOverlayFromTempInstallAsync,
    snapshotPinFromInstall,
    snapshotPinFromInstallAsync,
    pruneOverlays,
    pruneOverlaysAsync,
    readInstalledVersion,
    sentinelPath,
    readSentinel,
    needsActivation,
    activateOverlay,
    writeSentinel,
    writeBinShim,
    removeBinShim,
    readBinShimTarget,
    validateBinShim,
    sweepShimDir,
    serverPidPath,
    writeServerPid,
    clearServerPid,
    readLiveServerPid,
    resolvePackageBin,
  };
};

module.exports = {
  kOpenclawActivationSentinelName,
  createOpenclawReleaseChannelStore,
  normalizeState,
};
