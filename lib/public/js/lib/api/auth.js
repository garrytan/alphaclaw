import { kChatSendOutboxStorageKey, kChatSessionDraftsStorageKey } from "../storage-keys.js";
import { authFetch } from "./http.js";
import { parseJsonOrThrow, parseEnvelopeOrThrow } from "./parse.js";

export const fetchAuthStatus = async () => {
  const res = await authFetch("/api/auth/status");
  return parseJsonOrThrow(res, "Could not load data");
};

export const fetchAuthIdentity = async () => {
  const res = await authFetch("/api/auth/identity");
  return parseEnvelopeOrThrow(res, "Could not load identity");
};

export const logout = async () => {
  // Chat drafts and queued outbox content are member data — they must not
  // survive an identity change on a shared origin. Cleared before the POST so
  // even a failed logout request never leaves them behind on a shared device.
  try {
    localStorage.removeItem(kChatSendOutboxStorageKey);
    localStorage.removeItem(kChatSessionDraftsStorageKey);
  } catch {}
  const res = await authFetch("/api/auth/logout", { method: "POST" });
  return res.json();
};
