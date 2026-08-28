// Pure view-model builders for the OpenClaw Upgrade page. Everything here is
// display logic and must stay free of Preact/DOM imports so it can be tested
// directly in node.

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
  "Channel-applied versions add ~10-30s to restarts (the built-in version boots fastest).";
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

export const formatDateTime = (value, fallback = "—") => {
  const ms = toEpochMs(value);
  if (ms == null) return fallback;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return fallback;
  }
};

export const formatDateOnly = (value, fallback = "—") => {
  const ms = toEpochMs(value);
  if (ms == null) return fallback;
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return fallback;
  }
};

export const formatRelativeAge = (value, nowMs = Date.now()) => {
  const ms = toEpochMs(value);
  if (ms == null) return null;
  const deltaMs = Math.max(0, nowMs - ms);
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

export const buildStalenessLabel = (staleAsOf, nowMs = Date.now()) => {
  const age = formatRelativeAge(staleAsOf, nowMs);
  return age ? `Catalog as of ${age}` : "Catalog freshness unknown";
};

export const formatElapsed = (startedAt, nowMs = Date.now()) => {
  const start = toEpochMs(startedAt);
  if (start == null) return "0s";
  const totalSeconds = Math.max(0, Math.floor((nowMs - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

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

export const buildBlocklistDetail = (blocklisted = {}) => {
  const parts = [];
  parts.push(
    blocklisted?.reason ? `trigger: ${blocklisted.reason}` : "trigger: unknown",
  );
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

export const kStepLabels = {
  preflight: "Preflight checks",
  backup: "Backup",
  toolchain: "Toolchain",
  download: "Download",
  fetch: "Fetch source",
  checkout: "Checkout commit",
  install: "Install dependencies",
  build: "Build",
  doctor: "Doctor",
  verify: "Verify",
  "db-preflight": "Database compatibility",
  record: "Record",
  restarting: "Restarting",
};

// Collapses the raw step event stream (one entry per status change) into one
// row per step, in first-seen order, carrying the latest status/detail/error.
export const buildStepListModel = (steps = []) => {
  const byName = new Map();
  for (const step of Array.isArray(steps) ? steps : []) {
    const name = String(step?.name || "").trim();
    if (!name) continue;
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        label: kStepLabels[name] || name,
        status: null,
        detail: null,
        error: null,
        at: null,
      });
    }
    const entry = byName.get(name);
    if (step.status) entry.status = step.status;
    if (step.at != null) entry.at = step.at;
    if (step.detail) entry.detail = step.detail;
    if (step.error) entry.error = step.error;
  }
  return [...byName.values()];
};

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

export const buildStatusCardModel = (info = null) => {
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
          line: `auto-rollback armed → last known good: ${
            lastKnownGoodLabel || info.pinVersion || "built-in pin"
          }`,
          caption:
            "Mark as good now — otherwise auto-rollback reverts this version if it crash-loops in its first 24h.",
        }
      : null,
    autoAcceptedNote: autoAcceptedInWindow ? kAutoAcceptedNote : null,
    lastUpdate: buildLastUpdateSummary(info.lastUpdateRun),
    lastKnownGood: lastKnownGoodLabel,
    driftNotice:
      info.lastBoot?.action === "drift_reverted" ? kDriftNotice : null,
  };
};

export const buildAvailabilityLine = ({
  catalog = null,
  releaseChannel = "stable",
  installedVersion = null,
} = {}) => {
  if (!catalog) return null;
  if (releaseChannel === "dev") {
    const head = (catalog.dev?.commits || [])[0] || null;
    if (!head) return "No dev commits listed.";
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
  if (!latest) return `No ${releaseChannel} releases listed.`;
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
        : "";
  return `Latest ${releaseChannel}: ${latest.version}${suffix}`;
};

// ---------------------------------------------------------------------------
// Confirm dialogs (U1/U3/U9)
// ---------------------------------------------------------------------------

export const buildApplyConfirmModel = ({
  payload = {},
  label = "",
  isDowngrade = false,
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
  return {
    title: isDowngrade ? `Downgrade to ${label}?` : `Switch to ${label}?`,
    tone: isDowngrade ? "warning" : "primary",
    confirmLabel: isDowngrade ? "Downgrade" : "Apply",
    lines,
    isDowngrade,
  };
};

export const buildChannelSwitchModel = ({
  nextChannel = "stable",
  latestLabel = "",
  securityFlips = [],
} = {}) => {
  const isDev = nextChannel === "dev";
  return {
    title: `Switch to latest ${nextChannel}?`,
    tooltip: kChannelTooltips[nextChannel] || "",
    applyLabel: "Apply now",
    applyCaption: isDev
      ? `Builds ${latestLabel || "the latest dev commit"} from source — ${kDevApplyImpactNote}. Backup included.`
      : `Installs ${latestLabel ? `${latestLabel} ` : ""}now (~2 min, backup included).`,
    browseLabel: "Just browse the catalog",
    browseCaption: `Saves ${nextChannel} as your channel but installs nothing until you press Apply on a version.`,
    // Curated security-default flips for the target channel (D5): shown inside the
    // switch dialog so critical behavior changes are visible BEFORE committing.
    securityFlips: Array.isArray(securityFlips) ? securityFlips : [],
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
    const reason = newestBlock.reason || "unknown";
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
  if (!expected) {
    return { ok: true, message: okMessage };
  }
  if (expected.version) {
    const matches =
      appliedId === expected.version || installedVersion === expected.version;
    return matches
      ? { ok: true, message: okMessage }
      : {
          ok: false,
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
      ? { ok: true, message: okMessage }
      : {
          ok: false,
          message: `Reconnected, but OpenClaw is on ${displayVersion || "an unknown version"} — the update to ${formatShortSha(expected.sha)} may not have activated.`,
        };
  }
  if (expected.devHead) {
    // A dev-head rebuild that resolves to the SAME sha (main unchanged) is a
    // SUCCESS — requiring the sha to differ from previousId made the UI poll
    // for two minutes and then report a failure for a completed update.
    const matches = !channel.isPin && Boolean(appliedId);
    return matches
      ? { ok: true, message: okMessage }
      : {
          ok: false,
          message: `Reconnected, but OpenClaw is on ${displayVersion || "an unknown version"} — the dev build may not have activated.`,
        };
  }
  return { ok: true, message: okMessage };
};

// ---------------------------------------------------------------------------
// Error envelopes (U8/U12)
// ---------------------------------------------------------------------------

export const buildErrorEnvelopeModel = (error = null) => {
  if (!error) return null;
  const message = String(
    (typeof error === "string" ? error : error.message) ||
      "Something went wrong",
  );
  return {
    message,
    hint: error.hint ? String(error.hint) : null,
    code: error.code ? String(error.code) : null,
    docsUrl: error.docsUrl ? String(error.docsUrl) : null,
  };
};
