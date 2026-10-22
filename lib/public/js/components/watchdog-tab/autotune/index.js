import { h } from "preact";
import htm from "htm";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  acknowledgeAutotuneResize,
  fetchAutotune,
  reapplyAutotune,
  updateAutotuneSettings,
} from "../../../lib/api.js";
import {
  getCached,
  invalidateCache,
  setCached,
} from "../../../lib/api-cache.js";
import { useCachedFetch } from "../../../hooks/use-cached-fetch.js";
import { useSavedSetting } from "../../../hooks/use-saved-setting.js";
import { showToast } from "../../toast.js";
import {
  kAutotuneCacheKey,
  kAutotuneEnabledContext,
  kAutotuneHeapContext,
  formatAutotuneValue,
  buildAutotuneCounts,
  pluralSettings,
  buildAutotuneToggleToast,
} from "./model.js";
import { AutotuneCardView } from "./view.js";

const html = htm.bind(h);

const selectAutotuneSettingsDoc = (data) => ({
  enabled: data?.ledger?.enabled !== false,
  gatewayHeapMb: data?.ledger?.overrides?.gatewayHeapMb ?? null,
});

// Container: owns the ledger fetch, the shared settings document (the toggle
// and the gatewayHeapMb field save through ONE useSavedSetting so they can't
// clobber each other), and the freshness triggers — restartSignal (spawn-time
// pending_restart → applied flips happen server-side, an event the card never
// observes otherwise) and the shared resources poll's profile.detectedAt
// (live resizes surface without a second poll loop).
export const WatchdogAutotuneCard = ({
  restartSignal = 0,
  resourcesProfile = null,
  onRestartGateway = null,
  restartingGateway = false,
}) => {
  const ledgerFetch = useCachedFetch(kAutotuneCacheKey, fetchAutotune);
  const ledger = ledgerFetch.data?.ledger || null;

  const setting = useSavedSetting({
    cacheKey: kAutotuneCacheKey,
    load: fetchAutotune,
    select: selectAutotuneSettingsDoc,
    selectSaved: (response) =>
      response?.ledger ? selectAutotuneSettingsDoc(response) : undefined,
    // The endpoint merges per key, so each save sends ONLY what its context
    // changed — the enabled toggle never writes back a stale override copy
    // and the heap field never writes back a stale enabled flag.
    save: (next, { context } = {}) =>
      updateAutotuneSettings(
        context === kAutotuneEnabledContext
          ? { enabled: next?.enabled === true }
          : context === kAutotuneHeapContext
            ? { overrides: { gatewayHeapMb: next?.gatewayHeapMb ?? null } }
            : {
                enabled: next?.enabled === true,
                overrides: { gatewayHeapMb: next?.gatewayHeapMb ?? null },
              },
      ),
    onSaved: async (next, response) => {
      // The PUT returns the fresh ledger — seed the shared cache so the row
      // list converges without a second GET (refresh() adopts the cache).
      if (response?.ledger) {
        setCached(kAutotuneCacheKey, { ok: true, ledger: response.ledger });
      }
      await ledgerFetch.refresh().catch(() => {});
    },
    label: "autotune settings",
  });

  const enabled =
    setting.hydrated && setting.value !== undefined
      ? setting.value?.enabled === true
      : ledger?.enabled !== false;

  const [heapDraft, setHeapDraft] = useState(null); // null = not editing
  const savedHeap = setting.value?.gatewayHeapMb ?? null;
  const savedHeapText = savedHeap === null ? "" : String(savedHeap);
  const heapDraftValue = heapDraft !== null ? heapDraft : savedHeapText;
  const heapDirty = heapDraft !== null && heapDraft.trim() !== savedHeapText;

  const [reapplying, setReapplying] = useState(false);
  const [reapplyError, setReapplyError] = useState(null);
  const [dismissingResize, setDismissingResize] = useState(false);

  // Gateway restarts flip pending rows server-side at spawn: invalidate and
  // refetch on the tab's restart signal (immediate + settled, mirroring the
  // incidents hook), or the chips stay amber forever.
  useEffect(() => {
    if (!restartSignal) return;
    invalidateCache(kAutotuneCacheKey);
    ledgerFetch.refresh({ force: true }).catch(() => {});
    const timer = setTimeout(() => {
      ledgerFetch.refresh({ force: true }).catch(() => {});
    }, 3500);
    return () => clearTimeout(timer);
  }, [restartSignal, ledgerFetch.refresh]);

  // Live-resize freshness: the Resources card's 5s poll carries the machine
  // profile; a detectedAt CHANGE (never the first observation) means the
  // server re-detected capacity, so the ledger is stale.
  const detectedAt = resourcesProfile?.detectedAt ?? null;
  const lastDetectedAtRef = useRef(null);
  useEffect(() => {
    if (detectedAt == null) return;
    if (lastDetectedAtRef.current == null) {
      lastDetectedAtRef.current = detectedAt;
      return;
    }
    if (lastDetectedAtRef.current === detectedAt) return;
    lastDetectedAtRef.current = detectedAt;
    invalidateCache(kAutotuneCacheKey);
    ledgerFetch.refresh({ force: true }).catch(() => {});
  }, [detectedAt, ledgerFetch.refresh]);

  const onToggleEnabled = useCallback(
    async (next) => {
      const outcome = await setting.commit(
        (current) => ({ ...(current || {}), enabled: next === true }),
        { context: kAutotuneEnabledContext },
      );
      if (outcome.ok) {
        // The commit's onSaved seeded the shared cache with the returned
        // ledger (and reconciled via refresh), so the cache holds the
        // server's adopted state — including killSwitchActive.
        const toast = buildAutotuneToggleToast(
          next === true,
          getCached(kAutotuneCacheKey)?.ledger || null,
        );
        showToast(toast.message, toast.tone);
      } else if (!outcome.busy) {
        // The SavedToggle's inline chip is the loud revert; the toast echoes
        // the failure for users who already scrolled away.
        showToast(
          outcome.error?.message || "Could not save autotune settings",
          "error",
        );
      }
    },
    [setting.commit],
  );

  const onHeapInput = useCallback((event) => {
    setHeapDraft(String(event?.target?.value ?? ""));
  }, []);

  const onHeapSave = useCallback(async () => {
    const raw = String(heapDraft ?? "").trim();
    let nextValue = null;
    if (raw !== "") {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw) {
        showToast(
          "Enter a whole number of MB, or leave the field empty to clear the override",
          "error",
        );
        return;
      }
      nextValue = parsed;
    }
    const outcome = await setting.commit(
      (current) => ({ ...(current || {}), gatewayHeapMb: nextValue }),
      { context: kAutotuneHeapContext },
    );
    if (outcome.ok) {
      setHeapDraft(null);
      showToast(
        nextValue === null
          ? "Gateway heap override cleared — the derived value applies on the next gateway restart"
          : `Gateway heap override saved (${formatAutotuneValue("gatewayHeapMb", nextValue)}) — applies on the next gateway restart`,
        "success",
      );
    } else if (!outcome.busy) {
      // The hook reverted and is reconciling with the server; drop the
      // rejected draft too, or the field would keep showing a value the
      // error chip just said was never adopted.
      setHeapDraft(null);
    }
  }, [heapDraft, setting.commit]);

  const onReapply = useCallback(async () => {
    if (reapplying) return;
    setReapplying(true);
    setReapplyError(null);
    try {
      const data = await reapplyAutotune();
      if (data?.ledger) {
        setCached(kAutotuneCacheKey, { ok: true, ledger: data.ledger });
      }
      await ledgerFetch.refresh({ force: !data?.ledger }).catch(() => {});
      // The toast derives from the RETURNED ledger — honest about skips.
      const counts = buildAutotuneCounts(data?.ledger?.rows);
      showToast(
        counts.skipped > 0
          ? `Recalculated with ${pluralSettings(counts.skipped)} skipped — see the card for why`
          : `Recalculated — ${pluralSettings(counts.tuned)} tuned`,
        "info",
      );
    } catch (error) {
      setReapplyError(error);
      showToast(
        error?.message || "Could not recalculate autotune settings",
        "error",
      );
    } finally {
      setReapplying(false);
    }
  }, [reapplying, ledgerFetch.refresh]);

  const onDismissResize = useCallback(async () => {
    if (dismissingResize) return;
    setDismissingResize(true);
    try {
      await acknowledgeAutotuneResize();
      invalidateCache(kAutotuneCacheKey);
      await ledgerFetch.refresh({ force: true }).catch(() => {});
    } catch (error) {
      showToast(
        error?.message || "Could not dismiss the resize notice",
        "error",
      );
    } finally {
      setDismissingResize(false);
    }
  }, [dismissingResize, ledgerFetch.refresh]);

  return html`
    <${AutotuneCardView}
      ledger=${ledger}
      error=${ledgerFetch.error}
      onRetry=${() => ledgerFetch.refresh({ force: true }).catch(() => {})}
      enabled=${enabled}
      settingHydrated=${setting.hydrated}
      settingSaving=${setting.saving}
      settingSavingContext=${setting.savingContext}
      settingSaveError=${setting.saveError}
      settingLoadError=${setting.loadError}
      onRetryLoadSetting=${setting.retryLoad}
      onToggleEnabled=${onToggleEnabled}
      heapDraftValue=${heapDraftValue}
      heapDirty=${heapDirty}
      onHeapInput=${onHeapInput}
      onHeapSave=${onHeapSave}
      reapplying=${reapplying}
      reapplyError=${reapplyError}
      onReapply=${onReapply}
      dismissingResize=${dismissingResize}
      onDismissResize=${onDismissResize}
      onRestartGateway=${onRestartGateway}
      restartingGateway=${restartingGateway}
    />
  `;
};
