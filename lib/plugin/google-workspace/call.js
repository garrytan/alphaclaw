// One Google tool call through GBrain's broker (contract v4), and its state:
// the last quota each product reported, in memory (the broker's ledger, so
// no second counter; the next reply restores it after a restart), and the
// intent ids of calls held for the owner (owner_confirm_required, 10
// minutes) or with an unknown outcome (24 hours), so calling the same tool
// with the same arguments again replays that intent instead of starting a
// new one. Every write's intent is journaled before it is sent (it is not
// sent when the journal cannot be written) and kept until a definite answer,
// so a gateway that dies mid-call replays it too; reads are never held.
// Holds are kept in holdsFile (0600) so they survive a gateway restart:
// argument hash, intent id, a hash of the account, expiry and kind; never
// arguments or the account address.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { kCaller } = require("./broker");
const { errorResult, codeOfBroker, codeOfToolError, kBrokerCodes } = require("./errors");

const kConfirmHoldMs = 10 * 60 * 1000;
const kUnknownHoldMs = 24 * 60 * 60 * 1000;
const kMaxHeld = 500;
const kAllowOnce = "ALLOW_ONCE";
// Broker answers that settle an intent id for good: a replay of it may stop.
const kDefiniteCodes = new Set(["tool_error", "broker_args_refused", "tool_not_allowed"]);

const stableJson = (value) => {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value === undefined ? null : value);
};
const intentHash = ({ account, server, tool, args }) => crypto.createHash("sha256").update(stableJson({ account, server, tool, args })).digest("hex");
const accountTag = (account) => crypto.createHash("sha256").update(String(account)).digest("hex").slice(0, 16);
const kHashPattern = /^[0-9a-f]{64}$/;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Google's tool result as an OpenClaw tool result: its text and image parts,
// else the result as JSON.
const successResult = (result, details, notice) => {
  const parts = Array.isArray(result?.content) ? result.content.filter((part) => part && (part.type === "text" || part.type === "image")) : [];
  const content = parts.length ? parts : [{ type: "text", text: JSON.stringify(result?.structuredContent ?? result ?? null) }];
  if (notice) content.push({ type: "text", text: notice });
  return { content, details: { status: "ok", ...details } };
};

const createCaller = ({ broker, audit, logger = null, noticeAt = 1200, stopAt = 1500, now = Date.now, onRevoked = () => {}, holdsFile = null, fsModule = fs } = {}) => {
  const quotas = new Map();
  const noticed = new Set();
  const held = new Map();
  // Per intent id: calls in flight under it, ids a definite answer settled
  // while another call under them was still in flight (the last to finish
  // lets the id go), and ids an in-flight call left with an unknown outcome
  // (never let go or turned into a pause while a call under them is in
  // flight; an owner pause becomes a pause only when no other call is).
  const busy = new Map();
  const done = new Set();
  const uncertain = new Set();

  let warned = false;
  // Writes held to holdsFile; false when the file could not be written.
  const save = () => {
    if (!holdsFile) return true;
    try {
      fsModule.mkdirSync(path.dirname(holdsFile), { recursive: true, mode: 0o700 });
      const temp = holdsFile + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
      fsModule.writeFileSync(temp, JSON.stringify(Object.fromEntries(held)), { mode: 0o600, flag: "wx" });
      fsModule.renameSync(temp, holdsFile);
      return true;
    } catch (error) {
      if (!warned) {
        warned = true;
        logger?.warn?.("[google-workspace] saving held calls failed: " + String(error?.code || error?.message || error).slice(0, 80));
      }
      return false;
    }
  };
  if (holdsFile) {
    try {
      const saved = JSON.parse(fsModule.readFileSync(holdsFile, "utf8"));
      for (const [hash, entry] of Object.entries(saved && typeof saved === "object" ? saved : {})) {
        if (held.size >= kMaxHeld) break;
        const until = Number(entry?.until);
        if (!kHashPattern.test(hash) || typeof entry?.key !== "string" || !entry.key || !(until > now())) continue;
        held.set(hash, { key: entry.key.slice(0, 128), account: String(entry.account || "").slice(0, 16), until, kind: entry.kind === "confirm" ? "confirm" : "unknown" });
      }
    } catch {}
  }

  // Room for one more hold: expired holds go first, then the oldest owner
  // pause (the broker did not act on it). A write whose outcome is unknown
  // is never evicted; with no room left the new write is not sent.
  const makeRoom = () => {
    if (held.size < kMaxHeld) return true;
    for (const [hash, entry] of held) if (entry.until <= now() && !busy.has(entry.key)) held.delete(hash);
    if (held.size < kMaxHeld) return true;
    for (const [hash, entry] of held) {
      if (entry.kind !== "confirm" || busy.has(entry.key)) continue;
      held.delete(hash);
      return true;
    }
    return false;
  };
  // Returns false when the hold could not be kept (no room, or the file
  // could not be written); the hold is then not in memory either.
  const hold = (hash, key, account, ms, kind) => {
    const before = held.get(hash);
    held.delete(hash);
    if (!makeRoom()) {
      if (before) held.set(hash, before);
      return false;
    }
    held.set(hash, { key, account: accountTag(account), until: now() + ms, kind });
    if (save()) return true;
    held.delete(hash);
    if (before) held.set(hash, before);
    return false;
  };
  // Lets an intent id go, only while it is still the one held for hash.
  const release = (hash, key) => {
    if (held.get(hash)?.key !== key) return;
    held.delete(hash);
    save();
  };
  // An expired id stays reserved while a call under it is in flight.
  const heldKey = (hash) => {
    const entry = held.get(hash);
    if (!entry) return null;
    if (entry.until <= now() && !busy.has(entry.key)) {
      release(hash, entry.key);
      return null;
    }
    return entry.key;
  };

  const limitOf = (quota) => Math.min(stopAt, Number.isFinite(Number(quota?.cap)) && Number(quota.cap) > 0 ? Number(quota.cap) : stopAt);
  const stopped = (server) => {
    const quota = quotas.get(server);
    return Boolean(quota) && quota.day === utcDay(now()) && quota.used >= limitOf(quota);
  };
  // Records the broker's quota for this product and returns the owner notice
  // once per product per UTC day, when today's count reaches noticeAt.
  const noteQuota = (server, quota) => {
    const used = Number(quota?.used_today);
    if (!quota || !Number.isFinite(used)) return null;
    const day = typeof quota.day === "string" && quota.day ? quota.day : utcDay(now());
    quotas.set(server, { day, used, cap: quota.cap });
    if (used < noticeAt || noticed.has(server + "@" + day)) return null;
    noticed.add(server + "@" + day);
    const limit = limitOf(quota);
    logger?.warn?.("[google-workspace] quota notice product=" + server + " used=" + used + " stop=" + limit + " day=" + day);
    return "Tell the owner: Google " + server + " calls today are at " + used + " of " + limit + "; at " + limit + " they stop until midnight UTC.";
  };

  const forgetAccount = (account) => {
    const tag = accountTag(account);
    let changed = false;
    for (const [hash, entry] of held) {
      if (entry.account !== tag) continue;
      held.delete(hash);
      changed = true;
    }
    if (changed) save();
  };

  // { account, server, tool, args, write, turnId, assertCurrent, signal } ->
  // an OpenClaw tool result. Only owner turns reach here (index.js). A write
  // is journaled before it is sent and replays its intent id until a
  // definite answer; a read gets a fresh id every time and is never held.
  const callTool = async ({ account, server, tool, args, write = true, turnId, assertCurrent, signal }) => {
    const record = (outcome, extra = {}) => audit?.write({ product: server, tool, outcome, ...extra });
    if (stopped(server)) {
      record("gw_quota_stopped");
      return errorResult("gw_quota_stopped");
    }
    const hash = intentHash({ account, server, tool, args });
    const replay = write ? heldKey(hash) : null;
    const key = replay || crypto.randomUUID();
    // A fresh write, or a replay of an owner pause (the owner may have just
    // approved it), is journaled as an unknown outcome before it is sent, so
    // a gateway that dies mid-call never lets it expire as a pause.
    const pending = write && (!replay || held.get(hash)?.kind === "confirm");
    if (pending && !hold(hash, key, account, kUnknownHoldMs, "unknown")) {
      record("gw_journal_failed");
      return errorResult("gw_journal_failed");
    }
    if (write) busy.set(key, (busy.get(key) || 0) + 1);
    try {
      return await exchange({ hash, key, replay, write, account, server, tool, args, turnId, assertCurrent, signal, record });
    } catch (error) {
      if (write && !replay && (busy.get(key) || 0) <= 1 && !uncertain.has(key)) release(hash, key);
      throw error;
    } finally {
      if (write) {
        const left = (busy.get(key) || 1) - 1;
        if (left > 0) busy.set(key, left);
        else {
          busy.delete(key);
          uncertain.delete(key);
          if (done.delete(key)) release(hash, key);
        }
      }
    }
  };

  const exchange = async ({ hash, key, replay, write, account, server, tool, args, turnId, assertCurrent, signal, record }) => {
    // The broker did not act on this attempt. A fresh write's intent goes,
    // unless another identical call is still using it; a replayed one stays
    // held until it succeeds, is refused for good, or expires: its first
    // attempt may have acted.
    const settle = () => {
      if (write && !replay && (busy.get(key) || 0) <= 1 && !uncertain.has(key)) release(hash, key);
    };
    // The broker answered this intent id for good, so it is settled, also
    // for an identical call still in flight under it.
    const settled = () => {
      if (!write) return;
      if ((busy.get(key) || 0) <= 1) release(hash, key);
      else done.add(key);
    };
    const unknown = (extra) => {
      if (!write) {
        record("gw_read_unanswered", extra);
        return errorResult("gw_read_unanswered");
      }
      uncertain.add(key);
      const current = held.get(hash);
      if (current && current.key !== key) logger?.warn?.("[google-workspace] kept a newer intent id over an older call's unknown outcome");
      else if (!hold(hash, key, account, kUnknownHoldMs, "unknown")) logger?.warn?.("[google-workspace] could not keep an unknown-outcome call's intent id");
      record("gw_outcome_unknown", extra);
      return errorResult("gw_outcome_unknown", { ref: key });
    };
    const base = { op: "call", account, server, tool, args: args ?? {}, turn_id: String(turnId).slice(0, 128), idempotency_key: key, caller: kCaller };
    const send = (extra) => broker.request({ ...base, ...extra }, { beforeWrite: assertCurrent, signal });
    let offered = null;
    let given = null;
    let answer = await send({});
    for (;;) {
      if (answer.transport === "down") {
        settle();
        record("gw_broker_down", { offered, given });
        return errorResult("gw_broker_down");
      }
      if (answer.transport === "lost") return unknown({ offered, given });
      const reply = answer.reply;
      const code = typeof reply.code === "string" ? reply.code : "";
      // A reply this plugin cannot read as a definite answer (ok neither
      // true nor false, an unknown code) leaves a write's outcome unknown; a
      // read just failed.
      if (write && reply.ok !== true && (reply.ok !== false || !(code === "tool_error" || Object.hasOwn(kBrokerCodes, code)))) return unknown({ offered, given });
      const notice = noteQuota(server, reply.quota);
      const requestId = typeof reply.request_id === "string" ? reply.request_id : null;
      if (reply.ok === true) {
        if (write) settled();
        record("ok", { offered, given, requestId });
        return successResult(reply.result, { server, tool, ...(requestId ? { requestId } : {}) }, notice);
      }
      if (code === "input_required" && given === null) {
        offered = Array.isArray(reply.choices) ? reply.choices.map((choice) => String(choice?.id ?? choice?.value ?? choice)) : [];
        if (requestId && offered.includes(kAllowOnce)) {
          given = kAllowOnce;
          answer = await send({ owner_verdict: { choice: kAllowOnce, for_request: requestId } });
          continue;
        }
      }
      const keep = write && (code === "owner_confirm_required" || code === "input_required" || code === "outcome_unknown");
      if (code === "outcome_unknown") return unknown({ offered, given, requestId });
      if (keep) {
        if (!uncertain.has(key) && (busy.get(key) || 0) <= 1) hold(hash, key, account, kConfirmHoldMs, "confirm");
      }
      else if (kDefiniteCodes.has(code)) settled();
      else settle();
      if (code === "revoked") {
        forgetAccount(account);
        onRevoked(account);
      }
      if (code === "day_cap") quotas.set(server, { day: utcDay(now()), used: Infinity, cap: reply.quota?.cap });
      const gwCode = code === "tool_error" ? codeOfToolError(reply.reason) : codeOfBroker(code);
      record(gwCode, { offered, given, requestId });
      return errorResult(gwCode, { ref: keep ? key : null, googleMessage: code === "tool_error" ? reply.message_md : null, notice });
    }
  };

  // The status op for an intent id gw_outcome_unknown handed out. Read-only.
  const checkOutcome = async ({ ref, assertCurrent, signal }) => {
    const answer = await broker.request({ op: "status", idempotency_key: String(ref) }, { beforeWrite: assertCurrent, signal });
    if (answer.transport) return errorResult(answer.transport === "down" ? "gw_broker_down" : "gw_outcome_unknown", { ref });
    const reply = answer.reply;
    if (reply.ok !== true) return errorResult(codeOfBroker(reply.code), { ref });
    const { v, ok, ...state } = reply;
    return { content: [{ type: "text", text: JSON.stringify(state) }], details: { status: "ok", ref } };
  };

  return { callTool, checkOutcome, forgetAccount, isStopped: stopped };
};

module.exports = { createCaller, intentHash, stableJson };
