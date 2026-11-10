// A new hook's own token is shown once, in the create answer (GST-2134). It
// lives only in this module's Map until the person presses Done or reloads the
// page: never in localStorage, sessionStorage or the shared api cache.
const kOwnTokensByHook = new Map();

export const kHookTokenPlaceholder = "<this hook's token>";
export const kOwnTokenNotice =
  "This hook takes its own token, not the shared webhook token. Copy it now: you won't see it again.";
export const kSendTestNeedsOwnTokenReason =
  "Send test needs this hook's token. Replace it under Sender verification to see a new one.";
export const kSendTestSignedReason =
  "Signed hooks only accept deliveries signed by their sender.";

const normalizeHookName = (hookName = "") => String(hookName || "").trim().toLowerCase();

export const getOwnToken = (hookName = "") =>
  kOwnTokensByHook.get(normalizeHookName(hookName)) || "";

export const forgetOwnToken = (hookName = "") => {
  kOwnTokensByHook.delete(normalizeHookName(hookName));
};

// Keeps the token from a create answer, or forgets a stale one when the answer
// carries none (an older server, or a name reused after a delete).
export const rememberCreatedOwnToken = (hookName = "", createData = null) => {
  const name = normalizeHookName(hookName);
  if (!name) return "";
  const token = String(createData?.webhook?.ownToken || "").trim();
  if (token) kOwnTokensByHook.set(name, token);
  else kOwnTokensByHook.delete(name);
  return token;
};

// The detail GET of a hook off the shared token carries a placeholder where
// the token goes; the URL form takes the token URL-encoded.
export const substituteHookToken = (value = "", token = "", { encode = false } = {}) => {
  const text = String(value || "");
  if (!token) return text;
  return text.split(kHookTokenPlaceholder).join(encode ? encodeURIComponent(token) : token);
};

export const getSendTestDisabledReason = ({
  preset = "token",
  hasOwnToken = false,
  hasOauthCallback = false,
} = {}) => {
  if (hasOauthCallback) return "";
  const normalizedPreset = String(preset || "token");
  if (normalizedPreset === "token") return "";
  if (normalizedPreset === "per_hook_token") return hasOwnToken ? "" : kSendTestNeedsOwnTokenReason;
  return kSendTestSignedReason;
};
