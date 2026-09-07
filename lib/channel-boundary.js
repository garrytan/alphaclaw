// Shared channel-boundary predicate for OpenClaw applies (issue #79, Stage 4a).
//
// ONE function answers "does this apply cross a channel boundary?" for both
// sides: the server's backup hard gate (`backupHardGate` beside `runBackup` in
// lib/server/openclaw-channel-sync.js) and the Upgrade tab's apply confirm
// (`buildApplyConfirmModel` in lib/public/js/components/upgrade-tab/helpers.js).
// Before this module each side encoded its own rule — the server gated only a
// prerelease TARGET, the UI only a stable→non-stable move — so a beta→stable
// apply hard-gated on the server while the confirm promised nothing, and a
// beta.1→beta.2 apply said "backup hard gate" without one. A boundary is:
//
//   prerelease ↔ stable in EITHER direction   (a labeled suffix flips)
//   OR a channel NAME change                  (stable / beta / dev)
//
// `currentChannel` is the PERSISTED applied channel (`state.applied?.channel
// ?? "stable"` — Codex 19), never alphaclaw.json's mutable `releaseChannel`
// selection: the selection is a catalog preference the operator may have
// flipped minutes ago, so reading it would report "same channel" for the very
// stable→beta apply it is about to make.
//
// Like lib/update-progress-model.js this is dependency-free CommonJS: the
// server requires it directly and the esbuild UI bundle imports its named
// exports, so it must never require a node builtin or a server module (which
// is why the prerelease test is re-implemented here rather than imported from
// lib/server/helpers.js — its twin lives in upgrade-tab/helpers.js and the
// test file pins all three to the same answers).

const kDefaultChannel = "stable";

// Blank / non-string → the default channel, mirroring the normalized applied
// record (`channel: string | null`) and the caller's `?? "stable"`.
// Case and surrounding whitespace never make two spellings of one channel
// look like a crossing.
const normalizeChannelName = (value) => {
  if (typeof value !== "string") return kDefaultChannel;
  const trimmed = value.trim().toLowerCase();
  return trimmed || kDefaultChannel;
};

// OpenClaw's suffix convention (kept in step with `isPrereleaseVersion` in
// lib/server/helpers.js and upgrade-tab/helpers.js):
//   2026.8.1-beta.3 / 2026.9.2-rc.1 → labeled suffix → PRERELEASE
//   2026.7.1-2                      → bare numeric suffix → out-of-band HOTFIX
//   2026.9.2                        → base release
// Tags arrive v-prefixed from GitHub; the prefix is not part of the version.
const isPrereleaseVersion = (version) => {
  const raw = String(version ?? "").trim().replace(/^v/, "");
  const dashIndex = raw.indexOf("-");
  if (dashIndex === -1) return false;
  const suffix = raw.slice(dashIndex + 1);
  return suffix.length > 0 && !/^\d+$/.test(suffix);
};

const hasVersion = (value) => String(value ?? "").trim().length > 0;

// True when the apply changes channel name OR flips between a prerelease and
// a stable build. The version arm needs BOTH endpoints: with nothing
// installed (or an unknown target) there is no direction to speak of, so it
// stays silent and the channel-name arm alone decides — callers keep their
// own `isPrereleaseTarget` term for the target-only view.
const crossesChannelBoundary = ({
  installedVersion = null,
  targetVersion = null,
  currentChannel = kDefaultChannel,
  targetChannel = kDefaultChannel,
} = {}) => {
  if (normalizeChannelName(currentChannel) !== normalizeChannelName(targetChannel)) {
    return true;
  }
  if (!hasVersion(installedVersion) || !hasVersion(targetVersion)) return false;
  return isPrereleaseVersion(installedVersion) !== isPrereleaseVersion(targetVersion);
};

module.exports = {
  kDefaultChannel,
  normalizeChannelName,
  isPrereleaseVersion,
  crossesChannelBoundary,
};
