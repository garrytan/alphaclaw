import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { formatLocaleTime } from "../../lib/format.js";
import {
  getHardeningReasonCopy,
  kManagedPrefix,
} from "../../lib/hardening-reasons.js";

const html = htm.bind(h);

const kVisibleSignalCount = 3;

// One signal per problem file, keyed on the FILE's own reason; an absent file
// with an empty per-file reason is plain-missing (rejected reads carry their
// own reason) — mixed causes each get their true copy, never one homogenized
// cause. Kept separate from the model builder to stay under the
// branch-complexity bar.
const selectHardeningSignals = (files, topReason) => {
  const list = Array.isArray(files) ? files : [];
  return list
    .filter(
      (file) =>
        file &&
        (file.reason ||
          file.injectable === false ||
          file.skipped ||
          file.truncated ||
          !file.exists),
    )
    .map((file) => {
      const path = String(file.path || "");
      const reason =
        String(file.reason || "") || (!file.exists ? "missing_file" : topReason);
      const copy = getHardeningReasonCopy(reason, {
        managed: path.startsWith(kManagedPrefix),
      });
      return {
        key: path || "generic",
        path,
        cause: copy.cause,
        fix: copy.short,
        // Zero content delivered: rejected, missing, or fully dropped.
        dropped: Boolean(file.skipped || !file.exists || file.injectable === false),
      };
    });
};

export const buildHardeningCardModel = (doctorStatus = null) => {
  const hardening = doctorStatus?.bootstrapContext?.hardening || null;
  if (!hardening || typeof hardening !== "object") return null;
  // Dev-channel builds run upstream source: the badge's "unverified" copy
  // owns that state — the card never renders over it.
  if (String(doctorStatus?.releaseChannel || "") === "dev") return null;
  const state = String(hardening.state || "").trim();
  if (state !== "blocked" && state !== "starved") return null;

  const topReason = String(hardening.reason || "");
  let signals = selectHardeningSignals(hardening.files, topReason);
  if (signals.length === 0) {
    // Old servers (empty files[]) or a bad state with no matching problem
    // file: one generic fallback signal, never an intro with zero rows.
    const copy = getHardeningReasonCopy(topReason || "", { managed: true });
    signals = [
      { key: "generic", path: "", cause: copy.cause, fix: copy.short, dropped: true },
    ];
  }

  // Severity derives from impact, not the state name: "blocked" is ALWAYS
  // danger (zero delivery by definition — including legacy payloads where no
  // impact can be derived; fail safe to danger). Within "starved": danger
  // when any problem file is fully dropped, warning when merely truncated.
  const droppedCount = signals.filter((signal) => signal.dropped).length;
  const tone = state === "blocked" || droppedCount > 0 ? "danger" : "warning";
  const badgeLabel =
    state === "blocked" ? "BLOCKED" : droppedCount > 0 ? "DROPPED" : "PARTIAL";
  const anchor =
    tone === "danger"
      ? "Safety rules are not reaching the agent."
      : "Some safety rules are cut before reaching the agent.";
  const detail =
    state === "starved" && droppedCount > 0
      ? `${droppedCount} file(s) are dropped by the context budget before the agent sees them.`
      : signals.length === 1 && signals[0].path
        ? `${signals[0].path} is affected.`
        : `${signals.length} hardening file(s) are affected.`;
  // Only AlphaClaw-server restarts get the disambiguation footnote —
  // hook_disabled's fix legitimately says "restart the gateway".
  const needsRestartFootnote = signals.some((signal) =>
    /restart alphaclaw/i.test(signal.fix),
  );

  return {
    tone,
    badgeLabel,
    anchor,
    detail,
    signals: signals.slice(0, kVisibleSignalCount),
    collapsedSignals: signals.slice(kVisibleSignalCount),
    needsRestartFootnote,
  };
};

const HardeningSignalRow = ({ signal }) => html`
  <li class="ac-surface-inset border border-border rounded-lg p-3 space-y-1">
    ${signal.path
      ? html`<p class="font-mono text-sm text-body break-all">${signal.path}</p>`
      : null}
    <p class="text-xs text-fg-muted">${signal.cause}</p>
    <p class="text-xs text-body">→ ${signal.fix}</p>
  </li>
`;

// "Updated" = CLIENT receive time of the doctorStatus payload (the slim SSE
// path carries no compute timestamp) — labeled honestly as delivery, so a
// user who just restarted can tell a stale card from a still-broken one.
// First-seen time per payload object; module-level so the component stays
// hook-free (the node-env test suite calls components as plain functions).
const kStatusReceivedAt = new WeakMap();
const getStatusReceivedAt = (status) => {
  if (!status || typeof status !== "object") return 0;
  if (!kStatusReceivedAt.has(status)) kStatusReceivedAt.set(status, Date.now());
  return kStatusReceivedAt.get(status);
};

export const GeneralHardeningCard = ({
  doctorStatus = null,
  onOpenDoctor = () => {},
  // Optional precomputed model: GeneralTab already builds it to gate the
  // GeneralDoctorWarning suppression — no need to compute twice per SSE tick.
  model: precomputedModel,
}) => {
  const model =
    precomputedModel !== undefined
      ? precomputedModel
      : buildHardeningCardModel(doctorStatus);
  if (!model) return null;
  const isDanger = model.tone === "danger";
  const updatedAt = getStatusReceivedAt(doctorStatus);
  const updatedLabel = updatedAt
    ? formatLocaleTime(updatedAt, { withSeconds: true, fallback: null })
    : null;
  return html`
    <div
      class=${`bg-surface border ${
        isDanger ? "border-status-error-border" : "border-status-warning-border"
      } rounded-xl p-4 space-y-3`}
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <h2 class="card-label">Prompt hardening</h2>
          <${Badge} tone=${model.tone}>${model.badgeLabel}<//>
        </div>
        ${updatedLabel
          ? html`<span class="text-xs text-fg-muted"
              >updated ${updatedLabel} · re-checks automatically</span
            >`
          : null}
      </div>
      <div class="space-y-1">
        <p class="text-sm text-body">${model.anchor}</p>
        <p class="text-xs text-fg-muted">${model.detail}</p>
      </div>
      <ul class="space-y-3">
        ${model.signals.map(
          (signal) => html`<${HardeningSignalRow} key=${signal.key} signal=${signal} />`,
        )}
      </ul>
      ${model.collapsedSignals.length > 0
        ? html`
            <details>
              <summary class="text-xs text-fg-muted cursor-pointer">
                Show ${model.collapsedSignals.length} more${" "}
                ${model.collapsedSignals.length === 1 ? "file" : "files"}
              </summary>
              <ul class="space-y-3 mt-3">
                ${model.collapsedSignals.map(
                  (signal) =>
                    html`<${HardeningSignalRow} key=${signal.key} signal=${signal} />`,
                )}
              </ul>
            </details>
          `
        : null}
      ${model.needsRestartFootnote
        ? html`<p class="text-xs text-fg-dim leading-5">
            Restart here means the AlphaClaw server — restart the
            container/process, not the gateway Restart above.
          </p>`
        : null}
      <${ActionButton}
        onClick=${onOpenDoctor}
        tone=${isDanger ? "danger" : "warning"}
        idleLabel="Open Drift Doctor"
      />
    </div>
  `;
};
