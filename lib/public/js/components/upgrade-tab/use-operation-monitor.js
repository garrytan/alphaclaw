import { useCallback, useEffect, useRef } from "preact/hooks";
import { fetchOpenclawRun, fetchStatus } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { buildErrorEnvelopeModel, buildVerdictBannerModel, describeTarget } from "./helpers.js";

export const completesInPlace = (target) => target?.repair === true || target?.kind === "backup";

export const resumeLedgerOperation = (runs = []) => {
  const run = runs.find((entry) => entry?.operationId && entry.target &&
    (entry.state === "running" || entry.state === "restart_expected"));
  if (!run) return null;
  return {
    operationId: run.operationId,
    resumed: true,
    target: run.target,
    intent: run.intent,
    expectLatest: run.expectLatest === true,
    recoveryMode: run.recoveryMode || "config_only",
    label: run.target.repair ? "repair" : run.target.kind === "backup" ? "manual backup" : describeTarget(run.target),
    startedAt: run.startedAt || Date.now(),
    steps: Array.isArray(run.steps) ? run.steps : [],
    output: "",
    lastOutputAt: null,
    phase: run.state === "restart_expected" && !completesInPlace(run.target) ? "restarting" : "running",
    error: null,
  };
};

export const operationRunPhase = (run) => {
  if (!run) return "running";
  if (["failed", "activation_failed", "interrupted"].includes(run.state) || run.ok === false) return "failed";
  if (completesInPlace(run.target)) {
    return ["completed", "activated"].includes(run.state) || (run.finishedAt != null && run.ok === true)
      ? "completed" : "running";
  }
  if (run.state === "restart_expected" || run.state === "activated" || run.ok === true) return "restarting";
  return "running";
};

// A lost stream and a page reload follow the same durable record. Neither
// channel.lastUpdateRun nor list order may decide an existing operation.
export const useOperationMonitor = ({ operation, setOperation, expectedRef, onTerminal, onRestartFinished }) => {
  const operationId = operation?.operationId || "";
  const active = Boolean(operation && (operation.resumed || operation.phase === "restarting") &&
    ["running", "restarting"].includes(operation.phase));
  const callbacks = useRef({ onTerminal, onRestartFinished });
  callbacks.current = { onTerminal, onRestartFinished };
  const handled = useRef(null);
  const read = usePolling(async ({ signal }) => {
    const payload = operationId ? await fetchOpenclawRun(operationId, { signal }) : null;
    const run = payload?.run || null;
    if (operationId && run?.operationId !== operationId) throw new Error("The operation status did not match this operation. Retry to check again.");
    const restarting = operation?.phase === "restarting" || operationRunPhase(run) === "restarting";
    const status = restarting && !completesInPlace(operation?.target) ? await fetchStatus({ signal }) : null;
    return { run, status, operationId, startedAt: operation?.startedAt };
  }, 3000, {
    enabled: active,
    cacheKey: `/api/openclaw/runs/${operationId || "rollback"}?monitor=${operation?.startedAt || ""}&phase=${operation?.phase || ""}`,
    acceptsSignal: true,
  });

  useEffect(() => {
    if (!active || !read.data || read.data.operationId !== operationId || read.data.startedAt !== operation.startedAt) return;
    const { run, status } = read.data;
    const phase = operationRunPhase(run);
    const terminalKey = `${operationId}:${operation.startedAt}:${phase}`;
    if (phase === "failed" || phase === "completed") {
      if (handled.current === terminalKey) return;
      handled.current = terminalKey;
      setOperation((current) => (current?.operationId || "") === operationId ? {
        ...current, phase, steps: run.steps || current.steps,
        finishedAt: run.finishedAt ?? Date.now(), result: run.result,
        error: phase === "failed" ? buildErrorEnvelopeModel(run.result || { message: "The operation did not complete." }) : null,
      } : current);
      callbacks.current.onTerminal?.(run, phase);
      return;
    }
    if (status?.openclawChannel && (!operationId || run?.state === "activated")) {
      const verdict = buildVerdictBannerModel({
        expected: expectedRef.current || operation.target,
        channel: status.openclawChannel,
      });
      if (verdict?.ok) {
        if (handled.current === terminalKey) return;
        handled.current = terminalKey;
        callbacks.current.onRestartFinished?.(verdict, run);
        return;
      }
    }
    setOperation((current) => (current?.operationId || "") === operationId && current?.phase === "running" ? {
      ...current, steps: run?.steps || current.steps,
      phase: phase === "restarting" ? "restarting" : "running",
    } : current);
  }, [active, read.data, operationId, operation?.startedAt, operation?.phase]);

  // Losing the provider connection is not proof the operation failed. Keep
  // its identity and allow an explicit status retry after a bounded wait.
  useEffect(() => {
    if (!active || operation?.phase !== "restarting") return;
    const timer = setTimeout(() => setOperation((current) =>
      (current?.operationId || "") === operationId && current?.phase === "restarting"
        ? { ...current, phase: "unknown", monitorMessage: "The server has not confirmed this update yet. Retry the status check before starting another operation." }
        : current), 120_000);
    return () => clearTimeout(timer);
  }, [active, operationId, operation?.startedAt, operation?.phase]);

  const retry = useCallback(() => {
    if (operation?.phase === "unknown") setOperation((current) => current ? { ...current, resumed: true, phase: "restarting", monitorMessage: null } : current);
    return read.refresh({ force: true });
  }, [operation?.phase, read.refresh]);
  return { error: active ? read.error : null, retry };
};
