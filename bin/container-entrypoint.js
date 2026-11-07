#!/usr/bin/env node
"use strict";

// The container image's first process (Dockerfile ENTRYPOINT). A container
// init such as tini keeps the environment it was started with for the life
// of the container, and the agent's shell, which runs as the same uid, can
// read /proc/1/environ. So this launcher moves the deployment secrets
// (lib/server/deployment-secrets.js) into a 0600 handoff file and execs the
// init with an environment that carries only the handoff path; AlphaClaw
// reads and deletes the file at boot (CSO ALPH-71 M-1). Only the program the
// init runs (the first argument after "--", else the command itself) is
// looked at, and only an exact "alphaclaw" basename gets the handoff, as the
// image's CMD ["alphaclaw", "start"] does. Any other start command, a shell
// form included, keeps its environment unchanged and gets one warning: no
// handoff is left behind for nobody to consume, and a one-shot handoff is
// never spent by a process that is not the server.
const path = require("path");
const { kDeploymentSecretKeys, withDeploymentSecretsHandoff } = require("../lib/server/deployment-secrets");

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("[alphaclaw] usage: container-entrypoint.js <init> [args...]");
  process.exit(64);
}
const separator = args.indexOf("--");
const program = separator >= 0 ? args[separator + 1] || "" : command;
const runsAlphaclaw = path.basename(program) === "alphaclaw";
if (!runsAlphaclaw && kDeploymentSecretKeys.some((key) => process.env[key])) {
  console.error(
    "[alphaclaw] container entrypoint: the start command (" + path.basename(program || command) + ") is not alphaclaw, so the deployment secrets stay in this container's environment. Use CMD [\"alphaclaw\", \"start\"] (README: Docker, the entrypoint).",
  );
}
const env = runsAlphaclaw ? withDeploymentSecretsHandoff(process.env) : { ...process.env };
try {
  process.execve(command, [command, ...args], env);
} catch (error) {
  console.error("[alphaclaw] container entrypoint could not start " + command + ": " + (error?.code || error?.message || error));
  process.exit(1);
}
