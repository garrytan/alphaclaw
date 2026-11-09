// Per-sender verification for /hooks (GST-2134 PR 2). Each hook names how its
// sender proves itself: the shared webhook token (the default), a provider
// signature over the exact bytes sent (Circleback, Quo, Verkada, Standard
// Webhooks) or a token AlphaClaw minted for that hook alone. Moving a hook to
// a signed mode keeps the shared token working until the gateway has admitted
// one signed delivery, then for a fixed 24 hours; after that only a human
// reopens it. Policy lives in alphaclaw.json hooksIngress.hooks, secrets in
// <root>/hook-ingress/secrets.json, and a mismatch between them refuses the
// hook instead of reverting it to the shared token.
const crypto = require("crypto");
const fs = require("fs");
const { credentialMatches, hashHookToken, ownTokenMatches } = require("./verify");
const { kSignedPresets, validateSecret, verifySignedDelivery } = require("./signatures");
const { kHooksPolicyVersion, readHooksPolicy, readSecrets, setHookSecret, updateHooksPolicy } = require("./policy");

const kSignedOverlapMs = 24 * 60 * 60 * 1000;
const kNoticeIntervalMs = 60 * 60 * 1000;
const kInFlightRetryAfterSeconds = 5;
const kMaxIdempotencyKeyLength = 256;
const kSignedSet = new Set(kSignedPresets);
const kSenderSecretPresets = new Set(["standard_webhooks", "circleback", "quo"]);
const kGeneratedSecretPresets = new Set(["verkada", "per_hook_token"]);
const kReplayTtlMs = Object.freeze({
  standard_webhooks: 7 * 24 * 60 * 60 * 1000,
  quo: 7 * 24 * 60 * 60 * 1000,
  quo_legacy: 60 * 60 * 1000,
  verkada: 60 * 60 * 1000,
  circleback: 30 * 24 * 60 * 60 * 1000,
});
const kSignatureHeaderByPreset = Object.freeze({
  standard_webhooks: ["webhook-signature"],
  quo: ["webhook-signature", "openphone-signature"],
  circleback: ["x-signature"],
  verkada: ["verkada-signature"],
});
const kPresets = Object.freeze([
  { id: "token", label: "Shared webhook token (today)", secretSource: "none", help: "Every hook takes the same WEBHOOK_TOKEN, usually in ?token=." },
  { id: "circleback", label: "Circleback", secretSource: "sender", help: "Paste the automation's signing secret from Circleback." },
  { id: "quo", label: "Quo", secretSource: "sender", help: "Paste the webhook's signing secret from Quo Settings > Webhooks." },
  { id: "verkada", label: "Verkada", secretSource: "alphaclaw", help: "Generate a secret here and type it into the Verkada webhook." },
  { id: "standard_webhooks", label: "Standard Webhooks", secretSource: "sender", help: "For any sender that signs with the Standard Webhooks scheme (a whsec_ secret)." },
  { id: "per_hook_token", label: "Own token for this hook", secretSource: "alphaclaw", help: "Generate a token only this hook accepts, for senders that cannot sign." },
]);
const kPresetIds = new Set(kPresets.map((preset) => preset.id));
const kRequestFieldPattern = /\b(headers|query|searchParams)\b/;

const headerValue = (headers, name) => {
  const value = headers?.[name];
  return Array.isArray(value) ? value.join(",") : String(value || "");
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

const createSenderVerification = ({
  fsModule = fs,
  openclawDir,
  rootDir,
  hasReplayKey = () => false,
  recordReplayKey = () => {},
  deleteReplayKeysByHook = () => 0,
  countAuthMethods = () => ({}),
  listHookNames = () => [],
  getHookSources = () => [],
  getHookUrl = (name) => "/hooks/" + name,
  sendNotice = () => {},
  webhooksUrl = () => "the Webhooks page",
  nowMs = () => Date.now(),
  logger = console,
} = {}) => {
  const pending = new Set();
  const lastNoticeAt = new Map();
  const alerts = new Map();
  const isoAt = (ms) => new Date(ms).toISOString();

  const alert = (hookName, reason, message) => {
    const now = nowMs();
    alerts.set(hookName, { reason, message, at: isoAt(now) });
    const key = hookName + "|" + reason;
    if (now - (lastNoticeAt.get(key) ?? -Infinity) < kNoticeIntervalMs) return;
    lastNoticeAt.set(key, now);
    while (lastNoticeAt.size > 1000) lastNoticeAt.delete(lastNoticeAt.keys().next().value);
    sendNotice(message + " " + webhooksUrl(), "hook-ingress-" + hookName + "-" + reason + "-" + Math.floor(now / kNoticeIntervalMs));
  };

  // { mode, entry, secret } or { failClosed: reason }. Without a readable
  // policy, a hook is on the shared token only when no secret was ever
  // written for it (a signed mode always writes its secret first).
  const resolveHookMode = (hookName) => {
    const policy = readHooksPolicy({ fsModule, openclawDir });
    const secrets = readSecrets({ fsModule, rootDir });
    const secretEntry = secrets.unreadable ? null : secrets.secrets.hooks[hookName] || null;
    if (policy.unreadable) {
      if (secrets.missing || (!secrets.unreadable && !secretEntry)) return { mode: "token", entry: null };
      return { failClosed: "policy_unreadable" };
    }
    const entry = policy.hooks[hookName] || null;
    if (!entry) {
      if (secrets.unreadable || secretEntry) return { failClosed: "policy_missing" };
      return { mode: "token", entry: null };
    }
    const mode = String(entry.mode || "");
    if (mode === "token") return { mode, entry };
    if (!kSignedSet.has(mode) && mode !== "per_hook_token") return { failClosed: "policy_unknown_mode" };
    if (secrets.unreadable) return { failClosed: "secrets_unreadable" };
    if (!secretEntry || secretEntry.preset !== mode || Number(secretEntry.generation) !== Number(entry.generation)) {
      return { failClosed: "secret_missing" };
    }
    return { mode, entry, secret: secretEntry };
  };

  const sharedWindow = (entry, now = nowMs()) => {
    if (!entry?.firstAdmittedAt) return { state: "waiting", open: true, closesAtMs: null };
    const closesAtMs = Date.parse(String(entry.closesAt || ""));
    if (Number.isFinite(closesAtMs) && now < closesAtMs) return { state: "overlap", open: true, closesAtMs };
    return { state: "closed", open: false, closesAtMs: Number.isFinite(closesAtMs) ? closesAtMs : null };
  };

  const recordFirstAdmitted = (hookName, generation) => {
    try {
      updateHooksPolicy({
        fsModule,
        openclawDir,
        mutate: (policy) => {
          const entry = policy.hooks[hookName];
          if (!entry || entry.firstAdmittedAt || Number(entry.generation) !== Number(generation)) return policy;
          const now = nowMs();
          policy.hooks[hookName] = { ...entry, firstAdmittedAt: isoAt(now), closesAt: isoAt(now + kSignedOverlapMs) };
          return policy;
        },
      });
    } catch (err) {
      logger.warn?.("[hooks] could not record the first verified delivery for /hooks/" + hookName + ": " + err.message);
    }
  };

  const refuse = (status, reason, error, detail, extra = {}) => ({ ok: false, status, reason, error, detail, ...extra });

  const sharedTokenVerdict = (hookName, entry) => {
    const window = sharedWindow(entry);
    if (window.state === "waiting") return { ok: true, authMethod: "shared_token" };
    if (window.open) {
      alert(hookName, "migration_not_finished",
        "/hooks/" + hookName + " still received a delivery with the shared webhook token after its sender started verifying. The shared token stops working on it at " +
          isoAt(window.closesAtMs) + "; check the sender's settings in");
      return { ok: true, authMethod: "shared_token" };
    }
    alert(hookName, "shared_token_after_close",
      "AlphaClaw refused a delivery to /hooks/" + hookName + " with the shared webhook token: this hook now takes only verified deliveries. If that sender is real, move it or reopen the shared token in");
    return refuse(401, "shared_token_retired", "Unauthorized", "the shared token no longer works on /hooks/" + hookName);
  };

  // Called for every non-built-in delivery. Returns a verdict, or null to fall
  // through to the shared credential failure path.
  const authenticateSender = ({ hookName, headers, rawBody, presented, credential, takeFailure }) => {
    const resolved = resolveHookMode(hookName);
    if (resolved.failClosed) {
      alert(hookName, resolved.failClosed,
        "AlphaClaw refused deliveries to /hooks/" + hookName + " because its sender verification settings or secret cannot be read (" +
          resolved.failClosed + "). Set it up again in");
      return refuse(503, "hook_policy_" + resolved.failClosed, "Service Unavailable", "the hook's sender verification cannot be read, so AlphaClaw refuses it");
    }
    const { mode, entry, secret } = resolved;
    if (mode === "token") {
      if (!credential.ok) return { ok: true, authMethod: "unchecked" };
      if (presented && credentialMatches(presented, credential.value)) return { ok: true, authMethod: "shared_token" };
      return null;
    }
    if (!credential.ok) {
      return refuse(503, "credential_unresolved", "Service Unavailable", "AlphaClaw cannot read the gateway's hook credential, so it cannot forward a verified delivery");
    }
    const authorization = "Bearer " + credential.value;
    const generation = entry.generation;
    const onAdmitted = entry.firstAdmittedAt ? null : () => recordFirstAdmitted(hookName, generation);
    const reject = (status, reason, detail) => {
      alert(hookName, "rejected",
        "AlphaClaw refused a delivery to /hooks/" + hookName + " (" + reason + "): it did not verify as " + mode + ". If the sender is real, check its secret in");
      const failure = takeFailure();
      if (failure.limited) {
        return refuse(429, "throttled", "Too Many Requests", "too many failed credentials from this client", { retryAfterSeconds: failure.retryAfterSeconds });
      }
      return refuse(status, reason, status === 415 ? "Unsupported Media Type" : "Unauthorized", detail);
    };
    if (mode === "per_hook_token") {
      if (presented && ownTokenMatches(presented, secret.tokenSha256)) {
        return { ok: true, authMethod: "per_hook_token", authorization, onAdmitted };
      }
      if (presented && credentialMatches(presented, credential.value)) return sharedTokenVerdict(hookName, entry);
      if (!presented) return null;
      return reject(401, "bad_credential", "the credential does not match");
    }
    const signatureSent = kSignatureHeaderByPreset[mode].some((name) => headerValue(headers, name));
    if (!signatureSent) {
      if (presented && credentialMatches(presented, credential.value)) return sharedTokenVerdict(hookName, entry);
      return reject(401, "missing_signature", "the delivery carries no " + mode + " signature");
    }
    const encoding = headerValue(headers, "content-encoding").trim().toLowerCase();
    if (encoding && encoding !== "identity") {
      return reject(415, "compressed_body", "a signed delivery must be sent uncompressed");
    }
    const verified = verifySignedDelivery({ preset: mode, secret: secret.secret, rawBody, headers, nowMs: nowMs() });
    if (!verified.ok) return reject(401, verified.reason, "the signature did not verify (" + verified.reason + ")");
    const replayTag = mode + ":" + verified.replayKey;
    return {
      ok: true,
      authMethod: "signed",
      authorization,
      onAdmitted,
      signed: {
        preset: mode,
        scheme: verified.scheme,
        replayKey: verified.replayKey,
        deliveryId: verified.deliveryId || null,
        signedHeaders: verified.signedHeaders || {},
        idempotencyKey: replayTag.length <= kMaxIdempotencyKeyLength
          ? replayTag
          : mode + ":" + crypto.createHash("sha256").update(verified.replayKey).digest("hex"),
      },
    };
  };

  // Bounded replay suppression with at-least-once delivery: a key is stored
  // only after the gateway's 2xx, a concurrent duplicate waits (409), and a
  // crash between the 2xx and the insert can let one retry through again.
  const beginSignedDelivery = (hookName, signed) => {
    const key = hookName + "\n" + signed.replayKey;
    if (pending.has(key)) return { status: "in_flight", retryAfterSeconds: kInFlightRetryAfterSeconds };
    try {
      if (hasReplayKey(hookName, signed.replayKey, nowMs())) return { status: "duplicate" };
    } catch (err) {
      logger.warn?.("[hooks] replay check failed for /hooks/" + hookName + ": " + err.message);
    }
    pending.add(key);
    let settled = false;
    return {
      status: "ok",
      settle: (accepted) => {
        if (settled) return;
        settled = true;
        pending.delete(key);
        if (!accepted) return;
        try {
          const now = nowMs();
          recordReplayKey(hookName, signed.replayKey, now + (kReplayTtlMs[signed.scheme] || kReplayTtlMs[signed.preset] || kReplayTtlMs.circleback), now);
        } catch (err) {
          logger.warn?.("[hooks] could not store the replay key for /hooks/" + hookName + ": " + err.message);
        }
      },
    };
  };

  const ingressStatus = (hookName) => {
    const policy = readHooksPolicy({ fsModule, openclawDir });
    const resolved = resolveHookMode(hookName);
    const entry = policy.unreadable ? null : policy.hooks[hookName] || null;
    const preset = String(entry?.mode || "token");
    const window = sharedWindow(entry);
    let state = "token";
    if (resolved.failClosed) state = "misconfigured";
    else if (preset !== "token") state = window.state;
    let counts = {};
    try {
      counts = countAuthMethods(hookName) || {};
    } catch {}
    let sources = [];
    try {
      sources = getHookSources(hookName) || [];
    } catch {}
    const misconfigured = resolved.failClosed
      ? { reason: resolved.failClosed, message: "This hook's verification settings or secret cannot be read, so AlphaClaw refuses its deliveries. Set it up again below.", at: null }
      : null;
    return {
      preset,
      hasSecret: !!resolved.secret,
      state,
      firstAdmittedAt: entry?.firstAdmittedAt || null,
      closesAt: entry?.closesAt || null,
      closedAt: state === "closed" ? entry?.closesAt || null : null,
      sharedTokenAccepted: preset === "token" || (!resolved.failClosed && window.open),
      signedUrl: getHookUrl(hookName),
      counts: Object.fromEntries(["signed", "shared_token", "per_hook_token", "rejected"].map((kind) => [kind, counts[kind] || 0])),
      alert: alerts.get(hookName) || misconfigured,
      readsRequestFields: sources.some((text) => kRequestFieldPattern.test(String(text || ""))),
      presets: kPresets,
    };
  };

  const assertHook = (hookName) => {
    if (!listHookNames().includes(hookName)) throw httpError(404, "Webhook not found");
  };

  const writeMode = (hookName, mode, generation) =>
    updateHooksPolicy({
      fsModule,
      openclawDir,
      mutate: (policy) => {
        policy.hooks[hookName] = mode === "token"
          ? { mode: "token", changedAt: isoAt(nowMs()) }
          : { mode, generation, changedAt: isoAt(nowMs()), firstAdmittedAt: null, closesAt: null };
        return policy;
      },
    });

  // The secret is written first, then the policy names the mode, so a failed
  // second write leaves the hook on its old mode with an unused secret.
  const setIngress = (hookName, { preset, secret } = {}) => {
    assertHook(hookName);
    const mode = String(preset || "");
    if (!kPresetIds.has(mode)) throw httpError(400, "Unknown verification method");
    if (mode === "token") {
      writeMode(hookName, "token");
      setHookSecret({ fsModule, rootDir, name: hookName, entry: null });
      alerts.delete(hookName);
      return ingressStatus(hookName);
    }
    if (kGeneratedSecretPresets.has(mode)) throw httpError(400, "Generate the secret for this method instead");
    const checked = validateSecret(mode, String(secret || ""));
    if (!checked.ok) throw httpError(400, "That signing secret is not valid for " + mode + " (" + checked.reason + ")");
    const generation = setHookSecret({ fsModule, rootDir, name: hookName, entry: { preset: mode, secret: String(secret), createdAt: isoAt(nowMs()) } });
    writeMode(hookName, mode, generation);
    alerts.delete(hookName);
    return ingressStatus(hookName);
  };

  const generateSecret = (hookName, { preset } = {}) => {
    assertHook(hookName);
    const mode = String(preset || "");
    if (!kGeneratedSecretPresets.has(mode)) throw httpError(400, "AlphaClaw generates secrets only for Verkada and own-token hooks");
    const value = crypto.randomBytes(32).toString("base64url");
    const entry = mode === "per_hook_token"
      ? { preset: mode, tokenSha256: hashHookToken(value), createdAt: isoAt(nowMs()) }
      : { preset: mode, secret: value, createdAt: isoAt(nowMs()) };
    const generation = setHookSecret({ fsModule, rootDir, name: hookName, entry });
    writeMode(hookName, mode, generation);
    alerts.delete(hookName);
    return { secret: value, ingress: ingressStatus(hookName) };
  };

  // Undo after the overlap closed: the shared token works for another 24 h.
  const reopen = (hookName) => {
    assertHook(hookName);
    updateHooksPolicy({
      fsModule,
      openclawDir,
      mutate: (policy) => {
        const entry = policy.hooks[hookName];
        if (!entry || entry.mode === "token") throw httpError(409, "This hook already takes the shared token");
        if (!entry.firstAdmittedAt) throw httpError(409, "The shared token still works on this hook");
        const now = nowMs();
        policy.hooks[hookName] = { ...entry, closesAt: isoAt(now + kSignedOverlapMs), reopenedAt: isoAt(now) };
        return policy;
      },
    });
    alerts.delete(hookName);
    return ingressStatus(hookName);
  };

  // Hook deleted or (re)created: its policy, secret and replay keys go, and a
  // created hook starts on the shared token with a new policy entry.
  const resetHook = (hookName, { created = false } = {}) => {
    updateHooksPolicy({
      fsModule,
      openclawDir,
      mutate: (policy) => {
        if (created) policy.hooks[hookName] = { mode: "token", changedAt: isoAt(nowMs()) };
        else delete policy.hooks[hookName];
        return policy;
      },
    });
    setHookSecret({ fsModule, rootDir, name: hookName, entry: null });
    try {
      deleteReplayKeysByHook(hookName);
    } catch {}
    alerts.delete(hookName);
  };

  // Once per box: every existing hook gets an explicit shared-token entry, so
  // a later missing entry with a secret behind it is refused, never reverted.
  const runHooksPolicyMigration = () => {
    const policy = readHooksPolicy({ fsModule, openclawDir });
    if (policy.unreadable) {
      logger.warn?.("[hooks] sender policy migration skipped: alphaclaw.json is unreadable");
      return { ran: false, reason: "policy_unreadable" };
    }
    if (policy.version >= kHooksPolicyVersion) return { ran: false, reason: "already_ran" };
    let names = [];
    try {
      names = listHookNames();
    } catch {}
    try {
      updateHooksPolicy({
        fsModule,
        openclawDir,
        mutate: (current) => {
          if (current.version >= kHooksPolicyVersion) return current;
          for (const name of names) {
            if (!current.hooks[name]) current.hooks[name] = { mode: "token", changedAt: isoAt(nowMs()) };
          }
          return { ...current, version: kHooksPolicyVersion };
        },
      });
    } catch (err) {
      logger.warn?.("[hooks] sender policy migration failed: " + err.message);
      return { ran: false, reason: "write_failed" };
    }
    return { ran: true, hooks: names.length };
  };

  return {
    authenticateSender,
    beginSignedDelivery,
    generateSecret,
    ingressStatus,
    reopen,
    resetHook,
    runHooksPolicyMigration,
    setIngress,
  };
};

module.exports = { createSenderVerification, kSignedOverlapMs };
