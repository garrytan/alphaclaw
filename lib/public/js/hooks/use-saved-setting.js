import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { getCached, setCached } from "../lib/api-cache.js";

// The persisted-setting loop. One instance per setting — or per settings
// DOCUMENT when several controls share one GET/PUT (never one per field
// against the same endpoint: that double-fetches and races itself).
//
//         ┌──────────────── mount / key change ────────────────┐
//         ▼                                                    │
//   [cacheKey seed? value=cached, hydrated=true, interactive]  │
//         │  GET (foreground revalidate, captures gen=g)       │
//         ▼                                                    │
//   ┌─ GET ok ──▶ gen unchanged? value=select(payload) ────────┼──▶ READY
//   │             gen changed?   keep user value, payload only │
//   └─ GET fail ─▶ loadError (+ Retry chip, control disabled) ─┘
//   READY ── commit(next) ──▶ SAVING (savingRef lock, gen++, optimistic value)
//     │                        ├─ ok ──▶ adopt selectSaved(response) ──▶ onSaved (isolated) ──▶ READY
//     │                        └─ fail ─▶ revert ──▶ saveError{attempted} ──▶ reload reconcile ──▶ READY
//     └─ unmount / key change ──▶ stale operations may not write state or release the lock
//
// Guard inventory (each kills a distinct verified defect class):
// - generation ref: an in-flight GET dispatched before a user action must
//   never clobber it — not even when it lands AFTER the save settles.
// - savingRef: synchronous concurrency lock (the `saving` state closure is
//   not one — two commits before a re-render would both pass it).
// - operation token (generation captured per commit): a stale save (older
//   commit, or a commit from a previous `key`) may not revert state, set
//   errors, or release the current key's lock.
// - active flag: nothing writes state after unmount or key switch.
// - valueRef: functional commits merge from a synchronous snapshot, never a
//   stale render closure.
// - reconcile-on-failure: a rejected fetch does not prove the PUT failed
//   server-side; after reverting we re-load so the UI converges to server
//   truth instead of asserting "still disabled".
// Deliberate exception to the useCachedFetch convention: user-mutable state
// must not be background-revalidated (that IS the clobber class), so the read
// stays imperative; `cacheKey` only seeds and updates the shared cache.
export const useSavedSetting = ({
  key = null,
  cacheKey = "",
  load,
  select,
  selectSaved = null,
  save,
  onSaved = null,
  label = "setting",
} = {}) => {
  const loadRef = useRef(load);
  const selectRef = useRef(select);
  const selectSavedRef = useRef(selectSaved);
  const saveRef = useRef(save);
  const onSavedRef = useRef(onSaved);
  const cacheKeyRef = useRef(cacheKey);
  loadRef.current = load;
  selectRef.current = select;
  selectSavedRef.current = selectSaved;
  saveRef.current = save;
  onSavedRef.current = onSaved;
  cacheKeyRef.current = cacheKey;

  const generationRef = useRef(0);
  const savingRef = useRef(false);
  const valueRef = useRef(undefined);

  const seed = () => {
    if (!cacheKeyRef.current) return { seeded: false };
    const cached = getCached(cacheKeyRef.current);
    if (cached === null || cached === undefined) return { seeded: false };
    try {
      return { seeded: true, value: selectRef.current(cached), payload: cached };
    } catch {
      return { seeded: false };
    }
  };

  const initialSeed = useRef(null);
  if (initialSeed.current === null) {
    initialSeed.current = seed();
    if (initialSeed.current.seeded) valueRef.current = initialSeed.current.value;
  }

  const [value, setValueState] = useState(initialSeed.current.value);
  const [payload, setPayload] = useState(initialSeed.current.payload ?? null);
  // A seeded value is interactive immediately; the mount GET is a foreground
  // revalidate whose result applies through the generation guard, so a user
  // click during revalidation wins and a differing server value corrects
  // visibly. Never hold a seeded control hostage behind the revalidate.
  const [hydrated, setHydrated] = useState(initialSeed.current.seeded === true);
  const [saving, setSaving] = useState(false);
  const [savingContext, setSavingContext] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loadNonce, setLoadNonce] = useState(0);

  // Key change gates rendering synchronously (render-phase reset): no frame
  // may show the previous entity's value — interactive — under the new key.
  const [renderedKey, setRenderedKey] = useState(key);
  if (renderedKey !== key) {
    setRenderedKey(key);
    generationRef.current += 1; // every in-flight op from the old key goes stale
    savingRef.current = false; // the old key's save may not hold the new key's lock
    const next = seed();
    valueRef.current = next.seeded ? next.value : undefined;
    setValueState(next.seeded ? next.value : undefined);
    setPayload(next.seeded ? next.payload : null);
    setHydrated(next.seeded === true);
    setSaving(false);
    setSavingContext(null);
    setSaveError(null);
    setLoadError(null);
  }

  useEffect(() => {
    let active = true;
    const generation = generationRef.current;
    (async () => {
      try {
        const data = await loadRef.current();
        if (!active) return;
        setPayload(data);
        if (cacheKeyRef.current) setCached(cacheKeyRef.current, data);
        if (generationRef.current === generation) {
          // A user action supersedes any in-flight GET — never clobber it.
          let next;
          try {
            next = selectRef.current(data);
          } catch (error) {
            console.warn(`[saved-setting] ${label} select failed`, error);
            setLoadError(error);
            setHydrated(true);
            return;
          }
          valueRef.current = next;
          setValueState(next);
        }
        setLoadError(null);
        setHydrated(true);
      } catch (error) {
        if (!active) return;
        console.warn(`[saved-setting] ${label} load failed`, error);
        // A failed GET must NOT present the default value as fact — callers
        // render a disabled control with a Retry chip off this state.
        setLoadError(error);
        setHydrated(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [key, loadNonce]);

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setHydrated(false);
    setLoadNonce((n) => n + 1);
  }, []);

  const commit = useCallback(
    async (nextOrUpdater, { context = null } = {}) => {
      if (savingRef.current) {
        return { ok: false, busy: true, error: null, value: valueRef.current };
      }
      savingRef.current = true;
      const token = ++generationRef.current;
      const previous = valueRef.current;
      const next =
        typeof nextOrUpdater === "function"
          ? nextOrUpdater(previous)
          : nextOrUpdater;
      valueRef.current = next;
      setValueState(next); // optimistic — the control reflects the click instantly
      setSaveError(null);
      setSaving(true);
      setSavingContext(context);
      let outcome;
      let response;
      try {
        response = await saveRef.current(next);
        if (generationRef.current === token && selectSavedRef.current) {
          // Canonical adoption ONLY via selectSaved — PUT responses may be
          // partial or shaped differently from GET payloads; never blind-write
          // them over value, payload, or the cache.
          try {
            const canonical = selectSavedRef.current(response);
            if (canonical !== undefined) {
              valueRef.current = canonical;
              setValueState(canonical);
            }
          } catch (error) {
            console.warn(`[saved-setting] ${label} selectSaved failed`, error);
          }
        }
        outcome = { ok: true, busy: false, error: null, value: valueRef.current };
      } catch (error) {
        console.warn(`[saved-setting] ${label} save failed`, error);
        if (generationRef.current === token) {
          valueRef.current = previous;
          setValueState(previous);
          setSaveError({ attempted: next, error, context });
          // A rejected fetch does not prove the PUT failed server-side —
          // reconcile so the UI converges to server truth.
          setLoadNonce((n) => n + 1);
        }
        outcome = { ok: false, busy: false, error, value: valueRef.current };
      } finally {
        if (generationRef.current === token) {
          savingRef.current = false;
          setSaving(false);
          setSavingContext(null);
        }
      }
      if (outcome.ok && onSavedRef.current) {
        // Outside the revert path on purpose: a cache-invalidation failure
        // must never revert a save that succeeded server-side.
        try {
          await onSavedRef.current(next, response);
        } catch (error) {
          console.warn(`[saved-setting] ${label} onSaved failed`, error);
        }
      }
      return outcome;
    },
    [label],
  );

  const clearSaveError = useCallback(() => setSaveError(null), []);

  return {
    value,
    payload,
    hydrated,
    saving,
    savingContext,
    saveError,
    loadError,
    commit,
    retryLoad,
    clearSaveError,
  };
};
