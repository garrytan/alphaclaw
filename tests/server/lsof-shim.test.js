// The ask-scoped lsof shim (bug #137): a /proc-backed stand-in for the
// `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc` call the pinned OpenClaw CLI
// makes from `gateway restart`, plus the resolver that appends it to the ask
// spawn's PATH only when no real lsof exists. Spawned for real against a
// listening socket; the incomplete-discovery cases run on a fake /proc.
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { kShimDir, kShimPath, resolveAskLsofPath, withAskLsofPath } = require("../../lib/server/lsof-shim");
const { findPortListeners, findPortListenerPids, kMaxProcScan } = require("../../lib/server/gateway-identity");

const kRepoRoot = path.resolve(__dirname, "../..");
const kInstallHint = "install lsof (apt-get install -y lsof)";
const hasProc = process.platform === "linux" && fs.existsSync(`/proc/${process.pid}/fd`);
const describeLinux = hasProc ? describe : describe.skip;

const runShim = (args) =>
  spawnSync(process.execPath, [kShimPath, ...args], { encoding: "utf8", timeout: 15000 });

const listen = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const close = (server) => new Promise((resolve) => server.close(() => resolve()));

// A port nothing listens on: bind, read the number, release it.
const freePort = async () => {
  const server = await listen();
  const { port } = server.address();
  await close(server);
  return port;
};

// A fake /proc: `tables` are the raw /proc/net/tcp{,6} texts (or an Error to
// throw), `procs` maps pid → { fds: { fd: linkTarget } } or { error: code }.
const fakeFs = ({ tables = {}, procs = {} } = {}) => ({
  readFileSync: (file) => {
    const value = tables[file];
    if (value instanceof Error) throw value;
    if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return value;
  },
  readdirSync: (dir) => {
    if (dir === "/proc") return [...Object.keys(procs), "self", "cpuinfo"];
    const m = /^\/proc\/(\d+)\/fd$/.exec(dir);
    const proc = m ? procs[m[1]] : undefined;
    if (!proc) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    if (proc.error) throw Object.assign(new Error(proc.error), { code: proc.error });
    return Object.keys(proc.fds);
  },
  readlinkSync: (file) => {
    const m = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(file);
    const target = m ? procs[m[1]]?.fds?.[m[2]] : undefined;
    if (target === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return target;
  },
});

// One LISTEN row on `port` (hex) with socket inode `inode`, in the kernel's
// /proc/net/tcp layout (header line, then sl local rem st ... inode).
const tcpTable = (rows) =>
  [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    ...rows.map(
      ({ port, inode, state = "0A" }, i) =>
        `   ${i}: 0100007F:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`,
    ),
    "",
  ].join("\n");

describe("lsof shim: file", () => {
  it("is named lsof, has a node shebang and the executable bit set", () => {
    expect(path.basename(kShimPath)).toBe("lsof");
    expect(kShimDir).toBe(path.join(kRepoRoot, "lib", "server", "lsof-shim"));
    expect(fs.readFileSync(kShimPath, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(fs.statSync(kShimPath).mode & 0o111).not.toBe(0);
  });
});

describeLinux("lsof shim: spawned against real sockets", () => {
  it("reports a real listener as p<pid>/c<comm> lines and exits 0", async () => {
    const server = await listen();
    try {
      const { port } = server.address();
      const res = runShim(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      const lines = res.stdout.split("\n").filter(Boolean);
      expect(lines).toContain(`p${process.pid}`);
      const ownComm = fs.readFileSync(`/proc/${process.pid}/comm`, "utf8").trim();
      expect(lines[lines.indexOf(`p${process.pid}`) + 1]).toBe(`c${ownComm}`);
      expect(lines.every((line) => /^[pc]/.test(line))).toBe(true);
    } finally {
      await close(server);
    }
  });

  it("answers -FpFc identically to -Fpc, and -n/-P split or reordered", async () => {
    const server = await listen();
    try {
      const { port } = server.address();
      const canonical = runShim(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
      for (const args of [
        ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpFc"],
        ["-n", "-P", "-FpFc", "-sTCP:LISTEN", `-iTCP:${port}`],
        ["-Fp", "-Fc", "-nP", "-i", `TCP:${port}`, "-s", "TCP:LISTEN"],
      ]) {
        const res = runShim(args);
        expect(res.status, args.join(" ")).toBe(0);
        expect(res.stdout, args.join(" ")).toBe(canonical.stdout);
      }
    } finally {
      await close(server);
    }
  });

  it("adds n*:<port> lines for -FpFcn", async () => {
    const server = await listen();
    try {
      const { port } = server.address();
      const res = runShim(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpFcn"]);
      expect(res.status).toBe(0);
      const lines = res.stdout.split("\n").filter(Boolean);
      const at = lines.indexOf(`p${process.pid}`);
      expect(lines[at + 1].startsWith("c")).toBe(true);
      expect(lines[at + 2]).toBe(`n*:${port}`);
    } finally {
      await close(server);
    }
  });

  it("is reachable the way the pin spawns it: bare `lsof` through an appended PATH, via its shebang", async () => {
    const server = await listen();
    try {
      const { port } = server.address();
      // PATH = node's own dir (for `#!/usr/bin/env node`) + the shim dir
      // appended by withAskLsofPath; fixed candidates are hidden so a real
      // lsof on this box cannot answer instead.
      const hideFixed = {
        constants: fs.constants,
        accessSync: (file, mode) => {
          if (file === "/usr/bin/lsof" || file === "/usr/sbin/lsof") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return fs.accessSync(file, mode);
        },
      };
      const env = withAskLsofPath({ PATH: path.dirname(process.execPath) }, { fsModule: hideFixed, platform: "linux" });
      expect(env.PATH.endsWith(`${path.delimiter}${kShimDir}`)).toBe(true);
      const res = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { env, encoding: "utf8", timeout: 15000 });
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(0);
      expect(res.stdout.split("\n")).toContain(`p${process.pid}`);
    } finally {
      await close(server);
    }
  });

  it("still names the owners it could read when another listener's fd dir is denied (lsof's own behaviour)", async () => {
    // A root-owned listener on the same port cannot be attributed from a
    // non-root scan; the shim must not turn that into exit 2 when the
    // gateway's own pid WAS found — the pin verifies pids by argv anyway.
    const server = await listen();
    try {
      const { port } = server.address();
      const deadline = Date.now() + 1500;
      let res;
      do {
        res = runShim(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
      } while (res.status !== 0 && Date.now() < deadline);
      expect(res.status).toBe(0);
      expect(res.stdout.split("\n")).toContain(`p${process.pid}`);
    } finally {
      await close(server);
    }
  });

  it("exits 1 with EMPTY stdout for a free port (the pin's 'free')", async () => {
    const port = await freePort();
    const res = runShim(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
  });

  it.each([
    [[]],
    [["-nP", "-iTCP", "-sTCP:LISTEN", "-FpFcn"]],
    [["-nP", "-iTCP:18789", "-sTCP:ESTABLISHED", "-FpFcn"]],
    [["-nP", "-iTCP:18789", "-sTCP:LISTEN"]],
    [["-nP", "-iTCP:18789", "-sTCP:LISTEN", "-Fc"]],
    [["-nP", "-iTCP:18789", "-sTCP:LISTEN", "-Fpcn", "-t"]],
    [["-nP", "-iTCP:70000", "-sTCP:LISTEN", "-Fpc"]],
    [["-nP", "-iUDP:18789", "-sTCP:LISTEN", "-Fpc"]],
    [["-i", ":18789"]],
  ])("exits 2 with the install hint on unsupported arguments %j", (args) => {
    const res = runShim(args);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe(`AlphaClaw lsof shim: unsupported arguments — ${kInstallHint}\n`);
  });
});

describe("findPortListeners (fake /proc)", () => {
  const kPort = 18789;
  const kInode = "424242";
  const socket = `socket:[${kInode}]`;

  it("finds the owner through the socket inode and reports complete", () => {
    const fsModule = fakeFs({
      tables: { "/proc/net/tcp": tcpTable([{ port: kPort, inode: kInode }]) },
      procs: {
        1: { fds: { 0: "/dev/null" } },
        4242: { fds: { 0: "/dev/null", 19: socket } },
      },
    });
    expect(findPortListeners(kPort, { fsModule })).toEqual({ complete: true, pids: [4242] });
    expect(findPortListenerPids(kPort, { fsModule })).toEqual([4242]);
  });

  it("is complete with no listener when both tables are readable but empty for the port", () => {
    const fsModule = fakeFs({
      tables: {
        "/proc/net/tcp": tcpTable([{ port: 3000, inode: "1" }, { port: kPort, inode: "2", state: "01" }]),
        "/proc/net/tcp6": tcpTable([]),
      },
      procs: { 1: { fds: {} } },
    });
    expect(findPortListeners(kPort, { fsModule })).toEqual({ complete: true, pids: [] });
  });

  it("is incomplete when both /proc/net/tcp and tcp6 are unreadable", () => {
    const fsModule = fakeFs({ tables: {}, procs: { 1: { fds: {} } } });
    expect(findPortListeners(kPort, { fsModule })).toEqual({ complete: false, pids: [] });
    expect(findPortListenerPids(kPort, { fsModule })).toEqual([]);
  });

  it("is complete when only one table is readable", () => {
    const fsModule = fakeFs({
      tables: { "/proc/net/tcp6": tcpTable([{ port: kPort, inode: kInode }]) },
      procs: { 4242: { fds: { 19: socket } } },
    });
    expect(findPortListeners(kPort, { fsModule })).toEqual({ complete: true, pids: [4242] });
  });

  it.each(["EACCES", "EPERM"])(
    "is incomplete when a /proc/<pid>/fd dir fails %s and a listening inode has no known owner",
    (code) => {
      const fsModule = fakeFs({
        tables: { "/proc/net/tcp": tcpTable([{ port: kPort, inode: kInode }]) },
        procs: {
          1: { error: code },
          4242: { fds: { 0: "/dev/null" } },
        },
      });
      expect(findPortListeners(kPort, { fsModule })).toEqual({ complete: false, pids: [] });
      expect(findPortListenerPids(kPort, { fsModule })).toEqual([]);
    },
  );

  it("stays complete past a denied fd dir once every listening inode has an owner", () => {
    const fsModule = fakeFs({
      tables: { "/proc/net/tcp": tcpTable([{ port: kPort, inode: kInode }]) },
      procs: {
        1: { error: "EACCES" },
        4242: { fds: { 19: socket } },
      },
    });
    expect(findPortListeners(kPort, { fsModule })).toEqual({ complete: true, pids: [4242] });
  });

  it("is incomplete when a second listening inode stays unowned behind a denied fd dir", () => {
    const fsModule = fakeFs({
      tables: {
        "/proc/net/tcp": tcpTable([{ port: kPort, inode: kInode }]),
        "/proc/net/tcp6": tcpTable([{ port: kPort, inode: "777" }]),
      },
      procs: {
        1: { error: "EPERM" },
        4242: { fds: { 19: socket } },
      },
    });
    expect(findPortListeners(kPort, { fsModule })).toEqual({ complete: false, pids: [4242] });
  });

  it.each(["ENOENT", "ESRCH"])("treats a %s fd dir as a process that exited (still complete)", (code) => {
    const fsModule = fakeFs({
      tables: { "/proc/net/tcp": tcpTable([{ port: kPort, inode: kInode }]) },
      procs: {
        7: { error: code },
        4242: { fds: { 19: socket } },
      },
    });
    expect(findPortListeners(kPort, { fsModule })).toEqual({ complete: true, pids: [4242] });
  });

  it("is incomplete when the kMaxProcScan cap cuts the pid listing short", () => {
    const procs = {};
    for (let pid = 1; pid <= kMaxProcScan + 1; pid += 1) procs[pid] = { fds: {} };
    procs[kMaxProcScan + 1] = { fds: { 19: socket } };
    const fsModule = fakeFs({ tables: { "/proc/net/tcp": tcpTable([{ port: kPort, inode: kInode }]) }, procs });
    expect(findPortListeners(kPort, { fsModule })).toEqual({ complete: false, pids: [] });
  });

  it("rejects a non-port as complete and empty", () => {
    const fsModule = fakeFs();
    expect(findPortListeners(0, { fsModule })).toEqual({ complete: true, pids: [] });
    expect(findPortListeners("18789", { fsModule })).toEqual({ complete: true, pids: [] });
  });
});

describe("resolveAskLsofPath / withAskLsofPath", () => {
  const executable = (...files) => ({
    constants: fs.constants,
    accessSync: (file) => {
      if (!files.includes(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  const linux = { platform: "linux" };

  it("prefers the pin's fixed candidates in its order, before PATH", () => {
    const fsModule = executable("/usr/bin/lsof", "/usr/sbin/lsof", "/opt/bin/lsof", kShimPath);
    expect(resolveAskLsofPath({ env: { PATH: "/opt/bin" }, fsModule, ...linux })).toEqual({ path: "/usr/bin/lsof", kind: "real" });
    expect(resolveAskLsofPath({ env: { PATH: "/opt/bin" }, fsModule: executable("/usr/sbin/lsof", kShimPath), ...linux })).toEqual({
      path: "/usr/sbin/lsof",
      kind: "real",
    });
    expect(resolveAskLsofPath({ env: { PATH: "/opt/bin" }, fsModule: executable("/opt/bin/lsof", kShimPath), ...linux })).toEqual({
      path: "/opt/bin/lsof",
      kind: "real",
    });
    expect(resolveAskLsofPath({ env: {}, fsModule: executable("/usr/bin/lsof"), platform: "darwin" })).toEqual({ path: "/usr/bin/lsof", kind: "real" });
    expect(resolveAskLsofPath({ env: {}, fsModule: executable("/usr/bin/lsof", "/usr/sbin/lsof"), platform: "darwin" })).toEqual({
      path: "/usr/sbin/lsof",
      kind: "real",
    });
  });

  it("falls back to the shim on Linux when nothing real resolves", () => {
    const fsModule = executable(kShimPath);
    expect(resolveAskLsofPath({ env: { PATH: "/usr/local/bin:/usr/bin" }, fsModule, ...linux })).toEqual({ path: kShimPath, kind: "shim" });
    expect(resolveAskLsofPath({ env: {}, fsModule, ...linux })).toEqual({ path: kShimPath, kind: "shim" });
  });

  it("is disabled by ALPHACLAW_LSOF_SHIM=0 and off Linux, and when the shim file is not executable", () => {
    const fsModule = executable(kShimPath);
    expect(resolveAskLsofPath({ env: { ALPHACLAW_LSOF_SHIM: "0" }, fsModule, ...linux })).toEqual({ path: null, kind: "none" });
    expect(resolveAskLsofPath({ env: {}, fsModule, platform: "darwin" })).toEqual({ path: null, kind: "none" });
    expect(resolveAskLsofPath({ env: {}, fsModule: executable(), ...linux })).toEqual({ path: null, kind: "none" });
    expect(resolveAskLsofPath({ env: { ALPHACLAW_LSOF_SHIM: "1" }, fsModule, ...linux })).toEqual({ path: kShimPath, kind: "shim" });
  });

  it("withAskLsofPath appends the shim directory (never prepends) and copies the env", () => {
    const fsModule = executable(kShimPath);
    const env = { PATH: "/usr/local/bin:/usr/bin", HOME: "/root" };
    const next = withAskLsofPath(env, { fsModule, ...linux });
    expect(next).not.toBe(env);
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(next.PATH).toBe(`/usr/local/bin:/usr/bin${path.delimiter}${kShimDir}`);
    expect(next.HOME).toBe("/root");
    expect(withAskLsofPath({}, { fsModule, ...linux }).PATH).toBe(kShimDir);
    expect(withAskLsofPath(next, { fsModule, ...linux }).PATH).toBe(next.PATH);
    expect(resolveAskLsofPath({ env: next, fsModule, ...linux })).toEqual({ path: kShimPath, kind: "shim" });
  });

  it("withAskLsofPath is a no-op when a real lsof resolves or the shim is disabled", () => {
    const env = { PATH: "/usr/bin" };
    expect(withAskLsofPath(env, { fsModule: executable("/usr/bin/lsof", kShimPath), ...linux })).toEqual(env);
    expect(withAskLsofPath({ ...env, ALPHACLAW_LSOF_SHIM: "0" }, { fsModule: executable(kShimPath), ...linux })).toEqual({
      ...env,
      ALPHACLAW_LSOF_SHIM: "0",
    });
    expect(withAskLsofPath(env, { fsModule: executable(kShimPath), platform: "darwin" })).toEqual(env);
  });

  it("a real executable named lsof in a PATH directory wins over the shim (real fs)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-lsof-"));
    try {
      const fake = path.join(dir, "lsof");
      fs.writeFileSync(fake, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const realFs = {
        constants: fs.constants,
        // /usr/bin/lsof and /usr/sbin/lsof are hidden so the box's own lsof
        // (if any) does not decide the test.
        accessSync: (file, mode) => {
          if (file === "/usr/bin/lsof" || file === "/usr/sbin/lsof") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return fs.accessSync(file, mode);
        },
      };
      const env = { PATH: dir };
      expect(resolveAskLsofPath({ env, fsModule: realFs, ...linux })).toEqual({ path: fake, kind: "real" });
      expect(withAskLsofPath(env, { fsModule: realFs, ...linux })).toEqual(env);
      fs.chmodSync(fake, 0o644);
      const resolved = resolveAskLsofPath({ env, fsModule: realFs, ...linux });
      expect(resolved.kind).toBe(process.platform === "linux" ? "shim" : "none");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
