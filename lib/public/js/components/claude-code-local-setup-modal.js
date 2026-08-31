import { h } from "preact";
import htm from "htm";
import { useCallback, useEffect, useState } from "preact/hooks";
import { ModalShell } from "./modal-shell.js";
import { ActionButton } from "./action-button.js";
import { LoadingSpinner } from "./loading-spinner.js";
import { showToast } from "./toast.js";

const html = htm.bind(h);

// Guided one-time claude.ai OAuth login for the local rescue session
// (plan D1a). The server drives `claude auth login` in a PTY; this modal
// mirrors its phases from the status poll the parent hook owns:
//   intro → starting → awaiting_code → verifying → success | failed
// Exported for tests: stage derivation is pure so every state renders
// deterministically from a status snapshot.
export const deriveSetupStage = (local, begunThisOpen = false) => {
  const phase = local?.login?.phase || null;
  if (local?.state === "login_in_progress") {
    if (phase === "awaiting_code") return "awaiting_code";
    if (phase === "verifying") return "verifying";
    return "starting";
  }
  if (phase === "failed") return "failed";
  if (begunThisOpen && phase === "success") return "success";
  return "intro";
};

export const ClaudeCodeLocalSetupModal = ({
  visible = false,
  local = null,
  onClose = () => {},
  onBeginLogin = () => {},
  onSubmitCode = () => {},
  onCancelLogin = () => {},
  onStartSession = () => {},
  fetchTail = null,
}) => {
  const [begunThisOpen, setBegunThisOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [tail, setTail] = useState("");
  const [tailVisible, setTailVisible] = useState(false);

  // Fresh slate per open: a previous attempt's pasted code or CLI tail must
  // never leak into the next one.
  useEffect(() => {
    if (!visible) return;
    setBegunThisOpen(false);
    setCode("");
    setBusy(false);
    setTail("");
    setTailVisible(false);
  }, [visible]);

  const stage = deriveSetupStage(local, begunThisOpen);
  const oauthUrl = local?.login?.oauthUrl || null;

  const handleClose = useCallback(() => {
    // Closing mid-flow abandons the login: cancel the server-side PTY so the
    // card does not stay in login_in_progress with nobody watching.
    if (local?.state === "login_in_progress") {
      Promise.resolve(onCancelLogin()).catch(() => {});
    }
    onClose();
  }, [local, onCancelLogin, onClose]);

  const handleBegin = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onBeginLogin();
      setBegunThisOpen(true);
    } catch (error) {
      showToast(error?.message || "Could not start the Claude login", "error");
    } finally {
      setBusy(false);
    }
  }, [busy, onBeginLogin]);

  const handleSubmitCode = useCallback(async () => {
    const trimmed = String(code || "").trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmitCode(trimmed);
      setCode("");
    } catch (error) {
      showToast(error?.message || "Could not submit the login code", "error");
    } finally {
      setBusy(false);
    }
  }, [code, busy, onSubmitCode]);

  const handleShowTail = useCallback(async () => {
    if (tailVisible) {
      setTailVisible(false);
      return;
    }
    setTailVisible(true);
    if (typeof fetchTail !== "function") return;
    try {
      const result = await fetchTail({ source: "login" });
      setTail(String(result?.tail || ""));
    } catch (error) {
      setTail(error?.message || "No CLI output available.");
    }
  }, [tailVisible, fetchTail]);

  const handleStartSession = useCallback(() => {
    onClose();
    onStartSession();
  }, [onClose, onStartSession]);

  return html`
    <${ModalShell} visible=${visible} onClose=${handleClose}>
      <h2 class="text-base font-semibold text-body">
        Set up local rescue sessions
      </h2>
      ${stage === "intro"
        ? html`
            <p class="text-sm text-fg-muted">
              A rescue session is a Claude Code instance running on this
              server — reachable from claude.ai/code (or your phone) even when
              the gateway is broken. It uses your claude.ai subscription and
              needs a one-time login.
            </p>
            <p class="text-sm text-fg-muted">
              Credentials are stored in a private directory on this server,
              never in .env.
            </p>
            <div class="flex justify-end gap-2 pt-1">
              <${ActionButton}
                tone="neutral"
                size="md"
                idleLabel="Cancel"
                onClick=${handleClose}
              />
              <${ActionButton}
                tone="primary"
                size="md"
                idleLabel="Log in with claude.ai"
                loadingLabel="Starting..."
                loading=${busy}
                onClick=${handleBegin}
              />
            </div>
          `
        : null}
      ${stage === "starting"
        ? html`
            <div class="flex items-center gap-2 text-sm text-fg-muted">
              <${LoadingSpinner} className="h-4 w-4" />
              <span>Starting the Claude CLI login…</span>
            </div>
            <div class="flex justify-end gap-2 pt-1">
              <${ActionButton}
                tone="neutral"
                size="md"
                idleLabel="Cancel"
                onClick=${handleClose}
              />
            </div>
          `
        : null}
      ${stage === "awaiting_code"
        ? html`
            <p class="text-sm text-fg-muted">
              1. Open the login link and approve access on claude.ai:
            </p>
            ${oauthUrl
              ? html`<a
                  class="ac-tip-link text-sm break-all"
                  href=${oauthUrl}
                  target="_blank"
                  rel="noopener"
                  >${oauthUrl}</a
                >`
              : html`<p class="text-sm text-fg-muted">Waiting for the login link…</p>`}
            <p class="text-sm text-fg-muted">
              2. Paste the code claude.ai shows you:
            </p>
            <input
              type="text"
              class="w-full bg-field border border-border rounded-lg px-3 py-2 text-base font-mono focus:border-fg-muted"
              placeholder="Paste the code here"
              value=${code}
              oninput=${(event) => setCode(event.target.value)}
              onkeydown=${(event) => {
                if (event.key === "Enter") handleSubmitCode();
              }}
            />
            <div class="flex justify-end gap-2 pt-1">
              <${ActionButton}
                tone="neutral"
                size="md"
                idleLabel="Cancel"
                onClick=${handleClose}
              />
              <${ActionButton}
                tone="primary"
                size="md"
                idleLabel="Submit"
                loadingLabel="Submitting..."
                loading=${busy}
                disabled=${!String(code || "").trim()}
                onClick=${handleSubmitCode}
              />
            </div>
          `
        : null}
      ${stage === "verifying"
        ? html`
            <div class="flex items-center gap-2 text-sm text-fg-muted">
              <${LoadingSpinner} className="h-4 w-4" />
              <span>Verifying the login with the Claude CLI…</span>
            </div>
            <div class="flex justify-end gap-2 pt-1">
              <${ActionButton}
                tone="neutral"
                size="md"
                idleLabel="Cancel"
                onClick=${handleClose}
              />
            </div>
          `
        : null}
      ${stage === "success"
        ? html`
            <p class="text-sm text-status-success-muted">
              Logged in. Rescue sessions are ready to start.
            </p>
            <div class="flex justify-end gap-2 pt-1">
              <${ActionButton}
                tone="neutral"
                size="md"
                idleLabel="Close"
                onClick=${onClose}
              />
              <${ActionButton}
                tone="primary"
                size="md"
                idleLabel="Start rescue session now"
                onClick=${handleStartSession}
              />
            </div>
          `
        : null}
      ${stage === "failed"
        ? html`
            <p class="text-sm text-status-error-muted">
              ${local?.login?.error || "The Claude login failed."}
            </p>
            <button
              type="button"
              class="ac-tip-link text-xs text-left py-2 -my-2"
              onclick=${handleShowTail}
            >
              ${tailVisible ? "Hide CLI output" : "Show CLI output"}
            </button>
            ${tailVisible
              ? html`<pre
                  class="ac-surface-inset border border-border rounded-lg p-2 text-xs overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto"
                >
${tail || "Loading CLI output…"}</pre
                >`
              : null}
            <div class="flex justify-end gap-2 pt-1">
              <${ActionButton}
                tone="neutral"
                size="md"
                idleLabel="Close"
                onClick=${handleClose}
              />
              <${ActionButton}
                tone="primary"
                size="md"
                idleLabel="Retry"
                loadingLabel="Starting..."
                loading=${busy}
                onClick=${handleBegin}
              />
            </div>
          `
        : null}
    </${ModalShell}>
  `;
};
