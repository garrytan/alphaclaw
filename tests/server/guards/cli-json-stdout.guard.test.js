// Every `alphaclaw <verb> --json` prints exactly one JSON document on stdout
// (ALPH-39). The boot lines that run before verb dispatch ("Root directory",
// "Loaded .env", a pending self-update's npm output) and the verb's own log
// lines go to stderr. This spawns the real bin for each --json verb in a
// scratch root with a .env present, so the "Loaded .env" line fires, and
// drives each verb to a fast path that still emits its document (no server,
// no token, no network). The verb list comes from --help: a new
// `<verb> options:` section with --json fails here until the verb is in
// kJsonCliVerbs and has a case below.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { kJsonCliVerbs } = require("../../../lib/boot-cli-verbs");

const binPath = path.resolve(__dirname, "../../../bin/alphaclaw.js");

const kCases = {
  "git-sync": { argv: ["git-sync", "--json", "--message", "guard"], loadsEnv: true },
  diagnose: { argv: ["diagnose", "--json"], loadsEnv: false },
  "telegram topics list": { argv: ["telegram", "topics", "list", "--json"], loadsEnv: true },
  admin: { argv: ["admin", "GET", "/api/status", "--json"], loadsEnv: true },
};

const readHelpJsonVerbs = (helpText) => {
  const verbs = [];
  let section = null;
  for (const line of helpText.split("\n")) {
    const heading = /^(\S.*) options:$/.exec(line);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (!line.trim()) {
      section = null;
      continue;
    }
    if (section && /^\s+--json\b/.test(line) && !verbs.includes(section)) verbs.push(section);
  }
  return verbs.sort();
};

describe("CLI --json stdout carries exactly one JSON document", () => {
  let scratchDir;
  let preloadPath;
  let fakeNpmDir;

  const makeRoot = (name) => {
    const rootDir = path.join(scratchDir, name, "root");
    const homeDir = path.join(scratchDir, name, "home");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, ".env"), "ALPHACLAW_GUARD_SAMPLE=1\n");
    return { rootDir, homeDir };
  };

  const runCli = ({ rootDir, homeDir }, cliArgs) => {
    const result = spawnSync(
      process.execPath,
      ["--require", preloadPath, binPath, "--root-dir", rootDir, ...cliArgs],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${fakeNpmDir}${path.delimiter}${process.env.PATH || ""}`,
          ALPHACLAW_ROOT_DIR: rootDir,
          ALPHACLAW_TEST_HOME: homeDir,
          HOME: homeDir,
          ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL: "true",
          ALPHACLAW_GIT_SHIM_PATH: path.join(homeDir, "bin", "git"),
          ALPHACLAW_OPENCLAW_WRAPPER_PATH: path.join(homeDir, "bin", "openclaw"),
          ALPHACLAW_PROFILE_SNIPPET_PATH: path.join(homeDir, "profile.sh"),
          ALPHACLAW_GIT_SYNC: "",
          GITHUB_TOKEN: "",
          GITHUB_WORKSPACE_REPO: "",
          PORT: "1",
        },
      },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  const expectOneJsonDocument = (stdout) => {
    expect(stdout.endsWith("\n")).toBe(true);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
  };

  beforeAll(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-cli-json-"));
    preloadPath = path.join(scratchDir, "preload.js");
    fs.writeFileSync(
      preloadPath,
      'const os = require("os");\nif (process.env.ALPHACLAW_TEST_HOME) os.homedir = () => process.env.ALPHACLAW_TEST_HOME;\n',
    );
    fakeNpmDir = path.join(scratchDir, "fake-npm");
    fs.mkdirSync(fakeNpmDir);
    fs.writeFileSync(
      path.join(fakeNpmDir, "npm"),
      "#!/bin/sh\necho \"fake npm: added 1 package\"\nexit 0\n",
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("covers every --json verb that --help lists, and only those", () => {
    const help = spawnSync(process.execPath, [binPath, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    const helpVerbs = readHelpJsonVerbs(help.stdout);
    expect(helpVerbs).toEqual(kJsonCliVerbs.map(({ verb }) => verb.join(" ")).sort());
    expect(helpVerbs).toEqual(Object.keys(kCases).sort());
  });

  it.each(Object.entries(kCases))("%s --json", (name, { argv, loadsEnv }) => {
    const result = runCli(makeRoot(name.replace(/ /g, "-")), argv);
    expectOneJsonDocument(result.stdout);
    if (loadsEnv) expect(result.stderr).toContain("[alphaclaw] Loaded .env");
  });

  it("keeps a pending self-update's npm output off stdout", () => {
    const root = makeRoot("pending-update");
    fs.writeFileSync(path.join(root.rootDir, ".alphaclaw-update-pending"), "");
    const result = runCli(root, ["admin", "manifest", "--json"]);
    expectOneJsonDocument(result.stdout);
    expect(JSON.parse(result.stdout).ok).toBe(true);
    expect(result.stderr).toContain("[alphaclaw] Pending update");
    expect(fs.existsSync(path.join(root.rootDir, ".alphaclaw-update-pending"))).toBe(false);
  });

  it("leaves the boot lines on stdout without --json", () => {
    const result = runCli(makeRoot("plain"), ["telegram", "topics", "list"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[alphaclaw] Loaded .env");
  });
});
