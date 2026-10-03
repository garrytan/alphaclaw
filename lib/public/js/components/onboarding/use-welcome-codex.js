import { useEffect, useRef, useState } from "preact/hooks";
import {
  disconnectCodex,
  exchangeCodexOAuth,
  fetchCodexStatus,
} from "../../lib/api.js";
import {
  isCodexAuthCallbackMessage,
  openCodexAuthWindow,
} from "../../lib/codex-oauth-window.js";
import {
  applyCodexStatusRead,
  isStoreUnavailable,
} from "../../lib/codex-status.js";
import {
  cancelStoreUnavailableRecheck,
  settleStoreUnavailableRecheck,
} from "../../lib/store-availability.js";
import { watchPopupClosed } from "../../lib/popup-watch.js";

export const useWelcomeCodex = ({ setFormError } = {}) => {
  const [codexStatus, setCodexStatus] = useState({ connected: false });
  const [codexLoading, setCodexLoading] = useState(true);
  // codexStatusError carries the failed-check message ("" when healthy);
  // codexStatusKnown is true only once a status CHECK has succeeded — the
  // { connected: false } initial above is a placeholder, not a checked status.
  const [codexStatusError, setCodexStatusError] = useState("");
  const [codexStatusKnown, setCodexStatusKnown] = useState(false);
  // ONE bounded re-read while the status read is unavailable: onboarding
  // never remounts, so without it the "unavailable" line would stand until
  // the operator acted.
  const codexStoreRecheckRef = useRef(null);
  const [codexManualInput, setCodexManualInput] = useState("");
  const [codexExchanging, setCodexExchanging] = useState(false);
  const [codexAuthStarted, setCodexAuthStarted] = useState(false);
  const [codexAuthWaiting, setCodexAuthWaiting] = useState(false);
  const [codexDisconnecting, setCodexDisconnecting] = useState(false);
  const codexExchangeInFlightRef = useRef(false);
  // "Did the OAuth popup close?" watcher — click-lifecycle, via the shared
  // imperative primitive (fix wave PR 11); the ref holds its stop().
  const codexPopupWatchRef = useRef(null);

  const refreshCodexStatus = async () => {
    try {
      const status = await fetchCodexStatus();
      if (status?.ok === false) {
        // HTTP errors resolve as {ok:false} envelopes — same rule as the
        // rejection path below: keep last-known, never fabricate.
        setCodexStatusError(
          String(status.error || status.message || "unknown error"),
        );
        return;
      }
      // An `unavailable` read keeps the last-known status
      // under the marker and does not count as a check.
      const read = applyCodexStatusRead({
        previous: codexStatus,
        previousKnown: codexStatusKnown,
        next: status,
      });
      setCodexStatus(read.status);
      setCodexStatusKnown(read.known);
      setCodexStatusError("");
      if (read.status.connected) {
        setCodexAuthStarted(false);
        setCodexAuthWaiting(false);
      }
      settleStoreUnavailableRecheck(codexStoreRecheckRef, {
        unavailable: isStoreUnavailable(status),
        recheck: () => refreshCodexStatus(),
      });
    } catch (err) {
      // A failed status CHECK keeps the last-known status — fabricating
      // "not connected" would misreport a live auth.
      setCodexStatusError(err?.message || "unknown error");
    } finally {
      setCodexLoading(false);
    }
  };

  useEffect(() => {
    refreshCodexStatus();
  }, []);

  const submitCodexAuthInput = async (input) => {
    const normalizedInput = String(input || "").trim();
    if (!normalizedInput || codexExchangeInFlightRef.current) return;
    codexExchangeInFlightRef.current = true;
    setCodexManualInput(normalizedInput);
    setCodexExchanging(true);
    setFormError(null);
    try {
      const result = await exchangeCodexOAuth(normalizedInput);
      if (!result.ok)
        throw new Error(result.error || "Codex OAuth exchange failed");
      setCodexManualInput("");
      setCodexAuthStarted(false);
      setCodexAuthWaiting(false);
      await refreshCodexStatus();
    } catch (err) {
      setCodexAuthWaiting(false);
      setFormError(err.message || "Codex OAuth exchange failed");
    } finally {
      codexExchangeInFlightRef.current = false;
      setCodexExchanging(false);
    }
  };

  useEffect(() => {
    const onMessage = async (e) => {
      if (e.data?.codex === "success") {
        await refreshCodexStatus();
      } else if (isCodexAuthCallbackMessage(e.data)) {
        await submitCodexAuthInput(e.data.input);
      }
      if (e.data?.codex === "error") {
        setFormError(`Codex auth failed: ${e.data.message || "unknown error"}`);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [setFormError, submitCodexAuthInput]);

  useEffect(
    () => () => {
      codexPopupWatchRef.current?.();
      codexPopupWatchRef.current = null;
      cancelStoreUnavailableRecheck(codexStoreRecheckRef);
    },
    [],
  );

  // Shared by Connect AND Reconnect — no connected-guard here (Reconnect
  // exists precisely to redo the flow while connected).
  const startCodexAuth = () => {
    setCodexAuthStarted(true);
    setCodexAuthWaiting(true);
    const popup = openCodexAuthWindow();
    if (!popup || popup.closed) {
      setCodexAuthWaiting(false);
      return;
    }
    codexPopupWatchRef.current?.();
    codexPopupWatchRef.current = watchPopupClosed(popup, () => {
      codexPopupWatchRef.current = null;
      setCodexAuthWaiting(false);
    });
  };

  const completeCodexAuth = async () => {
    await submitCodexAuthInput(codexManualInput);
  };

  const handleCodexDisconnect = async () => {
    if (codexDisconnecting) return;
    setCodexDisconnecting(true);
    try {
      const result = await disconnectCodex();
      if (!result.ok) {
        setFormError(result.error || "Failed to disconnect Codex");
        return;
      }
      setCodexAuthStarted(false);
      setCodexAuthWaiting(false);
      setCodexManualInput("");
      await refreshCodexStatus();
    } catch (err) {
      setFormError(err.message || "Failed to disconnect Codex");
    } finally {
      setCodexDisconnecting(false);
    }
  };

  return {
    codexStatus,
    codexLoading,
    codexStatusError,
    // A failed FIRST check has no last-known status to show — the consuming
    // step renders a neutral "Status unknown", never a fabricated
    // "Not connected".
    codexStatusUnknown: !!codexStatusError && !codexStatusKnown,
    codexStatusKnown,
    codexManualInput,
    setCodexManualInput,
    codexExchanging,
    codexAuthStarted,
    codexAuthWaiting,
    codexDisconnecting,
    startCodexAuth,
    completeCodexAuth,
    handleCodexDisconnect,
  };
};
