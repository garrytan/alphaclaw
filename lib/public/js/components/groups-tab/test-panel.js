import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { testTelegramGroup } from "../../lib/api.js";
import { StatusDot, ToneWord } from "../relay-tab/parts.js";
import { describeGroupGuard, describeSender } from "./model.js";
import { ProblemCard, kFieldClass } from "./parts.js";

const html = htm.bind(h);

const SenderVerdict = ({ sender, notModelled }) => {
  const view = describeSender(sender, { notModelled });
  return html`
    <li class="groups-verdict">
      <div class="groups-verdict-head">
        ${view.name ? html`<span class="text-bright">${view.name}</span>` : null}
        ${view.id ? html`<code class=${"font-mono " + (view.name ? "text-fg-muted" : "text-bright")}>${view.id}</code>` : null}
        ${view.roles.map((role) => html`<${Badge} key=${role} tone="neutral">${role}</${Badge}>`)}
        <span class="groups-verdict-outcome">
          <${StatusDot} tone=${view.reply.tone} />
          <${ToneWord} tone=${view.reply.tone}>${view.reply.word}</${ToneWord}>
          ${view.reply.detail ? html`<span>${view.reply.detail}</span>` : null}
          ${view.actions ? html`<span class="text-fg-muted">· ${view.actions}</span>` : null}
        </span>
      </div>
      ${view.reason ? html`<p class=${"groups-verdict-reason" + (view.guardSkipped ? " text-tone-warn" : "")}>${view.reason}</p>` : null}
      <details class="groups-layers">
        <summary>How this was decided</summary>
        <p class="groups-layers-label">Checked against OpenClaw's own rules</p>
        <ol class="groups-layer-list">
          ${view.modelled.map(
            (layer, index) => html`
              <li key=${index}>
                <${StatusDot} tone=${layer.tone} />
                <span>${layer.label}</span>
                <span class="text-fg-muted">${layer.verdict}</span>
                ${layer.detail ? html`<span class="text-fg-muted">· ${layer.detail}</span>` : null}
              </li>
            `,
          )}
        </ol>
        ${view.notModelled.length
          ? html`<p class="groups-layers-label">Not checked</p>
              <p class="text-sm text-fg-muted">
                Other plugins on this box can still refuse a turn:
                ${view.notModelled.map((plugin, index) => html`${index ? ", " : " "}<code class="font-mono">${plugin}</code>`)}.
              </p>`
          : null}
      </details>
    </li>
  `;
};

// "Test this group": what your agent would do with a message from each
// person the rules name, plus anyone else, from OpenClaw's own resolvers.
export const GroupTestPanel = ({ group, accountId }) => {
  const [extra, setExtra] = useState("");
  const [result, setResult] = useState(null);
  const [problem, setProblem] = useState(null);
  const [running, setRunning] = useState(false);

  const run = async (event) => {
    event?.preventDefault?.();
    const senderIds = extra.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
    const bad = senderIds.find((value) => !/^\d{1,20}$/.test(value));
    if (bad) {
      setProblem({ title: "\"" + bad + "\" is not a Telegram user id", fix: "Use numeric user ids, separated by commas." });
      return;
    }
    setRunning(true);
    setProblem(null);
    try {
      setResult(await testTelegramGroup(group.groupId, { senderIds, accountId }));
    } catch (error) {
      setProblem(error.problem || { title: error.message });
    } finally {
      setRunning(false);
    }
  };

  const guard = describeGroupGuard(result?.groupGuard);
  return html`
    <div class="groups-test">
      <form class="groups-form" onsubmit=${run}>
        <input
          class=${kFieldClass + " font-mono flex-1 min-w-[12rem]"}
          inputmode="numeric"
          placeholder="Also test user ids (optional)"
          aria-label=${"Telegram user ids to test in " + (group.title || group.groupId)}
          value=${extra}
          oninput=${(event) => setExtra(event.target.value)}
        />
        <${ActionButton} type="submit" tone="secondary" size="sm" loading=${running} idleLabel="Run test" loadingLabel="Testing…" />
      </form>
      ${problem ? html`<${ProblemCard} problem=${problem} />` : null}
      ${result
        ? html`
            ${guard ? html`<p class="text-sm text-tone-warn">${guard.title}: ${guard.reason}</p>` : null}
            <p class="text-sm text-fg-muted">
              ${result.requireMention ? "Your agent replies here only when mentioned." : "Your agent can reply here without being mentioned."}
            </p>
            <ul class="groups-verdicts">
              ${(result.senders || []).map(
                (sender, index) => html`<${SenderVerdict} key=${sender.id || "anyone-" + index} sender=${sender} notModelled=${result.notModelled} />`,
              )}
            </ul>
          `
        : null}
    </div>
  `;
};
