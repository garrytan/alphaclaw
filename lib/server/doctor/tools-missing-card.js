const { kMissingKinds, kToolsMissingSourceKeyPrefix } = require("../tool-inventory");

const kContainerIdPattern = /^[a-f0-9]{32}$/;
const kMaxEvidenceNames = 50;

// One card while names a rebuild took away are still missing (toolInventory
// getStatus()). Container-scoped sourceKey: a person's dismissal clears the
// names (routes/doctor.js), and a later rebuild that loses more starts a new
// card. No card once every name is seen on PATH again.
const buildToolsMissingCard = (toolInventory, { sanitize = (text) => String(text ?? "") } = {}) => {
  const outstanding = Array.isArray(toolInventory?.outstanding) ? toolInventory.outstanding : [];
  if (!outstanding.length || !kContainerIdPattern.test(String(toolInventory.containerId || ""))) return [];
  const namesOf = (kind) => outstanding.filter((entry) => entry.kind === kind).map((entry) => sanitize(entry.name));
  const lost = namesOf(kMissingKinds.HAND_INSTALL_LOST);
  const dropped = namesOf(kMissingKinds.IMAGE_DROPPED);
  const binDir = sanitize(toolInventory.binDir || "");
  const parts = [];
  if (lost.length) parts.push(`Installed by hand inside an earlier container and removed by a redeploy: ${lost.join(", ")}.`);
  if (dropped.length) parts.push(`No longer shipped by the image: ${dropped.join(", ")}.`);
  return [{
    sourceKey: `${kToolsMissingSourceKeyPrefix}${toolInventory.containerId}`,
    priority: "P1",
    category: "workspace state",
    title: outstanding.length === 1 ? "A tool went missing in a rebuild" : "Tools went missing in a rebuild",
    summary: `${parts.join(" ")} Commands and skills that call them fail until they are back.`,
    recommendation: `Ask for them to be added to the image, or put a statically linked copy in ${binDir}. ` +
      "Dismiss this card if you no longer need them.",
    evidence: outstanding.slice(0, kMaxEvidenceNames).map((entry) => ({
      type: "text",
      text: sanitize(`${entry.name}: ${entry.kind === kMissingKinds.HAND_INSTALL_LOST ? "hand install lost" : "dropped from the image"} since ${entry.missingSince || "unknown"}`),
    })),
    targetPaths: [],
    fixPrompt: `A redeploy removed these commands from PATH: ${[...lost, ...dropped].join(", ")}. ` +
      `For each one the agent needs, put a statically linked build in ${binDir} (\`ldd <file>\` must say "not a dynamic executable"; ` +
      "a copy of an apt binary is dynamic and breaks again on the next redeploy), or install it with uv or pipx into ~/.local/bin. " +
      "Never use apt-get or npm -g for a tool you need after a redeploy. If a tool belongs in the image, tell the owner which one and why.",
  }];
};

module.exports = { buildToolsMissingCard };
