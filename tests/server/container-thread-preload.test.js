const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

describe.runIf(process.platform === "linux")("container TID fixture preload", () => {
  let rootDir;
  let fixtureDir;
  let entrypoint;
  let preload;
  const kClaimAt = 1700000000000;
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-thread-preload-"));
    fixtureDir = path.join(rootDir, "fixture");
    fs.mkdirSync(fixtureDir);
    preload = path.join(fixtureDir, "preload.cjs");
    fs.copyFileSync(path.join(__dirname, "../container/fixtures/seed-own-thread-claim.cjs"), preload);
    fs.writeFileSync(path.join(fixtureDir, "armed.json"), JSON.stringify({ claimAt: kClaimAt }));
    entrypoint = path.join(rootDir, "alphaclaw.js");
    fs.writeFileSync(entrypoint, "process.stdout.write(JSON.stringify({ pid: process.pid }));\n");
  });
  afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const run = (script = entrypoint, command = "start") => JSON.parse(execFileSync(process.execPath, [script, command], {
    env: { ...process.env, ALPHACLAW_ROOT_DIR: rootDir, NODE_OPTIONS: `--require=${preload}` },
    encoding: "utf8", timeout: 15_000,
  }));
  const readWitness = () => JSON.parse(fs.readFileSync(path.join(fixtureDir, "witness.json"), "utf8"));

  it("plants an actual nonleader TID before the entrypoint and cannot reseed on another start", () => {
    const first = run();
    const witness = readWitness();
    expect(witness.serverPid).toBe(first.pid);
    expect(witness.threadId).not.toBe(first.pid);
    expect(witness.tgid).toBe(first.pid);
    expect(witness.status).toMatch(new RegExp(`^Tgid:\\s+${first.pid}$`, "m"));
    const claimPath = path.join(rootDir, ".openclaw/.alphaclaw/alphaclaw-server.pid");
    const claim = fs.readFileSync(claimPath, "utf8");
    expect(JSON.parse(claim)).toEqual({ pid: witness.threadId, at: kClaimAt });
    expect(fs.existsSync(path.join(fixtureDir, "armed.json"))).toBe(false);
    expect(run().pid).not.toBe(first.pid);
    expect(readWitness()).toEqual(witness);
    expect(fs.readFileSync(claimPath, "utf8")).toBe(claim);
  });

  it("ignores inherited child commands and admits a symlinked AlphaClaw start", () => {
    const child = path.join(rootDir, "child.js");
    fs.copyFileSync(entrypoint, child);
    run(child);
    run(entrypoint, "diagnose");
    expect(fs.existsSync(path.join(fixtureDir, "armed.json"))).toBe(true);
    expect(fs.existsSync(path.join(fixtureDir, "witness.json"))).toBe(false);
    const shim = path.join(rootDir, "alphaclaw");
    fs.symlinkSync(entrypoint, shim);
    const started = run(shim);
    expect(readWitness().serverPid).toBe(started.pid);
  });
});
