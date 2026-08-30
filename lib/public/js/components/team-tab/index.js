import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { PageHeader } from "../page-header.js";
import { LoadingSpinner } from "../loading-spinner.js";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { ConfirmDialog } from "../confirm-dialog.js";
import { DevicePairings } from "../device-pairings.js";
import { showToast } from "../toast.js";
import { useTeamTab } from "./use-team-tab.js";
import { TeamEnableWizard } from "./enable-wizard.js";
import { formatLocaleDate, formatRelativeTime } from "../../lib/format.js";

const html = htm.bind(h);

const kInputClass =
  "w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted";

const UpsellCard = ({ onSwitchTab = () => {} }) => html`
  <div class="bg-surface border border-border rounded-xl p-4 space-y-2">
    <h2 class="card-label">Team access</h2>
    <p class="text-sm text-body">
      Share this AlphaClaw with named teammates — each person gets their own
      login, their identity carries into OpenClaw, and messages are attributed.
    </p>
    <p class="text-sm text-fg-muted">
      Team access needs OpenClaw 2026.8 or newer. Your installed version
      doesn't support it yet — switch to the beta channel to try it.
    </p>
    <div class="pt-1">
      <${ActionButton}
        onClick=${() => onSwitchTab("upgrade")}
        tone="primary"
        idleLabel="Open the Upgrade page"
      />
    </div>
  </div>
`;

const IntroCard = ({ onStart = () => {} }) => html`
  <div class="bg-surface border border-border rounded-xl p-4 space-y-2">
    <h2 class="card-label">Team access</h2>
    <p class="text-sm text-body">
      Share this AlphaClaw with named teammates. Everyone signs in with their
      own account; OpenClaw sees who's who — attributed messages, per-person
      profiles, who's online.
    </p>
    <p class="text-sm text-fg-muted">
      Members can chat and view status. They cannot manage updates, secrets,
      terminals, agents, or team access.
    </p>
    <div class="pt-1">
      <${ActionButton}
        onClick=${onStart}
        tone="primary"
        idleLabel="Set up team access"
      />
    </div>
  </div>
`;

const MembersCard = ({
  members = [],
  me = null,
  busyMemberId = null,
  onUpdateMember = () => {},
  onRequestDisable = () => {},
  onRequestRemove = () => {},
}) => {
  const activeAdmins = members.filter(
    (member) => member.role === "admin" && !member.disabled,
  );
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3 lg:col-span-8">
      <div class="flex items-center justify-between gap-2">
        <h2 class="card-label">Members</h2>
        <span class="text-xs text-fg-muted">${members.length} total</span>
      </div>
      <p class="text-xs text-fg-muted">
        Members can chat and view status. They cannot manage updates, secrets,
        terminals, agents, or team access.
      </p>
      <ul class="divide-y divide-border">
        ${members.map((member) => {
          const isLastAdmin =
            member.role === "admin" &&
            !member.disabled &&
            activeAdmins.length <= 1;
          const busy = busyMemberId === member.id;
          return html`
            <li
              key=${member.id}
              class="py-2.5 flex flex-wrap items-center justify-between gap-2 min-h-[44px]"
            >
              <div class="min-w-0">
                <div class="text-sm text-body truncate">
                  ${member.displayName || member.email}
                  ${me?.email === member.email
                    ? html` <span class="text-xs text-fg-muted">(you)</span>`
                    : null}
                </div>
                <div class="text-xs text-fg-muted font-mono truncate">
                  ${member.email}
                </div>
              </div>
              <div class="flex items-center gap-2">
                ${member.disabled
                  ? html`<${Badge} tone="warning">Disabled</${Badge}>`
                  : null}
                <select
                  class="bg-field border border-border rounded-lg px-2 py-1 text-xs text-body"
                  value=${member.role}
                  disabled=${busy || isLastAdmin}
                  title=${isLastAdmin
                    ? "The last active admin cannot be demoted."
                    : "Member permissions"}
                  onChange=${(e) =>
                    onUpdateMember(member.id, { role: e.target.value })}
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                </select>
                ${member.disabled
                  ? html`<${ActionButton}
                      onClick=${() =>
                        onUpdateMember(member.id, { disabled: false })}
                      tone="subtle"
                      idleLabel="Re-enable"
                      loading=${busy}
                      loadingLabel="Working..."
                    />`
                  : html`<${ActionButton}
                      onClick=${() => onRequestDisable(member)}
                      tone="subtle"
                      idleLabel="Disable"
                      disabled=${busy || isLastAdmin}
                    />`}
                <${ActionButton}
                  onClick=${() => onRequestRemove(member)}
                  tone="warning"
                  idleLabel="Remove"
                  disabled=${busy || isLastAdmin}
                />
              </div>
            </li>
          `;
        })}
      </ul>
    </div>
  `;
};

const InvitesCard = ({
  invites = [],
  freshInvite = null,
  creatingInvite = false,
  onCreateInvite = () => {},
  onRevokeInvite = () => {},
  onDismissFreshInvite = () => {},
}) => {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <h2 class="card-label">Invites</h2>
      <p class="text-xs text-fg-muted">
        An invite creates AlphaClaw access. Device approval (its own queue
        above, when pending) authorizes a browser or client inside OpenClaw —
        two different things.
      </p>
      <div class="space-y-2">
        <input
          type="email"
          class=${kInputClass}
          value=${email}
          onInput=${(e) => setEmail(e.target.value)}
          placeholder="Email (optional — pins the invite)"
        />
        <div class="flex items-center gap-2">
          <select
            class="bg-field border border-border rounded-lg px-2 py-1.5 text-sm text-body"
            value=${role}
            onChange=${(e) => setRole(e.target.value)}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <${ActionButton}
            onClick=${() => {
              onCreateInvite({ email: email.trim(), role });
              setEmail("");
            }}
            tone="primary"
            idleLabel="Create invite"
            loadingLabel="Creating..."
            loading=${creatingInvite}
          />
        </div>
      </div>
      ${freshInvite
        ? html`
            <div class="ac-surface-inset border border-green-500/35 rounded-lg p-3 space-y-2">
              <p class="text-xs text-body">
                Share this link now — it's shown only once and expires in 7
                days:
              </p>
              <div class="flex items-center gap-2">
                <code
                  class="text-xs bg-field rounded px-2 py-1 break-all flex-1"
                  >${freshInvite.url}</code
                >
                <${ActionButton}
                  onClick=${async () => {
                    try {
                      await navigator.clipboard.writeText(freshInvite.url);
                      showToast("Invite link copied", "success");
                    } catch {
                      showToast("Could not copy — select the link text", "error");
                    }
                  }}
                  tone="subtle"
                  idleLabel="Copy"
                />
              </div>
              <button
                type="button"
                class="text-xs text-fg-muted hover:text-body"
                onclick=${onDismissFreshInvite}
              >
                Dismiss
              </button>
            </div>
          `
        : null}
      ${invites.length === 0
        ? html`<p class="text-sm text-fg-muted">
            No open invites. Create one to bring a teammate in.
          </p>`
        : html`
            <ul class="divide-y divide-border">
              ${invites.map(
                (invite) => html`
                  <li
                    key=${invite.id}
                    class="py-2 flex items-center justify-between gap-2"
                  >
                    <div class="min-w-0">
                      <div class="text-sm text-body truncate">
                        ${invite.email || "Anyone with the link"}
                      </div>
                      <div class="text-xs text-fg-muted">
                        ${invite.role} · expires${" "}
                        ${formatLocaleDate(invite.expiresAt, {
                          valueIsEpochMs: true,
                        })}
                      </div>
                    </div>
                    <${ActionButton}
                      onClick=${() => onRevokeInvite(invite.id)}
                      tone="subtle"
                      idleLabel="Revoke"
                    />
                  </li>
                `,
              )}
            </ul>
          `}
    </div>
  `;
};

const PresenceCard = ({ presence = [], presenceUnavailable = false }) => html`
  <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
    <h2 class="card-label">Who's online</h2>
    ${presenceUnavailable
      ? html`<p class="text-sm text-status-warning-muted">
          Presence unavailable — could not reach the server. Retrying
          automatically.
        </p>`
      : presence.length === 0
        ? html`<p class="text-sm text-fg-muted">
            No one online right now. Members appear here while they're active.
          </p>`
        : html`
            <ul class="space-y-1.5">
              ${presence.map(
                (entry) => html`
                  <li key=${entry.email} class="flex items-center gap-2">
                    <span
                      class="w-2 h-2 rounded-full bg-green-500"
                      aria-hidden="true"
                    ></span>
                    <span class="text-sm text-body truncate">
                      ${entry.displayName || entry.email}
                    </span>
                    <span class="text-xs text-fg-muted ml-auto">
                      ${formatRelativeTime(entry.lastSeenAt)}
                    </span>
                  </li>
                `,
              )}
            </ul>
          `}
    <p class="text-xs text-fg-muted">
      Profiles and avatars live in the OpenClaw dashboard (Settings → Profile).
    </p>
  </div>
`;

export const TeamTab = ({
  onRefreshStatuses = () => {},
  onSwitchTab = () => {},
}) => {
  const state = useTeamTab({ onRefreshStatuses });
  const {
    team,
    loading,
    loadError,
    presenceUnavailable,
    wizardOpen,
    setWizardOpen,
    closeWizard,
    enabling,
    enableError,
    enableResult,
    onEnable,
    creatingInvite,
    freshInvite,
    setFreshInvite,
    onCreateInvite,
    onRevokeInvite,
    busyMemberId,
    onUpdateMember,
    onRemoveMember,
    onDisableTeam,
    confirmAction,
    confirmBusy,
    requestConfirm,
    cancelConfirm,
    runConfirm,
    devicePending,
    onApproveDevice,
    onRejectDevice,
    onOpenControlUi,
  } = state;

  const isAdmin = team?.me?.role === "admin";
  const capabilityMissing = team?.capability?.trustedProxyTeam === false;

  return html`
    <div class="space-y-4">
      <${PageHeader} title="Team" />

      ${loading
        ? html`
            <div class="bg-surface border border-border rounded-xl p-4">
              <div class="flex items-center gap-2 text-sm text-fg-muted py-2">
                <${LoadingSpinner} className="h-4 w-4" />
                Loading team status...
              </div>
            </div>
          `
        : null}

      ${loadError && !team
        ? html`
            <div class="bg-surface border border-red-500/40 rounded-xl p-4">
              <p class="text-sm text-status-error">${loadError}</p>
            </div>
          `
        : null}

      ${team && !team.enabled && isAdmin
        ? capabilityMissing
          ? html`<${UpsellCard} onSwitchTab=${onSwitchTab} />`
          : html`<${IntroCard} onStart=${() => setWizardOpen(true)} />`
        : null}

      ${team && !team.enabled && !isAdmin
        ? html`
            <div class="bg-surface border border-border rounded-xl p-4">
              <p class="text-sm text-fg-muted">
                Team access is not enabled on this AlphaClaw.
              </p>
            </div>
          `
        : null}

      ${team?.enabled
        ? html`
            <div class="bg-surface border border-border rounded-xl p-4 space-y-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <h2 class="card-label">Team access</h2>
                  <${Badge} tone="success">ENABLED</${Badge}>
                </div>
                <div class="flex items-center gap-2">
                  <${ActionButton}
                    onClick=${onOpenControlUi}
                    tone="primary"
                    idleLabel="Open Control UI"
                  />
                  ${isAdmin
                    ? html`<${ActionButton}
                        onClick=${() =>
                          requestConfirm({
                            title: "Disable team access?",
                            message:
                              "Every member session ends immediately and the previous gateway login mode is restored (one restart required). Member accounts are kept for later.",
                            confirmLabel: "Disable team access",
                            run: onDisableTeam,
                          })}
                        tone="warning"
                        idleLabel="Disable team access"
                      />`
                    : null}
                </div>
              </div>
              <p class="text-xs text-fg-muted">
                Shared access is a convenience boundary: any process on this
                host can impersonate a member unless the host stays isolated.
              </p>
            </div>

            ${isAdmin && team.identityProbe && team.identityProbe.ok === false
              ? html`
                  <div class="bg-surface border border-red-500/40 rounded-xl p-4 space-y-1">
                    <div class="flex items-center gap-2">
                      <span class="w-2 h-2 rounded-full bg-red-500 shrink-0"></span>
                      <h2 class="card-label">Login identity check failing</h2>
                    </div>
                    <p class="text-sm text-body">
                      The gateway is not accepting the identity AlphaClaw
                      forwards for signed-in members — member requests to
                      OpenClaw will fail until this recovers.
                    </p>
                    <p class="text-xs text-fg-muted">
                      Restart the gateway from the Watchdog page, or disable
                      and re-enable team access to rebuild the login
                      configuration.
                      ${team.identityProbe.error
                        ? html` <span class="text-fg-muted">(${team.identityProbe.error})</span>`
                        : null}
                    </p>
                  </div>
                `
              : null}

            ${isAdmin && devicePending.length > 0
              ? html`
                  <div class="bg-surface border border-yellow-500/35 rounded-xl p-4 space-y-1">
                    <h2 class="card-label">Pending device approvals</h2>
                    <p class="text-xs text-fg-muted">
                      Device approval authorizes a browser or client inside
                      OpenClaw — it is separate from the AlphaClaw invites
                      below.
                    </p>
                    <${DevicePairings}
                      pending=${devicePending}
                      onApprove=${onApproveDevice}
                      onReject=${onRejectDevice}
                    />
                  </div>
                `
              : null}

            <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
              ${isAdmin
                ? html`<${MembersCard}
                    members=${team.members || []}
                    me=${team.me}
                    busyMemberId=${busyMemberId}
                    onUpdateMember=${onUpdateMember}
                    onRequestDisable=${(member) =>
                      requestConfirm({
                        title: `Disable ${member.email}?`,
                        message:
                          "Their sessions end immediately and OpenClaw stops trusting their identity (one restart applies it). You can re-enable them later.",
                        confirmLabel: "Disable member",
                        run: () =>
                          onUpdateMember(member.id, { disabled: true }),
                      })}
                    onRequestRemove=${(member) =>
                      requestConfirm({
                        title: `Remove ${member.email}?`,
                        message:
                          "Their account is deleted, sessions end immediately, and OpenClaw stops trusting their identity (one restart applies it). This cannot be undone.",
                        confirmLabel: "Remove member",
                        run: () => onRemoveMember(member.id),
                      })}
                  />`
                : html`
                    <div class="bg-surface border border-border rounded-xl p-4 lg:col-span-8">
                      <h2 class="card-label">Members</h2>
                      <ul class="mt-2 space-y-1">
                        ${(team.members || []).map(
                          (member) => html`
                            <li key=${member.email} class="text-sm text-body">
                              ${member.displayName || member.email}
                              <span class="text-xs text-fg-muted">
                                · ${member.role}</span
                              >
                            </li>
                          `,
                        )}
                      </ul>
                    </div>
                  `}
              <div class="lg:col-span-4 space-y-4">
                ${isAdmin
                  ? html`<${InvitesCard}
                      invites=${team.invites || []}
                      freshInvite=${freshInvite}
                      creatingInvite=${creatingInvite}
                      onCreateInvite=${onCreateInvite}
                      onRevokeInvite=${onRevokeInvite}
                      onDismissFreshInvite=${() => setFreshInvite(null)}
                    />`
                  : null}
                <${PresenceCard}
                  presence=${team.presence || []}
                  presenceUnavailable=${presenceUnavailable}
                />
              </div>
            </div>
          `
        : null}

      <${TeamEnableWizard}
        visible=${wizardOpen}
        onClose=${closeWizard}
        onEnable=${onEnable}
        enabling=${enabling}
        enableError=${enableError}
        enableResult=${enableResult}
      />

      <${ConfirmDialog}
        visible=${Boolean(confirmAction)}
        title=${confirmAction?.title || ""}
        message=${confirmAction?.message || ""}
        confirmLabel=${confirmAction?.confirmLabel || "Confirm"}
        confirmTone="danger"
        confirmLoading=${confirmBusy}
        onConfirm=${runConfirm}
        onCancel=${cancelConfirm}
      />
    </div>
  `;
};
