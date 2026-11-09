import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { SegmentedControl } from "../segmented-control.js";
import { showToast } from "../toast.js";
import { setTelegramGroupPolicy } from "../../lib/api.js";
import { formatRelativeTime } from "../../lib/format.js";
import {
  buildPolicyBody,
  describeRules,
  describeTopicOverride,
  groupName,
  kModeOptions,
  parsePersonInput,
  personName,
  removeTrusted,
  sectionIdForGroup,
  setTrustedScope,
  upsertTrusted,
} from "./model.js";
import { ProblemCard, RuleLines, kFieldClass } from "./parts.js";
import { GroupTestPanel } from "./test-panel.js";
import { GroupWarnings } from "./warnings.js";

const html = htm.bind(h);

const kScopeOptions = [
  { value: "actions", label: "Actions", title: "Can talk and make your agent use tools" },
  { value: "conversation", label: "Conversation", title: "Can talk; no tools" },
];

const when = (iso) => html`<span title=${iso}>${formatRelativeTime(iso, { style: "compact" })}</span>`;

const TrustedPeople = ({ group, owners, saving, onSave }) => {
  const approved = group.mode === "approved";
  const [draft, setDraft] = useState({ id: "", label: "", scope: approved ? "actions" : "conversation" });
  const [inputError, setInputError] = useState("");
  const trusted = Array.isArray(group.trusted) ? group.trusted : [];
  const add = (event) => {
    event.preventDefault();
    const parsed = parsePersonInput({ id: draft.id, label: draft.label, owners });
    if (parsed.error) {
      setInputError(parsed.error);
      return;
    }
    setInputError("");
    onSave(upsertTrusted(trusted, { ...parsed.person, scope: draft.scope }), "Added " + personName(parsed.person)).then((ok) => {
      if (ok) setDraft({ id: "", label: "", scope: draft.scope });
    });
  };
  return html`
    <div class="groups-people">
      <p class="groups-subtitle">Trusted people</p>
      <p class="text-sm text-fg-muted">
        ${approved
          ? "Everyone here can talk to your agent. People trusted with actions can also make it use tools."
          : "Only you and these people are heard here. Trust someone with actions to let them make your agent use tools."}
      </p>
      ${trusted.length
        ? html`<ul class="groups-chips">
            ${trusted.map(
              (person) => html`
                <li class="groups-chip" key=${person.id}>
                  <span class="groups-chip-name">
                    <span class="text-bright">${personName(person)}</span>
                    ${person.label ? html`<code class="font-mono text-fg-muted">${person.id}</code>` : null}
                  </span>
                  <${SegmentedControl}
                    options=${kScopeOptions}
                    value=${person.scope}
                    disabled=${saving}
                    onChange=${(scope) =>
                      scope !== person.scope &&
                      onSave(setTrustedScope(trusted, person.id, scope), personName(person) + (scope === "actions" ? " can now use tools" : " can now only talk"))}
                  />
                  <button
                    type="button"
                    class="relay-row-action"
                    disabled=${saving}
                    aria-label=${"Remove " + personName(person)}
                    onclick=${() => onSave(removeTrusted(trusted, person.id), "Removed " + personName(person))}
                  >
                    Remove
                  </button>
                </li>
              `,
            )}
          </ul>`
        : html`<p class="text-sm text-fg-muted">Nobody yet. You are always heard and can use every tool.</p>`}
      <form class="groups-form" onsubmit=${add}>
        <input
          class=${kFieldClass + " font-mono w-40"}
          inputmode="numeric"
          placeholder="Telegram user id"
          aria-label=${"Telegram user id to trust in " + groupName(group)}
          value=${draft.id}
          oninput=${(event) => setDraft({ ...draft, id: event.target.value })}
        />
        <input
          class=${kFieldClass + " flex-1 min-w-[8rem] max-w-xs"}
          placeholder="Name (optional)"
          maxlength="120"
          aria-label="Name"
          value=${draft.label}
          oninput=${(event) => setDraft({ ...draft, label: event.target.value })}
        />
        <${SegmentedControl} options=${kScopeOptions} value=${draft.scope} onChange=${(scope) => setDraft({ ...draft, scope })} />
        <${ActionButton} type="submit" tone="secondary" size="sm" loading=${saving} idleLabel="Add person" loadingLabel="Saving…" />
      </form>
      ${inputError ? html`<p class="text-sm text-tone-bad" role="alert">${inputError}</p>` : null}
    </div>
  `;
};

const RowFacts = ({ group }) => {
  const facts = [];
  if (group.mode === "waiting") {
    facts.push(html`<p>Added ${group.seen?.lastJoinAt ? when(group.seen.lastJoinAt) : "recently"}. Your agent stays silent here until you pick a rule.</p>`);
  }
  if (group.mode === "blocked") {
    if (group.leaveError) {
      facts.push(html`<p class="text-tone-bad">Your agent could not leave: ${group.leaveError}</p>`);
    } else if (group.lastLeftAt) {
      facts.push(html`<p>Left ${when(group.lastLeftAt)}.</p>`);
    }
  }
  if (group.pendingBlockAt && group.mode !== "blocked") {
    facts.push(html`<p class="text-tone-warn">A block started ${when(group.pendingBlockAt)} was not fully saved. AlphaClaw's group guard already ignores this group; pick Blocked again to finish it.</p>`);
  }
  return facts.length ? html`<div class="groups-row-facts">${facts}</div>` : null;
};

// One group: its mode control, what the mode means here, trusted people,
// topic overrides, warnings and the test panel.
export const GroupRow = ({ group, owners = [], accountId, onChangeMode, onChanged }) => {
  const [testOpen, setTestOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState(null);
  const custom = sectionIdForGroup(group) === "custom";
  const name = groupName(group);

  const save = async ({ mode = group.mode, trusted, message }) => {
    setSaving(true);
    setProblem(null);
    try {
      await setTelegramGroupPolicy(group.groupId, buildPolicyBody({ group, mode, trusted }), { revision: group.revision, accountId });
      showToast(message, "success");
      onChanged?.();
      return true;
    } catch (error) {
      setProblem(error.problem || { title: error.message });
      onChanged?.();
      return false;
    } finally {
      setSaving(false);
    }
  };

  const topicOverrides = (group.topicOverrides || []).map(describeTopicOverride);
  return html`
    <li class="groups-row" key=${group.groupId}>
      <div class="groups-row-head">
        <div class="groups-row-name">
          <span class="groups-row-title">${name}</span>
          ${group.title ? html`<code class="font-mono text-fg-muted">${group.groupId}</code>` : null}
          ${custom ? html`<${Badge} tone="warn">Custom</${Badge}>` : null}
        </div>
        <div class="relay-row-meta">
          ${typeof group.requireMention === "boolean" ? html`<span>${group.requireMention ? "replies when mentioned" : "replies without a mention"}</span>` : null}
          ${group.updatedAt ? html`<span>changed ${when(group.updatedAt)}</span>` : null}
        </div>
      </div>
      <div class="groups-row-control">
        ${custom ? html`<span class="text-sm text-fg-muted">Replace with</span>` : null}
        <${SegmentedControl}
          options=${kModeOptions}
          value=${custom || group.mode === "waiting" ? null : group.mode}
          disabled=${saving}
          onChange=${(mode) => (custom || mode !== group.mode) && onChangeMode(group, mode)}
        />
      </div>
      <${RowFacts} group=${group} />
      ${group.mode === "blocked" && group.leaveError
        ? html`<div>
            <${ActionButton}
              tone="secondary"
              size="sm"
              loading=${saving}
              idleLabel="Try leaving again"
              loadingLabel="Leaving…"
              onClick=${() => save({ mode: "blocked", message: "Your agent left " + name })}
            />
          </div>`
        : null}
      ${custom
        ? html`<div class="groups-people">
            <p class="groups-subtitle">Current rules in openclaw.json</p>
            <${RuleLines} lines=${describeRules(group.rules)} empty="No rules this page manages" />
          </div>`
        : null}
      ${group.mode === "approved" || group.mode === "trusted"
        ? html`<${TrustedPeople}
            group=${group}
            owners=${owners}
            saving=${saving}
            onSave=${(trusted, message) => save({ trusted, message })}
          />`
        : null}
      ${topicOverrides.length
        ? html`<div class="groups-people">
            <p class="groups-subtitle">Topic overrides</p>
            <p class="text-sm text-fg-muted">These forum topics set their own rules on who may talk. Approving the group or changing its trusted people needs them removed first, so the group's mode applies to every topic.</p>
            <ul class="groups-topics">
              ${topicOverrides.map(
                (topic) => html`<li key=${topic.threadId}><span class="text-fg-muted">Topic</span> <code class="font-mono">${topic.threadId}</code> <span class="font-mono text-fg-muted">${topic.settings}</span></li>`,
              )}
            </ul>
          </div>`
        : null}
      <${GroupWarnings} warnings=${group.warnings} />
      ${problem ? html`<${ProblemCard} problem=${problem} action=${group.mode} />` : null}
      ${problem?.code === "topic_override"
        ? html`<div>
            <${ActionButton}
              tone="secondary"
              size="sm"
              idleLabel="Preview removing the topic overrides"
              onClick=${() => onChangeMode(group, group.mode)}
            />
          </div>`
        : null}
      <div>
        <button type="button" class="relay-log-toggle" aria-expanded=${testOpen ? "true" : "false"} onclick=${() => setTestOpen(!testOpen)}>
          Test this group
        </button>
      </div>
      ${testOpen ? html`<${GroupTestPanel} group=${group} accountId=${accountId} />` : null}
    </li>
  `;
};
