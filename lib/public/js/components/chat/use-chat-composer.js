import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { kChatSessionDraftsStorageKey } from "../../lib/storage-keys.js";

const kDraftDebounceMs = 300;

const readDrafts = () => {
  try {
    const rawValue = localStorage.getItem(kChatSessionDraftsStorageKey);
    if (!rawValue) return {};
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

// Per-session composer drafts (the one good bit of the old chat-route, kept):
// localStorage-persisted, now with a trailing debounce so a keystroke no
// longer serializes every session's draft — flushed on blur/beforeunload so
// the 300ms tail is never lost.
export const useChatComposer = ({ selectedSessionKey = "" }) => {
  const [draftBySession, setDraftBySession] = useState(readDrafts);
  const [draft, setDraft] = useState("");
  const persistTimerRef = useRef(null);
  const draftsRef = useRef(draftBySession);
  draftsRef.current = draftBySession;

  const persistNow = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    try {
      localStorage.setItem(
        kChatSessionDraftsStorageKey,
        JSON.stringify(draftsRef.current),
      );
    } catch {}
  }, []);

  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(persistNow, kDraftDebounceMs);
  }, [persistNow]);

  useEffect(() => {
    window.addEventListener("beforeunload", persistNow);
    return () => {
      persistNow();
      window.removeEventListener("beforeunload", persistNow);
    };
  }, [persistNow]);

  useEffect(() => {
    if (!selectedSessionKey) return;
    setDraft(String(draftsRef.current[selectedSessionKey] || ""));
  }, [selectedSessionKey]);

  const updateDraft = useCallback(
    (nextValue) => {
      const value = String(nextValue || "");
      setDraft(value);
      if (!selectedSessionKey) return;
      setDraftBySession((currentMap) => ({
        ...currentMap,
        [selectedSessionKey]: value,
      }));
      schedulePersist();
    },
    [schedulePersist, selectedSessionKey],
  );

  const clearDraft = useCallback(() => {
    setDraft("");
    if (!selectedSessionKey) return;
    setDraftBySession((currentMap) => ({
      ...currentMap,
      [selectedSessionKey]: "",
    }));
    schedulePersist();
  }, [schedulePersist, selectedSessionKey]);

  // Cancelled queued messages return here — APPENDED after a blank line when
  // the draft is non-empty, never overwriting existing text.
  const appendToDraft = useCallback(
    (content) => {
      const value = String(content || "");
      if (!value) return;
      const current = String(draftsRef.current[selectedSessionKey] || "");
      updateDraft(current ? `${current}\n\n${value}` : value);
    },
    [selectedSessionKey, updateDraft],
  );

  // Identity-stable container (draft aside): row-level memoization keys off
  // these callbacks — a fresh object literal per render would defeat it.
  return useMemo(
    () => ({
      draft,
      updateDraft,
      clearDraft,
      appendToDraft,
      flushDraftPersist: persistNow,
    }),
    [draft, updateDraft, clearDraft, appendToDraft, persistNow],
  );
};
