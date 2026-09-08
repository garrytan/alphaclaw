const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { resolveOpenclawConfigPath, readOpenclawConfigForWrite } = require("./openclaw-config");
const { resolveAlphaclawConfigPath } = require("./alphaclaw-config");
const { isConfigUnreadableError, configUnreadableEnvelope, noteConfigUnreadable } = require("./utils/config-unreadable");

const kConsentTtlMs = 10 * 60 * 1000;
const kMaxConsentEntries = 128;
const kMaxOfferBytes = 256 * 1024;
const kMaxDatabases = 512;
const kArtifactReadBudget = 8 * 1024 * 1024;
const kConfigReadBudget = 1024 * 1024;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const factsDigest = (facts) => digest(JSON.stringify(facts));
const refusal = (code) => Object.assign(new Error(code), { code });
const statIdentity = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];

const consentConfigError = (error) => {
  noteConfigUnreadable({ error, source: "backup_risk_consent" });
  const envelope = configUnreadableEnvelope(error);
  return { ...envelope, message: `Backup-risk confirmation is refused. ${envelope.error}` };
};

// These two guarded files govern the selected build and gateway ownership.
// Only digests and file identities enter the offer; parsed configuration and
// credentials never leave this bounded read or enter logs/ledger/SSE.
const fingerprintConsentConfigs = ({ openclawDir, fsModule = fs }) => {
  const entries = [
    { file: resolveOpenclawConfigPath({ openclawDir }), code: "OPENCLAW_CONFIG_UNREADABLE" },
    { file: resolveAlphaclawConfigPath({ openclawDir }), code: "ALPHACLAW_CONFIG_UNREADABLE" },
  ];
  return entries.map(({ file, code }) => {
    let fd;
    try {
      fd = fsModule.openSync(file, "r");
      const before = fsModule.fstatSync(fd);
      if (!before.isFile() || before.size > kConfigReadBudget) throw new Error("unverified");
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = fsModule.readSync(fd, buffer, length, buffer.length - length, length);
        if (!count) break;
        length += count;
      }
      const after = fsModule.fstatSync(fd);
      if (length !== before.size || JSON.stringify(statIdentity(before)) !== JSON.stringify(statIdentity(after)) ||
          JSON.stringify(statIdentity(after)) !== JSON.stringify(statIdentity(fsModule.statSync(file)))) throw new Error("changed");
      const bytes = buffer.subarray(0, length);
      const raw = bytes.toString("utf8");
      // Reuse the strict OpenClaw parser on these exact bounded bytes, without
      // reopening a possibly replaced or grown file through an unbounded read.
      const parsed = code === "OPENCLAW_CONFIG_UNREADABLE"
        ? readOpenclawConfigForWrite({ openclawDir, fsModule: { readFileSync: () => raw } })
        : JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("unverified");
      if (code === "OPENCLAW_CONFIG_UNREADABLE") {
        const pending = [parsed];
        while (pending.length) {
          const value = pending.pop();
          if (!value || typeof value !== "object") continue;
          // Included files are outside this guarded snapshot. A waiver cannot
          // claim to verify their effective configuration from the root alone.
          if (Object.hasOwn(value, "$include")) throw new Error("unverified include");
          pending.push(...Object.values(value));
        }
      }
      return { file, identity: statIdentity(after), sha256: digest(bytes) };
    } catch (error) {
      if (fd === undefined && error.code === "ENOENT") return { file, missing: true };
      // Parse errors can contain secret input excerpts: expose only the shared
      // typed vocabulary and a fixed message, never the parser's raw error.
      throw Object.assign(new Error(`Cannot verify ${path.basename(file)} for backup-risk confirmation.`), { code, configPath: file });
    } finally {
      if (fd !== undefined) fsModule.closeSync(fd);
    }
  });
};

// Only this process can issue a waiver. The raw bearer is returned once and
// never retained; the failed operation and the human session remain bound
// through issuance, queueing, and the final one-use consume.
const createBackupRiskConsentStore = ({ now = Date.now, ttlMs = kConsentTtlMs, maxEntries = kMaxConsentEntries } = {}) => {
  const offers = new Map();
  const tokens = new Map();
  const sweep = () => {
    for (const [key, entry] of offers) if (entry.expiresAt <= now()) offers.delete(key);
    for (const [key, entry] of tokens) if (entry.expiresAt <= now() || !offers.has(entry.operationId)) tokens.delete(key);
  };
  const bound = (map) => {
    while (map.size > maxEntries) map.delete(map.keys().next().value);
  };
  const offer = ({ operationId, sessionId, facts, backup, preflight }) => {
    sweep();
    if (!operationId || !sessionId) return false;
    if (Buffer.byteLength(JSON.stringify({ facts, backup, preflight })) > kMaxOfferBytes) return false;
    offers.set(operationId, { operationId, sessionId, facts: structuredClone(facts), factsHash: factsDigest(facts),
      backup: structuredClone(backup), preflight: structuredClone(preflight), expiresAt: now() + ttlMs });
    bound(offers);
    return true;
  };
  const getOffer = (operationId, sessionId) => {
    sweep();
    const entry = offers.get(operationId);
    return entry && entry.sessionId === sessionId ? structuredClone(entry) : null;
  };
  const issue = ({ operationId, sessionId, facts }) => {
    const entry = getOffer(operationId, sessionId);
    if (!entry || entry.factsHash !== factsDigest(facts)) return null;
    const token = crypto.randomBytes(32).toString("base64url");
    tokens.set(digest(token), { operationId, sessionId, factsHash: entry.factsHash, expiresAt: entry.expiresAt });
    bound(tokens);
    return { token, expiresAt: entry.expiresAt };
  };
  const peek = (token, sessionId) => {
    sweep();
    if (typeof token !== "string" || token.length > 128 || !sessionId) return null;
    const entry = tokens.get(digest(token));
    if (entry?.sessionId !== sessionId) return null;
    const offer = getOffer(entry.operationId, sessionId);
    return offer?.factsHash === entry.factsHash ? offer : null;
  };
  const consume = ({ token, sessionId, facts }) => {
    const entry = peek(token, sessionId);
    if (!entry || entry.factsHash !== factsDigest(facts)) return null;
    offers.delete(entry.operationId);
    tokens.delete(digest(token));
    sweep();
    return entry;
  };
  return { offer, getOffer, issue, peek, consume, size: () => { sweep(); return { offers: offers.size, tokens: tokens.size }; } };
};

// The verified, managed artifact is immutable. Bind its directory identity
// plus the executable and public metadata bytes so replacement of an overlay
// (including another copy with the same version) invalidates the approval.
const fingerprintBuild = async (build, { fsModule = fs } = {}) => {
  if (!build?.bin || !build.packageDir) throw refusal("build_unverified");
  const fsp = fsModule.promises || fs.promises;
  const hash = crypto.createHash("sha256");
  const signature = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  const rootBefore = await fsp.stat(build.packageDir);
  let remaining = kArtifactReadBudget;
  for (const file of [path.join(build.packageDir, "package.json"), build.bin]) {
    const before = await fsp.stat(file);
    if (!before.isFile() || before.size > remaining) throw refusal("build_unverified");
    remaining -= before.size;
    const bytes = await fsp.readFile(file);
    const after = await fsp.stat(file);
    if (JSON.stringify(signature(before)) !== JSON.stringify(signature(after))) throw refusal("build_changed");
    hash.update(file).update(JSON.stringify(signature(after))).update(bytes);
  }
  const rootAfter = await fsp.stat(build.packageDir);
  if (JSON.stringify(signature(rootBefore)) !== JSON.stringify(signature(rootAfter))) throw refusal("build_changed");
  return hash.update(JSON.stringify(signature(rootAfter))).digest("hex");
};

// A WAL commit need not change user_version or the main DB header. Bind
// those files separately using bounded header reads plus filesystem change
// identity; never hash a multi-GB database during a human confirmation.
const fingerprintDatabase = async (filePath, { fsModule = fs } = {}) => {
  const fsp = fsModule.promises || fs.promises;
  const facts = [];
  for (const [suffix, headerBytes] of [["", 100], ["-wal", 32], ["-journal", 28]]) {
    let handle;
    try {
      handle = await fsp.open(`${filePath}${suffix}`, "r");
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("state_db_unverified");
      const header = Buffer.alloc(headerBytes);
      const { bytesRead } = await handle.read(header, 0, headerBytes, 0);
      const after = await handle.stat();
      const named = await fsp.stat(`${filePath}${suffix}`);
      if (JSON.stringify(statIdentity(before)) !== JSON.stringify(statIdentity(after)) ||
          JSON.stringify(statIdentity(after)) !== JSON.stringify(statIdentity(named))) throw new Error("state_db_changed");
      facts.push({ suffix, identity: statIdentity(after), header: digest(header.subarray(0, bytesRead)) });
    } catch (error) {
      if (error.code === "ENOENT" && !handle && suffix) facts.push({ suffix, missing: true });
      else throw Object.assign(new Error("Database state cannot be verified."), { code: error.message === "state_db_changed" ? "state_db_changed" : "state_db_unverified" });
    } finally {
      await handle?.close();
    }
  }
  return facts;
};

const assertDatabaseFilesUnchanged = (databases, fsModule = fs) => {
  for (const entry of databases) {
    for (const file of entry.files || []) {
      let current;
      try { current = fsModule.statSync(`${entry.path}${file.suffix}`); } catch (error) {
        if (error.code !== "ENOENT" || !file.missing) throw refusal("state_db_changed");
      }
      if (file.missing ? Boolean(current) : JSON.stringify(statIdentity(current)) !== JSON.stringify(file.identity)) throw refusal("state_db_changed");
    }
  }
};

const createBackupRiskCoordinator = ({ now, fsModule, openclawDir, describeSource, describeTarget, readVersions,
  getChannelInfo, isQuiet, checkDisk, assertPolicy, readRun, makeError, canIssue = () => true }) => {
  const store = createBackupRiskConsentStore({ now });
  const fail = (code) => { throw Object.assign(new Error(code), { code }); };
  const collectFacts = async (target, { hold = null, intent, recoveryHold = null, strict = true } = {}) => {
    assertPolicy({ hold, intent, recoveryHold, strict });
    if (isQuiet()) fail("state_db_quiet");
    if (!checkDisk(target)) fail("insufficient_disk");
    const info = getChannelInfo();
    if (info.stateCorrupted) fail("state_corrupted");
    const configurations = strict ? fingerprintConsentConfigs({ openclawDir, fsModule }) : null;
    const source = await describeSource();
    const candidate = await describeTarget(target);
    if (!source || !candidate) fail("build_unverified");
    const versions = await readVersions();
    if (versions.entries.length > kMaxDatabases) fail("state_db_unverified");
    const databases = versions.entries.map((entry) => ({ path: entry.path, kind: entry.kind,
      userVersion: entry.userVersion, status: entry.status })).sort((a, b) => a.path.localeCompare(b.path));
    for (const entry of databases) {
      if (entry.status === "missing") continue;
      if (entry.status !== "ok") {
        if (strict) fail(entry.status === "corrupt" ? "state_db_unreadable" : "state_db_unverified");
        continue;
      }
      const supported = candidate.schemas?.[entry.kind];
      if (!Number.isSafeInteger(supported)) {
        if (strict) fail("target_unverified");
        continue;
      }
      if (entry.userVersion > supported) fail("db_preflight_failed");
    }
    const sourceFingerprint = await fingerprintBuild(source, { fsModule });
    const targetFingerprint = await fingerprintBuild(candidate, { fsModule });
    for (const entry of databases) {
      if (entry.status === "ok") entry.files = await fingerprintDatabase(entry.path, { fsModule });
    }
    assertPolicy({ hold, intent, recoveryHold, strict });
    if (isQuiet()) fail("state_db_quiet");
    // No await between this last change check and returning the snapshot to
    // the consume path: a writer during artifact/header reads invalidates it.
    assertDatabaseFilesUnchanged(databases, fsModule);
    if (strict && JSON.stringify(configurations) !== JSON.stringify(fingerprintConsentConfigs({ openclawDir, fsModule }))) fail("backup_consent_stale");
    return {
      source: { ...source, fingerprint: sourceFingerprint },
      target: { ...target, ...candidate, fingerprint: targetFingerprint },
      state: { pinVersion: info.pinVersion, expectedVersion: info.expectedVersion, appliedId: info.appliedId },
      databases,
      ...(strict ? { configurations } : {}),
    };
  };
  const request = async ({ operationId, consentSessionId }) => {
    const offer = store.getOffer(operationId, consentSessionId);
    const run = readRun(operationId);
    if (!canIssue() || !offer || run?.state !== "failed" || run?.result?.backupRiskEligible !== true) {
      return { status: 409, body: makeError("backup_consent_required", "This failed update no longer has an eligible backup-risk confirmation.", "Retry the update and review its current backup result.") };
    }
    try {
      const facts = await collectFacts(offer.facts.target);
      const issued = store.issue({ operationId, sessionId: consentSessionId, facts });
      if (!issued) fail("backup_consent_stale");
      const { channel, version, sha } = facts.target;
      return { status: 200, body: { ok: true, confirmNoBackupToken: issued.token,
        expiresAt: new Date(issued.expiresAt).toISOString(), operationId,
        target: channel === "dev" ? { channel, sha } : { channel, version } } };
    } catch (error) {
      if (isConfigUnreadableError(error)) return { status: 409, body: consentConfigError(error) };
      return { status: 409, body: makeError(error.code || "backup_consent_stale", "The update facts changed or cannot be verified, so the backup risk cannot be approved.", "Retry the update and review its current result.") };
    }
  };
  return { collectFacts, request, offer: store.offer, peek: store.peek, consume: store.consume };
};

module.exports = { createBackupRiskConsentStore, createBackupRiskCoordinator, fingerprintBuild, fingerprintDatabase,
  consentConfigError,
  kConsentTtlMs, kMaxConsentEntries };
