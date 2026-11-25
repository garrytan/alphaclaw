// One Google tool call through GBrain's broker (contract v4), and its state:
// the last quota each product reported, in memory (the broker's ledger, so
// no second counter; the next reply restores it after a restart), and the
// intent ids of calls held for the owner (owner_confirm_required, 10
// minutes) or with an unknown outcome (24 hours), so calling the same tool
// with the same arguments again replays that intent instead of starting a
// new one. Every call's intent is journaled before it is sent and kept until
// a definite answer, so a gateway that dies mid-call replays it too. Holds
// are kept in holdsFile (0600) so they survive a gateway restart: argument
// hash, intent id, a hash of the account, expiry; never arguments or the
// account address.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { kCaller } = require("./broker");
const { errorResult, codeOfBroker, codeOfToolError } = require("./errors");

const kConfirmHoldMs = 10 * 60 * 1000;
const kUnknownHoldMs = 24 * 60 * 60 * 1000;
const kMaxHeld = 500;
const kAllowOnce = "ALLOW_ONCE";

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

  let warned = false;
  const save = () => {
    if (!holdsFile) return;
    try {
      fsModule.mkdirSync(path.dirname(holdsFile), { recursive: true, mode: 0o700 });
      const temp = holdsFile + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
      fsModule.writeFileSync(temp, JSON.stringify(Object.fromEntries(held)), { mode: 0o600, flag: "wx" });
      fsModule.renameSync(temp, holdsFile);
    } catch (error) {
      if (warned) return;
      warned = true;
      logger?.warn?.("[google-workspace] saving held calls failed: " + String(error?.code || error?.message || error).slice(0, 80));
    }
  };
  if (holdsFile) {
    try {
      const saved = JSON.parse(fsModule.readFileSync(holdsFile, "utf8"));
      for (const [hash, entry] of Object.entries(saved && typeof saved === "object" ? saved : {})) {
        if (held.size >= kMaxHeld) break;
        const until = Number(entry?.until);
        if (!kHashPattern.test(hash) || typeof entry?.key !== "string" || !entry.key || !(until > now())) continue;
        held.set(hash, { key: entry.key.slice(0, 128), account: String(entry.account || "").slice(0, 16), until });
      }
    } catch {}
  }

  const hold = (hash, key, account, ms) => {
    held.delete(hash);
    if (held.size >= kMaxHeld) held.delete(held.keys().next().value);
    held.set(hash, { key, account: accountTag(account), until: now() + ms });
    save();
  };
  const release = (hash) => {
    if (held.delete(hash)) save();
  };
  const heldKey = (hash) => {
    const entry = held.get(hash);
    if (!entry) return null;
    if (entry.until <= now()) {
      release(hash);
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

  // { account, server, tool, args, turnId, assertCurrent, signal } -> an
  // OpenClaw tool result. Only owner turns reach here (index.js).
  const callTool = async ({ account, server, tool, args, turnId, assertCurrent, signal }) => {
    const record = (outcome, extra = {}) => audit?.write({ product: server, tool, outcome, ...extra });
    if (stopped(server)) {
      record("gw_quota_stopped");
      return errorResult("gw_quota_stopped");
    }
    const hash = intentHash({ account, server, tool, args });
    const replay = heldKey(hash);
    const key = replay || crypto.randomUUID();
    if (!replay) hold(hash, key, account, kUnknownHoldMs);
    // A refusal settles a fresh intent (the broker did not act). A replayed
    // one stays held until it succeeds or expires: its first attempt may
    // have acted.
    const settle = () => {
      if (!replay) release(hash);
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
      if (answer.transport === "lost") {
        hold(hash, key, account, kUnknownHoldMs);
        record("gw_outcome_unknown", { offered, given });
        return errorResult("gw_outcome_unknown", { ref: key });
      }
      const reply = answer.reply;
      const notice = noteQuota(server, reply.quota);
      const requestId = typeof reply.request_id === "string" ? reply.request_id : null;
      if (reply.ok === true) {
        release(hash);
        record("ok", { offered, given, requestId });
        return successResult(reply.result, { server, tool, ...(requestId ? { requestId } : {}) }, notice);
      }
      const code = String(reply.code || "");
      if (code === "input_required" && given === null) {
        offered = Array.isArray(reply.choices) ? reply.choices.map((choice) => String(choice?.id ?? choice?.value ?? choice)) : [];
        if (requestId && offered.includes(kAllowOnce)) {
          given = kAllowOnce;
          answer = await send({ owner_verdict: { choice: kAllowOnce, for_request: requestId } });
          continue;
        }
      }
      const keep = code === "owner_confirm_required" || code === "input_required" || code === "outcome_unknown";
      if (code === "owner_confirm_required" || code === "input_required") hold(hash, key, account, kConfirmHoldMs);
      else if (code === "outcome_unknown") hold(hash, key, account, kUnknownHoldMs);
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
