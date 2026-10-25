const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildNextStatus, recordGitSyncRun, readGitSyncStatus, resolveGitSyncStatusPath } = require("../../lib/cli/git-sync-status");

const { kGitSyncCodes, describeGitSyncFailure } = require("../../lib/cli/git-sync-codes");
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

  it("ends every episode on a disabled run and keeps the last success", () => {
    const ok = buildNextStatus({ previous: null, result: { code: "ok", pushed: true, pushedSha: "abc" }, trigger: "scheduled", lock: "acquired", nowIso: at(0) });
    const held = buildNextStatus({ previous: ok, result: { code: "held_back", heldBack: [{ path: "big.bin", bytes: 1 }], pushed: true }, trigger: "scheduled", lock: "acquired", nowIso: at(10) });
    const failed = buildNextStatus({ previous: held, result: { code: "merge_conflict", liveTreeBehind: { paths: ["a.md"] } }, trigger: "scheduled", lock: "acquired", nowIso: at(20) });
    expect(failed).toMatchObject({ consecutiveFailures: 1, firstFailureAt: at(20), heldBack: { since: at(10) }, liveTreeBehind: { since: at(20) } });
    const off = buildNextStatus({ previous: failed, result: { code: "disabled" }, trigger: "scheduled", lock: "none", nowIso: at(30) });
    expect(off).toMatchObject({ outcome: "disabled", code: "disabled", consecutiveFailures: 0, sameCodeRuns: 0, firstFailureAt: null, lastSuccessAt: at(10), heldBack: null, nestedRepos: null, liveTreeBehind: null });
    expect(kGitSyncCodes.disabled).toMatchObject({ outcome: "disabled", exitCode: 0, headline: "Git sync is off (ALPHACLAW_GIT_SYNC=off)" });
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

  it("keeps a held-back episode across failed and single-file runs and clears it on a full scan with none", () => {
    const heldBack = [{ path: "workspace/dump/", bytes: 2048 }];
    const held = buildNextStatus({ previous: null, result: { code: "held_back", heldBack, pushed: true }, trigger: "scheduled", lock: "acquired", nowIso: at(0) });
    expect(held).toMatchObject({ outcome: "warning", consecutiveFailures: 0, heldBack: { since: at(0), runs: 1, paths: heldBack } });
    const failed = buildNextStatus({ previous: held, result: { code: "failed" }, trigger: "scheduled", lock: "acquired", nowIso: at(30) });
    expect(failed.heldBack).toMatchObject({ since: at(0), runs: 1 });
    const caller = buildNextStatus({ previous: failed, result: { code: "ok", heldBack: [], singleFile: true }, trigger: "caller", lock: "acquired", nowIso: at(40) });
    expect(caller.heldBack).toMatchObject({ since: at(0) });
    const again = buildNextStatus({ previous: caller, result: { code: "held_back", heldBack }, trigger: "scheduled", lock: "acquired", nowIso: at(50) });
    expect(again.heldBack).toMatchObject({ since: at(0), runs: 2 });
    const cleared = buildNextStatus({ previous: again, result: { code: "ok", heldBack: [] }, trigger: "scheduled", lock: "acquired", nowIso: at(59) });
    expect(cleared.heldBack).toBeNull();
  });

  it("keeps a nested-repository episode across failed and single-file runs and clears it on a full scan with none", () => {
    const nestedRepos = [{ path: "workspace-research/", kind: "repository" }];
    const nested = buildNextStatus({ previous: null, result: { code: "nested_repo", nestedRepos, pushed: true }, trigger: "scheduled", lock: "acquired", nowIso: at(0) });
    expect(nested).toMatchObject({ outcome: "warning", consecutiveFailures: 0, nestedRepos: { since: at(0), runs: 1, paths: nestedRepos } });
    const failed = buildNextStatus({ previous: nested, result: { code: "failed" }, trigger: "scheduled", lock: "acquired", nowIso: at(30) });
    expect(failed.nestedRepos).toMatchObject({ since: at(0), runs: 1 });
    const caller = buildNextStatus({ previous: failed, result: { code: "ok", nestedRepos: [], singleFile: true }, trigger: "caller", lock: "acquired", nowIso: at(40) });
    expect(caller.nestedRepos).toMatchObject({ since: at(0) });
    const again = buildNextStatus({ previous: caller, result: { code: "nested_repo", nestedRepos }, trigger: "scheduled", lock: "acquired", nowIso: at(50) });
    expect(again.nestedRepos).toMatchObject({ since: at(0), runs: 2 });
    const cleared = buildNextStatus({ previous: again, result: { code: "ok", nestedRepos: [] }, trigger: "scheduled", lock: "acquired", nowIso: at(59) });
    expect(cleared.nestedRepos).toBeNull();
  });

  it("every emitted code has an outcome, exit code and copy", () => {
    for (const [code, info] of Object.entries(kGitSyncCodes)) {
      expect(["ok", "warning", "disabled", "refused", "failed"]).toContain(info.outcome);
      expect([0, 1, 2, 75]).toContain(info.exitCode);
      expect(info.headline, code).toBeTruthy();
      if (code !== "ok") expect(info.action, code).toBeTruthy();
    }
  });
});

describe("git-sync failure reason", () => {
  it("names the git error in one plain sentence", () => {
    const reason = (detail, code = "failed") => describeGitSyncFailure({ code, detail });
    expect(reason("error: pathspec 'workspace/caf\ufffd.md' did not match any file(s) known to git"))
      .toBe('Git could not match "workspace/caf\ufffd.md", a path the sync asked it to commit.');
    expect(reason("error: 'workspace/clone/' does not have a commit checked out\nfatal: adding files failed"))
      .toBe('"workspace/clone/" is a nested git repository with no commits, so git cannot add it.');
    expect(reason("fatal: Authentication failed for 'https://github.com/owner/repo.git/'", "remote_unreachable"))
      .toBe("GitHub rejected the sync's credentials.");
    expect(reason("hint: something\nfatal: unable to write new index file\nmore"))
      .toBe("Git reported: unable to write new index file.");
    expect(reason("fatal: unable to access 'https://user:secret@example.com/r.git/': weird"))
      .not.toContain("secret");
    expect(reason("error: x\ny".repeat(200)).length).toBeLessThanOrEqual(240);
  });

  it("leaves codes whose headline already names the cause, and whose detail can name processes, without one", () => {
    expect(describeGitSyncFailure({ code: "in_progress_operation", detail: "pid 812 (git rebase) is still running" })).toBe("");
    expect(describeGitSyncFailure({ code: "merge_conflict", detail: "conflict in a.md" })).toBe("");
    expect(describeGitSyncFailure({ code: "failed", detail: "" })).toBe("");
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

  it("closes an announced failure episode with one turned-off line when sync is switched off, never a recovery line", async () => {
    record({ code: "merge_conflict", detail: "conflict in a.md" });
    record({ code: "merge_conflict", detail: "conflict in a.md" });
    const { health, notify, recordEvent } = createHealth();
    expect(await health.check()).toEqual({ action: "notified_blocked" });

    now += 60 * 60_000;
    record({ code: "disabled" });
    expect(await health.check()).toEqual({ action: "notified_disabled" });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toBe(
      "⏸️ Git sync was turned off (ALPHACLAW_GIT_SYNC=off), so AlphaClaw no longer backs up this repository and its open sync alert is closed.",
    );
    expect(notify.mock.calls[1][1]).toEqual({ eventType: "health", id: "git-sync-disabled-2026-10-12T10:00:00.000Z" });
    expect(recordEvent).toHaveBeenLastCalledWith(expect.objectContaining({ eventType: "git_sync_disabled", source: "git-sync", status: "ok" }));
    expect(notify.mock.calls.some(([message]) => /recovered/.test(message))).toBe(false);

    now += 25 * 60 * 60_000;
    record({ code: "disabled" });
    expect(await health.check()).toEqual({ action: "none" });
    await expect(createHealth().health.check()).resolves.toEqual({ action: "none" });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("says nothing when sync is switched off with no open episode", async () => {
    record({ code: "ok", pushed: true, shortHash: "abc1234" });
    record({ code: "disabled" });
    const { health, notify } = createHealth();
    expect(await health.check()).toEqual({ action: "none" });
    expect(notify).not.toHaveBeenCalled();
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

  it("tells the owner once per episode when a failure lasts a day, naming the git error, then clears it", async () => {
    const pathspec = { code: "failed", detail: "error: pathspec 'workspace/caf\ufffd.md' did not match any file(s) known to git" };
    record(pathspec);
    const { health, notify, recordEvent } = createHealth();
    expect(await health.check()).toEqual({ action: "none" });

    now += 24 * 60 * 60_000;
    expect(await health.check()).toEqual({ action: "notified_blocked" });
    const [message] = notify.mock.calls[0];
    expect(message).toContain("Git sync failed (since 2026-10-12T10:00:00Z, 1 run(s))");
    expect(message).toContain('Git could not match "workspace/caf\ufffd.md", a path the sync asked it to commit.');
    expect(message).not.toContain("error: pathspec");
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent.mock.calls[0][0]).toMatchObject({
      eventType: "git_sync_refused",
      status: "failed",
      details: { code: "failed", reason: 'Git could not match "workspace/caf\ufffd.md", a path the sync asked it to commit.' },
    });

    for (let run = 0; run < 5; run += 1) {
      now += 60 * 60_000;
      record(pathspec);
      expect(await health.check()).toEqual({ action: "none" });
    }
    expect(notify).toHaveBeenCalledTimes(1);

    record({ code: "ok", pushed: true, shortHash: "def5678" });
    expect(await health.check()).toEqual({ action: "notified_recovered" });
    expect(notify.mock.calls[1][0]).toBe("✅ Git sync recovered after 29 h; pushed def5678.");
    expect(recordEvent.mock.calls[1][0]).toMatchObject({ eventType: "git_sync_recovered", status: "ok" });
    expect(await health.check()).toEqual({ action: "none" });
  });

  it("tells the owner after three failed runs in a row, before a day has passed", async () => {
    const { health, notify } = createHealth();
    for (let run = 1; run <= 3; run += 1) {
      record({ code: "failed", detail: "fatal: unable to write new index file" });
      expect(await health.check()).toEqual({ action: run < 3 ? "none" : "notified_blocked" });
      now += 30 * 60_000;
    }
    expect(notify.mock.calls[0][0]).toContain("Git reported: unable to write new index file.");
  });

  it("reminds every 24 h while the failure lasts, and survives a restart without an extra reminder", async () => {
    const failing = { code: "failed", detail: "error: pathspec 'workspace/a.md' did not match any file(s) known to git" };
    for (let run = 0; run < 3; run += 1) record(failing);
    const { health, notify, recordEvent } = createHealth();
    expect(await health.check()).toEqual({ action: "notified_blocked" });

    now += 23 * 60 * 60_000;
    record(failing);
    expect(await health.check()).toEqual({ action: "none" });
    now += 60 * 60_000;
    const restarted = createHealth();
    expect(await restarted.health.check()).toEqual({ action: "none" });
    now += 60_000;
    record(failing);
    expect(await restarted.health.check()).toEqual({ action: "reminded_blocked" });
    expect(await health.check()).toEqual({ action: "none" });

    now += 24 * 60 * 60_000;
    const third = createHealth();
    now += 60_000;
    record(failing);
    expect(await third.health.check()).toEqual({ action: "reminded_blocked" });
    const [message, opts] = third.notify.mock.calls[0];
    expect(message).toMatch(/^⚠️ Still failing: Git sync failed \(since 2026-10-12T10:00:00Z, 6 run\(s\)\)/);
    expect(message).toContain('Git could not match "workspace/a.md", a path the sync asked it to commit.');
    expect(opts.id).toBe("git-sync-blocked-2026-10-12T10:00:00.000Z-reminder-2");
    expect(third.recordEvent.mock.calls[0][0]).toMatchObject({ eventType: "git_sync_refused", details: { reminder: 2 } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it("holds an older version's episode until the first run after this process started, then reminds once", async () => {
    for (let run = 0; run < 3; run += 1) record({ code: "failed", detail: "fatal: x" });
    const statePath = path.join(openclawDir, ".alphaclaw", "git-sync-health.json");
    fs.writeFileSync(statePath, JSON.stringify({ episode: "2026-10-12T10:00:00.000Z", episodeCode: "failed" }));
    now += 60_000;
    const { health, notify } = createHealth();
    now += 7_000;
    expect(await health.check()).toEqual({ action: "none" });
    expect(notify).not.toHaveBeenCalled();

    now += 60 * 60_000;
    record({ code: "failed", detail: "fatal: x" });
    expect(await health.check()).toEqual({ action: "reminded_blocked" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/^⚠️ Still failing: /);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({
      episodeCode: "failed",
      failure: { since: "2026-10-12T10:00:00.000Z", lastNotifiedAt: now, reminders: 1 },
    });
    expect(await health.check()).toEqual({ action: "none" });
  });

  it("sends an older version's episode one recovery line once a run after this process started succeeds", async () => {
    for (let run = 0; run < 3; run += 1) record({ code: "failed", detail: "fatal: x" });
    const statePath = path.join(openclawDir, ".alphaclaw", "git-sync-health.json");
    fs.writeFileSync(statePath, JSON.stringify({ failure: { since: "2026-10-12T10:00:00.000Z", lastNotifiedAt: now, reminders: 0 } }));
    now += 2 * 24 * 60 * 60_000;
    const { health, notify } = createHealth();
    expect(await health.check()).toEqual({ action: "none" });

    now += 30 * 60_000;
    record({ code: "ok", pushed: true, shortHash: "abc1234" });
    expect(await health.check()).toEqual({ action: "notified_recovered" });
    expect(await health.check()).toEqual({ action: "none" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe("✅ Git sync recovered after 2 days; pushed abc1234.");
  });

  it("does not mark an episode announced when the notification could not be handed over", async () => {
    for (let run = 0; run < 3; run += 1) record({ code: "failed", detail: "fatal: x" });
    const notify = vi.fn(async () => {
      throw new Error("outbox unavailable");
    });
    const recordEvent = vi.fn();
    const logger = { warn: vi.fn() };
    const health = createGitSyncHealth({ openclawDir, notify, recordEvent, nowFn: () => now, logger });
    expect(await health.check()).toEqual({ action: "notify_failed" });
    expect(recordEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("retrying next check"));
    expect(await createHealth().health.check()).toEqual({ action: "notified_blocked" });
  });

  it("retries a notification the notifier refused, but accepts one the owner's settings skip", async () => {
    for (let run = 0; run < 3; run += 1) record({ code: "failed", detail: "fatal: x" });
    const refusing = createGitSyncHealth({
      openclawDir,
      notify: vi.fn(async () => ({ ok: false, reason: "all_admin_targets_failed" })),
      recordEvent: vi.fn(),
      nowFn: () => now,
      logger: { warn: vi.fn() },
    });
    expect(await refusing.check()).toEqual({ action: "notify_failed" });
    expect(await refusing.check()).toEqual({ action: "notify_failed" });
    const skipping = createGitSyncHealth({
      openclawDir,
      notify: vi.fn(async () => ({ ok: false, skipped: true, reason: "notifications_disabled" })),
      recordEvent: vi.fn(),
      nowFn: () => now,
    });
    expect(await skipping.check()).toEqual({ action: "notified_blocked" });
    expect(await skipping.check()).toEqual({ action: "none" });
  });

  it("reports held-back large files once per episode, reminds daily, and clears when they are gone", async () => {
    const heldBack = [{ path: "workspace/dump/", bytes: 120 * 1024 * 1024 }];
    record({ code: "held_back", heldBack, pushed: true, shortHash: "abc1234" });
    const { health, notify, recordEvent } = createHealth();
    expect(await health.check()).toEqual({ action: "notified_held_back" });
    expect(notify.mock.calls[0][0]).toBe(
      "⚠️ Git sync has not backed up 1 large new path(s) since 2026-10-12T10:00:00Z: workspace/dump/ (120.0 MB).\n" +
        "Everything else was pushed. Move the listed paths out of the workspace or add them to .gitignore; raise ALPHACLAW_GIT_SYNC_MAX_NEW_MB only if they belong in the backup.",
    );
    expect(recordEvent.mock.calls[0][0]).toMatchObject({ eventType: "git_sync_refused", status: "warning", details: { code: "held_back" } });
    record({ code: "held_back", heldBack });
    expect(await health.check()).toEqual({ action: "none" });

    now += 24 * 60 * 60_000;
    for (let run = 0; run < 3; run += 1) record({ code: "failed", detail: "fatal: x" });
    expect(await health.check()).toEqual({ action: "notified_blocked" });
    record({ code: "held_back", heldBack });
    expect(await health.check()).toEqual({ action: "notified_recovered" });
    expect(await health.check()).toEqual({ action: "reminded_held_back" });
    expect(notify.mock.calls.at(-1)[0]).toMatch(/^⚠️ Still holding back: /);

    record({ code: "ok", heldBack: [] });
    expect(await health.check()).toEqual({ action: "notified_held_back_cleared" });
    expect(notify.mock.calls.at(-1)[0]).toBe("✅ Git sync is no longer holding back large new files.");
    expect(recordEvent.mock.calls.at(-1)[0]).toMatchObject({ eventType: "git_sync_recovered", details: { code: "held_back" } });
    expect(await health.check()).toEqual({ action: "none" });
  });

  it("reports nested repositories once per episode, names what is and is not backed up, reminds daily, and clears", async () => {
    const nestedRepos = [
      { path: "workspace-research/", kind: "repository" },
      { path: "workspace/scripts/xmcp", kind: "pointer" },
    ];
    record({ code: "nested_repo", nestedRepos, pushed: true, shortHash: "abc1234" });
    const { health, notify, recordEvent } = createHealth();
    expect(await health.check()).toEqual({ action: "notified_nested_repo" });
    expect(notify.mock.calls[0][0]).toBe(
      "⚠️ Git sync has not backed up 2 nested git repositories since 2026-10-12T10:00:00Z: " +
        "workspace-research/ (a separate repository: its content and history are not backed up), " +
        "workspace/scripts/xmcp (a pointer only: the repository it points to is not backed up).\n" +
        kGitSyncCodes.nested_repo.action,
    );
    expect(recordEvent.mock.calls[0][0]).toMatchObject({
      eventType: "git_sync_refused",
      status: "warning",
      details: { code: "nested_repo", paths: nestedRepos },
    });
    record({ code: "nested_repo", nestedRepos });
    expect(await health.check()).toEqual({ action: "none" });

    now += 24 * 60 * 60_000;
    record({ code: "nested_repo", nestedRepos });
    expect(await health.check()).toEqual({ action: "reminded_nested_repo" });
    expect(notify.mock.calls.at(-1)[0]).toMatch(/^⚠️ Still not backing up: /);

    record({ code: "ok", nestedRepos: [] });
    expect(await health.check()).toEqual({ action: "notified_nested_repo_cleared" });
    expect(notify.mock.calls.at(-1)[0]).toBe("✅ Git sync no longer skips nested git repositories.");
    expect(recordEvent.mock.calls.at(-1)[0]).toMatchObject({ eventType: "git_sync_recovered", details: { code: "nested_repo" } });
    expect(await health.check()).toEqual({ action: "none" });
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
