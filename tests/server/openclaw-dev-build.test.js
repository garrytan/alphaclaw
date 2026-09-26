const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execFile } = require("child_process");
const { promisify } = require("util");
const { prepareDevBuild } = require("../../lib/server/openclaw-dev-build");
const { withIsolatedDevPreparation } = require("../../lib/server/openclaw-dev-preparation");
const { createDevCandidate } = require("../../lib/server/openclaw-dev-candidates");
const { readCheckoutBuildId } = require("../../lib/server/openclaw-build");

describe("isolated source builds without native updater activation", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-build-root-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("runs real git, install, build and doctor only in the candidate, never the PATH updater's active root", async () => {
    const upstream = path.join(root, "upstream");
    const active = path.join(root, "active");
    const binDir = path.join(root, "bin");
    for (const directory of [upstream, active, binDir]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(upstream, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.2", bin: "openclaw.mjs",
      scripts: { build: "node build.cjs", "ui:build": "node build.cjs ui" } }));
    fs.writeFileSync(path.join(upstream, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n");
    fs.writeFileSync(path.join(upstream, "build.cjs"), 'const fs=require("fs");fs.mkdirSync("dist/control-ui",{recursive:true});fs.writeFileSync(process.argv[2] ? "dist/control-ui/index.html" : "dist/built",process.cwd());');
    fs.writeFileSync(path.join(upstream, "openclaw.mjs"), 'import fs from "node:fs"; if(process.argv.includes("doctor")) fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH,"{\\"isolatedDoctor\\":true}"); console.log("2026.9.2");');
    execFileSync("git", ["init", "--initial-branch=main", upstream], { stdio: "ignore" });
    execFileSync("git", ["-C", upstream, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", upstream, "commit", "-m", "Source build fixture"], { stdio: "ignore" });
    const sha = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(active, "openclaw.json"), "unchanged active state");
    fs.writeFileSync(path.join(binDir, "openclaw"), `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(path.join(active, "native-update-ran"))}, process.argv[1]);process.exit(91);\n`, { mode: 0o700 });
    const candidate = createDevCandidate({ checkoutDir: active });
    const calls = [];
    let isolatedHome;
    let doctorConfig;
    const runner = { runStreamed: async (options) => {
      calls.push({ command: options.command, args: options.args, cwd: options.cwd });
      expect(options.cwd).toBe(candidate.checkoutDir);
      expect(options.env.OPENCLAW_GIT_DIR).toBe(candidate.checkoutDir);
      expect(options.env.OPENCLAW_UPDATE_IN_PROGRESS).toBe(options.command === "pnpm" && options.args[0] === "build" ? "1" : undefined);
      expect(options.env.OPENCLAW_STATE_DIR.startsWith(active)).toBe(false);
      isolatedHome = options.env.HOME;
      const args = options.args.map((value) => value === "https://github.com/openclaw/openclaw.git" ? upstream : value);
      try {
        const result = await promisify(execFile)(options.command, args, { cwd: options.cwd, env: options.env, timeout: 30_000 });
        if (options.args.includes("doctor")) doctorConfig = JSON.parse(fs.readFileSync(options.env.OPENCLAW_CONFIG_PATH));
        return { ok: true, tail: result.stdout + result.stderr };
      } catch (error) { return { ok: false, tail: error.stderr || error.message }; }
    } };
    const output = Object.assign(() => {}, { flush() {} });
    const result = await withIsolatedDevPreparation({ checkoutDir: candidate.checkoutDir, env: { PATH: `${binDir}:${process.env.PATH}` } }, (env) => prepareDevBuild({
      sha, candidateDir: candidate.checkoutDir, env, runner, emit() {}, output, rootDir: root,
      readHead: readCheckoutBuildId, resolveBin: (directory) => path.join(directory, "openclaw.mjs"),
      channelError: (code, message) => ({ ok: false, code, message }) }));
    expect(result, JSON.stringify(result)).toEqual({ ok: true, sha });
    expect(calls.map((call) => call.args[0])).toEqual(["clone", "fetch", "checkout", "install", "build", "ui:build", path.join(candidate.checkoutDir, "openclaw.mjs")]);
    expect(calls.some((call) => call.command === "openclaw" || call.args.includes("update"))).toBe(false);
    expect(readCheckoutBuildId(candidate.checkoutDir)).toBe(sha);
    expect(fs.readFileSync(path.join(candidate.checkoutDir, "dist", "built"), "utf8")).toBe(candidate.checkoutDir);
    expect(fs.readFileSync(path.join(candidate.checkoutDir, "dist", "control-ui", "index.html"), "utf8")).toBe(candidate.checkoutDir);
    expect(doctorConfig).toEqual({ isolatedDoctor: true });
    expect(fs.existsSync(isolatedHome)).toBe(false);
    expect(fs.existsSync(path.join(active, "native-update-ran"))).toBe(false);
    expect(fs.readFileSync(path.join(active, "openclaw.json"), "utf8")).toBe("unchanged active state");
  });
});
