import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "./action-button.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { triggerWatchdogRepair } from "../lib/api.js";

const html = htm.bind(h);

export const kRepairConfirmTitle = "Run Doctor repair?";
export const kRepairConfirmMessage =
  "Doctor may change supported configuration and relaunch the gateway.";

// Doctor repair keeps its confirmation: it can rewrite supported
// configuration before relaunching. When the server reports automatic repair
// as paused (and nothing else blocks it), the one admitted attempt is
// requested with `force: true` — "Resume repair once" never re-enables
// automatic repair.
export const RepairButton = ({
  descriptor = null,
  frozen = false,
  disabled = false,
  disabledReason = "",
  repairing = false,
  onRepaired = null,
}) => {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const flightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resumeOnce = descriptor?.paused === true && !descriptor?.resolution;
  const blocked =
    frozen ||
    disabled ||
    (descriptor?.disposition != null && descriptor.disposition !== "execute");
  const title = blocked
    ? disabledReason || descriptor?.disabledReason || descriptor?.reason || ""
    : descriptor?.description || "";

  const submit = async () => {
    setConfirming(false);
    if (flightRef.current) return;
    flightRef.current = true;
    setSubmitting(true);
    setOutcome(null);
    try {
      await triggerWatchdogRepair(resumeOnce ? { force: true } : {});
      if (!mountedRef.current) return;
      setOutcome(null);
      onRepaired?.();
    } catch (error) {
      if (!mountedRef.current) return;
      setOutcome(
        error?.notStarted
          ? `Not started: ${error.message}`
          : error?.responseReceived
            ? `Repair did not complete: ${error.message}. Configuration changes may already have been applied.`
            : "Result unknown: the response was lost. Refresh status before trying again.",
      );
    } finally {
      flightRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

  // Siblings, not a wrapper: the outcome line wraps onto its own row of the
  // card's button group (flex-basis 100%) instead of widening a column.
  return html`
    <${ActionButton}
      onClick=${() => setConfirming(true)}
      tone=${descriptor?.kind === "primary" ? "primary" : "secondary"}
      size="sm"
      idleLabel="Repair"
      loadingLabel="Repairing…"
      loading=${submitting || repairing}
      disabled=${blocked}
      title=${title}
      className="ac-touch"
    />
    ${outcome
      ? html`<p class="ac-repair-outcome text-xs text-status-warning-muted" role="alert">${outcome}</p>`
      : null}
    <${ConfirmDialog}
      visible=${confirming}
      title=${kRepairConfirmTitle}
      message=${kRepairConfirmMessage}
      confirmLabel=${resumeOnce ? "Resume repair once" : "Repair"}
      confirmTone="warning"
      onConfirm=${submit}
      onCancel=${() => setConfirming(false)}
    />
  `;
};
