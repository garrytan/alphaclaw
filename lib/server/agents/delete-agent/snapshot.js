const fs = require("fs");
const path = require("path");
const { resolveAgentDirPath, resolveAgentWorkspacePath, kDefaultAgentId } = require("../shared");
const { parseSingleJson } = require("./gateway-delete");
const { redactSecretText } = require("../../utils/redact");

const kDatabaseBasename = "openclaw-agent.sqlite";
const kSnapshotMarginBytes = 256 * 1024 * 1024;
const kMeasureEntryCap = 200_000;
const kCopyConcurrency = 8;

const resolveEntryWorkspace = ({ entry, cfg, openclawDir }) => {
  const id = String(entry?.id || "").trim();
  if (entry?.workspace) return path.resolve(String(entry.workspace));
  if (id === kDefaultAgentId && cfg?.agents?.defaults?.workspace) return path.resolve(String(cfg.agents.defaults.workspace));
  return resolveAgentWorkspacePath({ OPENCLAW_DIR: openclawDir, agentId: id });
};

// Where OpenClaw keeps one agent's data (agents.delete's own resolution:
// agentDir, workspace, sessions dir; the database inside agentDir).
const resolveAgentPaths = ({ cfg, agentId, openclawDir }) => {
  const entry = cfg.agents.list.find((item) => String(item.id || "").trim() === agentId) || { id: agentId };
  const agentDir = entry.agentDir ? path.resolve(String(entry.agentDir)) : resolveAgentDirPath({ OPENCLAW_DIR: openclawDir, agentId });
  return {
    entry,
    agentDir,
    databasePath: path.join(agentDir, kDatabaseBasename),
    workspace: resolveEntryWorkspace({ entry, cfg, openclawDir }),
    sessionsDir: path.join(openclawDir, "agents", agentId, "sessions"),
  };
};

const isInside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
};

// OpenClaw keeps a workspace that is the same path as, inside, or contains a
// surviving agent's workspace; everything else goes to its Trash.
const findWorkspaceOwner = ({ cfg, agentId, workspace, openclawDir }) => {
  for (const entry of cfg.agents.list) {
    const id = String(entry.id || "").trim();
    if (!id || id === agentId) continue;
    const other = resolveEntryWorkspace({ entry, cfg, openclawDir });
    if (isInside(workspace, other) || isInside(other, workspace)) return id;
  }
  return null;
};

// Where the agent's chat history lives, and whether OpenClaw's agent snapshot
// (which reads exactly <agentDir>/openclaw-agent.sqlite) covers all of it.
const assessHistoryCoverage = ({ cfg, agentId, paths, registered, openclawDir, fsModule = fs }) => {
  const sharedOwner = String(cfg?.agents?.defaults?.sessionStore?.agentId || "").trim();
  if (sharedOwner && sharedOwner !== agentId) {
    return { available: false, reason: `Its chat history is stored with agent ${sharedOwner}, so a snapshot of this agent wouldn't include it.` };
  }
  if (registered === null) return { available: false, reason: "OpenClaw's database registry couldn't be read." };
  const canonical = path.resolve(paths.databasePath);
  const resolvedRows = registered.map((row) => path.resolve(openclawDir, row));
  if (resolvedRows.length > 1) return { available: false, reason: "OpenClaw has more than one database registered for this agent." };
  if (resolvedRows.length === 1 && resolvedRows[0] !== canonical) {
    return { available: false, reason: "Its database isn't in the standard place, so OpenClaw's snapshot wouldn't read it." };
  }
  let exists = false;
  try {
    exists = fsModule.lstatSync(canonical).isFile();
  } catch {}
  if (resolvedRows.length === 1 && !exists) return { available: false, reason: "Its registered database file is missing." };
  return { available: true, reason: null, hasDatabase: exists };
};

const databaseFamilyBytes = (databasePath, fsModule = fs) => {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += Number(fsModule.lstatSync(databasePath + suffix).size) || 0;
    } catch {}
  }
  return total;
};

// Async, capped walk: never follows symlinks; past the cap the size is a
// lower bound (approximate: true).
const measureTree = async (root, { cap = kMeasureEntryCap, fsp = fs.promises } = {}) => {
  let stat;
  try {
    stat = await fsp.lstat(root);
  } catch {
    return { exists: false, bytes: 0, files: 0, approximate: false };
  }
  if (!stat.isDirectory()) return { exists: true, bytes: stat.isFile() ? Number(stat.size) : 0, files: 1, approximate: false };
  let bytes = 0;
  let files = 0;
  let seen = 0;
  const queue = [root];
  while (queue.length) {
    const dir = queue.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > cap) return { exists: true, bytes, files, approximate: true };
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) {
        files += 1;
        try {
          bytes += Number((await fsp.lstat(full)).size) || 0;
        } catch {}
      }
    }
  }
  return { exists: true, bytes, files, approximate: false };
};

// OpenClaw refuses a snapshot repository whose ancestors another user could
// replace (group/world-writable without the sticky bit, or owned by someone
// other than this user or root). Checked here so that refusal comes before
// the click, not after.
const checkRepositoryAncestors = (dir, { fsModule = fs, uid = process.getuid?.() } = {}) => {
  let current = path.resolve(dir);
  for (;;) {
    let stat = null;
    try {
      stat = fsModule.statSync(current);
    } catch {}
    if (stat) {
      const sticky = (stat.mode & 0o1000) !== 0;
      if ((stat.mode & 0o022) !== 0 && !sticky) return `${current} is writable by other users, which OpenClaw's snapshot refuses.`;
      if (uid !== undefined && stat.uid !== uid && stat.uid !== 0) return `${current} is owned by another user, which OpenClaw's snapshot refuses.`;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const nearestExisting = (dir, fsModule = fs) => {
  let current = path.resolve(dir);
  while (!fsModule.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
};

const freeBytes = async (dir, { fsp = fs.promises, fsModule = fs } = {}) => {
  try {
    const stats = await fsp.statfs(nearestExisting(dir, fsModule));
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
};

// The snapshot writes the database with its embedded cold transcripts once
// and verify stages one more copy; the workspace is copied once.
const snapshotNeedBytes = ({ databaseBytes, historyBytes, workspaceBytes }) =>
  2 * (databaseBytes + historyBytes) + workspaceBytes + kSnapshotMarginBytes;

// Regular files, directories and symlinks (kept as links); anything else is
// skipped and listed. Bounded concurrency, abortable, never blocks the loop.
const copyTree = async (source, target, { signal, fsp = fs.promises } = {}) => {
  const skipped = [];
  let files = 0;
  let bytes = 0;
  const pending = [];
  let active = 0;
  let failure = null;
  const run = async (task) => {
    while (active >= kCopyConcurrency) await Promise.race(pending);
    active += 1;
    const promise = task()
      .catch((error) => {
        failure = failure || error;
      })
      .finally(() => {
        active -= 1;
        pending.splice(pending.indexOf(promise), 1);
      });
    pending.push(promise);
  };
  const visit = async (from, to, relative) => {
    if (signal?.aborted) throw Object.assign(new Error("copy timed out"), { code: "ETIMEDOUT" });
    if (failure) throw failure;
    const stat = await fsp.lstat(from);
    if (stat.isSymbolicLink()) {
      await fsp.symlink(await fsp.readlink(from), to);
      return;
    }
    if (stat.isDirectory()) {
      await fsp.mkdir(to, { mode: stat.mode & 0o777 });
      for (const name of await fsp.readdir(from)) {
        await visit(path.join(from, name), path.join(to, name), path.join(relative, name));
      }
      return;
    }
    if (stat.isFile()) {
      await run(async () => {
        if (signal?.aborted) throw Object.assign(new Error("copy timed out"), { code: "ETIMEDOUT" });
        await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
        files += 1;
        bytes += Number(stat.size) || 0;
      });
      return;
    }
    skipped.push({ path: relative, reason: stat.isSocket() ? "socket" : stat.isFIFO() ? "fifo" : "special file" });
  };
  await visit(source, target, ".");
  await Promise.all(pending);
  if (failure) throw failure;
  return { files, bytes, skipped };
};

class SnapshotError extends Error {
  constructor(message, { status = 502, code = "snapshot_failed" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const runSnapshotCli = async ({ execFileCmd, env, args, timeoutMs, label }) => {
  try {
    const stdout = await execFileCmd("openclaw", args, { env, processGroup: true, timeoutMs });
    const body = parseSingleJson(stdout);
    if (!body || body.ok === false) throw new SnapshotError(`OpenClaw's ${label} didn't report success.`);
    return body;
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    if (error?.timedOut) throw new SnapshotError(`OpenClaw's ${label} timed out.`);
    const body = parseSingleJson(error?.stdout);
    const reason = body?.error?.message || body?.error || String(error?.stderr || error?.message || "").trim().split("\n").pop();
    throw new SnapshotError(`OpenClaw's ${label} failed: ${redactSecretText(String(reason || "unknown error")).slice(0, 300)}`);
  }
};

const createDatabaseSnapshot = async ({ execFileCmd, env, agentId, repository, scratch, timeoutMs }) => {
  const created = await runSnapshotCli({
    execFileCmd,
    env,
    args: ["backup", "sqlite", "create", "--agent", agentId, "--repository", repository, "--json"],
    timeoutMs,
    label: "snapshot",
  });
  const snapshotPath = String(created.snapshotPath || "");
  if (!snapshotPath || path.dirname(path.resolve(snapshotPath)) !== path.resolve(repository)) {
    throw new SnapshotError("OpenClaw's snapshot didn't say where it wrote the snapshot.");
  }
  const verified = await runSnapshotCli({
    execFileCmd,
    env,
    args: ["backup", "sqlite", "verify", snapshotPath, "--scratch", scratch, "--json"],
    timeoutMs,
    label: "snapshot check",
  });
  if (verified.manifest?.artifact?.sha256 !== created.manifest?.artifact?.sha256) {
    throw new SnapshotError("OpenClaw's snapshot check didn't match the snapshot it wrote.");
  }
  return { snapshotId: path.basename(snapshotPath), manifest: created.manifest || null };
};

module.exports = {
  SnapshotError,
  assessHistoryCoverage,
  checkRepositoryAncestors,
  copyTree,
  createDatabaseSnapshot,
  databaseFamilyBytes,
  findWorkspaceOwner,
  freeBytes,
  measureTree,
  resolveAgentPaths,
  snapshotNeedBytes,
};
