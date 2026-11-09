import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { EmptyState } from "../empty-state.js";
import { RoutePageHeader } from "../page-header.js";
import { BriefingSection, FactRow, StatusDot, ToneWord } from "../relay-tab/parts.js";
import { BlockedPeople } from "./blocked-people.js";
import { GroupRow } from "./group-row.js";
import { ModeChangeDialog } from "./mode-change-dialog.js";
import {
  buildGroupsHeadline,
  countByMode,
  describeGroupGuard,
  describeRulesUnreadable,
  sortGroupsIntoSections,
} from "./model.js";
import { ProblemCard } from "./parts.js";
import { useGroupsTab } from "./use-groups-tab.js";

const html = htm.bind(h);

const RulesUnreadable = ({ problem, onReload }) => {
  const view = describeRulesUnreadable(problem);
  return html`
    <section class="groups-problem" role="alert" aria-labelledby="groups-unreadable-title">
      <p class="groups-problem-title" id="groups-unreadable-title">
        <${StatusDot} tone="bad" />
        <${ToneWord} tone="bad">${view.title}</${ToneWord}>
      </p>
      <p>Nothing can be saved, and the block list is left as it is, until telegram/group-rules.json under AlphaClaw's root is fixed or moved aside.</p>
      ${view.detail ? html`<p class="groups-problem-detail font-mono">${view.detail}</p>` : null}
      <ol class="groups-steps">
        ${view.steps.map((step, index) => html`<li key=${index}>${step}</li>`)}
      </ol>
      <div><${ActionButton} tone="secondary" size="sm" idleLabel="Reload" onClick=${onReload} /></div>
    </section>
  `;
};

const GuardBanner = ({ guard }) => html`
  <div class="groups-problem groups-banner" role="status">
    <p class="groups-problem-title">
      <${StatusDot} tone="warn" />
      <${ToneWord} tone="warn">${guard.title}</${ToneWord}>
    </p>
    <p>${guard.reason} ${guard.effect}</p>
  </div>
`;

const kCountOrder = ["waiting", "custom", "approved", "trusted", "silent", "blocked"];
const kCountLabels = { waiting: "waiting for you", custom: "custom", approved: "approved", trusted: "trusted only", silent: "silent", blocked: "blocked" };

// The Groups page (GST-1975 PR 2): every Telegram group your agent was added
// to, sorted by its rule, with the people blocked everywhere at the foot.
export const GroupsTab = ({ accountId = "default" }) => {
  const { data, error, refresh } = useGroupsTab({ accountId });
  const [change, setChange] = useState(null);
  const problem = error ? error.problem || { title: String(error.message || error), status: error.status } : null;
  const unreadable = problem?.code === "rules_unreadable";
  const shown = unreadable ? null : data;
  const configured = shown?.configured !== false;
  const sections = shown && configured ? sortGroupsIntoSections(shown.groups) : [];
  const guard = configured ? describeGroupGuard(shown?.groupGuard) : null;
  const owners = Array.isArray(shown?.owners) ? shown.owners : [];
  const counts = countByMode(shown?.groups);
  const countLine = kCountOrder
    .filter((id) => counts[id])
    .map((id) => counts[id] + " " + kCountLabels[id])
    .join(" · ");

  return html`
    <div class="groups briefing">
      <${RoutePageHeader}
        routeId="groups"
        actions=${html`<${ActionButton} onClick=${() => refresh()} tone="subtle" size="md" idleLabel="Refresh" />`}
      />
      <div class="relay-lead">
        <p class="briefing-headline">${buildGroupsHeadline({ data: shown, problem })}</p>
        <ul class="relay-facts">
          ${shown && configured && countLine ? html`<${FactRow} tone="neutral" word=${countLine} />` : null}
          ${shown && configured
            ? owners.length
              ? html`<${FactRow} tone="ok" word=${owners.length === 1 ? "Owner" : "Owners"}>
                  Always heard with every tool, in every group:
                  ${owners.map((id, index) => html`${index ? ", " : " "}<code class="font-mono">${id}</code>`)}
                </${FactRow}>`
              : html`<${FactRow} tone="warn" word="No owner id">
                  No owner Telegram id is known, so no rule can be saved. Set commands.ownerAllowFrom (or the bot's DM allowFrom) in openclaw.json to your Telegram user id.
                </${FactRow}>`
            : null}
          ${shown && configured && shown.accountPolicy !== "allowlist"
            ? html`<${FactRow} tone="warn" word="Groups are not on an allowlist">
                The bot's groupPolicy is ${JSON.stringify(shown.accountPolicy ?? null)}, so groups without a rule are admitted and no rule can be saved. Set groupPolicy to "allowlist" for this bot in openclaw.json.
              </${FactRow}>`
            : null}
        </ul>
      </div>
      ${unreadable ? html`<${RulesUnreadable} problem=${problem} onReload=${() => refresh()} />` : null}
      ${problem && !unreadable ? html`<${ProblemCard} problem=${problem} />` : null}
      ${guard ? html`<${GuardBanner} guard=${guard} />` : null}
      ${shown && !configured
        ? html`<${EmptyState}
            title="Telegram is not set up"
            body="Connect a Telegram bot on the Channels page, then add it to a group."
            action=${html`<a class="text-accent-link" href="#/channels">Open Channels</a>`}
          />`
        : null}
      ${shown && configured && !sections.length
        ? html`<${EmptyState}
            title="No groups yet"
            body="Add your bot to a Telegram group. It stays silent there and the group shows up here, waiting for you to pick a rule."
          />`
        : null}
      ${sections.map(
        (section) => html`
          <${BriefingSection} key=${section.id} id=${"groups-" + section.id + "-title"} title=${section.title + " (" + section.groups.length + ")"} caption=${section.caption}>
            <ul class="groups-list">
              ${section.groups.map(
                (group) => html`<${GroupRow}
                  key=${group.groupId}
                  group=${group}
                  owners=${owners}
                  accountId=${accountId}
                  onChangeMode=${(target, mode) => setChange({ group: target, mode })}
                  onChanged=${() => refresh()}
                />`,
              )}
            </ul>
          </${BriefingSection}>
        `,
      )}
      ${shown && configured
        ? html`<${BlockedPeople} blockedSenders=${shown.blockedSenders} owners=${owners} guard=${guard} onChanged=${() => refresh()} />`
        : null}
      ${change
        ? html`<${ModeChangeDialog}
            group=${change.group}
            mode=${change.mode}
            accountId=${accountId}
            onClose=${() => setChange(null)}
            onSaved=${() => refresh()}
          />`
        : null}
    </div>
  `;
};
