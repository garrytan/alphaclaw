// Pairing cleanup after a channel account is deleted: the SQLite pairing
// rows and the file-era pairing files. Split out of createChannelsDomain.
const path = require("path");
const {
  resolveCredentialsDirPath,
  isValidChannelAccountId,
} = require("../shared");
const { deleteChannelPairingRows } = require("../../openclaw-state-era");

const createChannelPairingCleanup = ({
  fsImpl,
  OPENCLAW_DIR,
}) => {
  // The operator's real remedy. "Re-run the delete" was dead advice: the
  // account is already gone from openclaw.json, so a second delete 404s at
  // the not-found check before it reaches the row clear. Re-adding the same
  // id works because createChannelAccount clears that id's stale rows first.
  const pairingRowsRemedy = (label) =>
    `re-add ${label} (adding an account clears its stale pairing rows) and delete it again, or delete the rows by hand from state/openclaw.sqlite (channel_pairing_allow_entries and channel_pairing_requests where channel_key and account_id match)`;
  const clearChannelAccountPairingRows = ({ provider, accountId }) => {
    const label = `${provider}/${accountId || "default"}`;
    let reason;
    try {
      const result = deleteChannelPairingRows({
        openclawDir: OPENCLAW_DIR,
        channel: provider,
        accountId,
      });
      if (result?.ok !== false) return { failed: false };
      // Not a throw: openclaw.json/.env are already mutated, so a retry
      // would 404 — but never a clean `ok: true` either. The caller
      // surfaces `pairingRowsCleanupFailed` + the reason so the client can
      // say the allow entries are still authorized.
      reason = String(result.error || "unknown error");
    } catch (error) {
      reason = String(error?.message || error);
    }
    console.error(
      `[alphaclaw] SECURITY: could not clear ${label} pairing rows from the state db: ${reason} — the deleted account's allow entries are STILL authorized; ${pairingRowsRemedy(label)}`,
    );
    return { failed: true, error: reason };
  };
  // The additive outcome flags a delete result carries for the pairing-row
  // clear: failed (schema mismatch / DB error; the allow entries are STILL
  // authorized) — `ok: true` stays authoritative for the delete itself,
  // which already happened.
  const pairingRowsOutcomeFields = (pairingRows) => ({
    ...(pairingRows?.failed
      ? {
          pairingRowsCleanupFailed: true,
          pairingRowsCleanupError: pairingRows.error || "unknown error",
        }
      : {}),
  });

  // File-era pairing state (credentials/<provider>-pairing.json and the
  // allowFrom files) — plain fs.
  const cleanupChannelAccountPairingFiles = ({ provider, accountId }) => {
    const credDir = resolveCredentialsDirPath({ OPENCLAW_DIR });
    const normalizedAccountId =
      String(accountId || "")
        .trim()
        .toLowerCase() || "default";
    // Defense in depth: the id is joined into allowFrom file names below — a
    // traversal shape must never reach rmSync, even from a skipped caller.
    if (!isValidChannelAccountId(normalizedAccountId)) return;

    const pairingFilePath = path.join(credDir, `${provider}-pairing.json`);
    try {
      const raw = fsImpl.readFileSync(pairingFilePath, "utf8");
      const parsed = JSON.parse(raw);
      const requests = Array.isArray(parsed?.requests) ? parsed.requests : [];
      const nextRequests = requests.filter((entry) => {
        const entryAccountId =
          String(entry?.meta?.accountId || "")
            .trim()
            .toLowerCase() || "default";
        return entryAccountId !== normalizedAccountId;
      });
      if (nextRequests.length !== requests.length) {
        fsImpl.writeFileSync(
          pairingFilePath,
          JSON.stringify({ version: 1, requests: nextRequests }, null, 2),
        );
      }
    } catch {}

    const allowFromPatterns = [
      `${provider}-${normalizedAccountId}-allowFrom.json`,
      ...(normalizedAccountId === "default"
        ? [`${provider}-allowFrom.json`]
        : []),
    ];
    for (const fileName of allowFromPatterns) {
      try {
        fsImpl.rmSync(path.join(credDir, fileName), { force: true });
      } catch {}
    }
  };

  return { clearChannelAccountPairingRows, pairingRowsOutcomeFields, cleanupChannelAccountPairingFiles };
};

module.exports = { createChannelPairingCleanup };
