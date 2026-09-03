// Agent-actor read redaction for the merged status: the session URL and the
// login OAuth URL have no reason to enter an agent transcript. sessionUrl is
// now the AlphaClaw rescue capability URL (/rescue/<token>) — /rescue/:token
// is UNAUTHENTICATED (the token is the credential), so an agent that learns
// it holds a live link to a remote-controlled shell on this box. Stripping
// it here is a real boundary, not just hygiene. Error tails / warnings can
// carry arbitrary box content scraped from the rescue terminal.
const redactLocalStatus = (body) => {
  if (!body || typeof body !== "object" || !body.local || typeof body.local !== "object") {
    return body;
  }
  const local = { ...body.local };
  delete local.sessionUrl;
  // sessionId reconstructs the URL canonically (tui.js), so redacting the
  // URL alone would be theater.
  delete local.sessionId;
  delete local.socketPath;
  if (local.login && typeof local.login === "object") {
    local.login = { ...local.login };
    delete local.login.oauthUrl;
  }
  if (local.error && typeof local.error === "object") {
    local.error = { ...local.error };
    delete local.error.tailSanitized;
  }
  delete local.warnings;
  return { ...body, local };
};

// Shared rationale for every denied op below: each one lets its holder stand
// up (or steer/inspect) a remote-controlled shell with acceptEdits on this
// box — the same privilege escalation the original claude-code.session
// denial documents. Human operators (browser session auth) are unaffected;
// tiers gate only the agent actor.
module.exports = {
  domain: "claude-code",
  title: "Claude Code Launcher",
  ops: [
    {
      id: "claude-code.status",
      title: "Launcher availability + local rescue state (redacted)",
      method: "GET",
      path: "/api/claude-code/status",
      tier: "safe",
      redactResponse: redactLocalStatus,
      notes:
        "The local block's sessionUrl, sessionId, login.oauthUrl, error tail, and warnings are stripped for the agent actor.",
    },
    {
      // tier "denied", not "write": firing starts an autonomous,
      // prompt-injectable, subscription-billing Claude Code run on the
      // operator's personal claude.ai account. The agent actor must never be
      // able to trigger that; human operators (browser session auth) are
      // unaffected — tiers gate only the agent actor.
      id: "claude-code.session",
      title: "Fire the Claude Code routine (humans only)",
      method: "POST",
      path: "/api/claude-code/session",
      tier: "denied",
    },
    {
      id: "claude-code.local.session",
      title: "Start the local rescue session (humans only)",
      method: "POST",
      path: "/api/claude-code/local/session",
      tier: "denied",
    },
    {
      id: "claude-code.local.session-stop",
      title: "Stop the local rescue session (humans only)",
      method: "POST",
      path: "/api/claude-code/local/session/stop",
      tier: "denied",
    },
    {
      id: "claude-code.local.login",
      title: "Start the rescue Claude login (humans only)",
      method: "POST",
      path: "/api/claude-code/local/login",
      tier: "denied",
    },
    {
      id: "claude-code.local.login-code",
      title: "Submit the rescue login code (humans only)",
      method: "POST",
      path: "/api/claude-code/local/login/code",
      tier: "denied",
    },
    {
      id: "claude-code.local.login-cancel",
      title: "Cancel the rescue Claude login (humans only)",
      method: "POST",
      path: "/api/claude-code/local/login/cancel",
      tier: "denied",
    },
    {
      id: "claude-code.local.logout",
      title: "Remove the rescue Claude credentials (humans only)",
      method: "POST",
      path: "/api/claude-code/local/logout",
      tier: "denied",
    },
    {
      id: "claude-code.local.tail",
      title: "Read the rescue terminal tail (humans only)",
      method: "GET",
      path: "/api/claude-code/local/tail",
      tier: "denied",
    },
  ],
};
