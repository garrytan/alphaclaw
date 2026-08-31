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

// The Remote Control session URL as the TUI renders it (optionally with the
// ?from=cli query). The id charset/length mirrors the launcher's session-id
// validation discipline: the extracted URL is CANONICALIZED — the browser
// only ever navigates to https://claude.ai/code/<id>, never to a raw string
// scraped out of a PTY (claude-code-service.js applies the same rule to the
// routine-fire response).
const kRemoteControlUrlPattern =
  /https:\/\/claude\.ai\/code\/([A-Za-z0-9_-]{8,})(?:\?\S*)?/;

const extractRemoteControlUrl = (text) => {
  const match = stripAnsi(text).match(kRemoteControlUrlPattern);
  if (!match) return null;
  const sessionId = match[1];
  return { sessionId, sessionUrl: `https://claude.ai/code/${sessionId}` };
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
  extractOauthUrl,
  detectAuthGateError,
  detectTrustPrompt,
  detectAwaitingCode,
  detectLoginSuccess,
  detectLoginFailure,
  detectBridgeDisconnect,
};
