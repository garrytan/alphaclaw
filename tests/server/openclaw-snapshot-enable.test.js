const fs = require("fs");
const os = require("os");
const path = require("path");
const { applySnapshotEnable, buildSnapshotEnableProposal, kCaptureRetentionDays } = require("../../lib/server/openclaw-snapshot-enable");
const { evaluateCapturePreflight } = require("../../lib/server/openclaw-capture-preflight");

const run = typeof process.getuid === "function" && process.platform === "linux" ? describe : describe.skip;
const statfs = () => ({ bavail: 1e12, bsize: 1 });
const evaluate = (options) => evaluateCapturePreflight({ ...options, statfs });
const quiet = { log: () => {}, warn: () => {} };
const modeOf = (dir) => fs.statSync(dir).mode & 0o7777;

run("openclaw-snapshot-enable", () => {
  let root;
  let outer;
  let inner;
  let stateDir;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-"));
    fs.chmodSync(root, 0o700);
    outer = path.join(root, "outer");
    inner = path.join(outer, "inner");
    stateDir = path.join(inner, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.chmodSync(outer, 0o777);
    fs.chmodSync(inner, 0o2775);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("proposes exactly the refused directories with old/new modes, capture size and retention", () => {
    const proposal = buildSnapshotEnableProposal(evaluate({ stateDir }));
    expect(proposal).toMatchObject({ ok: true, retentionDays: kCaptureRetentionDays, captureRoot: `${fs.realpathSync(stateDir)}.update-captures` });
    expect(proposal.dirs.map((dir) => [dir.path, dir.oldMode, dir.newMode])).toEqual([
      [inner, "02775", "03775"],
      [outer, "0777", "01777"],
    ]);
    expect(proposal.proposalId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("applies chmod +t to only those directories and the ported check then passes", () => {
    const { proposalId } = buildSnapshotEnableProposal(evaluate({ stateDir }));
    const result = applySnapshotEnable({ proposalId, stateDir, evaluate, logger: quiet });
    expect(result).toMatchObject({ ok: true, captureAvailable: true });
    expect(modeOf(inner)).toBe(0o3775);
    expect(modeOf(outer)).toBe(0o1777);
    expect(modeOf(stateDir) & 0o1000).toBe(0);
  });

  it("refuses a stale proposal (a directory changed after the confirm opened) and changes nothing", () => {
    const { proposalId } = buildSnapshotEnableProposal(evaluate({ stateDir }));
    fs.chmodSync(inner, 0o775);
    const result = applySnapshotEnable({ proposalId, stateDir, evaluate, logger: quiet });
    expect(result).toMatchObject({ ok: false, code: "proposal_stale", changed: [] });
    expect(modeOf(outer)).toBe(0o777);
  });

  it("dry-run refusal: nothing to fix when snapshots already work", () => {
    fs.chmodSync(outer, 0o755);
    fs.chmodSync(inner, 0o755);
    expect(buildSnapshotEnableProposal(evaluate({ stateDir }))).toMatchObject({ ok: false, code: "already_available" });
  });

  it("refuses when the volume can't hold two snapshots plus a run", () => {
    const db = path.join(stateDir, "openclaw.sqlite");
    fs.writeFileSync(db, Buffer.alloc(4096));
    const preflight = evaluateCapturePreflight({ stateDir, databaseFiles: [db], statfs: () => ({ bavail: 64 * 1024 * 1024 + 25_000, bsize: 1 }) });
    // One run fits (2·4096 + 3·4096 + 64 MiB), two retained snapshots don't.
    expect(preflight.neededBytes).toBeLessThan(preflight.freeBytes);
    expect(preflight.enableRequiredBytes).toBeGreaterThan(preflight.freeBytes);
    expect(preflight.fixable).toMatchObject({ canFix: false, reason: "space" });
    expect(buildSnapshotEnableProposal(preflight)).toMatchObject({ ok: false, code: "not_fixable" });
  });

  it("EPERM on the second directory rolls the first back through its handle and reports path + errno", () => {
    const { proposalId } = buildSnapshotEnableProposal(evaluate({ stateDir }));
    let calls = 0;
    const fsModule = {
      ...fs,
      fchmodSync: (fd, mode) => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        return fs.fchmodSync(fd, mode);
      },
    };
    const result = applySnapshotEnable({ proposalId, stateDir, evaluate, fsModule, logger: quiet });
    expect(result).toMatchObject({ ok: false, code: "chmod_failed", path: outer, errno: "EPERM", changed: [] });
    expect(result.rolledBack).toEqual([{ path: inner, mode: "02775" }]);
    expect(modeOf(inner)).toBe(0o2775);
    expect(modeOf(outer)).toBe(0o777);
  });

  it("a symlink substituted for a proposed directory is refused (O_NOFOLLOW)", () => {
    const { proposalId } = buildSnapshotEnableProposal(evaluate({ stateDir }));
    const moved = path.join(root, "moved");
    fs.renameSync(inner, moved);
    fs.symlinkSync(moved, inner);
    const result = applySnapshotEnable({ proposalId, stateDir, evaluate: () => evaluate({ stateDir: path.join(moved, "state") }), logger: quiet });
    expect(result.ok).toBe(false);
    expect(modeOf(moved)).toBe(0o2775);
  });
});
