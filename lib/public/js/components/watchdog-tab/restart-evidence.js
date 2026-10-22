import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

// Plain phrases for the operator (bug #137): engineer vocabulary (gateway
// set, bystanders, verdicts, reason codes) stays in the record and the log.
const kAskSkipCopy = {
  no_lsof: "skipped — lsof is not installed on this host (apt-get install -y lsof)",
  no_respawn_pinned: "skipped — OPENCLAW_NO_RESPAWN keeps the gateway in-process",
  no_worker: "skipped — no gateway worker was identified",
  no_budget: "skipped — not enough time left in the operation",
  caller_disabled: "skipped — disabled for this restart",
};
const kHowCopy = {
  graceful: "OpenClaw finished its work and exited on its own",
  sigterm: "forced (SIGTERM)",
  sigkill: "forced (SIGKILL)",
  none: "nothing was running",
};
const items = (list) => (Array.isArray(list?.items) ? list.items : Array.isArray(list) ? list : []);
const omitted = (list) => (Number.isFinite(list?.omitted) && list.omitted > 0 ? ` (+${list.omitted} more)` : "");
const describeProcess = (entry) => {
  const parts = [`pid ${entry?.pid ?? "?"}`];
  if (entry?.cmd) parts.push(entry.cmd);
  if (entry?.verdict === "unknown") parts.push("— could not be verified");
  else if (entry?.verdict === "alive") parts.push("— still alive");
  return parts.join(" ");
};
const processLine = (label, list, { emptyText = null } = {}) => {
  const entries = items(list);
  if (entries.length === 0 && !emptyText) return null;
  return html`<li><span class="text-fg-muted">${label}:</span> ${
    entries.length ? `${entries.map(describeProcess).join("; ")}${omitted(list)}` : emptyText
  }</li>`;
};

// Stop evidence in plain language: what the stop touched and where it
// broke. Admin sessions only — the server strips it for everyone else.
export const describeStopEvidenceLines = ({ stopEvidence = null, failedPhase = null, how = null } = {}) => {
  if (!stopEvidence || typeof stopEvidence !== "object") return [];
  const lines = [];
  if (failedPhase) lines.push(["Where it stopped", failedPhase]);
  const resolvedHow = stopEvidence.how || how;
  if (resolvedHow && kHowCopy[resolvedHow]) lines.push(["How it was stopped", kHowCopy[resolvedHow]]);
  if (stopEvidence.askSkippedReason) {
    lines.push(["Graceful stop", kAskSkipCopy[stopEvidence.askSkippedReason] || `skipped — ${stopEvidence.askSkippedReason}`]);
  } else if (stopEvidence.askExit === "expedited") {
    lines.push(["Graceful stop", "cut short: someone chose Restart now while OpenClaw was finishing its work"]);
  } else if (stopEvidence.askRefusedLine || (stopEvidence.askExit != null && resolvedHow !== "graceful")) {
    lines.push(["Graceful stop", `OpenClaw refused${stopEvidence.askRefusedLine ? `: ${stopEvidence.askRefusedLine}` : ""}`]);
  }
  const helpers = Number(stopEvidence.observedExits?.helpers);
  if (Number.isFinite(helpers) && helpers > 0) {
    lines.push(["OpenClaw helpers that exited", `${helpers}`]);
  }
  return lines;
};

export const WatchdogRestartEvidence = ({ operation = null, onLoadEvidence = null }) => {
  const [evidence, setEvidence] = useState({ operationId: null, status: "idle", text: "", detail: null });
  if (!operation || !operation.operationId) return null;
  // Failed operations always have evidence; a succeeded one only when the
  // stop was forced or took other processes with it.
  const forcedSuccess =
    operation.phase === "succeeded" &&
    ((operation.how && operation.how !== "graceful" && operation.how !== "none") ||
      (Number.isFinite(Number(operation.observedExitsCount)) && Number(operation.observedExitsCount) > 0));
  if (operation.phase !== "failed" && !forcedSuccess) return null;
  const operationId = operation.operationId;
  const current = evidence.operationId === operationId ? evidence : { status: "idle", text: "", detail: null };

  const handleToggle = (event) => {
    if (!event?.currentTarget?.open || current.status !== "idle") return;
    if (typeof onLoadEvidence !== "function") {
      setEvidence({ operationId, status: "expired", text: "", detail: null });
      return;
    }
    setEvidence({ operationId, status: "loading", text: "", detail: null });
    Promise.resolve(onLoadEvidence(operationId))
      .then((loaded) => {
        // The loader answers a string (the redacted stderr tail) or an
        // object { text, stopEvidence, failedPhase, how }.
        const text = loaded && typeof loaded === "object" ? String(loaded.text || "") : loaded ? String(loaded) : "";
        const detail = loaded && typeof loaded === "object" ? loaded : null;
        setEvidence(
          text || detail?.stopEvidence || (Array.isArray(detail?.timeline) && detail.timeline.length)
            ? { operationId, status: "loaded", text, detail }
            : { operationId, status: "expired", text: "", detail: null },
        );
      })
      .catch((error) =>
        setEvidence({ operationId, status: "error", text: String(error?.message || ""), detail: null }),
      );
  };

  const stopEvidence = current.detail?.stopEvidence || null;
  const timeline = Array.isArray(current.detail?.timeline) ? current.detail.timeline : [];
  const timelineOrigin = Number(current.detail?.startedAt) || Number(timeline[0]?.at) || 0;
  const describeTimelineEntry = (entry) => {
    const offset = `+${Math.max(0, Math.round((Number(entry.at) - timelineOrigin) / 100) / 10)}s`;
    const phase = entry.detail?.phase ? ` (${entry.detail.phase}${entry.detail.reason ? `: ${entry.detail.reason}` : ""})` : "";
    const how = entry.detail?.how ? ` — ${entry.detail.how}` : "";
    return `${offset} ${entry.step} ${entry.status}${phase}${how}`;
  };
  const lines = describeStopEvidenceLines({
    stopEvidence,
    failedPhase: current.detail?.failedPhase || null,
    how: current.detail?.how || operation.how || null,
  });

  return html`
    <details class="bg-surface border border-border rounded-xl p-4" ontoggle=${handleToggle}>
      <summary class="card-label cursor-pointer">Restart evidence</summary>
      ${current.status === "loading"
        ? html`<p class="mt-2 text-xs text-fg-muted">Loading evidence…</p>`
        : current.status === "expired"
          ? html`<p class="mt-2 text-xs text-fg-muted">Evidence expired</p>`
          : current.status === "error"
            ? html`<p class="mt-2 text-xs text-fg-muted">
                ${current.text ? `Couldn't load evidence — ${current.text}` : "Couldn't load evidence"}
              </p>`
            : current.status === "loaded"
              ? html`
                  ${stopEvidence
                    ? html`<ul class="mt-2 text-xs text-body space-y-1">
                        ${lines.map(([label, value]) => html`<li><span class="text-fg-muted">${label}:</span> ${value}</li>`)}
                        ${processLine("Stopped (OpenClaw)", stopEvidence.identity?.gateway)}
                        ${processLine("Also stopped (not OpenClaw)", stopEvidence.observedExits?.other)}
                        ${processLine("Still running (not OpenClaw)", stopEvidence.stillRunning)}
                        ${processLine("Did not exit", stopEvidence.survivors)}
                      </ul>`
                    : null}
                  ${timeline.length
                    ? html`<details class="mt-2">
                        <summary class="text-xs text-fg-muted cursor-pointer">Timeline (${timeline.length} steps)</summary>
                        <ol class="mt-1 text-xs text-body space-y-0.5">
                          ${timeline.map((entry) => html`<li>${describeTimelineEntry(entry)}</li>`)}
                        </ol>
                      </details>`
                    : null}
                  ${current.text
                    ? html`<pre class="mt-2 bg-field rounded p-2 text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto">${current.text}</pre>`
                    : null}
                `
              : null}
    </details>
  `;
};
