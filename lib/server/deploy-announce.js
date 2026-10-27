const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./utils/safe-file");

// Deploy announcements and measured downtime.
//
//   POST /api/deploy/announce ─▶ announce(): owner notice "restart in N s,
//     back in about M", every sidecar's `announce` command, a pending record
//   SIGTERM ─▶ onShutdown(): records the shutdown time; when nothing was
//     announced in the last window, sends the shutdown notice itself
//   boot starts a pin-change data upgrade ─▶ onDataUpgradeStart(): one
//     "upgrading OpenClaw data" notice with the last upgrade's duration
//   first gateway serving after boot ─▶ onGatewayReady(): downtime = serving −
//     the outage start (the shutdown of the last process that served), kept
//     in a short history, one notice. The sidecar service calls it on the
//     first serving /readyz answer only, never at its 10-min fallback.
//
// The ETA, when the caller gives none, is the median of the measured
// downtimes. Notices carry an expiry so a shutdown notice the outbox could not
// send before exit is never delivered after the box is back.
const kHistoryMax = 20;
const kEtaSampleSize = 5;
const kAnnouncementWindowMs = 10 * 60 * 1000;
const kAnnounceRateLimitMs = 30 * 1000;
const kSidecarAnnounceTimeoutMs = 5000;
const kShutdownNoticeMinLifetimeMs = 2 * 60 * 1000;
const kDataUpgradeNoticeSlackMs = 5 * 60 * 1000;
const kDataUpgradeNoticeIdPrefix = "deploy-upgrading-";

const formatDuration = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
};

const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const createDeployAnnouncer = ({
  rootDir,
  stateFile = path.join(rootDir, "deploy-history.json"),
  fsModule = fs,
  notify = async () => ({ ok: true }),
  flushNotifications = async () => {},
  // (id) => boolean: closes matching undelivered notices (upgrade-notifier).
  retireNotices = () => 0,
  // Whether this boot starts a gateway at all (onboarded at boot). A gateway
  // that first serves after onboarding ends no outage: nothing is measured.
  gatewayExpectedAtBoot = true,
  sidecarService = null,
  insertEvent = () => {},
  processStartedAtMs = Date.now() - Math.round(process.uptime() * 1000),
  now = Date.now,
  logger = console,
}) => {
  const read = () => {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(stateFile, "utf8"));
      return {
        pending: parsed?.pending || null,
        lastShutdown: parsed?.lastShutdown || null,
        history: Array.isArray(parsed?.history) ? parsed.history : [],
      };
    } catch {
      return { pending: null, lastShutdown: null, history: [] };
    }
  };
  const write = (state) => {
    try {
      writeFileAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`, { fsModule });
    } catch (error) {
      logger.warn(`[deploy] could not record deploy state: ${error.message}`);
    }
  };
  let lastAnnounceAt = 0;
  let measured = null;
  let shutdownSeen = false;
  let dataUpgradeNoticeSent = false;

  const estimateEta = (history) => {
    const seconds = median(history.slice(-kEtaSampleSize).map((entry) => entry.seconds).filter(Number.isFinite));
    return seconds === null ? { etaSeconds: null, etaSource: "unknown" } : { etaSeconds: seconds, etaSource: "measured" };
  };

  const recordEvent = (status, details) => {
    try {
      insertEvent({ eventType: "deploy", source: "deploy", status, details });
    } catch {}
  };

  const announceToSidecars = async (env) => {
    if (!sidecarService?.announceAll) return [];
    try {
      return await sidecarService.announceAll(env, kSidecarAnnounceTimeoutMs);
    } catch (error) {
      logger.warn(`[deploy] sidecar announce failed: ${error.message}`);
      return [];
    }
  };

  const announce = async ({ inSeconds, etaSeconds = null, reason = "", source = "api" } = {}) => {
    const at = now();
    if (at - lastAnnounceAt < kAnnounceRateLimitMs) {
      return { ok: false, error: "announce_rate_limited", retryAfterSeconds: Math.ceil((kAnnounceRateLimitMs - (at - lastAnnounceAt)) / 1000) };
    }
    lastAnnounceAt = at;
    const state = read();
    const estimate = etaSeconds !== null ? { etaSeconds, etaSource: "caller" } : estimateEta(state.history);
    const back = estimate.etaSeconds !== null
      ? ` Expected back about ${formatDuration(estimate.etaSeconds)} after it stops${estimate.etaSource === "measured" ? " (typical of recent restarts)" : ""}.`
      : "";
    const why = reason ? ` Reason: ${reason}.` : "";
    const when = inSeconds > 0 ? `in about ${formatDuration(inSeconds)}` : "now";
    const message = `🔄 AlphaClaw will restart for a deploy ${when}.${back}${why}`;
    const lifetimeMs = (inSeconds + (estimate.etaSeconds ?? 600)) * 1000;
    await notify(message, { eventType: "deploy", id: `deploy-announce-${at}`, expiresAt: at + Math.max(lifetimeMs, kShutdownNoticeMinLifetimeMs) }).catch(() => {});
    const sidecars = await announceToSidecars({
      ALPHACLAW_DEPLOY_PHASE: "announced",
      ALPHACLAW_DEPLOY_IN_SECONDS: String(inSeconds),
      ALPHACLAW_DEPLOY_ETA_SECONDS: estimate.etaSeconds === null ? "" : String(estimate.etaSeconds),
      ALPHACLAW_DEPLOY_REASON: reason,
    });
    const pending = { at: isoSeconds(at), inSeconds, ...estimate, reason: reason || null, source };
    write({ ...state, pending });
    recordEvent("ok", { phase: "announced", ...pending, sidecars });
    logger.log(`[deploy] announced restart in ${inSeconds}s (eta ${estimate.etaSeconds ?? "unknown"}s, source ${source})`);
    return { ok: true, announcedAt: pending.at, inSeconds, ...estimate, sidecars };
  };

  const onShutdown = async ({ reason = "" } = {}) => {
    shutdownSeen = true;
    const at = now();
    const state = read();
    const pendingAt = Date.parse(state.pending?.at || "");
    const announced =
      Number.isFinite(pendingAt) &&
      at - pendingAt <= (Number(state.pending.inSeconds) || 0) * 1000 + kAnnouncementWindowMs;
    // A process that never saw its gateway serve is still inside the outage
    // an earlier process's shutdown opened: keep that start, so the next
    // measured downtime covers the whole outage.
    const earlierAtMs = Number(state.lastShutdown?.atMs);
    const outageStillOpen = gatewayExpectedAtBoot && !measured && Number.isFinite(earlierAtMs) && earlierAtMs < processStartedAtMs;
    const lastShutdown = outageStillOpen
      ? { ...state.lastShutdown, announced: state.lastShutdown.announced === true || announced }
      : { at: isoSeconds(at), atMs: at, reason, announced };
    write({ ...state, pending: announced ? state.pending : null, lastShutdown });
    if (reason !== "SIGTERM") return { announced, notified: false };
    const estimate = announced && state.pending.etaSeconds != null
      ? { etaSeconds: state.pending.etaSeconds, etaSource: state.pending.etaSource }
      : estimateEta(state.history);
    const sidecarEnv = {
      ALPHACLAW_DEPLOY_PHASE: "shutting_down",
      ALPHACLAW_DEPLOY_IN_SECONDS: "0",
      ALPHACLAW_DEPLOY_ETA_SECONDS: estimate.etaSeconds === null ? "" : String(estimate.etaSeconds),
      ALPHACLAW_DEPLOY_REASON: announced ? state.pending.reason || "" : "SIGTERM",
    };
    if (announced) {
      await announceToSidecars(sidecarEnv);
      return { announced, notified: false };
    }
    logger.log(`[deploy] SIGTERM with no announcement: sending the shutdown notice (eta ${estimate.etaSeconds ?? "unknown"}s)`);
    const back = estimate.etaSeconds !== null ? ` Expected back in about ${formatDuration(estimate.etaSeconds)} (typical of recent restarts).` : "";
    const lifetimeMs = Math.max((estimate.etaSeconds ?? 0) * 2000, kShutdownNoticeMinLifetimeMs);
    await Promise.all([
      notify(`🔄 AlphaClaw got SIGTERM from the platform and is shutting down, usually for a deploy or a restart.${back}`, {
        eventType: "deploy",
        id: `deploy-shutdown-${at}`,
        expiresAt: at + lifetimeMs,
      })
        .then(() => flushNotifications())
        .catch(() => {}),
      announceToSidecars(sidecarEnv),
    ]);
    return { announced, notified: true };
  };

  // One notice when the boot starts the data upgrade for a new OpenClaw pin,
  // so the owner is not left trusting the shutdown notice's ETA, which is not
  // pin-aware. onGatewayReady retires it (and any earlier boot's), so it is
  // never delivered once the gateway serves; the expiry bounds it otherwise.
  const onDataUpgradeStart = async ({ fromVersion = null, toVersion = null, lastDurationMs = null } = {}) => {
    if (dataUpgradeNoticeSent || measured || shutdownSeen) return { notified: false };
    dataUpgradeNoticeSent = true;
    const at = now();
    const estimateSeconds = Number(lastDurationMs) > 0 ? Math.round(Number(lastDurationMs) / 1000) : null;
    const target = toVersion ? ` to ${toVersion}` : "";
    const estimate = estimateSeconds !== null ? ` The last data upgrade took about ${formatDuration(estimateSeconds)}.` : "";
    await notify(
      `⏳ AlphaClaw is upgrading OpenClaw's data after the update${target}; replies resume when it finishes.${estimate}`,
      {
        eventType: "deploy",
        id: `${kDataUpgradeNoticeIdPrefix}${processStartedAtMs}`,
        expiresAt: at + (estimateSeconds ?? 600) * 1000 + kDataUpgradeNoticeSlackMs,
      },
    ).catch(() => {});
    recordEvent("ok", { phase: "data_upgrade_started", fromVersion, toVersion, estimateSeconds });
    return { notified: true, estimateSeconds };
  };

  // Called once, when the first gateway of this process serves.
  const onGatewayReady = async ({ readyAt } = {}) => {
    if (shutdownSeen) return null;
    dataUpgradeNoticeSent = true;
    try {
      retireNotices((id) => id.startsWith(kDataUpgradeNoticeIdPrefix));
    } catch {}
    const readyMs = Date.parse(readyAt || "") || now();
    const state = read();
    if (!gatewayExpectedAtBoot) {
      write({ ...state, pending: null, lastShutdown: null });
      measured = { measured: false, reason: "not_onboarded_at_boot", readyAt: isoSeconds(readyMs) };
      recordEvent("ok", { phase: "back", ...measured });
      return measured;
    }
    const shutdownMs = Number(state.lastShutdown?.atMs) || Date.parse(state.lastShutdown?.at || "");
    if (!Number.isFinite(shutdownMs) || shutdownMs > processStartedAtMs) {
      measured = { measured: false, bootSeconds: Math.round((readyMs - processStartedAtMs) / 1000), readyAt: isoSeconds(readyMs) };
      recordEvent("ok", { phase: "back", ...measured });
      return measured;
    }
    const seconds = Math.max(0, Math.round((readyMs - shutdownMs) / 1000));
    const entry = {
      shutdownAt: isoSeconds(shutdownMs),
      readyAt: isoSeconds(readyMs),
      seconds,
      reason: state.lastShutdown.reason || null,
      announced: state.lastShutdown.announced === true,
      etaSeconds: state.lastShutdown.announced ? state.pending?.etaSeconds ?? null : null,
    };
    write({ pending: null, lastShutdown: null, history: [...state.history, entry].slice(-kHistoryMax) });
    measured = { measured: true, ...entry };
    recordEvent("ok", { phase: "back", ...entry });
    const eta = entry.etaSeconds !== null ? ` The announced estimate was ${formatDuration(entry.etaSeconds)}.` : "";
    await notify(
      `✅ AlphaClaw is back: down ${formatDuration(seconds)} (stopped ${entry.shutdownAt}, gateway ready ${entry.readyAt}).${eta}`,
      { eventType: "deploy", id: `deploy-back-${shutdownMs}` },
    ).catch(() => {});
    return measured;
  };

  const getStatus = () => {
    const state = read();
    return {
      pending: state.pending,
      lastShutdown: state.lastShutdown ? { at: state.lastShutdown.at, reason: state.lastShutdown.reason, announced: state.lastShutdown.announced } : null,
      thisBoot: measured,
      history: state.history.slice(-10),
      ...estimateEta(state.history),
    };
  };

  return { announce, onShutdown, onDataUpgradeStart, onGatewayReady, getStatus, getLastDowntimeSeconds: () => (measured?.measured ? measured.seconds : null) };
};

module.exports = { createDeployAnnouncer, formatDuration, median };
