const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  evaluateCapturePreflight,
  evaluateStagingChain,
  kFailingRules,
  kFixReasons,
  kSpaceReserveBytes,
} = require("../../lib/server/openclaw-capture-preflight");

const dirId = (uid, mode) => ({ uid, gid: 1000, mode, directory: true, symlink: false, dev: "1", ino: "2" });

describe("openclaw-capture-preflight: the ported staging rule", () => {
  const uid = 1000;
  const chain = (dataMode, dataUid = 0) => ({
    uid,
    root: { path: "/data/state.update-captures", exists: false, identity: null },
    ancestors: [
      { path: "/data", identity: dirId(dataUid, dataMode) },
      { path: "/", identity: dirId(0, 0o755) },
    ],
  });

  it("#144 layout: a group-writable, non-sticky /data (root:node 2775) refuses the snapshot", () => {
    expect(evaluateStagingChain(chain(0o2775))).toEqual({ ok: false, failingPath: "/data", failingRule: kFailingRules.ancestorReplaceable });
  });

  it("the sticky bit on that ancestor makes it trusted (2775 → 3775)", () => {
    expect(evaluateStagingChain(chain(0o3775))).toEqual({ ok: true, failingPath: null, failingRule: null });
  });

  it("an ancestor owned by another non-root user refuses even when not writable", () => {
    expect(evaluateStagingChain(chain(0o755, 4242))).toMatchObject({ ok: false, failingRule: kFailingRules.ancestorForeignOwner });
  });

  it("an existing capture root shared with other users refuses", () => {
    const input = chain(0o755);
    input.root = { path: input.root.path, exists: true, identity: dirId(uid, 0o770) };
    expect(evaluateStagingChain(input)).toMatchObject({ ok: false, failingRule: kFailingRules.captureRootUnsafe });
  });

  it("a sticky ancestor protects only a child the process owns", () => {
    const input = chain(0o3775);
    input.ancestors.unshift({ path: "/data/state", identity: dirId(4242, 0o755) });
    input.root = { path: "/data/state/x.update-captures", exists: false, identity: null };
    expect(evaluateStagingChain(input)).toMatchObject({ ok: false, failingRule: kFailingRules.ancestorForeignOwner });
  });
});

describe("openclaw-capture-preflight: evaluateCapturePreflight on a real tree", () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const run = uid === undefined || process.platform !== "linux" ? it.skip : it;
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  run("names the replaceable ancestor, proposes the sticky bit and never changes anything", () => {
    const shared = path.join(root, "shared");
    const stateDir = path.join(shared, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.chmodSync(shared, 0o777);
    const verdict = evaluateCapturePreflight({ stateDir, statfs: () => ({ bavail: 1e9, bsize: 4096 }) });
    expect(verdict).toMatchObject({
      captureAvailable: false,
      failingPath: shared,
      failingRule: kFailingRules.ancestorReplaceable,
      fixable: { canFix: true, reason: kFixReasons.sticky },
      captureRoot: `${fs.realpathSync(stateDir)}.update-captures`,
    });
    expect(verdict.stickyTargets).toEqual([expect.objectContaining({ path: shared, mode: 0o777, newMode: 0o1777 })]);
    expect(fs.statSync(shared).mode & 0o7777).toBe(0o777);
    expect(fs.existsSync(verdict.captureRoot)).toBe(false);
  });

  run("follows a symlinked state dir to its real parent", () => {
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    fs.chmodSync(real, 0o700);
    const link = path.join(root, "link");
    fs.symlinkSync(real, link);
    const verdict = evaluateCapturePreflight({ stateDir: link, statfs: () => ({ bavail: 1e9, bsize: 4096 }) });
    expect(verdict.symlinked).toBe(true);
    expect(verdict.captureRoot).toBe(`${fs.realpathSync(real)}.update-captures`);
  });

  run("space: 2·bytes + 3·largest + 64 MiB, counting -wal/-shm sidecars per database", () => {
    const stateDir = path.join(root, "state");
    fs.mkdirSync(path.join(stateDir, "state"), { recursive: true });
    fs.chmodSync(root, 0o700);
    const db = path.join(stateDir, "state", "openclaw.sqlite");
    fs.writeFileSync(db, Buffer.alloc(1000));
    fs.writeFileSync(`${db}-wal`, Buffer.alloc(500));
    const agentDb = path.join(stateDir, "agent.sqlite");
    fs.writeFileSync(agentDb, Buffer.alloc(200));
    const needed = 2 * 1700 + 3 * 1500 + kSpaceReserveBytes;
    const roomy = evaluateCapturePreflight({ stateDir, databaseFiles: [db, agentDb], statfs: () => ({ bavail: needed, bsize: 1 }) });
    expect(roomy).toMatchObject({ captureBytes: 1700, neededBytes: needed });
    const tight = evaluateCapturePreflight({ stateDir, databaseFiles: [db, agentDb], statfs: () => ({ bavail: needed - 1, bsize: 1 }) });
    expect(tight).toMatchObject({ captureAvailable: false, failingRule: kFailingRules.space, fixable: { canFix: false, reason: kFixReasons.space } });
  });

  it("is honest where it cannot judge (no uid / another platform)", () => {
    expect(evaluateCapturePreflight({ stateDir: os.tmpdir(), platform: "darwin" })).toMatchObject({
      captureAvailable: null,
      failingRule: kFailingRules.unsupported,
    });
  });
});
