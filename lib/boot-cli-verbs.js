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

module.exports = { isEarlyExitCliCommand };
