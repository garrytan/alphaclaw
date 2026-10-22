import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export async function fetchGoogleAccounts({ signal } = {}) {
  const res = await authFetch("/api/google/accounts", { signal });
  return parseJsonOrThrow(res, "Could not load data");
}

export async function fetchGoogleCredentials({
  accountId = "",
  client = "",
} = {}) {
  const params = new URLSearchParams();
  if (accountId) params.set("accountId", String(accountId));
  if (client) params.set("client", String(client));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await authFetch(`/api/google/credentials${suffix}`);
  return parseJsonOrThrow(res, "Could not load data");
}

export async function checkGoogleApis(accountId = "") {
  const params = new URLSearchParams();
  if (accountId) params.set("accountId", String(accountId));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await authFetch(`/api/google/check${suffix}`);
  return parseJsonOrThrow(res, "Could not load data");
}

export async function saveGoogleCredentials({
  clientId,
  clientSecret,
  email,
  services = [],
  client = "default",
  personal = false,
  accountId = "",
}) {
  const res = await authFetch("/api/google/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId,
      clientSecret,
      email,
      services,
      client,
      personal,
      accountId,
    }),
  });
  return res.json();
}

export async function saveGoogleAccount({
  email,
  services = [],
  client = "default",
  personal = false,
  accountId = "",
}) {
  const res = await authFetch("/api/google/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, services, client, personal, accountId }),
  });
  return res.json();
}

export async function disconnectGoogle(accountId = "") {
  const res = await authFetch("/api/google/disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId }),
  });
  return res.json();
}

export const fetchGmailConfig = async () => {
  const res = await authFetch("/api/gmail/config");
  return parseJsonOrThrow(res, "Could not load Gmail watch config");
};

export const saveGmailConfig = async ({
  client = "default",
  topicPath = "",
  projectId = "",
  regeneratePushToken = false,
} = {}) => {
  const res = await authFetch("/api/gmail/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client,
      topicPath,
      projectId,
      regeneratePushToken,
    }),
  });
  return parseJsonOrThrow(res, "Could not save Gmail watch config");
};

export const startGmailWatch = async (accountId, { destination = null } = {}) => {
  const res = await authFetch("/api/gmail/watch/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId: String(accountId || ""),
      ...(destination ? { destination } : {}),
    }),
  });
  return parseJsonOrThrow(res, "Could not start Gmail watch");
};

export const stopGmailWatch = async (accountId) => {
  const res = await authFetch("/api/gmail/watch/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: String(accountId || "") }),
  });
  return parseJsonOrThrow(res, "Could not stop Gmail watch");
};

export const renewGmailWatch = async ({
  accountId = "",
  force = true,
} = {}) => {
  const res = await authFetch("/api/gmail/watch/renew", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId: String(accountId || ""),
      force: Boolean(force),
    }),
  });
  return parseJsonOrThrow(res, "Could not renew Gmail watch");
};
