import { authFetch } from "./api/http.js";

// OAuth starts are same-origin POSTs (ALPH-71 L-10). The popup opens blank
// inside the click, so popup blockers allow it, and goes to the provider once
// the box answers with the authorize URL. A blocked popup sends this page
// there instead. A failed start closes the popup and reports the message.
export const startOauthPopup = ({
  startPath,
  body = {},
  windowName,
  features,
  onError = () => {},
}) => {
  const opened = window.open("", windowName, features);
  const popup = opened && !opened.closed ? opened : null;
  (async () => {
    try {
      const res = await authFetch(startPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || typeof data?.url !== "string" || !data.url) {
        throw new Error(data?.error || `Could not start sign-in (${res.status})`);
      }
      if (popup) popup.location.href = data.url;
      else window.location.href = data.url;
    } catch (err) {
      try {
        popup?.close();
      } catch {}
      onError(err?.message || "Could not start sign-in");
    }
  })();
  return popup;
};
