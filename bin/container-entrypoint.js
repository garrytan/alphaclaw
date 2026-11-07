#!/usr/bin/env node
"use strict";

// The container image's first process (Dockerfile ENTRYPOINT). A container
// init such as tini keeps the environment it was started with for the life
// of the container, and the agent's shell, which runs as the same uid, can
// read /proc/1/environ. So this launcher moves the deployment secrets
// (lib/server/deployment-secrets.js) into a 0600 handoff file and execs the
// init with an environment that carries only the handoff path; AlphaClaw
// reads and deletes the file at boot (CSO ALPH-71 M-1). A command that does
// not run AlphaClaw keeps its environment unchanged, so no handoff is left
// behind for nobody to consume.
const path = require("path");
const { withDeploymentSecretsHandoff } = require("../lib/server/deployment-secrets");

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("[alphaclaw] usage: container-entrypoint.js <init> [args...]");
  process.exit(64);
}
const runsAlphaclaw = [command, ...args].some((arg) => path.basename(arg) === "alphaclaw");
const env = runsAlphaclaw ? withDeploymentSecretsHandoff(process.env) : { ...process.env };
try {
  process.execve(command, [command, ...args], env);
} catch (error) {
  console.error("[alphaclaw] container entrypoint could not start " + command + ": " + (error?.code || error?.message || error));
  process.exit(1);
}
