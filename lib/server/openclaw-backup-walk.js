// Streaming full-copy walk. Optional debris measurement has its own global
// budget and never consumes the copy-set cap or turns sampling into a failure.
const fs = require("fs");
const path = require("path");
const { OfflineCopyError } = require("./openclaw-backup-errors");
const { resolveBackupPolicy, isCoreAssetPath } = require("./openclaw-backup-policy");
const { resolveBackupStateRoot, isBackupEnvPath } = require("./openclaw-backup-paths");
const kWalkCheckpointEvery = 500;
const kMaxWalkEntries = 200_000;
const kMeasurementEntries = 10_000;
const kMeasurementMs = 250;
const kSqliteDbPattern = /\.sqlite$/i;
const kSqliteSidecarPattern = /\.sqlite-(wal|shm|journal)$/i;
const kSkipDirNames = new Set([".alphaclaw", "logs", "tmp", "node_modules", "backups"]);
const kWorkspaceDirPattern = /^workspace(-.*)?$/;
const toPosix = (value) => String(value || "").split(path.sep).join("/");
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

function* walkStateTreeSteps({
  stateDir, fsModule = fs, checkpointEvery = kWalkCheckpointEvery,
  excludes, rootExcludes, policy: suppliedPolicy, inventory = null,
  nowFn = Date.now, maxEntries = kMaxWalkEntries,
  measurementMaxEntries = kMeasurementEntries, measurementMs = kMeasurementMs,
  mode = "copy", diagnostic = false, diagnosisMs = 60_000,
  _state,
}) {
  const diagnosing = mode === "diagnosis" || diagnostic;
  const deadline = diagnosing ? nowFn() + diagnosisMs : Infinity;
  let rootInfo;
  try { rootInfo = resolveBackupStateRoot({ stateDir, fsModule }); }
  catch (error) { throw new OfflineCopyError("enumerate", `cannot resolve state root: ${error.message}`, { cause: error }); }
  stateDir = rootInfo.stateDir;
  const dbs = [...(inventory?.dbs || [])];
  const files = [...(inventory?.files || [])].filter((file) => !isBackupEnvPath(file.archivePath));
  const selected = new Set([...dbs, ...files].map((file) => file.sourcePath));
  const skipped = [...(inventory?.skipped || [])];
  const workspaces = new Map();
  const policy = resolveBackupPolicy(suppliedPolicy || { excludes, rootExcludes }, { inventory });
  const rootRules = policy.rootApplied || [];
  const rules = [...policy.applied, ...rootRules];
  const tallies = rules.map((rule, index) => ({
    pattern: rule.pattern, ...(index >= policy.applied.length ? { scope: "root" } : {}), files: 0, bytes: 0,
  }));
  const leaders = { entries: [], bytes: [] };
  const active = [];
  const topLevel = new Map();
  const absoluteSymlinks = [];
  const envFiles = [];
  let top = null;
  let totalBytes = 0;
  const selection = {
    dbBytes: dbs.reduce((sum, db) => sum + db.bytes, 0), dbCount: dbs.length,
    assetBytes: files.reduce((sum, file) => sum + file.bytes, 0), assetCount: files.length,
    workspaceBytes: 0, workspaceFiles: 0, excludedBytes: 0, excludedFiles: 0,
  };
  const offer = (entry) => {
    if (!entry.path) return;
    for (const field of ["entries", "bytes"]) {
      leaders[field] = [...leaders[field].filter((row) => row.path !== entry.path), { ...entry }]
        .sort((a, b) => b[field] - a[field] || a.path.localeCompare(b.path)).slice(0, 5);
    }
  };
  let entriesSeen = 0;
  let visited = 0;
  let measured = 0;
  let measurementStartedAt = null;
  let measurementComplete = true;
  // A live gateway writes and removes files (session transcripts, .lock
  // sidecars) while we walk: an entry that is gone by the time it is stat'ed
  // no longer exists, so it is recorded and skipped — never a reason to fail
  // the preflight or the copy's enumeration (v0.9.87 aborted the whole backup
  // with "cannot stat …" under churn; live tier 2026-09-22).
  let vanished = 0;
  const isVanished = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";
  const snapshot = (complete = false) => {
    const values = [...new Map([...leaders.entries, ...leaders.bytes, ...active]
      .filter((entry) => entry.path).map((entry) => [entry.path, entry])).values()];
    const rank = (field) => values.toSorted((a, b) => b[field] - a[field] || a.path.localeCompare(b.path))
      .slice(0, 5).map((entry) => ({ ...entry, path: entry.path.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 512), partial: !complete || !entry.complete || !measurementComplete }));
    return {
      complete, entries: diagnosing ? visited : entriesSeen, measuredEntries: measured, measurementComplete, vanishedEntries: vanished,
      rawWorkspaceBytes: [...workspaces.values()].reduce((sum, ws) => sum + ws.bytes + ws.excludedBytes + ws.protectedBytes, 0),
      topEntries: rank("entries"), topBytes: rank("bytes"),
      ...(diagnosing ? {
        bytes: totalBytes, selectedEntries: entriesSeen,
        stateDir, rootSymlink: rootInfo.rootSymlink, rootIsSymlink: rootInfo.rootSymlink,
        topLevel: [...topLevel.values()].map((entry) => ({ ...entry, partial: !complete })),
        absoluteSymlinks: [...absoluteSymlinks], absoluteSymlinkCount: absoluteSymlinks.length,
        envFiles: [...envFiles], envFileCount: envFiles.length,
        copyBudget: { entries: entriesSeen, maxEntries, exceeded: entriesSeen > maxEntries },
        selection: { ...selection },
      } : {}),
    };
  };
  _state.snapshot = snapshot;
  const budget = () => {
    if (diagnosing && nowFn() > deadline) {
      const error = new OfflineCopyError("enumerate", "diagnosis budget exhausted before the complete state tree could be counted");
      error.code = "diagnosis_budget";
      throw error;
    }
  };
  const retain = (list, entry) => { if (!diagnosing || entriesSeen <= maxEntries) list.push(entry); };
  const inspectEntry = (full, entry) => {
    if (!diagnosing) return;
    const relPath = toPosix(path.relative(stateDir, full));
    const name = relPath.split("/")[0];
    if (!topLevel.has(name)) topLevel.set(name, { path: name, entries: 0, bytes: 0 });
    top = topLevel.get(name);
    top.entries++;
    if (entry.name === ".env") envFiles.push(relPath);
    if (entry.isSymbolicLink()) {
      const target = fsModule.readlinkSync(full);
      if (path.isAbsolute(target)) absoluteSymlinks.push({ path: relPath, target });
    }
  };
  function* tick({ diagnostic = false } = {}) {
    budget();
    visited += 1;
    if (!diagnostic && ++entriesSeen > maxEntries && !diagnosing) {
      throw new OfflineCopyError("enumerate", `state tree exceeds ${maxEntries} entries — refusing an unbounded copy`);
    }
    for (const entry of active) entry.entries += 1;
    if (visited % checkpointEvery === 0) yield visited;
  }
  const noteBytes = (bytes) => {
    for (const entry of active) entry.bytes += bytes;
    totalBytes += bytes;
    if (top) top.bytes += bytes;
  };
  function* directoryEntries(directory) {
    let handle;
    try {
      handle = fsModule.opendirSync(directory);
      for (let entry; (entry = handle.readSync()) !== null;) yield entry;
    } finally { handle?.closeSync(); }
  }
  const mayMeasure = () => {
    if (diagnosing) { budget(); return true; }
    if (measurementStartedAt === null) measurementStartedAt = nowFn();
    if (measured >= measurementMaxEntries || nowFn() - measurementStartedAt >= measurementMs) {
      measurementComplete = false;
      return false;
    }
    return true;
  };
  function* measure(directory, total) {
    if (!mayMeasure()) { total.complete = false; return; }
    const stat = { path: toPosix(path.relative(stateDir, directory)), entries: 0, bytes: 0, complete: false };
    active.push(stat);
    try {
      for (const entry of directoryEntries(directory)) {
        if (!mayMeasure()) { total.complete = false; return; }
        measured += 1;
        yield* tick({ diagnostic: true });
        const full = path.join(directory, entry.name);
        inspectEntry(full, entry);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) yield* measure(full, total);
        else if (entry.isFile()) {
          try {
            const bytes = fsModule.statSync(full).size;
            total.bytes += bytes;
            total.files += 1;
            noteBytes(bytes);
          } catch (error) {
            if (isVanished(error)) { vanished += 1; continue; }
            total.complete = measurementComplete = false;
            if (diagnosing) throw error;
          }
        }
      }
      stat.complete = total.complete;
    } catch (error) {
      total.complete = measurementComplete = false;
      if (diagnosing) throw error;
    }
    finally { offer(stat); active.pop(); }
  }
  function* visit(directory, rel, workspaceRoot) {
    const stat = { path: rel, entries: 0, bytes: 0, complete: false };
    active.push(stat);
    try {
      for (const entry of directoryEntries(directory)) {
        const full = path.join(directory, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        yield* tick();
        inspectEntry(full, entry);
        const isDirectory = entry.isDirectory();
        const nextWorkspace = workspaceRoot || (isDirectory && kWorkspaceDirPattern.test(entry.name) ? full : null);
        if (nextWorkspace && !workspaces.has(nextWorkspace)) {
          workspaces.set(nextWorkspace, { bytes: 0, files: [], excludedBytes: 0, excludedFiles: 0, protectedBytes: 0 });
        }
        // Known migration inputs were enumerated independently. They remain in
        // dbs/files even when a workspace/built-in exclusion skips an ancestor.
        const required = selected.has(full);
        const db = entry.isFile() && kSqliteDbPattern.test(entry.name);
        const sidecar = entry.isFile() && kSqliteSidecarPattern.test(entry.name);
        if (entry.name === ".env") {
          const total = { bytes: 0, files: 0, complete: true };
          if (isDirectory) { if (diagnosing) yield* measure(full, total); }
          else if (entry.isFile()) {
            try { total.bytes = fsModule.statSync(full).size; total.files = 1; noteBytes(total.bytes); }
            catch (error) { if (isVanished(error)) { vanished += 1; continue; } throw error; }
          }
          selection.excludedBytes += total.bytes;
          selection.excludedFiles += total.files;
          const ws = workspaces.get(nextWorkspace);
          if (ws) { ws.excludedBytes += total.bytes; ws.excludedFiles += total.files; }
          retain(skipped, { kind: "secret", sourcePath: full, reason: "environment secrets are never archived" });
          continue;
        }
        let ruleIndex = rootRules.findIndex((rule) => rule.test(relPath, { isDirectory }));
        if (ruleIndex >= 0) ruleIndex += policy.applied.length;
        else if (workspaceRoot) {
          const wsRel = toPosix(path.relative(workspaceRoot, full));
          ruleIndex = policy.applied.findIndex((rule) => rule.test(wsRel, { isDirectory }));
        }
        if (ruleIndex >= 0 && !entry.isSymbolicLink() && !required && !db && !sidecar) {
          const total = { bytes: 0, files: 0, complete: true };
          if (isDirectory) yield* measure(full, total);
          else if (entry.isFile()) {
            try { total.bytes = fsModule.statSync(full).size; noteBytes(total.bytes); }
            catch (error) {
              if (isVanished(error)) { vanished += 1; continue; }
              total.complete = measurementComplete = false;
              if (diagnosing) throw error;
            }
            total.files = 1;
          }
          tallies[ruleIndex].files += total.files;
          tallies[ruleIndex].bytes += total.bytes;
          selection.excludedBytes += total.bytes;
          selection.excludedFiles += total.files;
          if (!total.complete) tallies[ruleIndex].partial = true;
          const ws = workspaces.get(nextWorkspace);
          if (ws) { ws.excludedBytes += total.bytes; ws.excludedFiles += total.files; }
          retain(skipped, { kind: "policy_exclude", sourcePath: full, reason: `excluded by backup policy (${rules[ruleIndex].pattern})`,
            pattern: rules[ruleIndex].pattern, ...(ruleIndex >= policy.applied.length ? { scope: "root" } : {}),
            files: total.files, bytes: total.bytes, ...(!total.complete ? { partial: true } : {}),
          });
          continue;
        }
        if (entry.isSymbolicLink()) {
          if (!workspaceRoot && relPath === "openclaw.json") {
            let target;
            try { target = fsModule.statSync(full); } catch {}
            if (target?.isFile() && !isBackupEnvPath(fsModule.realpathSync(full))) {
              if (!required) {
                retain(files, { sourcePath: full, archivePath: relPath, bytes: target.size, viaSymlink: true });
                selection.assetBytes += target.size;
                selection.assetCount++;
              }
              noteBytes(target.size);
              continue;
            }
          }
          const core = !workspaceRoot && isCoreAssetPath(relPath);
          retain(skipped, { kind: "symlink", sourcePath: full, reason: relPath === "openclaw.json" ? "config symlink does not resolve to a regular file" : core ? "core asset is a symlink (not followed)" : "symlink not followed", ...(core ? { core: true } : {}) });
          continue;
        }
        if (isDirectory) {
          if (!workspaceRoot && kSkipDirNames.has(entry.name)) {
            if (diagnosing) {
              const total = { bytes: 0, files: 0, complete: true };
              yield* measure(full, total);
              selection.excludedBytes += total.bytes;
              selection.excludedFiles += total.files;
            }
            retain(skipped, { kind: "dir", sourcePath: full, reason: "not OpenClaw state" });
            continue;
          }
          yield* visit(full, relPath, nextWorkspace);
          continue;
        }
        if (!entry.isFile()) {
          retain(skipped, { kind: "special", sourcePath: full, reason: "not a regular file" });
          continue;
        }
        let size;
        try { size = fsModule.statSync(full).size; }
        catch (error) {
          if (isVanished(error)) {
            vanished += 1;
            retain(skipped, { kind: "vanished", sourcePath: full, reason: "vanished between readdir and stat (a live writer removed it)" });
            continue;
          }
          throw new OfflineCopyError("enumerate", `cannot stat ${full}: ${error.message}`, { cause: error });
        }
        noteBytes(size);
        if (sidecar) {
          const coveredBy = full.replace(kSqliteSidecarPattern, ".sqlite");
          try { if (!fsModule.statSync(coveredBy).isFile()) throw new Error("not a regular file"); }
          catch (error) { throw new OfflineCopyError("enumerate", `database sidecar survives without its database: ${relPath}`, { cause: error }); }
          retain(skipped, { kind: "sqlite-sidecar", sourcePath: full, reason: "covered by the online sqlite copy", coveredBy });
          continue;
        }
        if (db || required) {
          if (db && !required) {
            retain(dbs, { sourcePath: full, archivePath: relPath, bytes: size });
            if (!diagnosing) selected.add(full);
            selection.dbBytes += size;
            selection.dbCount++;
          }
          if (workspaceRoot) workspaces.get(workspaceRoot).protectedBytes += size;
          continue;
        }
        const file = { sourcePath: full, archivePath: relPath, bytes: size };
        if (workspaceRoot) {
          const ws = workspaces.get(workspaceRoot);
          ws.bytes += size;
          retain(ws.files, file);
          selection.workspaceBytes += size;
          selection.workspaceFiles++;
        } else {
          retain(files, file);
          selection.assetBytes += size;
          selection.assetCount++;
        }
      }
      stat.complete = true;
    } catch (error) {
      if (error instanceof OfflineCopyError || error.code === "diagnosis_budget") throw error;
      throw new OfflineCopyError("enumerate", `cannot read ${directory}: ${error.message}`, { cause: error });
    } finally { offer(stat); active.pop(); }
  }
  yield* visit(stateDir, "", null);
  budget();
  return { dbs, files, skipped, workspaces, excludes: tallies,
    refusedExcludes: policy.refused.map(({ scope, ...entry }) => scope === "workspace" ? entry : { scope, ...entry }),
    diagnostics: snapshot(true), measurementComplete,
  };
}

const walkStateTree = (options) => {
  const state = {};
  const steps = walkStateTreeSteps({ ...options, _state: state });
  try {
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  } catch (error) {
    if (error.code === "diagnosis_budget" && !error.stage) error.stage = "enumerate";
    error.diagnostics = state.snapshot?.(false);
    throw error;
  }
  finally { steps.return(); }
};
const walkStateTreeAsync = async ({ checkpoint = () => {}, onProgress = null, ...options }) => {
  const state = {};
  const steps = walkStateTreeSteps({ ...options, _state: state });
  try {
    let step = steps.next();
    while (!step.done) {
      checkpoint("enumerate");
      onProgress?.({ stage: "enumerate", diagnostics: state.snapshot(false), rawWorkspaceBytes: state.snapshot(false).rawWorkspaceBytes });
      await yieldToEventLoop();
      step = steps.next();
    }
    onProgress?.({ stage: "enumerate", diagnostics: step.value.diagnostics, rawWorkspaceBytes: step.value.diagnostics.rawWorkspaceBytes });
    return step.value;
  } catch (error) {
    if (error.code === "diagnosis_budget" && !error.stage) error.stage = "enumerate";
    error.diagnostics = state.snapshot?.(false);
    throw error;
  }
  finally { steps.return(); }
};
module.exports = { walkStateTree, walkStateTreeAsync, kWalkCheckpointEvery, kMaxWalkEntries, kMeasurementEntries, kMeasurementMs };
