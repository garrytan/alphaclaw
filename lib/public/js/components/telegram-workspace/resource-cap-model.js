// Concurrency copy for the topics page. Preference: config read-back ??
// server-computed (lib/server/autotune.js, surfaced in the workspace status
// response) ?? the local formula. The local formula covers an older server
// that sends no computed values, and the first paint from a cached workspace
// saved without them (finishing onboarding saves one) until the workspace
// status response arrives.
export const buildResourceCapModel = ({
  topicCount,
  configAgentMaxConcurrent,
  configSubagentMaxConcurrent,
  concurrency,
}) => {
  const localMaxConcurrent = Math.max(topicCount * 3, 8);
  const localSubagentMaxConcurrent = Math.max(localMaxConcurrent - 2, 4);
  const maxConcurrent = Number.isFinite(configAgentMaxConcurrent)
    ? configAgentMaxConcurrent
    : Number.isFinite(concurrency?.computedMaxConcurrent)
      ? concurrency.computedMaxConcurrent
      : localMaxConcurrent;
  const subagentMaxConcurrent = Number.isFinite(configSubagentMaxConcurrent)
    ? configSubagentMaxConcurrent
    : Number.isFinite(concurrency?.computedSubagentMaxConcurrent)
      ? concurrency.computedSubagentMaxConcurrent
      : localSubagentMaxConcurrent;
  const resourceCap = Number.isFinite(concurrency?.resourceCap)
    ? concurrency.resourceCap
    : null;
  // The machine-size claim is only honest when the server derived the cap
  // from detected machine resources; "legacy" (or an older server omitting
  // resourceCapSource) means the constant cap — no machine claim.
  const resourceCapFromMachine =
    resourceCap != null && concurrency?.resourceCapSource === "machine";
  return {
    maxConcurrent,
    subagentMaxConcurrent,
    resourceCap,
    resourceCapFromMachine,
  };
};
