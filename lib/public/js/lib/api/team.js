import { authFetch } from "./http.js";
import { parseEnvelopeOrThrow } from "./parse.js";

export async function fetchTeam() {
  const res = await authFetch("/api/team");
  return parseEnvelopeOrThrow(res, "Could not load team status");
}

export async function fetchTeamPresence() {
  const res = await authFetch("/api/team/presence");
  return parseEnvelopeOrThrow(res, "Could not load presence");
}

export async function enableTeam(payload) {
  const res = await authFetch("/api/team/enable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseEnvelopeOrThrow(res, "Could not enable team access");
}

export async function disableTeam() {
  const res = await authFetch("/api/team/disable", { method: "POST" });
  return parseEnvelopeOrThrow(res, "Could not disable team access");
}

export async function createTeamInvite(payload) {
  const res = await authFetch("/api/team/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseEnvelopeOrThrow(res, "Could not create the invite");
}

export async function revokeTeamInvite(inviteId) {
  const res = await authFetch(
    `/api/team/invites/${encodeURIComponent(inviteId)}`,
    { method: "DELETE" },
  );
  return parseEnvelopeOrThrow(res, "Could not revoke the invite");
}

export async function updateTeamMember(memberId, payload) {
  const res = await authFetch(
    `/api/team/members/${encodeURIComponent(memberId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    },
  );
  return parseEnvelopeOrThrow(res, "Could not update the member");
}

export async function removeTeamMember(memberId) {
  const res = await authFetch(
    `/api/team/members/${encodeURIComponent(memberId)}`,
    { method: "DELETE" },
  );
  return parseEnvelopeOrThrow(res, "Could not remove the member");
}
