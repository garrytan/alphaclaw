const fs = require("fs");
const path = require("path");
const { writeFileAtomic, withFileLockSync } = require("./utils/safe-file");

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
    return JSON.parse(fsModule.readFileSync(configPath, "utf8"));
  } catch {
    return fallback;
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
    return parsed;
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
} = {}) => {
  const configPath = resolveOpenclawConfigPath({ openclawDir });
  writeFileAtomic(configPath, JSON.stringify(config, null, spacing), {
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
  return withFileLockSync(configPath, () => {
    const config = readOpenclawConfigForWrite({ fsModule, openclawDir });
    const result = mutate(config) || {};
    writeOpenclawConfig({ fsModule, openclawDir, config, spacing });
    return { configPath, config, ...result };
  }, { fsModule });
};

module.exports = {
  resolveOpenclawConfigPath,
  OpenclawConfigReadError,
  readOpenclawConfig,
  readOpenclawConfigForWrite,
  updateOpenclawConfig,
  writeOpenclawConfig,
};
