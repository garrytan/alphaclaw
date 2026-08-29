// Shared error-envelope normalizer for inline error surfaces (chips, banners).
// Server envelopes (parseEnvelopeOrThrow) attach code/hint/docsUrl to thrown
// errors; this flattens any thrown value into a render-ready shape. Lives here
// (not format.js — that file is for value formatters) so non-upgrade features
// can import it without cross-feature coupling.
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
    // Server envelopes may flag failures the `openclaw update repair` runbook
    // fixes; consumers render a repair hint off this.
    repairApplicable: error.repairApplicable === true,
  };
};
