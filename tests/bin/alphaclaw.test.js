const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

describe("bin/alphaclaw port check", () => {
  let tmpDir;
  let tmpHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-test-"));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-home-"));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {}
    try {
      if (fs.existsSync(tmpHome)) {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    } catch {}
  });

  const binPath = path.resolve(__dirname, "../../bin/alphaclaw.js");

  // The CLI's Node version gate fires before anything these tests assert on
  // (port check, SETUP_PASSWORD, state-dir export). Pin process.versions.node
  // to a supported release via --require — the same preload idiom the
  // git-sync version test below uses — so the gate is deterministic no matter
  // which Node the host happens to run the suite with.
  const supportedNodePreload = () => {
    const preloadPath = path.join(tmpDir, "force-supported-node.js");
    fs.writeFileSync(
      preloadPath,
      `Object.defineProperty(process.versions, "node", { value: "22.22.3" });`,
    );
    return `--require="${preloadPath}"`;
  };

  it("allows git-sync on Node versions below OpenClaw's runtime minimum", () => {
    const preloadPath = path.join(tmpDir, "override-node-version.js");
    fs.writeFileSync(
      preloadPath,
      `Object.defineProperty(process.versions, "node", { value: "22.22.2" });`,
    );

    let output = "";
    let status = 0;
    try {
      execSync(`node --require="${preloadPath}" "${binPath}" git-sync`, {
        stdio: "pipe",
        encoding: "utf8",
        env: { ...process.env, ALPHACLAW_ROOT_DIR: tmpDir },
      });
    } catch (error) {
      status = error.status;
      output = `${error.stdout || ""}${error.stderr || ""}`;
    }

    expect(status).toBe(1);
    expect(output).toContain("Missing --message for git-sync");
    expect(output).not.toContain("Node.js 22.22.2 is not supported");
  });

  it("generates an operator-shell openclaw wrapper that works under POSIX sh without the dev shim", () => {
    // The wrapper is #!/bin/sh; its PATH fallback must be POSIX (an earlier
    // revision used `command -v -a`, which dash/bash-as-sh reject — every
    // non-dev-channel box got a wrapper that exits 127 in front of a
    // perfectly good openclaw).
    const wrapperPath = path.join(tmpDir, "wrapper", "openclaw");
    const profilePath = path.join(tmpDir, "profile.d", "alphaclaw-openclaw.sh");
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    // A "real" openclaw further down PATH (the pin install; no dev shim).
    const realBinDir = path.join(tmpDir, "realbin");
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(
      path.join(realBinDir, "openclaw"),
      [
        "#!/bin/sh",
        'printf "REAL_OPENCLAW args=%s OPENCLAW_STATE_DIR=%s\n" "$*" "${OPENCLAW_STATE_DIR:-}"',
      ].join("\n"),
      { mode: 0o755 },
    );

    // Intercept the final lib/server.js require so `start` runs the whole
    // launcher (incl. the wrapper install) without booting a real server.
    const interceptPreload = path.join(tmpDir, "intercept-server-load.js");
    fs.writeFileSync(
      interceptPreload,
      `
Object.defineProperty(process.versions, "node", { value: "22.22.3" });
const Module = require("module");
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (typeof request === "string" && /lib[\\/]server(\.js)?$/.test(request)) {
    process.exit(0);
  }
  return realLoad.apply(this, arguments);
};
`,
    );
    try {
      execSync(`node --require="${interceptPreload}" "${binPath}" start`, {
        stdio: "pipe",
        encoding: "utf8",
        timeout: 60000,
        env: {
          ...process.env,
          ALPHACLAW_ROOT_DIR: tmpDir,
          ALPHACLAW_OPENCLAW_WRAPPER_PATH: wrapperPath,
          ALPHACLAW_PROFILE_SNIPPET_PATH: profilePath,
          SETUP_PASSWORD: "test-password",
          PORT: "3999",
          ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL: "true",
          HOME: tmpHome,
        },
      });
    } catch {
      // Any nonzero exit after the wrapper install is irrelevant here.
    }

    expect(fs.existsSync(wrapperPath)).toBe(true);
    const wrapperText = fs.readFileSync(wrapperPath, "utf8");
    expect(wrapperText).not.toContain("command -v -a");

    // Execute the generated wrapper under sh: no shim exists, so the PATH
    // walk must find the real openclaw (skipping the wrapper itself) and the
    // managed env must be exported.
    const output = execSync(`sh "${wrapperPath}" status --json`, {
      encoding: "utf8",
      timeout: 15000,
      env: {
        PATH: `${path.dirname(wrapperPath)}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH}`,
      },
    });
    expect(output).toContain("REAL_OPENCLAW args=status --json");
    expect(output).toContain(`OPENCLAW_STATE_DIR=${path.join(tmpDir, ".openclaw")}`);

    // The install outcome is persisted, never silent.
    const outcome = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".openclaw", ".alphaclaw", "operator-shell-env.json"),
        "utf8",
      ),
    );
    expect(outcome.wrapper).toContain("installed");
    expect(outcome.profileSnippet).toContain("installed");
    expect(fs.readFileSync(profilePath, "utf8")).toContain("OPENCLAW_STATE_DIR=");
  });

  it("exports the OpenClaw state env for non-start verbs and leaves HOME alone", () => {
    // Issue #25: every CLI verb (git-sync, admin, telegram ...) can shell
    // `openclaw` or spawn children that do; without OPENCLAW_STATE_DIR those
    // resolve ~/.openclaw and, on >= 2026.9.1-beta.1, build a divergent
    // second state database. `start` already exported the vars (test below);
    // this guards the verb path. HOME must stay untouched for verbs: hoisting
    // it would reroute git config/SSH for git-sync and npm for updates.
    const capturePath = path.join(tmpDir, "captured-verb-env.json");
    const preloadPath = path.join(tmpDir, "capture-verb-env.js");
    fs.writeFileSync(
      preloadPath,
      `
Object.defineProperty(process.versions, "node", { value: "22.22.3" });
const fs = require("fs");
process.on("exit", () => {
  fs.writeFileSync(process.env.ALPHACLAW_CAPTURE_ENV_PATH, JSON.stringify({
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }));
});
`,
    );

    try {
      execSync(`node --require="${preloadPath}" "${binPath}" git-sync`, {
        stdio: "pipe",
        encoding: "utf8",
        env: {
          ...process.env,
          ALPHACLAW_ROOT_DIR: tmpDir,
          ALPHACLAW_CAPTURE_ENV_PATH: capturePath,
          HOME: tmpHome,
          XDG_CONFIG_HOME: "",
        },
      });
    } catch {
      // git-sync exits 1 (missing --message) AFTER the env hoist — expected.
    }

    const reported = JSON.parse(fs.readFileSync(capturePath, "utf8"));
    expect(reported.OPENCLAW_HOME).toBe(tmpDir);
    expect(reported.OPENCLAW_STATE_DIR).toBe(path.join(tmpDir, ".openclaw"));
    expect(reported.OPENCLAW_CONFIG_PATH).toBe(
      path.join(tmpDir, ".openclaw", "openclaw.json"),
    );
    // Verb paths never touch HOME/XDG_CONFIG_HOME (start does — separately).
    expect(reported.HOME).toBe(tmpHome);
    expect(reported.XDG_CONFIG_HOME || "").toBe("");
  });

  it("exits with error if PORT env var is 18789", () => {
    let output = "";
    let status = 0;
    try {
      execSync(`ALPHACLAW_ROOT_DIR="${tmpDir}" node ${supportedNodePreload()} "${binPath}" start`, {
        stdio: "pipe",
        encoding: "utf8",
        env: { ...process.env, PORT: "18789", ALPHACLAW_ROOT_DIR: tmpDir }
      });
    } catch (e) {
      status = e.status;
      output = e.stdout + e.stderr;
    }

    expect(status).toBe(1);
    expect(output).toContain("AlphaClaw cannot be started on port 18789");
    expect(output).toContain("reserved for the OpenClaw gateway");
  });

  it("exits with error if --port flag is 18789", () => {
    let output = "";
    let status = 0;
    try {
      execSync(`ALPHACLAW_ROOT_DIR="${tmpDir}" node ${supportedNodePreload()} "${binPath}" start --port 18789`, {
        stdio: "pipe",
        encoding: "utf8",
        env: { ...process.env, PORT: "3000", ALPHACLAW_ROOT_DIR: tmpDir }
      });
    } catch (e) {
      status = e.status;
      output = e.stdout + e.stderr;
    }

    expect(status).toBe(1);
    expect(output).toContain("AlphaClaw cannot be started on port 18789");
    expect(output).toContain("reserved for the OpenClaw gateway");
  });

  it("does not exit if PORT is not 18789 (fails on SETUP_PASSWORD)", () => {
    let output = "";
    let status = 0;
    try {
      // We expect it to fail on SETUP_PASSWORD missing, which is AFTER the port check
      execSync(`ALPHACLAW_ROOT_DIR="${tmpDir}" node ${supportedNodePreload()} "${binPath}" start`, {
        stdio: "pipe",
        encoding: "utf8",
        env: { ...process.env, PORT: "3001", ALPHACLAW_ROOT_DIR: tmpDir, SETUP_PASSWORD: "" }
      });
    } catch (e) {
      status = e.status;
      output = e.stdout + e.stderr;
    }

    expect(status).toBe(1);
    expect(output).not.toContain("AlphaClaw cannot be started on port 18789");
    expect(output).toContain("SETUP_PASSWORD is missing or empty");
  });

  it("boot reconcile falls back to the default schedule when system-sync.json holds an injected one", () => {
    const preloadPath = path.join(tmpDir, "capture-cron-write.js");
    const capturePath = path.join(tmpDir, "captured-cron-content.txt");
    // Seed an on-disk cron config carrying the injection payload the shared
    // guard exists for. The boot reconcile must write the DEFAULT schedule.
    fs.mkdirSync(path.join(tmpDir, ".openclaw", "cron"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".openclaw", "cron", "system-sync.json"),
      JSON.stringify({ enabled: true, schedule: "PATH=/tmp/evil\n*\n*\n*\n*" }),
    );
    fs.writeFileSync(
      preloadPath,
      `
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const childProcess = require("child_process");

const realLoad = Module._load;
const realCopyFileSync = fs.copyFileSync;
const realWriteFileSync = fs.writeFileSync;
const realUnlinkSync = fs.unlinkSync;
const realRenameSync = fs.renameSync;
const realChmodSync = fs.chmodSync;

const capturePath = process.env.ALPHACLAW_CAPTURE_CRON_PATH;
const testHome = process.env.ALPHACLAW_TEST_HOME;
if (testHome) {
  os.homedir = () => testHome;
}

childProcess.execSync = (command, options = {}) => "";

const cronWrites = {};
fs.copyFileSync = (src, dest, ...rest) => {
  const target = String(dest || "");
  if (target.startsWith("/usr/local/bin/") || target.startsWith("/etc/cron.d/")) return;
  return realCopyFileSync(src, dest, ...rest);
};
fs.writeFileSync = (targetPath, data, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/etc/cron.d/")) {
    cronWrites[target] = String(data);
    return;
  }
  if (target.startsWith("/usr/local/bin/")) return;
  return realWriteFileSync(targetPath, data, ...rest);
};
fs.renameSync = (from, to, ...rest) => {
  const src = String(from || "");
  const dest = String(to || "");
  if (dest.startsWith("/etc/cron.d/")) {
    // Complete the atomic install against the captured temp content.
    realWriteFileSync(capturePath, cronWrites[src] || "");
    return;
  }
  return realRenameSync(from, to, ...rest);
};
fs.unlinkSync = (targetPath, ...rest) => {
  if (String(targetPath || "").startsWith("/etc/cron.d/")) return;
  return realUnlinkSync(targetPath, ...rest);
};
fs.chmodSync = (targetPath, ...rest) => {
  if (String(targetPath || "").startsWith("/usr/local/bin/")) return;
  return realChmodSync(targetPath, ...rest);
};

Module._load = function patchedLoad(request, parent, isMain) {
  const parentFile = String(parent && parent.filename ? parent.filename : "");
  if (
    (request === "../lib/server.js" || String(request || "").endsWith("/lib/server.js")) &&
    parentFile.endsWith(path.join("bin", "alphaclaw.js"))
  ) {
    return {};
  }
  return realLoad.apply(this, arguments);
};
      `.trim(),
    );

    const output = execSync(`node ${supportedNodePreload()} "${binPath}" start`, {
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        SETUP_PASSWORD: "test-password",
        ALPHACLAW_ROOT_DIR: tmpDir,
        ALPHACLAW_GIT_SHIM_PATH: path.join(tmpDir, "bin", "git"),
        ALPHACLAW_TEST_HOME: tmpHome,
        ALPHACLAW_CAPTURE_CRON_PATH: capturePath,
        NODE_OPTIONS: `--require=${preloadPath}`,
      },
    });

    expect(output).toContain("Ignoring invalid stored sync-cron schedule");
    const cronContent = fs.readFileSync(capturePath, "utf8");
    expect(cronContent).toContain('0 * * * * root bash');
    expect(cronContent).not.toContain("/tmp/evil");
  });

  it("exports OPENCLAW_STATE_DIR during managed startup", () => {
    const preloadPath = path.join(tmpDir, "capture-openclaw-env.js");
    const capturePath = path.join(tmpDir, "captured-openclaw-env.json");
    fs.writeFileSync(
      preloadPath,
      `
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const childProcess = require("child_process");

const realLoad = Module._load;
const realCopyFileSync = fs.copyFileSync;
const realWriteFileSync = fs.writeFileSync;
const realUnlinkSync = fs.unlinkSync;
const realChmodSync = fs.chmodSync;

const capturePath = process.env.ALPHACLAW_CAPTURE_ENV_PATH;
const testHome = process.env.ALPHACLAW_TEST_HOME;
if (testHome) {
  os.homedir = () => testHome;
}

childProcess.execSync = (command, options = {}) => {
  const cmd = String(command || "");
  if (
    cmd.startsWith("command -v ") ||
    cmd === "pgrep -x cron" ||
    cmd === "cron"
  ) {
    return "";
  }
  if (cmd.startsWith("git ")) {
    return "";
  }
  return "";
};

fs.copyFileSync = (src, dest, ...rest) => {
  const target = String(dest || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realCopyFileSync(src, dest, ...rest);
};

fs.writeFileSync = (targetPath, data, ...rest) => {
  const target = String(targetPath || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realWriteFileSync(targetPath, data, ...rest);
};

fs.unlinkSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/etc/cron.d/")) return;
  return realUnlinkSync(targetPath, ...rest);
};

fs.chmodSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/usr/local/bin/")) return;
  return realChmodSync(targetPath, ...rest);
};

Module._load = function patchedLoad(request, parent, isMain) {
  const parentFile = String(parent && parent.filename ? parent.filename : "");
  if (
    (request === "../lib/server.js" || String(request || "").endsWith("/lib/server.js")) &&
    parentFile.endsWith(path.join("bin", "alphaclaw.js"))
  ) {
    fs.writeFileSync(
      capturePath,
      JSON.stringify({
        HOME: process.env.HOME,
        OPENCLAW_HOME: process.env.OPENCLAW_HOME,
        OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
        OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      }),
    );
    return {};
  }
  return realLoad.apply(this, arguments);
};
      `.trim(),
    );

    execSync(`node ${supportedNodePreload()} "${binPath}" start`, {
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        SETUP_PASSWORD: "test-password",
        ALPHACLAW_ROOT_DIR: tmpDir,
        ALPHACLAW_GIT_SHIM_PATH: path.join(tmpDir, "bin", "git"),
        ALPHACLAW_TEST_HOME: tmpHome,
        ALPHACLAW_CAPTURE_ENV_PATH: capturePath,
        NODE_OPTIONS: `--require=${preloadPath}`,
      },
    });

    const reportedEnv = JSON.parse(fs.readFileSync(capturePath, "utf8"));
    expect(reportedEnv).toEqual(expect.objectContaining({
      HOME: tmpDir,
      OPENCLAW_HOME: tmpDir,
      OPENCLAW_CONFIG_PATH: path.join(tmpDir, ".openclaw", "openclaw.json"),
      OPENCLAW_STATE_DIR: path.join(tmpDir, ".openclaw"),
      XDG_CONFIG_HOME: path.join(tmpDir, ".openclaw"),
    }));
    expect(reportedEnv.PATH.split(path.delimiter)[0]).toBe(path.join(tmpDir, "bin"));

  });

  it("bakes --root-dir into lib/server/constants before any lib require (ISSUE-002)", () => {
    // v0.9.38 regression: bin's top-level helpers/self-dependency requires
    // load constants.js, which snapshots ALPHACLAW_ROOT_DIR at first require.
    // The env used to be set only AFTER those requires, so a `--root-dir` run
    // split state across two roots (banner on the flag's root, boot sync/env
    // watcher on ~/.alphaclaw). Assert the constants snapshot the server will
    // actually use (the require cache is shared) points at the flag's root,
    // not the fake home's ~/.alphaclaw.
    const preloadPath = path.join(tmpDir, "capture-root-dir.js");
    const capturePath = path.join(tmpDir, "captured-root-dir.json");
    fs.writeFileSync(
      preloadPath,
      `
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const childProcess = require("child_process");

const realLoad = Module._load;
const realCopyFileSync = fs.copyFileSync;
const realWriteFileSync = fs.writeFileSync;
const realUnlinkSync = fs.unlinkSync;
const realChmodSync = fs.chmodSync;

const capturePath = process.env.ALPHACLAW_CAPTURE_ENV_PATH;
const testHome = process.env.ALPHACLAW_TEST_HOME;
if (testHome) {
  os.homedir = () => testHome;
}

childProcess.execSync = (command, options = {}) => {
  const cmd = String(command || "");
  if (
    cmd.startsWith("command -v ") ||
    cmd === "pgrep -x cron" ||
    cmd === "cron"
  ) {
    return "";
  }
  if (cmd.startsWith("git ")) {
    return "";
  }
  return "";
};

fs.copyFileSync = (src, dest, ...rest) => {
  const target = String(dest || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realCopyFileSync(src, dest, ...rest);
};

fs.writeFileSync = (targetPath, data, ...rest) => {
  const target = String(targetPath || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realWriteFileSync(targetPath, data, ...rest);
};

fs.unlinkSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/etc/cron.d/")) return;
  return realUnlinkSync(targetPath, ...rest);
};

fs.chmodSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/usr/local/bin/")) return;
  return realChmodSync(targetPath, ...rest);
};

Module._load = function patchedLoad(request, parent, isMain) {
  const parentFile = String(parent && parent.filename ? parent.filename : "");
  if (
    (request === "../lib/server.js" || String(request || "").endsWith("/lib/server.js")) &&
    parentFile.endsWith(path.join("bin", "alphaclaw.js"))
  ) {
    // Cached from bin's own top-level requires — this returns the snapshot
    // the whole server would run with.
    const constants = realLoad.call(
      this,
      path.join(path.dirname(parentFile), "..", "lib", "server", "constants.js"),
      parent,
      false,
    );
    fs.writeFileSync(
      capturePath,
      JSON.stringify({
        constantsAlphaclawDir: constants.ALPHACLAW_DIR,
        rootDirEnv: process.env.ALPHACLAW_ROOT_DIR,
      }),
    );
    return {};
  }
  return realLoad.apply(this, arguments);
};
      `.trim(),
    );

    // The child gets NO ALPHACLAW_ROOT_DIR — only the flag names the root.
    const childEnv = {
      ...process.env,
      SETUP_PASSWORD: "test-password",
      ALPHACLAW_TEST_HOME: tmpHome,
      ALPHACLAW_CAPTURE_ENV_PATH: capturePath,
      NODE_OPTIONS: `--require=${preloadPath}`,
    };
    delete childEnv.ALPHACLAW_ROOT_DIR;

    execSync(
      `node ${supportedNodePreload()} "${binPath}" start --root-dir "${tmpDir}"`,
      {
        stdio: "pipe",
        encoding: "utf8",
        env: childEnv,
      },
    );

    const captured = JSON.parse(fs.readFileSync(capturePath, "utf8"));
    expect(captured.constantsAlphaclawDir).toBe(tmpDir);
    expect(captured.rootDirEnv).toBe(tmpDir);
    // The pre-fix baked value: the (fake) home's default root.
    expect(captured.constantsAlphaclawDir).not.toBe(
      path.join(tmpHome, ".alphaclaw"),
    );
  });

  it("creates a gogcli compatibility symlink under the managed home", () => {
    const preloadPath = path.join(tmpDir, "capture-openclaw-env.js");
    fs.writeFileSync(
      preloadPath,
      `
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const childProcess = require("child_process");

const realLoad = Module._load;
const realCopyFileSync = fs.copyFileSync;
const realWriteFileSync = fs.writeFileSync;
const realUnlinkSync = fs.unlinkSync;
const realChmodSync = fs.chmodSync;

const testHome = process.env.ALPHACLAW_TEST_HOME;
if (testHome) {
  os.homedir = () => testHome;
}

childProcess.execSync = (command, options = {}) => {
  const cmd = String(command || "");
  if (
    cmd.startsWith("command -v ") ||
    cmd === "pgrep -x cron" ||
    cmd === "cron"
  ) {
    return "";
  }
  if (cmd.startsWith("git ")) {
    return "";
  }
  return "";
};

fs.copyFileSync = (src, dest, ...rest) => {
  const target = String(dest || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realCopyFileSync(src, dest, ...rest);
};

fs.writeFileSync = (targetPath, data, ...rest) => {
  const target = String(targetPath || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realWriteFileSync(targetPath, data, ...rest);
};

fs.unlinkSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/etc/cron.d/")) return;
  return realUnlinkSync(targetPath, ...rest);
};

fs.chmodSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/usr/local/bin/")) return;
  return realChmodSync(targetPath, ...rest);
};

Module._load = function patchedLoad(request, parent, isMain) {
  const parentFile = String(parent && parent.filename ? parent.filename : "");
  if (
    (request === "../lib/server.js" || String(request || "").endsWith("/lib/server.js")) &&
    parentFile.endsWith(path.join("bin", "alphaclaw.js"))
  ) {
    return {};
  }
  return realLoad.apply(this, arguments);
};
      `.trim(),
    );

    execSync(`node ${supportedNodePreload()} "${binPath}" start`, {
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        SETUP_PASSWORD: "test-password",
        ALPHACLAW_ROOT_DIR: tmpDir,
        ALPHACLAW_TEST_HOME: tmpHome,
        NODE_OPTIONS: `--require=${preloadPath}`,
      },
    });

    const compatPath = path.join(tmpDir, ".config", "gogcli");
    const managedPath = path.join(tmpDir, ".openclaw", "gogcli");
    expect(fs.lstatSync(compatPath).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(compatPath), fs.readlinkSync(compatPath))).toBe(
      managedPath,
    );
  });

  it("does not replace an existing gogcli config directory", () => {
    const preloadPath = path.join(tmpDir, "capture-openclaw-env.js");
    fs.writeFileSync(
      preloadPath,
      `
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const childProcess = require("child_process");

const realLoad = Module._load;
const realCopyFileSync = fs.copyFileSync;
const realWriteFileSync = fs.writeFileSync;
const realUnlinkSync = fs.unlinkSync;
const realChmodSync = fs.chmodSync;

const testHome = process.env.ALPHACLAW_TEST_HOME;
if (testHome) {
  os.homedir = () => testHome;
}

childProcess.execSync = (command, options = {}) => {
  const cmd = String(command || "");
  if (
    cmd.startsWith("command -v ") ||
    cmd === "pgrep -x cron" ||
    cmd === "cron"
  ) {
    return "";
  }
  if (cmd.startsWith("git ")) {
    return "";
  }
  return "";
};

fs.copyFileSync = (src, dest, ...rest) => {
  const target = String(dest || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realCopyFileSync(src, dest, ...rest);
};

fs.writeFileSync = (targetPath, data, ...rest) => {
  const target = String(targetPath || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realWriteFileSync(targetPath, data, ...rest);
};

fs.unlinkSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/etc/cron.d/")) return;
  return realUnlinkSync(targetPath, ...rest);
};

fs.chmodSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/usr/local/bin/")) return;
  return realChmodSync(targetPath, ...rest);
};

Module._load = function patchedLoad(request, parent, isMain) {
  const parentFile = String(parent && parent.filename ? parent.filename : "");
  if (
    (request === "../lib/server.js" || String(request || "").endsWith("/lib/server.js")) &&
    parentFile.endsWith(path.join("bin", "alphaclaw.js"))
  ) {
    return {};
  }
  return realLoad.apply(this, arguments);
};
      `.trim(),
    );

    const compatPath = path.join(tmpDir, ".config", "gogcli");
    fs.mkdirSync(compatPath, { recursive: true });
    fs.writeFileSync(path.join(compatPath, "config.json"), "{}");

    execSync(`node ${supportedNodePreload()} "${binPath}" start`, {
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        SETUP_PASSWORD: "test-password",
        ALPHACLAW_ROOT_DIR: tmpDir,
        ALPHACLAW_TEST_HOME: tmpHome,
        NODE_OPTIONS: `--require=${preloadPath}`,
      },
    });

    expect(fs.lstatSync(compatPath).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(compatPath, "config.json"))).toBe(true);
  });

  // Fix wave PR 2 — boot spine. One `start` boot per case, driven through the
  // same preload idiom as ISSUE-002: child_process is stubbed and recorded,
  // writes to /usr/local/bin and /etc/cron.d are swallowed, and lib/server.js
  // is intercepted so the capture describes exactly what the real server
  // would run with.
  const writeBootSpinePreload = () => {
    const preloadPath = path.join(tmpDir, "capture-boot-spine.js");
    fs.writeFileSync(
      preloadPath,
      `
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const childProcess = require("child_process");

const capturePath = process.env.ALPHACLAW_CAPTURE_ENV_PATH;
const testHome = process.env.ALPHACLAW_TEST_HOME;
if (testHome) os.homedir = () => testHome;

const recorded = { execSync: [], execFileSync: [] };
const realExecFileSync = childProcess.execFileSync;
childProcess.execSync = (command) => {
  recorded.execSync.push(String(command || ""));
  return "";
};
childProcess.execFileSync = (file, args, options) => {
  const argv = Array.isArray(args) ? args.map(String) : [];
  recorded.execFileSync.push([String(file), ...argv].join(" "));
  // Keep the real git for the origin scrub probe (get-url) so §10 behaves as
  // in production; everything else (set-url, npm, curl, tar) is recorded only.
  if (String(file) === "git" && argv[1] === "get-url") {
    try { return realExecFileSync(file, args, options); } catch { return ""; }
  }
  return "";
};

for (const [name, real] of [["copyFileSync", fs.copyFileSync], ["writeFileSync", fs.writeFileSync], ["unlinkSync", fs.unlinkSync], ["chmodSync", fs.chmodSync]]) {
  fs[name] = (targetPath, ...rest) => {
    const target = String(targetPath || "");
    if (target.startsWith("/usr/local/bin/") || target.startsWith("/etc/cron.d/")) return;
    return real.call(fs, targetPath, ...rest);
  };
}

const realLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  const parentFile = String(parent && parent.filename ? parent.filename : "");
  if (
    (request === "../lib/server.js" || String(request || "").endsWith("/lib/server.js")) &&
    parentFile.endsWith(path.join("bin", "alphaclaw.js"))
  ) {
    const constants = realLoad.call(
      this,
      path.join(path.dirname(parentFile), "..", "lib", "server", "constants.js"),
      parent,
      false,
    );
    fs.writeFileSync(
      capturePath,
      JSON.stringify({
        constantsPort: constants.PORT,
        portEnv: process.env.PORT,
        recorded,
        githubRepoEnv: process.env.GITHUB_WORKSPACE_REPO || "",
      }),
    );
    return {};
  }
  return realLoad.apply(this, arguments);
};
      `.trim(),
    );
    return preloadPath;
  };

  const runBootSpine = ({ rootDir, extraArgs = "", env = {} }) => {
    const preloadPath = writeBootSpinePreload();
    const capturePath = path.join(tmpDir, `captured-boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.json`);
    const childEnv = {
      ...process.env,
      SETUP_PASSWORD: "test-password",
      ALPHACLAW_TEST_HOME: tmpHome,
      ALPHACLAW_CAPTURE_ENV_PATH: capturePath,
      ALPHACLAW_ROOT_DIR: rootDir,
      ALPHACLAW_OPENCLAW_WRAPPER_PATH: path.join(rootDir, "wrapper-openclaw.sh"),
      NODE_OPTIONS: `--require=${preloadPath}`,
      ...env,
    };
    delete childEnv.PORT;
    delete childEnv.GITHUB_WORKSPACE_REPO;
    if (env.PORT !== undefined) childEnv.PORT = env.PORT;
    if (env.GITHUB_WORKSPACE_REPO !== undefined) childEnv.GITHUB_WORKSPACE_REPO = env.GITHUB_WORKSPACE_REPO;
    // spawnSync via a shell so the preload flag string is honored verbatim;
    // both streams are captured (boot warnings go to stderr).
    const result = require("child_process").spawnSync(
      `node ${supportedNodePreload()} "${binPath}" start --root-dir "${rootDir}" ${extraArgs}`,
      { shell: true, encoding: "utf8", env: childEnv },
    );
    if (result.status !== 0) {
      throw new Error(`boot exited ${result.status}: ${result.stderr}\n${result.stdout}`);
    }
    const output = `${result.stdout}\n${result.stderr}`;
    return { captured: JSON.parse(fs.readFileSync(capturePath, "utf8")), output };
  };

  it("honors `start --port <n>` in the constants snapshot the real server uses (F193)", () => {
    const rootDir = fs.mkdtempSync(path.join(tmpDir, "port-root-"));
    const { captured } = runBootSpine({ rootDir, extraArgs: "--port 3999" });
    expect(captured.constantsPort).toBe(3999);
    expect(captured.portEnv).toBe("3999");
    const fromEnv = runBootSpine({ rootDir, env: { PORT: "3001" } });
    expect(fromEnv.captured.constantsPort).toBe(3001);
  });

  it("never lets a shell-injected GITHUB_WORKSPACE_REPO from .env reach a shell, and refuses the malformed slug (F001)", () => {
    const rootDir = fs.mkdtempSync(path.join(tmpDir, "inject-root-"));
    const openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(path.join(openclawDir, ".git"), { recursive: true });
    const pwned = path.join(tmpDir, "pwned-marker");
    fs.writeFileSync(
      path.join(rootDir, ".env"),
      `GITHUB_WORKSPACE_REPO=owner/repo"$(touch ${pwned})"\n`,
    );
    const { captured, output } = runBootSpine({ rootDir });
    expect(fs.existsSync(pwned)).toBe(false);
    // The value was loaded (the loader itself is unchanged)…
    expect(captured.githubRepoEnv).toContain("$(touch");
    // …but no child process ever saw a `$(`, and the malformed slug never
    // reached `git remote set-url` at all.
    const everything = [...captured.recorded.execSync, ...captured.recorded.execFileSync].join("\n");
    expect(everything).not.toContain("$(");
    expect(everything).not.toContain("set-url");
    expect(output).toContain("is not owner/repo");

    // A well-formed slug goes to git as argv behind `--`.
    fs.writeFileSync(path.join(rootDir, ".env"), "GITHUB_WORKSPACE_REPO=owner/repo\n");
    const good = runBootSpine({ rootDir });
    expect(good.captured.recorded.execFileSync).toContain(
      "git remote set-url origin -- https://github.com/owner/repo.git",
    );
    expect(good.captured.recorded.execSync.some((cmd) => cmd.includes("set-url"))).toBe(false);
  });

  it("never overwrites a non-managed file at ALPHACLAW_PROFILE_SNIPPET_PATH and records the skip (F003)", () => {
    const rootDir = fs.mkdtempSync(path.join(tmpDir, "snippet-root-"));
    const snippetPath = path.join(rootDir, "operator-profile.sh");
    fs.writeFileSync(snippetPath, "# operator's own profile snippet\nexport FOO=bar\n");
    runBootSpine({ rootDir, env: { ALPHACLAW_PROFILE_SNIPPET_PATH: snippetPath } });
    expect(fs.readFileSync(snippetPath, "utf8")).toBe("# operator's own profile snippet\nexport FOO=bar\n");
    const outcome = JSON.parse(
      fs.readFileSync(path.join(rootDir, ".openclaw", ".alphaclaw", "operator-shell-env.json"), "utf8"),
    );
    expect(outcome.profileSnippet).toBe("skipped: existing non-managed file");

    // A managed snippet (marker present) is still regenerated.
    fs.writeFileSync(snippetPath, "# alphaclaw-managed openclaw environment — stale\n");
    runBootSpine({ rootDir, env: { ALPHACLAW_PROFILE_SNIPPET_PATH: snippetPath } });
    expect(fs.readFileSync(snippetPath, "utf8")).toContain("export OPENCLAW_STATE_DIR=");
  });

  it("trims .env keys like the server parser (F006)", () => {
    const rootDir = fs.mkdtempSync(path.join(tmpDir, "trim-root-"));
    fs.writeFileSync(path.join(rootDir, ".env"), "GITHUB_WORKSPACE_REPO =owner/trimmed\n");
    const { captured } = runBootSpine({ rootDir });
    expect(captured.githubRepoEnv).toBe("owner/trimmed");
  });

  // F004 follow-up: the single-instance refusal needs evidence. A hard-killed
  // predecessor leaves its pidfile on the volume, and a fresh container's early
  // processes reuse low pid numbers, so kill(pid, 0) alone says "alive" — the
  // container-e2e durability leg caught exactly that as a boot crash loop.
  const spawnBootSpine = ({ rootDir }) => {
    const preloadPath = writeBootSpinePreload();
    const capturePath = path.join(
      tmpDir,
      `captured-boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.json`,
    );
    const childEnv = {
      ...process.env,
      SETUP_PASSWORD: "test-password",
      ALPHACLAW_TEST_HOME: tmpHome,
      ALPHACLAW_CAPTURE_ENV_PATH: capturePath,
      ALPHACLAW_ROOT_DIR: rootDir,
      ALPHACLAW_OPENCLAW_WRAPPER_PATH: path.join(rootDir, "wrapper-openclaw.sh"),
      NODE_OPTIONS: `--require=${preloadPath}`,
    };
    delete childEnv.PORT;
    delete childEnv.GITHUB_WORKSPACE_REPO;
    return require("child_process").spawnSync(
      `node ${supportedNodePreload()} "${binPath}" start --root-dir "${rootDir}"`,
      { shell: true, encoding: "utf8", env: childEnv },
    );
  };
  const writeServerPidRecord = (rootDir, record) => {
    const managedDir = path.join(rootDir, ".openclaw", ".alphaclaw");
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(path.join(managedDir, "alphaclaw-server.pid"), JSON.stringify(record));
  };
  const spawnSleeper = () =>
    require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
  const hasProc = process.platform === "linux" && fs.existsSync(`/proc/${process.pid}/stat`);

  it("boots on (with a warning) when the pidfile names a live pid it cannot verify — legacy record (F004 follow-up)", () => {
    const rootDir = fs.mkdtempSync(path.join(tmpDir, "stale-pid-root-"));
    const child = spawnSleeper();
    try {
      writeServerPidRecord(rootDir, { pid: child.pid, at: 1 });
      const result = spawnBootSpine({ rootDir });
      expect(result.status, result.stderr).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(
        /could not be verified — boot sync skipped, continuing/,
      );
    } finally {
      child.kill("SIGKILL");
    }
  });

  it.skipIf(!hasProc)("refuses to start (exit 1) when the live pid is corroborated by its kernel start time (F004)", () => {
    const { readProcStartTicks } = require("../../lib/server/utils/safe-file");
    const rootDir = fs.mkdtempSync(path.join(tmpDir, "live-pid-root-"));
    const child = spawnSleeper();
    try {
      writeServerPidRecord(rootDir, {
        pid: child.pid,
        at: 1,
        startTicks: readProcStartTicks(child.pid, fs),
      });
      const result = spawnBootSpine({ rootDir });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Refusing to start a second instance/);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it.skipIf(!hasProc)("boots normally when the recorded pid was recycled (start time differs)", () => {
    const { readProcStartTicks } = require("../../lib/server/utils/safe-file");
    const rootDir = fs.mkdtempSync(path.join(tmpDir, "recycled-pid-root-"));
    const child = spawnSleeper();
    try {
      writeServerPidRecord(rootDir, {
        pid: child.pid,
        at: 1,
        startTicks: readProcStartTicks(child.pid, fs) - 777,
      });
      const result = spawnBootSpine({ rootDir });
      expect(result.status, result.stderr).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/boot sync skipped: another/);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
