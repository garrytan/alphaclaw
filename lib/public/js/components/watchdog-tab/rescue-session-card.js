import { h } from "preact";
import htm from "htm";
import { useCallback, useMemo, useState } from "preact/hooks";
import qrcodeGenerator from "qrcode-generator";
import { useClaudeCodeLocal } from "../../hooks/use-claude-code-local.js";
import {
  hasLocalConsent,
  storeLocalConsent,
} from "../../hooks/use-claude-code-launcher.js";
import { ClaudeCodeConfirmModal } from "../claude-code-confirm-modal.js";
import { ClaudeCodeLocalSetupModal } from "../claude-code-local-setup-modal.js";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { showToast } from "../toast.js";
import { copyTextToClipboard } from "../../lib/clipboard.js";
import { formatRelativeTime } from "../../lib/format.js";
import { useNowMs } from "../../hooks/use-now-ms.js";

const html = htm.bind(h);

// Exported: the badge map doubles as the card's full-state test matrix.
export const kRescueStateBadge = {
  probing: { tone: "neutral", label: "Probing" },
  disabled: { tone: "neutral", label: "Disabled" },
  not_installed: { tone: "warning", label: "Not installed" },
  needs_login: { tone: "warning", label: "Login needed" },
  login_in_progress: { tone: "info", label: "Logging in" },
  ready: { tone: "success", label: "Ready" },
  starting: { tone: "info", label: "Starting" },
  running: { tone: "success", label: "Running" },
  stopping: { tone: "info", label: "Stopping" },
  error: { tone: "danger", label: "Error" },
};

const kQrQuietZoneModules = 2;

// Pure QR model (exported for the known-vector test): one SVG path covering
// every dark module, deterministic for a given URL. Returns null on any
// encode failure — the card then renders the plain URL only (registry row:
// "QR encoder | encode failure | render plain URL only").
export const buildRescueQrModel = (url) => {
  const text = String(url || "");
  if (!text) return null;
  try {
    const qr = qrcodeGenerator(0, "M");
    qr.addData(text);
    qr.make();
    const moduleCount = qr.getModuleCount();
    const pathParts = [];
    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount; col += 1) {
        if (qr.isDark(row, col)) {
          pathParts.push(
            `M${col + kQrQuietZoneModules},${row + kQrQuietZoneModules}h1v1h-1z`,
          );
        }
      }
    }
    return {
      moduleCount,
      viewBoxSize: moduleCount + kQrQuietZoneModules * 2,
      path: pathParts.join(""),
    };
  } catch {
    return null;
  }
};

// QR carries an aria-label AND the plain selectable URL always renders
// beside it (D16 — never QR-only).
const RescueQr = ({ url }) => {
  const model = useMemo(() => buildRescueQrModel(url), [url]);
  if (!model) return null;
  return html`
    <svg
      role="img"
      aria-label="QR code for the rescue session URL"
      viewBox="0 0 ${model.viewBoxSize} ${model.viewBoxSize}"
      width="112"
      height="112"
      shape-rendering="crispEdges"
      class="rounded border border-border bg-white"
    >
      <rect width="100%" height="100%" fill="#ffffff" />
      <path d=${model.path} fill="#000000" />
    </svg>
  `;
};

// Watchdog rescue-session card: state + lifecycle controls for the local
// Claude Code rescue session. The card never writes env itself — permission
// mode / autostart / cwd are edited on the Envars page.
export const WatchdogRescueSessionCard = () => {
  const { local, refresh, start, stop, login, logout, fetchTail } =
    useClaudeCodeLocal({ enabled: true });
  const nowMs = useNowMs(30_000, { enabled: Boolean(local?.startedAt) });
  const [setupOpen, setSetupOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [tail, setTail] = useState("");
  const [tailVisible, setTailVisible] = useState(false);

  const doStart = useCallback(
    async (confirmed) => {
      if (working) return;
      setWorking(true);
      try {
        const result = await start({
          confirmed,
          permissionMode: local?.permissionMode || null,
        });
        showToast(
          result?.status === "running"
            ? "Rescue session is running"
            : "Rescue session starting — the URL appears here shortly",
          "success",
        );
      } catch (error) {
        if (error?.code === "confirm_required") {
          setConfirmOpen(true);
          return;
        }
        showToast(
          error?.message || "Could not start the rescue session",
          "error",
        );
      } finally {
        setWorking(false);
      }
    },
    [working, start, local],
  );

  const onStartClick = useCallback(() => {
    // Same per-path consent memory as the sidebar launcher: consent is keyed
    // to the permission mode AND the configured cwd, so changing either
    // re-confirms here too.
    doStart(
      hasLocalConsent({
        permissionMode: local?.permissionMode,
        cwd: local?.cwd,
      }),
    );
  }, [doStart, local]);

  const onConfirmStart = useCallback(() => {
    storeLocalConsent({
      permissionMode: local?.permissionMode,
      cwd: local?.cwd,
    });
    setConfirmOpen(false);
    doStart(true);
  }, [doStart, local]);

  const onStopClick = useCallback(async () => {
    if (working) return;
    setWorking(true);
    try {
      await stop();
      showToast("Rescue session stopped", "success");
    } catch (error) {
      showToast(error?.message || "Could not stop the rescue session", "error");
    } finally {
      setWorking(false);
    }
  }, [working, stop]);

  const onLogoutClick = useCallback(async () => {
    if (working) return;
    setWorking(true);
    try {
      await logout();
      showToast("Logged out of Claude on this box", "success");
    } catch (error) {
      showToast(error?.message || "Could not log out", "error");
    } finally {
      setWorking(false);
    }
  }, [working, logout]);

  const onCopyAttach = useCallback(async () => {
    const line = `tmux -S ${local?.socketPath} attach -t ${local?.sessionName || "alphaclaw-rescue"}`;
    const copied = await copyTextToClipboard(line);
    showToast(
      copied ? "Attach command copied" : "Could not copy the attach command",
      copied ? "success" : "error",
    );
  }, [local]);

  const onToggleTail = useCallback(async () => {
    if (tailVisible) {
      setTailVisible(false);
      return;
    }
    setTailVisible(true);
    try {
      const result = await fetchTail({ source: "session" });
      setTail(String(result?.tail || ""));
    } catch (error) {
      setTail(error?.message || "No CLI output available.");
    }
  }, [tailVisible, fetchTail]);

  // Old server / feature not wired: no local block, no card (additive UI).
  if (!local) return null;

  const state = local.state || "probing";
  const badge = kRescueStateBadge[state] || kRescueStateBadge.probing;
  // enabled=0 with a session still live (E2): the kill switch must never cut
  // off an operator mid-rescue, so the card collapses to stop-only.
  const disabledWithLiveSession = state === "disabled" && Boolean(local.startedAt);
  const modeDrift =
    Boolean(local.livePermissionMode) &&
    local.permissionMode !== local.livePermissionMode;

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <h2 class="card-label">Rescue Claude Code session</h2>
          <${Badge} tone=${badge.tone}>${badge.label}</${Badge}>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          ${state === "needs_login"
            ? html`<${ActionButton}
                onClick=${() => setSetupOpen(true)}
                tone="primary"
                idleLabel="Log in to Claude"
              />`
            : null}
          ${state === "login_in_progress"
            ? html`<${ActionButton}
                onClick=${() => setSetupOpen(true)}
                tone="secondary"
                idleLabel="Continue login"
              />`
            : null}
          ${state === "ready" || state === "error"
            ? html`<${ActionButton}
                onClick=${onStartClick}
                tone="primary"
                idleLabel=${state === "error" ? "Retry start" : "Start session"}
                loadingLabel="Starting..."
                loading=${working}
              />`
            : null}
          ${state === "running" || state === "starting" || disabledWithLiveSession
            ? html`<${ActionButton}
                onClick=${onStopClick}
                tone="danger"
                idleLabel="Stop session"
                loadingLabel="Stopping..."
                loading=${working}
              />`
            : null}
          ${state === "ready"
            ? html`<${ActionButton}
                onClick=${onLogoutClick}
                tone="neutral"
                idleLabel="Log out"
                loading=${working}
              />`
            : null}
        </div>
      </div>

      <p class="text-xs text-fg-muted">
        A Claude Code instance running on this box, reachable from
        claude.ai/code — for fixing the box when the gateway is down. Uses
        your claude.ai subscription.
        ${local.claudeVersion ? ` CLI: claude ${local.claudeVersion}.` : ""}
        <a class="ac-tip-link" href="#/envars"> Edit settings in Envars →</a>
      </p>

      ${Array.isArray(local.warnings) && local.warnings.length > 0
        ? html`<ul class="space-y-1">
            ${local.warnings.map(
              (warning) => html`<li class="text-xs text-status-warning-muted">
                ${warning}
              </li>`,
            )}
          </ul>`
        : null}

      ${state === "not_installed"
        ? html`<p class="text-xs text-fg-muted">
            The claude CLI is not installed on this box — rescue sessions are
            unavailable. The sidebar button falls back to your routine.
          </p>`
        : null}

      ${state === "running"
        ? html`
            <div class="ac-surface-inset border border-border rounded-lg p-3 space-y-2">
              <div class="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                ${local.startedAt
                  ? html`<span>
                      running since
                      ${" "}${formatRelativeTime(local.startedAt, { nowMs })}
                    </span>`
                  : null}
                ${local.spawnedBy
                  ? html`<span>· started by ${local.spawnedBy}</span>`
                  : null}
                ${local.livePermissionMode
                  ? html`<${Badge} tone=${local.livePermissionMode === "bypassPermissions" ? "danger" : "secondary"}>
                      ${local.livePermissionMode}
                    </${Badge}>`
                  : null}
                ${modeDrift
                  ? html`<span class="text-status-warning-muted">
                      Configured mode is ${local.permissionMode} — restart the
                      session to apply.
                    </span>`
                  : null}
              </div>
              <div class="flex flex-wrap items-start gap-3">
                <${RescueQr} url=${local.sessionUrl} />
                <div class="min-w-0 space-y-1">
                  <a
                    class="ac-tip-link text-sm break-all select-all"
                    href=${local.sessionUrl}
                    target="_blank"
                    rel="noopener"
                    >${local.sessionUrl}</a
                  >
                  <p class="text-xs text-fg-muted">
                    Open on any device logged into your claude.ai account.
                  </p>
                </div>
              </div>
              ${local.hosting === "tmux"
                ? html`<div class="flex flex-wrap items-center gap-2">
                    <code class="text-xs ac-surface-inset border border-border rounded px-2 py-1 select-all break-all">
                      tmux -S ${local.socketPath} attach -t
                      ${" "}${local.sessionName || "alphaclaw-rescue"}
                    </code>
                    <${ActionButton}
                      onClick=${onCopyAttach}
                      tone="subtle"
                      idleLabel="Copy"
                    />
                  </div>`
                : null}
            </div>
          `
        : null}

      ${state === "error" && local.error
        ? html`
            <div class="ac-surface-inset border border-border rounded-lg p-3 space-y-2">
              <p class="text-xs text-status-error-muted">
                ${local.error.message || "The rescue session failed."}
              </p>
              <button
                type="button"
                class="ac-tip-link text-xs text-left py-2 -my-2"
                onclick=${onToggleTail}
              >
                ${tailVisible ? "Hide CLI output" : "Show CLI output"}
              </button>
              ${tailVisible
                ? html`<pre
                    class="border border-border rounded-lg p-2 text-xs overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto"
                  >
${tail || local.error.tailSanitized || "Loading CLI output…"}</pre
                  >`
                : null}
            </div>
          `
        : null}

      <${ClaudeCodeLocalSetupModal}
        visible=${setupOpen}
        local=${local}
        onClose=${() => {
          setSetupOpen(false);
          refresh();
        }}
        onBeginLogin=${login.begin}
        onSubmitCode=${login.submitCode}
        onCancelLogin=${login.cancel}
        onStartSession=${onStartClick}
        fetchTail=${fetchTail}
      />
      <${ClaudeCodeConfirmModal}
        visible=${confirmOpen}
        mode="local"
        permissionMode=${local.permissionMode}
        onStart=${onConfirmStart}
        onCancel=${() => setConfirmOpen(false)}
      />
    </div>
  `;
};
