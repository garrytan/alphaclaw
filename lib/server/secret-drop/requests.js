// Secret drop requests: one-time links that let a signed-in admin type a value
// into AlphaClaw instead of a chat. The link token is returned once, when the
// request is made, and only its sha256 is kept; a token is resolved by a
// constant-time compare against every held request. No value is ever held
// here: the save reads it from the request body and forgets it.
//
// Records (names, the token's hash, the page's CSRF value, status, which
// stores hold the key and where it is usable) are kept in a 0600 JSON file
// under AlphaClaw's root (db/secret-drop-requests.json) when a store is
// given, so an open link survives an AlphaClaw restart within its 15 minutes
// and a used link still shows what its save did. A finished or expired record
// stays readable for a day, then it is dropped. A save marks its record
// (saveStartedAt) before it writes either store, so a restart in the middle
// of one reopens the link as interrupted, never as "nothing was saved".
const crypto = require("crypto");
const fs = require("fs");
const { timingSafeStringEqual } = require("../utils/timing-safe");
const { classifySecretDropKey } = require("../utils/env-keys");

const kSecretDropTtlMs = 15 * 60 * 1000;
// A finished or expired request stays readable (status only) this long.
const kSecretDropKeepMs = 24 * 60 * 60 * 1000;
const kSecretDropMaxOpen = 20;
const kSecretDropReasonMaxChars = 200;
const kSecretDropTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const kSecretDropStateFileName = "secret-drop-requests.json";
const kRequestIdPattern = /^sd_[a-f0-9]{18}$/;
const kStatuses = new Set(["pending", "partial", "stored", "expired", "partial_expired"]);

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const isOpen = (request) => request.status === "pending" || request.status === "partial";

// A record read back from the file, or null when it is not one of ours.
const readRecord = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  if (!kRequestIdPattern.test(String(raw.id || "")) || !kStatuses.has(raw.status)) return null;
  if (typeof raw.name !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(raw.name)) return null;
  if (!Number.isFinite(raw.createdAt) || !Number.isFinite(raw.expiresAt)) return null;
  if (typeof raw.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.tokenHash)) return null;
  if (typeof raw.csrf !== "string" || !raw.csrf) return null;
  return {
    id: raw.id,
    name: String(raw.name),
    reason: String(raw.reason || ""),
    requestedBy: String(raw.requestedBy || "unknown"),
    requestContext: raw.requestContext ? String(raw.requestContext) : null,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    status: raw.status,
    tokenHash: raw.tokenHash,
    csrf: raw.csrf,
    stores: raw.stores && typeof raw.stores === "object" ? { env: raw.stores.env === true, store: raw.stores.store === true } : null,
    reach: raw.reach && typeof raw.reach === "object" ? raw.reach : null,
    notices: Array.isArray(raw.notices) ? raw.notices.map(String) : [],
    savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : null,
    endedAt: Number.isFinite(raw.endedAt) ? raw.endedAt : null,
    saveStartedAt: Number.isFinite(raw.saveStartedAt) ? raw.saveStartedAt : null,
    interrupted: raw.interrupted === true,
  };
};

const createSecretDropRequests = ({
  nowFn = () => Date.now(),
  randomBytes = crypto.randomBytes,
  ttlMs = kSecretDropTtlMs,
  store = null,
  logger = console,
  fsModule = fs,
} = {}) => {
  const requests = new Map();
  // ids whose save is running: they never expire under it, so the page and a
  // second press see the save land instead of an expiry.
  const savingIds = new Set();

  const load = () => {
    if (!store) return;
    let saved;
    try {
      saved = store.read();
    } catch (error) {
      logger.warn(`[secret-drop] could not read saved links: ${error?.code || error?.name || "error"}`);
      return;
    }
    let interrupted = false;
    for (const raw of Array.isArray(saved?.requests) ? saved.requests : []) {
      const record = readRecord(raw);
      if (!record) continue;
      if (record.saveStartedAt) {
        record.saveStartedAt = null;
        record.interrupted = true;
        interrupted = true;
        logger.warn(`[secret-drop] save interrupted by a restart id=${record.id} name=${record.name}`);
      }
      requests.set(record.id, record);
    }
    if (interrupted) persist();
  };

  // A failed write fails closed: the file is removed, so a restart drops
  // every link instead of reopening one this process already spent. Links
  // keep working in memory until then.
  const persist = () => {
    if (!store) return;
    try {
      store.write({ requests: [...requests.values()] });
    } catch (error) {
      logger.warn(`[secret-drop] could not save links, so a restart drops them: ${error?.code || error?.name || "error"}`);
      try {
        if (store.path) fsModule.rmSync(store.path, { force: true });
      } catch (removeError) {
        logger.error(`[secret-drop] could not remove the stale links file: ${removeError?.code || removeError?.name || "error"}`);
      }
    }
  };

  const sweep = () => {
    const now = nowFn();
    let changed = false;
    for (const [id, request] of requests) {
      if (isOpen(request) && now >= request.expiresAt && !savingIds.has(id)) {
        request.status = request.status === "partial" ? "partial_expired" : "expired";
        request.endedAt = now;
        changed = true;
      }
      if (!isOpen(request) && now - (request.endedAt ?? request.expiresAt) > kSecretDropKeepMs) {
        requests.delete(id);
        changed = true;
      }
    }
    if (changed) persist();
  };

  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

  const view = (request) => ({
    id: request.id,
    name: request.name,
    status: request.status,
    createdAt: iso(request.createdAt),
    expiresAt: iso(request.expiresAt),
    ...(request.savedAt ? { savedAt: iso(request.savedAt) } : {}),
    ...(request.stores ? { stores: { ...request.stores } } : {}),
    ...(request.reach ? { reach: request.reach } : {}),
    ...(request.notices?.length ? { notices: [...request.notices] } : {}),
    ...(request.interrupted ? { interrupted: true } : {}),
  });

  const create = ({ name, reason = "", requestedBy = "unknown", requestContext = null }) => {
    sweep();
    const verdict = classifySecretDropKey(name);
    if (!verdict.ok) return { ok: false, code: verdict.reason, error: verdict.error };
    const open = [...requests.values()].filter(isOpen);
    if (open.length >= kSecretDropMaxOpen) {
      return { ok: false, code: "too_many_open", error: `${kSecretDropMaxOpen} secret links are already open; wait for one to be used or expire.` };
    }
    const now = nowFn();
    const token = randomBytes(32).toString("base64url");
    const request = {
      id: `sd_${randomBytes(9).toString("hex")}`,
      name,
      reason: String(reason || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, kSecretDropReasonMaxChars),
      requestedBy,
      requestContext: requestContext ? String(requestContext).slice(0, 256) : null,
      createdAt: now,
      expiresAt: now + ttlMs,
      status: "pending",
      tokenHash: sha256(token),
      csrf: randomBytes(24).toString("base64url"),
      stores: null,
      reach: null,
      notices: [],
      savedAt: null,
      saveStartedAt: null,
      interrupted: false,
      endedAt: null,
    };
    requests.set(request.id, request);
    persist();
    return { ok: true, token, request: view(request) };
  };

  // The held request a link token names, whatever its status, or null.
  const lookupToken = (token) => {
    sweep();
    if (typeof token !== "string" || !kSecretDropTokenPattern.test(token)) return null;
    const hash = sha256(token);
    let found = null;
    for (const request of requests.values()) {
      if (timingSafeStringEqual(request.tokenHash, hash)) found = request;
    }
    return found;
  };

  // The live request a link token opens for a save, or null (unknown, used,
  // expired). A stored link never opens again.
  const resolveToken = (token) => {
    const request = lookupToken(token);
    return request && isOpen(request) ? request : null;
  };

  const get = (id) => {
    sweep();
    const request = requests.get(String(id || ""));
    return request ? view(request) : null;
  };

  // stored: both stores hold the value; the link is spent. partial: one
  // does; the link stays open until it expires so Retry can ask again.
  const finish = (id, { status, stores, reach, notices = [] }) => {
    const request = requests.get(id);
    if (!request) return null;
    const now = nowFn();
    request.stores = stores;
    request.reach = reach;
    request.notices = notices.map(String);
    request.status = status;
    request.savedAt = now;
    request.saveStartedAt = null;
    request.interrupted = false;
    if (status === "stored") request.endedAt = now;
    persist();
    return view(request);
  };

  // Written before the save touches either store; finish() or endSave()
  // clears it.
  const beginSave = (id) => {
    savingIds.add(id);
    const request = requests.get(id);
    if (!request) return;
    request.saveStartedAt = nowFn();
    persist();
  };
  const endSave = (id) => {
    savingIds.delete(id);
    const request = requests.get(id);
    if (request?.saveStartedAt) {
      request.saveStartedAt = null;
      persist();
    }
    sweep();
  };

  load();
  sweep();

  return { create, lookupToken, resolveToken, get, finish, view, isOpen, beginSave, endSave };
};

module.exports = {
  createSecretDropRequests,
  kSecretDropTtlMs,
  kSecretDropKeepMs,
  kSecretDropTokenPattern,
  kSecretDropStateFileName,
};
