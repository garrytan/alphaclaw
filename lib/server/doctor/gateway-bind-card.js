// det:gateway-bind-exposed (GST-2134): AlphaClaw checks every /hooks delivery
// at its own edge, but a gateway bound beyond loopback also answers /hooks/*
// on its own port, where those checks never run. AlphaClaw's onboarding binds
// loopback, so this only fires on a box someone changed. Never changes the key.
const buildGatewayBindCard = (bind) => {
  const value = typeof bind === "string" ? bind.trim() : "";
  if (!value || value === "loopback") return null;
  return {
    sourceKey: `det:gateway-bind-exposed:${value.slice(0, 40)}`,
    priority: "P2",
    category: "security",
    title: "The gateway listens beyond this machine, so /hooks can skip AlphaClaw's checks",
    summary:
      `gateway.bind is "${value.slice(0, 40)}", so the OpenClaw gateway accepts connections on its own port from other ` +
      "machines, containers or proxies. A /hooks delivery sent there goes straight to the gateway and skips AlphaClaw's " +
      "per-client failure limit, the closed built-in hooks and the request log. Deliveries through AlphaClaw's own " +
      "address are unaffected.",
    recommendation:
      "Point every proxy that forwards /hooks at AlphaClaw instead of the gateway port, then set gateway.bind back to " +
      "\"loopback\" at a planned restart. AlphaClaw does not change this setting for you.",
    evidence: [{ type: "text", text: `gateway.bind: ${value.slice(0, 40)}` }],
    targetPaths: [],
    fixPrompt:
      "Do not edit workspace files or openclaw.json for this. Report to the operator: gateway.bind is not loopback, so " +
      "/hooks deliveries can reach the gateway without AlphaClaw's edge checks. Suggest repointing any proxy that " +
      "forwards /hooks to AlphaClaw and setting gateway.bind to loopback at a planned restart.",
  };
};

module.exports = { buildGatewayBindCard };
