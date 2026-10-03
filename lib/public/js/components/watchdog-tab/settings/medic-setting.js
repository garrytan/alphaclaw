import { h } from "preact";
import htm from "htm";
import { useCallback } from "preact/hooks";
import { fetchOpenclawMedic, updateOpenclawMedic } from "../../../lib/api.js";
import { useSavedSetting } from "../../../hooks/use-saved-setting.js";
import { InfoTooltip } from "../../info-tooltip.js";
import { SavedToggle } from "../../saved-toggle.js";
import { showToast } from "../../toast.js";

const html = htm.bind(h);

// Startup medic: automatic repair of EX_CONFIG (exit 78) gateway startup
// failures. Default ON (opt-out) — every medic action comes from a
// deterministic whitelist and is capped per incident; the AI tier only
// chooses among whitelisted remedies.

export const describeMedicSaveError = (attempted) =>
  attempted
    ? "Couldn't enable the startup medic — still disabled."
    : "Couldn't disable the startup medic — still enabled.";

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

export const MedicSetting = () => {
  const setting = useSavedSetting({
    cacheKey: "/api/openclaw/medic",
    load: fetchOpenclawMedic,
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

  const aiLine = buildMedicAiLine(setting.payload?.ai || null);

  return html`
    <div class="mt-3 space-y-1">
      <div class="flex items-center justify-between gap-3">
        <div class="inline-flex items-center gap-2 text-xs text-fg-muted">
          <span>Startup medic</span>
          <${InfoTooltip}
            text="When the gateway exits with a fatal configuration error, the medic removes config keys the gateway itself rejected, runs OpenClaw's doctor, or asks the smartest frontier model you have an API key for to pick a whitelisted fix — then restarts the gateway. Every repair is announced in notifications and the watchdog event log."
          />
        </div>
        <${SavedToggle}
          value=${setting.value !== false}
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
      ${aiLine
        ? html`<p
            class=${`text-xs ${aiLine.tone === "ok" ? "text-fg-dim" : "text-status-warning-muted"}`}
          >
            ${aiLine.text}
          </p>`
        : null}
    </div>
  `;
};
