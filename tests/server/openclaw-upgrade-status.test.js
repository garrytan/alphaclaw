const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  addDismissal,
  buildUpgradeStatus,
  describeBackupEvidence,
  kMemberLine,
  readDismissals,
  readRetryEligibility,
  readWorkspaceMoveEligibility,
  snapshotDismissKey,
} = require("../../lib/server/openclaw-upgrade-status");
const { evaluateUpgradeDiskCheck } = require("../../lib/server/upgrade-disk-check");

const kPin = "2026.10.4";
const key = { openclawVersion: kPin, alphaclawVersion: "0.10.7", configSha: "abc", layout: { symlinked: true } };
const kCause = "SQLite staging ancestor must not allow another user to replace its child: /data";
const failed = (overrides = {}) => ({
  status: "failed",
  class: "deterministic",
  reason: "failing_check",
  detail: "Failing check plugins: broken",
  captureState: "unavailable",
  captureCause: kCause,
  openclawVersion: kPin,
  source: "boot",
  at: 10,
  ...overrides,
});
const fixablePreflight = { captureAvailable: false, failingPath: "/data", failingRule: "ancestor_replaceable", fixable: { canFix: true, reason: "sticky_bit" } };

describe("openclaw-upgrade-status: the alert matrix", () => {
  it("deterministic failure (admin): plain reason, raw detail kept, snapshot line, Enable snapshots before Retry upgrade", () => {
    const status = buildUpgradeStatus({ record: { lastOutcome: failed() }, installedVersion: kPin, preflight: fixablePreflight, isAdmin: true });
    expect(status.alert).toMatchObject({
      kind: "failed",
      tone: "error",
      headline: "OpenClaw's data upgrade didn't finish",
      sentence: "One of OpenClaw's upgrade checks failed: plugins.",
      detail: "Failing check plugins: broken",
      snapshot: { sentence: "This run had no safety snapshot: /data lets other users replace the folders inside it, so OpenClaw won't stage a snapshot there." },
      actions: ["enable_snapshots", "retry_upgrade", "view_logs", "back_up"],
    });
    expect(status.retry.available).toBe(true);
  });

  it("member: the headline and the member line only — no actions, paths or preflight", () => {
    const status = buildUpgradeStatus({ record: { lastOutcome: failed() }, installedVersion: kPin, preflight: fixablePreflight, isAdmin: false });
    expect(status.alert).toEqual({
      kind: "failed",
      tone: "error",
      headline: "OpenClaw's data upgrade didn't finish",
      sentence: "One of OpenClaw's upgrade checks failed: plugins.",
      memberLine: kMemberLine,
      at: 10,
      actions: [],
    });
    expect(status.preflight).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("/data");
  });

  it("July-2026 window refusal: bridge steps and View logs, never Retry", () => {
    const status = buildUpgradeStatus({
      record: { lastOutcome: failed({ reason: "upgrade_window_refused", bridgeVersion: "2026.9.5" }) },
      installedVersion: kPin,
      isAdmin: true,
    });
    expect(status.alert.kind).toBe("window_refused");
    expect(status.alert.actions).toEqual(["view_logs", "back_up"]);
    expect(status.alert.steps[1]).toContain("OpenClaw 2026.9.5");
    expect(status.retry.available).toBe(false);
  });

  it("transient failure: 'interrupted' with Retry upgrade now and the next-restart sentence", () => {
    const status = buildUpgradeStatus({ record: { lastOutcome: failed({ class: "transient", reason: "timed_out" }) }, installedVersion: kPin, isAdmin: true });
    expect(status.alert).toMatchObject({ kind: "interrupted", tone: "warning", headline: "OpenClaw's data upgrade was interrupted" });
    expect(status.alert.sentence).toMatch(/next time the AlphaClaw server starts/);
  });

  it("a completed upgrade then a failed repair Doctor raises no failure alert", () => {
    const status = buildUpgradeStatus({
      record: { completedForVersion: kPin, lastOutcome: failed({ source: "repair" }) },
      installedVersion: kPin,
      isAdmin: true,
    });
    expect(status.alert).toBeNull();
  });

  it("an unchanged remembered failure marks the retry 'unchanged' (Retry anyway)", () => {
    const status = buildUpgradeStatus({
      record: { lastOutcome: failed(), failed: { key, reason: "failing_check", attempts: 2, at: 20 } },
      installedVersion: kPin,
      currentKey: { ...key },
      isAdmin: true,
    });
    expect(status.alert).toMatchObject({ unchanged: true, unchangedSince: 20, attempts: 2 });
    expect(status.retry).toMatchObject({ unchanged: true, unchangedSince: 20 });
    const changed = buildUpgradeStatus({
      record: { lastOutcome: failed(), failed: { key, reason: "failing_check", attempts: 2, at: 20 } },
      installedVersion: kPin,
      currentKey: { ...key, configSha: "def" },
      isAdmin: true,
    });
    expect(changed.retry.unchanged).toBe(false);
  });

  it("snapshot-less success: admin-only info row, dismissible per (version, path, rule); members see nothing", () => {
    const record = {
      completedForVersion: kPin,
      lastOutcome: { status: "ok", captureState: "unavailable", captureCause: kCause, openclawVersion: kPin, source: "boot", at: 5 },
      snapshotless: { openclawVersion: kPin, captureCause: kCause, source: "boot", at: 5 },
    };
    const admin = buildUpgradeStatus({ record, installedVersion: kPin, preflight: fixablePreflight, isAdmin: true });
    expect(admin.alert).toMatchObject({
      kind: "snapshotless",
      tone: "info",
      headline: "The upgrade ran without a safety snapshot",
      failingPath: "/data",
      failingRule: "ancestor_replaceable",
      actions: ["enable_snapshots", "dismiss", "back_up"],
    });
    expect(admin.alert.dismissKey).toBe(snapshotDismissKey({ openclawVersion: kPin, failingPath: "/data", failingRule: "ancestor_replaceable" }));
    expect(buildUpgradeStatus({ record, installedVersion: kPin, isAdmin: false }).alert).toBeNull();
    expect(buildUpgradeStatus({ record, installedVersion: kPin, isAdmin: true, dismissed: [admin.alert.dismissKey] }).alert).toBeNull();
    // After Enable snapshots the row says FUTURE runs only.
    const enabled = buildUpgradeStatus({ record, installedVersion: kPin, isAdmin: true, preflight: { captureAvailable: true, fixable: { canFix: false } } });
    expect(enabled.alert.sentence).toBe("Snapshots are on for future Doctor runs. This upgrade already ran without one, and turning them on doesn't change that.");
    expect(enabled.alert.actions).toEqual(["dismiss", "back_up"]);
  });

  it("dismissals persist server-side, newest 50", () => {
    const managedDir = fs.mkdtempSync(path.join(os.tmpdir(), "dismiss-"));
    for (let i = 0; i < 55; i += 1) addDismissal({ managedDir, key: i.toString(16).padStart(16, "0") });
    const keys = readDismissals({ managedDir });
    expect(keys).toHaveLength(50);
    expect(keys.at(-1)).toBe((54).toString(16).padStart(16, "0"));
  });
});

describe("openclaw-upgrade-status: backup evidence", () => {
  let backupsDir;
  beforeEach(() => {
    backupsDir = fs.mkdtempSync(path.join(os.tmpdir(), "backups-"));
  });
  const write = (name, bytes, mtimeMs) => {
    const file = path.join(backupsDir, name);
    fs.writeFileSync(file, Buffer.alloc(bytes));
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return { file, stat: fs.statSync(file) };
  };

  it("'verified' only for the archive the receipt names (path, size, mtime); everything else is 'unknown'", () => {
    const { file, stat } = write("a.tar.gz", 10, 1_000_000);
    write("b.tar.gz", 20, 2_000_000);
    const receipt = { archivePath: file, bytes: stat.size, mtimeMs: stat.mtimeMs, finishedAt: 1_000_000, verified: true, openclawVersion: "2026.10.2", upgradeCompleted: false };
    const evidence = describeBackupEvidence({ backupsDir, receipt, installedVersion: kPin, nowMs: 3_000_000 });
    expect(evidence.count).toBe(2);
    expect(evidence.newest).toMatchObject({ name: "b.tar.gz", verification: "unknown", ageMs: 1_000_000 });
    expect(evidence.verified).toMatchObject({ name: "a.tar.gz", scope: "pre_upgrade", openclawVersion: "2026.10.2" });
  });

  it("a rewritten archive under the same name loses its verified label", () => {
    const { file, stat } = write("a.tar.gz", 10, 1_000_000);
    const receipt = { archivePath: file, bytes: stat.size, mtimeMs: stat.mtimeMs, verified: true, openclawVersion: kPin, upgradeCompleted: true };
    fs.writeFileSync(file, Buffer.alloc(11));
    const evidence = describeBackupEvidence({ backupsDir, receipt, installedVersion: kPin });
    expect(evidence.verified).toBeNull();
    expect(evidence.newest.verification).toBe("unknown");
  });

  it("scope: a verified backup of the completed pin is the current state; before completion it's after the attempt", () => {
    const { file, stat } = write("c.tar.gz", 10, 1_000_000);
    const base = { archivePath: file, bytes: stat.size, mtimeMs: stat.mtimeMs, verified: true, openclawVersion: kPin };
    expect(describeBackupEvidence({ backupsDir, receipt: { ...base, upgradeCompleted: true }, installedVersion: kPin }).verified.scope).toBe("current");
    expect(describeBackupEvidence({ backupsDir, receipt: { ...base, upgradeCompleted: false }, installedVersion: kPin }).verified.scope).toBe("after_upgrade_attempt");
  });
});

describe("openclaw-upgrade-status: retry eligibility", () => {
  it("refuses a completed pin, a window refusal and an unchanged failure without confirmation", () => {
    expect(readRetryEligibility({ record: { completedForVersion: kPin }, installedVersion: kPin })).toMatchObject({ ok: false, code: "upgrade_complete" });
    expect(readRetryEligibility({ record: { lastOutcome: failed({ reason: "upgrade_window_refused" }) }, installedVersion: kPin })).toMatchObject({ ok: false, code: "upgrade_window_refused" });
    const record = { lastOutcome: failed(), failed: { key, reason: "failing_check", at: 3 } };
    expect(readRetryEligibility({ record, installedVersion: kPin, currentKey: key })).toMatchObject({ ok: false, code: "unchanged_since_failure", unchangedSince: 3 });
    expect(readRetryEligibility({ record, installedVersion: kPin, currentKey: key, confirmUnchanged: true })).toEqual({ ok: true, unchanged: true });
    expect(readRetryEligibility({ record, installedVersion: kPin, currentKey: { ...key, configSha: "x" } })).toEqual({ ok: true, unchanged: false });
  });
});

describe("openclaw-upgrade-status: disk space row (ALPH-23)", () => {
  const warn = { verdict: "warn", sentences: ["Only 45.0 GB is free for 30.0 GB of OpenClaw state."], stateBytes: 30e9, freeBytes: 45e9, expectedMinutes: 24 };
  const refuse = { verdict: "refuse", sentences: ["Make at least 60.0 GB free, then use Retry upgrade."], stateBytes: 30e9, freeBytes: 30e9, expectedMinutes: 24 };
  const completed = { completedForVersion: kPin };

  it("warns admins before the next upgrade, dismissible, and gives Retry upgrade the same sentences", () => {
    const status = buildUpgradeStatus({ record: completed, installedVersion: kPin, diskCheck: warn, isAdmin: true });
    expect(status.alert).toMatchObject({
      kind: "disk_space",
      tone: "warning",
      badgeLabel: "At risk",
      headline: "OpenClaw's next data upgrade is at risk",
      sentence: warn.sentences[0],
      actions: ["dismiss"],
    });
    expect(status.retry.disk).toEqual({ verdict: "warn", sentences: warn.sentences, expectedMinutes: 24 });
    const dismissed = buildUpgradeStatus({ record: completed, installedVersion: kPin, diskCheck: warn, isAdmin: true, dismissed: [status.alert.dismissKey] });
    expect(dismissed.alert).toBeNull();
  });

  it("a refusal is an error and cannot be dismissed", () => {
    const status = buildUpgradeStatus({ record: completed, installedVersion: kPin, diskCheck: refuse, isAdmin: true });
    expect(status.alert).toMatchObject({ kind: "disk_space", tone: "error", headline: "OpenClaw's next data upgrade can't start", actions: [], dismissKey: null });
  });

  it("never covers a failure row, and members never see it", () => {
    const failure = buildUpgradeStatus({ record: { lastOutcome: failed() }, installedVersion: kPin, diskCheck: refuse, isAdmin: true });
    expect(failure.alert.kind).toBe("failed");
    expect(buildUpgradeStatus({ record: completed, installedVersion: kPin, diskCheck: warn, isAdmin: false }).alert).toBeNull();
  });

  it("a boot that refused for disk space says the upgrade didn't start, with AlphaClaw's sentence", () => {
    const status = buildUpgradeStatus({
      record: { lastOutcome: failed({ class: "transient", reason: "insufficient_disk", detail: refuse.sentences[0], captureState: "unknown" }) },
      installedVersion: kPin,
      isAdmin: true,
    });
    expect(status.alert).toMatchObject({
      kind: "interrupted",
      headline: "OpenClaw's data upgrade didn't start",
      sentence: expect.stringContaining(refuse.sentences[0]),
      detail: null,
      actions: expect.arrayContaining(["retry_upgrade"]),
    });
  });

  it("a disk refusal reads the volume as it is now, except while a Doctor is writing to it", () => {
    const record = { lastOutcome: failed({ class: "transient", reason: "insufficient_disk", detail: "recorded sentence", captureState: "unknown" }) };
    const tight = evaluateUpgradeDiskCheck({ stateBytes: 4.2e9, freeBytes: 3.0e9 });
    const stillTight = buildUpgradeStatus({ record, installedVersion: kPin, diskCheck: tight, isAdmin: true });
    expect(stillTight.alert.sentence).toContain("3.0 GB free for 4.2 GB");
    expect(stillTight.alert.sentence).not.toContain("recorded sentence");

    const roomy = evaluateUpgradeDiskCheck({ stateBytes: 4.2e9, freeBytes: 6.0e9 });
    const freed = buildUpgradeStatus({ record, installedVersion: kPin, diskCheck: roomy, isAdmin: true });
    expect(freed.alert.sentence).toMatch(/^There is room for it to start now. Use Retry upgrade. Only 6.0 GB is free for 4.2 GB/);
    expect(freed.alert.sentence).toContain("skip its recovery copy");

    const plenty = evaluateUpgradeDiskCheck({ stateBytes: 4.2e9, freeBytes: 20e9 });
    expect(buildUpgradeStatus({ record, installedVersion: kPin, diskCheck: plenty, isAdmin: true }).alert.sentence).toMatch(
      /^There is room for it now: 20.0 GB free for 4.2 GB of OpenClaw state. Use Retry upgrade./,
    );

    const busy = { kind: "upgrade_retry", label: "Retry upgrade" };
    const running = buildUpgradeStatus({ record, installedVersion: kPin, diskCheck: tight, busy, isAdmin: true });
    expect(running.alert.sentence).toContain("recorded sentence");
    expect(buildUpgradeStatus({ record: completed, installedVersion: kPin, diskCheck: refuse, busy, isAdmin: true }).alert).toBeNull();

    const unmeasured = evaluateUpgradeDiskCheck({ stateBytes: 4.2e9, freeBytes: null });
    expect(buildUpgradeStatus({ record, installedVersion: kPin, diskCheck: unmeasured, isAdmin: true }).alert.sentence).toContain("recorded sentence");
  });
});

describe("openclaw-upgrade-status: the workspace moved (OpenClaw's workspace-alias stop)", () => {
  const move = { aliasPath: "/data/.openclaw/workspace", from: "/data/.openclaw/workspace", to: "/data/repo/sub/workspace" };
  const detail = "Failing check workspace-state (step-threw): Workspace path $OPENCLAW_HOME/.openclaw/workspace now resolves to …";
  const moved = (extra = {}) => failed({ reason: "workspace_moved", detail, captureState: "available", workspaceMove: { ...move, ...extra } });

  it("admin: its own row names both paths, says not to confirm by mistake, offers Confirm instead of Retry", () => {
    const record = { lastOutcome: moved(), failed: { key, reason: "workspace_moved", workspaceMove: move, at: 3 } };
    const status = buildUpgradeStatus({ record, installedVersion: kPin, currentKey: key, isAdmin: true });
    expect(status.alert).toMatchObject({
      kind: "failed",
      reason: "workspace_moved",
      headline: "OpenClaw's data upgrade is waiting for you to confirm the workspace moved",
      sentence:
        "The workspace folder's real location changed from /data/.openclaw/workspace to /data/repo/sub/workspace, and OpenClaw needs a confirmation before it rebinds its saved records to the new location. Don't confirm unless the folder really moved; if the path points somewhere new by mistake, restore the original link instead.",
      workspaceMove: move,
      detail,
      actions: ["confirm_workspace_move", "view_logs", "back_up"],
      unchanged: false,
    });
    expect(status.retry).toMatchObject({ available: false, unchanged: false });
  });

  it("names the configured path when it differs, and reads the remembered failure after a restart", () => {
    const record = { failed: { key, reason: "workspace_moved", detail, workspaceMove: { aliasPath: "/data/ws", from: "/data/old/ws", to: "/data/new/ws" }, at: 3 } };
    const status = buildUpgradeStatus({ record, installedVersion: kPin, isAdmin: true });
    expect(status.alert.sentence).toMatch(/^The workspace folder's real location changed from \/data\/old\/ws to \/data\/new\/ws \(configured as \/data\/ws\),/);
    expect(status.alert.actions).toContain("confirm_workspace_move");
  });

  it("a move OpenClaw refuses to rebind gets OpenClaw's reason and no Confirm", () => {
    const status = buildUpgradeStatus({ record: { lastOutcome: moved({ blocked: "The original workspace still exists." }) }, installedVersion: kPin, isAdmin: true });
    expect(status.alert.sentence).toMatch(/OpenClaw won't rebind them as things stand: The original workspace still exists\.$/);
    expect(status.alert.actions).toEqual(["view_logs", "back_up"]);
  });

  it("members see the plain sentence, never the paths or the action", () => {
    const status = buildUpgradeStatus({ record: { lastOutcome: moved() }, installedVersion: kPin, isAdmin: false });
    expect(status.alert).toEqual({
      kind: "failed",
      tone: "error",
      headline: "OpenClaw's data upgrade is waiting for you to confirm the workspace moved",
      sentence: "The workspace folder's real location changed, and OpenClaw needs a confirmation before it rebinds its saved records.",
      memberLine: kMemberLine,
      at: 10,
      actions: [],
    });
    expect(JSON.stringify(status)).not.toContain("/data/");
  });

  it("Confirm is eligible only for the move the operator saw, while the pin is unfinished", () => {
    const record = { lastOutcome: moved() };
    const confirmed = { from: move.from, to: move.to };
    expect(readWorkspaceMoveEligibility({ record, installedVersion: kPin, confirmed })).toEqual({ ok: true, workspaceMove: move });
    expect(readWorkspaceMoveEligibility({ record, installedVersion: kPin, confirmed: { ...confirmed, to: "/elsewhere" } })).toMatchObject({ ok: false, code: "workspace_move_changed" });
    expect(readWorkspaceMoveEligibility({ record: { lastOutcome: failed() }, installedVersion: kPin, confirmed })).toMatchObject({ ok: false, code: "no_workspace_move" });
    expect(readWorkspaceMoveEligibility({ record: { ...record, completedForVersion: kPin }, installedVersion: kPin, confirmed })).toMatchObject({ ok: false, code: "upgrade_complete" });
    expect(readWorkspaceMoveEligibility({ record: { lastOutcome: moved({ blocked: "The original workspace still exists." }) }, installedVersion: kPin, confirmed })).toMatchObject({ ok: false, code: "workspace_move_blocked" });
    expect(readWorkspaceMoveEligibility({ record, installedVersion: null, confirmed })).toMatchObject({ ok: false, code: "version_unknown" });
  });
});
