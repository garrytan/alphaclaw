#!/usr/bin/env node
"use strict";
// AlphaClaw's managed GitHub credential helper (GST-3351). git runs it through
// the launcher AlphaClaw writes at <openclaw dir>/.alphaclaw/bin/ as
// "<launcher> get|store|erase" with the request on stdin.
//   get:   answers only for the managed host (https://github.com), from the
//          most specific gitCredentials.routes entry in alphaclaw.json for the
//          request's path (owner/repo; credential.useHttpPath must be on), with
//          the token read from the env var the route names: the process env
//          first, then AlphaClaw's .env file. No route, no token: no answer,
//          so git falls back to the next helper or askpass.
//   store, erase: no-ops. This helper keeps nothing, so there is nothing a
//          successful push can write and nothing a refused one must evict.
// It never prints anything but the answer, and never writes a file.
const fs = require("fs");
const { normalizeGitCredentialsConfig, repoOfPath, resolveGitCredentialRoute } = require("../server/git-credential-routes");
const { parseEnvFileContent } = require("../server/utils/env-file-format");

const readStdin = () =>
  new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (text.length < 65536) text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });

const fieldsOf = (text) => {
  const fields = {};
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0 && !line.slice(0, index).endsWith("[]")) fields[line.slice(0, index)] = line.slice(index + 1);
  }
  return fields;
};

const tokenFromEnvFile = (file, name) => {
  try {
    const entry = parseEnvFileContent(fs.readFileSync(file, "utf8")).find((item) => item.key === name);
    return entry ? String(entry.value || "") : "";
  } catch {
    return "";
  }
};

const answer = async () => {
  const operation = process.argv[2];
  const input = await readStdin();
  if (operation !== "get") return "";
  const fields = fieldsOf(input);
  let managed;
  try {
    managed = new URL(process.env.ALPHACLAW_GIT_CREDENTIAL_URL || "https://github.com");
  } catch {
    return "";
  }
  if (fields.protocol !== managed.protocol.replace(/:$/, "") || String(fields.host || "").toLowerCase() !== managed.host.toLowerCase()) return "";
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(process.env.ALPHACLAW_GIT_CREDENTIAL_CONFIG || "", "utf8"))?.gitCredentials;
  } catch {
    return "";
  }
  const refusedEnvKeys = String(process.env.ALPHACLAW_GIT_CREDENTIAL_REFUSED || "").split(",").filter(Boolean);
  const { routes } = normalizeGitCredentialsConfig(raw, { refusedEnvKeys });
  const route = resolveGitCredentialRoute(routes, repoOfPath(fields.path));
  if (!route) return "";
  const token = String(process.env[route.tokenEnv] || tokenFromEnvFile(process.env.ALPHACLAW_GIT_CREDENTIAL_ENV_FILE || "", route.tokenEnv)).trim();
  if (!token || /[\r\n\0]/.test(token)) return "";
  return "username=" + route.username + "\npassword=" + token + "\n";
};

answer()
  .then((text) => {
    if (text) process.stdout.write(text);
  })
  .catch(() => {});
