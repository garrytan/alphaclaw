// Claude Code launcher service — fires a claude.ai Claude Code "routine" and
// returns the resulting session URL for the sidebar launcher.
//
//   click ──▶ POST /api/claude-code/session ──▶ createSession({confirmed})
//               │                                  │
//               │                       resolveConfig (once per call)
//               │                                  │ not_configured/invalid_config
//               │                       confirm_required (consent, pre-network)
//               │                       busy / cooldown (single-flight guards)
//               │                                  ▼
//               │                       POST {fireUrl} (routine fire, 15s cap)
//               ▼                                  ▼
//        409/429/502/504 map              { sessionId, sessionUrl }
//
// A fire starts an AUTONOMOUS Claude Code cloud run (shell access, no approval
// prompts) billed to the token owner's claude.ai subscription — hence the
// consent handshake, the single-flight + cooldown guards, and the manifest
// tier "denied" for the agent actor. The routine token (sk-ant-oat01-…) is a
// per-routine claude.ai credential, NOT the Anthropic API key and NOT the
// ANTHROPIC_TOKEN setup token, despite the shared prefix.
const { buildSecretReplacements } = require("./helpers");

// Experimental Claude Code product-surface API. Anthropic ships breaking
// changes behind new dated header versions and keeps the two previous
// versions working, so bumping this constant is the whole migration.
// Docs: https://platform.claude.com/docs/en/api/claude-code/routines-fire
const kRoutineBetaHeader = "experimental-cc-routine-2026-04-01";
const kAnthropicVersion = "2023-06-01";

// Anchored on the exact Anthropic host + path shape: this regex IS the SSRF
// allowlist for operator-supplied fire URLs — no env string ever becomes a
// URL host any other way.
const kFireUrlPattern =
  /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9_-]+)\/fire\/?$/;
const kRoutineIdPattern = /^trig_[A-Za-z0-9_-]+$/;
const kRoutineTokenPrefix = "sk-ant-oat01-";
const kSessionIdPattern = /^session_[A-Za-z0-9_-]+$/;
// Upstream Retry-After honored internally, but bounded — a hostile/buggy
// header must not freeze the launcher for hours.
const kMaxRetryAfterCooldownMs = 300_000;

const kDefaultTimeoutMs = 15_000;
const kDefaultCooldownMs = 5_000;
// A timed-out fire may still have created a billed session upstream (the fire
// endpoint has no idempotency key), so rapid retries are the duplicate-billing
// vector — the post-timeout window is deliberately longer.
const kTimeoutCooldownMs = 30_000;

const createClaudeCodeService = ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = kDefaultTimeoutMs,
  cooldownMs = kDefaultCooldownMs,
  timeoutCooldownMs = kTimeoutCooldownMs,
  logger = console,
  nowFn = Date.now,
} = {}) => {
  let inFlight = false;
  let cooldownUntil = 0;

  // Config is read at call time: the .env fs-watcher reload (lib/server/env.js)
  // makes launcher config changes live without a server restart.
  const resolveConfig = () => {
    const rawUrl = String(env.CLAUDE_CODE_ROUTINE_URL || "").trim();
    const token = String(env.CLAUDE_CODE_ROUTINE_TOKEN || "").trim();
    if (!rawUrl && !token) {
      return {
        ok: false,
        reason: "not_configured",
        message:
          "Claude Code launcher is not configured — set CLAUDE_CODE_ROUTINE_URL and CLAUDE_CODE_ROUTINE_TOKEN in Envars.",
      };
    }
    if (!rawUrl || !token) {
      const missing = rawUrl ? "CLAUDE_CODE_ROUTINE_TOKEN" : "CLAUDE_CODE_ROUTINE_URL";
      return {
        ok: false,
        reason: "invalid_config",
        message: `${missing} is not set — both Claude Code launcher values are required (Envars).`,
      };
    }
    let fireUrl = null;
    if (kRoutineIdPattern.test(rawUrl)) {
      fireUrl = `https://api.anthropic.com/v1/claude_code/routines/${rawUrl}/fire`;
    } else if (kFireUrlPattern.test(rawUrl)) {
      fireUrl = rawUrl;
    } else {
      return {
        ok: false,
        reason: "invalid_config",
        message:
          "CLAUDE_CODE_ROUTINE_URL must be a trig_… id or the exact https://api.anthropic.com/v1/claude_code/routines/…/fire URL from claude.ai/code/routines.",
      };
    }
    if (!token.startsWith(kRoutineTokenPrefix)) {
      return {
        ok: false,
        reason: "invalid_config",
        message: `CLAUDE_CODE_ROUTINE_TOKEN must start with ${kRoutineTokenPrefix} (the per-routine API-trigger token, not an API key).`,
      };
    }
    return { ok: true, fireUrl, token };
  };

  const getAvailability = () => {
    const config = resolveConfig();
    if (!config.ok) {
      return { available: false, reason: config.reason, message: config.message };
    }
    return { available: true };
  };

  // Upstream prose could echo the token (auth errors sometimes reflect the
  // credential) and may contain newlines; redact configured secrets and keep
  // the log line single-line before it reaches the logger. Redaction runs
  // BEFORE truncation — slicing first could cut a secret at the 300-char
  // boundary, and the surviving fragment would no longer match its full
  // value and leak verbatim. extraSecrets carries the token THIS request
  // used: env is live-reloaded, so after a mid-flight rotation the old
  // credential would no longer be in env's replacement set.
  const sanitizeDetail = (text, extraSecrets = []) => {
    let detail = String(text || "");
    for (const value of extraSecrets) {
      if (value) detail = detail.split(value).join("${CLAUDE_CODE_ROUTINE_TOKEN}");
    }
    for (const [value, replacement] of buildSecretReplacements(env)) {
      detail = detail.split(value).join(replacement);
    }
    return detail.replace(/[\r\n]+/g, " ").slice(0, 300);
  };

  // Retry-After arrives as delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
  const parseRetryAfterSec = (rawValue) => {
    const raw = String(rawValue || "").trim();
    if (!raw) return null;
    const seconds = Number.parseInt(raw, 10);
    if (Number.isFinite(seconds) && String(seconds) === raw && seconds > 0) {
      return seconds;
    }
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
      const delta = Math.ceil((dateMs - nowFn()) / 1000);
      return delta > 0 ? delta : null;
    }
    return null;
  };

  const createSession = async ({ confirmed = false } = {}) => {
    const config = resolveConfig();
    if (!config.ok) {
      return { ok: false, code: config.reason, message: config.message };
    }
    // Consent handshake — checked before the single-flight/cooldown guards so
    // a confirm_required probe consumes neither. This is a UX gate, not an
    // authorization boundary: it stops the FIRST accidental click per browser
    // (the client sends its one-time ui-settings flag), not a determined
    // caller who can POST {confirmed:true} directly. The real actor boundary
    // is requireAuth + admin-only routing + the manifest tier on this op.
    if (confirmed !== true) {
      return {
        ok: false,
        code: "confirm_required",
        message: "Confirmation required before the first fire.",
      };
    }
    if (inFlight) {
      return { ok: false, code: "busy", message: "A session is already starting." };
    }
    const now = nowFn();
    if (now < cooldownUntil) {
      return {
        ok: false,
        code: "cooldown",
        message: "A session was just fired — wait a few seconds before firing another.",
        retryAfterSec: Math.ceil((cooldownUntil - now) / 1000),
      };
    }

    inFlight = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response;
    let json = null;
    try {
      try {
        response = await fetchImpl(config.fireUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.token}`,
            "anthropic-beta": kRoutineBetaHeader,
            "anthropic-version": kAnthropicVersion,
          },
          // The SSRF allowlist validated ONE origin; a redirect would move
          // the request (and bearer header) off it — refuse instead.
          redirect: "error",
          signal: controller.signal,
        });
        // The body read stays under the SAME abort timer: headers can arrive
        // and the body then stall forever — clearing the timer after headers
        // would make this await unbounded (llm-client.js pattern).
        try {
          json = await response.json();
        } catch (error) {
          // undici wraps a body-read abort in `TypeError: terminated`, so the
          // signal state decides, not the error name.
          if (error?.name === "AbortError" || controller.signal.aborted) {
            throw error;
          }
          // Non-abort parse failures fall through with json = null and are
          // classified below (bad_upstream_response on 200, upstream_* else).
        }
      } catch (error) {
        const timedOut =
          error?.name === "AbortError" || controller.signal.aborted;
        if (timedOut) {
          cooldownUntil = nowFn() + timeoutCooldownMs;
          const message = `Timed out after ${Math.round(timeoutMs / 1000)}s — the session may still have been created (the fire endpoint has no idempotency); check claude.ai/code before retrying.`;
          logger.error?.(`[claude-code] fire timeout: ${message}`);
          return { ok: false, code: "timeout", message };
        }
        const detail = sanitizeDetail(error?.message, [config.token]);
        logger.error?.(`[claude-code] fire network failure: ${detail}`);
        // A network error (e.g. ECONNRESET) can strike AFTER the request
        // reached Anthropic — the same maybe-billed ambiguity as a timeout —
        // so it gets the same long cooldown window.
        cooldownUntil = nowFn() + timeoutCooldownMs;
        return {
          ok: false,
          code: "network",
          message:
            "Could not reach api.anthropic.com — the session may still have been created; check claude.ai/code before retrying.",
        };
      }

      if (!response.ok) {
        const detail = sanitizeDetail(
          JSON.stringify(json?.error || json || {}),
          [config.token],
        );
        const code = `upstream_${response.status}`;
        logger.error?.(`[claude-code] fire refused ${code}: ${detail}`);
        const result = { ok: false, code, detail };
        // Cooldown class: 4xx are clear refusals (nothing ran) → short
        // window; 5xx are ambiguous (the fire may have been processed
        // before the error) → the long maybe-billed window; 429 honors the
        // upstream Retry-After (either RFC form), bounded.
        let nextCooldownMs =
          response.status >= 500 ? timeoutCooldownMs : cooldownMs;
        if (response.status === 429) {
          const retryAfterSec = parseRetryAfterSec(
            response.headers?.get?.("retry-after"),
          );
          if (retryAfterSec) {
            result.retryAfterSec = retryAfterSec;
            nextCooldownMs = Math.max(
              nextCooldownMs,
              Math.min(retryAfterSec * 1000, kMaxRetryAfterCooldownMs),
            );
          }
        }
        cooldownUntil = nowFn() + nextCooldownMs;
        return result;
      }

      const sessionId = String(json?.claude_code_session_id || "");
      const sessionUrl = String(json?.claude_code_session_url || "");
      // Exact canonical equality: no credentials, query, fragment, or
      // id/url mismatch can slip past string identity.
      const canonicalUrl = `https://claude.ai/code/${sessionId}`;
      if (!kSessionIdPattern.test(sessionId) || sessionUrl !== canonicalUrl) {
        // Never hand the browser an unvalidated navigation target: the URL
        // must be exactly https://claude.ai/code/session_… or the whole
        // response is treated as malformed. This is the one outcome where a
        // billed session DEFINITELY started (the fire returned 200), so it
        // gets the long cooldown — an immediate retry bills a second session.
        const detail = sanitizeDetail(JSON.stringify(json || {}), [config.token]);
        logger.error?.(`[claude-code] malformed fire response: ${detail}`);
        cooldownUntil = nowFn() + timeoutCooldownMs;
        return {
          ok: false,
          code: "bad_upstream_response",
          message:
            "The routine fired but returned an unusable session URL — the session was created; find it at claude.ai/code instead of retrying.",
        };
      }

      cooldownUntil = nowFn() + cooldownMs;
      logger.info?.(`[claude-code] session started: ${sessionId}`);
      return { ok: true, sessionId, sessionUrl };
    } finally {
      clearTimeout(timer);
      inFlight = false;
    }
  };

  return { getAvailability, createSession };
};

module.exports = {
  createClaudeCodeService,
  kRoutineBetaHeader,
};
