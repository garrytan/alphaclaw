import { h } from "preact";
import htm from "htm";
import { ActionButton } from "./action-button.js";
import { useGatewayRecovery } from "../hooks/use-gateway-recovery.js";
import { formatLocaleDateTime } from "../lib/format.js";

const html = htm.bind(h);
const helpUrl = (ref) => `https://github.com/garrytan/alphaclaw/blob/main/${ref || "README.md"}`;

export const GatewayRecoveryOptions = ({ shell = {}, serverState = null, setupRequired = false, onRestart = null, onRefresh = null, progress = null }) => {
  const recovery = useGatewayRecovery({ shell, serverState, onRestart, onRefresh });
  const { selected, descriptor, outcome, evidence } = recovery;
  const current = evidence?.summary?.recovery;
  const findings = evidence?.sections?.stateDb?.data?.findings || [];
  const nextAction = outcome?.recovery?.nextAction || descriptor?.nextAction;
  const stopped = descriptor?.stopped;
  const label = selected === "repair" ? descriptor?.paused ? "Resume repair once" : "Run Doctor repair" : stopped ? "Start gateway" : "Restart gateway";
  const navigate = (target) => { window.location.hash = `/${target}`; };
  return html`
    <div class="ac-gateway-recovery">
      <div class="ac-gateway-recovery-actions">
        ${["repair", "restart"].map((id) => html`<${ActionButton} key=${id} idleLabel=${id === "repair" ? "Repair" : "Restart"} size="lg" tone=${serverState?.actions?.find((a) => a.id === id)?.kind === "primary" ? "primary" : "secondary"} className="ac-recovery-control" onClick=${(event) => recovery.open(id, event)} />`)}
      </div>
      ${progress}
      ${selected ? html`
        <section class="ac-recovery-options" aria-label=${`${selected === "repair" ? "Repair" : "Restart"} options`} aria-busy=${recovery.checking} onKeyDown=${(event) => { if (event.key === "Escape") { event.stopPropagation(); recovery.close(); } }}>
          <h3 ref=${recovery.headingRef} tabIndex="-1">${selected === "repair" ? "Repair" : "Restart"} options</h3>
          <p>${selected === "repair" ? "Doctor repair may change supported configuration and relaunch the gateway." : "Restart relaunches the installed build without running Doctor."}</p>
          ${setupRequired ? html`<p>Complete the setup prerequisites below before a gateway repair or restart. Opening these options does not queue an attempt.</p>` : recovery.frozen ? html`<p>Status is not current. Reconnect or sign in to AlphaClaw and refresh status before confirming a new attempt. No request is queued.</p>` : null}
          ${descriptor?.reason && descriptor.reason !== nextAction?.description ? html`<p>${descriptor.reason}</p>` : null}
          ${recovery.operationActive ? html`<p>Viewing the existing operation. No new repair or restart was started. Wait for its result, then deliberately try again.</p>` : null}
          ${descriptor?.paused && !descriptor?.resolution ? html`<p>Automatic repair is paused or off. Resume repair once requests one admitted Doctor attempt; it does not enable automatic repair.</p>` : null}
          ${descriptor?.additionalReasons?.length ? html`<details><summary>Other recovery constraints (${descriptor.additionalReasons.length})</summary>${descriptor.additionalReasons.map((reason) => html`<p>${reason.description}</p>`)}</details>` : null}
          ${nextAction ? html`<p>${nextAction.description} <a href=${helpUrl(nextAction.helpRef)} target="_blank" rel="noopener noreferrer">Recovery instructions</a></p>` : null}
          ${outcome ? html`<p role=${["not_started", "failed", "unknown"].includes(outcome.kind) ? "alert" : "status"}>${outcome.message}${outcome.hint ? ` ${outcome.hint}` : ""}</p>` : null}
          <div class="ac-recovery-options-actions">
            <${ActionButton} idleLabel="Refresh status" size="lg" tone="secondary" className="ac-recovery-control" onClick=${recovery.refresh} />
            <${ActionButton} idleLabel=${recovery.checking ? "Checking…" : "Check again"} size="lg" tone="secondary" className="ac-recovery-control" onClick=${recovery.check} />
            ${!serverState || descriptor?.resolution === "setup" ? html`<${ActionButton} idleLabel="Complete setup" size="lg" className="ac-recovery-control" onClick=${() => shell.actions?.openSetup?.()} />` : null}
            <${ActionButton} idleLabel="Open human recovery tools" size="lg" tone="secondary" className="ac-recovery-control" onClick=${() => navigate("watchdog")} />
            ${recovery.canExecute && !recovery.confirmation ? html`<${ActionButton} idleLabel=${label} size="lg" className="ac-recovery-control" disabled=${recovery.submitting || outcome?.kind === "unknown"} onClick=${recovery.confirm} />` : null}
          </div>
          ${recovery.confirmation ? html`<div><p>${label}? This can interrupt active gateway work. AlphaClaw will check admission again before executing.</p><${ActionButton} idleLabel=${`Confirm ${label.toLowerCase()}`} size="lg" className="ac-recovery-control" disabled=${recovery.confirmation.submitted} loading=${recovery.submitting} onClick=${recovery.submit} /></div>` : null}
          ${current ? html`<div><h4>Current assessment</h4><p>${formatLocaleDateTime(current.observedAt, { fallback: "Time unavailable" })}: ${current.assessment}; ${current.databaseVerdict ? `databases ${current.databaseVerdict}; ` : ""}gateway ${String(current.gatewayReadiness || "unknown").replaceAll("_", " ")}.</p>${current.nextActions?.map((action) => html`<p>${action.description} <a href=${helpUrl(action.helpRef)} target="_blank" rel="noopener noreferrer">${action.label}</a></p>`)}</div>` : null}
          ${findings.length ? html`<details><summary>Database findings (${findings.length})</summary>${findings.map((finding) => html`<div><p><code>${finding.path || "Path unavailable"}</code>: ${finding.problem || finding.reason || finding.code}${finding.cause ? ` — ${finding.cause}` : ""}</p>${finding.nextAction ? html`<p>${finding.nextAction.description} <a href=${helpUrl(finding.helpRef || finding.nextAction.helpRef)} target="_blank" rel="noopener noreferrer">${finding.nextAction.label}</a></p>` : null}</div>`)}</details>` : null}
          ${evidence?.sections?.stateDb?.data?.excludedArtifacts?.length ? html`<details><summary>Excluded temporary artifacts</summary>${evidence.sections.stateDb.data.excludedArtifacts.map((entry) => html`<p><code>${entry.path}</code>: ${entry.reason}. File left untouched.</p>`)}</details>` : null}
          <${ActionButton} idleLabel="Close options" size="lg" tone="secondary" className="ac-recovery-control" onClick=${recovery.close} />
        </section>
      ` : null}
    </div>
  `;
};
