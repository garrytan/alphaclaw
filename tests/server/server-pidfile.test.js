// The single-instance server pidfile (lib/server/server-pidfile.js): who holds
// <managedDir>/alphaclaw-server.pid, judged by identity (host, kernel start
// ticks, container pid-1 ticks) and never by a bare pid. Ported from the
// retired release-channel store, which used to own the claim. Hermetic: real
// temp dirs, real child processes for the /proc-backed cases, a planted /proc
// for the rest.
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createServerPidfile, formatServerPidDecision } = require("../../lib/server/server-pidfile");

const kSilentLogger = { log() {}, warn() {}, error() {} };

const createStore = (overrides = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-server-pidfile-test-"));
  const managedDir = path.join(rootDir, ".openclaw", ".alphaclaw");
  const store = createServerPidfile({ managedDir, logger: kSilentLogger, ...overrides });
  return { store, rootDir, managedDir };
};

describe("server/server-pidfile", () => {
  it("keeps the claim at <managedDir>/alphaclaw-server.pid", () => {
    const { store, managedDir } = createStore();
    expect(store.serverPidPath).toBe(path.join(managedDir, "alphaclaw-server.pid"));
  });

  describe("server pid guard", () => {
    const os = require("os");
    const { spawn } = require("child_process");
    // A live child standing in for a foreign alphaclaw server. `argvTag`
    // lands in /proc/<pid>/cmdline so the legacy (identity-less) claim path
    // can tell an alphaclaw entry from an unrelated process.
    const spawnHolder = (argvTag = null) =>
      spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)", ...(argvTag ? [argvTag] : [])],
        { stdio: "ignore" },
      );
    const waitForProc = async (pid) => {
      // /proc/<pid>/stat is readable as soon as spawn returns; the loop only
      // guards a racing kernel on slow CI hosts.
      for (let i = 0; i < 50; i += 1) {
        try {
          fs.readFileSync(`/proc/${pid}/stat`, "utf8");
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    };
    const fullClaim = (store, pid) => ({
      pid,
      at: 1,
      host: os.hostname(),
      startTicks: store.readProcessStartTicks(pid),
    });

    it("never clobbers a live foreign owner (identity matches) and clears only its own claim", () => {
      const { store } = createStore();
      const child = spawnHolder();
      try {
        fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
        fs.writeFileSync(
          store.serverPidPath,
          JSON.stringify(fullClaim(store, child.pid)),
        );
        // A live foreign owner is sacred — a second start must not replace it
        // (it would clear the claim on exit, leaving the live server unguarded).
        store.writeServerPid();
        expect(JSON.parse(fs.readFileSync(store.serverPidPath, "utf8")).pid).toBe(
          child.pid,
        );
        // clearServerPid only removes its OWN claim.
        store.clearServerPid();
        expect(fs.existsSync(store.serverPidPath)).toBe(true);
      } finally {
        child.kill("SIGKILL");
      }
    });
  });

  describe("server pid guard — identity, not just a pid", () => {
    const os = require("os");
    const { spawn } = require("child_process");
    // A lookalike SERVER carries the bin entry AND the `start` verb (the argv
    // test is verb-scoped since #76 — `alphaclaw diagnose` is not a server).
    const spawnHolder = (...argvTags) =>
      spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)", ...argvTags],
        { stdio: "ignore" },
      );
    const writeClaim = (store, claim) => {
      fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
      fs.writeFileSync(store.serverPidPath, JSON.stringify(claim));
    };

    it("a claim written by another container/host is stale even when the pid is alive here (fresh container on the same volume)", () => {
      const { store } = createStore();
      const child = spawnHolder();
      try {
        // The old container's server had this pid; in OUR pid namespace the
        // same number is a different, live process.
        writeClaim(store, {
          pid: child.pid,
          at: 1,
          host: "b7f0c0ffee11",
          startTicks: store.readProcessStartTicks(child.pid),
        });
        expect(store.readLiveServerPid()).toBeNull();
        // ...so the boot may claim the file for itself.
        store.writeServerPid();
        const written = JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"));
        expect(written.pid).toBe(process.pid);
        expect(written.host).toBe(os.hostname());
      } finally {
        child.kill("SIGKILL");
      }
    });

    it("a reused pid (same host, different process start time) is stale", () => {
      const { store } = createStore();
      const liveTicks = store.readProcessStartTicks(process.pid);
      if (liveTicks == null) return; // no /proc on this platform — legacy path covered below
      const child = spawnHolder();
      try {
        const childTicks = store.readProcessStartTicks(child.pid);
        expect(childTicks).not.toBeNull();
        writeClaim(store, {
          pid: child.pid,
          at: 1,
          host: os.hostname(),
          startTicks: childTicks - 1, // the process that wrote this started earlier and is gone
        });
        expect(store.readLiveServerPid()).toBeNull();
        // Matching identity: live.
        writeClaim(store, { pid: child.pid, at: 1, host: os.hostname(), startTicks: childTicks });
        expect(store.readLiveServerPid()).toBe(child.pid);
      } finally {
        child.kill("SIGKILL");
      }
    });

    it("a legacy identity-less claim is trusted only if the live process looks like an alphaclaw server", () => {
      const { store } = createStore();
      if (store.readProcessStartTicks(process.pid) == null) return; // needs /proc
      const stranger = spawnHolder();
      const server = spawnHolder("/opt/alphaclaw/bin/alphaclaw.js", "start");
      // The bin entry WITHOUT the server verb: an operator's `alphaclaw
      // diagnose`, the /usr/local/bin shim for any other verb — live, argv
      // names alphaclaw, and still not a server (Eng 3A / CEO 6.3).
      const otherVerb = spawnHolder("/opt/alphaclaw/bin/alphaclaw.js");
      try {
        writeClaim(store, { pid: stranger.pid, at: Date.now() });
        expect(store.readLiveServerPid()).toBeNull();
        writeClaim(store, { pid: otherVerb.pid, at: Date.now() });
        expect(store.readLiveServerPidEvidence()).toBeNull();
        expect(store.describeServerPidDecision().reason).toBe("not_alphaclaw");
        writeClaim(store, { pid: server.pid, at: Date.now() });
        expect(store.readLiveServerPid()).toBe(server.pid);
      } finally {
        stranger.kill("SIGKILL");
        server.kill("SIGKILL");
        otherVerb.kill("SIGKILL");
      }
    });

    it("a dead pid and a self pid are never live", () => {
      const { store } = createStore();
      const child = spawnHolder();
      child.kill("SIGKILL");
      writeClaim(store, { pid: process.pid, at: 1, host: os.hostname() });
      expect(store.readLiveServerPid()).toBeNull();
      writeClaim(store, { pid: 999999, at: 1, host: os.hostname() });
      expect(store.readLiveServerPid()).toBeNull();
    });
  });
  // F004 follow-up: the single-instance refusal must be backed by evidence.
  // A hard-killed predecessor (`docker rm -f`) leaves its pidfile on the
  // volume and a fresh container's early processes reuse low pid numbers, so
  // kill(pid, 0) alone says "alive". The record now carries the owner's
  // kernel start time; a mismatch means the pid was recycled.
  describe("server pid guard evidence (recycled pid after a hard kill)", () => {
    const { spawn } = require("child_process");
    const { readProcStartTicks } = require("../../lib/server/utils/safe-file");
    const spawnSleeper = () =>
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const writePidRecord = (store, record) => {
      fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
      fs.writeFileSync(store.serverPidPath, JSON.stringify(record));
    };
    const hasProc = process.platform === "linux" && fs.existsSync(`/proc/${process.pid}/stat`);

    it("records the owner's kernel start time alongside the pid", () => {
      const { store } = createStore();
      fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
      store.writeServerPid();
      const record = JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"));
      expect(record.pid).toBe(process.pid);
      // Format 2 (#76): the claim also names the container it was written in.
      expect(record.format).toBe(2);
      expect(record.legacyClaim).toBeUndefined();
      if (hasProc) {
        expect(record.startTicks).toBe(readProcStartTicks(process.pid, fs));
        expect(record.containerStartTicks).toBe(readProcStartTicks(1, fs));
      } else {
        expect(record.startTicks).toBeNull();
        expect(record.containerStartTicks).toBeNull();
      }
    });

    it.skipIf(!hasProc)("corroborates a live owner whose start time matches the record", () => {
      const child = spawnSleeper();
      try {
        const { store } = createStore();
        writePidRecord(store, { pid: child.pid, at: 1, startTicks: readProcStartTicks(child.pid, fs) });
        expect(store.readLiveServerPidEvidence()).toEqual({ pid: child.pid, corroborated: true });
        expect(store.readLiveServerPid()).toBe(child.pid);
      } finally {
        child.kill("SIGKILL");
      }
    });

    it.skipIf(!hasProc)("treats a live pid with a DIFFERENT start time as recycled — no owner, claim replaceable", () => {
      const child = spawnSleeper();
      try {
        const { store } = createStore();
        writePidRecord(store, {
          pid: child.pid,
          at: 1,
          startTicks: readProcStartTicks(child.pid, fs) - 12345,
        });
        expect(store.readLiveServerPidEvidence()).toBeNull();
        expect(store.readLiveServerPid()).toBeNull();
        store.writeServerPid();
        expect(JSON.parse(fs.readFileSync(store.serverPidPath, "utf8")).pid).toBe(process.pid);
      } finally {
        child.kill("SIGKILL");
      }
    });

    it("a legacy record (no startTicks) naming a live alphaclaw-looking process is live but UNcorroborated; a stranger is stale", () => {
      // Reconciled with #64: identity-less claims are trusted only when the
      // live process's argv names the alphaclaw entry, and even then the
      // launcher gets corroborated:false (skip the sync, keep booting).
      const { spawn } = require("child_process");
      const lookalike = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)", "/opt/alphaclaw/bin/alphaclaw.js", "start"],
        { stdio: "ignore" },
      );
      const stranger = spawnSleeper();
      try {
        const { store } = createStore();
        // A real wall-clock `at`: a legacy claim older than this container is
        // provably from a previous one (#76) — a fresh claim is not.
        writePidRecord(store, { pid: lookalike.pid, at: Date.now() });
        expect(store.readLiveServerPidEvidence()).toEqual({ pid: lookalike.pid, corroborated: false });
        expect(store.readLiveServerPid()).toBe(lookalike.pid);
        if (hasProc) {
          writePidRecord(store, { pid: stranger.pid, at: Date.now() });
          expect(store.readLiveServerPidEvidence()).toBeNull();
        }
      } finally {
        lookalike.kill("SIGKILL");
        stranger.kill("SIGKILL");
      }
    });

    it("returns null for this process, a dead pid, or garbage", () => {
      const { store } = createStore();
      writePidRecord(store, { pid: process.pid, at: 1 });
      expect(store.readLiveServerPidEvidence()).toBeNull();
      writePidRecord(store, { pid: 2 ** 22 - 1, at: 1 }); // above default pid_max → ESRCH
      expect(store.readLiveServerPidEvidence()).toBeNull();
      fs.writeFileSync(store.serverPidPath, "not json");
      expect(store.readLiveServerPidEvidence()).toBeNull();
    });
  });

  // Issue #76 RC1/RC2. A pid number can name a THREAD: for a thread `tid` of
  // process `pid`, kill(tid, 0) succeeds and /proc/<tid>/cmdline is the
  // leader's argv, so a stale legacy {pid, at} claim colliding with one of
  // our own V8/libuv threads passed as "another alphaclaw server is live"
  // and the boot sync (the step that activates the applied overlay) was
  // skipped for 45 minutes. And a legacy claim that survives every check
  // used to stay a legacy claim forever — nothing ever disproved it.
  describe("server pid guard — thread ids, container identity and legacy convergence (#76)", () => {
    const os = require("os");
    const { spawn } = require("child_process");
    const {
      readProcStartTicks,
      readContainerStartTicks,
    } = require("../../lib/server/openclaw-lock-contention");
    const hasProc = process.platform === "linux" && fs.existsSync(`/proc/${process.pid}/status`);
    const kServerArgv = ["/opt/alphaclaw/bin/alphaclaw.js", "start", "--root-dir", "/data"];
    const spawnLookalike = (argv = kServerArgv) =>
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", ...argv], { stdio: "ignore" });
    // Node starts its platform threads immediately; poll only for a racing
    // kernel on slow CI hosts, then ASSERT the fixture really is multi-threaded
    // (CEO 6.1) so a single-threaded child can never make the test vacuous.
    const readSiblingTid = async (pid) => {
      let tids = [];
      for (let i = 0; i < 100; i += 1) {
        try {
          tids = fs.readdirSync(`/proc/${pid}/task`).map(Number);
          if (tids.length > 1) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(tids.length).toBeGreaterThan(1);
      const tid = tids.find((candidate) => candidate !== pid);
      expect(tid).toEqual(expect.any(Number));
      return tid;
    };
    const writePidRecord = (store, record) => {
      fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
      fs.writeFileSync(store.serverPidPath, JSON.stringify(record));
    };
    // /proc/<pid>/stat as the kernel prints it (starttime is field 22).
    const statLine = (pid, ticks) =>
      `${pid} (node) S 1 ${pid} ${pid} 0 -1 4194304 623 1997 0 0 0 0 0 0 20 0 7 0 ${ticks} 4558848 825 18446744073709551615 0 0\n`;
    const statusText = (pid, tgid) => `Name:\tnode\nUmask:\t0022\nState:\tS (sleeping)\nTgid:\t${tgid}\nNgid:\t0\nPid:\t${pid}\nPPid:\t1\n`;
    // A planted /proc over the REAL fs (the store keeps writing its files to
    // the temp root): `procs[pid] = { tgid, ticks, cmdline }` describes each
    // live task; `pid1Ticks` is the container's identity. Inline on purpose
    // — gateway.test.js's installFakeProc is describe-local.
    const fakeProcFs = ({ procs = {}, pid1Ticks = 3431, uptimeSeconds = 900 } = {}) => {
      const table = () => procs;
      const readProc = (target) => {
        const text = String(target);
        if (text === "/proc/uptime") return `${uptimeSeconds}.00 ${uptimeSeconds * 4}.00\n`;
        if (text === "/proc/1/stat") return statLine(1, pid1Ticks);
        const match = /^\/proc\/(\d+)\/(stat|status|cmdline)$/.exec(text);
        if (!match) return undefined;
        const entry = table()[match[1]];
        if (!entry) throw Object.assign(new Error(`ENOENT: ${text}`), { code: "ENOENT" });
        if (match[2] === "stat") return statLine(Number(match[1]), entry.ticks);
        if (match[2] === "status") return statusText(Number(match[1]), entry.tgid ?? Number(match[1]));
        return entry.cmdline == null ? "" : entry.cmdline.split(" ").join("\0") + "\0";
      };
      return new Proxy(fs, {
        get(target, prop) {
          if (prop === "readFileSync") {
            return (file, ...rest) => {
              if (/^\/proc\//.test(String(file))) {
                const planted = readProc(file);
                if (planted !== undefined) return planted;
              }
              return target.readFileSync(file, ...rest);
            };
          }
          return Reflect.get(target, prop);
        },
      });
    };
    // Liveness oracle over the same table: ESRCH for an unknown pid.
    const fakeKill = (procs) => (pid) => {
      if (!procs[pid]) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    const kNow = Date.now();
    const createFakeStore = ({ procs, pid1Ticks, containerStartMs = kNow - 10 * 60 * 1000, ...rest } = {}) =>
      createStore({
        fsModule: fakeProcFs({ procs, pid1Ticks }),
        killFn: fakeKill(procs),
        readContainerStartMs: () => containerStartMs,
        ...rest,
      });
    const kLookalikeCmdline = "node /app/bin/alphaclaw.js start --root-dir /data";

    it.skipIf(!hasProc)("a legacy claim naming a THREAD of a live lookalike server is not a server: null (reason thread), never a skip", async () => {
      const child = spawnLookalike();
      try {
        const tid = await readSiblingTid(child.pid);
        // The two checks the pre-#76 guard relied on both pass for the tid.
        expect(() => process.kill(tid, 0)).not.toThrow();
        expect(fs.readFileSync(`/proc/${tid}/cmdline`, "utf8")).toMatch(/alphaclaw\.js\0start/);
        const { store } = createStore();
        writePidRecord(store, { pid: tid, at: Date.now() });
        const decision = store.describeServerPidDecision();
        expect(decision.evidence).toBeNull();
        expect(decision.decision).toBe("proceed");
        expect(decision.reason).toBe("thread");
        expect(decision.tgid).toBe(child.pid);
        expect(decision.killOk).toBe(true);
        expect(decision.record).toEqual({ raw: { pid: tid, at: expect.any(Number) }, format: "legacy", legacyClaim: true });
        expect(store.readLiveServerPidEvidence()).toBeNull();
        // The judge is pure: nothing was written or converged.
        expect(JSON.parse(fs.readFileSync(store.serverPidPath, "utf8")).pid).toBe(tid);
        expect(store.convergeLegacyServerPidClaim(decision)).toEqual({ converged: false, reason: "not_legacy_skip" });
        // The LEADER itself is still a live lookalike server — uncorroborated.
        writePidRecord(store, { pid: child.pid, at: Date.now() });
        expect(store.describeServerPidDecision()).toEqual(
          expect.objectContaining({ reason: "legacy_argv_match", tgid: child.pid, evidence: { pid: child.pid, corroborated: false } }),
        );
      } finally {
        child.kill("SIGKILL");
      }
    });

    it.skipIf(!hasProc)("a legacy claim naming one of OUR OWN threads is own_thread → proceed, even when its argv looks like a server", async () => {
      const tid = await readSiblingTid(process.pid);
      // Our real argv is vitest's; plant a server-shaped cmdline for the tid
      // so the test proves the Tgid check fires BEFORE the argv check.
      const realFs = fs;
      const fsModule = new Proxy(realFs, {
        get(target, prop) {
          if (prop === "readFileSync") {
            return (file, ...rest) =>
              String(file) === `/proc/${tid}/cmdline`
                ? "node\0/app/bin/alphaclaw.js\0start\0"
                : target.readFileSync(file, ...rest);
          }
          return Reflect.get(target, prop);
        },
      });
      const { store } = createStore({ fsModule });
      writePidRecord(store, { pid: tid, at: Date.now() });
      const decision = store.describeServerPidDecision();
      expect(decision).toEqual(
        expect.objectContaining({ evidence: null, decision: "proceed", reason: "own_thread", tgid: process.pid, selfPid: process.pid, pid: tid }),
      );
      expect(store.readLiveServerPidEvidence()).toBeNull();
      // ...so the boot may claim the file for itself, as format 2.
      store.writeServerPid();
      const written = JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"));
      expect(written).toEqual(expect.objectContaining({ pid: process.pid, format: 2, containerStartTicks: readContainerStartTicks() }));
    });

    it("a legacy claim older than this container (by > 5 min) predates it → null; a fresh one is still an uncorroborated live owner", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: kLookalikeCmdline } };
      const { store } = createFakeStore({ procs, containerStartMs: kNow - 10 * 60 * 1000 });
      writePidRecord(store, { pid: 21, at: kNow - 60 * 60 * 1000 });
      const stale = store.describeServerPidDecision();
      expect(stale).toEqual(
        expect.objectContaining({
          evidence: null,
          reason: "predates_container",
          pid: 21,
          killOk: true,
          tgid: 21,
          liveTicks: 5000,
          containerStartMs: kNow - 10 * 60 * 1000,
          claimAt: kNow - 60 * 60 * 1000,
        }),
      );
      // Inside the margin: not provably older than the container.
      writePidRecord(store, { pid: 21, at: kNow - 12 * 60 * 1000 });
      expect(store.readLiveServerPidEvidence()).toEqual({ pid: 21, corroborated: false });
      // A logical-clock stamp (test harnesses) is never compared with the container.
      writePidRecord(store, { pid: 21, at: 1 });
      expect(store.describeServerPidDecision().reason).toBe("legacy_argv_match");
      // No container estimate → the check is skipped, not failed.
      const { store: blind } = createFakeStore({ procs, readContainerStartMs: () => null });
      writePidRecord(blind, { pid: 21, at: kNow - 60 * 60 * 1000 });
      expect(blind.readLiveServerPidEvidence()).toEqual({ pid: 21, corroborated: false });
    });

    it("convergeLegacyServerPidClaim rewrites a positively identified legacy claim as format 2 with observedTicks — never startTicks — and it stays uncorroborated", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: kLookalikeCmdline } };
      const nowRef = { now: kNow };
      const { store } = createFakeStore({ procs, pid1Ticks: 3431, nowFn: () => nowRef.now, hostnameFn: () => "render-web-1" });
      writePidRecord(store, { pid: 21, at: kNow - 60 * 1000 });
      const decision = store.describeServerPidDecision();
      expect(decision.evidence).toEqual({ pid: 21, corroborated: false });
      expect(decision.reason).toBe("legacy_argv_match");
      const result = store.convergeLegacyServerPidClaim(decision);
      expect(result.converged).toBe(true);
      const record = JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"));
      expect(record).toEqual({
        pid: 21,
        at: kNow - 60 * 1000, // the original claim time is preserved
        upgradedAt: kNow,
        host: "render-web-1",
        observedTicks: 5000,
        containerStartTicks: 3431,
        format: 2,
        legacyClaim: true,
      });
      expect(record.startTicks).toBeUndefined();
      // Same live process next boot: still a legacy claim, permanently
      // corroborated: false (the launcher can never refuse on it).
      const again = store.describeServerPidDecision();
      expect(again.evidence).toEqual({ pid: 21, corroborated: false });
      expect(again.record).toEqual(expect.objectContaining({ format: 2, legacyClaim: true }));
      expect(again.recordedTicks).toBe(5000);
      expect(again.recordedContainerTicks).toBe(3431);
      expect(store.readLiveServerPidEvidence()).toEqual({ pid: 21, corroborated: false });
      // The pid was recycled since (different start ticks): disproved → proceed.
      procs[21].ticks = 9001;
      const recycled = store.describeServerPidDecision();
      expect(recycled).toEqual(expect.objectContaining({ evidence: null, reason: "recycled", recordedTicks: 5000, liveTicks: 9001 }));
      expect(store.readLiveServerPidEvidence()).toBeNull();
    });

    it("a converged claim from a PREVIOUS container (pid 1 differs) is other_container → proceed, whatever pid 21 is doing now", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: kLookalikeCmdline } };
      const { store } = createFakeStore({ procs, pid1Ticks: 9999 });
      writePidRecord(store, {
        pid: 21,
        at: kNow - 60 * 1000,
        upgradedAt: kNow - 30 * 1000,
        host: os.hostname(), // a Render instance name survives the redeploy
        observedTicks: 5000, // and the ticks happen to match
        containerStartTicks: 3431,
        format: 2,
        legacyClaim: true,
      });
      const decision = store.describeServerPidDecision();
      expect(decision).toEqual(
        expect.objectContaining({ evidence: null, reason: "other_container", recordedContainerTicks: 3431, liveContainerTicks: 9999 }),
      );
      expect(store.readLiveServerPidEvidence()).toBeNull();
    });

    it("the pidfile changes at most once: repeated reads write nothing and a converged record is never re-converged (identity stays)", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: kLookalikeCmdline } };
      const { store } = createFakeStore({ procs });
      writePidRecord(store, { pid: 21, at: kNow - 60 * 1000 });
      const before = fs.statSync(store.serverPidPath).mtimeMs;
      // The grace loop re-reads the decision many times before converging.
      let decision = null;
      for (let i = 0; i < 6; i += 1) decision = store.describeServerPidDecision();
      expect(store.readLiveServerPidEvidence()).toEqual({ pid: 21, corroborated: false });
      expect(fs.statSync(store.serverPidPath).mtimeMs).toBe(before);
      expect(store.convergeLegacyServerPidClaim(decision).converged).toBe(true);
      const converged = fs.readFileSync(store.serverPidPath, "utf8");
      const afterFirst = fs.statSync(store.serverPidPath).mtimeMs;
      // Next boot on the same live process: skip again, no second write.
      const next = store.describeServerPidDecision();
      expect(next.evidence).toEqual({ pid: 21, corroborated: false });
      expect(store.convergeLegacyServerPidClaim(next)).toEqual({ converged: false, reason: "already_converged" });
      expect(fs.readFileSync(store.serverPidPath, "utf8")).toBe(converged);
      expect(fs.statSync(store.serverPidPath).mtimeMs).toBe(afterFirst);
      // writeServerPid never clobbers the live (uncorroborated) owner either.
      store.writeServerPid();
      expect(fs.readFileSync(store.serverPidPath, "utf8")).toBe(converged);
    });

    it("weak evidence never converges: an unreadable or empty cmdline skips (legacy_no_argv) but leaves the file untouched", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: null } };
      const { store } = createFakeStore({ procs });
      const raw = JSON.stringify({ pid: 21, at: kNow - 60 * 1000 });
      writePidRecord(store, JSON.parse(raw));
      const decision = store.describeServerPidDecision();
      expect(decision).toEqual(expect.objectContaining({ evidence: { pid: 21, corroborated: false }, reason: "legacy_no_argv", cmdline: "", argvMatched: null }));
      expect(store.convergeLegacyServerPidClaim(decision)).toEqual({ converged: false, reason: "weak_argv" });
      expect(fs.readFileSync(store.serverPidPath, "utf8")).toBe(raw);
      // No /proc at all (macOS): liveness alone is trusted, still no convergence.
      const noProc = createStore({
        fsModule: new Proxy(fs, {
          get(target, prop) {
            if (prop !== "readFileSync") return Reflect.get(target, prop);
            return (file, ...rest) => {
              if (/^\/proc\//.test(String(file))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
              return target.readFileSync(file, ...rest);
            };
          },
        }),
        killFn: () => {},
        readContainerStartMs: () => null,
      }).store;
      writePidRecord(noProc, JSON.parse(raw));
      const blind = noProc.describeServerPidDecision();
      expect(blind).toEqual(expect.objectContaining({ evidence: { pid: 21, corroborated: false }, reason: "legacy_no_argv", tgid: null, liveTicks: null, liveContainerTicks: null }));
      expect(noProc.convergeLegacyServerPidClaim(blind)).toEqual({ converged: false, reason: "weak_argv" });
    });

    it("the argv test is verb-scoped: a live `alphaclaw diagnose`, the bare shim and the placeholder child are not servers (CEO 6.3)", () => {
      for (const cmdline of [
        "node /app/bin/alphaclaw.js diagnose",
        "/usr/local/bin/alphaclaw diagnose --json",
        "/usr/local/bin/alphaclaw",
        "node /app/bin/alphaclaw.js",
        "node /app/bin/alphaclaw.js start boot-placeholder-child",
        "node /app/node_modules/openclaw/dist/entry.js gateway run",
      ]) {
        const procs = { 21: { tgid: 21, ticks: 5000, cmdline } };
        const { store } = createFakeStore({ procs });
        writePidRecord(store, { pid: 21, at: kNow - 60 * 1000 });
        const decision = store.describeServerPidDecision();
        expect(decision.reason, cmdline).toBe("not_alphaclaw");
        expect(decision.evidence, cmdline).toBeNull();
        expect(store.convergeLegacyServerPidClaim(decision).converged, cmdline).toBe(false);
      }
      for (const cmdline of [
        "node /app/bin/alphaclaw.js start",
        "/usr/local/bin/alphaclaw start --root-dir /data",
        "node /opt/alphaclaw/bin/alphaclaw start",
      ]) {
        const procs = { 21: { tgid: 21, ticks: 5000, cmdline } };
        const { store } = createFakeStore({ procs });
        writePidRecord(store, { pid: 21, at: kNow - 60 * 1000 });
        expect(store.describeServerPidDecision().reason, cmdline).toBe("legacy_argv_match");
      }
    });

    it("planted /proc: a thread of another leader, a dead pid, an EPERM pid and a garbage record each proceed with their own reason", () => {
      const procs = {
        18: { tgid: 18, ticks: 4000, cmdline: kLookalikeCmdline },
        21: { tgid: 18, ticks: 4000, cmdline: kLookalikeCmdline }, // a thread of 18
      };
      const { store } = createFakeStore({ procs });
      writePidRecord(store, { pid: 21, at: kNow });
      expect(store.describeServerPidDecision()).toEqual(expect.objectContaining({ evidence: null, reason: "thread", tgid: 18, pid: 21 }));
      writePidRecord(store, { pid: 77, at: kNow });
      expect(store.describeServerPidDecision()).toEqual(expect.objectContaining({ evidence: null, reason: "dead", killOk: false, pid: 77 }));
      writePidRecord(store, { pid: "twenty-one", at: kNow });
      expect(store.describeServerPidDecision()).toEqual(expect.objectContaining({ evidence: null, reason: "garbage", pid: null }));
      fs.writeFileSync(store.serverPidPath, "[1, 2]");
      expect(store.describeServerPidDecision().reason).toBe("garbage");
      fs.unlinkSync(store.serverPidPath);
      expect(store.describeServerPidDecision()).toEqual(expect.objectContaining({ evidence: null, reason: "absent", pid: null }));
      // EPERM keeps its historical meaning: a pid we may not signal is not a
      // server we could be racing (throw → null).
      const eperm = createStore({
        fsModule: fakeProcFs({ procs }),
        killFn: () => {
          throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        },
      }).store;
      writePidRecord(eperm, { pid: 18, at: kNow });
      expect(eperm.describeServerPidDecision()).toEqual(expect.objectContaining({ evidence: null, reason: "kill_failed", killOk: false }));
      // An identity (format 1/2) record with matching ticks is the corroborated skip.
      writePidRecord(store, { pid: 18, at: kNow, host: os.hostname(), startTicks: 4000 });
      expect(store.describeServerPidDecision()).toEqual(
        expect.objectContaining({ evidence: { pid: 18, corroborated: true }, reason: "corroborated", record: expect.objectContaining({ format: 1, legacyClaim: false }) }),
      );
    });

    it("formatServerPidDecision renders the one-line audit and tolerates a null record", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: kLookalikeCmdline } };
      const { store } = createFakeStore({ procs, pid1Ticks: 3431 });
      writePidRecord(store, { pid: 21, at: kNow - 60 * 1000 });
      const line = formatServerPidDecision(store.describeServerPidDecision());
      expect(line).toBe(
        `format=legacy pid=21 kill=ok tgid=21 self=${process.pid} ticks=–/5000 container=–/3431 → legacy_argv_match (skip)`,
      );
      expect(formatServerPidDecision(null)).toBe("format=– pid=– kill=– tgid=– self=– ticks=–/– container=–/– → – (–)");
      procs[21].tgid = 18;
      expect(formatServerPidDecision(store.describeServerPidDecision())).toMatch(/tgid=18 .*→ thread \(proceed\)$/);
    });

    it("persisted-format fixtures (C5): every alphaclaw-server.pid era is classified by format/legacyClaim and judged on its own evidence", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: kLookalikeCmdline } };
      const host = os.hostname();
      const at = kNow - 60 * 1000;
      const eras = [
        {
          era: "pre-v0.9.73 legacy {pid, at}",
          raw: { pid: 21, at },
          format: "legacy", legacyClaim: true, reason: "legacy_argv_match", evidence: { pid: 21, corroborated: false },
        },
        {
          era: "v0.9.73 identity (format 1: host + startTicks)",
          raw: { pid: 21, at, host, startTicks: 5000 },
          format: 1, legacyClaim: false, reason: "corroborated", evidence: { pid: 21, corroborated: true },
        },
        {
          era: "v0.9.73 identity, recycled pid",
          raw: { pid: 21, at, host, startTicks: 4999 },
          format: 1, legacyClaim: false, reason: "recycled", evidence: null,
        },
        {
          era: "v0.9.77 format 2, server-written (startTicks + containerStartTicks)",
          raw: { pid: 21, at, host, startTicks: 5000, containerStartTicks: 3431, format: 2 },
          format: 2, legacyClaim: false, reason: "corroborated", evidence: { pid: 21, corroborated: true },
        },
        {
          era: "v0.9.77 format 2, converged legacy claim (observedTicks, never startTicks)",
          raw: { pid: 21, at, upgradedAt: kNow - 30 * 1000, host, observedTicks: 5000, containerStartTicks: 3431, format: 2, legacyClaim: true },
          format: 2, legacyClaim: true, reason: "legacy_argv_match", evidence: { pid: 21, corroborated: false },
        },
        {
          era: "v0.9.77 converged claim from a previous container",
          raw: { pid: 21, at, upgradedAt: kNow - 30 * 1000, host, observedTicks: 5000, containerStartTicks: 1111, format: 2, legacyClaim: true },
          format: 2, legacyClaim: true, reason: "other_container", evidence: null,
        },
        {
          era: "v0.9.77 converged claim, recycled pid",
          raw: { pid: 21, at, upgradedAt: kNow - 30 * 1000, host, observedTicks: 4000, containerStartTicks: 3431, format: 2, legacyClaim: true },
          format: 2, legacyClaim: true, reason: "recycled", evidence: null,
        },
      ];
      for (const fixture of eras) {
        const { store } = createFakeStore({ procs, pid1Ticks: 3431 });
        writePidRecord(store, fixture.raw);
        const decision = store.describeServerPidDecision();
        expect(decision.record, fixture.era).toEqual({ raw: fixture.raw, format: fixture.format, legacyClaim: fixture.legacyClaim });
        expect(decision.reason, fixture.era).toBe(fixture.reason);
        expect(decision.evidence, fixture.era).toEqual(fixture.evidence);
      }
      // The record THIS version writes is the v0.9.77 shape, key for key — a
      // change here is a persisted-format change and needs a new era above.
      const { store } = createFakeStore({ procs, pid1Ticks: 3431 });
      store.writeServerPid();
      const written = JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"));
      expect(Object.keys(written).sort()).toEqual(["at", "containerStartTicks", "format", "host", "pid", "startTicks"]);
      expect(written).toEqual(expect.objectContaining({ pid: process.pid, host, format: 2, containerStartTicks: 3431 }));
      expect(written.legacyClaim).toBeUndefined();
    });
  });
});
