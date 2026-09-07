// `alphaclaw diagnose [--json]` (issue #76 A9): the read-only evidence
// bundle as the operator runs it — the real bin, spawned against a temp root,
// with the server down. Pins: markdown by default with every section
// heading, ONE JSON line with --json, exit 0 on an empty root, and — the
// property a diagnose verb must never lose — nothing is created on the
// volume (no mkdir, no state file, no pidfile, no placeholder spawn).
// Hermetic: temp root + temp home, HOME/homedir pinned, no network.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kDiagnoseSchema,
  kDiagnoseSectionNames,
} = require("../../lib/server/diagnose/collect");
const { kDiagnoseSectionTitles } = require("../../lib/server/diagnose/render");
const { createOpenclawReleaseChannelStore } = require("../../lib/server/openclaw-release-channel");

const binPath = path.resolve(__dirname, "../../bin/alphaclaw.js");

// Same idiom as telegram-topics-cli.test.js: os.homedir() is pinned so no
// code path — the bin's ~/.openclaw link, `~/` state-dir expansion — can
// reach the runner's real home.
const kPreloadSource = `
const os = require("os");
const testHome = process.env.ALPHACLAW_TEST_HOME;
if (testHome) {
  os.homedir = () => testHome;
}
`.trim();

const listTree = (dir) => {
  const out = [];
  const walk = (current, prefix) => {
    let names = [];
    try {
      names = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      out.push(rel);
      const full = path.join(current, name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, rel);
    }
  };
  walk(dir, "");
  return out;
};

describe("bin/alphaclaw diagnose", () => {
  let rootDir;
  let tmpHome;
  let scratchDir;
  let preloadPath;

  const runCli = (cliArgs, { env = {} } = {}) => {
    const result = spawnSync(
      process.execPath,
      ["--require", preloadPath, binPath, "--root-dir", rootDir, ...cliArgs],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ALPHACLAW_ROOT_DIR: rootDir,
          ALPHACLAW_TEST_HOME: tmpHome,
          HOME: tmpHome,
          ...env,
        },
      },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-diagnose-cli-root-"));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-diagnose-cli-home-"));
    // The preload lives OUTSIDE the root so the "root stays empty" assertion
    // below is about the bin's writes alone.
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-diagnose-cli-scratch-"));
    preloadPath = path.join(scratchDir, "preload.js");
    fs.writeFileSync(preloadPath, kPreloadSource);
  });

  afterEach(() => {
    for (const dir of [rootDir, tmpHome, scratchDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("renders the markdown bundle by default against an EMPTY root: exit 0, every section present, nothing created", () => {
    expect(listTree(rootDir)).toEqual([]);
    const result = runCli(["diagnose"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("# AlphaClaw diagnose");
    expect(result.stdout).toContain("- mode: cli (disk only)");
    expect(result.stdout).toContain(`- root: \`${rootDir}\``);
    expect(result.stdout).toContain(`- openclaw dir: \`${path.join(rootDir, ".openclaw")}\``);
    const headings = result.stdout.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toHaveLength(kDiagnoseSectionNames.length);
    for (const name of kDiagnoseSectionNames) {
      expect(result.stdout).toContain(`## ${kDiagnoseSectionTitles[name]} (`);
    }
    // The empty states are documented, not failures; only the DB-backed and
    // live-only sections are unavailable with the server down.
    expect(result.stdout).toContain("## Incidents (unavailable)");
    expect(result.stdout).toContain("## Watchdog (unavailable)");
    expect(result.stdout).toContain("- no stamp at");
    expect(result.stdout).toContain("- no boot-report.json under");
    // No boot placeholder, no server, no diagnose failure line.
    expect(result.stderr).not.toContain("diagnose failed");
    expect(result.stderr).not.toContain("Fatal config error");

    // Read-only, on the volume AND in the home: the root is exactly as empty
    // as it was, the managed dir/state file/pidfile were never created, and
    // nothing linked ~/.openclaw.
    expect(listTree(rootDir)).toEqual([]);
    expect(listTree(tmpHome)).toEqual([]);
  });

  it("--json prints ONE line: the redacted bundle, parseable, with the same section set", () => {
    const result = runCli(["diagnose", "--json"]);

    expect(result.status).toBe(0);
    const lines = result.stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const bundle = JSON.parse(lines[0]);
    expect(bundle.schema).toBe(kDiagnoseSchema);
    expect(bundle.mode).toBe("cli");
    expect(bundle.redacted).toBe(true);
    expect(bundle.paths).toMatchObject({
      rootDir,
      openclawDir: path.join(rootDir, ".openclaw"),
      managedDir: path.join(rootDir, ".openclaw", ".alphaclaw"),
    });
    expect(Object.keys(bundle.sections)).toEqual([...kDiagnoseSectionNames]);
    expect(bundle.summary.unavailable).toEqual(["incidents", "watchdog"]);
    expect(bundle.summary.bootVerdict).toBeNull();
    expect(listTree(rootDir)).toEqual([]);
  });

  it("reads what a booted box left behind and redacts the .env secrets it finds in them", () => {
    // A box that has booted once: the self-version stamp, a boot report and
    // a channel state, written the way their owners write them, plus a
    // secret in .env that a boot warning happens to echo.
    const kSecret = "tg-bot-token-4242-secret";
    const openclawDir = path.join(rootDir, ".openclaw");
    const store = createOpenclawReleaseChannelStore({
      rootDir,
      openclawDir,
      nowFn: () => 1_700_000_000_000,
      logger: { log() {}, warn() {}, error() {} },
    });
    fs.writeFileSync(path.join(rootDir, ".env"), `TELEGRAM_BOT_TOKEN=${kSecret}\n`);
    store.writeState({
      pinVersion: "2026.9.2",
      applied: null,
      lastBoot: {
        at: 1_700_000_000_000,
        action: "none",
        warnings: [`boot warning echoing ${kSecret}`],
      },
    });
    fs.writeFileSync(
      path.join(store.managedDir, "alphaclaw-version.json"),
      `${JSON.stringify({ version: "0.9.77", commit: "abc123", firstBootAt: 1, lastBootAt: 2, bootCount: 3, previous: { version: "0.9.76", commit: null, lastBootAt: 0 } })}\n`,
    );
    fs.writeFileSync(
      path.join(store.managedDir, "boot-report.json"),
      `${JSON.stringify({
        schema: "alphaclaw.boot-report.v1",
        bootId: "40:1",
        at: 1_700_000_000_000,
        alphaclaw: { version: "0.9.77", commit: "abc123", previousVersion: "0.9.76", firstBootOfVersion: true },
        openclaw: { declaredPin: "2026.9.2", expected: "2026.9.2", installedAtBoot: "2026.9.2", bootSync: { action: "none", reason: null, warnings: [] } },
        pidfile: { decision: "proceed", reason: "absent" },
        binPhase: { status: "ok" },
        serverPhase: { status: "recorded", verdict: [] },
      })}\n`,
    );
    const before = listTree(rootDir);

    const markdown = runCli(["diagnose"]);
    expect(markdown.status).toBe(0);
    expect(markdown.stdout).toContain("0.9.77");
    expect(markdown.stdout).toContain("commit abc123");
    expect(markdown.stdout).toContain("previous 0.9.76");
    expect(markdown.stdout).toContain("- pin: 2026.9.2");
    expect(markdown.stdout).toContain("boot `40:1`");
    expect(markdown.stdout).toContain("- current boot verdict: consistent");
    expect(markdown.stdout).not.toContain(kSecret);

    const json = runCli(["diagnose", "--json"]);
    expect(json.status).toBe(0);
    expect(json.stdout).not.toContain(kSecret);
    const bundle = JSON.parse(json.stdout.trim());
    expect(bundle.sections.selfVersion.data.record.version).toBe("0.9.77");
    expect(bundle.sections.bootReports.data.current.bootId).toBe("40:1");
    expect(bundle.sections.channelState.data.pinVersion).toBe("2026.9.2");
    expect(bundle.sections.pidfile.data.decision).toMatchObject({ decision: "proceed", reason: "absent" });

    // Still read-only: two runs later the tree is byte-for-byte the same set
    // of entries (no pidfile claimed, no state rewrite, no report rotation).
    expect(listTree(rootDir)).toEqual(before);
  });

  it("is listed in the help text and works without --root-dir too (env root)", () => {
    const help = spawnSync(process.execPath, ["--require", preloadPath, binPath, "--help"], {
      encoding: "utf8",
      env: { ...process.env, ALPHACLAW_ROOT_DIR: rootDir, ALPHACLAW_TEST_HOME: tmpHome, HOME: tmpHome },
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("diagnose  Print a read-only diagnostic bundle");
    expect(help.stdout).toContain("diagnose options:");
    expect(help.stdout).toContain("alphaclaw diagnose --json");

    const viaEnv = spawnSync(process.execPath, ["--require", preloadPath, binPath, "diagnose", "--json"], {
      encoding: "utf8",
      env: { ...process.env, ALPHACLAW_ROOT_DIR: rootDir, ALPHACLAW_TEST_HOME: tmpHome, HOME: tmpHome },
    });
    expect(viaEnv.status).toBe(0);
    expect(JSON.parse(viaEnv.stdout.trim()).paths.rootDir).toBe(rootDir);
    expect(listTree(rootDir)).toEqual([]);
  });
});
