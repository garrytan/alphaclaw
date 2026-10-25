// det:node-options-signal-collision (ALPH-34): NODE_OPTIONS hooks a Node
// diagnostic flag to a signal OpenClaw uses for restarts. gatewayEnv()
// already drops it from the gateway's environment (node-options-signal-flags.js);
// this card tells the operator why and how to remove it at the source. The
// card names flags and signals only, never the rest of NODE_OPTIONS.
const kFlagEffects = {
  "--heapsnapshot-signal": "write a heap snapshot (the whole gateway heap, often hundreds of MB, with the gateway frozen while it writes)",
  "--report-on-signal": "write a Node diagnostic report",
};

const buildNodeOptionsSignalCard = (collisions = []) => {
  if (!Array.isArray(collisions) || collisions.length === 0) return null;
  const known = collisions.filter((entry) => kFlagEffects[entry?.flag] && /^SIGUSR[12]$/.test(entry?.signal));
  if (known.length === 0) return null;
  const listed = known.map(({ flag, signal }) => `${flag} (${signal})`);
  const effects = known.map(({ flag, signal }) => `on every ${signal} Node would ${kFlagEffects[flag]}`);
  return {
    sourceKey: `det:node-options-signal-collision:${known.map(({ flag, signal }) => `${flag.slice(2)}-${signal}`).join(",")}`,
    priority: "P1",
    category: "config",
    title: "NODE_OPTIONS sets a diagnostic signal that OpenClaw uses for restarts",
    summary:
      `NODE_OPTIONS contains ${listed.join(" and ")}. OpenClaw uses SIGUSR2 for every gateway restart request and ` +
      `\`openclaw gateway restart\` can send SIGUSR1, so ${effects.join("; ")}. A restart requested once a minute ` +
      "fills a disk in hours. AlphaClaw removes the flag from the gateway's environment, so the gateway is protected, " +
      "but the setting is still in your deployment.",
    recommendation:
      "Remove the flag from NODE_OPTIONS in the deployment's environment or .env, then delete any *.heapsnapshot " +
      "files it already wrote. If you need on-demand heap snapshots, choose a signal OpenClaw does not use " +
      "(not SIGUSR1 or SIGUSR2).",
    evidence: listed.map((text) => ({ type: "text", text: `NODE_OPTIONS: ${text}` })),
    targetPaths: [],
    fixPrompt:
      "Do not edit workspace files for this. Report to the operator: NODE_OPTIONS sets " +
      `${listed.join(" and ")}, a Node diagnostic hook on a signal OpenClaw uses for restarts. AlphaClaw already ` +
      "removes it from the gateway's environment. Suggest removing it from the deployment's NODE_OPTIONS and checking " +
      "the Node diagnostic directory for leftover *.heapsnapshot files.",
  };
};

module.exports = { buildNodeOptionsSignalCard };
