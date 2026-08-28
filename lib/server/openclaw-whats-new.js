// Resolve the curated "What's new" entry for the Upgrade page. The data is
// hand-written (lib/server/openclaw-whats-new.json): OpenClaw's beta changelog is one
// aggregated multi-hundred-line section that cannot be honestly parsed into
// highlights, and the security-default flips need human wording. Chosen over
// release-notes parsing in the plan (item 2.1).
const kWhatsNewData = require("./openclaw-whats-new.json");
const { compareVersionParts } = require("./helpers");

// "2026.8.1-beta.3" -> "2026.8"
const minorOf = (version) => {
  const match = String(version || "").match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : null;
};

const latestVersionForChannel = (catalog, releaseChannel) => {
  const rows = Array.isArray(catalog?.[releaseChannel])
    ? catalog[releaseChannel]
    : [];
  const sorted = rows
    .filter((entry) => entry && typeof entry.version === "string")
    .slice()
    .sort((x, y) => compareVersionParts(y.version, x.version));
  return sorted[0]?.version || null;
};

// Returns { minor, channel, highlights, securityFlips, lastVerifiedVersion,
// channelLatest, newerThanVerified } or null when no curated entry matches the
// channel's latest minor (the UI falls back to "see release notes below").
const resolveWhatsNew = ({
  catalog = null,
  releaseChannel = "stable",
  entries = kWhatsNewData.entries,
} = {}) => {
  if (!catalog || releaseChannel === "dev") return null;
  const channelLatest = latestVersionForChannel(catalog, releaseChannel);
  if (!channelLatest) return null;
  const minor = minorOf(channelLatest);
  const entry = (Array.isArray(entries) ? entries : []).find(
    (candidate) =>
      candidate &&
      candidate.channel === releaseChannel &&
      candidate.minor === minor,
  );
  if (!entry) return null;
  const newerThanVerified =
    typeof entry.lastVerifiedVersion === "string" &&
    compareVersionParts(channelLatest, entry.lastVerifiedVersion) > 0;
  return {
    minor: entry.minor,
    channel: entry.channel,
    highlights: Array.isArray(entry.highlights) ? entry.highlights : [],
    securityFlips: Array.isArray(entry.securityFlips) ? entry.securityFlips : [],
    lastVerifiedVersion: entry.lastVerifiedVersion || null,
    channelLatest,
    newerThanVerified,
  };
};

module.exports = { resolveWhatsNew, minorOf, kWhatsNewData };
