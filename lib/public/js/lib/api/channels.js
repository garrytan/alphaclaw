import { subscribeToSse } from "../sse.js";
import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export const fetchChannelAccounts = async () => {
  const res = await authFetch("/api/channels/accounts");
  return parseJsonOrThrow(res, "Could not load channel accounts");
};

export const fetchChannelAccountToken = async ({
  provider = "",
  accountId = "default",
} = {}) => {
  const params = new URLSearchParams({
    provider: String(provider || ""),
    accountId: String(accountId || "default"),
  });
  const res = await authFetch(`/api/channels/accounts/token?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load channel token");
};

export const createChannelAccount = async (payload) => {
  const res = await authFetch("/api/channels/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not create channel account");
};

export const createChannelAccountJob = async (payload) => {
  const res = await authFetch("/api/channels/accounts/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not start channel account operation");
};

export const subscribeOperationEvents = ({
  operationId = "",
  onMessage = () => {},
  onError = () => {},
}) =>
  subscribeToSse({
    url: `/api/operations/${encodeURIComponent(String(operationId || ""))}/events`,
    onMessage,
    onError,
  });

export const updateChannelAccount = async (payload) => {
  const res = await authFetch("/api/channels/accounts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not update channel account");
};

export const deleteChannelAccount = async (payload) => {
  const res = await authFetch("/api/channels/accounts", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not delete channel account");
};

export const runChannelAccountLogin = async (payload) => {
  const res = await authFetch("/api/channels/accounts/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not run channel login");
};

export const fetchChannelAccountLoginStatus = async ({
  provider = "",
  accountId = "default",
} = {}) => {
  const params = new URLSearchParams({
    provider: String(provider || ""),
    accountId: String(accountId || "default"),
  });
  const res = await authFetch(
    `/api/channels/accounts/login-status?${params.toString()}`,
  );
  return parseJsonOrThrow(res, "Could not load channel login status");
};
