#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const { parseJsonObjectFromNoisyOutput } = require("../server/utils/json");
const pkg = require("../../package.json");

const getPinnedOpenclawVersion = () =>
  String(pkg.dependencies?.openclaw || "").trim();

// Published-semver shape (calver + optional prerelease). Dev builds identify
// as commit shas, which are neither installable as @openclaw/codex@<v> nor a
// legitimate reconcile target.
const kPublishedVersionShape = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

// The ACTIVE openclaw version — the release channel may have activated a
// beta/dev build on top of the npm pin. Reconciling the codex plugin to the
// PIN while a newer core is active force-downgrades the plugin on every boot
// against a core whose plugin-sdk it no longer matches.
const getActiveOpenclawVersion = ({ exec = execFileSync } = {}) => {
  try {
    const output = exec("openclaw", ["--version"], {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    // "OpenClaw <version>" or "OpenClaw <version> (<commit>)"
    const match = /OpenClaw\s+(\S+)/i.exec(String(output || ""));
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
};

const getInstalledCodexPlugin = ({ exec = execFileSync } = {}) => {
  try {
    const output = exec("openclaw", ["plugins", "list", "--json"], {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    const parsed = parseJsonObjectFromNoisyOutput(output) || {};
    return (parsed.plugins || []).find(
      (plugin) => plugin?.id === "codex" && plugin?.origin === "global",
    );
  } catch {
    return null;
  }
};

const reconcileCodexPlugin = ({ exec = execFileSync, logger = console } = {}) => {
  const activeVersion = getActiveOpenclawVersion({ exec });
  const expectedVersion = activeVersion || getPinnedOpenclawVersion();
  if (!expectedVersion) return { changed: false, reason: "missing-pin" };
  if (!kPublishedVersionShape.test(expectedVersion)) {
    // Dev sha / unpublished build: skip rather than force the pin — a
    // downgraded plugin against a newer core is worse than a mismatched one.
    logger.log(
      `[alphaclaw] Codex plugin reconcile skipped: active openclaw version ${JSON.stringify(expectedVersion)} is not a published release`,
    );
    return { changed: false, reason: "unpublished-active-version", version: expectedVersion };
  }

  const installed = getInstalledCodexPlugin({ exec });
  if (!installed) return { changed: false, reason: "not-installed" };
  if (installed.version === expectedVersion) {
    return { changed: false, reason: "current", version: expectedVersion };
  }

  logger.log(
    `[alphaclaw] Updating Codex plugin ${installed.version || "unknown"} -> ${expectedVersion}`,
  );
  exec(
    "openclaw",
    ["plugins", "install", `@openclaw/codex@${expectedVersion}`, "--force"],
    {
      encoding: "utf8",
      env: process.env,
      stdio: "inherit",
      timeout: 120_000,
    },
  );
  return {
    changed: true,
    previousVersion: installed.version || null,
    version: expectedVersion,
  };
};

if (require.main === module) {
  try {
    reconcileCodexPlugin();
  } catch (error) {
    console.warn(
      `[alphaclaw] Codex plugin reconciliation warning: ${error.message}`,
    );
  }
}

module.exports = {
  getActiveOpenclawVersion,
  getInstalledCodexPlugin,
  getPinnedOpenclawVersion,
  reconcileCodexPlugin,
};
