import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useCachedFetch } from "./use-cached-fetch.js";
import { kClaudeCodeStatusCacheKey } from "../lib/cache-keys.js";
import {
  createClaudeCodeLocalSession,
  createClaudeCodeSession,
  fetchClaudeCodeStatus,
  fetchClaudeCodeStatusDirect,
} from "../lib/api.js";
import { showToast } from "../components/toast.js";
import { kClaudeCodeUrl } from "../lib/app-navigation.js";
import { readUiSettings, updateUiSettings } from "../lib/ui-settings.js";
import { kThemeStorageKey } from "../lib/storage-keys.js";

const kFireConfirmedUiSettingKey = "claudeCodeFireConfirmed";
// Per-path consent (codex 13): the LOCAL consent remembers WHICH permission
// mode AND working directory were consented to, so switching
// CLAUDE_CODE_LOCAL_PERMISSION_MODE (for example to bypassPermissions) or
// the configured cwd always re-confirms with mode-naming copy.
export const kLocalConfirmedScopeUiSettingKey = "claudeCodeLocalConfirmedScope";
const kLocalSetupToastShownUiSettingKey = "claudeCodeLocalSetupToastShown";
const kLongToastMs = 10_000;
// "15 seconds" mirrors the server's kDefaultTimeoutMs (claude-code-service.js)
// — update both together.
const kStartingInterstitialText =
  "Starting Claude Code session… This can take up to 15 seconds.";
const kLocalStartingInterstitialText =
  "Starting rescue Claude Code on this box… (~15-30s)";
const kLocalUrlWaitInterstitialText = "Waiting for the Remote Control URL…";
// Client poll cap 90s > server URL-extraction watchdog 60s (plan D12): the
// server always concludes (running or error) before the client gives up.
const kLocalPollIntervalMs = 1_500;
const kLocalPollTimeoutMs = 90_000;
const kLocalUrlWaitTextAfterMs = 15_000;

// Sidebar "Open Claude Code" launcher.
//
//  click ──▶ win = open(about:blank interstitial)  (SYNCHRONOUS — popup-safe)
//    │
//    ├─ cached status hints local plausible (local.enabled, state not
//    │  disabled/not_installed) ──▶ POST /api/claude-code/local/session
//    │     200 running ──▶ win → local sessionUrl (+ success toast)
//    │     202 starting ──▶ poll GET status (1.5s, 90s cap) → running → win →
//    │                      sessionUrl; needs_login|disabled|not_installed →
//    │                      stop polling, SAME routine fallback as the 409
//    │                      trio below; error/timeout → win.close() + toast
//    │                      (NO routine fallback — consent rule)
//    │     409 confirm_required ──▶ modal, mode "local" (lock HELD)
//    │     409 disabled|not_installed|needs_login ──▶ FALL BACK to the
//    │                      routine fire below, on the SAME window
//    │     502/network ──▶ win.close() + toast (NO routine fallback)
//    │
//    └─ routine path (unchanged): POST /api/claude-code/session {confirmed}
//          success ──▶ win → session URL (+ success toast)
//          confirm_required ──▶ modal, mode "routine" (lock HELD)
//          not_configured ──▶ win → claude.ai/code (silent fallback)
//          other error ──▶ win.close() + error toast (one tab)
//
// The placeholder is about:blank (ours) and is navigated exactly once:
// claude.ai serves Cross-Origin-Opener-Policy: same-origin, which severs a
// WindowProxy opened directly on it — retargeting later would silently fail.
// The interstitial follows the app's persisted theme preference (the theme
// toggle writes kThemeStorageKey): an explicit "light"/"dark" pins the
// colors, while "system" or an unset key falls back to prefers-color-scheme.
const kInterstitialBodyBase =
  "margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,sans-serif;font-size:16px;text-align:center;padding:24px";
const kInterstitialLightColors = "background:#f5f5f4;color:#1a1a1a";
const kInterstitialDarkColors = "background:#1a1a1a;color:#e8e8e8";

const interstitialStyle = () => {
  let themePref = null;
  try {
    themePref = window.localStorage.getItem(kThemeStorageKey);
  } catch {}
  if (themePref === "light") {
    return `:root{color-scheme:light}body{${kInterstitialBodyBase};${kInterstitialLightColors}}`;
  }
  if (themePref === "dark") {
    return `:root{color-scheme:dark}body{${kInterstitialBodyBase};${kInterstitialDarkColors}}`;
  }
  return `:root{color-scheme:light dark}body{${kInterstitialBodyBase};${kInterstitialLightColors}}@media (prefers-color-scheme:dark){body{${kInterstitialDarkColors}}}`;
};

const writeInterstitial = (win, text) => {
  try {
    win.document.title = "Starting Claude Code…";
    win.document.body.innerHTML = "";
    win.document.write(
      `<style>${interstitialStyle()}</style><body>${text}</body>`,
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Consent memory for the LOCAL path: valid only while the stored scope still
// matches BOTH the configured permission mode AND the configured cwd
// (changing either invalidates the consent). An unknown mode never asserts
// consent.
export const hasLocalConsent = ({ permissionMode, cwd } = {}) => {
  const mode = String(permissionMode || "");
  if (!mode) return false;
  const stored = readUiSettings()[kLocalConfirmedScopeUiSettingKey];
  return (
    Boolean(stored) &&
    typeof stored === "object" &&
    stored.permissionMode === mode &&
    stored.cwd === String(cwd || "")
  );
};

export const storeLocalConsent = ({ permissionMode, cwd } = {}) => {
  updateUiSettings((settings) => ({
    ...settings,
    [kLocalConfirmedScopeUiSettingKey]: {
      permissionMode: String(permissionMode || ""),
      cwd: String(cwd || ""),
    },
  }));
};

export const useClaudeCodeLauncher = ({ enabled = true, onBeforeOpen = null } = {}) => {
  // Status is COSMETIC only (tooltip + live-dot + local-first ROUTING HINT):
  // a stale hint costs one refused local POST (which falls back or toasts),
  // never a wrong billed action. It refreshes on window focus (the natural
  // moment after configuring the routine in another tab) and envars.js
  // invalidates the key on save — without those, one fetch per page load
  // would leave the cue stale until a full reload. Three-way: true / false
  // (server-confirmed) / null (unknown — never assert setup guidance on a
  // transient status failure).
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
  const local = statusData?.local || null;
  const localState = local?.enabled === true ? local.state : null;
  const tooltip =
    localState === "running"
      ? "Opens this box's rescue Claude Code session"
      : localState === "ready" || localState === "starting"
        ? "Starts a rescue Claude Code session on this box and opens it"
        : configured === true
          ? "Fires your Claude Code routine (autonomous run on your claude.ai account) and opens the new session"
          : configured === false
            ? "Opens claude.ai/code. Set CLAUDE_CODE_ROUTINE_URL and CLAUDE_CODE_ROUTINE_TOKEN in Envars for one-click sessions."
            : "Opens claude.ai/code.";
  // Live-dot = "a configured launch path exists": today's routine rule OR a
  // RUNNING local session. No other local state lights it, and local states
  // never suppress the routine clause.
  const liveDot = configured === true || localState === "running";
  const liveDotTitle =
    localState === "running"
      ? "Rescue session running on this box — a click opens it"
      : "Routine configured — a click starts a session";

  // Routing hint read at click time (ref, not the render-scoped value: the
  // click handler must see the freshest cached status, not the closure's).
  const statusRef = useRef(null);
  statusRef.current = statusData;

  const [launching, setLaunching] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Which path the pending confirmation belongs to — drives the modal copy.
  // Mirrored in a ref because confirmStart must read the value that was
  // current when the modal OPENED, not a possibly-stale render closure.
  const [confirmContext, setConfirmContext] = useState({
    mode: "routine",
    permissionMode: null,
    cwd: null,
  });
  const confirmContextRef = useRef({
    mode: "routine",
    permissionMode: null,
    cwd: null,
  });
  // Synchronous re-entrancy lock: state alone can double-fire between
  // renders. Held from click through EVERY terminal outcome — including
  // across a pending confirmation modal (releasing in a naive finally would
  // let re-clicks open more placeholders while the modal waits).
  const launchingRef = useRef(false);
  const pendingWinRef = useRef(null);
  // The placeholder tab, tracked from open through settle — NOT just while the
  // confirm modal waits (pendingWinRef). Unmount during the initial fire would
  // otherwise orphan the about:blank tab. Doubles as the 202-poll cancel
  // signal: the loop stops when this ref no longer points at its window.
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

  const openConfirmModal = useCallback((win, mode, scope = {}) => {
    // Keep the lock and the placeholder; the modal takes over. Start
    // re-fires with confirmed:true on this SAME still-same-origin
    // window, so no second window.open (and no popup risk) is needed.
    pendingWinRef.current = win;
    confirmPendingRef.current = true;
    confirmContextRef.current = {
      mode,
      permissionMode: scope.permissionMode ?? null,
      cwd: scope.cwd ?? null,
    };
    setConfirmContext(confirmContextRef.current);
    writeInterstitial(win, "Waiting for your confirmation in AlphaClaw…");
    setConfirmOpen(true);
  }, []);

  // Today's routine fire, unchanged behavior: the local branch falls back
  // onto this exact function so the fallback stays byte-for-byte.
  const fireRoutine = useCallback(
    async (win, confirmed) => {
      try {
        const result = await createClaudeCodeSession({ confirmed });
        settle(win, result, null);
      } catch (error) {
        if (error?.code === "confirm_required") {
          openConfirmModal(win, "routine");
          return;
        }
        settle(win, null, error);
      }
    },
    [settle, openConfirmModal],
  );

  // Shared by the POST-time 409 refusal trio AND the mid-poll terminal
  // states: re-fires today's routine byte-for-byte on the SAME window.
  // needs_login also shows the one-time setup toast pointing at the
  // Watchdog page (once ever, persisted).
  const fallBackToRoutine = useCallback(
    async (win, code) => {
      if (
        code === "needs_login" &&
        readUiSettings()[kLocalSetupToastShownUiSettingKey] !== true
      ) {
        updateUiSettings((settings) => ({
          ...settings,
          [kLocalSetupToastShownUiSettingKey]: true,
        }));
        showToast(
          "Set up local rescue sessions from the Watchdog page",
          "info",
          { durationMs: kLongToastMs },
        );
      }
      if (win && !win.closed) {
        writeInterstitial(win, kStartingInterstitialText);
      }
      const routineConfirmed =
        readUiSettings()[kFireConfirmedUiSettingKey] === true;
      await fireRoutine(win, routineConfirmed);
    },
    [fireRoutine],
  );

  // 202-starting poll: the server owns the 60s URL watchdog, this loop just
  // relays its conclusion to the held popup. Cancellation is implicit —
  // activeWinRef moving off `win` (settle/release/unmount) ends the loop.
  const pollLocalSession = useCallback(
    async (win) => {
      const startedAtMs = Date.now();
      let switchedText = false;
      for (;;) {
        if (activeWinRef.current !== win) return;
        const elapsedMs = Date.now() - startedAtMs;
        if (elapsedMs >= kLocalPollTimeoutMs) {
          settle(
            win,
            null,
            new Error(
              "Timed out waiting for the rescue session URL — check the rescue card on the Watchdog page",
            ),
          );
          return;
        }
        if (!switchedText && elapsedMs >= kLocalUrlWaitTextAfterMs) {
          switchedText = true;
          writeInterstitial(win, kLocalUrlWaitInterstitialText);
        }
        await sleep(kLocalPollIntervalMs);
        if (activeWinRef.current !== win) return;
        let status = null;
        try {
          status = await fetchClaudeCodeStatusDirect();
        } catch {
          // Transient poll failure: keep polling until the cap decides.
          continue;
        }
        const localNow = status?.local || null;
        if (localNow?.state === "running" && localNow.sessionUrl) {
          settle(win, { sessionUrl: localNow.sessionUrl }, null);
          return;
        }
        if (
          localNow?.state === "needs_login" ||
          localNow?.state === "disabled" ||
          localNow?.state === "not_installed"
        ) {
          // The server's auth gate can conclude a start in needs_login (and
          // an operator can disable/uninstall mid-start): stop polling and
          // run the SAME routine fallback as the POST-time 409 trio, on
          // this same window.
          await fallBackToRoutine(win, localNow.state);
          return;
        }
        if (localNow?.state === "error") {
          settle(
            win,
            null,
            new Error(
              localNow.error?.message ||
                "The rescue Claude Code session failed to start",
            ),
          );
          return;
        }
      }
    },
    [settle, fallBackToRoutine],
  );

  const fireLocal = useCallback(
    async (win, { confirmed = false, permissionMode = null } = {}) => {
      try {
        const result = await createClaudeCodeLocalSession({
          confirmed,
          permissionMode,
        });
        if (result?.status === "starting") {
          pollLocalSession(win);
          return;
        }
        settle(win, result, null);
      } catch (error) {
        const code = error?.code;
        if (code === "confirm_required") {
          openConfirmModal(win, "local", {
            permissionMode: statusRef.current?.local?.permissionMode || null,
            cwd: statusRef.current?.local?.cwd || null,
          });
          return;
        }
        if (
          code === "disabled" ||
          code === "not_installed" ||
          code === "needs_login"
        ) {
          // FALL BACK to the routine fire on the SAME window — today's path.
          await fallBackToRoutine(win, code);
          return;
        }
        // 502/busy/login_in_progress/network: close + toast, deliberately NO
        // routine fallback — an unexpected local failure must never silently
        // become a billable cloud run (consent rule).
        try {
          win?.close();
        } catch {}
        showToast(
          error?.message || "Could not start the rescue Claude Code session",
          "error",
          { durationMs: kLongToastMs },
        );
        release();
      }
    },
    [settle, openConfirmModal, pollLocalSession, fallBackToRoutine, release],
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
      // Local-first only on a plausible cached hint: local block present,
      // enabled, and not conclusively out (disabled / not_installed).
      // needs_login/error/probing still ATTEMPT — the server's refusal codes
      // route to fallback or toast. Unknown/absent local → routine unchanged.
      const localHint = statusRef.current?.local || null;
      const localPlausible =
        Boolean(localHint) &&
        localHint.enabled === true &&
        localHint.state !== "disabled" &&
        localHint.state !== "not_installed";
      if (win) {
        writeInterstitial(
          win,
          localPlausible ? kLocalStartingInterstitialText : kStartingInterstitialText,
        );
      }
      if (localPlausible) {
        fireLocal(win, {
          confirmed: hasLocalConsent({
            permissionMode: localHint.permissionMode,
            cwd: localHint.cwd,
          }),
          permissionMode: localHint.permissionMode || null,
        });
        return;
      }
      const confirmed = readUiSettings()[kFireConfirmedUiSettingKey] === true;
      fireRoutine(win, confirmed);
    },
    [fireLocal, fireRoutine, onBeforeOpen],
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
    const { mode, permissionMode, cwd } = confirmContextRef.current;
    if (mode === "local") {
      storeLocalConsent({ permissionMode, cwd });
      if (win && !win.closed) {
        writeInterstitial(win, kLocalStartingInterstitialText);
      }
      fireLocal(win, { confirmed: true, permissionMode });
      return;
    }
    updateUiSettings((settings) => ({
      ...settings,
      [kFireConfirmedUiSettingKey]: true,
    }));
    if (win && !win.closed) {
      writeInterstitial(win, kStartingInterstitialText);
    }
    fireRoutine(win, true);
  }, [fireLocal, fireRoutine]);

  const confirmCancel = useCallback(() => {
    try {
      pendingWinRef.current?.close();
    } catch {}
    release();
  }, [release]);

  // Unmount mid-launch (a pending modal OR an in-flight initial fire): close
  // the orphan placeholder and release the lock so a remount starts clean.
  // Clearing activeWinRef also stops a 202 poll still in flight.
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
    liveDot,
    liveDotTitle,
    launching,
    confirmOpen,
    confirmMode: confirmContext.mode,
    confirmPermissionMode: confirmContext.permissionMode,
    openClaudeCode,
    confirmStart,
    confirmCancel,
  };
};
