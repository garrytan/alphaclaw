import { h } from "preact";
import htm from "htm";
import { useCallback, useEffect, useState } from "preact/hooks";
import { fetchOpenclawMedic, updateOpenclawMedic } from "../../lib/api.js";
import { ToggleSwitch } from "../toggle-switch.js";
import { showToast } from "../toast.js";

const html = htm.bind(h);

// "Startup medic" card: automatic repair of EX_CONFIG (exit 78) gateway
// startup failures. Default ON (opt-out) — unlike the recommend-only
// overseer, because every medic action comes from a deterministic whitelist,
// is preceded by a backup, and is capped per incident. The AI tier only
// chooses among whitelisted remedies; this card shows which frontier model
// it would use, or why none is reachable.

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
  const [enabled, setEnabled] = useState(true);
  const [ai, setAi] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  // Bumped on a failed save so the ToggleSwitch remounts: the DOM checkbox
  // has already flipped visually, but `enabled` didn't change, so no prop
  // diff would otherwise reset it.
  const [toggleRevision, setToggleRevision] = useState(0);

  const load = useCallback(async () => {
    try {
      const settings = await fetchOpenclawMedic();
      setEnabled(settings?.enabled !== false);
      setAi(settings?.ai || null);
    } catch {
      // The card still renders (toggle + disclosure) without availability.
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onToggle = useCallback(
    async (next) => {
      if (saving) return;
      setSaving(true);
      try {
        await updateOpenclawMedic(next);
        setEnabled(next === true);
        showToast(
          next
            ? "Startup medic enabled — config startup failures repair automatically"
            : "Startup medic disabled — config startup failures pause the gateway",
          "info",
        );
      } catch (err) {
        showToast(err?.message || "Could not save medic settings", "error");
        setToggleRevision((revision) => revision + 1);
      } finally {
        setSaving(false);
      }
    },
    [saving],
  );

  if (!loaded) {
    return html`
      <div class="bg-surface border border-border rounded-xl p-4">
        <h2 class="card-label">Startup medic</h2>
        <p class="text-xs text-fg-muted mt-2">Loading medic status...</p>
      </div>
    `;
  }

  const aiLine = buildMedicAiLine(ai);

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="card-label">Startup medic</h2>
        <${ToggleSwitch}
          key=${toggleRevision}
          checked=${enabled}
          disabled=${saving}
          onChange=${onToggle}
          label=${enabled ? "Enabled" : "Disabled"}
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
