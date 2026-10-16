// "Open the Retry upgrade confirm": the progress card's Try again and the
// global surfaces ask for it; the upgrade alert (General tab) owns the
// dialog. A request made from another page survives the navigation as a
// pending flag the alert consumes when it mounts.
const kEventName = "alphaclaw:open-upgrade-retry";
let pending = false;

export const requestUpgradeRetryConfirm = () => {
  pending = true;
  if (typeof window === "undefined") return;
  const hash = String(window.location?.hash || "");
  if (!hash.startsWith("#/general")) {
    window.location.hash = "/general";
    return;
  }
  window.dispatchEvent?.(new CustomEvent(kEventName));
};

export const consumeUpgradeRetryRequest = () => {
  const was = pending;
  pending = false;
  return was;
};

export const subscribeUpgradeRetryRequests = (listener) => {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener?.(kEventName, handler);
  return () => window.removeEventListener?.(kEventName, handler);
};
