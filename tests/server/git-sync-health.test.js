const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildNextStatus, recordGitSyncRun, readGitSyncStatus, resolveGitSyncStatusPath } = require("../../lib/cli/git-sync-status");
const { kGitSyncCodes } = require("../../lib/cli/git-sync-codes");
const { createGitSyncHealth } = require("../../lib/server/git-sync-health");

// Issue #140: a refused git-sync used to log one line and nothing else.
describe("git-sync status file", () => {
  const at = (minute) => `2026-10-12T10:${String(minute).padStart(2, "0")}:00.000Z`;

  it("opens an episode on the first failure and keeps its start across runs and code changes", () => {
    const first = buildNextStatus({ previous: null, result: { code: "lock_timeout" }, trigger: "scheduled", lock: "timeout", nowIso: at(0) });
    expect(first).toMatchObject({ outcome: "refused", consecutiveFailures: 1, sameCodeRuns: 1, firstFailureAt: at(0), lastSuccessAt: null });
    const second = buildNextStatus({ previous: first, result: { code: "lock_timeout" }, trigger: "scheduled", lock: "timeout", nowIso: at(30) });
    expect(second).toMatchObject({ consecutiveFailures: 2, sameCodeRuns: 2, firstFailureAt: at(0) });
    const third = buildNextStatus({ previous: second, result: { code: "merge_conflict" }, trigger: "scheduled", lock: "acquired", nowIso: at(59) });
    expect(third).toMatchObject({ code: "merge_conflict", consecutiveFailures: 3, sameCodeRuns: 1, firstFailureAt: at(0) });
    const ok = buildNextStatus({ previous: third, result: { code: "ok", pushed: true, pushedSha: "abc", shortHash: "abc" }, trigger: "scheduled", lock: "acquired", nowIso: at(59) });
    expect(ok).toMatchObject({ outcome: "ok", consecutiveFailures: 0, firstFailureAt: null, lastSuccessAt: at(59), lastPushedSha: "abc" });
    expect(ok.attemptId).toBe(4);
  });

  it("tracks a live-tree-behind warning as a success with its own `since`", () => {
    const behind = buildNextStatus({ previous: null, result: { code: "live_tree_behind", liveTreeBehind: { paths: ["a.md"] }, pushed: true }, trigger: "scheduled", lock: "acquired", nowIso: at(0) });
    expect(behind).toMatchObject({ outcome: "warning", consecutiveFailures: 0, lastSuccessAt: at(0), liveTreeBehind: { since: at(0), runs: 1, paths: ["a.md"] } });
    const still = buildNextStatus({ previous: behind, result: { code: "live_tree_behind", liveTreeBehind: { paths: ["a.md"] } }, trigger: "scheduled", lock: "acquired", nowIso: at(30) });
    expect(still.liveTreeBehind).toMatchObject({ since: at(0), runs: 2 });
    const refusedMeanwhile = buildNextStatus({ previous: still, result: { code: "lock_timeout" }, trigger: "scheduled", lock: "timeout", nowIso: at(40) });
    expect(refusedMeanwhile.liveTreeBehind).toMatchObject({ since: at(0), runs: 2 });
    const caughtUp = buildNextStatus({ previous: refusedMeanwhile, result: { code: "ok" }, trigger: "scheduled", lock: "acquired", nowIso: at(50) });
    expect(caughtUp.liveTreeBehind).toBeNull();
  });

  it("every emitted code has an outcome, exit code and copy", () => {
    for (const [code, info] of Object.entries(kGitSyncCodes)) {
      expect(["ok", "warning", "refused", "failed"]).toContain(info.outcome);
      expect([0, 1, 75]).toContain(info.exitCode);
      expect(info.headline, code).toBeTruthy();
      if (code !== "ok") expect(info.action, code).toBeTruthy();
    }
  });
});

describe("git-sync health notifications", () => {
  let openclawDir;
  let now;
  const record = (result) =>
    recordGitSyncRun({
      openclawDir,
      result,
      trigger: "scheduled",
      nowFn: () => now,
      acquireLock: () => ({ release: () => {} }),
    });
  const createHealth = () => {
    const notify = vi.fn(async () => ({ ok: true }));
    const recordEvent = vi.fn();
    const health = createGitSyncHealth({ openclawDir, notify, recordEvent, nowFn: () => now });
    return { health, notify, recordEvent };
  };

  beforeEach(() => {
    openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gitsync-health-"));
    now = Date.parse("2026-10-12T10:00:00.000Z");
  });
  afterEach(() => {
    fs.rmSync(openclawDir, { recursive: true, force: true });
  });

  it("notifies once per blocking episode, survives a restart without re-sending, and sends one recovery line", async () => {
    record({
      code: "in_progress_operation",
      detail: "/data/.openclaw has an in-progress git operation",
      staleState: { marker: "rebase-merge", ageSeconds: 7200, owners: [] },
    });
    const { health, notify, recordEvent } = createHealth();
    expect(await health.check()).toEqual({ action: "notified_blocked" });
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notify.mock.calls[0];
    expect(message).toContain("Git sync blocked by an unfinished rebase or merge");
    expect(message).toContain(".git/rebase-merge, 120 min old; no git process running");
    expect(message).toContain("not being backed up");
    expect(opts).toEqual({ eventType: "health", id: "git-sync-blocked-2026-10-12T10:00:00.000Z" });
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "git_sync_refused", source: "git-sync" }));

    now += 30 * 60_000;
    record({ code: "in_progress_operation", staleState: { marker: "rebase-merge", owners: [] } });
    const restarted = createHealth();
    expect(await restarted.health.check()).toEqual({ action: "none" });
    expect(restarted.notify).not.toHaveBeenCalled();

    now += 60 * 60_000;
    record({ code: "ok", pushed: true, shortHash: "abc1234" });
    expect(await restarted.health.check()).toEqual({ action: "notified_recovered" });
    expect(restarted.notify.mock.calls[0][0]).toBe("✅ Git sync recovered after 90 min; pushed abc1234.");
    expect(await restarted.health.check()).toEqual({ action: "none" });
  });

  it("waits for repeated transient failures and for a second refusal while the rebase owner is alive", async () => {
    const { health, notify } = createHealth();
    record({ code: "lock_timeout" });
    record({ code: "lock_timeout" });
    expect(await health.check()).toEqual({ action: "none" });
    record({ code: "lock_timeout" });
    expect(await health.check()).toEqual({ action: "notified_blocked" });

    record({ code: "ok" });
    await health.check();
    notify.mockClear();
    now += 60_000;
    record({ code: "in_progress_operation", staleState: { marker: "rebase-merge", owners: [{ pid: 9, cmd: "git rebase" }] } });
    expect(await health.check()).toEqual({ action: "none" });
    record({ code: "in_progress_operation", staleState: { marker: "rebase-merge", owners: [{ pid: 9, cmd: "git rebase" }] } });
    expect(await health.check()).toEqual({ action: "notified_blocked" });
    expect(notify.mock.calls[0][0]).toContain("pid 9 (git rebase) still running");
  });

  it("raises a live-tree-behind warning once after three runs", async () => {
    const { health, notify } = createHealth();
    for (let run = 0; run < 2; run += 1) {
      record({ code: "live_tree_behind", liveTreeBehind: { paths: ["workspace/notes.md"] } });
      expect(await health.check()).toEqual({ action: "none" });
    }
    record({ code: "live_tree_behind", liveTreeBehind: { paths: ["workspace/notes.md"] } });
    expect(await health.check()).toEqual({ action: "notified_behind" });
    expect(notify.mock.calls[0][0]).toContain("Local edits block the update: workspace/notes.md");
    record({ code: "live_tree_behind", liveTreeBehind: { paths: ["workspace/notes.md"] } });
    expect(await health.check()).toEqual({ action: "none" });
  });

  it("writes the status file 0600 in the managed dir and tolerates a missing one", async () => {
    const { health } = createHealth();
    expect(await health.check()).toEqual({ action: "none" });
    record({ code: "ok" });
    const statusPath = resolveGitSyncStatusPath(openclawDir);
    expect(statusPath).toBe(path.join(openclawDir, ".alphaclaw", "git-sync-status.json"));
    expect(fs.statSync(statusPath).mode & 0o777).toBe(0o600);
    expect(readGitSyncStatus({ statusPath })).toMatchObject({ code: "ok", version: 1 });
  });
});
