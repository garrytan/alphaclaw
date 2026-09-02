// Pure view-model builders for the OpenClaw Upgrade page. Everything here is
// display logic and must stay free of Preact/DOM imports so it can be tested
// directly in node.

import { buildErrorEnvelopeModel } from "../../lib/error-envelope.js";
import {
  formatBytes,
  formatLocaleDate,
  formatLocaleDateTime,
  formatRelativeTime,
} from "../../lib/format.js";

export const kOpenclawChannels = ["stable", "beta", "dev"];

export const kChannelLabels = {
  stable: "Stable",
  beta: "Beta",
  dev: "Dev",
};

export const kChannelTooltips = {
  stable: "The version AlphaClaw ships and tests against",
  beta: "Upstream's pre-release train — new features sooner, occasional bugs",
  dev: "Built from OpenClaw's main branch source — newest possible, auto-rollback protects you",
};

export const buildChannelOptions = () =>
  kOpenclawChannels.map((value) => ({
    value,
    label: kChannelLabels[value],
    title: kChannelTooltips[value],
  }));

export const kBootCostNote =
  "Channel-applied versions add ~10-60s to the first restart after a version change (settings migration and install checks run once; later restarts are fast).";
export const kAutoAcceptedNote =
  "Auto-rollback stays armed for 24h after activation — 'Mark as good now' disarms it.";
export const kPackageApplyImpactNote =
  "~2 min, your agent will be briefly offline";
export const kDevApplyImpactNote =
  "compiles from source, 20-35 minutes; your agent stays up until the final restart";
export const kBackupScopeNote =
  "Backup includes OpenClaw's config, sessions and pairings; your workspace repo is already safe in git.";
export const kDevRequirementsNote =
  "≈5 GB free on the data volume · 8 GB RAM recommended · first build takes 20-35 minutes";
export const kDevUntestedCaveat = "untested snapshot";
export const kRepairCaption =
  "Finishes a half-completed update; doesn't touch your data";
export const kDriftNotice =
  "OpenClaw was changed outside this dashboard (possibly by your agent) — reverted to your selection.";
export const kRestartingMessage =
  "AlphaClaw is restarting — this page will reconnect automatically (up to ~2 min)";
export const kNotesUnavailableLabel = "release notes unavailable offline";
export const kAlphaclawCrossLink =
  "Looking for AlphaClaw updates? Use the update dialog in the sidebar.";
export const kNpmDegradedApplyNote =
  "npm registry unreachable — installs are gated on npm";
export const kGithubDegradedNotesNote =
  "GitHub unreachable — release notes may be unavailable";
export const kBreakingSafetyNote =
  "Verified backup required and taken first · 120s health check · auto-rollback stays armed for 24h · a failing version gets blocklisted.";
export const kBackupHardGateNote = "If the backup fails, nothing is installed.";
export const kBackupPauseNote =
  "The gateway pauses briefly during the pre-update backup.";
// WI-4.4/4.5: the reuse consent is the LAST line of the hard-gate confirm.
// Default OFF, never persisted, bound to ONE archive's sha256 — the server
// re-verifies the digest before waving that backup through the hard gate.
export const kBackupReuseConsentLabel =
  "If a fresh backup can't be made, proceed with the most recent verified backup";
export const kBackupReuseNoneReason = "No eligible backup to reuse";
// Mirrors the server's reuse gate (`kOpenclawBackupReuseMaxAgeMs` in
// lib/server/constants.js, applied in `tryReuseRecentBackup`): an archive
// older than this is never accepted, so offering consent for it would make
// the confirm promise a fallback the server refuses.
export const kBackupReuseMaxAgeMs = 24 * 60 * 60 * 1000;
export const kBackupReuseStaleReason =
  "No verified backup from the last 24 hours that postdates the last update — if a fresh backup fails, nothing is installed.";
export const kBackupReuseNoDigestReason =
  "The newest eligible backup has no recorded digest to bind this consent to — if a fresh backup fails, you'll be offered it after the update stops.";
// A hard-gated confirm must never call a backup list it could not read
// "empty" (AGENTS.md: loading / error / genuinely-empty are distinct states).
// These two are retryable — the dialog offers the same re-read as the card.
export const kBackupReuseInventoryLoadingReason =
  "Loading the backup list — the consent line binds once it arrives; if a fresh backup fails, nothing is installed.";
export const kBackupReuseInventoryErrorReason =
  "Couldn't read the backup list, so no backup can be named here — retry the read, or continue: if a fresh backup fails, nothing is installed.";
export const kBackupReuseInventoryUnreadableReason =
  "The backups directory couldn't be read, so no backup can be named here — retry the read, or continue: if a fresh backup fails, nothing is installed.";
// The pre-update backup runs on EVERY apply (same-channel stable upgrades are
// only soft-gated on its failure) — the copy must not imply cross-channel only.
export const kBackupsEmptyLabel =
  "No backups yet — the next OpenClaw update takes one before installing";
export const kBackupsErrorHeadline = "Couldn't read backups";
export const kBackupsUnreadableMessage =
  "The backups directory could not be read — it may not exist yet, may be a stray file, or may be unreadable";
export const kBackupsRunbookUrl =
  "https://github.com/chrysb/alphaclaw/blob/main/docs/upgrade-troubleshooting.md#restoring-a-backup";
export const kBackupProducerLabels = {
  openclaw: "upstream",
  "alphaclaw-offline-copy": "offline copy",
};
// Inventory `ineligibleReason` → the visible reason text on the row badge
// (tooltips are supplementary only — the reason must be readable inline).
export const kBackupIneligibleReasonLabels = {
  outside_dir: "outside the backups directory",
  symlink: "not a regular file",
  no_provenance: "no run record for it",
  unverified: "never verified",
  partial: "workspace files excluded",
  missing: "no longer on disk",
};
const kSha256Pattern = /^[0-9a-f]{64}$/;
export const kBackupPartialBadgePrefix = "partial";

// The visible reason a partial archive is less than the whole state dir. New
// records carry `partialReasons: string[]` (workspace exclusion and/or skipped
// core symlinks such as credentials) — rendered verbatim, joined with "; ".
// Old records only carry `partial: true`, so they keep the generic
// workspace-excluded label rather than claiming a reason nobody recorded.
export const buildBackupPartialReasonText = (entry = null) => {
  const reasons = Array.isArray(entry?.partialReasons)
    ? entry.partialReasons.filter(
        (reason) => typeof reason === "string" && reason.trim(),
      )
    : [];
  return reasons.length > 0
    ? reasons.map((reason) => reason.trim()).join("; ")
    : kBackupIneligibleReasonLabels.partial;
};

export const buildBackupPartialBadgeLabel = (entry = null) =>
  `${kBackupPartialBadgePrefix} — ${buildBackupPartialReasonText(entry)}`;

export const kApplyStepPreview = [
  "Backup",
  "Download",
  "Verify",
  "Restart (~2 min)",
  "Stabilizing (24h auto-rollback window)",
];

// ---------------------------------------------------------------------------
// Time / formatting
// ---------------------------------------------------------------------------

const toEpochMs = (value) => {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

export const formatShortSha = (sha) => String(sha || "").slice(0, 7);

// formatDateTime/formatDateOnly keep their names and toEpochMs coercion (real
// behavior: numeric-or-parseable inputs) on top of the shared locale
// formatters.
export const formatDateTime = (value, fallback = "—") => {
  const ms = toEpochMs(value);
  if (ms == null) return fallback;
  return formatLocaleDateTime(ms, { valueIsEpochMs: true, fallback });
};

export const formatDateOnly = (value, fallback = "—") => {
  const ms = toEpochMs(value);
  if (ms == null) return fallback;
  return formatLocaleDate(ms, { valueIsEpochMs: true, fallback });
};

// Keeps the null-for-invalid contract; rendering rides the shared relative
// core (long style: "5 minutes ago", seconds tier "42 seconds ago").
export const formatRelativeAge = (value, nowMs = Date.now()) => {
  const ms = toEpochMs(value);
  if (ms == null) return null;
  return formatRelativeTime(ms, { nowMs, style: "long" });
};

// A bare span noun ("2 hours", "3 days") for "taken <span> before this
// update" phrasing — same tiers as the shared relative formatter, without the
// direction suffix. Sub-5s spans read "moments".
export const describeAgeSpan = (ageMs, nowMs = Date.now()) => {
  const ms = Number(ageMs);
  if (!Number.isFinite(ms) || ms < 0) return "some time";
  const relative = formatRelativeTime(nowMs - ms, { nowMs, style: "long" });
  return relative.endsWith(" ago") ? relative.slice(0, -4) : "moments";
};

export const buildStalenessLabel = (staleAsOf, nowMs = Date.now()) => {
  const age = formatRelativeAge(staleAsOf, nowMs);
  return age ? `Catalog as of ${age}` : "Catalog freshness unknown";
};

// Canonical home is lib/update-progress-model.js (shared, dependency-free
// CJS — boot-time workstreams require it directly); re-exported here so
// existing frontend imports keep working.
export { formatElapsed } from "../../../../update-progress-model.js";

export const formatHeartbeat = (lastOutputAt, nowMs = Date.now()) => {
  const at = toEpochMs(lastOutputAt);
  if (at == null) return null;
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  return `last output ${seconds}s ago`;
};

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

const parseVersionParts = (version) => {
  const raw = String(version || "").trim().replace(/^v/, "");
  const [core, ...preParts] = raw.split("-");
  const nums = core
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((num) => (Number.isFinite(num) ? num : 0));
  return { nums, pre: preParts.join("-") };
};

// Suffix ranking follows OpenClaw's publishing convention, not plain semver:
// a bare numeric suffix (2026.7.1-2) is an out-of-band HOTFIX above the base
// release, while a labeled suffix (2026.8.1-beta.3) is a prerelease below it.
const suffixRank = (pre) => {
  if (!pre) return 0; // base release
  if (/^\d+$/.test(pre)) return 1; // hotfix — above the base
  return -1; // prerelease label — below the base
};

// A labeled suffix (beta.3, rc.1) marks a prerelease; a bare numeric suffix
// is an out-of-band hotfix, not a prerelease (see suffixRank).
export const isPrereleaseVersion = (version) => {
  const { pre } = parseVersionParts(version);
  return Boolean(pre) && !/^\d+$/.test(pre);
};

export const compareVersions = (a, b) => {
  const va = parseVersionParts(a);
  const vb = parseVersionParts(b);
  const length = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (va.nums[i] || 0) - (vb.nums[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  const ra = suffixRank(va.pre);
  const rb = suffixRank(vb.pre);
  if (ra !== rb) return ra > rb ? 1 : -1;
  if (va.pre === vb.pre) return 0;
  // Dotted label segments compare numerically where both sides are numbers:
  // beta.10 > beta.9 (plain string compare would invert this) — mirrors the
  // server's compareVersionParts.
  const compareLabelSegments = (x, y) => {
    const xParts = x.split(".");
    const yParts = y.split(".");
    const length = Math.max(xParts.length, yParts.length);
    for (let i = 0; i < length; i += 1) {
      const xs = xParts[i] ?? "";
      const ys = yParts[i] ?? "";
      if (xs === ys) continue;
      const xn = Number.parseInt(xs, 10);
      const yn = Number.parseInt(ys, 10);
      if (Number.isFinite(xn) && Number.isFinite(yn) && xn !== yn) {
        return xn > yn ? 1 : -1;
      }
      return xs > ys ? 1 : -1;
    }
    return 0;
  };
  if (ra === 1) {
    // both hotfixes: numeric order ("-2" vs "-02" parse equal → equal),
    // mirroring the server's compareVersionParts.
    const hotfixA = Number.parseInt(va.pre, 10);
    const hotfixB = Number.parseInt(vb.pre, 10);
    if (hotfixA === hotfixB) return 0;
    return hotfixA > hotfixB ? 1 : -1;
  }
  return compareLabelSegments(va.pre, vb.pre);
};

// ---------------------------------------------------------------------------
// Catalog rows
// ---------------------------------------------------------------------------

// Friendly copy for machine blocklist reasons; unknown values pass through.
export const kBlocklistReasonLabels = {
  config_error: "configuration error (exit 78)",
  config_migration_failed: "settings migration failed before first launch",
  crash_loop: "crash loop",
  degraded: "degraded health",
};

export const buildBlocklistDetail = (blocklisted = {}) => {
  const parts = [];
  const reason = blocklisted?.reason
    ? kBlocklistReasonLabels[blocklisted.reason] || blocklisted.reason
    : null;
  parts.push(reason ? `trigger: ${reason}` : "trigger: unknown");
  if (blocklisted?.exitCode != null) {
    parts.push(`exit code ${blocklisted.exitCode}`);
  }
  const at = formatDateTime(blocklisted?.at, "");
  if (at) parts.push(at);
  return parts.join(" · ");
};

export const buildRowBadges = (row = {}) => {
  const badges = [];
  if (row.current) {
    badges.push({ id: "current", label: "current", tone: "success" });
  }
  if (row.isDistTagLatest) {
    badges.push({ id: "latest", label: "latest", tone: "info" });
  }
  if (row.lastKnownGood) {
    badges.push({
      id: "last-known-good",
      label: "last known good",
      tone: "cyan",
    });
  }
  if (row.blocklisted) {
    badges.push({
      id: "blocklisted",
      label: "blocklisted",
      tone: "danger",
      detail: buildBlocklistDetail(row.blocklisted),
    });
  }
  return badges;
};

// Switch/Upgrade/Downgrade label for a package row. VERSION ORDER decides —
// never list position: rows are sorted by publish date, and extended-stable
// backports (e.g. 2026.6.34 published after 2026.7.1-2) sit above the current
// release while being older versions. Mislabeling them "Upgrade" would skip
// the downgrade confirm + backup gate. (Caught live by /devex-review.)
export const getRowActionModel = ({
  row = null,
  rows = [],
  installedVersion = null,
} = {}) => {
  if (row?.current) {
    return { label: "Current", disabled: true, isDowngrade: false };
  }
  const list = Array.isArray(rows) ? rows : [];
  const currentVersion =
    installedVersion || list.find((entry) => entry?.current)?.version || null;
  let isDowngrade = false;
  let isUpgrade = false;
  if (currentVersion && row?.version) {
    const cmp = compareVersions(row.version, currentVersion);
    isDowngrade = cmp < 0;
    isUpgrade = cmp > 0;
  }
  return {
    label: isDowngrade ? "Downgrade" : isUpgrade ? "Upgrade" : "Switch",
    disabled: false,
    isDowngrade,
  };
};

// U2: the newest non-current, non-blocklisted target of the active channel.
export const getLatestApplicableTarget = ({
  catalog = null,
  releaseChannel = "stable",
} = {}) => {
  if (!catalog) return null;
  if (releaseChannel === "dev") {
    return {
      applyPayload: { channel: "dev", devHead: true },
      label: "latest dev (main HEAD)",
      devHead: true,
    };
  }
  const rows = Array.isArray(catalog[releaseChannel])
    ? catalog[releaseChannel]
    : [];
  const eligible = rows.filter(
    (entry) => entry && !entry.current && !entry.blocklisted,
  );
  // Stable: the npm dist-tag defines "latest" — a later-published backport
  // (extended-stable line) must never become the primary update target.
  const row =
    (releaseChannel === "stable"
      ? eligible.find((entry) => entry.isDistTagLatest)
      : null) ||
    eligible.slice().sort((x, y) => compareVersions(y.version, x.version))[0] ||
    null;
  if (!row) return null;
  return {
    applyPayload:
      row.applyPayload || { channel: releaseChannel, version: row.version },
    label: row.version,
    row,
  };
};

// "N releases behind" — only meaningful when the installed version actually belongs
// to the selected channel's catalog. Running stable while browsing beta is
// "not-on-channel", not "behind"; a cold/empty catalog is "unknown".
export const computeReleasesBehind = ({
  catalog = null,
  releaseChannel = "stable",
  installedVersion = null,
} = {}) => {
  if (!catalog || releaseChannel === "dev" || !installedVersion) {
    return { status: "unknown", count: 0 };
  }
  const rows = Array.isArray(catalog[releaseChannel])
    ? catalog[releaseChannel]
    : [];
  if (rows.length === 0) return { status: "unknown", count: 0 };
  const onChannel = rows.some((entry) => entry?.version === installedVersion);
  if (!onChannel) return { status: "not-on-channel", count: 0 };
  const behind = rows.filter(
    (entry) =>
      entry?.version &&
      !entry.blocklisted &&
      compareVersions(entry.version, installedVersion) > 0,
  ).length;
  return { status: behind > 0 ? "behind" : "current", count: behind };
};

export const formatReleasesBehind = (result, channelLabel = "") => {
  if (!result || result.status === "unknown") return null;
  if (result.status === "not-on-channel") {
    return "Not running the selected channel";
  }
  if (result.status === "current") return "Up to date";
  const noun = result.count === 1 ? "release" : "releases";
  const scope = channelLabel ? `${channelLabel} ` : "";
  return `${result.count} ${scope}${noun} behind`;
};

// ---------------------------------------------------------------------------
// Apply progress steps
// ---------------------------------------------------------------------------

// Canonical home is lib/update-progress-model.js (shared, dependency-free
// CJS — boot-time workstreams require it directly); re-exported here so
// existing frontend imports keep working.
export {
  buildStepListModel,
  kStepLabels,
} from "../../../../update-progress-model.js";

export const describeTarget = (target = null) => {
  if (!target) return "unknown target";
  if (target.channel === "dev") {
    return target.devHead
      ? "latest dev (main HEAD)"
      : `dev ${formatShortSha(target.sha)}`;
  }
  if (target.version) return target.version;
  return `latest ${target.channel || ""}`.trim();
};

// ---------------------------------------------------------------------------
// Status card
// ---------------------------------------------------------------------------

export const describeLastKnownGood = (lastKnownGood = null) => {
  if (!lastKnownGood) return null;
  const pkg = lastKnownGood.package || null;
  const dev = lastKnownGood.dev ? `dev ${formatShortSha(lastKnownGood.dev)}` : null;
  if (pkg && dev) return `${pkg} · ${dev}`;
  return pkg || dev || null;
};

export const buildLastUpdateSummary = (run = null) => {
  if (!run) return null;
  if (run.finishedAt == null) {
    return { inFlight: true, ok: null, text: `Updating to ${describeTarget(run.target)}…` };
  }
  const when = formatDateTime(run.finishedAt);
  if (run.ok) {
    return {
      inFlight: false,
      ok: true,
      text: `Updated to ${describeTarget(run.target)} · ${when}`,
    };
  }
  return {
    inFlight: false,
    ok: false,
    text: `Update to ${describeTarget(run.target)} failed · ${when}`,
  };
};

// D1: "config migration" is implementation language — the row says what
// happened to the user's settings. A failed attempt states the consequence
// and the automatic retry (the trigger stays armed until a run succeeds).
export const buildSettingsMigrationRow = (configMigration = null) => {
  if (!configMigration || typeof configMigration !== "object") return null;
  const attempt = configMigration.lastAttempt;
  if (attempt && attempt.ok === false) {
    return {
      ok: false,
      text: `Settings update for ${attempt.version || "this version"} failed — OpenClaw may refuse to start until it succeeds. It retries at the next restart.`,
    };
  }
  if (configMigration.completedForVersion) {
    return {
      ok: true,
      text: `Settings updated for ${configMigration.completedForVersion}`,
    };
  }
  return null;
};

export const formatWindowRemaining = (endsAt, nowMs) => {
  const remainingMs = Number(endsAt) - Number(nowMs);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const hours = Math.round(remainingMs / 3_600_000);
  if (hours >= 2) return `~${hours}h left`;
  const minutes = Math.max(1, Math.round(remainingMs / 60_000));
  return `~${minutes}m left`;
};

export const buildStatusCardModel = (info = null, nowMs = Date.now()) => {
  if (!info) return null;
  const appliedChannel = info.applied?.channel || null;
  // A dev build's identity is its commit — installedVersion is only the
  // dormant pin the install would fall back to, so it must not lead.
  const runningLabel =
    appliedChannel === "dev"
      ? `dev ${formatShortSha(info.appliedId)}${
          info.installedVersion
            ? ` (package ${info.installedVersion} dormant)`
            : ""
        }`
      : info.installedVersion || info.pinVersion || "unknown";
  const stabilizing = Boolean(info.inStabilizationWindow) && !info.acceptedAt;
  // Two-tier window: an auto-accepted build (acceptedSource "acceptance")
  // keeps the 24h rollback window armed even after acceptedAt is set.
  const autoAcceptedInWindow =
    Boolean(info.inStabilizationWindow) && Boolean(info.acceptedAt);
  const lastKnownGoodLabel = describeLastKnownGood(info.lastKnownGood);
  return {
    releaseChannel: info.releaseChannel || "stable",
    runningLabel,
    pinVersion: info.pinVersion || null,
    isPin: Boolean(info.isPin),
    bootCostNote: info.isPin ? null : kBootCostNote,
    // Actions (Mark as good now / Roll back now) stay available for as long
    // as the rollback window is armed — auto-acceptance keeps it armed, and
    // the auto-accepted note tells users "Mark as good now" disarms it, so
    // the button must actually be there. Manual mark-good always wins.
    showStabilizationActions: Boolean(info.inStabilizationWindow),
    stabilization: stabilizing
      ? {
          badge: "STABILIZING",
          // D1: "stabilization window" is implementation language — the line
          // says what the period IS and what it falls back to.
          line: `Post-upgrade monitoring period — auto-rollback armed → last known good: ${
            lastKnownGoodLabel || info.pinVersion || "built-in pin"
          }`,
          caption:
            "Mark as good now — otherwise auto-rollback reverts this version if it crash-loops in its first 24h.",
        }
      : null,
    autoAcceptedNote: autoAcceptedInWindow
      ? [
          kAutoAcceptedNote,
          formatWindowRemaining(info.stabilizationEndsAt, nowMs),
        ]
          .filter(Boolean)
          .join(" ")
      : null,
    lastUpdate: buildLastUpdateSummary(info.lastUpdateRun),
    lastKnownGood: lastKnownGoodLabel,
    settingsMigration: buildSettingsMigrationRow(info.configMigration),
    driftNotice:
      info.lastBoot?.action === "drift_reverted" ? kDriftNotice : null,
  };
};

// Per-source degradation, and what it gates: npm is the install path, GitHub
// is the release-notes path. `catalog.degraded` comes from the server's
// getCatalog ({github: bool, npm: bool}).
export const buildCatalogGatingModel = (catalog = null) => {
  const githubDegraded = Boolean(catalog?.degraded?.github);
  const npmDegraded = Boolean(catalog?.degraded?.npm);
  return {
    githubDegraded,
    npmDegraded,
    applyDisabled: npmDegraded,
    applyDisabledReason: npmDegraded ? kNpmDegradedApplyNote : null,
    notesNote: githubDegraded ? kGithubDegradedNotesNote : null,
  };
};

// An empty channel list is NOT "you're current" when a source is down —
// telling degraded and genuinely-current apart is what keeps the
// "already on the latest beta" copy honest.
export const isChannelListEmptyBecauseDegraded = ({
  catalog = null,
  releaseChannel = "stable",
} = {}) => {
  if (!catalog) return false;
  const gating = buildCatalogGatingModel(catalog);
  if (releaseChannel === "dev") {
    return (catalog.dev?.commits || []).length === 0 && gating.githubDegraded;
  }
  const rows = Array.isArray(catalog[releaseChannel])
    ? catalog[releaseChannel]
    : [];
  return rows.length === 0 && (gating.npmDegraded || gating.githubDegraded);
};

export const buildNoTargetNotice = ({
  catalog = null,
  releaseChannel = "stable",
} = {}) =>
  isChannelListEmptyBecauseDegraded({ catalog, releaseChannel })
    ? `Catalog degraded — can't confirm the latest ${releaseChannel} right now.`
    : `You're already on the latest ${releaseChannel}.`;

export const buildAvailabilityLine = ({
  catalog = null,
  releaseChannel = "stable",
  installedVersion = null,
} = {}) => {
  if (!catalog) return null;
  if (releaseChannel === "dev") {
    const head = (catalog.dev?.commits || [])[0] || null;
    if (!head) {
      return isChannelListEmptyBecauseDegraded({ catalog, releaseChannel })
        ? "Catalog degraded — can't confirm the latest dev commit."
        : "No dev commits listed.";
    }
    return head.current
      ? "You're on the latest dev commit."
      : `Latest dev commit: ${head.shortSha || formatShortSha(head.sha)}`;
  }
  const rows = Array.isArray(catalog[releaseChannel])
    ? catalog[releaseChannel]
    : [];
  // "Latest" is the dist-tag for stable (never max publish date — backports
  // publish later), and the highest version otherwise.
  const latest =
    (releaseChannel === "stable"
      ? rows.find((entry) => entry?.isDistTagLatest)
      : null) ||
    rows.slice().sort((x, y) => compareVersions(y.version, x.version))[0] ||
    null;
  if (!latest) {
    return isChannelListEmptyBecauseDegraded({ catalog, releaseChannel })
      ? `Catalog degraded — can't confirm the latest ${releaseChannel} right now.`
      : `No ${releaseChannel} releases listed.`;
  }
  if (latest.current) return `You're on the latest ${releaseChannel} version.`;
  // Honest distance detail (E2/D13): counted only when the installed version
  // belongs to this channel's catalog; cross-channel reads "not on this channel".
  const behind = computeReleasesBehind({
    catalog,
    releaseChannel,
    installedVersion,
  });
  const suffix =
    behind.status === "behind"
      ? ` — ${formatReleasesBehind(behind, releaseChannel)}`
      : behind.status === "not-on-channel"
        ? " — not running this channel yet"
        : // D13: don't silently omit the distance claim when it can't be
          // computed (no installed version / degraded read) — say so plainly
          // rather than implying the running build is up to date.
          behind.status === "unknown"
          ? " — update status unavailable"
          : "";
  return `Latest ${releaseChannel}: ${latest.version}${suffix}`;
};

// ---------------------------------------------------------------------------
// Confirm dialogs (U1/U3/U9)
// ---------------------------------------------------------------------------

// The reuse gate's window start: an archive taken before the newest
// successful apply / activation / settings migration predates state the
// current build has already rewritten, so the gate refuses it. The inventory
// (GET /api/openclaw/backups) publishes the server's own value as
// `reuseWindowStartMs` — computed by the SAME helper the gate uses, and the
// only place the run ledger's older activations are visible to the UI — so it
// is preferred whenever present. The channel-payload mirror below (the same
// three records the server reads: `applied.at`, the last update run's
// ACTIVATION time — `finishedAt`, falling back to `startedAt` for legacy
// records — when that run succeeded, `configMigration.lastAttempt.at` when
// that attempt succeeded) stays as the fallback for older servers, and is folded in with
// max() rather than discarded: both are lower bounds on the window, and the
// channel payload can be fresher than a cached inventory right after an apply.
export const buildBackupReuseWindowStartMs = (channelInfo = null, inventory = null) => {
  let since = 0;
  const serverSince = toEpochMs(inventory?.reuseWindowStartMs);
  if (serverSince != null) since = Math.max(since, serverSince);
  const appliedAt = toEpochMs(channelInfo?.applied?.at);
  if (appliedAt != null) since = Math.max(since, appliedAt);
  const lastRun = channelInfo?.lastUpdateRun;
  // Activation time, not start: the run's own pre-update backup was taken
  // after it started and before it switched, so the start would leave that
  // archive reusable after the state it preceded was rewritten.
  const lastRunActivatedAt = toEpochMs(lastRun?.finishedAt) ?? toEpochMs(lastRun?.startedAt);
  if (lastRun?.ok === true && lastRunActivatedAt != null) {
    since = Math.max(since, lastRunActivatedAt);
  }
  const migration = channelInfo?.configMigration?.lastAttempt;
  const migrationAt = toEpochMs(migration?.at);
  if (migration?.ok === true && migrationAt != null) {
    since = Math.max(since, migrationAt);
  }
  return since;
};

// The gate's max archive age: the inventory's `reuseMaxAgeMs` when the server
// publishes it (one constant, server-owned), else the 24 h mirror.
export const buildBackupReuseMaxAgeMs = (inventory = null) => {
  const serverMaxAge = Number(inventory?.reuseMaxAgeMs);
  return Number.isFinite(serverMaxAge) && serverMaxAge > 0
    ? serverMaxAge
    : kBackupReuseMaxAgeMs;
};

// The newest archive the reuse gate could accept, and whether the confirm
// dialog can bind consent to it. Mirrors the server's candidate filter
// (eligible · on disk · verified · not partial · has a timestamp · at most
// the reuse max age old · not older than the reuse window start — both
// server-published on the inventory when available); the sha256 must come
// from the inventory entry itself — the UI never hashes and never sends a
// path. `available:false` carries the visible reason. A list that is still
// loading, failed to load (`inventoryError`, no last-known data) or that the
// server could not scan (`readable:false`) is NOT "no eligible backup" — the
// reason says so and `retryable` lets the dialog offer the re-read.
export const buildBackupReuseConsentModel = ({
  inventory = null,
  inventoryError = null,
  inventoryLoading = false,
  channelInfo = null,
  nowMs = Date.now(),
} = {}) => {
  const unavailable = { available: false, entry: null, sha256: null };
  if (inventory == null && inventoryError) {
    return { ...unavailable, reason: kBackupReuseInventoryErrorReason, retryable: true };
  }
  if (inventory == null && inventoryLoading === true) {
    return { ...unavailable, reason: kBackupReuseInventoryLoadingReason, retryable: false };
  }
  if (inventory?.readable === false) {
    return { ...unavailable, reason: kBackupReuseInventoryUnreadableReason, retryable: true };
  }
  const entries = Array.isArray(inventory?.entries) ? inventory.entries : [];
  const verifiedCandidates = entries.filter(
    (entry) =>
      entry &&
      entry.eligible === true &&
      entry.exists !== false &&
      entry.verified === true &&
      entry.partial !== true &&
      Number.isFinite(Number(entry.at)),
  );
  if (verifiedCandidates.length === 0) {
    return { available: false, entry: null, sha256: null, reason: kBackupReuseNoneReason };
  }
  const since = buildBackupReuseWindowStartMs(channelInfo, inventory);
  const maxAgeMs = buildBackupReuseMaxAgeMs(inventory);
  const candidates = verifiedCandidates.filter(
    (entry) => nowMs - Number(entry.at) <= maxAgeMs && Number(entry.at) >= since,
  );
  if (candidates.length === 0) {
    return { available: false, entry: null, sha256: null, reason: kBackupReuseStaleReason };
  }
  const newest = candidates.reduce((best, entry) =>
    Number(entry.at) > Number(best.at) ? entry : best,
  );
  const ageLabel = formatRelativeAge(newest.at, nowMs) || "at an unknown time";
  const base = {
    entry: newest,
    name: newest.name || String(newest.file || "").split("/").pop() || "backup",
    ageLabel,
    producerLabel: kBackupProducerLabels[newest.producer] || newest.producer || "unknown",
    lossWindowLine: `Taken ${ageLabel} — state written since would not be in it.`,
  };
  if (!kSha256Pattern.test(String(newest.sha256 || ""))) {
    return { ...base, available: false, sha256: null, reason: kBackupReuseNoDigestReason };
  }
  return { ...base, available: true, sha256: newest.sha256, reason: null };
};

// Consent rides the apply body as `allowBackupReuse: { sha256 }` — an object
// bound to ONE digest (bare true / strings are 400s server-side). Anything
// short of "checked AND a digest to bind to" sends no consent at all.
export const buildBackupReuseConsent = ({
  consentModel = null,
  checked = false,
} = {}) => {
  if (checked !== true) return null;
  if (!consentModel?.available) return null;
  if (!kSha256Pattern.test(String(consentModel.sha256 || ""))) return null;
  return { sha256: consentModel.sha256 };
};

export const buildApplyConfirmModel = ({
  payload = {},
  label = "",
  isDowngrade = false,
  currentChannel = "stable",
  notesAvailable = null,
  securityFlips = [],
  backupInventory = null,
  backupInventoryError = null,
  backupInventoryLoading = false,
  channelInfo = null,
  nowMs = Date.now(),
} = {}) => {
  const isDev = payload.channel === "dev";
  const lines = [
    `Impact: ${isDev ? kDevApplyImpactNote : kPackageApplyImpactNote}.`,
    `Backup included — ${kBackupScopeNote}`,
  ];
  if (isDev && !payload.devHead) {
    lines.push(
      "This commit is an untested snapshot from OpenClaw's main branch.",
    );
  }
  if (isDowngrade) {
    lines.push(
      "Downgrading can leave newer state formats behind; OpenClaw may warn on first boot.",
    );
  }
  // Breaking-change framing lives HERE, on the moment of commitment: crossing
  // stable→beta/dev or applying any prerelease spells out the safety net and
  // the backup hard gate (the server refuses to install if the backup fails).
  const crossesChannel =
    currentChannel === "stable" && Boolean(payload.channel) &&
    payload.channel !== "stable";
  const isBreaking = crossesChannel || isPrereleaseVersion(payload.version);
  if (isBreaking) {
    if (notesAvailable === true) {
      lines.push(`Release notes for ${label} are on its catalog row.`);
    } else if (notesAvailable === false) {
      lines.push("Release notes are unavailable right now (source degraded).");
    }
    lines.push(`Safety net: ${kBreakingSafetyNote}`);
  }
  // The server hard-gates downgrades, dev switches AND cross-channel /
  // prerelease applies on the verified backup, and quiesces the gateway for
  // it — every hard-gated confirm says so (issue #54: a same-channel
  // downgrade used to skip both lines).
  const hardGate = isBreaking || isDowngrade || isDev;
  if (hardGate) {
    lines.push(kBackupHardGateNote);
    lines.push(kBackupPauseNote);
  }
  return {
    title: isDowngrade ? `Downgrade to ${label}?` : `Switch to ${label}?`,
    tone: isDowngrade ? "warning" : "primary",
    confirmLabel: isDowngrade ? "Downgrade" : "Apply",
    lines,
    isDowngrade,
    isBreaking,
    hardGate,
    steps: isBreaking ? kApplyStepPreview : null,
    // Curated security-default flips for the target channel (D5): shown inside
    // the apply confirm so critical behavior changes (each flip carries
    // key/from/to/warning) are visible BEFORE committing.
    securityFlips: Array.isArray(securityFlips) ? securityFlips : [],
    // Reuse consent (WI-4.5) only means something behind the hard gate; a
    // soft-gated upgrade proceeds without a backup anyway.
    backupReuse: hardGate
      ? buildBackupReuseConsentModel({
          inventory: backupInventory,
          inventoryError: backupInventoryError,
          inventoryLoading: backupInventoryLoading,
          channelInfo,
          nowMs,
        })
      : null,
  };
};

// The offer's age strings, derived from the archive's absolute timestamp at
// RENDER time: the failed card can sit on screen for hours while the page's
// `nowMs` ticks, and the loss window it discloses must keep pace with every
// sibling card's ages rather than freeze at the moment the 409 arrived.
export const buildBackupReuseOfferLabels = (offer = null, nowMs = Date.now()) => {
  const at = toEpochMs(offer?.at);
  const ageLabel =
    at != null
      ? formatRelativeTime(at, { nowMs, style: "long" }) || "at an unknown time"
      : "at an unknown time";
  return {
    ageLabel,
    ctaLabel: `Retry using the backup taken ${ageLabel}`,
    lossWindowLine: `That backup was taken ${ageLabel} — state written since would not be in it.`,
  };
};

// 409 backup_failed with `reusableBackup` = the ladder exhausted and the
// server found ONE verified archive it would accept with consent. The offer
// binds to that sha256; the retry re-runs the FULL ladder first (pause and
// all) and only then falls back to the named backup — the dialog says so.
export const buildBackupReuseOfferModel = ({
  error = null,
  target = null,
  label = "",
  nowMs = Date.now(),
} = {}) => {
  const offer = error?.reusableBackup;
  if (error?.code !== "backup_failed" || !offer || typeof offer !== "object") {
    return null;
  }
  if (!kSha256Pattern.test(String(offer.sha256 || ""))) return null;
  // The model keeps the ABSOLUTE timestamp (`at`; reconstructed from the
  // server's `ageMs` when only that arrived) so the views can re-derive the
  // age against the live clock. The strings below are the build-time snapshot
  // — `buildBackupReuseOfferLabels(offer, nowMs)` is what renders.
  const recordedAt = toEpochMs(offer.at);
  const ageMs = Number.isFinite(Number(offer.ageMs)) ? Number(offer.ageMs) : null;
  const at = recordedAt ?? (ageMs != null ? nowMs - Math.max(0, ageMs) : null);
  const file = typeof offer.file === "string" ? offer.file : "";
  return {
    sha256: offer.sha256,
    file: file || null,
    name: file.split("/").pop() || "backup",
    producerLabel: kBackupProducerLabels[offer.producer] || offer.producer || "unknown",
    at,
    target: target || null,
    label: label || describeTarget(target),
    ...buildBackupReuseOfferLabels({ at }, nowMs),
  };
};

// Inventory rows for the Backups card: age · size · producer · self-standing
// status badges (label names the condition; the reason text is visible, never
// tooltip-only). The newest archive on disk is the highlighted row.
export const buildBackupInventoryRows = (inventory = null, nowMs = Date.now()) => {
  const entries = Array.isArray(inventory?.entries) ? inventory.entries : [];
  const newest = entries
    .filter((entry) => entry && entry.exists !== false && Number.isFinite(Number(entry.at)))
    .reduce(
      (best, entry) => (best == null || Number(entry.at) > Number(best.at) ? entry : best),
      null,
    );
  return entries
    .filter((entry) => entry && (entry.file || entry.name))
    .map((entry) => {
      const badges = [];
      const missing = entry.exists === false;
      if (entry.verified === true) {
        badges.push({ id: "verified", label: "verified", tone: "success" });
      } else {
        badges.push({ id: "unverified", label: "unverified", tone: "warning" });
      }
      if (entry.partial === true) {
        badges.push({
          id: "partial",
          label: buildBackupPartialBadgeLabel(entry),
          tone: "warning",
        });
      }
      if (entry.reused === true) {
        badges.push({ id: "reused", label: "reused for a later update", tone: "info" });
      }
      if (missing) {
        badges.push({ id: "missing", label: "missing — no longer on disk", tone: "danger" });
      } else if (entry.eligible !== true) {
        const reason =
          kBackupIneligibleReasonLabels[entry.ineligibleReason] ||
          entry.ineligibleReason ||
          "reason not recorded";
        // "partial" already carries its own badge above — don't say it twice.
        if (entry.ineligibleReason !== "partial") {
          badges.push({
            id: "ineligible",
            label: `not reusable — ${reason}`,
            tone: "warning",
          });
        }
      }
      const ageLabel = formatRelativeAge(entry.at, nowMs);
      return {
        key: entry.file || entry.name,
        name: entry.name || String(entry.file || "").split("/").pop(),
        file: entry.file || null,
        ageLabel: ageLabel || "unknown age",
        sizeLabel:
          Number.isFinite(Number(entry.sizeBytes)) && entry.sizeBytes != null
            ? formatBytes(entry.sizeBytes)
            : "—",
        producerLabel: kBackupProducerLabels[entry.producer] || entry.producer || "unknown",
        producerTone: entry.producer === "alphaclaw-offline-copy" ? "cyan" : "neutral",
        badges,
        newest: newest != null && entry === newest,
        missing,
      };
    });
};

// ---------------------------------------------------------------------------
// Channel selection (immediate persist)
// ---------------------------------------------------------------------------

// The running build's identity, for the mismatch banner: channel + label.
// isPin/built-in installs run the stable line regardless of preference.
export const describeRunningBuild = (channelInfo = null) => {
  if (!channelInfo) return { channel: "stable", label: "unknown" };
  const appliedChannel = channelInfo.applied?.channel || null;
  if (appliedChannel === "dev") {
    return { channel: "dev", label: `dev ${formatShortSha(channelInfo.appliedId)}` };
  }
  const version =
    channelInfo.installedVersion || channelInfo.pinVersion || null;
  const channel =
    appliedChannel || (isPrereleaseVersion(version) ? "beta" : "stable");
  return { channel, label: version || "unknown" };
};

// Persistent banner whenever the configured channel's latest applicable
// target differs from the running build. Channel selection is a pure catalog
// preference, so this is the piece that says "you chose beta but nothing is
// installed yet" — with an Apply path, notes, and a way back.
export const buildChannelMismatchModel = ({
  catalog = null,
  channelInfo = null,
  releaseChannel = null,
} = {}) => {
  if (!catalog || !channelInfo) return null;
  const channel = releaseChannel || channelInfo.releaseChannel || "stable";
  const running = describeRunningBuild(channelInfo);
  const sameChannel = running.channel === channel;
  const gating = buildCatalogGatingModel(catalog);
  const backChannel = sameChannel ? null : running.channel;
  const base = {
    channel,
    runningLabel: running.label,
    applyTarget: null,
    applyLabel: null,
    applyDisabled: false,
    applyDisabledReason: null,
    notesRowId: null,
    backChannel,
    backLabel: backChannel ? `Back to ${backChannel}` : null,
  };
  if (channel === "dev") {
    // Dev's "latest" is main HEAD — unknowable without a build, so only the
    // cross-channel intent mismatch is flagged (never a permanent banner
    // for someone already running dev).
    if (sameChannel) return null;
    return {
      ...base,
      kind: "update-available",
      message: `Channel set to dev — still running ${running.channel} ${running.label}.`,
      applyTarget: {
        applyPayload: { channel: "dev", devHead: true },
        label: "latest dev (main HEAD)",
      },
      applyLabel: "Update to latest dev (main HEAD)",
      applyDisabled: gating.applyDisabled,
      applyDisabledReason: gating.applyDisabledReason,
    };
  }
  const target = getLatestApplicableTarget({ catalog, releaseChannel: channel });
  const targetVersion = target?.row?.version || target?.label || null;
  // "Newer" is a version comparison, not mere existence: a beta dist-tag
  // older than the running stable must not be offered as an "Update".
  const targetIsNewer =
    Boolean(target) &&
    (running.channel === "dev" ||
      !running.label ||
      running.label === "unknown" ||
      compareVersions(targetVersion, running.label) > 0);
  if (target && targetIsNewer) {
    return {
      ...base,
      kind: "update-available",
      message: sameChannel
        ? `A newer ${channel} is available — still running ${running.label}.`
        : `Channel set to ${channel} — still running ${running.channel} ${running.label}.`,
      applyTarget: target,
      applyLabel: `Update to ${target.label}`,
      applyDisabled: gating.applyDisabled,
      applyDisabledReason: gating.applyDisabledReason,
      notesRowId:
        target.row && target.row.notes && !target.row.notesUnavailable
          ? target.row.version
          : null,
    };
  }
  if (sameChannel) return null;
  if (isChannelListEmptyBecauseDegraded({ catalog, releaseChannel: channel })) {
    return {
      ...base,
      kind: "degraded-unknown",
      message: `Channel set to ${channel} — the catalog is degraded, so the latest ${channel} can't be confirmed. Still running ${running.channel} ${running.label}.`,
    };
  }
  return {
    ...base,
    kind: "no-newer",
    message: `No newer ${channel} is published — ${running.channel} ${running.label} is current.`,
  };
};

// A failed channel save must revert LOUDLY: the chip names what was attempted
// and what the selection snapped back to, next to the control itself.
export const buildChannelSaveErrorModel = ({
  attempted = "",
  activeChannel = "",
  error = null,
} = {}) => {
  const envelope = buildErrorEnvelopeModel(error);
  return {
    attempted,
    activeChannel,
    message: `Couldn't switch to ${attempted} — still on ${activeChannel}.`,
    detail: envelope?.message || null,
    hint: envelope?.hint || null,
  };
};

// ---------------------------------------------------------------------------
// Incident card (U6)
// ---------------------------------------------------------------------------

export const buildIncidentModel = ({
  lastUpdateRun = null,
  blocklist = [],
} = {}) => {
  const entries = Array.isArray(blocklist) ? blocklist : [];
  const lastApplyAt =
    toEpochMs(lastUpdateRun?.finishedAt) ?? toEpochMs(lastUpdateRun?.startedAt);
  let newestBlock = null;
  for (const entry of entries) {
    const at = toEpochMs(entry?.at);
    if (at == null) continue;
    if (!newestBlock || at > toEpochMs(newestBlock.at)) newestBlock = entry;
  }
  if (
    newestBlock &&
    (lastApplyAt == null || toEpochMs(newestBlock.at) > lastApplyAt)
  ) {
    const reason = newestBlock.reason
      ? kBlocklistReasonLabels[newestBlock.reason] || newestBlock.reason
      : "unknown";
    const exitPart =
      newestBlock.exitCode != null ? `, exit code ${newestBlock.exitCode}` : "";
    return {
      kind: "rollback",
      title: `${newestBlock.id} rolled back at ${formatDateTime(newestBlock.at)}`,
      detail: `Trigger: ${reason}${exitPart}`,
      recovery:
        "You're back on a version that works. When you're ready, clear the blocklist entry and try again — or stay put.",
      blockedId: newestBlock.id || null,
    };
  }
  if (lastUpdateRun?.result && lastUpdateRun.result.ok === false) {
    return {
      kind: "apply-failed",
      title: `Update to ${describeTarget(lastUpdateRun.target)} failed`,
      detail:
        lastUpdateRun.result.message || "The update did not complete.",
      recovery:
        "Nothing was changed — you're still on your previous version. Fix the issue and try again.",
      blockedId: null,
    };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Verdict banner (U4)
// ---------------------------------------------------------------------------

export const kGatewayHeldVerdictMessage =
  "Activated, but settings migration failed — the gateway is held. Check the notification for the exact keys, then use Retry migration.";

export const buildVerdictBannerModel = ({
  expected = null,
  channel = null,
} = {}) => {
  if (!channel) return null;
  const appliedId = channel.appliedId || null;
  const installedVersion = channel.installedVersion || null;
  // A dev activation's identity is its commit — installedVersion is only the
  // dormant pin the install would fall back to, so a sha-shaped applied id on
  // a non-pin install leads (mirrors buildStatusCardModel's running label).
  const devDisplay =
    !channel.isPin && /^[0-9a-f]{7,40}$/.test(String(appliedId || ""))
      ? `dev ${formatShortSha(appliedId)}`
      : null;
  const displayVersion =
    devDisplay ||
    installedVersion ||
    formatShortSha(appliedId) ||
    channel.pinVersion ||
    "";
  const okMessage = `Now on OpenClaw ${displayVersion} — activation verified`;
  // A held gateway must never read as a green success: activation itself
  // completed (ok stays true so the reconnect poller finishes instead of
  // timing out), but the boot-time config reconciler failed and HELD the
  // gateway — warn instead. Read defensively: the /api/status summary may
  // predate the server-side gatewayHold field.
  const okModel =
    (channel?.gatewayHold ?? null) != null
      ? { ok: true, tone: "warning", message: kGatewayHeldVerdictMessage }
      : { ok: true, tone: "success", message: okMessage };
  if (!expected) {
    return okModel;
  }
  if (expected.version) {
    const matches =
      appliedId === expected.version || installedVersion === expected.version;
    return matches
      ? okModel
      : {
          ok: false,
          tone: "danger",
          message: `Reconnected, but OpenClaw is on ${displayVersion || "an unknown version"} — the update to ${expected.version} may not have activated.`,
        };
  }
  if (expected.sha) {
    const applied = String(appliedId || "");
    const wanted = String(expected.sha || "");
    const matches =
      Boolean(applied) &&
      (applied.startsWith(wanted) || wanted.startsWith(applied));
    return matches
      ? okModel
      : {
          ok: false,
          tone: "danger",
          message: `Reconnected, but OpenClaw is on ${displayVersion || "an unknown version"} — the update to ${formatShortSha(expected.sha)} may not have activated.`,
        };
  }
  if (expected.devHead) {
    // A dev-head rebuild that resolves to the SAME sha (main unchanged) is a
    // SUCCESS — requiring the sha to differ from previousId made the UI poll
    // for two minutes and then report a failure for a completed update.
    const matches = !channel.isPin && Boolean(appliedId);
    return matches
      ? okModel
      : {
          ok: false,
          tone: "danger",
          message: `Reconnected, but OpenClaw is on ${displayVersion || "an unknown version"} — the dev build may not have activated.`,
        };
  }
  return okModel;
};

// ---------------------------------------------------------------------------
// Gateway hold (settings-migration recovery)
// ---------------------------------------------------------------------------

export const kGatewayHoldTitle = "Settings migration needs attention";
export const kGatewayHoldKeyDisplayCap = 12;

export const buildStripKeysConfirmMessage = (keyCount) =>
  `Remove the ${keyCount} setting key${keyCount === 1 ? "" : "s"} OpenClaw's validator rejected? A backup was saved before migration; protected security settings are never removable.`;

// Second-stage rollback fence (issue #20 / WI-4.1): the server refused the
// rollback because this update migrated the state DBs. The guidance line names
// the verified pre-update backup when the server recorded one, and renders the
// re-stat caveats: pruned archive (→ newest surviving archive, with the honest
// "may not predate the migration" warning), partial (workspace excluded), and
// reused (age-qualified loss window). Accepts the legacy bare file string too.
export const buildRollbackDataRiskLine = (modelOrFile = null, nowMs = Date.now()) => {
  const model =
    modelOrFile && typeof modelOrFile === "object"
      ? modelOrFile
      : { backupFile: modelOrFile || null };
  const backupFile = model.backupFile || null;
  if (!backupFile) {
    return "No verified pre-update backup is recorded — data written by the newer version may be unreadable if you roll back anyway.";
  }
  // Older servers omit backupFileExists — only an explicit false is "pruned".
  if (model.backupFileExists === false) {
    const survivor = model.newestSurvivingBackup;
    if (survivor && survivor.file) {
      const survivorAge = formatRelativeAge(survivor.at, nowMs);
      const producer =
        kBackupProducerLabels[survivor.producer] || survivor.producer || null;
      const survivorMeta = [producer, survivorAge].filter(Boolean).join(", ");
      return `The recorded pre-update backup (${backupFile}) is no longer on disk — the original pre-migration backup was pruned. The newest surviving archive is ${survivor.file}${survivorMeta ? ` (${survivorMeta})` : ""} — it may not predate the migration, so check its date before restoring. Or roll back anyway — data written by the newer version may be unreadable.`;
    }
    return `The recorded pre-update backup (${backupFile}) is no longer on disk — the original pre-migration backup was pruned and no other archive survives. Rolling back anyway may leave data written by the newer version unreadable.`;
  }
  const caveats = [];
  if (model.backupPartial === true) {
    caveats.push("workspace files were excluded from it");
  }
  if (model.backupReused === true) {
    const age = Number.isFinite(Number(model.reusedAgeMs))
      ? describeAgeSpan(Number(model.reusedAgeMs), nowMs)
      : "some time";
    caveats.push(
      `it was taken ${age} before this update — state written since is not in it`,
    );
  }
  const caveatText = caveats.length > 0 ? ` Note: ${caveats.join("; ")}.` : "";
  return `Restore the verified pre-update backup first (${backupFile}), or roll back anyway — data written by the newer version may be unreadable.${caveatText}`;
};

// Pure view model for the held-gateway warning section. The hold crosses the
// server boundary, so sanitize: only strings render, and the display list
// caps at kGatewayHoldKeyDisplayCap keys with a "+N more" suffix entry.
// canStrip follows the REAL key count — stripping nothing is not an offer.
export const buildGatewayHoldModel = (channelInfo = null) => {
  const hold = channelInfo?.gatewayHold ?? null;
  if (hold == null || typeof hold !== "object") return null;
  const keys = (Array.isArray(hold.blamedKeys) ? hold.blamedKeys : []).filter(
    (key) => typeof key === "string" && key,
  );
  const blamedKeys = keys.slice(0, kGatewayHoldKeyDisplayCap);
  if (keys.length > kGatewayHoldKeyDisplayCap) {
    blamedKeys.push(`+${keys.length - kGatewayHoldKeyDisplayCap} more`);
  }
  return {
    reason:
      typeof hold.reason === "string" && hold.reason
        ? hold.reason
        : "Settings migration failed.",
    blamedKeys,
    keyCount: keys.length,
    canStrip: keys.length > 0,
  };
};

// ---------------------------------------------------------------------------
// Error envelopes (U8/U12)
// ---------------------------------------------------------------------------

// Canonical home is lib/error-envelope.js (shared by InlineErrorChip and every
// feature area); re-exported here so existing upgrade-tab imports keep working.
export { buildErrorEnvelopeModel };

// ---------------------------------------------------------------------------
// Update run ledger (timeline + post-restart continuity)
// ---------------------------------------------------------------------------

export const kRunStateMeta = {
  running: { label: "running", tone: "info" },
  failed: { label: "failed", tone: "danger" },
  noop: { label: "no change", tone: "neutral" },
  restart_expected: { label: "restarting", tone: "info" },
  activated: { label: "activated", tone: "success" },
  activation_failed: { label: "activation failed", tone: "danger" },
  interrupted: { label: "interrupted", tone: "danger" },
};

export const buildRunTimelineModel = (runs = [], nowMs = Date.now()) =>
  (Array.isArray(runs) ? runs : [])
    .filter((run) => run && run.operationId)
    .map((run) => {
      const meta =
        kRunStateMeta[run.state] || { label: run.state || "unknown", tone: "neutral" };
      return {
        operationId: run.operationId,
        stateLabel: meta.label,
        tone: meta.tone,
        targetLabel: describeTarget(run.target),
        when: formatRelativeAge(run.finishedAt ?? run.startedAt, nowMs) || "",
        hasLog: Boolean(run.hasLog),
      };
    });

// Post-restart continuity: after the reconnect poller comes back, the latest
// run's persisted state is the truth — activation_failed/interrupted become a
// failure card with the result envelope and a way into the full log.
export const buildRunFailureModel = (run = null) => {
  if (!run) return null;
  if (run.state !== "activation_failed" && run.state !== "interrupted") {
    return null;
  }
  const fallbackMessage =
    run.state === "interrupted"
      ? "The update process was interrupted before it finished."
      : "The new version did not activate — the previous version was restored.";
  const envelope = buildErrorEnvelopeModel(
    run.result && run.result.message ? run.result : { message: fallbackMessage },
  );
  return {
    operationId: run.operationId || null,
    state: run.state,
    title:
      run.state === "interrupted"
        ? `Update to ${describeTarget(run.target)} was interrupted`
        : `Update to ${describeTarget(run.target)} did not activate`,
    error: envelope,
    hasLog: Boolean(run.hasLog),
  };
};
