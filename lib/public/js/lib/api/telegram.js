import { authFetch } from "./http.js";

// Telegram topic registry (returns raw payloads so callers can inspect
// degraded-state codes like TOPIC_REGISTRY_UNREADABLE on ok:false responses).
export async function getTelegramTopics() {
  const res = await authFetch("/api/telegram/topics");
  return res.json();
}

export async function restoreTelegramTopic(groupId, topicId) {
  const safeGroupId = encodeURIComponent(String(groupId || ""));
  const safeTopicId = encodeURIComponent(String(topicId || ""));
  const res = await authFetch(
    `/api/telegram/groups/${safeGroupId}/topics/${safeTopicId}/restore`,
    { method: "POST" },
  );
  return res.json();
}

export async function verifyTelegramTopic(groupId, topicId, { accountId = "" } = {}) {
  const safeGroupId = encodeURIComponent(String(groupId || ""));
  const safeTopicId = encodeURIComponent(String(topicId || ""));
  // Named-account groups must be probed with THEIR bot (fix wave F166): without
  // the accountId the server fell back to the default bot, which is not a
  // member of the group, and "Verify now" marked live topics stale.
  const params = new URLSearchParams();
  const normalizedAccountId = String(accountId || "").trim();
  if (normalizedAccountId && normalizedAccountId !== "default") {
    params.set("accountId", normalizedAccountId);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await authFetch(
    `/api/telegram/groups/${safeGroupId}/topics/${safeTopicId}/verify${suffix}`,
    { method: "POST" },
  );
  return res.json();
}

export async function sweepTopicDiscovery() {
  const res = await authFetch("/api/telegram/discovery/sweep", {
    method: "POST",
  });
  return res.json();
}
