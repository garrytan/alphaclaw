import { describe, expect, it } from "vitest";
import {
  buildSyncScheduleOptions,
  defaultSyncSchedule,
  describeGitSyncLastRun,
} from "../../lib/public/js/components/general/sync-status.js";
import {
  describeSyncErrorToast,
  describeSyncToast,
} from "../../lib/public/js/components/sidebar-git-panel.js";

// Issue #140: offset schedule presets, the last-run status line, and the
// Sync button's toasts from the shared engine.
const presets = [
  { id: "every30", label: "Every 30 min · :07/:37", schedule: "7,37 * * * *" },
  { id: "hourly", label: "Hourly · :37", schedule: "37 * * * *" },
  { id: "daily", label: "Daily · 13:37", schedule: "37 13 * * *" },
];

describe("auto-sync schedule options", () => {
  it("lists the server presets and keeps a legacy or custom stored schedule visible", () => {
    expect(buildSyncScheduleOptions({ presets, schedule: "37 * * * *" }).map((o) => o.label)).toEqual([
      "Every 30 min · :07/:37",
      "Hourly · :37",
      "Daily · 13:37",
    ]);
    const legacy = buildSyncScheduleOptions({ presets, schedule: "0 * * * *", scheduleLabel: "Hourly · :00" });
    expect(legacy.at(-1)).toEqual({ value: "0 * * * *", label: "Hourly · :00", title: "0 * * * *" });
    expect(defaultSyncSchedule({ presets })).toBe("37 * * * *");
  });
});

describe("git sync last-run line", () => {
  const nowMs = Date.parse("2026-10-12T12:00:00.000Z");

  it("is absent before the first run", () => {
    expect(describeGitSyncLastRun(null)).toBeNull();
  });

  it("reports success, behind-GitHub warnings and blocked episodes", () => {
    expect(describeGitSyncLastRun({ at: "2026-10-12T11:48:00.000Z", outcome: "ok", shortHash: "abc1234" }, { nowMs })).toEqual({
      tone: "ok",
      text: "Last synced 12 minutes ago · abc1234",
    });
    expect(describeGitSyncLastRun({ at: "2026-10-12T11:48:00.000Z", outcome: "warning", liveTreeBehindCount: 2 }, { nowMs }).text)
      .toBe("Pushed 12 minutes ago, but 2 files on this box are behind GitHub (unsaved local edits)");
    expect(describeGitSyncLastRun({
      at: "2026-10-12T11:37:00.000Z",
      outcome: "refused",
      code: "in_progress_operation",
      headline: "Git sync blocked by an unfinished rebase or merge",
      firstFailureAt: "2026-10-12T09:00:00.000Z",
      consecutiveFailures: 3,
    }, { nowMs })).toEqual({
      tone: "error",
      text: "Git sync blocked by an unfinished rebase or merge since 3 hours ago (3 runs). Workspace changes are not being backed up.",
    });
    expect(describeGitSyncLastRun({ at: "x", outcome: "refused", code: "lock_timeout", consecutiveFailures: 1, headline: "h" }, { nowMs }).tone)
      .toBe("warning");
    expect(describeGitSyncLastRun({ at: "2026-10-12T11:48:00.000Z", outcome: "warning", code: "nested_repo", nestedRepoCount: 1 }, { nowMs })).toEqual({
      tone: "warning",
      text: "Pushed 12 minutes ago, but 1 nested git repository is not backed up",
    });
    expect(describeGitSyncLastRun({ at: "2026-10-12T11:48:00.000Z", outcome: "warning", code: "held_back", heldBackCount: 2 }, { nowMs })).toEqual({
      tone: "warning",
      text: "Pushed 12 minutes ago, but 2 large new paths are held back and not backed up",
    });
    expect(describeGitSyncLastRun({
      at: "2026-10-12T11:37:00.000Z",
      outcome: "failed",
      code: "failed",
      headline: "Git sync failed",
      firstFailureAt: "2026-10-12T09:00:00.000Z",
      consecutiveFailures: 5,
      reason: 'Git could not match "workspace/a.md", a path the sync asked it to commit.',
    }, { nowMs })).toEqual({
      tone: "error",
      text: 'Git sync failed since 3 hours ago (5 runs). Workspace changes are not being backed up. Git could not match "workspace/a.md", a path the sync asked it to commit.',
    });
  });
});

describe("sidebar sync toasts", () => {
  it("maps engine outcomes to toast tones", () => {
    expect(describeSyncToast({ outcome: "ok", committed: true, pushed: true, message: "Synced abc to GitHub" })).toEqual(["Synced abc to GitHub", "success"]);
    expect(describeSyncToast({ outcome: "warning", pushed: true, message: "Pushed, but behind" })).toEqual(["Pushed, but behind", "warning"]);
    expect(describeSyncToast({ outcome: "ok", committed: false, pushed: false, message: "No changes to sync" })).toEqual(["No changes to sync", "info"]);
    expect(describeSyncErrorToast({ code: "lock_timeout", message: "x" })).toEqual(["Another git writer is busy. Try again in a minute.", "info"]);
    expect(describeSyncErrorToast({ code: "merge_conflict", message: "Conflict in a.md.", hint: "Merge by hand." }))
      .toEqual(["Conflict in a.md. Merge by hand.", "error"]);
  });
});
