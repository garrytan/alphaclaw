// Shared error-envelope normalizer for inline error surfaces (chips, banners).
// Server envelopes (parseEnvelopeOrThrow) attach code/hint/docsUrl to thrown
// errors; this flattens any thrown value into a render-ready shape. Lives here
// (not format.js — that file is for value formatters) so non-upgrade features
// can import it without cross-feature coupling.
// Fail-closed refusals share one recovery story (fix wave PR 7): the server
// attaches this hint itself, but older envelopes and proxied bodies may carry
// only the code.
const kDefaultHintByCode = {
  config_unreadable:
    "AlphaClaw will not rewrite a config file it cannot parse. Fix the JSON by hand or restore a backup, then retry. Nothing was changed — the Doctor tab lists the file.",
};

export const buildErrorEnvelopeModel = (error = null) => {
  if (!error) return null;
  const message = String(
    (typeof error === "string" ? error : error.message) ||
      "Something went wrong",
  );
  return {
    message,
    hint: error.hint ? String(error.hint) : kDefaultHintByCode[String(error.code || "")] || null,
    code: error.code ? String(error.code) : null,
    // docsUrl renders into an anchor href across every feature area, and
    // envelopes chain from gateway/CLI response bodies — accept only http(s)
    // so an upstream-influenced `javascript:` URL can never become a link.
    docsUrl: toSafeHttpUrl(error.docsUrl),
    // Server envelopes may flag failures the `openclaw update repair` runbook
    // fixes; consumers render a repair hint off this.
    repairApplicable: error.repairApplicable === true,
  };
};

const toSafeHttpUrl = (value) => {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
};
