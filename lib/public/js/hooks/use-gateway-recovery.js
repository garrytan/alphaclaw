import { useEffect, useRef, useState } from "preact/hooks";
import { fetchGatewayRecoveryEvidence, triggerWatchdogRepair } from "../lib/api.js";

export const useGatewayRecovery = ({ shell, serverState, onRestart, onRefresh }) => {
  const [selected, setSelected] = useState(null);
  const [evidence, setEvidence] = useState(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const triggerRef = useRef(null);
  const headingRef = useRef(null);
  const flightRef = useRef(false);
  const checkRef = useRef(false);
  const mountedRef = useRef(true);
  const frozen = !serverState || shell.statusFreshness?.mode === "stale" || (shell.connectivityMode && shell.connectivityMode !== "online");
  const projected = serverState?.actions?.find((item) => item.id === selected);
  const descriptor = ["not_started", "failed"].includes(outcome?.kind) && outcome.recovery ? { ...projected, ...outcome.recovery } : projected;
  const operationActive = shell.restartOperation?.phase === "running";
  const signature = JSON.stringify([serverState?.state, descriptor, frozen, operationActive]);
  const [confirmation, setConfirmation] = useState(null);
  const canExecute = !frozen && !operationActive && descriptor?.disposition === "execute";

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => { if (selected) headingRef.current?.focus(); }, [selected]);
  useEffect(() => {
    if (confirmation && !confirmation.submitted && confirmation.signature !== signature) {
      setConfirmation(null);
      setOutcome({ kind: "not_started", message: "Status changed. Nothing was started by this confirmation. Inspect the current state and confirm again." });
    }
  }, [signature, confirmation]);

  const open = (id, event) => {
    triggerRef.current = event?.currentTarget || null;
    if (selected === id) headingRef.current?.focus();
    setSelected(id);
    setConfirmation(null);
    if (["not_started", "failed"].includes(outcome?.kind)) setOutcome(null);
  };
  const close = () => {
    setSelected(null);
    setConfirmation(null);
    triggerRef.current?.focus();
  };
  const refresh = async () => {
    await (onRefresh || shell.actions?.refresh)?.();
  };
  const check = async () => {
    if (checkRef.current) return;
    checkRef.current = true;
    setChecking(true);
    try {
      const result = await fetchGatewayRecoveryEvidence();
      if (mountedRef.current) {
        setEvidence(result.bundle);
        setOutcome({ kind: "observed", message: "Current assessment updated. Check again only observes; it does not start the gateway." });
      }
      await refresh();
    } catch (error) {
      if (mountedRef.current) setOutcome({ kind: "not_started", message: `${error.message}. Reconnect or sign in to AlphaClaw, or use the recovery instructions below.` });
    } finally {
      checkRef.current = false;
      if (mountedRef.current) setChecking(false);
    }
  };
  const submit = async () => {
    if (flightRef.current || confirmation?.submitted || confirmation?.signature !== signature || !canExecute) return;
    flightRef.current = true;
    setSubmitting(true);
    setConfirmation({ ...confirmation, submitted: true });
    setOutcome({ kind: "pending", message: "Request sent. Waiting for AlphaClaw's admission decision…" });
    try {
      const result = selected === "repair"
        ? await triggerWatchdogRepair({ force: descriptor?.paused === true && !descriptor?.resolution })
        : await (onRestart || shell.actions?.restart)?.({});
      if (!mountedRef.current) return;
      if (result?.ok === false || result?.skipped) {
        setOutcome({ kind: "not_started", message: result.error || result.reason || "Not started. Inspect current status before another attempt.", recovery: result.recovery });
      } else if (!result) {
        setOutcome({ kind: "unknown", message: "Result unknown. Refresh status to find the existing operation before making another attempt. This request will not be replayed." });
      } else {
        setOutcome({ kind: "accepted", message: result.attached ? "Viewing the existing operation. No second restart was started." : "Request accepted. Recovery is not confirmed until the gateway is ready." });
      }
      await refresh();
    } catch (error) {
      if (mountedRef.current) setOutcome({
        kind: error.notStarted ? "not_started" : error.responseReceived ? "failed" : "unknown",
        message: error.notStarted ? `Not started: ${error.message}` : error.responseReceived
          ? `Repair did not complete: ${error.message}. Configuration changes may already have been applied. Inspect the current status before another attempt.`
          : "Result unknown: the response was lost. Refresh status to reconcile existing work; do not repeat the request until its outcome is known.",
        recovery: error.recovery, hint: error.hint,
      });
      await refresh().catch(() => {});
    } finally {
      flightRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };
  return { selected, descriptor, frozen, operationActive, evidence, checking, submitting, outcome, confirmation, headingRef, canExecute, open, close, refresh, check, submit,
    confirm: () => setConfirmation({ signature }),
  };
};
