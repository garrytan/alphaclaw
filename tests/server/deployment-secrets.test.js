const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const modulePath = require.resolve("../../lib/server/deployment-secrets");
const load = () => {
  delete require.cache[modulePath];
  return require(modulePath);
};

// Deployment secrets leave every environment block (CSO ALPH-71 M-1): they
// move from process.env into the module, cross a re-exec or a respawn in a
// 0600 handoff file that the next image deletes on read, and stay masked.
describe("deployment secrets (ALPH-71 M-1)", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deployment-secrets-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("moves every deployment secret out of env and serves it from the module", () => {
    const secrets = load();
    const env = { SETUP_PASSWORD: "fake-setup-pass-1", RAILWAY_TOKEN: "fake-railway-1", NPM_TOKEN: "", PATH: "/usr/bin" };
    expect(secrets.captureDeploymentSecrets(env)).toBe(3);
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(secrets.getDeploymentSecret("SETUP_PASSWORD")).toBe("fake-setup-pass-1");
    expect(secrets.getDeploymentSecret("NPM_TOKEN", { NPM_TOKEN: "from-env" })).toBe("from-env");
    expect(secrets.deploymentSecretValues().sort()).toEqual(["fake-railway-1", "fake-setup-pass-1"]);
  });

  it("never lists gog's published default keyring password as a secret to mask", () => {
    const secrets = load();
    secrets.captureDeploymentSecrets({ GOG_KEYRING_PASSWORD: "alphaclaw", SETUP_PASSWORD: "fake-setup-pass-2" });
    expect(secrets.deploymentSecretValues()).toEqual(["fake-setup-pass-2"]);
    expect(require("../../lib/server/utils/redact").collectSecretValues({ env: {} }).has("fake-setup-pass-2")).toBe(true);
  });

  it("hands secrets over in a 0600 file inside a fresh 0700 dir that the reader deletes", () => {
    const writer = load();
    writer.captureDeploymentSecrets({ SETUP_PASSWORD: "fake-setup-pass-3" });
    const childEnv = writer.withDeploymentSecretsHandoff({ PATH: "/usr/bin", SETUP_PASSWORD: "stale" }, { tmpDir });
    const handoff = childEnv.ALPHACLAW_DEPLOYMENT_SECRETS_FILE;
    expect(childEnv).toEqual({ PATH: "/usr/bin", ALPHACLAW_DEPLOYMENT_SECRETS_FILE: handoff });
    expect(fs.statSync(handoff).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(handoff)).mode & 0o777).toBe(0o700);
    const reader = load();
    const env = { ...childEnv };
    expect(reader.consumeDeploymentSecretsHandoff(env)).toBe(true);
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(reader.getDeploymentSecret("SETUP_PASSWORD", {})).toBe("fake-setup-pass-3");
    expect(fs.existsSync(handoff)).toBe(false);
    expect(fs.existsSync(path.dirname(handoff))).toBe(false);
  });

  it("warns once, naming PID 1 and the error code but no value, when a child's handoff cannot be written", () => {
    const secrets = load();
    secrets.captureDeploymentSecrets({ SETUP_PASSWORD: "fake-setup-pass-12" });
    const warnings = [];
    const childEnv = secrets.withDeploymentSecretsHandoff({ PATH: "/usr/bin" }, { tmpDir: path.join(tmpDir, "missing"), logger: { warn: (line) => warnings.push(line) } });
    expect(childEnv).toEqual({ PATH: "/usr/bin", SETUP_PASSWORD: "fake-setup-pass-12" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("(ENOENT)");
    expect(warnings[0]).toContain("PID 1's environment");
    expect(warnings[0]).not.toContain("fake-setup-pass-12");
  });

  it("ignores a handoff variable that does not name an AlphaClaw handoff file, and deletes nothing", () => {
    const secrets = load();
    const victim = path.join(tmpDir, "keep.json");
    fs.writeFileSync(victim, JSON.stringify({ SETUP_PASSWORD: "fake" }));
    const warnings = [];
    expect(secrets.consumeDeploymentSecretsHandoff({ ALPHACLAW_DEPLOYMENT_SECRETS_FILE: victim }, { logger: { warn: (line) => warnings.push(line) } })).toBe(false);
    expect(fs.existsSync(victim)).toBe(true);
    expect(secrets.getDeploymentSecret("SETUP_PASSWORD", {})).toBe("");
    expect(warnings).toHaveLength(1);
  });

  it("re-execs with the secrets only in the handoff, and stays put when there is nothing to scrub", () => {
    const secrets = load();
    const execve = vi.fn();
    expect(secrets.reexecWithoutDeploymentSecrets({ env: { PATH: "/usr/bin" }, execve })).toBe(false);
    expect(execve).not.toHaveBeenCalled();
    const env = { PATH: "/usr/bin", SETUP_PASSWORD: "fake-setup-pass-4" };
    secrets.reexecWithoutDeploymentSecrets({ env, execPath: "/node", execArgv: ["--require=x"], argv: ["/node", "/bin/alphaclaw.js", "start"], execve, tmpDir });
    expect(execve).toHaveBeenCalledTimes(1);
    const [file, args, childEnv] = execve.mock.calls[0];
    expect([file, args]).toEqual(["/node", ["/node", "--require=x", "/bin/alphaclaw.js", "start"]]);
    expect(Object.keys(childEnv).sort()).toEqual(["ALPHACLAW_DEPLOYMENT_SECRETS_FILE", "PATH"]);
    expect(JSON.parse(fs.readFileSync(childEnv.ALPHACLAW_DEPLOYMENT_SECRETS_FILE, "utf8"))).toEqual({ SETUP_PASSWORD: "fake-setup-pass-4" });
  });

  // #342 round 4: under --env-file, -r dotenv/config or --import every image
  // loads the secrets again; a second exec would loop on the same pid forever.
  it("after a handoff, secrets that came back are captured with one warning naming the preload, and never exec again", () => {
    const writer = load();
    writer.captureDeploymentSecrets({ SETUP_PASSWORD: "fake-setup-pass-11" });
    const handedOver = writer.withDeploymentSecretsHandoff({ PATH: "/usr/bin" }, { tmpDir });
    const secrets = load();
    const env = { ...handedOver, SETUP_PASSWORD: "fake-setup-pass-11" };
    const execve = vi.fn();
    const warnings = [];
    expect(secrets.consumeDeploymentSecretsHandoff(env)).toBe(true);
    expect(
      secrets.reexecWithoutDeploymentSecrets({
        env,
        execArgv: ["--env-file=/srv/app/.env", "--max-old-space-size=512"],
        argv: ["/node", "/bin/alphaclaw.js", "start"],
        execve,
        tmpDir,
        logger: { warn: (line) => warnings.push(line) },
      }),
    ).toBe(false);
    expect(execve).not.toHaveBeenCalled();
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(secrets.getDeploymentSecret("SETUP_PASSWORD", {})).toBe("fake-setup-pass-11");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("(--env-file=/srv/app/.env)");
    expect(warnings[0]).not.toContain("fake-setup-pass-11");
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it("without execve, still keeps the secrets out of process.env for children and says what remains", () => {
    const secrets = load();
    const warnings = [];
    const env = { SETUP_PASSWORD: "fake-setup-pass-5" };
    expect(secrets.reexecWithoutDeploymentSecrets({ env, execve: null, logger: { warn: (line) => warnings.push(line) } })).toBe(false);
    expect(env).toEqual({});
    expect(secrets.getDeploymentSecret("SETUP_PASSWORD", {})).toBe("fake-setup-pass-5");
    expect(warnings.join("\n")).toContain("/proc environ");
    expect(warnings.join("\n")).not.toContain("fake-setup-pass-5");
  });

  it("a real re-exec leaves no secret in /proc/self/environ and keeps the value in the module", () => {
    if (process.platform !== "linux") return;
    const script = path.join(tmpDir, "reexec.js");
    fs.writeFileSync(
      script,
      [
        "const secrets = require(" + JSON.stringify(modulePath) + ");",
        "secrets.consumeDeploymentSecretsHandoff(process.env);",
        "secrets.reexecWithoutDeploymentSecrets();",
        "const environ = require('fs').readFileSync('/proc/self/environ', 'utf8');",
        "console.log(JSON.stringify({ pid: process.pid, inEnviron: environ.includes('fake-setup-pass-6'), inProcessEnv: 'SETUP_PASSWORD' in process.env, value: secrets.getDeploymentSecret('SETUP_PASSWORD') }));",
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { PATH: process.env.PATH, SETUP_PASSWORD: "fake-setup-pass-6" } });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim());
    expect(report).toMatchObject({ inEnviron: false, inProcessEnv: false, value: "fake-setup-pass-6" });
    expect(report.pid).toBe(result.pid);
  });
});
