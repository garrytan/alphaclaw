// Shared agent-admin wire constants. Single source of truth so the enforcement
// middleware, the confirm service, and the CLI never drift on header names — a
// rename in one place would otherwise silently break confirm redemption (the
// server would read one header while the paramsHash bound another).
const kConfirmHeader = "x-alphaclaw-confirm";
const kRequestContextHeader = "x-alphaclaw-request-context";
const kMaxRequestContextLength = 256;
// The single agent-actor secret mask. Shared by redact.js (maskSecretFields)
// and every domain redactResponse so the two can never render different masks.
const kMask = "••• (set)";

module.exports = {
  kConfirmHeader,
  kRequestContextHeader,
  kMaxRequestContextLength,
  kMask,
};
