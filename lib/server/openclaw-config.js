const fs = require("fs");
const path = require("path");
const { writeFileAtomic, withFileLockSync } = require("./utils/safe-file");
const {
  detectAgentsShape,
  normalizeAgentsShapeForRead,
  withAgentsShapeForWrite,
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
} = {}) => {
  const configPath = resolveOpenclawConfigPath({ openclawDir });
  try {
    // Present beta's keyed `agents.entries` to every reader as `agents.list`.
    return normalizeAgentsShapeForRead(
      JSON.parse(fsModule.readFileSync(configPath, "utf8")),
    );
  } catch {
    return fallback;
  }
};

// Detect the agents shape currently persisted on disk, so a write preserves it. A
// missing/unparseable file has no shape ("none").
const detectOnDiskAgentsShape = ({ fsModule = fs, openclawDir } = {}) => {
  const configPath = resolveOpenclawConfigPath({ openclawDir });
  try {
    return detectAgentsShape(JSON.parse(fsModule.readFileSync(configPath, "utf8")));
  } catch {
    return "none";
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
  // When the on-disk agents shape is already known (e.g. inside updateOpenclawConfig
  // which just read the file), pass it to skip the peek read.
  agentsShape,
} = {}) => {
  const configPath = resolveOpenclawConfigPath({ openclawDir });
  const shape =
    agentsShape === undefined
      ? detectOnDiskAgentsShape({ fsModule, openclawDir })
      : agentsShape;
  // Preserve beta's keyed `agents.entries` shape on write — the in-memory config is
  // always list-shaped (normalized on read), so convert back when the file uses
  // entries. Never downgrades a beta config to the legacy list shape.
  const toWrite = withAgentsShapeForWrite(config, shape);
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
    // Capture the on-disk agents shape before read-normalization flattens it, so the
    // write preserves it (we hold the lock, so disk cannot change between the two).
    const agentsShape = detectOnDiskAgentsShape({ fsModule, openclawDir });
    const config = readOpenclawConfigForWrite({ fsModule, openclawDir });
    const result = mutate(config) || {};
    // A mutate that changed nothing signals skipWrite — the operator's file
    // must not be round-tripped (mtime churn, format normalization, config
    // watchers) for a read-only decision.
    if (result.skipWrite !== true) {
      writeOpenclawConfig({ fsModule, openclawDir, config, spacing, agentsShape });
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
