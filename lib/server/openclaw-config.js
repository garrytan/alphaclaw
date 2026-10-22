const fs = require("fs");
const path = require("path");
const { writeFileAtomic, withFileLockSync } = require("./utils/safe-file");
const {
  describeOnDiskAgents,
  normalizeAgentsShapeForRead,
  canonicalizeAgentsForWrite,
} = require("./openclaw-config-migrations");

const resolveOpenclawConfigPath = ({ openclawDir }) =>
  path.join(openclawDir, "openclaw.json");

// openclaw itself accepts JSON5 / ${ENV} / $include configs that this parser
// cannot read. A parse failure here therefore does NOT mean the config is
// broken — it means alphaclaw must not rewrite it, or it would wipe the
// operator's config. Read-only consumers keep the old fallback behavior;
// write-back paths must use readOpenclawConfigForWrite, which fails closed.
class OpenclawConfigReadError extends Error {
  constructor(message, { configPath, cause } = {}) {
    super(message);
    this.name = "OpenclawConfigReadError";
    this.code = "OPENCLAW_CONFIG_UNREADABLE";
    this.configPath = configPath;
    if (cause) this.cause = cause;
  }
}

const readOpenclawConfig = ({
  fsModule = fs,
  openclawDir,
  fallback = {},
  configPath = resolveOpenclawConfigPath({ openclawDir }),
} = {}) => {
  try {
    const raw = fsModule.readFileSync(configPath, "utf8");
    // Present beta's keyed `agents.entries` to every reader as `agents.list`.
    return normalizeAgentsShapeForRead(
      JSON.parse(raw),
    );
  } catch {
    return fallback;
  }
};

// Describe the agents roster currently persisted on disk (shape, legacy
// markers, size), so a write can canonicalize relative to it. A
// missing/unparseable file has no roster.
const readOnDiskAgents = ({ fsModule = fs, openclawDir } = {}) => {
  const configPath = resolveOpenclawConfigPath({ openclawDir });
  try {
    return describeOnDiskAgents(JSON.parse(fsModule.readFileSync(configPath, "utf8")));
  } catch {
    return describeOnDiskAgents({});
  }
};

// Fail-closed read for callers that will write the config back. A missing
// file is a legitimate empty config; an existing file we cannot parse throws.
const readOpenclawConfigForWrite = ({ fsModule = fs, openclawDir } = {}) => {
  const configPath = resolveOpenclawConfigPath({ openclawDir });
  let raw;
  try {
    raw = fsModule.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw new OpenclawConfigReadError(
      `Cannot read ${configPath}: ${error.message}`,
      { configPath, cause: error },
    );
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config root is not an object");
    }
    return normalizeAgentsShapeForRead(parsed);
  } catch (error) {
    throw new OpenclawConfigReadError(
      `Refusing to overwrite ${configPath}: existing file is not JSON alphaclaw can parse ` +
        `(openclaw allows JSON5/env includes). Fix or migrate the file manually. (${error.message})`,
      { configPath, cause: error },
    );
  }
};

const writeOpenclawConfig = ({
  fsModule = fs,
  openclawDir,
  config = {},
  spacing = 2,
  // When the on-disk roster is already known (e.g. inside updateOpenclawConfig
  // which just read the file), pass it to skip the peek read.
  onDiskAgents,
} = {}) => {
  const configPath = resolveOpenclawConfigPath({ openclawDir });
  const onDisk =
    onDiskAgents === undefined
      ? readOnDiskAgents({ fsModule, openclawDir })
      : onDiskAgents;
  // The in-memory config is list-shaped (normalized on read) and may carry
  // AlphaClaw's in-memory `default` marker; write the canonical 2026.10
  // roster (keyed entries, no markers, explicit ownership for fleets).
  const toWrite = canonicalizeAgentsForWrite(config, onDisk);
  writeFileAtomic(configPath, JSON.stringify(toWrite, null, spacing), {
    fsModule,
  });
  return configPath;
};

// Serialized read-modify-write for openclaw.json shared by the server and CLI.
const updateOpenclawConfig = ({
  fsModule = fs,
  openclawDir,
  mutate,
  spacing = 2,
} = {}) => {
  const configPath = resolveOpenclawConfigPath({ openclawDir });
  // 1s cap (not 5s): the sync lock busy-waits on the event loop; a contended
  // lock degrades to a fast retryable error instead of a multi-second freeze.
  return withFileLockSync(configPath, () => {
    // Capture the on-disk roster before read-normalization flattens it (we hold
    // the lock, so disk cannot change between the two).
    const onDiskAgents = readOnDiskAgents({ fsModule, openclawDir });
    const config = readOpenclawConfigForWrite({ fsModule, openclawDir });
    const result = mutate(config) || {};
    // A mutate that changed nothing signals skipWrite — the operator's file
    // must not be round-tripped (mtime churn, format normalization, config
    // watchers) for a read-only decision.
    if (result.skipWrite !== true) {
      writeOpenclawConfig({ fsModule, openclawDir, config, spacing, onDiskAgents });
    }
    return { configPath, config, ...result };
  }, { fsModule, timeoutMs: 1000 });
};

module.exports = {
  resolveOpenclawConfigPath,
  OpenclawConfigReadError,
  readOpenclawConfig,
  readOpenclawConfigForWrite,
  updateOpenclawConfig,
  writeOpenclawConfig,
};
