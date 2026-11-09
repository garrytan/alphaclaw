import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { ConfirmDialog } from "../confirm-dialog.js";
import { showToast } from "../toast.js";
import { setTelegramBlockedSenders } from "../../lib/api.js";
import { formatRelativeTime } from "../../lib/format.js";
import { BriefingSection } from "../relay-tab/parts.js";
import { nextBlockedList, parsePersonInput, personName } from "./model.js";
import { ProblemCard, kFieldClass } from "./parts.js";

const html = htm.bind(h);

// People your agent ignores in every chat. The list is saved whole; adding
// asks first, unblocking is one click.
export const BlockedPeople = ({ blockedSenders = [], owners = [], guard = null, onChanged }) => {
  const [draft, setDraft] = useState({ id: "", label: "" });
  const [inputError, setInputError] = useState("");
  const [pending, setPending] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [problem, setProblem] = useState(null);
  const list = Array.isArray(blockedSenders) ? blockedSenders : [];

  const save = async (next, { id, message }) => {
    setBusyId(id);
    setProblem(null);
    try {
      await setTelegramBlockedSenders(next);
      showToast(message, "success");
      onChanged?.();
      return true;
    } catch (error) {
      setProblem(error.problem || { title: error.message });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const ask = (event) => {
    event.preventDefault();
    const parsed = parsePersonInput({ ...draft, owners });
    if (parsed.error) {
      setInputError(parsed.error);
      return;
    }
    setInputError("");
    setPending(parsed.person);
  };

  const confirm = async () => {
    const person = pending;
    const ok = await save(nextBlockedList(list, { add: person }), { id: person.id, message: "Blocked " + personName(person) });
    setPending(null);
    if (ok) setDraft({ id: "", label: "" });
  };

  return html`
    <${BriefingSection}
      id="groups-blocked-people-title"
      title="Blocked people"
      caption="Your agent ignores these people in every group and chat. You are always heard and can never be blocked."
    >
      ${list.length
        ? html`<ul class="relay-rows">
            ${list.map(
              (person) => html`
                <li class="relay-row" key=${person.id}>
                  <span class="text-bright">${personName(person)}</span>
                  ${person.label ? html`<code class="font-mono text-fg-muted">${person.id}</code>` : null}
                  <span class="relay-row-meta">
                    ${person.blockedAt
                      ? html`<span title=${person.blockedAt}>blocked ${formatRelativeTime(person.blockedAt, { style: "compact" })}</span>`
                      : null}
                    <${ActionButton}
                      tone="secondary"
                      size="sm"
                      loading=${busyId === String(person.id)}
                      disabled=${Boolean(busyId)}
                      idleLabel="Unblock"
                      loadingLabel="Saving…"
                      ariaLabel=${"Unblock " + personName(person)}
                      onClick=${() => save(nextBlockedList(list, { removeId: person.id }), { id: String(person.id), message: "Unblocked " + personName(person) })}
                    />
                  </span>
                </li>
              `,
            )}
          </ul>`
        : html`<p class="text-sm text-fg-muted">Nobody is blocked.</p>`}
      <form class="groups-form" onsubmit=${ask}>
        <input
          class=${kFieldClass + " font-mono w-40"}
          inputmode="numeric"
          placeholder="Telegram user id"
          aria-label="Telegram user id to block"
          value=${draft.id}
          oninput=${(event) => setDraft({ ...draft, id: event.target.value })}
        />
        <input
          class=${kFieldClass + " flex-1 min-w-[8rem] max-w-xs"}
          placeholder="Name (optional)"
          maxlength="120"
          aria-label="Name of the person to block"
          value=${draft.label}
          oninput=${(event) => setDraft({ ...draft, label: event.target.value })}
        />
        <${ActionButton} type="submit" tone="secondary" size="sm" idleLabel="Block person" />
      </form>
      ${inputError ? html`<p class="text-sm text-tone-bad" role="alert">${inputError}</p>` : null}
      ${problem ? html`<${ProblemCard} problem=${problem} />` : null}
      <${ConfirmDialog}
        visible=${Boolean(pending)}
        title=${pending ? "Block " + personName(pending) + "?" : ""}
        message=${pending
          ? "Your agent ignores " + personName(pending) + " (Telegram user " + pending.id + ") in every group and chat until you unblock them here."
          : ""}
        details=${guard ? html`<p class="text-sm text-tone-warn">${guard.title}: ${guard.reason} The block is saved, but it applies only once the group guard runs.</p>` : null}
        confirmLabel="Block person"
        confirmLoadingLabel="Blocking…"
        confirmTone="danger"
        confirmLoading=${Boolean(busyId)}
        onConfirm=${confirm}
        onCancel=${() => setPending(null)}
      />
    </${BriefingSection}>
  `;
};
