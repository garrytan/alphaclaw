// Streaming full-copy walk. Optional debris measurement has its own global
// budget and never consumes the copy-set cap or turns sampling into a failure.
const fs = require("fs");
const path = require("path");
const { OfflineCopyError } = require("./openclaw-backup-errors");
const { resolveBackupPolicy, isCoreAssetPath } = require("./openclaw-backup-policy");
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
  _state,
}) {
  const dbs = [...(inventory?.dbs || [])];
  const files = [...(inventory?.files || [])];
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
  const snapshot = (complete = false) => {
    const values = [...new Map([...leaders.entries, ...leaders.bytes, ...active]
      .filter((entry) => entry.path).map((entry) => [entry.path, entry])).values()];
    const rank = (field) => values.toSorted((a, b) => b[field] - a[field] || a.path.localeCompare(b.path))
      .slice(0, 5).map((entry) => ({ ...entry, path: entry.path.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 512), partial: !complete || !entry.complete || !measurementComplete }));
    return {
      complete, entries: entriesSeen, measuredEntries: measured, measurementComplete,
      rawWorkspaceBytes: [...workspaces.values()].reduce((sum, ws) => sum + ws.bytes + ws.excludedBytes + ws.protectedBytes, 0),
      topEntries: rank("entries"), topBytes: rank("bytes"),
    };
  };
  _state.snapshot = snapshot;
  function* tick({ diagnostic = false } = {}) {
    visited += 1;
    if (!diagnostic && ++entriesSeen > maxEntries) {
      throw new OfflineCopyError("enumerate", `state tree exceeds ${maxEntries} entries — refusing an unbounded copy`);
    }
    for (const entry of active) entry.entries += 1;
    if (visited % checkpointEvery === 0) yield visited;
  }
  const noteBytes = (bytes) => { for (const entry of active) entry.bytes += bytes; };
  function* directoryEntries(directory) {
    let handle;
    try {
      handle = fsModule.opendirSync(directory);
      for (let entry; (entry = handle.readSync()) !== null;) yield entry;
    } finally { handle?.closeSync(); }
  }
  const mayMeasure = () => {
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
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) yield* measure(full, total);
        else if (entry.isFile()) {
          try {
            const bytes = fsModule.statSync(full).size;
            total.bytes += bytes;
            total.files += 1;
            noteBytes(bytes);
          } catch { total.complete = measurementComplete = false; }
        }
      }
      stat.complete = total.complete;
    } catch { total.complete = measurementComplete = false; }
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
            catch { total.complete = measurementComplete = false; }
            total.files = 1;
          }
          tallies[ruleIndex].files += total.files;
          tallies[ruleIndex].bytes += total.bytes;
          if (!total.complete) tallies[ruleIndex].partial = true;
          const ws = workspaces.get(nextWorkspace);
          if (ws) { ws.excludedBytes += total.bytes; ws.excludedFiles += total.files; }
          skipped.push({ kind: "policy_exclude", sourcePath: full, reason: `excluded by backup policy (${rules[ruleIndex].pattern})`,
            pattern: rules[ruleIndex].pattern, ...(ruleIndex >= policy.applied.length ? { scope: "root" } : {}),
            files: total.files, bytes: total.bytes, ...(!total.complete ? { partial: true } : {}),
          });
          continue;
        }
        if (entry.isSymbolicLink()) {
          if (!workspaceRoot && relPath === "openclaw.json") {
            let target;
            try { target = fsModule.statSync(full); } catch {}
            if (target?.isFile()) {
              if (!required) files.push({ sourcePath: full, archivePath: relPath, bytes: target.size, viaSymlink: true });
              noteBytes(target.size);
              continue;
            }
          }
          const core = !workspaceRoot && isCoreAssetPath(relPath);
          skipped.push({ kind: "symlink", sourcePath: full, reason: relPath === "openclaw.json" ? "config symlink does not resolve to a regular file" : core ? "core asset is a symlink (not followed)" : "symlink not followed", ...(core ? { core: true } : {}) });
          continue;
        }
        if (isDirectory) {
          if (!workspaceRoot && kSkipDirNames.has(entry.name)) {
            skipped.push({ kind: "dir", sourcePath: full, reason: "not OpenClaw state" });
            continue;
          }
          yield* visit(full, relPath, nextWorkspace);
          continue;
        }
        if (!entry.isFile()) {
          skipped.push({ kind: "special", sourcePath: full, reason: "not a regular file" });
          continue;
        }
        let size;
        try { size = fsModule.statSync(full).size; }
        catch (error) { throw new OfflineCopyError("enumerate", `cannot stat ${full}: ${error.message}`, { cause: error }); }
        noteBytes(size);
        if (sidecar) {
          const coveredBy = full.replace(kSqliteSidecarPattern, ".sqlite");
          try { if (!fsModule.statSync(coveredBy).isFile()) throw new Error("not a regular file"); }
          catch (error) { throw new OfflineCopyError("enumerate", `database sidecar survives without its database: ${relPath}`, { cause: error }); }
          skipped.push({ kind: "sqlite-sidecar", sourcePath: full, reason: "covered by the online sqlite copy", coveredBy });
          continue;
        }
        if (db || required) {
          if (db && !required) { dbs.push({ sourcePath: full, archivePath: relPath, bytes: size }); selected.add(full); }
          if (workspaceRoot) workspaces.get(workspaceRoot).protectedBytes += size;
          continue;
        }
        const file = { sourcePath: full, archivePath: relPath, bytes: size };
        if (workspaceRoot) {
          const ws = workspaces.get(workspaceRoot);
          ws.bytes += size;
          ws.files.push(file);
        } else files.push(file);
      }
      stat.complete = true;
    } catch (error) {
      if (error instanceof OfflineCopyError) throw error;
      throw new OfflineCopyError("enumerate", `cannot read ${directory}: ${error.message}`, { cause: error });
    } finally { offer(stat); active.pop(); }
  }
  yield* visit(stateDir, "", null);
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
  } catch (error) { error.diagnostics = state.snapshot?.(false); throw error; }
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
  } catch (error) { error.diagnostics = state.snapshot?.(false); throw error; }
  finally { steps.return(); }
};
module.exports = { walkStateTree, walkStateTreeAsync, kWalkCheckpointEvery, kMaxWalkEntries, kMeasurementEntries, kMeasurementMs };
