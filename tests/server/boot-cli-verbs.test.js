const { isEarlyExitCliCommand } = require("../../lib/boot-cli-verbs");

// The predicate decides whether bin/alphaclaw.js binds the boot placeholder
// web server: a false negative binds a placeholder that fights the live
// server for the port; a false positive leaves the port silently closed
// during boot. Shapes below mirror the bin's dispatch sites exactly
// (command = commandArgs[0], commandScope = [1], commandAction = [2]).
describe("boot-cli-verbs isEarlyExitCliCommand", () => {
  const kEarlyExitShapes = [
    { command: "git-sync" },
    { command: "admin" },
    { command: "admin", commandScope: "manifest" },
    { command: "doctor", commandScope: "finding", commandAction: "complete" },
    { command: "telegram", commandScope: "topic", commandAction: "add" },
    { command: "telegram", commandScope: "topic", commandAction: "create" },
    { command: "telegram", commandScope: "topics", commandAction: "list" },
  ];

  it.each(kEarlyExitShapes)("early-exits %o", (shape) => {
    expect(isEarlyExitCliCommand(shape)).toBe(true);
  });

  const kServerBootShapes = [
    { command: "start" },
    {}, // no args → the bin prints help, but the predicate must not early-exit
    { command: undefined },
    { command: "frobnicate" },
    // Partial/wrong sub-verbs of the early-exit families stay server-boot:
    // the bin falls through their dispatch sites without exiting.
    { command: "doctor" },
    { command: "doctor", commandScope: "finding" },
    { command: "doctor", commandScope: "finding", commandAction: "reopen" },
    { command: "telegram" },
    { command: "telegram", commandScope: "topic" },
    { command: "telegram", commandScope: "topic", commandAction: "remove" },
    { command: "telegram", commandScope: "topics" },
    { command: "telegram", commandScope: "topics", commandAction: "prune" },
  ];

  it.each(kServerBootShapes)("does NOT early-exit %o", (shape) => {
    expect(isEarlyExitCliCommand(shape)).toBe(false);
  });

  it("tolerates being called with no argument at all", () => {
    expect(isEarlyExitCliCommand()).toBe(false);
  });
});
