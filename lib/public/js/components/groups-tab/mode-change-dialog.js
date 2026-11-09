import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { ConfirmDialog } from "../confirm-dialog.js";
import { showToast } from "../toast.js";
import { setTelegramGroupPolicy } from "../../lib/api.js";
import { buildPolicyBody, confirmCopyForMode, describeRules, groupName, kModeLabels } from "./model.js";
import { ProblemCard, RuleLines } from "./parts.js";
import { GroupWarnings } from "./warnings.js";

const html = htm.bind(h);

// A mode change: OpenClaw checks a dry run first and the dialog shows the
// group's rules before and after, then the real save goes out with the
// revision the preview was made from (If-Match), so a change made meanwhile
// is refused instead of overwritten.
export const ModeChangeDialog = ({ group, mode, accountId, onClose, onSaved }) => {
  const [normalizeTopics, setNormalizeTopics] = useState(false);
  const [preview, setPreview] = useState(null);
  const [problem, setProblem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const copy = confirmCopyForMode({ group, mode });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProblem(null);
    setPreview(null);
    setTelegramGroupPolicy(group.groupId, buildPolicyBody({ group, mode, normalizeTopics, dryRun: true }), { accountId })
      .then((result) => !cancelled && setPreview(result))
      .catch((error) => !cancelled && setProblem(error.problem || { title: error.message }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [group.groupId, mode, normalizeTopics]);

  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      const result = await setTelegramGroupPolicy(group.groupId, buildPolicyBody({ group, mode, normalizeTopics }), {
        revision: preview?.revision || group.revision,
        accountId,
      });
      showToast(groupName(group) + " is now " + kModeLabels[mode] + (result.backup ? ". The old rules are backed up." : "."), "success");
      onSaved?.(result);
      onClose();
    } catch (error) {
      setProblem(error.problem || { title: error.message });
      if (error.problem?.sideEffects === "partial") onSaved?.(null);
    } finally {
      setSaving(false);
    }
  };

  const topicBlocked = problem?.code === "topic_override" && !normalizeTopics;
  const before = describeRules(preview?.preview?.before);
  const after = describeRules(preview?.preview?.after);
  const details = html`
    <div class="groups-dialog-body">
      ${loading ? html`<p class="text-sm text-fg-muted">Checking the change with OpenClaw…</p>` : null}
      ${preview
        ? html`
            <div class="groups-preview">
              <div>
                <p class="groups-preview-label">Now</p>
                <${RuleLines} lines=${before} empty="No entry in openclaw.json (silent)" />
              </div>
              <div>
                <p class="groups-preview-label">After</p>
                <${RuleLines} lines=${after} />
              </div>
            </div>
            ${preview.preview?.topicsNormalized
              ? html`<p class="text-sm text-fg-muted">The topics' own enabled, groupPolicy and allowFrom settings are removed, so this mode applies to every topic.</p>`
              : null}
            <${GroupWarnings} warnings=${preview.warnings} />
          `
        : null}
      ${problem ? html`<${ProblemCard} problem=${problem} action=${mode} />` : null}
      ${topicBlocked
        ? html`<button type="button" class="relay-row-action" onclick=${() => setNormalizeTopics(true)}>Preview with the topic overrides removed</button>`
        : null}
    </div>
  `;

  return html`
    <${ConfirmDialog}
      visible=${true}
      title=${copy.title}
      message=${copy.message}
      details=${details}
      confirmLabel=${copy.confirmLabel}
      confirmLoadingLabel="Saving…"
      confirmTone=${copy.tone}
      confirmLoading=${saving}
      confirmDisabled=${loading || !preview}
      closeOnEscape=${!saving}
      closeOnOverlayClick=${!saving}
      onConfirm=${save}
      onCancel=${() => !saving && onClose()}
    />
  `;
};
