import { useCallback, useEffect, useState } from "preact/hooks";
import {
  fetchChannelAccountLoginStatus,
  fetchRestartStatus,
  runChannelAccountLogin,
} from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import {
  isImplicitDefaultAccount,
  resolveChannelAccountLabel,
} from "../../lib/channel-accounts.js";
import { getChannelMeta } from "../../lib/channel-registry.js";
import { showToast } from "../toast.js";
import { kOpenWhatsappQrEvent } from "../../lib/ui-events.js";

const appendTerminalOutput = (previousOutput = "", nextChunk = "") =>
  [String(previousOutput || "").trim(), String(nextChunk || "").trim()]
    .filter(Boolean)
    .join("\n\n");

const cloneLoginModalState = (state = {}) => ({
  loginAccount: state.loginAccount || null,
  loginOutput: String(state.loginOutput || ""),
  loginError: String(state.loginError || ""),
  loginRunning: !!state.loginRunning,
  loginMonitoring: !!state.loginMonitoring,
  loginCompleted: !!state.loginCompleted,
  loginLinked: !!state.loginLinked,
  loginRestartingGateway: !!state.loginRestartingGateway,
  loginRestartedGateway: !!state.loginRestartedGateway,
});

let kPreservedChannelLoginModalState = null;

const clearChannelLoginModalState = ({
  setLoginAccount,
  setLoginOutput,
  setLoginError,
  setLoginRunning,
  setLoginMonitoring,
  setLoginCompleted,
  setLoginLinked,
  setLoginRestartingGateway,
  setLoginRestartedGateway,
}) => {
  kPreservedChannelLoginModalState = null;
  setLoginAccount(null);
  setLoginOutput("");
  setLoginError("");
  setLoginRunning(false);
  setLoginMonitoring(false);
  setLoginCompleted(false);
  setLoginLinked(false);
  setLoginRestartingGateway(false);
  setLoginRestartedGateway(false);
};

// The WhatsApp QR login modal: runs the login, watches for the linked
// session, restarts the gateway so it comes online and refreshes the list.
// The modal's state outlives a remount of the Channels page.
export const useChannelLogin = ({
  channelAccounts,
  defaultAgentId,
  loadChannelAccounts,
  onRefreshStatuses,
  onRestartGateway,
}) => {
  const preservedLoginState = cloneLoginModalState(kPreservedChannelLoginModalState || {});
  const [loginAccount, setLoginAccount] = useState(preservedLoginState.loginAccount);
  const [loginOutput, setLoginOutput] = useState(preservedLoginState.loginOutput);
  const [loginError, setLoginError] = useState(preservedLoginState.loginError);
  const [loginRunning, setLoginRunning] = useState(preservedLoginState.loginRunning);
  const [loginMonitoring, setLoginMonitoring] = useState(preservedLoginState.loginMonitoring);
  const [loginCompleted, setLoginCompleted] = useState(preservedLoginState.loginCompleted);
  const [loginLinked, setLoginLinked] = useState(preservedLoginState.loginLinked);
  const [loginRestartingGateway, setLoginRestartingGateway] = useState(
    preservedLoginState.loginRestartingGateway,
  );
  const [loginRestartedGateway, setLoginRestartedGateway] = useState(
    preservedLoginState.loginRestartedGateway,
  );
  const [loginRestartStatusChecked, setLoginRestartStatusChecked] = useState(false);

  const loginStatusPoll = usePolling(
    () =>
      fetchChannelAccountLoginStatus({
        provider: loginAccount?.provider,
        accountId: loginAccount?.id,
      }),
    1000,
    {
      enabled:
        !!loginAccount &&
        !!loginMonitoring &&
        String(loginAccount?.provider || "").trim() === "whatsapp",
    },
  );
  const restartStatusPoll = usePolling(fetchRestartStatus, 2000, {
    enabled: !!loginAccount && !!loginRestartingGateway,
  });

  const appendLoginOutput = useCallback((nextChunk = "") => {
    setLoginOutput((currentOutput) => appendTerminalOutput(currentOutput, nextChunk));
  }, []);

  const openLogin = useCallback((account) => {
    setLoginAccount(account);
    setLoginOutput("");
    setLoginError("");
    setLoginRunning(false);
    setLoginMonitoring(false);
    setLoginCompleted(false);
    setLoginLinked(false);
    setLoginRestartingGateway(false);
    setLoginRestartedGateway(false);
    setLoginRestartStatusChecked(false);
  }, []);

  useEffect(() => {
    const nextState = cloneLoginModalState({
      loginAccount,
      loginOutput,
      loginError,
      loginRunning,
      loginMonitoring,
      loginCompleted,
      loginLinked,
      loginRestartingGateway,
      loginRestartedGateway,
    });
    const hasActiveLoginState =
      !!nextState.loginAccount ||
      !!nextState.loginOutput ||
      !!nextState.loginError ||
      !!nextState.loginRunning ||
      !!nextState.loginMonitoring ||
      !!nextState.loginCompleted ||
      !!nextState.loginLinked ||
      !!nextState.loginRestartingGateway ||
      !!nextState.loginRestartedGateway;
    kPreservedChannelLoginModalState = hasActiveLoginState ? nextState : null;
  }, [
    loginAccount,
    loginCompleted,
    loginError,
    loginLinked,
    loginMonitoring,
    loginOutput,
    loginRestartedGateway,
    loginRestartingGateway,
    loginRunning,
  ]);

  useEffect(() => {
    const handleOpenWhatsAppQr = () => {
      const configuredWhatsApp = channelAccounts.find(
        (entry) => String(entry?.channel || "").trim() === "whatsapp",
      );
      const account = Array.isArray(configuredWhatsApp?.accounts)
        ? configuredWhatsApp.accounts[0]
        : null;
      if (!account) return;
      const accountId = String(account?.id || "").trim() || "default";
      const boundAgentId = String(account?.boundAgentId || "").trim();
      const ownerAgentId =
        boundAgentId ||
        (isImplicitDefaultAccount({ accountId, boundAgentId })
          ? defaultAgentId
          : "");
      const accountData = {
        id: accountId,
        provider: "whatsapp",
        name: resolveChannelAccountLabel({
          channelId: "whatsapp",
          account,
          providerLabel: getChannelMeta("whatsapp").label || "WhatsApp",
        }),
        ownerAgentId,
        envKey: String(account?.envKey || "").trim(),
        token: String(account?.token || "").trim(),
      };
      openLogin(accountData);
    };
    window.addEventListener(kOpenWhatsappQrEvent, handleOpenWhatsAppQr);
    return () => {
      window.removeEventListener(kOpenWhatsappQrEvent, handleOpenWhatsAppQr);
    };
  }, [channelAccounts, defaultAgentId]);

  const handleRunChannelLogin = async () => {
    if (!loginAccount) return;
    setLoginRunning(true);
    setLoginMonitoring(true);
    setLoginCompleted(false);
    setLoginLinked(false);
    setLoginRestartingGateway(false);
    setLoginRestartedGateway(false);
    setLoginRestartStatusChecked(false);
    setLoginError("");
    setLoginOutput("");
    try {
      const result = await runChannelAccountLogin({
        provider: loginAccount.provider,
        accountId: loginAccount.id,
      });
      const combinedOutput = appendTerminalOutput(result?.stdout || "", result?.stderr || "");
      setLoginOutput(combinedOutput || "No terminal output captured.");
      setLoginCompleted(!!result?.completed);
      if (result?.completed) {
        await loginStatusPoll.refresh();
      }
    } catch (error) {
      setLoginError(String(error?.message || "Could not start channel login"));
      setLoginMonitoring(false);
    } finally {
      setLoginRunning(false);
    }
  };

  useEffect(() => {
    if (!loginAccount || !loginMonitoring || loginLinked || loginRestartingGateway) {
      return;
    }
    if (!loginStatusPoll.data?.linked) return;

    let cancelled = false;
    setLoginLinked(true);
    setLoginError("");
    appendLoginOutput("Saved WhatsApp credentials detected.");

    (async () => {
      setLoginRestartingGateway(true);
      setLoginRestartStatusChecked(false);
      appendLoginOutput("Restarting the gateway so the new WhatsApp session comes online…");
      try {
        const restartResult = await onRestartGateway();
        if (restartResult && restartResult.ok === false) {
          throw new Error(restartResult.error || "Could not restart gateway");
        }
        if (cancelled) return;
        appendLoginOutput("Gateway restart triggered. Waiting for it to come back online…");
        await restartStatusPoll.refresh();
        if (cancelled) return;
        setLoginRestartStatusChecked(true);
      } catch (error) {
        if (cancelled) return;
        setLoginError(String(error?.message || "Could not restart gateway"));
        appendLoginOutput(
          "WhatsApp linked, but the gateway restart failed. You may need to restart it manually.",
        );
        setLoginRestartStatusChecked(false);
        setLoginRestartingGateway(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    appendLoginOutput,
    loadChannelAccounts,
    loginAccount,
    loginLinked,
    loginMonitoring,
    loginRestartingGateway,
    loginStatusPoll.data?.linked,
    onRefreshStatuses,
    onRestartGateway,
    restartStatusPoll.refresh,
  ]);

  useEffect(() => {
    if (!loginAccount || !loginRestartingGateway) return;
    if (!loginRestartStatusChecked) return;
    const restartInProgress = !!restartStatusPoll.data?.restartInProgress;
    const gatewayRunning = restartStatusPoll.data?.gatewayRunning !== false;
    if (restartInProgress || !gatewayRunning) return;

    let cancelled = false;

    (async () => {
      setLoginRestartedGateway(true);
      setLoginMonitoring(false);
      appendLoginOutput("Gateway restart complete.");
      showToast("Channel linked", "success");
      await Promise.all([
        loadChannelAccounts(),
        Promise.resolve(onRefreshStatuses?.()),
      ]);
      if (cancelled) return;
      clearChannelLoginModalState({
        setLoginAccount,
        setLoginOutput,
        setLoginError,
        setLoginRunning,
        setLoginMonitoring,
        setLoginCompleted,
        setLoginLinked,
        setLoginRestartingGateway,
        setLoginRestartedGateway,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    appendLoginOutput,
    loadChannelAccounts,
    loginAccount,
    loginRestartStatusChecked,
    loginRestartingGateway,
    onRefreshStatuses,
    restartStatusPoll.data?.gatewayRunning,
    restartStatusPoll.data?.restartInProgress,
  ]);

  const closeLogin = () => {
    if (loginRunning || loginRestartingGateway) return;
    clearChannelLoginModalState({
      setLoginAccount,
      setLoginOutput,
      setLoginError,
      setLoginRunning,
      setLoginMonitoring,
      setLoginCompleted,
      setLoginLinked,
      setLoginRestartingGateway,
      setLoginRestartedGateway,
    });
  };

  return {
    loginAccount,
    loginOutput,
    loginError,
    loginRunning,
    loginLinked,
    loginRestartingGateway,
    loginRestartedGateway,
    openLogin,
    closeLogin,
    handleRunChannelLogin,
  };
};
