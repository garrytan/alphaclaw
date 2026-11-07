const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// #342 round 4: bin/alphaclaw.js re-execs (same pid) to drop the deployment
// secrets from its environ. Under `node --env-file`, a `-r dotenv/config`
// preload or an `--import` preload, every new image loads SETUP_PASSWORD
// again, so the re-exec'd image saw it, exec'd again, and the server never
// bound its port. The real entrypoint must exec at most once and serve.
const kBinPath = path.resolve(__dirname, "..", "..", "bin", "alphaclaw.js");
const kPw = "plain-words-for-login";
const kRepeatWarning = "Deployment secrets were set again after the handoff";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const request = ({ port, method = "GET", reqPath, body }) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: reqPath,
        headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {},
        timeout: 2000,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

// scrubTestRunnerEnv (tests/live/live-helpers.js), minus any inherited password.
const scrubbedEnv = () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST")) delete env[key];
  }
  delete env.SETUP_PASSWORD;
  return env;
};

const stopGroup = async (child, exited) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const done = await Promise.race([exited.then(() => true), sleep(15000).then(() => false)]);
  if (!done) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await exited;
  }
};

describe("bin/alphaclaw.js start under a Node.js preload that sets SETUP_PASSWORD", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-preload-boot-")));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const cases = [
    ["--env-file", (dir) => {
      const file = path.join(dir, "deploy.env");
      fs.writeFileSync(file, "SETUP_PASSWORD=" + kPw + "\n");
      return ["--env-file=" + file];
    }],
    ["-r preload (dotenv/config stand-in)", (dir) => {
      const file = path.join(dir, "dotenv-config.cjs");
      fs.writeFileSync(file, "process.env.SETUP_PASSWORD = " + JSON.stringify(kPw) + ";\n");
      return ["-r", file];
    }],
    ["--import preload", (dir) => {
      const file = path.join(dir, "load-env.mjs");
      fs.writeFileSync(file, "process.env.SETUP_PASSWORD = " + JSON.stringify(kPw) + ";\n");
      return ["--import", file];
    }],
  ];

  for (const [label, preloadArgs] of cases) {
    it(label + ": execs at most once, binds the port and serves the password", async () => {
      if (process.platform !== "linux") return;
      const rootDir = path.join(tmpDir, "root");
      const binDir = path.join(tmpDir, "fake-bin");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, "gog"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const countPath = path.join(tmpDir, "images.txt");
      const countPreload = path.join(tmpDir, "count-images.cjs");
      fs.writeFileSync(countPreload, "require('fs').appendFileSync(" + JSON.stringify(countPath) + ", process.pid + '\\n');\n");
      const port = 40000 + Math.floor(Math.random() * 9000);
      const child = spawn(
        process.execPath,
        [...preloadArgs(tmpDir), "--require=" + countPreload, kBinPath, "start"],
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...scrubbedEnv(),
            PATH: binDir + ":" + process.env.PATH,
            HOME: tmpDir,
            XDG_CONFIG_HOME: path.join(tmpDir, ".config"),
            ALPHACLAW_ROOT_DIR: rootDir,
            ALPHACLAW_GIT_SHIM_PATH: path.join(tmpDir, "git-shim"),
            ALPHACLAW_OPENCLAW_WRAPPER_PATH: path.join(tmpDir, "wrapper-openclaw.sh"),
            ALPHACLAW_PROFILE_SNIPPET_PATH: path.join(tmpDir, "profile-openclaw.sh"),
            ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL: "true",
            PORT: String(port),
          },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const exited = new Promise((resolve) => child.on("exit", resolve));
      const images = () => (fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8").split("\n").filter(Boolean) : []);
      try {
        let served = null;
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline && child.exitCode === null) {
          expect(images().length, "re-exec loop: " + images().length + " images").toBeLessThanOrEqual(2);
          if (stdout.includes("Express listening on :" + port)) {
            const health = await request({ port, reqPath: "/health" }).catch(() => null);
            if (health?.status === 200 && JSON.parse(health.text).status !== "updating") {
              served = health;
              break;
            }
          }
          await sleep(250);
        }
        expect(served, "never bound :" + port + "\n" + stderr + "\n" + stdout).not.toBeNull();
        expect(images()).toEqual([String(child.pid), String(child.pid)]);
        expect(stderr.split(kRepeatWarning).length - 1).toBe(1);
        expect(stdout + stderr).not.toContain(kPw);
        const login = await request({ port, method: "POST", reqPath: "/api/auth/login", body: JSON.stringify({ password: kPw }) });
        expect(login.status).toBe(200);
      } finally {
        await stopGroup(child, exited);
      }
    }, 90000);
  }
});
