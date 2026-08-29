import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useCachedFetch } from "./use-cached-fetch.js";
import { kClaudeCodeStatusCacheKey } from "../lib/cache-keys.js";
import { createClaudeCodeSession, fetchClaudeCodeStatus } from "../lib/api.js";
import { showToast } from "../components/toast.js";
import { kClaudeCodeUrl } from "../lib/app-navigation.js";
import { readUiSettings, updateUiSettings } from "../lib/ui-settings.js";

const kFireConfirmedUiSettingKey = "claudeCodeFireConfirmed";
const kLongToastMs = 10_000;
// "15 seconds" mirrors the server's kDefaultTimeoutMs (claude-code-service.js)
// — update both together.
const kStartingInterstitialText =
  "Starting Claude Code session… This can take up to 15 seconds.";

// Sidebar "Open Claude Code" launcher.
//
//  click ──▶ win = open(about:blank interstitial)  (SYNCHRONOUS — popup-safe)
//    │            POST /api/claude-code/session {confirmed: uiSettings flag}
//    │   success ──▶ win → session URL (+ success toast)
//    │   confirm_required ──▶ modal (lock HELD, placeholder waits)
//    │   not_configured ──▶ win → claude.ai/code (silent fallback)
//    │   other error ──▶ win.close() + error toast (cause + recovery, one tab)
//
// The placeholder is about:blank (ours) and is navigated exactly once:
// claude.ai serves Cross-Origin-Opener-Policy: same-origin, which severs a
// WindowProxy opened directly on it — retargeting later would silently fail.
const writeInterstitial = (win, text) => {
  try {
    win.document.title = "Starting Claude Code…";
    win.document.body.innerHTML = "";
    win.document.write(
      `<style>:root{color-scheme:light dark}body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f4;color:#1a1a1a;font-family:system-ui,sans-serif;font-size:16px;text-align:center;padding:24px}@media (prefers-color-scheme:dark){body{background:#1a1a1a;color:#e8e8e8}}</style><body>${text}</body>`,
    );
    win.document.close();
  } catch {
    // A dead/blocked handle is handled by the outcome paths.
  }
};

const isModifiedClick = (event) =>
  !!event &&
  (event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    (typeof event.button === "number" && event.button !== 0));

export const useClaudeCodeLauncher = ({ enabled = true, onBeforeOpen = null } = {}) => {
  // Status is COSMETIC only (tooltip + live-dot): behavior never branches on
  // it, so staleness can mislabel a tooltip but never change what a click
  // does. It refreshes on window focus (the natural moment after configuring
  // the routine in another tab) and envars.js invalidates the key on save —
  // without those, one fetch per page load would leave the cue stale until a
  // full reload. Three-way: true / false (server-confirmed) / null (unknown —
  // never assert setup guidance on a transient status failure).
  const { data: statusData, refresh: refreshStatus } = useCachedFetch(
    kClaudeCodeStatusCacheKey,
    fetchClaudeCodeStatus,
    { enabled, maxAgeMs: 60_000 },
  );

  useEffect(() => {
    if (!enabled) return undefined;
    const onFocus = () => {
      refreshStatus().catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, refreshStatus]);
  const availability = statusData?.availability || null;
  const configured = availability ? availability.available === true : null;
  const tooltip =
    configured === true
      ? "Fires your Claude Code routine (autonomous run on your claude.ai account) and opens the new session"
      : configured === false
        ? "Opens claude.ai/code. Set CLAUDE_CODE_ROUTINE_URL and CLAUDE_CODE_ROUTINE_TOKEN in Envars for one-click sessions."
        : "Opens claude.ai/code.";

  const [launching, setLaunching] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Synchronous re-entrancy lock: state alone can double-fire between
  // renders. Held from click through EVERY terminal outcome — including
  // across a pending confirmation modal (releasing in a naive finally would
  // let re-clicks open more placeholders while the modal waits).
  const launchingRef = useRef(false);
  const pendingWinRef = useRef(null);
  // The placeholder tab, tracked from open through settle — NOT just while the
  // confirm modal waits (pendingWinRef). Unmount during the initial fire would
  // otherwise orphan the about:blank tab.
  const activeWinRef = useRef(null);
  // One-shot gate for the modal's Start button: state (confirmOpen) is stale
  // within a double-click's two handler runs, so the guard must be a ref.
  const confirmPendingRef = useRef(false);

  const release = useCallback(() => {
    launchingRef.current = false;
    pendingWinRef.current = null;
    activeWinRef.current = null;
    confirmPendingRef.current = false;
    setLaunching(false);
    setConfirmOpen(false);
  }, []);

  const settle = useCallback(
    (win, result, error) => {
      if (result?.sessionUrl) {
        if (win && !win.closed) {
          win.location.href = result.sessionUrl;
          showToast("Claude Code session started", "success");
        } else {
          // A billed session must never start silently — even when the
          // placeholder was blocked or the user already closed it.
          showToast(
            "Claude Code session started — open claude.ai/code to find it",
            "warning",
            { durationMs: kLongToastMs },
          );
        }
        release();
        return;
      }
      if (error?.code === "not_configured") {
        // The expected graceful fallback: the click still lands somewhere
        // useful, no toast (the tooltip explains how to enable full mode).
        if (win && !win.closed) win.location.href = kClaudeCodeUrl;
        release();
        return;
      }
      // Real errors: cause and recovery stay in the dashboard tab instead of
      // an error toast here plus a consolation claude.ai tab there.
      try {
        win?.close();
      } catch {}
      showToast(
        error?.message || "Could not start a Claude Code session",
        "error",
        { durationMs: kLongToastMs },
      );
      release();
    },
    [release],
  );

  const fire = useCallback(
    async (win, confirmed) => {
      try {
        const result = await createClaudeCodeSession({ confirmed });
        settle(win, result, null);
      } catch (error) {
        if (error?.code === "confirm_required") {
          // Keep the lock and the placeholder; the modal takes over. Start
          // re-fires with confirmed:true on this SAME still-same-origin
          // window, so no second window.open (and no popup risk) is needed.
          pendingWinRef.current = win;
          confirmPendingRef.current = true;
          writeInterstitial(win, "Waiting for your confirmation in AlphaClaw…");
          setConfirmOpen(true);
          return;
        }
        settle(win, null, error);
      }
    },
    [settle],
  );

  const openClaudeCode = useCallback(
    (event) => {
      // Modifier clicks keep native anchor semantics: plain claude.ai/code in
      // a new tab, routine never fires (the documented escape hatch).
      if (isModifiedClick(event)) return;
      event?.preventDefault?.();
      if (launchingRef.current) return; // silent debounce, by design
      launchingRef.current = true;
      setLaunching(true);
      onBeforeOpen?.();
      // Synchronous open inside the click gesture — the one popup-safe moment.
      const win = window.open("about:blank", "_blank");
      activeWinRef.current = win;
      if (win) {
        writeInterstitial(win, kStartingInterstitialText);
      }
      const confirmed = readUiSettings()[kFireConfirmedUiSettingKey] === true;
      fire(win, confirmed);
    },
    [fire, onBeforeOpen],
  );

  const confirmStart = useCallback(() => {
    // One-shot: a modal double-click must not fire twice — the second POST
    // would come back `busy` and its error path would close the very
    // placeholder the first (billed) fire just navigated. Check-and-clear
    // the ref synchronously so re-entry is a no-op.
    if (!confirmPendingRef.current) return;
    confirmPendingRef.current = false;
    const win = pendingWinRef.current;
    pendingWinRef.current = null;
    setConfirmOpen(false);
    updateUiSettings((settings) => ({
      ...settings,
      [kFireConfirmedUiSettingKey]: true,
    }));
    if (win && !win.closed) {
      writeInterstitial(win, kStartingInterstitialText);
    }
    fire(win, true);
  }, [fire]);

  const confirmCancel = useCallback(() => {
    try {
      pendingWinRef.current?.close();
    } catch {}
    release();
  }, [release]);

  // Unmount mid-launch (a pending modal OR an in-flight initial fire): close
  // the orphan placeholder and release the lock so a remount starts clean.
  useEffect(
    () => () => {
      try {
        activeWinRef.current?.close();
      } catch {}
      launchingRef.current = false;
      pendingWinRef.current = null;
      activeWinRef.current = null;
      confirmPendingRef.current = false;
    },
    [],
  );

  return {
    configured,
    tooltip,
    launching,
    confirmOpen,
    openClaudeCode,
    confirmStart,
    confirmCancel,
  };
};
