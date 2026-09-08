// A consent is bound to the reviewed failed run. Never persist its token in
// operation state: only the next apply request receives it.
export const prepareBackupRiskApply = async (offer, requestConsent) => {
  if (!offer?.operationId || !offer?.target) throw new Error("Refresh the failed update before confirming backup risk.");
  // Freeze what the operator reviewed before awaiting issuance. Catalog or
  // operation refreshes must never broaden an in-flight confirmation.
  const operationId = offer.operationId;
  const reviewed = { ...offer.target };
  const label = offer.label;
  const consent = await requestConsent(operationId);
  if (typeof consent?.confirmNoBackupToken !== "string" ||
      !/^[a-zA-Z0-9_-]{32,128}$/.test(consent.confirmNoBackupToken)) {
    throw new Error("The server did not return a valid backup confirmation. Refresh the failed update.");
  }
  const target = consent.target;
  const sameTarget = target && ["stable", "beta", "dev"].includes(reviewed.channel) &&
    target.channel === reviewed.channel &&
    (reviewed.channel === "dev"
      ? !reviewed.devHead && /^[a-f0-9]{7,40}$/.test(reviewed.sha || "") &&
        /^[a-f0-9]{40}$/.test(target.sha || "") && target.sha.startsWith(reviewed.sha)
      : typeof reviewed.version === "string" && reviewed.version.length > 0 && target.version === reviewed.version);
  if (!sameTarget || consent.operationId !== operationId) {
    throw new Error("The update target changed. Review the failed update and confirm again.");
  }
  // The server binds dev approval to the full verified commit, even when
  // the failed run originally displayed an unambiguous short commit id.
  const payload = target.channel === "dev"
    ? { channel: "dev", sha: target.sha }
    : { channel: target.channel, version: target.version };
  return { payload, label, confirmNoBackup: true,
    confirmNoBackupToken: consent.confirmNoBackupToken };
};
