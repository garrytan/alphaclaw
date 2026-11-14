import { authFetch } from "./http.js";

// Guest notes (GST-2662): group members' saves, kept as outside-guest pages
// in the brain. Turning a group on is refused until the brain supports them.
const parse = async (res, fallbackError) => {
  const data = await res.json().catch(() => null);
  if (res.ok && data?.ok !== false) return data;
  throw Object.assign(new Error(data?.error || fallbackError), { status: res.status, code: data?.code || null });
};

export async function fetchGuestNotes() {
  return parse(await authFetch("/api/guest-notes"), "Could not load guest notes");
}

export async function setGuestNotesForGroup(groupKey, enabled) {
  const res = await authFetch("/api/guest-notes/groups/" + encodeURIComponent(String(groupKey)), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: enabled === true }),
  });
  return parse(res, "Could not save the guest notes setting");
}
