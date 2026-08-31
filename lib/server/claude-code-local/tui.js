// Pure parsers for claude CLI terminal output (tmux capture-pane / script(1)
// buffers). Everything here is fixture-driven: the verbatim buffers live in
// tests/server/fixtures/claude-code-tui/ and were captured from a real
// claude binary — when a claude version bump changes a screen, re-capture the
// fixture and fix the detector in the same commit (the Dockerfile pin and the
// fixtures move together). No I/O, no state: string in, structured data out.

// CSI (colors/cursor), OSC (titles), charset designation, and the short
// ESC-letter forms. tmux capture-pane -p already strips most of these, but
// script(1) buffers arrive raw, and defensive stripping costs nothing.
const kCsiPattern = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const kOscPattern = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const kCharsetPattern = /\x1b[()][0-9A-Za-z]/g;
const kBareEscPattern = /\x1b[=>78]/g;

const stripAnsi = (text) =>
  String(text || "")
    .replace(kOscPattern, "")
    .replace(kCsiPattern, "")
    .replace(kCharsetPattern, "")
    .replace(kBareEscPattern, "")
    // Cursor-visibility fragments survive when the ESC byte was consumed by a
    // partial capture: "[?25l" / "[?25h" interleave into spinner lines.
    .replace(/\[\?25[lh]/g, "")
    .replace(/\r/g, "");

// The Remote Control URLs as the TUI renders them. Two shapes exist
// (fixture rc-url-screen.txt, captured live from `claude remote-control`
// v2.1.237):
//   - environment form: https://claude.ai/code?environment=env_<id> — the
//     persistent server's banner ("Continue coding in the Claude mobile app
//     or …"), the stable entry point for this box.
//   - session form: https://claude.ai/code/<sessionId> — printed per
//     attached session.
// Either way the extracted URL is CANONICALIZED — the browser only ever
// navigates to a rebuilt https://claude.ai/… string, never to a raw string
// scraped out of a PTY (claude-code-service.js applies the same rule to the
// routine-fire response).
const kRemoteControlSessionUrlPattern =
  /https:\/\/claude\.ai\/code\/([A-Za-z0-9_-]{8,})(?:\?\S*)?/;
const kRemoteControlEnvironmentUrlPattern =
  /https:\/\/claude\.ai\/code\?environment=(env_[A-Za-z0-9]+)/;

const extractRemoteControlUrl = (text) => {
  const visible = stripAnsi(text);
  const sessionMatch = visible.match(kRemoteControlSessionUrlPattern);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    return { sessionId, sessionUrl: `https://claude.ai/code/${sessionId}` };
  }
  const envMatch = visible.match(kRemoteControlEnvironmentUrlPattern);
  if (envMatch) {
    const environmentId = envMatch[1];
    return {
      sessionId: environmentId,
      sessionUrl: `https://claude.ai/code?environment=${environmentId}`,
    };
  }
  return null;
};

// Adoption-time variant: a live rescue terminal's scrollback contains
// arbitrary echoed content (logs, fetched pages), so a bare whole-buffer
// regex could adopt an attacker-echoed lookalike URL. Anchor on the CLI's
// own banner lines first; only fall back to the generic scan when no banner
// survived the scroll window.
const kBannerLinePattern =
  /Continue coding in|visit claude\.ai\/code|Resume with:|Scan with your phone/i;

const extractRemoteControlUrlFromBanner = (text) => {
  for (const line of stripAnsi(text).split("\n")) {
    if (!kBannerLinePattern.test(line)) continue;
    const found = extractRemoteControlUrl(line);
    if (found) return found;
  }
  return extractRemoteControlUrl(text);
};

// `claude auth login` prints its authorize URL on claude.com with a
// /cai/oauth/ path (fixture auth-login-oauth-url.txt) — NOT claude.ai. Accept
// the sibling hosts too so a host migration degrades to "still works" instead
// of a broken login modal; anything outside the allowlist is rejected so a
// hostile buffer can never plant an arbitrary link in the UI.
const kOauthUrlPattern =
  /https:\/\/(?:claude\.(?:ai|com)|console\.anthropic\.com)\/[^\s"'`]*oauth[^\s"'`]*/i;

const extractOauthUrl = (text) => {
  const match = stripAnsi(text).match(kOauthUrlPattern);
  return match ? match[0] : null;
};

// Remote Control auth-gate screens (fixture rc-needs-login.txt). The gate
// checks login state before the ANTHROPIC_API_KEY conflict, so needs_login is
// the common failure; the env/subscription variants come from the binary's
// error-string table and fire when a login exists but is the wrong kind.
const detectAuthGateError = (text) => {
  const visible = stripAnsi(text);
  if (/Unset ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN .* to use Remote Control/i.test(visible)) {
    return "env_conflict";
  }
  if (/requires a claude\.ai subscription/i.test(visible)) {
    return "subscription_required";
  }
  if (
    /must be logged in to use Remote Control/i.test(visible) ||
    /only available with claude\.ai subscriptions/i.test(visible)
  ) {
    return "needs_login";
  }
  return null;
};

// First-run prompts the spawn watcher auto-answers with "1" + Enter. The
// pre-seeded home/.claude.json makes these a backstop, not the primary path.
const detectTrustPrompt = (text) => {
  const visible = stripAnsi(text);
  return (
    /trust (?:the files in )?this (?:folder|directory)/i.test(visible) ||
    /Bypass Permissions mode/i.test(visible)
  );
};

// `claude remote-control` confirms before registering the bridge (fixture
// rc-enable-prompt.txt); the watcher answers "y" + Enter once. The prompt
// stays on screen after being answered, so callers debounce on their side.
const detectRemoteControlConfirm = (text) =>
  /Enable Remote Control\? \(y\/n\)/i.test(stripAnsi(text));

// The non-interactive subcommand EXITS (no dialog) when the workspace is not
// trusted (fixture rc-workspace-not-trusted.txt). ensureWorkspaceTrust()
// pre-seeds trust so this never fires; the detector is defense in depth for
// a future CLI that changes the seed format — the error message it produces
// is actionable instead of a generic spawn failure.
const detectWorkspaceNotTrusted = (text) =>
  /Workspace not trusted/i.test(stripAnsi(text));

// Login-flow phase detectors. awaiting-code is fixture-pinned; the
// success/failure strings are provisional — the flow's AUTHORITATIVE success
// signal is a `claude auth status` re-probe, so a missed string here costs a
// poll interval, never a wrong verdict.
const detectAwaitingCode = (text) =>
  /Paste code here if prompted/i.test(stripAnsi(text));

const detectLoginSuccess = (text) =>
  /login successful|logged in as|successfully logged in/i.test(stripAnsi(text));

const detectLoginFailure = (text) =>
  /invalid (?:code|grant)|code (?:is )?expired|login failed|oauth error/i.test(
    stripAnsi(text),
  );

// Best-effort bridge-health warning while running: purely cosmetic (a status
// warning), never a state transition — the strings are not fixture-backed.
const detectBridgeDisconnect = (text) =>
  /remote control[^\n]*(?:disconnect|reconnect)|(?:disconnect|reconnect)[^\n]*remote control/i.test(
    stripAnsi(text),
  );

module.exports = {
  stripAnsi,
  extractRemoteControlUrl,
  extractRemoteControlUrlFromBanner,
  extractOauthUrl,
  detectAuthGateError,
  detectTrustPrompt,
  detectRemoteControlConfirm,
  detectWorkspaceNotTrusted,
  detectAwaitingCode,
  detectLoginSuccess,
  detectLoginFailure,
  detectBridgeDisconnect,
};
