const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("../../utils/safe-file");

// Durable record of every delete AlphaClaw sent to OpenClaw, snapshot on or
// off, so an outcome survives a reload, another admin, and a crash between
// the send and the answer. Lives beside the archives, outside OpenClaw's
// state directory and git sync. A delete in flight is "submitted"; it is
// "settled" once its outcome is known or decided after a restart.
const kOperationsDirName = ".operations";
const kStagingPrefix = ".staging-";
const kOpSchema = "alphaclaw.agent-delete-op/1";
const kMaxRecords = 200;

const operationsDir = (archivesRoot) => path.join(archivesRoot, kOperationsDirName);

const ensurePrivateDir = (dir, fsModule = fs) => {
  fsModule.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fsModule.chmodSync(dir, 0o700);
  } catch {}
};

const writeOperation = ({ archivesRoot, record, fsModule = fs }) => {
  ensurePrivateDir(archivesRoot, fsModule);
  ensurePrivateDir(operationsDir(archivesRoot), fsModule);
  const next = { schema: kOpSchema, ...record };
  writeFileAtomic(path.join(operationsDir(archivesRoot), `${record.opId}.json`), JSON.stringify(next, null, 2) + "\n", { fsModule, mode: 0o600 });
  return next;
};

const readOperations = ({ archivesRoot, fsModule = fs }) => {
  let names;
  try {
    names = fsModule.readdirSync(operationsDir(archivesRoot)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    try {
      const record = JSON.parse(fsModule.readFileSync(path.join(operationsDir(archivesRoot), name), "utf8"));
      if (record?.schema === kOpSchema && record.opId && record.agentId) records.push(record);
    } catch {}
  }
  return records.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0)).slice(0, kMaxRecords);
};

// No delete is running when the server starts, and a staging directory is
// only ever renamed into place right before a delete is sent; anything still
// named .staging-* never reached OpenClaw and holds nothing to keep.
const removeStaleStaging = ({ archivesRoot, fsModule = fs, logger = console }) => {
  let names;
  try {
    names = fsModule.readdirSync(archivesRoot);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(kStagingPrefix)) continue;
    try {
      fsModule.rmSync(path.join(archivesRoot, name), { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      logger.warn?.(`[alphaclaw] could not remove an unfinished agent snapshot (${name}): ${error.message}`);
    }
  }
  return removed;
};

// Count and size of the snapshots Delete Agent kept (from their manifests;
// nothing prunes them, so the boot report says what they hold).
const summarizeAgentArchives = ({ archivesRoot, fsModule = fs }) => {
  let names;
  try {
    names = fsModule.readdirSync(archivesRoot).filter((name) => !name.startsWith("."));
  } catch {
    return { count: 0, bytes: 0 };
  }
  let bytes = 0;
  let count = 0;
  for (const name of names) {
    try {
      const manifest = JSON.parse(fsModule.readFileSync(path.join(archivesRoot, name, "manifest.json"), "utf8"));
      count += 1;
      bytes += (Number(manifest?.database?.manifest?.artifact?.sizeBytes) || 0) + (Number(manifest?.workspace?.bytes) || 0);
    } catch {}
  }
  return { count, bytes };
};

module.exports = {
  kStagingPrefix,
  summarizeAgentArchives,
  ensurePrivateDir,
  readOperations,
  removeStaleStaging,
  writeOperation,
};
