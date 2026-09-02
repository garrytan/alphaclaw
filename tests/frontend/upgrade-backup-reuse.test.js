import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Upgrade-tab coverage for the #54 backup contracts (plan §4.4): the reuse
// consent line on hard-gated confirms (WI-4.4), the 409 backup_failed →
// "Retry using that backup" second-stage flow (WI-4.5), the Backups card
// states (WI-4.3), the rollback-fence re-stat caveats (WI-4.1), and the
// warning-styled backup/gateway-relaunch step rows (WI-1.9/3.5). Kept
// separate from upgrade-tab.test.js (same harness) so concurrent additions
// there don't conflict.

// Minimal hook harness (same pattern as upgrade-tab.test.js): hook state
// lives in per-call-index slots so component/hook functions can be invoked
// directly without a DOM renderer. Effects are collected, not run.
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, effects: [] };
  harness.beginRender = () => {
    harness.cursor = 0;
    harness.effects = [];
  };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
    harness.effects = [];
  };
  const useState = (initialValue) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] =
        typeof initialValue === "function" ? initialValue() : initialValue;
    }
    const setState = (next) => {
      harness.slots[index] =
        typeof next === "function" ? next(harness.slots[index]) : next;
    };
    return [harness.slots[index], setState];
  };
  const useRef = (initialValue = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = { current: initialValue };
    }
    return harness.slots[index];
  };
  const useMemo = (factory) => factory();
  const useCallback = (fn) => fn;
  const useEffect = (effect) => {
    harness.effects.push(effect);
  };
  return { useState, useRef, useMemo, useCallback, useEffect, __harness: harness };
});

vi.mock("../../lib/public/js/lib/api.js", () => ({
  applyOpenclawVersion: vi.fn(),
  clearOpenclawBlocklist: vi.fn(),
  fetchOpenclawBackups: vi.fn(),
  fetchOpenclawCatalog: vi.fn(),
  fetchOpenclawChannel: vi.fn(),
  fetchOpenclawRun: vi.fn(),
  fetchOpenclawRunLogText: vi.fn(),
  fetchOpenclawRuns: vi.fn(),
  fetchStatus: vi.fn(),
  markOpenclawGood: vi.fn(),
  retryOpenclawReconcile: vi.fn(),
  rollbackOpenclaw: vi.fn(),
  runOpenclawRepair: vi.fn(),
  subscribeOpenclawApplyEvents: vi.fn(() => () => {}),
  updateOpenclawReleaseChannel: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { invalidateCache, setCached } from "../../lib/public/js/lib/api-cache.js";
import { UpgradeTabView } from "../../lib/public/js/components/upgrade-tab/index.js";
import { useUpgradeTab } from "../../lib/public/js/components/upgrade-tab/use-upgrade-tab.js";
import {
  kBackupsCacheKey,
  useBackupsInventory,
} from "../../lib/public/js/components/upgrade-tab/use-backups-inventory.js";
import {
  buildApplyConfirmModel,
  buildBackupReuseOfferModel,
  kBackupReuseConsentLabel,
  kBackupReuseInventoryErrorReason,
  kBackupReuseInventoryLoadingReason,
  kBackupReuseInventoryUnreadableReason,
  kBackupReuseNoneReason,
  kBackupReuseStaleReason,
  kBackupsEmptyLabel,
  kBackupsRunbookUrl,
  kBackupsUnreadableMessage,
} from "../../lib/public/js/components/upgrade-tab/helpers.js";
import { kBackupReuseRetryInventoryLabel } from "../../lib/public/js/components/upgrade-tab/dialogs.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { ToggleSwitch } from "../../lib/public/js/components/toggle-switch.js";
import { Tooltip } from "../../lib/public/js/components/tooltip.js";
import { InfoTooltip } from "../../lib/public/js/components/info-tooltip.js";

const harness = preactHooks.__harness;

const kNow = Date.parse("2026-09-02T12:00:00.000Z");
const kSha = "a".repeat(64);

// Components whose render bodies need a real DOM (portals) — keep as vnodes.
const kSkipExpand = new Set([Tooltip, InfoTooltip]);

const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function" && !kSkipExpand.has(node.type)) {
    try {
      out.rendered = expandTree(node.type(node.props || {}));
    } catch {
      out.rendered = null;
    }
  }
  if (out.props.children !== undefined) {
    out.props = { ...out.props, children: expandTree(out.props.children) };
  }
  return out;
};

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectNodes(node.props.children, out);
  if (node.rendered) collectNodes(node.rendered, out);
  return out;
};

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    if (node.props) collectText(node.props.children, out);
    if (node.rendered) collectText(node.rendered, out);
  }
  return out;
};

const treeText = (tree) => collectText(tree).join(" ");

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const findActionButtonByLabel = (tree, label) =>
  findAllByType(tree, ActionButton).find(
    (vnode) => vnode.props.idleLabel === label,
  );

const renderView = (stateOverrides = {}) => {
  harness.beginRender();
  return expandTree(UpgradeTabView({ state: { nowMs: kNow, ...stateOverrides } }));
};

const makeChannelInfo = (overrides = {}) => ({
  ok: true,
  releaseChannel: "stable",
  installedVersion: "2026.7.1-2",
  pinVersion: "2026.7.1-2",
  applied: null,
  appliedId: null,
  isPin: true,
  acceptedAt: null,
  inStabilizationWindow: false,
  lastKnownGood: { package: "2026.7.1-2", dev: null },
  blocklist: [],
  lastUpdateRun: null,
  lastBoot: null,
  ...overrides,
});

const makeEntry = (overrides = {}) => ({
  file: "/root/backups/openclaw/openclaw-backup-2026-09-02T09-00-00.tar.gz",
  name: "openclaw-backup-2026-09-02T09-00-00.tar.gz",
  producer: "openclaw",
  sizeBytes: 12_345_678,
  mtimeMs: kNow - 3 * 3_600_000,
  at: kNow - 3 * 3_600_000,
  verified: true,
  partial: false,
  reused: false,
  exists: true,
  operationId: "op-1",
  eligible: true,
  ineligibleReason: null,
  sha256: kSha,
  ...overrides,
});

const makeInventory = (entries = [makeEntry()], overrides = {}) => ({
  ok: true,
  backupsDir: "/root/backups/openclaw",
  readable: true,
  entries,
  truncated: false,
  newestArchive: null,
  ...overrides,
});

const kReusableBackup = {
  file: "/root/backups/openclaw/openclaw-backup-2026-09-02T10-00-00.alphaclaw.tar.gz",
  at: kNow - 2 * 3_600_000,
  ageMs: 2 * 3_600_000,
  sha256: kSha,
  producer: "alphaclaw-offline-copy",
};

const kDowngradeTarget = { channel: "stable", version: "2026.7.0" };

const makeOffer = () =>
  buildBackupReuseOfferModel({
    error: { code: "backup_failed", reusableBackup: kReusableBackup },
    target: kDowngradeTarget,
    label: "2026.7.0",
    nowMs: kNow,
  });

const makePendingDowngrade = ({ inventory = makeInventory(), reuseConsent = false } = {}) => ({
  payload: kDowngradeTarget,
  label: "2026.7.0",
  isDowngrade: true,
  reuseConsent,
  confirm: buildApplyConfirmModel({
    payload: kDowngradeTarget,
    label: "2026.7.0",
    isDowngrade: true,
    currentChannel: "stable",
    backupInventory: inventory,
    nowMs: kNow,
  }),
});

const findConsentToggle = (tree) =>
  findAllByType(tree, ToggleSwitch).find(
    (vnode) => vnode.props.label === kBackupReuseConsentLabel,
  );

describe("frontend/upgrade-tab apply confirm — backup reuse consent (WI-4.4)", () => {
  beforeEach(() => {
    harness.reset();
  });

  it("renders the consent toggle LAST, default OFF, with the newest eligible backup's loss window", () => {
    const onToggleBackupReuseConsent = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      pendingApply: makePendingDowngrade(),
      onToggleBackupReuseConsent,
    });

    const text = treeText(tree);
    expect(text).toContain("Downgrade to 2026.7.0?");
    expect(text).toContain("If the backup fails, nothing is installed.");
    expect(text).toContain("The gateway pauses briefly during the pre-update backup.");
    expect(text).toContain(kBackupReuseConsentLabel);
    expect(text).toContain("Taken 3 hours ago — state written since would not be in it.");
    expect(text).toContain("openclaw-backup-2026-09-02T09-00-00.tar.gz");
    // The consent line is the last thing before the dialog's buttons.
    expect(text.lastIndexOf(kBackupReuseConsentLabel)).toBeGreaterThan(
      text.lastIndexOf("The gateway pauses briefly"),
    );

    const toggle = findConsentToggle(tree);
    expect(toggle).toBeTruthy();
    expect(toggle.props.checked).toBe(false);
    expect(toggle.props.disabled).toBe(false);
    // The switch is a real checkbox underneath; flipping it reports true.
    const input = findAllByType(toggle, "input")[0];
    expect(input.props.checked).toBe(false);
    input.props.onchange({ target: { checked: true } });
    expect(onToggleBackupReuseConsent).toHaveBeenCalledWith(true);
  });

  it("reflects a checked consent and stays disabled with the reason when nothing is eligible", () => {
    const checked = renderView({
      channelInfo: makeChannelInfo(),
      pendingApply: makePendingDowngrade({ reuseConsent: true }),
    });
    expect(findConsentToggle(checked).props.checked).toBe(true);

    const none = renderView({
      channelInfo: makeChannelInfo(),
      pendingApply: makePendingDowngrade({ inventory: makeInventory([]) }),
    });
    const toggle = findConsentToggle(none);
    expect(toggle.props.disabled).toBe(true);
    expect(toggle.props.checked).toBe(false);
    expect(treeText(none)).toContain("No eligible backup to reuse");

    // Eligible but without a recorded digest: disabled, honest reason.
    const noDigest = renderView({
      channelInfo: makeChannelInfo(),
      pendingApply: makePendingDowngrade({
        inventory: makeInventory([makeEntry({ sha256: null })]),
      }),
    });
    expect(findConsentToggle(noDigest).props.disabled).toBe(true);
    expect(treeText(noDigest)).toContain("has no recorded digest");
  });

  it("routine same-channel upgrades carry no consent line at all", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      pendingApply: {
        payload: { channel: "stable", version: "2026.7.2" },
        label: "2026.7.2",
        isDowngrade: false,
        reuseConsent: false,
        confirm: buildApplyConfirmModel({
          payload: { channel: "stable", version: "2026.7.2" },
          label: "2026.7.2",
          currentChannel: "stable",
          backupInventory: makeInventory(),
          nowMs: kNow,
        }),
      },
    });
    expect(findConsentToggle(tree)).toBeUndefined();
    expect(treeText(tree)).not.toContain(kBackupReuseConsentLabel);
  });
});

describe("frontend/upgrade-tab 409 backup_failed → retry-with-backup (WI-4.5 view)", () => {
  beforeEach(() => {
    harness.reset();
  });

  it("the quick-failure card offers the age-labelled retry CTA and the loss window", () => {
    const onRequestBackupReuseRetry = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      applyError: { message: "Backup failed (lock_contention)", hint: null },
      backupReuseOffer: makeOffer(),
      onRequestBackupReuseRetry,
    });
    // Adjacent text nodes join with a space in this harness — normalize.
    const text = treeText(tree).replace(/\s+/g, " ");
    expect(text).toContain("Backup failed (lock_contention)");
    expect(text).toContain(
      "A fresh backup could not be made. That backup was taken 2 hours ago — state written since would not be in it.",
    );
    const cta = findActionButtonByLabel(tree, "Retry using the backup taken 2 hours ago");
    expect(cta).toBeTruthy();
    expect(cta.props.tone).toBe("warning");
    cta.props.onClick();
    expect(onRequestBackupReuseRetry).toHaveBeenCalledTimes(1);
    // No second-stage dialog until the CTA opens it.
    expect(text).not.toContain("Retry using the older backup?");
  });

  it("the streamed failure (progress card) offers the same CTA", () => {
    const onRequestBackupReuseRetry = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      operation: {
        operationId: "op-9",
        phase: "failed",
        label: "2026.7.0",
        target: kDowngradeTarget,
        startedAt: kNow - 120_000,
        finishedAt: kNow - 5_000,
        steps: [
          { name: "backup", status: "failed", at: kNow - 5_000, error: "state lease lost" },
        ],
        output: "",
        lastOutputAt: null,
        error: { message: "Backup failed (lock_contention)", code: "backup_failed" },
      },
      backupReuseOffer: makeOffer(),
      onRequestBackupReuseRetry,
    });
    const cta = findActionButtonByLabel(tree, "Retry using the backup taken 2 hours ago");
    expect(cta).toBeTruthy();
    cta.props.onClick();
    expect(onRequestBackupReuseRetry).toHaveBeenCalledTimes(1);
    // Re-stage stays available next to it (a fresh attempt without consent).
    expect(findActionButtonByLabel(tree, "Re-stage version")).toBeTruthy();
  });

  it("no offer → no CTA on either failure surface", () => {
    const quick = renderView({
      channelInfo: makeChannelInfo(),
      applyError: { message: "disk full", code: "enospc" },
      backupReuseOffer: null,
    });
    expect(treeText(quick)).not.toContain("Retry using the backup");
    expect(findAllByType(quick, ActionButton).some((v) => /Retry using/.test(v.props.idleLabel))).toBe(false);
  });

  it("the second-stage dialog states the full-ladder re-run, the pause, and the exact loss window", () => {
    const onConfirmBackupReuseRetry = vi.fn();
    const onCancelBackupReuseRetry = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      applyError: { message: "Backup failed" },
      backupReuseOffer: makeOffer(),
      backupReuseRetryPrompt: true,
      onConfirmBackupReuseRetry,
      onCancelBackupReuseRetry,
    });
    const text = treeText(tree);
    expect(text).toContain("Retry using the older backup?");
    expect(text).toContain(
      "The update to 2026.7.0 first re-runs the full backup ladder — the gateway pauses again while a fresh backup is attempted. Only if that fails again does it proceed with the backup below.",
    );
    expect(text).toContain("openclaw-backup-2026-09-02T10-00-00.alphaclaw.tar.gz");
    expect(text).toContain("offline copy");
    expect(text).toContain(
      "That backup was taken 2 hours ago — state written since would not be in it.",
    );
    const confirm = findActionButtonByLabel(tree, "Retry with backup fallback");
    expect(confirm).toBeTruthy();
    expect(confirm.props.tone).toBe("warning");
    confirm.props.onClick();
    expect(onConfirmBackupReuseRetry).toHaveBeenCalledTimes(1);
    findActionButtonByLabel(tree, "Cancel").props.onClick();
    expect(onCancelBackupReuseRetry).toHaveBeenCalledTimes(1);

    // Closed prompt: the dialog is gone even while the offer persists.
    const closed = renderView({
      channelInfo: makeChannelInfo(),
      applyError: { message: "Backup failed" },
      backupReuseOffer: makeOffer(),
      backupReuseRetryPrompt: false,
    });
    expect(treeText(closed)).not.toContain("Retry using the older backup?");
  });
});

describe("frontend/upgrade-tab rollback fence re-stat caveats (WI-4.1 view)", () => {
  beforeEach(() => {
    harness.reset();
  });

  it("renders the pruned-archive caveat naming the newest surviving archive", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      rollbackDataRisk: {
        message: "This update migrated your state databases — the rollback target may not be able to read them.",
        backupFile: "/root/backups/openclaw/openclaw-backup-old.tar.gz",
        backupFileExists: false,
        backupPartial: false,
        backupReused: false,
        reusedAgeMs: null,
        newestSurvivingBackup: {
          file: "/root/backups/openclaw/openclaw-backup-new.alphaclaw.tar.gz",
          at: kNow - 3 * 3_600_000,
          producer: "alphaclaw-offline-copy",
        },
      },
    });
    const text = treeText(tree);
    expect(text).toContain("Roll back despite migrated data?");
    expect(text).toContain("the original pre-migration backup was pruned");
    expect(text).toContain(
      "The newest surviving archive is /root/backups/openclaw/openclaw-backup-new.alphaclaw.tar.gz (offline copy, 3 hours ago)",
    );
    expect(text).toContain("it may not predate the migration");
  });

  it("renders the partial and reused caveats on a present archive", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      rollbackDataRisk: {
        message: null,
        backupFile: "/root/backups/openclaw/openclaw-backup-x.tar.gz",
        backupFileExists: true,
        backupPartial: true,
        backupReused: true,
        reusedAgeMs: 2 * 3_600_000,
        newestSurvivingBackup: null,
      },
    });
    const text = treeText(tree);
    expect(text).toContain(
      "Restore the verified pre-update backup first (/root/backups/openclaw/openclaw-backup-x.tar.gz)",
    );
    expect(text).toContain("workspace files were excluded from it");
    expect(text).toContain(
      "it was taken 2 hours before this update — state written since is not in it",
    );
  });
});

describe("frontend/upgrade-tab Backups card (WI-4.3)", () => {
  beforeEach(() => {
    harness.reset();
  });

  const findBackupsCard = (tree) =>
    collectNodes(tree).find(
      (vnode) =>
        vnode.type === "div" &&
        collectText(vnode).join(" ").includes("Restore runbook") &&
        String(vnode.props.class || "").includes("bg-surface"),
    );

  it("renders the frame with LOADING scoped to the data region, plus the runbook link", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      backupsLoading: true,
      backupsInventory: null,
    });
    const card = findBackupsCard(tree);
    expect(card).toBeTruthy();
    const text = collectText(card).join(" ");
    expect(text).toContain("Backups");
    expect(text).toContain("Loading backups...");
    expect(text).not.toContain(kBackupsEmptyLabel);
    const link = findAllByType(card, "a").find((v) => v.props.href === kBackupsRunbookUrl);
    expect(link).toBeTruthy();
    expect(link.props.href).toContain("docs/upgrade-troubleshooting.md#restoring-a-backup");
    expect(link.props.rel).toBe("noreferrer");
  });

  it("renders the distinct EMPTY state", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      backupsInventory: makeInventory([]),
    });
    const text = collectText(findBackupsCard(tree)).join(" ");
    expect(text).toContain(kBackupsEmptyLabel);
    // The pre-update backup runs on EVERY apply (same-channel upgrades are
    // merely soft-gated) — the empty copy must not claim cross-channel only.
    expect(kBackupsEmptyLabel).not.toMatch(/cross-channel/);
    expect(kBackupsEmptyLabel).toMatch(/next OpenClaw update/);
    expect(text).not.toContain("Loading backups");
  });

  it("renders a 200 with readable:false as the ERROR state (never 'No backups yet'), Retry wired", () => {
    const onRetryBackups = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      backupsInventory: makeInventory([], { readable: false }),
      onRetryBackups,
    });
    const card = findBackupsCard(tree);
    const chips = findAllByType(card, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.headline).toBe("Couldn't read backups");
    const text = collectText(card).join(" ");
    expect(text).toContain(kBackupsUnreadableMessage);
    expect(text).toContain("/root/backups/openclaw");
    expect(text).not.toContain(kBackupsEmptyLabel);
    const retry = findAllByType(card, "button").find((v) =>
      collectText(v).join("").includes("Retry"),
    );
    retry.props.onclick();
    expect(onRetryBackups).toHaveBeenCalledTimes(1);
    // A readable scan with no archives is still the genuine EMPTY state.
    const empty = renderView({
      channelInfo: makeChannelInfo(),
      backupsInventory: makeInventory([], { readable: true }),
    });
    expect(findAllByType(findBackupsCard(empty), InlineErrorChip).length).toBe(0);
    expect(collectText(findBackupsCard(empty)).join(" ")).toContain(kBackupsEmptyLabel);
  });

  it("renders the ERROR state as a chip with Retry wired to onRetryBackups", () => {
    const onRetryBackups = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      backupsInventory: null,
      backupsError: Object.assign(new Error("Could not read the backup inventory"), {
        code: "backups_unavailable",
      }),
      onRetryBackups,
    });
    const card = findBackupsCard(tree);
    const chips = findAllByType(card, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.headline).toBe("Couldn't read backups");
    const text = collectText(card).join(" ");
    expect(text).toContain("Couldn't read backups");
    expect(text).toContain("Could not read the backup inventory");
    expect(text).not.toContain(kBackupsEmptyLabel);
    const retry = findAllByType(card, "button").find((v) =>
      collectText(v).join("").includes("Retry"),
    );
    expect(retry).toBeTruthy();
    retry.props.onclick();
    expect(onRetryBackups).toHaveBeenCalledTimes(1);
  });

  it("renders rows with age, size, producer and self-standing badges; newest highlighted; truncation noted", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      backupsInventory: makeInventory(
        [
          makeEntry(),
          makeEntry({
            file: "/root/backups/openclaw/openclaw-backup-offline.alphaclaw.tar.gz",
            name: "openclaw-backup-offline.alphaclaw.tar.gz",
            producer: "alphaclaw-offline-copy",
            at: kNow - 30 * 60_000,
            partial: true,
            eligible: false,
            ineligibleReason: "partial",
            sizeBytes: 2048,
          }),
          makeEntry({
            file: "/root/backups/openclaw/openclaw-backup-gone.tar.gz",
            name: "openclaw-backup-gone.tar.gz",
            exists: false,
            sizeBytes: null,
            at: kNow - 48 * 3_600_000,
            eligible: false,
            ineligibleReason: "missing",
          }),
          makeEntry({
            file: "/root/backups/openclaw/openclaw-backup-stray.tar.gz",
            name: "openclaw-backup-stray.tar.gz",
            verified: false,
            eligible: false,
            ineligibleReason: "no_provenance",
            at: kNow - 5 * 24 * 3_600_000,
          }),
        ],
        { truncated: true },
      ),
    });
    const card = findBackupsCard(tree);
    const text = collectText(card).join(" ").replace(/\s+/g, " ");
    expect(text).toContain("openclaw-backup-2026-09-02T09-00-00.tar.gz");
    expect(text).toContain("3 hours ago");
    expect(text).toContain("11.8 MB");
    expect(text).toContain("upstream");
    expect(text).toContain("offline copy");
    expect(text).toContain("30 minutes ago");
    expect(text).toContain("2.00 KB");
    expect(text).toContain("verified");
    // Reason text is visible on the row — never tooltip-only.
    expect(text).toContain("partial — workspace files excluded");
    expect(text).toContain("missing — no longer on disk");
    expect(text).toContain("not reusable — no run record for it");
    expect(text).toContain("unverified");
    // The truncation count is the server's capped page (entries.length), not a
    // client literal that could drift from the server's cap.
    expect(text).toContain("Showing the newest 4 archives");
    expect(text).not.toContain("Showing the newest 50 archives");
    expect(text).not.toContain(kBackupsEmptyLabel);

    // AsyncSection returns its children, so the harness walks each row twice
    // (props.children + rendered) — dedupe by the row key.
    const rows = [
      ...new Map(
        findAllByType(card, "li").map((row) => [
          collectText(row).join(" "),
          row,
        ]),
      ).values(),
    ];
    expect(rows.length).toBe(4);
    const highlighted = rows.filter((row) => row.props["aria-current"] === "true");
    expect(highlighted.length).toBe(1);
    expect(collectText(highlighted[0]).join(" ")).toContain(
      "openclaw-backup-offline.alphaclaw.tar.gz",
    );
    expect(collectText(highlighted[0]).join(" ")).toContain("newest");
    expect(String(highlighted[0].props.class)).toContain("border-cyan-500/40");
  });

  it("keeps last-known rows with a refresh warning when a later read fails", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      backupsInventory: makeInventory(),
      backupsError: new Error("timeout"),
    });
    const card = findBackupsCard(tree);
    const text = collectText(card).join(" ");
    expect(text).toContain("openclaw-backup-2026-09-02T09-00-00.tar.gz");
    expect(text).toContain("Could not refresh the backup list — showing the last loaded data");
    expect(text).toContain("timeout");
    expect(findAllByType(card, InlineErrorChip).length).toBe(0);
  });

  it("F4: renders a partial archive's recorded reasons on its row (old records keep the generic label)", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      backupsInventory: makeInventory([
        makeEntry({
          file: "/root/backups/openclaw/openclaw-backup-offline.alphaclaw.tar.gz",
          name: "openclaw-backup-offline.alphaclaw.tar.gz",
          producer: "alphaclaw-offline-copy",
          partial: true,
          eligible: false,
          ineligibleReason: "partial",
          partialReasons: [
            "workspace files excluded (900 MB > 512 MB inline limit)",
            "credentials/oauth.json: symlink skipped",
          ],
        }),
        makeEntry({
          file: "/root/backups/openclaw/openclaw-backup-legacy.alphaclaw.tar.gz",
          name: "openclaw-backup-legacy.alphaclaw.tar.gz",
          producer: "alphaclaw-offline-copy",
          at: kNow - 5 * 3_600_000,
          partial: true,
          eligible: false,
          ineligibleReason: "partial",
        }),
      ]),
    });
    const text = collectText(findBackupsCard(tree)).join(" ").replace(/\s+/g, " ");
    expect(text).toContain(
      "partial — workspace files excluded (900 MB > 512 MB inline limit); credentials/oauth.json: symlink skipped",
    );
    // The reason-less legacy record still says what was always true of it.
    expect(text).toContain("partial — workspace files excluded ");
  });
});

describe("frontend/upgrade-tab progress card — backup warnings + gateway relaunch (WI-1.9/3.5)", () => {
  beforeEach(() => {
    harness.reset();
  });

  it("labels the gateway-relaunch step, styles warnings amber, and renders the server wording verbatim", () => {
    const detail =
      "fresh backup failed (lock_contention) — proceeding with the verified backup from 2 hours ago; state written since is not in it (after 3 attempts, 2 with the gateway paused)";
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      operation: {
        operationId: "op-1",
        phase: "running",
        label: "2026.7.0",
        target: kDowngradeTarget,
        startedAt: kNow - 60_000,
        steps: [
          { name: "backup", status: "running", at: kNow - 50_000, detail: "pausing the gateway for a consistent backup" },
          { name: "backup", status: "warning", at: kNow - 20_000, detail },
          { name: "gateway-relaunch", status: "warning", at: kNow - 10_000, error: "gateway did not come back within the ready budget" },
          { name: "download", status: "running", at: kNow - 5_000 },
        ],
        output: "",
        lastOutputAt: null,
        error: null,
      },
    });
    const text = treeText(tree);
    expect(text).toContain("Gateway relaunch");
    expect(text).toContain("gateway did not come back within the ready budget");
    expect(text).toContain(detail);
    // Client never re-words: the earlier running detail was superseded, the
    // attempt wording arrives untouched.
    expect(text).not.toContain("pausing the gateway for a consistent backup");
    const warningLabels = findAllByType(tree, "span").filter(
      (vnode) =>
        String(vnode.props.class || "").includes("text-status-warning-muted") &&
        ["Backup", "Gateway relaunch"].includes(collectText(vnode).join("")),
    );
    expect(warningLabels.map((vnode) => collectText(vnode).join(""))).toEqual([
      "Backup",
      "Gateway relaunch",
    ]);
    const warningDetail = findAllByType(tree, "span").find(
      (vnode) => collectText(vnode).join("") === detail,
    );
    expect(String(warningDetail.props.class)).toContain("text-status-warning-muted");
  });
});

describe("frontend/upgrade-tab hook — consent + reuse retry + fence fields", () => {
  const flushAsync = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const renderHook = (props = {}) => {
    harness.beginRender();
    return useUpgradeTab(props);
  };

  const hydrate = async (props = {}) => {
    let state = renderHook(props);
    // Run only the mount data-load effect (effect #0); the others start
    // timers/streams that the harness should not leak.
    harness.effects[0]();
    await flushAsync();
    state = renderHook(props);
    return state;
  };

  beforeEach(() => {
    harness.reset();
    invalidateCache("/api/openclaw/channel");
    invalidateCache("/api/openclaw/catalog");
    invalidateCache(kBackupsCacheKey);
    api.fetchOpenclawChannel.mockResolvedValue(makeChannelInfo());
    api.fetchOpenclawCatalog.mockResolvedValue({
      ok: true,
      catalog: { stable: [], beta: [], dev: { commits: [] }, staleAsOf: kNow, degraded: {} },
      channel: { releaseChannel: "stable" },
    });
    api.fetchOpenclawRuns.mockResolvedValue({ ok: true, runs: [] });
    api.fetchOpenclawBackups.mockResolvedValue(makeInventory());
    api.subscribeOpenclawApplyEvents.mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const requestDowngrade = (state) =>
    state.onRequestApply({
      payload: kDowngradeTarget,
      label: "2026.7.0",
      isDowngrade: true,
    });

  it("consent defaults OFF on every open, toggles locally, and rides the apply body as {sha256} only", async () => {
    // The inventory is a cache-backed read; seed the cache like a warm mount.
    setCached(kBackupsCacheKey, makeInventory());
    let state = await hydrate();
    expect(state.backupsInventory).toEqual(makeInventory());

    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.reuseConsent).toBe(false);
    expect(state.pendingApply.confirm.backupReuse).toEqual(
      expect.objectContaining({ available: true, sha256: kSha }),
    );

    state.onToggleBackupReuseConsent(true);
    state = renderHook({});
    expect(state.pendingApply.reuseConsent).toBe(true);

    // Cancel + reopen: never remembered.
    state.onCancelApply();
    state = renderHook({});
    expect(state.pendingApply).toBeNull();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.reuseConsent).toBe(false);

    state.onToggleBackupReuseConsent(true);
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValue({
      ok: true,
      operationId: "op-1",
      events: "/api/operations/op-1/events",
    });
    await state.onConfirmApply();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({
      channel: "stable",
      version: "2026.7.0",
      allowBackupReuse: { sha256: kSha },
    });
    const sentBody = api.applyOpenclawVersion.mock.calls[0][0];
    expect(JSON.stringify(sentBody)).not.toContain("/root/backups");
    state = renderHook({});
    // The recorded operation target stays the BARE payload — a later
    // "Re-stage version" never inherits this attempt's consent.
    expect(state.operation.target).toEqual(kDowngradeTarget);
  });

  it("an unchecked consent (or no eligible archive) sends no allowBackupReuse at all", async () => {
    setCached(kBackupsCacheKey, makeInventory());
    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValue({ ok: true, operationId: "op-1", events: "/e" });
    await state.onConfirmApply();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith(kDowngradeTarget);
    expect("allowBackupReuse" in api.applyOpenclawVersion.mock.calls[0][0]).toBe(false);

    // Checked but nothing eligible: still no consent field.
    harness.reset();
    invalidateCache(kBackupsCacheKey);
    setCached(kBackupsCacheKey, makeInventory([]));
    api.applyOpenclawVersion.mockClear();
    state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    state.onToggleBackupReuseConsent(true);
    state = renderHook({});
    await state.onConfirmApply();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith(kDowngradeTarget);
  });

  it("a quick 409 backup_failed with reusableBackup offers the retry; confirming resends with that sha256", async () => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockRejectedValueOnce(
      Object.assign(new Error("Backup failed: state lease lost (after 3 attempts, 2 with the gateway paused)"), {
        code: "backup_failed",
        hint: "Newest surviving archive: …",
        reusableBackup: kReusableBackup,
      }),
    );
    requestDowngrade(state);
    state = renderHook({});
    await state.onConfirmApply();
    state = renderHook({});

    expect(state.operation).toBeNull();
    expect(state.applyError).toEqual(
      expect.objectContaining({ code: "backup_failed" }),
    );
    // The model keeps the ABSOLUTE timestamp; the age strings are derived at
    // render time against the page clock (below), never frozen at the 409.
    expect(state.backupReuseOffer).toEqual(
      expect.objectContaining({
        sha256: kSha,
        target: kDowngradeTarget,
        label: "2026.7.0",
        at: kReusableBackup.at,
      }),
    );
    const atArrival = renderView({
      channelInfo: state.channelInfo,
      applyError: state.applyError,
      backupReuseOffer: state.backupReuseOffer,
      nowMs: kNow,
    });
    expect(findActionButtonByLabel(atArrival, "Retry using the backup taken 2 hours ago")).toBeTruthy();
    // An hour later, with the failed card still on screen, the disclosed loss
    // window has grown with the clock — on the CTA, the caption and the dialog.
    const later = renderView({
      channelInfo: state.channelInfo,
      applyError: state.applyError,
      backupReuseOffer: state.backupReuseOffer,
      backupReuseRetryPrompt: true,
      nowMs: kNow + 3_600_000,
    });
    expect(findActionButtonByLabel(later, "Retry using the backup taken 3 hours ago")).toBeTruthy();
    expect(findActionButtonByLabel(later, "Retry using the backup taken 2 hours ago")).toBeFalsy();
    const laterText = treeText(later).replace(/\s+/g, " ");
    expect(laterText).toContain(
      "A fresh backup could not be made. That backup was taken 3 hours ago — state written since would not be in it.",
    );
    expect(laterText).not.toContain("taken 2 hours ago");
    expect(state.backupReuseRetryPrompt).toBe(false);
    // The inventory is re-read once the apply settles.
    expect(api.fetchOpenclawBackups).toHaveBeenCalled();

    // The CTA only opens the second-stage dialog.
    state.onRequestBackupReuseRetry();
    state = renderHook({});
    expect(state.backupReuseRetryPrompt).toBe(true);
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(1);

    api.applyOpenclawVersion.mockResolvedValueOnce({
      ok: true,
      operationId: "op-2",
      events: "/api/operations/op-2/events",
    });
    await state.onConfirmBackupReuseRetry();
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(2);
    expect(api.applyOpenclawVersion).toHaveBeenLastCalledWith({
      channel: "stable",
      version: "2026.7.0",
      allowBackupReuse: { sha256: kSha },
    });
    state = renderHook({});
    expect(state.backupReuseRetryPrompt).toBe(false);
    expect(state.backupReuseOffer).toBeNull();
    expect(state.applyError).toBeNull();
    expect(state.operation).toEqual(
      expect.objectContaining({ phase: "running", operationId: "op-2", target: kDowngradeTarget }),
    );
  });

  it("cancelling the second-stage dialog or dismissing the error clears without calling the API", async () => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockRejectedValueOnce(
      Object.assign(new Error("Backup failed"), {
        code: "backup_failed",
        reusableBackup: kReusableBackup,
      }),
    );
    requestDowngrade(state);
    state = renderHook({});
    await state.onConfirmApply();
    state = renderHook({});
    state.onRequestBackupReuseRetry();
    state = renderHook({});
    expect(state.backupReuseRetryPrompt).toBe(true);

    state.onCancelBackupReuseRetry();
    state = renderHook({});
    expect(state.backupReuseRetryPrompt).toBe(false);
    expect(state.backupReuseOffer).not.toBeNull();

    state.onDismissApplyError();
    state = renderHook({});
    expect(state.applyError).toBeNull();
    expect(state.backupReuseOffer).toBeNull();
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(1);
  });

  it("R5: useBackupsInventory reads cache-friendly on mount and forces the server on refreshBackups", async () => {
    harness.beginRender();
    let state = useBackupsInventory();
    // The hook declares two effects (key reset, mount read); the harness only
    // collects them, so run the mount read by hand.
    harness.effects[1]();
    await flushAsync();
    expect(api.fetchOpenclawBackups).toHaveBeenCalledTimes(1);
    expect(api.fetchOpenclawBackups).toHaveBeenLastCalledWith({ force: false });

    harness.beginRender();
    state = useBackupsInventory();
    expect(state.inventory).toEqual(makeInventory());
    await state.refreshBackups();
    expect(api.fetchOpenclawBackups).toHaveBeenCalledTimes(2);
    expect(api.fetchOpenclawBackups).toHaveBeenLastCalledWith({ force: true });
    // The force is one-shot: a later routine read is cache-friendly again.
    invalidateCache(kBackupsCacheKey);
    harness.beginRender();
    state = useBackupsInventory();
    harness.effects[1]();
    await flushAsync();
    expect(api.fetchOpenclawBackups).toHaveBeenLastCalledWith({ force: false });
  });

  it("R5: the post-failure inventory re-read forces the SERVER to rescan", async () => {
    let state = await hydrate();
    // The harness does not run the inventory hook's mount effect.
    expect(api.fetchOpenclawBackups).not.toHaveBeenCalled();

    api.applyOpenclawVersion.mockRejectedValueOnce(
      Object.assign(new Error("Backup failed"), {
        code: "backup_failed",
        reusableBackup: kReusableBackup,
      }),
    );
    requestDowngrade(state);
    state = renderHook({});
    await state.onConfirmApply();
    await flushAsync();
    // Settled failure: the re-read must bypass the server's 5 s SWR copy too —
    // otherwise the client stores the pre-update directory as fresh for 60 s.
    expect(api.fetchOpenclawBackups).toHaveBeenCalledTimes(1);
    expect(api.fetchOpenclawBackups).toHaveBeenLastCalledWith({ force: true });

    // Retry-the-backups-card also forces (same code path).
    state = renderHook({});
    await state.onRetryBackups();
    expect(api.fetchOpenclawBackups).toHaveBeenLastCalledWith({ force: true });
  });

  it("R5: an open confirm re-binds its consent candidate when the forced re-read lands", async () => {
    // Warm cache from BEFORE the failed apply: an older archive is "newest".
    const oldSha = "b".repeat(64);
    const stale = makeInventory([
      makeEntry({
        name: "openclaw-backup-2026-09-02T07-00-00.tar.gz",
        at: kNow - 5 * 3_600_000,
        sha256: oldSha,
      }),
    ]);
    setCached(kBackupsCacheKey, stale);
    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toEqual(
      expect.objectContaining({ available: true, sha256: oldSha }),
    );

    // The forced re-read resolves with the real newest archive.
    api.fetchOpenclawBackups.mockResolvedValue(makeInventory());
    await state.onRetryBackups();
    expect(api.fetchOpenclawBackups).toHaveBeenLastCalledWith({ force: true });
    state = renderHook({});
    expect(state.backupsInventory).toEqual(makeInventory());
    // The rebind effect is the LAST declared effect in the hook.
    harness.effects[harness.effects.length - 1]();
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toEqual(
      expect.objectContaining({ available: true, sha256: kSha }),
    );

    // Same inventory again: the pending object is left untouched (no churn).
    const before = state.pendingApply;
    harness.effects[harness.effects.length - 1]();
    state = renderHook({});
    expect(state.pendingApply).toBe(before);

    state.onToggleBackupReuseConsent(true);
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValueOnce({ ok: true, operationId: "op-1", events: "/e" });
    await state.onConfirmApply();
    expect(api.applyOpenclawVersion).toHaveBeenLastCalledWith({
      ...kDowngradeTarget,
      allowBackupReuse: { sha256: kSha },
    });
  });

  it("R7: a verified archive that predates the last apply is not offered — toggle disabled, no consent sent", async () => {
    // The only archive (3 h old) was taken BEFORE the currently applied build
    // activated (1 h ago): the server's reuse gate would refuse it.
    api.fetchOpenclawChannel.mockResolvedValue(
      makeChannelInfo({
        applied: { channel: "stable", version: "2026.8.2", at: kNow - 3_600_000, acceptedAt: null },
        appliedId: "2026.8.2",
        isPin: false,
      }),
    );
    setCached(kBackupsCacheKey, makeInventory());
    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toEqual(
      expect.objectContaining({
        available: false,
        sha256: null,
        reason: kBackupReuseStaleReason,
      }),
    );
    const tree = renderView({
      channelInfo: state.channelInfo,
      pendingApply: state.pendingApply,
    });
    const toggle = findConsentToggle(tree);
    expect(toggle.props.disabled).toBe(true);
    expect(treeText(tree)).toContain(kBackupReuseStaleReason);

    // Even a checked toggle (impossible in the UI, defended anyway) sends nothing.
    state.onToggleBackupReuseConsent(true);
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValueOnce({ ok: true, operationId: "op-1", events: "/e" });
    await state.onConfirmApply();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith(kDowngradeTarget);
    expect("allowBackupReuse" in api.applyOpenclawVersion.mock.calls[0][0]).toBe(false);
  });

  it("F2: the inventory's server-published reuse window fences an archive the channel payload alone would offer", async () => {
    // channelInfo carries no apply/run/migration record (nothing to mirror),
    // but the server's ledger saw an activation after this archive was taken.
    const entry = makeEntry();
    setCached(
      kBackupsCacheKey,
      makeInventory([entry], {
        reuseWindowStartMs: Number(entry.at) + 60_000,
        reuseMaxAgeMs: 24 * 3_600_000,
      }),
    );
    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toEqual(
      expect.objectContaining({ available: false, sha256: null, reason: kBackupReuseStaleReason }),
    );
    const tree = renderView({
      channelInfo: state.channelInfo,
      pendingApply: state.pendingApply,
    });
    expect(findConsentToggle(tree).props.disabled).toBe(true);
    expect(treeText(tree)).toContain(kBackupReuseStaleReason);

    // Same inventory without the server window (old server) → offered.
    harness.reset();
    invalidateCache(kBackupsCacheKey);
    setCached(kBackupsCacheKey, makeInventory([entry]));
    state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse.available).toBe(true);
  });

  it("a backup_failed WITHOUT an offer, or a different code, yields no offer", async () => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockRejectedValueOnce(
      Object.assign(new Error("disk full"), { code: "backup_failed" }),
    );
    requestDowngrade(state);
    state = renderHook({});
    await state.onConfirmApply();
    state = renderHook({});
    expect(state.applyError.message).toBe("disk full");
    expect(state.backupReuseOffer).toBeNull();
  });

  it("a STREAMED terminal backup_failed carrying reusableBackup offers the retry against the in-flight target", async () => {
    let captured = null;
    api.subscribeOpenclawApplyEvents.mockImplementation((options) => {
      captured = options;
      return () => {};
    });
    api.applyOpenclawVersion.mockResolvedValue({
      ok: true,
      operationId: "op-1",
      events: "/api/operations/op-1/events",
    });
    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    await state.onConfirmApply();
    expect(captured).toBeTruthy();

    captured.onMessage({
      event: "step",
      data: { name: "backup", status: "failed", at: kNow, error: "state lease lost" },
    });
    captured.onMessage({
      event: "error",
      data: {
        error: "Backup failed: state lease lost (after 3 attempts, 2 with the gateway paused)",
        code: "backup_failed",
        hint: "Newest surviving archive: …",
        finishedAt: kNow,
        reusableBackup: kReusableBackup,
      },
    });
    state = renderHook({});
    expect(state.operation).toEqual(
      expect.objectContaining({ phase: "failed", finishedAt: kNow }),
    );
    expect(state.operation.error.code).toBe("backup_failed");
    expect(state.backupReuseOffer).toEqual(
      expect.objectContaining({
        sha256: kSha,
        target: kDowngradeTarget,
        label: "2026.7.0",
      }),
    );

    // Confirming from the failed card: the failed operation is replaced by
    // the new attempt, sent with consent.
    state.onRequestBackupReuseRetry();
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValueOnce({ ok: true, operationId: "op-2", events: "/e" });
    await state.onConfirmBackupReuseRetry();
    expect(api.applyOpenclawVersion).toHaveBeenLastCalledWith({
      ...kDowngradeTarget,
      allowBackupReuse: { sha256: kSha },
    });
    state = renderHook({});
    expect(state.operation).toEqual(
      expect.objectContaining({ phase: "running", operationId: "op-2" }),
    );
    expect(state.backupReuseOffer).toBeNull();

    // A streamed failure with a different code never offers.
    captured.onMessage({
      event: "error",
      data: { error: "npm exploded", code: "download_failed", finishedAt: kNow },
    });
    state = renderHook({});
    expect(state.operation.phase).toBe("failed");
    expect(state.backupReuseOffer).toBeNull();
  });

  it("running a repair clears a leftover reuse offer — a quick-failing repair never shows the earlier apply's CTA", async () => {
    let captured = null;
    api.subscribeOpenclawApplyEvents.mockImplementation((options) => {
      captured = options;
      return () => {};
    });
    api.fetchOpenclawChannel.mockResolvedValue(makeChannelInfo({ releaseChannel: "dev" }));
    api.applyOpenclawVersion.mockResolvedValue({ ok: true, operationId: "op-1", events: "/e" });
    let state = await hydrate();
    expect(state.repairAvailable).toBe(true);
    state.onRequestApply({ payload: { channel: "dev", devHead: true }, label: "latest dev" });
    state = renderHook({});
    await state.onConfirmApply();
    captured.onMessage({
      event: "error",
      data: { error: "Backup failed", code: "backup_failed", reusableBackup: kReusableBackup },
    });
    state = renderHook({});
    expect(state.operation.phase).toBe("failed");
    expect(state.backupReuseOffer).not.toBeNull();
    // The failed dev card offers BOTH the reuse retry and Run repair.
    const failedCard = renderView({
      channelInfo: state.channelInfo,
      operation: state.operation,
      backupReuseOffer: state.backupReuseOffer,
      repairAvailable: true,
    });
    expect(findActionButtonByLabel(failedCard, "Run repair")).toBeTruthy();
    expect(findActionButtonByLabel(failedCard, "Retry using the backup taken 2 hours ago")).toBeTruthy();

    // Run repair is rejected before an operationId exists (busy / 5xx).
    api.runOpenclawRepair.mockRejectedValueOnce(
      Object.assign(new Error("Another operation is in progress"), { code: "busy", status: 409 }),
    );
    state.onRequestBackupReuseRetry();
    state = renderHook({});
    expect(state.backupReuseRetryPrompt).toBe(true);
    await state.onRunRepair();
    state = renderHook({});
    expect(state.operation).toBeNull();
    expect(state.applyError.message).toBe("Another operation is in progress");
    expect(state.backupReuseOffer).toBeNull();
    expect(state.backupReuseRetryPrompt).toBe(false);
    const repairError = renderView({
      channelInfo: state.channelInfo,
      applyError: state.applyError,
      backupReuseOffer: state.backupReuseOffer,
      backupReuseRetryPrompt: state.backupReuseRetryPrompt,
      repairAvailable: true,
    });
    const text = treeText(repairError);
    expect(text).toContain("Another operation is in progress");
    expect(text).not.toContain("A fresh backup could not be made");
    expect(text).not.toContain("Retry using the backup");
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(1);
  });

  it("a hard-gated confirm opened while the inventory read FAILED says so (not 'No eligible backup') and re-binds after a retry", async () => {
    // The harness collects effects without running them, so the inventory's
    // mount read is driven by hand through the same forced-refresh path.
    api.fetchOpenclawBackups.mockRejectedValueOnce(
      Object.assign(new Error("Could not read the backup inventory"), { code: "backups_unavailable" }),
    );
    let state = await hydrate();
    await state.onRetryBackups();
    state = renderHook({});
    expect(state.backupsInventory).toBeNull();
    expect(state.backupsError).toBeTruthy();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toEqual(
      expect.objectContaining({
        available: false,
        sha256: null,
        reason: kBackupReuseInventoryErrorReason,
        retryable: true,
      }),
    );
    expect(state.pendingApply.confirm.backupReuse.reason).not.toBe(kBackupReuseNoneReason);
    const tree = renderView({
      channelInfo: state.channelInfo,
      pendingApply: state.pendingApply,
      onRetryBackups: state.onRetryBackups,
    });
    expect(findConsentToggle(tree).props.disabled).toBe(true);
    const text = treeText(tree);
    expect(text).toContain(kBackupReuseInventoryErrorReason);
    expect(text).not.toContain(kBackupReuseNoneReason);
    // The dialog offers the same re-read as the card; it forces the server.
    const retry = findAllByType(tree, "button").find(
      (v) => collectText(v).join("") === kBackupReuseRetryInventoryLabel,
    );
    expect(retry).toBeTruthy();
    api.fetchOpenclawBackups.mockResolvedValue(makeInventory());
    await retry.props.onclick();
    expect(api.fetchOpenclawBackups).toHaveBeenLastCalledWith({ force: true });
    state = renderHook({});
    expect(state.backupsInventory).toEqual(makeInventory());
    // The re-bind effect (last declared) binds the consent to the real newest archive.
    harness.effects[harness.effects.length - 1]();
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toEqual(
      expect.objectContaining({ available: true, sha256: kSha }),
    );
    // Checked-while-unreadable never sent consent; fail-closed all the way.
    harness.reset();
    invalidateCache(kBackupsCacheKey);
    api.fetchOpenclawBackups.mockRejectedValueOnce(new Error("offline"));
    api.applyOpenclawVersion.mockClear();
    state = await hydrate();
    await state.onRetryBackups();
    state = renderHook({});
    requestDowngrade(state);
    state = renderHook({});
    state.onToggleBackupReuseConsent(true);
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValueOnce({ ok: true, operationId: "op-1", events: "/e" });
    await state.onConfirmApply();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith(kDowngradeTarget);
    expect("allowBackupReuse" in api.applyOpenclawVersion.mock.calls[0][0]).toBe(false);
  });

  it("a 200 with readable:false disables the consent with the unreadable reason (+ retry), never 'No eligible backup'", async () => {
    setCached(kBackupsCacheKey, makeInventory([], { readable: false }));
    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toEqual(
      expect.objectContaining({
        available: false,
        sha256: null,
        reason: kBackupReuseInventoryUnreadableReason,
        retryable: true,
      }),
    );
    const tree = renderView({ channelInfo: state.channelInfo, pendingApply: state.pendingApply });
    expect(findConsentToggle(tree).props.disabled).toBe(true);
    expect(treeText(tree)).toContain(kBackupReuseInventoryUnreadableReason);
    expect(treeText(tree)).not.toContain(kBackupReuseNoneReason);
    expect(
      findAllByType(tree, "button").some(
        (v) => collectText(v).join("") === kBackupReuseRetryInventoryLabel,
      ),
    ).toBe(true);
  });

  it("dismissing a failed operation clears the offer and the prompt", async () => {
    let captured = null;
    api.subscribeOpenclawApplyEvents.mockImplementation((options) => {
      captured = options;
      return () => {};
    });
    api.applyOpenclawVersion.mockResolvedValue({ ok: true, operationId: "op-1", events: "/e" });
    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    await state.onConfirmApply();
    captured.onMessage({
      event: "error",
      data: { error: "Backup failed", code: "backup_failed", reusableBackup: kReusableBackup },
    });
    state = renderHook({});
    state.onRequestBackupReuseRetry();
    state = renderHook({});
    expect(state.backupReuseOffer).not.toBeNull();
    expect(state.backupReuseRetryPrompt).toBe(true);

    state.onDismissOperation();
    state = renderHook({});
    expect(state.operation).toBeNull();
    expect(state.backupReuseOffer).toBeNull();
    expect(state.backupReuseRetryPrompt).toBe(false);
  });

  it("the 409 rollback fence carries the WI-4.1 re-stat fields into the data-risk model", async () => {
    api.rollbackOpenclaw.mockRejectedValueOnce(
      Object.assign(new Error("migrated"), {
        code: "rollback_requires_confirmation",
        status: 409,
        backupFile: "/root/backups/openclaw/old.tar.gz",
        backupFileExists: false,
        backupPartial: true,
        backupReused: true,
        reusedAgeMs: 7_200_000,
        newestSurvivingBackup: {
          file: "/root/backups/openclaw/new.tar.gz",
          at: kNow - 3_600_000,
          producer: "openclaw",
        },
      }),
    );
    let state = await hydrate();
    state.onRequestRollback();
    state = renderHook({});
    await state.onRollback();
    state = renderHook({});
    expect(state.actionError).toBeNull();
    expect(state.rollbackDataRisk).toEqual({
      message: "migrated",
      backupFile: "/root/backups/openclaw/old.tar.gz",
      backupFileExists: false,
      backupPartial: true,
      backupReused: true,
      reusedAgeMs: 7_200_000,
      newestSurvivingBackup: {
        file: "/root/backups/openclaw/new.tar.gz",
        at: kNow - 3_600_000,
        producer: "openclaw",
      },
    });

    // Malformed shapes are dropped, not coerced into caveats.
    api.rollbackOpenclaw.mockRejectedValueOnce(
      Object.assign(new Error("migrated"), {
        code: "rollback_requires_confirmation",
        backupFile: "b.tar.gz",
        backupFileExists: "yes",
        reusedAgeMs: "soon",
        newestSurvivingBackup: "b.tar.gz",
      }),
    );
    state.onCancelRollbackDataRisk();
    state = renderHook({});
    state.onRequestRollback();
    state = renderHook({});
    await state.onRollback();
    state = renderHook({});
    expect(state.rollbackDataRisk).toEqual({
      message: "migrated",
      backupFile: "b.tar.gz",
      backupFileExists: undefined,
      backupPartial: false,
      backupReused: false,
      reusedAgeMs: null,
      newestSurvivingBackup: null,
    });
  });
});
