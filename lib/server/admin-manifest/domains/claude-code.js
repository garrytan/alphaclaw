module.exports = {
  domain: "claude-code",
  title: "Claude Code Launcher",
  ops: [
    {
      id: "claude-code.status",
      title: "Launcher availability (config presence only, never values)",
      method: "GET",
      path: "/api/claude-code/status",
      tier: "safe",
    },
    {
      // tier "denied", not "write": firing starts an autonomous,
      // prompt-injectable, subscription-billing Claude Code run on the
      // operator's personal claude.ai account. The agent actor must never be
      // able to trigger that; human operators (browser session auth) are
      // unaffected — tiers gate only the agent actor.
      id: "claude-code.session",
      title: "Fire the configured Claude Code routine (humans only)",
      method: "POST",
      path: "/api/claude-code/session",
      tier: "denied",
    },
  ],
};
