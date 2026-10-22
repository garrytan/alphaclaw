import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export const subscribeStatusEvents = ({
  onMessage = () => {},
  onOpen = () => {},
  onError = () => {},
} = {}) => {
  if (typeof window?.EventSource !== "function") {
    throw new Error("Server events are not supported in this browser");
  }
  const source = new window.EventSource("/api/events/status", {
    withCredentials: true,
  });
  const handleStatus = (event) => {
    let payload = {};
    try {
      payload = event?.data ? JSON.parse(event.data) : {};
    } catch {}
    onMessage(payload || {});
  };
  source.addEventListener("status", handleStatus);
  source.onopen = () => onOpen();
  source.onerror = (event) => onError(event);
  return () => {
    source.removeEventListener("status", handleStatus);
    source.onopen = null;
    source.onerror = null;
    source.close();
  };
};

export async function fetchStatus({ signal } = {}) {
  const res = await authFetch("/api/status", { signal });
  // A non-OK response (the route's 500 {error} envelope) is a FAILED poll,
  // never a status frame — consuming it as data kept connectivity "online"
  // and rendered the version-skew legacy card against a broken server.
  return parseJsonOrThrow(res, "Could not load status");
}

// Public boot progress (no session needed; the boot placeholder answers the
// same path before the real server listens). Plain fetch: a reconnect probe
// must never trigger the 401 → login redirect. Resolves null when nothing
// usable answered.
export async function fetchBootProgress({ signal } = {}) {
  try {
    const res = await fetch("/boot-progress.json", { cache: "no-store", credentials: "same-origin", signal });
    if (!res.ok) return null;
    const frame = await res.json();
    return frame && typeof frame === "object" && frame.source ? frame : null;
  } catch {
    return null;
  }
}
