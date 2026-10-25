// Early-exit CLI verb predicate, extracted from bin/alphaclaw.js so the verb
// matrix is unit-testable without spawning the bin. It decides whether the
// boot placeholder binds the web port: these verbs process.exit() long before
// the server boots, so binding a placeholder for them would fight a live
// server for the port. Pure and side-effect free — safe to require anywhere.
//
// Every early-exit dispatch site in bin/alphaclaw.js (the pre-boot
// `if (command === ...) process.exit(...)` blocks) must have a matching arm
// here, and vice versa.
const isEarlyExitCliCommand = ({ command, commandScope, commandAction } = {}) =>
  command === "git-sync" ||
  command === "admin" ||
  // Read-only evidence bundle (issue #76 A9): dispatched right after the
  // root/port resolution, before the placeholder spawn and before section 2
  // mkdirs anything — it must never bind the port or touch the volume.
  command === "diagnose" ||
  (command === "doctor" &&
    commandScope === "finding" &&
    commandAction === "complete") ||
  (command === "telegram" &&
    ((commandScope === "topic" &&
      (commandAction === "add" || commandAction === "create")) ||
      (commandScope === "topics" && commandAction === "list")));

// Verbs with a --json mode. Under --json, stdout carries exactly one JSON
// document, so bin/alphaclaw.js sends every console.log line (the boot lines
// such as "Loaded .env" included) to stderr and the verb writes its document
// with process.stdout.write. `verb` is the leading commandArgs and matches the
// `<verb> options:` heading in --help. valueFlags mirror the verb's own --json
// parsing: git-sync skips their values, so a commit message spelled "--json"
// stays a message; the other verbs match the flag anywhere.
const kJsonCliVerbs = [
  {
    verb: ["git-sync"],
    valueFlags: ["--message", "-m", "--file", "-f", "--trigger", "--deadline-seconds", "--lock-wait"],
  },
  { verb: ["diagnose"], valueFlags: [] },
  { verb: ["telegram", "topics", "list"], valueFlags: [] },
  { verb: ["admin"], valueFlags: [] },
];

const isJsonCliInvocation = (commandArgs = []) => {
  const entry = kJsonCliVerbs.find(({ verb }) =>
    verb.every((token, index) => commandArgs[index] === token),
  );
  if (!entry) return false;
  for (let index = entry.verb.length; index < commandArgs.length; index += 1) {
    if (entry.valueFlags.includes(commandArgs[index])) {
      index += 1;
    } else if (commandArgs[index] === "--json") {
      return true;
    }
  }
  return false;
};

module.exports = { isEarlyExitCliCommand, kJsonCliVerbs, isJsonCliInvocation };
