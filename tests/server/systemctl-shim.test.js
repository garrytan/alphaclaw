const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const kShimPath = path.resolve(__dirname, "../../lib/scripts/systemctl");
const kGatewayPattern = "openclaw[^ ]* gateway";

// Stand-in for `pgrep -f <pattern>`: pgrep -f matches the pattern as an
// extended regex against the full command line, exactly like grep -E.
const grepMatches = (cmdline) => {
  const result = spawnSync("bash", [
    "-c",
    `printf '%s' '${cmdline}' | grep -qE '${kGatewayPattern}'`,
  ]);
  return result.status === 0;
};

describe("lib/scripts/systemctl gateway-process pattern", () => {
  it("uses the release-channel-aware pattern for pgrep and pkill", () => {
    const source = fs.readFileSync(kShimPath, "utf8");

    expect(source).toContain(`pgrep -f "${kGatewayPattern}"`);
    expect(source).toContain(`pkill -TERM -f "${kGatewayPattern}"`);
    expect(source).toContain(`pkill -9 -f "${kGatewayPattern}"`);
    // The literal-space pattern would miss the dev-checkout launch shape.
    expect(source).not.toMatch(/p(grep|kill)[^\n]*-f "openclaw gateway"/);
  });

  it("matches both pinned-npm and dev-checkout gateway command lines", () => {
    const matching = [
      "/app/node_modules/.bin/openclaw gateway run",
      "node /data/openclaw/openclaw.mjs gateway run",
      "openclaw gateway run",
    ];
    for (const cmdline of matching) {
      expect(grepMatches(cmdline), `should match: ${cmdline}`).toBe(true);
    }
  });

  it("does not match unrelated gateway-ish command lines", () => {
    const nonMatching = [
      "node something-else gateway run",
      "node /data/other/tool.mjs gateway run",
    ];
    for (const cmdline of nonMatching) {
      expect(grepMatches(cmdline), `should NOT match: ${cmdline}`).toBe(false);
    }
  });

  it("status action invokes pgrep -f with the exact pattern and reports active", () => {
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "systemctl-shim-bin-"));
    const argsFile = path.join(fakeBinDir, "pgrep-args.txt");
    const fakePgrep = path.join(fakeBinDir, "pgrep");
    fs.writeFileSync(
      fakePgrep,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "\${PGREP_ARGS_FILE}"\nexit 0\n`,
    );
    fs.chmodSync(fakePgrep, 0o755);

    const result = spawnSync("bash", [kShimPath, "status", "my-unit"], {
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        PGREP_ARGS_FILE: argsFile,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("● my-unit");
    expect(result.stdout).toContain("Active: active");
    const recordedArgs = fs
      .readFileSync(argsFile, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(recordedArgs).toEqual(["-f", kGatewayPattern]);
  });

  it("status action reports inactive with exit 3 when no gateway process matches", () => {
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "systemctl-shim-bin-"));
    const fakePgrep = path.join(fakeBinDir, "pgrep");
    fs.writeFileSync(fakePgrep, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(fakePgrep, 0o755);

    const result = spawnSync("bash", [kShimPath, "status", "my-unit"], {
      env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` },
      encoding: "utf8",
    });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain("● my-unit");
    expect(result.stdout).toContain("Active: inactive (dead)");
  });
});
