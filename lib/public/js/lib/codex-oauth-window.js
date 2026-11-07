import { startOauthPopup } from "./oauth-popup.js";

const kCodexAuthStartPath = "/auth/codex/start";
const kCodexAuthWindowName = "codex-auth";
const kCodexAuthPopupFeatures = "popup=yes,width=640,height=780";
const kCodexAuthCallbackMessageType = "callback-input";

// A failed start reaches the page's existing Codex message listener.
export const openCodexAuthWindow = () =>
  startOauthPopup({
    startPath: kCodexAuthStartPath,
    windowName: kCodexAuthWindowName,
    features: kCodexAuthPopupFeatures,
    onError: (message) =>
      window.postMessage({ codex: "error", message }, window.location.origin),
  });

export const isCodexAuthCallbackMessage = (value) =>
  value?.codex === kCodexAuthCallbackMessageType &&
  typeof value.input === "string" &&
  value.input.trim().length > 0;
