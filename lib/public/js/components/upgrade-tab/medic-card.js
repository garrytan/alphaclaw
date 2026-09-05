import { h } from "preact";
import htm from "htm";
import { useCallback } from "preact/hooks";
import { fetchOpenclawMedic, updateOpenclawMedic } from "../../lib/api.js";
import { useSavedSetting } from "../../hooks/use-saved-setting.js";
import { SavedToggle } from "../saved-toggle.js";
import { showToast } from "../toast.js";

const html = htm.bind(h);

// "Startup medic" card: automatic repair of EX_CONFIG (exit 78) gateway
// startup failures. Default ON (opt-out) — unlike the recommend-only
// overseer, because every medic action comes from a deterministic whitelist,
// is preceded by a backup, and is capped per incident. The AI tier only
// chooses among whitelisted remedies; this card shows which frontier model
// it would use, or why none is reachable.

// Inline chip headline after a reverted save (exported for tests).
export const describeMedicSaveError = (attempted) =>
  attempted
    ? "Couldn't enable the startup medic — still disabled."
    : "Couldn't disable the startup medic — still enabled.";

// Pure view-model: exported for tests.
export const buildMedicAiLine = (ai = null) => {
  if (!ai) return null;
  if (ai.available) {
    return {
      tone: "ok",
      text: `AI escalation available (${ai.provider}/${ai.model})`,
    };
  }
  return {
    tone: "warning",
    text:
      ai.message ||
      "AI escalation unavailable — no frontier-model API key configured. Deterministic repairs still run.",
  };
};

export const UpgradeMedicCard = () => {
  // One persisted-setting loop (fix wave F158): hydration, optimistic flip,
  // revert-on-failure with an inline chip, load-failure Retry — all from
  // useSavedSetting instead of the hand-rolled loaded/saving/remount dance.
  const setting = useSavedSetting({
    cacheKey: "/api/openclaw/medic",
    load: fetchOpenclawMedic,
    // Default ON (opt-out): only a literal false disables it.
    select: (data) => data?.enabled !== false,
    selectSaved: (response) =>
      typeof response?.enabled === "boolean" ? response.enabled : undefined,
    save: (next) => updateOpenclawMedic(next),
    label: "startup medic",
  });

  const onToggle = useCallback(
    async (next) => {
      const outcome = await setting.commit(next === true);
      if (outcome.ok) {
        showToast(
          next
            ? "Startup medic enabled — config startup failures repair automatically"
            : "Startup medic disabled — config startup failures pause the gateway",
          "info",
        );
      }
    },
    [setting.commit],
  );

  const enabled = setting.value !== false;
  const ai = setting.payload?.ai || null;
  const aiLine = buildMedicAiLine(ai);

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="card-label">Startup medic</h2>
        <${SavedToggle}
          value=${enabled}
          hydrated=${setting.hydrated}
          saving=${setting.saving}
          savingContext=${setting.savingContext}
          saveError=${setting.saveError}
          loadError=${setting.loadError}
          onRetryLoad=${setting.retryLoad}
          onChange=${onToggle}
          describe=${describeMedicSaveError}
        />
      </div>

      <p class="text-xs text-fg-muted">
        When the gateway exits with a fatal configuration error, the medic
        removes config keys the gateway itself rejected (with a backup), runs
        OpenClaw's doctor, or asks the smartest frontier model you have an API
        key for to pick a whitelisted fix — then restarts the gateway. Every
        repair is announced in notifications and the watchdog event log.
      </p>

      ${aiLine
        ? html`<p
            class=${`text-xs ${aiLine.tone === "ok" ? "text-fg-muted" : "text-status-warning-muted"}`}
          >
            ${aiLine.text}
          </p>`
        : null}
    </div>
  `;
};
