import { authFetch } from "./http.js";

// Telegram group rules (GST-1975). Failures are RFC 9457 problem bodies; the
// thrown error keeps only the documented problem fields, so the Groups page
// can show the title, fix, retry and side effects.
const kProblemFields = ["type", "title", "status", "detail", "code", "fix", "retry", "sideEffects", "revision", "current", "topicOverrides", "mode"];

const parseGroupsResponse = async (res, fallbackError) => {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error(fallbackError), { status: res.status, problem: { title: fallbackError, status: res.status, detail: text.slice(0, 300) } });
  }
  if (res.ok && data?.ok !== false) return data;
  const problem = { status: res.status };
  for (const field of kProblemFields) if (data?.[field] !== undefined) problem[field] = data[field];
  if (!problem.title) problem.title = data?.message || data?.error || fallbackError;
  throw Object.assign(new Error(problem.title), { status: res.status, code: problem.code, problem });
};

const accountQuery = (accountId) => {
  const normalized = String(accountId || "").trim();
  return normalized && normalized !== "default" ? "?accountId=" + encodeURIComponent(normalized) : "";
};

export async function fetchTelegramGroups({ accountId = "default" } = {}) {
  const res = await authFetch("/api/telegram/groups" + accountQuery(accountId));
  return parseGroupsResponse(res, "Could not load the Telegram groups");
}

export async function setTelegramGroupPolicy(groupId, body, { revision = "", accountId = "default" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (revision) headers["If-Match"] = '"' + revision + '"';
  const res = await authFetch("/api/telegram/groups/" + encodeURIComponent(String(groupId)) + "/policy" + accountQuery(accountId), {
    method: "PUT",
    headers,
    body: JSON.stringify(body || {}),
  });
  return parseGroupsResponse(res, body?.dryRun ? "Could not preview the change" : "Could not save the group's rule");
}

export async function testTelegramGroup(groupId, { senderIds = [], accountId = "default" } = {}) {
  const res = await authFetch("/api/telegram/groups/" + encodeURIComponent(String(groupId)) + "/test" + accountQuery(accountId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderIds }),
  });
  return parseGroupsResponse(res, "Could not test the group");
}

export async function setTelegramBlockedSenders(senders, { revision = "" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (revision) headers["If-Match"] = '"' + revision + '"';
  const res = await authFetch("/api/telegram/blocked-senders", {
    method: "PUT",
    headers,
    body: JSON.stringify({ senders }),
  });
  return parseGroupsResponse(res, "Could not save the block list");
}
