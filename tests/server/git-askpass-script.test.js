const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  kGitAskpassScript,
  writeGitAskpassScript,
} = require("../../lib/git-askpass-script");

describe("git-askpass-script", () => {
  it("is valid POSIX sh", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "askpass-syntax-"));
    const scriptPath = path.join(dir, "askpass.sh");
    fs.writeFileSync(scriptPath, kGitAskpassScript);
    execFileSync("sh", ["-n", scriptPath], { stdio: "pipe" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // H14: the helper must land in a fresh private (mkdtemp) directory, never a
  // predictable ${pid} path that a pre-planted symlink could hijack.
  it("writes into a private mkdtemp directory (H14)", () => {
    const calls = [];
    const fsMock = {
      mkdtempSync: (prefix) => {
        calls.push(prefix);
        return `${prefix}RANDOM`;
      },
      writeFileSync: (p, content, opts) => {
        calls.push({ p, content, opts });
      },
    };
    const osMock = { tmpdir: () => "/tmpx" };

    const { scriptPath, dir } = writeGitAskpassScript({
      fsModule: fsMock,
      osModule: osMock,
    });

    expect(dir).toBe("/tmpx/alphaclaw-askpass-RANDOM");
    expect(scriptPath).toBe("/tmpx/alphaclaw-askpass-RANDOM/askpass.sh");
    expect(calls[0]).toBe("/tmpx/alphaclaw-askpass-");
    expect(calls[1].opts).toEqual({ mode: 0o700 });
    // Never a predictable pid-named path.
    expect(scriptPath).not.toMatch(/askpass-\d+\.sh$/);
  });

  it("answers a real github.com prompt with the token but not an attacker host (H9)", () => {
    const { scriptPath, dir } = writeGitAskpassScript();
    try {
      const ask = (prompt) =>
        String(
          execFileSync("sh", [scriptPath, prompt], {
            env: { GITHUB_TOKEN: "ghp_secret", PATH: process.env.PATH },
            stdio: "pipe",
          }),
        );
      expect(ask("Password for 'https://x@github.com': ")).toBe("ghp_secret");
      expect(ask("Password for 'https://github.com@evil.example/r': ")).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
