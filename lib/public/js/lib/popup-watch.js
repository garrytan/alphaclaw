// "Did the OAuth popup close?" watcher (fix wave PR 11). This is the one
// legitimate imperative interval in lib/public/js: the poll belongs to the
// CLICK that opened the popup, not to a render lifecycle (a hook-based
// interval would shift effect order for every component that opens one), it
// does no network work, and it must keep running while our tab is hidden —
// the user is IN the popup. Listed in the ui-intervals guard's primitive set.
export const kPopupWatchIntervalMs = 500;

export const watchPopupClosed = (
  popup,
  onClosed,
  { intervalMs = kPopupWatchIntervalMs } = {},
) => {
  if (!popup || typeof onClosed !== "function") return () => {};
  let id = setInterval(() => {
    let closed = false;
    try {
      closed = popup.closed === true;
    } catch {
      // Cross-origin popups can throw on property access in some browsers.
      closed = false;
    }
    if (!closed) return;
    stop();
    onClosed();
  }, intervalMs);
  const stop = () => {
    if (id == null) return;
    clearInterval(id);
    id = null;
  };
  return stop;
};
