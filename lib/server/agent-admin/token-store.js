const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("../utils/safe-file");

const kTokenFileName = "agent-admin-token";
const kTokenBytes = 32;

// The token lives in the managed state dir (never git-synced) as PLAINTEXT:
// the CLI must read it, and the server compares timing-safe against the same
// file — hashing buys nothing when the reader and the verifier share the file.
// It is a transcript-hygiene + revocation credential, not a wall against the
// agent (see the design doc's threat model).
const resolveTokenPath = ({ openclawDir }) =>
  path.join(openclawDir, ".alphaclaw", kTokenFileName);

const mintToken = () => crypto.randomBytes(kTokenBytes).toString("hex");

// mtime/size-keyed parse cache: the bearer branch runs on every agent request,
// same pattern as readAlphaclawConfig / gateway-credential.
let kTokenReadCache = null;

const readToken = ({ fsModule = fs, openclawDir } = {}) => {
  try {
    const tokenPath = resolveTokenPath({ openclawDir });
    let stat = null;
    try {
      stat = fsModule.statSync(tokenPath);
    } catch {
      kTokenReadCache = null;
      return null;
    }
    if (
      kTokenReadCache &&
      kTokenReadCache.tokenPath === tokenPath &&
      kTokenReadCache.mtimeMs === stat.mtimeMs &&
      kTokenReadCache.size === stat.size
    ) {
      return kTokenReadCache.token;
    }
    const token = String(fsModule.readFileSync(tokenPath, "utf8")).trim();
    if (!token) return null;
    kTokenReadCache = {
      tokenPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      token,
    };
    return token;
  } catch {
    return null;
  }
};

const writeTokenFile = ({ fsModule, tokenPath, token }) => {
  fsModule.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  writeFileAtomic(tokenPath, `${token}\n`, { fsModule });
  // Atomic rename does not carry a mode; clamp after the swap. Best-effort on
  // mocked fs without chmodSync.
  if (typeof fsModule.chmodSync === "function") {
    try {
      fsModule.chmodSync(tokenPath, 0o600);
    } catch {}
  }
  kTokenReadCache = null;
};

// Idempotent: mints only when absent so restarts don't rotate the credential
// out from under a running agent session. Returns null on failure — callers
// (boot sync, skill installer) surface unavailability instead of crashing,
// per the mint-failure visibility chain (F3).
const ensureToken = ({ fsModule = fs, openclawDir } = {}) => {
  const existing = readToken({ fsModule, openclawDir });
  if (existing) return { token: existing, minted: false, error: null };
  const tokenPath = resolveTokenPath({ openclawDir });
  try {
    const token = mintToken();
    writeTokenFile({ fsModule, tokenPath, token });
    return { token, minted: true, error: null };
  } catch (error) {
    return { token: null, minted: false, error };
  }
};

const rotateToken = ({ fsModule = fs, openclawDir } = {}) => {
  const tokenPath = resolveTokenPath({ openclawDir });
  const token = mintToken();
  writeTokenFile({ fsModule, tokenPath, token });
  return token;
};

// Flag off ⇒ credential gone ⇒ the bearer branch is inert everywhere.
const removeToken = ({ fsModule = fs, openclawDir } = {}) => {
  const tokenPath = resolveTokenPath({ openclawDir });
  try {
    fsModule.unlinkSync(tokenPath);
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  kTokenReadCache = null;
  return true;
};

module.exports = {
  kTokenFileName,
  resolveTokenPath,
  readToken,
  ensureToken,
  rotateToken,
  removeToken,
};
