#!/usr/bin/env node
// Regenerates lib/server/model-catalog-bootstrap.json from the installed
// OpenClaw CLI (`openclaw models list --all --json`).
//
// The bootstrap catalog seeds the onboarding model picker before any live
// gateway catalog exists, so it must reflect the STABLE pin AlphaClaw ships
// with — run this after bumping the openclaw dependency, then commit the
// regenerated JSON.
//
// Hand-curated rows do NOT belong in the generated file (this script would
// erase them): they live in lib/server/model-catalog-curated.json and are
// merged at load in lib/server/constants.js (generated rows win on key
// collision).
//
// Usage:
//   node scripts/refresh-model-bootstrap.mjs           # uses node_modules/.bin/openclaw
//   node scripts/refresh-model-bootstrap.mjs --bin /path/to/openclaw
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const kRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kOutputPath = path.join(kRepoRoot, "lib", "server", "model-catalog-bootstrap.json");

const binFlagIndex = process.argv.indexOf("--bin");
const openclawBin =
  binFlagIndex !== -1 && process.argv[binFlagIndex + 1]
    ? path.resolve(process.argv[binFlagIndex + 1])
    : path.join(kRepoRoot, "node_modules", ".bin", "openclaw");

// Isolated state: a developer's own ~/.openclaw config (custom providers,
// local models) must never leak into the committed bootstrap. NODE_OPTIONS is
// scrubbed because loader flags inherited from a test runner break CLI output.
const isolatedHome = mkdtempSync(path.join(tmpdir(), "alphaclaw-model-bootstrap-"));
const env = { ...process.env };
delete env.NODE_OPTIONS;
Object.assign(env, {
  OPENCLAW_HOME: isolatedHome,
  OPENCLAW_CONFIG_PATH: path.join(isolatedHome, "openclaw.json"),
  OPENCLAW_STATE_DIR: isolatedHome,
  XDG_CONFIG_HOME: isolatedHome,
  OPENCLAW_NO_AUTO_UPDATE: "1",
});

const run = async (args) => {
  const { stdout } = await execFileAsync(openclawBin, args, {
    env,
    cwd: isolatedHome,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
};

try {
  const versionLine = (await run(["--version"])).trim();
  // "OpenClaw 2026.7.1-2 (0790d9f)" -> "2026.7.1-2 (0790d9f)"
  const openclawVersion = versionLine.replace(/^openclaw\s+/i, "");

  const raw = JSON.parse(await run(["models", "list", "--all", "--json"]));
  const models = (Array.isArray(raw.models) ? raw.models : [])
    .filter((model) => typeof model?.key === "string" && model.key.includes("/"))
    .map((model) => ({
      key: model.key,
      provider: model.key.split("/")[0],
      label: model.name || model.key,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  if (models.length === 0) {
    throw new Error("openclaw returned zero models — refusing to write an empty bootstrap");
  }

  const payload = {
    version: 1,
    source: "openclaw models list --all --json",
    generatedAt: new Date().toISOString(),
    openclawVersion,
    models,
  };
  writeFileSync(kOutputPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `wrote ${path.relative(kRepoRoot, kOutputPath)} — ${models.length} models from OpenClaw ${openclawVersion}`,
  );
} finally {
  rmSync(isolatedHome, { recursive: true, force: true });
}
