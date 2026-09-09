// Declared-intent check for package-channel applies (v0.9.81, cross-model
// decisions D13 / D21). "Update to latest stable" once resolved to an OLDER
// version and the server happily downgraded (issue: bug 2). The server now
// requires every stable/beta apply to SAY which way it is going and refuses a
// body whose direction disagrees with the installed version. Pure: no I/O.
//
//   intent (required for stable/beta, refused for dev)
//     │
//     ├─ not one of update | downgrade | switch ──────────► 400 invalid_body
//     │
//     ├─ direction vs installedVersion (fail-closed, no catalog needed)
//     │     update    ⇒ version strictly newer than installed
//     │     downgrade ⇒ version strictly older than installed
//     │     switch    ⇒ same core version, OR installed unknown
//     │     (update/downgrade with installed unknown ⇒ mismatch: the
//     │      direction cannot be confirmed, so it is not granted)
//     │     disagreement ────────────────────────────────► 409 intent_mismatch
//     │
//     └─ latest agreement (update + expectLatest only; BEST-EFFORT, recorded)
//           catalog absent / not ok ───► check.latest = skipped_catalog_unavailable
//           catalog degraded for npm ──► check.latest = skipped_degraded
//           channel latest newer than version ───────────► 409 catalog_stale
//           else ───────────────────────► check.latest = verified
//
// `expectLatest` is the caller's claim that `version` IS the channel's
// newest (the "Update to latest" CTA sends it; a catalog row's own Upgrade
// button does not — an operator may deliberately pick an older-but-newer
// row, and a stale-catalog refusal would be wrong there). The result always
// carries `check` so the run record can show what was verified and what was
// skipped — a skipped check is visible, never silent.
const { compareVersionParts } = require("./helpers");

const kApplyIntents = Object.freeze(["update", "downgrade", "switch"]);

const fail = (status, code, message, hint, extra = null) => ({
  ok: false,
  status,
  code,
  message,
  hint,
  ...(extra || {}),
});

// The channel's newest row by the SAME rule the UI's resolveChannelLatestRow
// uses: stable → the dist-tag row (never max publish date — backports publish
// later), else the highest version; beta → the highest prerelease version
// (the npm `beta` dist-tag is not trustworthy for the channel — it has
// pointed at a stable release).
const resolveChannelLatestVersion = ({ catalog = null, channel = "stable" } = {}) => {
  if (!catalog || typeof catalog !== "object") return null;
  const rows = Array.isArray(catalog[channel]) ? catalog[channel] : [];
  const versions = rows.map((row) => row?.version).filter((v) => typeof v === "string" && v);
  if (versions.length === 0) return null;
  if (channel === "stable") {
    const tagged = rows.find((row) => row?.isDistTagLatest === true && typeof row.version === "string");
    if (tagged) return tagged.version;
  }
  return versions.slice().sort((a, b) => compareVersionParts(b, a))[0] || null;
};

const directionOf = (version, installedVersion) => {
  if (typeof installedVersion !== "string" || !installedVersion) return null;
  const cmp = compareVersionParts(version, installedVersion);
  return cmp > 0 ? "update" : cmp < 0 ? "downgrade" : "switch";
};

const assessApplyIntent = ({
  intent,
  channel,
  version = null,
  installedVersion = null,
  catalog = null,
  expectLatest = false,
} = {}) => {
  if (channel === "dev") {
    if (intent !== undefined && intent !== null) {
      return fail(
        400,
        "invalid_body",
        "intent is not accepted for dev applies — a commit has no version direction.",
        "Omit intent when channel is dev.",
      );
    }
    return { ok: true, check: { direction: "not_applicable", latest: "not_applicable" } };
  }
  if (!kApplyIntents.includes(intent)) {
    return fail(
      400,
      "invalid_body",
      `intent is required for ${channel} applies and must be one of: ${kApplyIntents.join(", ")}.`,
      'Send intent: "update" for a newer version, "downgrade" for an older one, "switch" for the same core version.',
    );
  }
  const installed = typeof installedVersion === "string" && installedVersion ? installedVersion : null;
  const actual = directionOf(version, installed);
  // `switch` with an unknown installed version is the one grant without
  // evidence: there is nothing to compare, and it carries no direction claim.
  const directionOk = actual === intent || (intent === "switch" && actual === null);
  if (!directionOk) {
    const message = installed
      ? `intent "${intent}" does not match the direction of this apply: ${version} is ${
          actual === "switch" ? "the same version as" : actual === "update" ? "newer than" : "older than"
        } the running ${installed}.`
      : `intent "${intent}" cannot be confirmed: the running OpenClaw version is unknown.`;
    return fail(
      409,
      "intent_mismatch",
      message,
      installed
        ? `Refresh the Upgrade page and choose the version again — its button says whether it is an upgrade, a downgrade or a switch.`
        : "Reconcile the running build first (the Upgrade page offers it), then retry.",
      { installedVersion: installed, direction: actual },
    );
  }
  const check = { direction: "verified", installedVersion: installed, latest: "not_applicable" };
  if (intent === "update") {
    if (!expectLatest) {
      check.latest = "not_claimed";
    } else if (!catalog || typeof catalog !== "object" || catalog.ok === false) {
      check.latest = "skipped_catalog_unavailable";
    } else if (catalog.degraded?.npm === true) {
      check.latest = "skipped_degraded";
    } else {
      const latest = resolveChannelLatestVersion({ catalog, channel });
      if (!latest) {
        check.latest = "skipped_catalog_unavailable";
      } else if (compareVersionParts(latest, version) > 0) {
        return fail(
          409,
          "catalog_stale",
          `${latest} is the latest ${channel} release — ${version} is no longer the newest.`,
          `Refresh the catalog ("Check now") and update to ${latest}.`,
          { latest, installedVersion: installed },
        );
      } else {
        check.latest = "verified";
        check.latestVersion = latest;
      }
    }
  }
  return { ok: true, check };
};

module.exports = { assessApplyIntent, resolveChannelLatestVersion, kApplyIntents };
