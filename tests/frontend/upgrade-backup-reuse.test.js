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
  const harness = { slots: [], cursor: 0, effects: [], cleanups: new Map() };
  harness.runEffect = (index) => {
    harness.cleanups.get(index)?.();
    harness.cleanups.set(index, harness.effects[index]?.());
  };
  // Keep committed read subscriptions mounted without starting polling.
  // Named effects avoid coupling these older fixtures to extraction order.
  harness.mountReads = () => harness.effects.forEach((effect, index) => {
    if (String(effect).includes("subscribeCache") || String(effect).includes("followedStale")) harness.runEffect(index);
  });
  harness.findEffect = (text) => harness.effects.find((effect) => String(effect).includes(text));
  harness.beginRender = () => {
    harness.cursor = 0;
    harness.effects = [];
  };
  harness.reset = () => {
    for (const cleanup of harness.cleanups.values()) cleanup?.();
    harness.cleanups.clear();
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
  authFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true, blocked: false, reason: null, diagnosis: { directories: { complete: true } } }))),
  applyOpenclawVersion: vi.fn(),
  requestOpenclawBackupRiskConsent: vi.fn(),
  cancelOpenclawRecoveryReview: vi.fn(),
  clearOpenclawBlocklist: vi.fn(),
  fetchOpenclawBackups: vi.fn(),
  fetchOpenclawCatalog: vi.fn(),
  fetchOpenclawChannel: vi.fn(),
  fetchOpenclawRunLogText: vi.fn(),
  fetchOpenclawRuns: vi.fn(),
  fetchOpenclawRun: vi.fn(),
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
  buildNoBackupConsentOfferModel,
  crossesChannelBoundary,
  kBackupHardGateNote,
  kBackupReuseCandidateChangedNotice,
  kBackupReuseConsentLabel,
  kBackupReuseInventoryErrorReason,
  kBackupReuseInventoryLoadingReason,
  kBackupReuseInventoryUnreadableReason,
  kBackupReuseNoneReason,
  kBackupReuseStaleReason,
  kBackupsEmptyLabel,
  kBackupsRunbookUrl,
  kBackupsUnreadableMessage,
  kNoBackupConsentConfirmLabel,
  kNoBackupConsentCtaLabel,
  kNoBackupConsentLabel,
} from "../../lib/public/js/components/upgrade-tab/helpers.js";
import { kBackupReuseRetryInventoryLabel } from "../../lib/public/js/components/upgrade-tab/dialogs.js";
// The server-side predicate the confirm's hard-gate copy must share (#79 (a)).
import { crossesChannelBoundary as kSharedBoundaryPredicate } from "../../lib/channel-boundary.js";
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

// #79 (b) fixtures: a routine same-channel target whose db-preflight said the
// target migrates the databases while the (soft-gated) backup failed — the
// server's 409 backup_required_for_migration envelope, verbatim shape.
const kSoftTarget = { channel: "stable", version: "2026.7.2" };
const kMigrationError = {
  backupRiskEligible: true,
  operationId: "11111111-1111-4111-8111-111111111111",
  code: "backup_required_for_migration",
  message:
    "OpenClaw 2026.7.2 will migrate your database (state 12→15, agent 17→19) and no backup exists — the running 2026.7.1-2 cannot read the migrated database, so there would be no rollback path.",
  hint:
    "Fix the backup and retry, or resend with confirmNoBackup: true to continue without one — there is then no way back to 2026.7.1-2.",
};
const makeNoBackupOffer = () =>
  buildNoBackupConsentOfferModel({ error: kMigrationError, target: kSoftTarget, label: "2026.7.2" });
const findNoBackupToggle = (tree) =>
  findAllByType(tree, ToggleSwitch).find(
    (vnode) => vnode.props.label === kNoBackupConsentLabel,
  );

describe("frontend/upgrade-tab apply confirm — backup reuse consent (WI-4.4)", () => {
  beforeEach(() => {
    harness.reset();
  });

  it("shows bounded config recovery instead of a historical archive fallback", () => {
    for (const pendingApply of [makePendingDowngrade(), makePendingDowngrade({ reuseConsent: true }), makePendingDowngrade({ inventory: makeInventory([]) }), { ...makePendingDowngrade(), reuseConsentReset: true }]) {
      const tree = renderView({ channelInfo: makeChannelInfo(), pendingApply });
      expect(treeText(tree)).toContain("Configuration checkpoint; database data not backed up");
      expect(treeText(tree)).toContain("16 MiB");
      expect(findConsentToggle(tree)).toBeUndefined();
      expect(treeText(tree)).not.toContain(kBackupReuseConsentLabel);
    }
  });

  it("does not expose archive reuse even for checked or empty legacy inventory", () => {
    for (const pendingApply of [makePendingDowngrade(), makePendingDowngrade({ reuseConsent: true }), makePendingDowngrade({ inventory: makeInventory([]) }), { ...makePendingDowngrade(), reuseConsentReset: true }]) {
      const tree = renderView({ channelInfo: makeChannelInfo(), pendingApply });
      expect(treeText(tree)).toContain("Configuration checkpoint; database data not backed up");
      expect(treeText(tree)).toContain("16 MiB");
      expect(findConsentToggle(tree)).toBeUndefined();
      expect(treeText(tree)).not.toContain(kBackupReuseConsentLabel);
    }
  });

  it("does not revive retired archive consent from stale dialog state", () => {
    for (const pendingApply of [makePendingDowngrade(), makePendingDowngrade({ reuseConsent: true }), makePendingDowngrade({ inventory: makeInventory([]) }), { ...makePendingDowngrade(), reuseConsentReset: true }]) {
      const tree = renderView({ channelInfo: makeChannelInfo(), pendingApply });
      expect(treeText(tree)).toContain("Configuration checkpoint; database data not backed up");
      expect(treeText(tree)).toContain("16 MiB");
      expect(findConsentToggle(tree)).toBeUndefined();
      expect(treeText(tree)).not.toContain(kBackupReuseConsentLabel);
    }
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

describe("frontend/upgrade-tab 409 backup_required_for_migration → no-backup consent (#79 (b), Codex 20 view)", () => {
  beforeEach(() => {
    harness.reset();
  });

  it("the offer model exists for the overridable code ONLY: backup_failed (even with a reusableBackup) and every other code yield null", () => {
    expect(makeNoBackupOffer()).toEqual({
      code: "backup_required_for_migration",
      operationId: kMigrationError.operationId,
      message: kMigrationError.message,
      hint: kMigrationError.hint,
      target: kSoftTarget,
      label: "2026.7.2",
    });
    expect(
      buildNoBackupConsentOfferModel({
        error: { code: "backup_failed", reusableBackup: kReusableBackup },
        target: kDowngradeTarget,
        label: "2026.7.0",
      }),
    ).toBeNull();
    expect(buildNoBackupConsentOfferModel({ error: { code: "db_preflight_failed" } })).toBeNull();
    expect(buildNoBackupConsentOfferModel({})).toBeNull();
  });

  it("the quick-failure card offers the CTA; the second-stage dialog renders the server message, a default-OFF checkbox with the exact consent copy, and a confirm that stays inert until it is checked", () => {
    const onToggleNoBackupConsent = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      applyError: kMigrationError,
      noBackupConsentOffer: makeNoBackupOffer(),
      noBackupConsentPrompt: true,
      noBackupConsentChecked: false,
      onToggleNoBackupConsent,
    });
    const text = treeText(tree).replace(/\s+/g, " ");
    expect(findActionButtonByLabel(tree, kNoBackupConsentCtaLabel)).toBeTruthy();
    expect(text).toContain(
      "Database data will not be backed up. Continuing is forward-only and may leave no safe rollback path.",
    );
    expect(text).toContain("Upgrade without database snapshot?");
    expect(text).toContain(kMigrationError.message);
    expect(text).toContain("this attempt has no database snapshot to restore");
    // The consent copy the plan pins.
    expect(kNoBackupConsentLabel).toBe(
      "I understand: database data is not backed up; this is forward-only and may leave no safe rollback path",
    );
    const toggle = findNoBackupToggle(tree);
    expect(toggle).toBeTruthy();
    expect(toggle.props.checked).toBe(false);
    // Never disabled: unlike the reuse toggle there is no candidate to bind.
    expect(Boolean(toggle.props.disabled)).toBe(false);
    const input = findAllByType(toggle, "input")[0];
    input.props.onchange({ target: { checked: true } });
    expect(onToggleNoBackupConsent).toHaveBeenCalledWith(true);
    // Unchecked → the confirm is disabled.
    const confirm = findActionButtonByLabel(tree, kNoBackupConsentConfirmLabel);
    expect(confirm).toBeTruthy();
    expect(confirm.props.disabled).toBe(true);
    // This dialog is the ONLY consent surface for this code — no reuse toggle.
    expect(findConsentToggle(tree)).toBeUndefined();

    const checked = renderView({
      channelInfo: makeChannelInfo(),
      applyError: kMigrationError,
      noBackupConsentOffer: makeNoBackupOffer(),
      noBackupConsentPrompt: true,
      noBackupConsentChecked: true,
    });
    expect(findNoBackupToggle(checked).props.checked).toBe(true);
    expect(findActionButtonByLabel(checked, kNoBackupConsentConfirmLabel).props.disabled).toBe(false);

    // Prompt closed → no dialog, the CTA remains.
    const closed = renderView({
      channelInfo: makeChannelInfo(),
      applyError: kMigrationError,
      noBackupConsentOffer: makeNoBackupOffer(),
      noBackupConsentPrompt: false,
    });
    expect(findNoBackupToggle(closed)).toBeUndefined();
    expect(findActionButtonByLabel(closed, kNoBackupConsentCtaLabel)).toBeTruthy();
  });

  it("a 409 backup_failed shows the reuse CTA and NO no-backup consent — the checkbox belongs to the overridable code alone (Codex 20)", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      applyError: { code: "backup_failed", message: "Backup failed: state lease lost", hint: null },
      backupReuseOffer: makeOffer(),
      noBackupConsentOffer: buildNoBackupConsentOfferModel({
        error: { code: "backup_failed", reusableBackup: kReusableBackup },
        target: kDowngradeTarget,
        label: "2026.7.0",
      }),
      noBackupConsentPrompt: true,
    });
    expect(findActionButtonByLabel(tree, "Retry using the backup taken 2 hours ago")).toBeTruthy();
    expect(findActionButtonByLabel(tree, kNoBackupConsentCtaLabel)).toBeUndefined();
    expect(findNoBackupToggle(tree)).toBeUndefined();
    expect(treeText(tree)).not.toContain(kNoBackupConsentLabel);
  });

  it("the streamed failure (progress card) offers the same CTA and caption", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      operation: {
        operationId: "op-9",
        resumed: false,
        target: kSoftTarget,
        label: "2026.7.2",
        startedAt: kNow - 60_000,
        finishedAt: kNow,
        steps: [],
        output: "",
        phase: "failed",
        error: kMigrationError,
      },
      noBackupConsentOffer: makeNoBackupOffer(),
    });
    expect(findActionButtonByLabel(tree, kNoBackupConsentCtaLabel)).toBeTruthy();
    expect(treeText(tree)).toContain("may leave no safe rollback path");
  });

  it("the apply confirm's hard-gate copy comes from the SHARED server predicate (#79 (a)): beta→stable and a same-channel prerelease→base both carry the backup hard gate; stable→stable base→base carries neither gate nor consent line", () => {
    // ONE function, re-exported — the confirm cannot drift from the gate.
    expect(crossesChannelBoundary).toBe(kSharedBoundaryPredicate);
    const betaBox = makeChannelInfo({
      releaseChannel: "beta",
      installedVersion: "2026.9.1-beta.1",
      applied: { channel: "beta", version: "2026.9.1-beta.1" },
      appliedId: "2026.9.1-beta.1",
      isPin: false,
    });
    const betaToStable = buildApplyConfirmModel({
      payload: { channel: "stable", version: "2026.9.2" },
      label: "2026.9.2",
      // The hook passes the PERSISTED applied channel (Codex 19).
      currentChannel: betaBox.applied.channel,
      channelInfo: betaBox,
      backupInventory: makeInventory(),
      nowMs: kNow,
    });
    expect(betaToStable.isBreaking).toBe(true);
    expect(betaToStable.hardGate).toBe(true);
    expect(betaToStable.lines).toContain(kBackupHardGateNote);
    expect(betaToStable.backupReuse).toBeNull();
    // prerelease → base on the beta channel: the version arm alone.
    const betaBase = buildApplyConfirmModel({
      payload: { channel: "beta", version: "2026.9.2" },
      label: "2026.9.2",
      currentChannel: "beta",
      channelInfo: betaBox,
      backupInventory: makeInventory(),
      nowMs: kNow,
    });
    expect(betaBase.isBreaking).toBe(true);
    expect(betaBase.hardGate).toBe(true);
    expect(betaBase.lines).toContain(kBackupHardGateNote);
    // stable → stable, base → base: no gate.
    const routine = buildApplyConfirmModel({
      payload: kSoftTarget,
      label: "2026.7.2",
      currentChannel: "stable",
      channelInfo: makeChannelInfo(),
      backupInventory: makeInventory(),
      nowMs: kNow,
    });
    expect(routine.isBreaking).toBe(false);
    expect(routine.hardGate).toBe(false);
    expect(routine.lines).not.toContain(kBackupHardGateNote);
    expect(routine.backupReuse).toBeNull();
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
    // v0.9.81 (C4, cross-model D18): a BACKUP-class failure offers "Retry
    // backup" next to the consent — never "Re-stage version", which would
    // re-download the target and change nothing about the backup.
    expect(findActionButtonByLabel(tree, "Retry backup")).toBeTruthy();
    expect(findActionButtonByLabel(tree, "Re-stage version")).toBeUndefined();
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
    const state = useUpgradeTab(props);
    harness.mountReads();
    return state;
  };

  const hydrate = async (props = {}) => {
    let state = renderHook(props);
    // Run only the mount data-load effect (effect #0); the others start
    // timers/streams that the harness should not leak.
    harness.findEffect("loadChannel({ fromCache")();
    await flushAsync();
    state = renderHook(props);
    return state;
  };

  // Pin Date (only Date — flushAsync and the hook's intervals stay real) to
  // the fixture epoch: the hook builds the reuse consent model with
  // Date.now(), so kNow-relative archives silently aged past the 24 h reuse
  // window once the wall clock moved beyond 2026-09-03 (a time bomb in the
  // fixtures, not a product change).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: kNow });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
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

  const choiceError = () => Object.assign(new Error("Database migration required"), {
    code: "recovery_choice_required", operationId: "choice-run", backupRiskEligible: true,
    databaseCount: 3, databaseBytes: 8 * 1024 ** 3, preflight: { migrationRequired: true, state: { from: 12, to: 15 } },
  });
  const requestChoice = async (error = choiceError()) => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockRejectedValueOnce(error);
    state.onRequestApply({ payload: kSoftTarget, label: "2026.7.2", intent: "update", expectLatest: true });
    state = renderHook({});
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    return renderHook({});
  };

  it("offers three explicit migration choices without sending a default risk decision", async () => {
    const state = await requestChoice();
    expect(api.applyOpenclawVersion).toHaveBeenCalledExactlyOnceWith({ ...kSoftTarget, intent: "update", expectLatest: true, recoveryMode: "config_only" });
    expect(state.recoveryChoice).toMatchObject({ operationId: "choice-run", databaseBytes: 8 * 1024 ** 3 });
    expect(state.noBackupConsentPrompt).toBe(false);
    expect(state.noBackupConsentChecked).toBe(false);
    expect(state.actionsDisabled).toBe(true);
    const tree = renderView(state);
    for (const label of ["Create database snapshot and upgrade", "Upgrade without database snapshot", "Cancel"]) expect(findActionButtonByLabel(tree, label)).toBeTruthy();
    expect(treeText(tree)).toContain("The gateway stays up while you choose");
    expect(treeText(tree)).toContain("8.00 GB");
    expect(treeText(tree)).not.toContain("Full backup");
  });

  it("snapshot choice retries the exact target, intent and latest claim and never silently proceeds after failure", async () => {
    let state = await requestChoice();
    api.applyOpenclawVersion.mockRejectedValueOnce(Object.assign(new Error("Snapshot disk full"), { code: "backup_failed" }));
    await state.onChooseDatabaseSnapshot();
    expect(api.applyOpenclawVersion).toHaveBeenLastCalledWith({ ...kSoftTarget, intent: "update", expectLatest: true, recoveryMode: "database_set" });
    state = renderHook({});
    expect(state.recoveryChoice).toBeNull();
    expect(state.applyError.message).toBe("Snapshot disk full");
    expect(state.noBackupConsentOffer).toBeNull();
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(2);
    expect(api.requestOpenclawBackupRiskConsent).not.toHaveBeenCalled();
    api.applyOpenclawVersion.mockResolvedValueOnce({ ok: true, noop: true });
    await state.onRetryBackup();
    expect(api.applyOpenclawVersion).toHaveBeenLastCalledWith({ ...kSoftTarget, intent: "update", expectLatest: true, recoveryMode: "database_set" });
  });

  it("forward-only choice requires the unchecked confirmation and preserves intent and latest claim with its single-use token", async () => {
    let state = await requestChoice();
    state.onRequestNoBackupConsent();
    state = renderHook({});
    await state.onConfirmNoBackupConsent();
    expect(api.requestOpenclawBackupRiskConsent).not.toHaveBeenCalled();
    state.onToggleNoBackupConsent(true);
    state = renderHook({});
    api.requestOpenclawBackupRiskConsent.mockResolvedValueOnce({ operationId: "choice-run", target: kSoftTarget, confirmNoBackupToken: "a".repeat(43) });
    api.applyOpenclawVersion.mockResolvedValueOnce({ ok: true, noop: true });
    await state.onConfirmNoBackupConsent();
    expect(api.applyOpenclawVersion).toHaveBeenLastCalledWith({ ...kSoftTarget, intent: "update", expectLatest: true, recoveryMode: "config_only", confirmNoBackup: true, confirmNoBackupToken: "a".repeat(43) });
    expect(JSON.stringify(renderHook({}).operation)).not.toContain("a".repeat(43));
  });

  it("cancelling the migration choice starts no snapshot or apply", async () => {
    const state = await requestChoice();
    state.onCancelRecoveryChoice();
    expect(renderHook({}).recoveryChoice).toBeNull();
    expect(renderHook({}).actionsDisabled).toBe(false);
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(1);
    expect(api.requestOpenclawBackupRiskConsent).not.toHaveBeenCalled();
    expect(api.cancelOpenclawRecoveryReview).not.toHaveBeenCalled();
  });

  it("held review cancellation waits for server success and blocks other choices while pending", async () => {
    let state = await requestChoice(Object.assign(choiceError(), { gatewayHeld: true }));
    let resolve;
    api.cancelOpenclawRecoveryReview.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const pending = state.onCancelRecoveryChoice();
    state = renderHook({});
    expect(state.cancellingRecoveryChoice).toBe(true);
    expect(state.recoveryChoice).toMatchObject({ operationId: "choice-run", gatewayHeld: true, requiresServerCancel: true });
    expect(api.cancelOpenclawRecoveryReview).toHaveBeenCalledExactlyOnceWith("choice-run");
    await state.onChooseDatabaseSnapshot();
    await state.onCancelRecoveryChoice();
    expect(api.applyOpenclawVersion).toHaveBeenCalledOnce();
    expect(api.cancelOpenclawRecoveryReview).toHaveBeenCalledOnce();
    resolve({ ok: true, operationId: "choice-run", resumed: true });
    await pending;
    state = renderHook({});
    expect(state.recoveryChoice).toBeNull();
    expect(state.cancellingRecoveryChoice).toBe(false);
  });

  it("failed cancellation leaves the gateway-held review actionable and retries only cancellation", async () => {
    let state = await requestChoice(Object.assign(choiceError(), { gatewayHeld: true }));
    api.cancelOpenclawRecoveryReview.mockRejectedValueOnce(Object.assign(new Error("Prior gateway could not resume"), { code: "gateway_relaunch_failed", hint: "The gateway remains held. Retry cancellation." }));
    await state.onCancelRecoveryChoice();
    state = renderHook({});
    expect(state.recoveryChoice.requiresServerCancel).toBe(true);
    expect(state.recoveryCancelError).toMatchObject({ code: "gateway_relaunch_failed" });
    const tree = renderView(state);
    expect(treeText(tree)).toContain("The gateway remains held");
    expect(findActionButtonByLabel(tree, "Retry cancellation")).toBeTruthy();
    api.cancelOpenclawRecoveryReview.mockResolvedValueOnce({ ok: true, operationId: "choice-run" });
    await state.onCancelRecoveryChoice();
    expect(renderHook({}).recoveryChoice).toBeNull();
    expect(api.applyOpenclawVersion).toHaveBeenCalledOnce();
  });

  it("reload resumes a durable stopped review from its matching run rather than the installed target", async () => {
    const run = { operationId: "choice-run", state: "failed", target: kSoftTarget, intent: "update", expectLatest: true, result: { ...choiceError(), gatewayHeld: true } };
    api.fetchOpenclawChannel.mockResolvedValue(makeChannelInfo({ gatewayHold: { reason: "recovery_review", operationId: "choice-run" }, lastUpdateRun: { operationId: "other", target: kDowngradeTarget } }));
    api.fetchOpenclawRuns.mockResolvedValue({ runs: [run] });
    await hydrate();
    harness.findEffect("restoredRecoveryReview.current")();
    const state = renderHook({});
    expect(state.recoveryChoice).toMatchObject({ operationId: "choice-run", requiresServerCancel: true, request: { payload: kSoftTarget, intent: "update", expectLatest: true } });
    expect(state.noBackupConsentOffer.target).toEqual(kSoftTarget);
    expect(state.noBackupConsentPrompt).toBe(false);
    expect(api.applyOpenclawVersion).not.toHaveBeenCalled();
    api.cancelOpenclawRecoveryReview.mockResolvedValueOnce({ ok: true, operationId: "choice-run" });
    await state.onCancelRecoveryChoice();
    expect(api.cancelOpenclawRecoveryReview).toHaveBeenCalledExactlyOnceWith("choice-run");
    renderHook({});
    harness.findEffect("restoredRecoveryReview.current")();
    expect(renderHook({}).recoveryChoice).toBeNull();
  });

  it("unknown compatibility never offers a generic waiver even with a stray eligibility flag", async () => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockRejectedValueOnce(Object.assign(new Error("Target schema is unknown"), { code: "db_preflight_failed", backupRiskEligible: true, operationId: "unknown", hint: "Choose a supported version" }));
    state.onRequestApply({ payload: kSoftTarget, label: "2026.7.2" });
    state = renderHook({});
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    state = renderHook({});
    expect(state.recoveryChoice).toBeNull();
    expect(state.noBackupConsentOffer).toBeNull();
    expect(state.applyError.hint).toBe("Choose a supported version");
  });

  it("streamed migration choices preserve the original exact request", async () => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockResolvedValueOnce({ ok: true, operationId: "choice-run", events: "/events" });
    state.onRequestApply({ payload: kSoftTarget, label: "2026.7.2", intent: "update", expectLatest: true });
    state = renderHook({});
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    api.subscribeOpenclawApplyEvents.mock.calls.at(-1)[0].onMessage({ event: "error", data: { ...choiceError(), error: "Database migration required" } });
    state = renderHook({});
    expect(state.recoveryChoice.request).toMatchObject({ payload: kSoftTarget, intent: "update", expectLatest: true });
    expect(state.noBackupConsentOffer).toMatchObject({ operationId: "choice-run", intent: "update", expectLatest: true });
  });

  it("resumed migration choices retain the persisted exact intent and latest claim", async () => {
    const run = { operationId: "choice-run", state: "running", target: kSoftTarget, intent: "update", expectLatest: true, startedAt: kNow - 60000, steps: [] };
    api.fetchOpenclawRuns.mockResolvedValue({ runs: [run] });
    await hydrate();
    harness.findEffect("resumeLedgerOperation")();
    renderHook({});
    api.fetchOpenclawRun.mockResolvedValue({ run: { ...run, state: "failed", finishedAt: kNow, ok: false, result: { ...choiceError(), message: "Migration required" } } });
    vi.useFakeTimers();
    vi.setSystemTime(kNow);
    let stopPoll;
    try {
      stopPoll = harness.findEffect("read.refresh().catch")();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      stopPoll?.();
      vi.useRealTimers();
    }
    await flushAsync();
    renderHook({});
    harness.findEffect("terminalKey")();
    await flushAsync();
    const state = renderHook({});
    expect(state.recoveryChoice.request).toMatchObject({ payload: kSoftTarget, intent: "update", expectLatest: true });
    api.applyOpenclawVersion.mockResolvedValueOnce({ ok: true, noop: true });
    await state.onChooseDatabaseSnapshot();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({ ...kSoftTarget, intent: "update", expectLatest: true, recoveryMode: "database_set" });
  });

  it("fresh configuration checkpoints never inherit legacy archive consent", async () => {
    setCached(kBackupsCacheKey, makeInventory());

    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toBeNull();
    expect(state.onToggleBackupReuseConsent).toBeUndefined();
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValue({ ok: true, noop: true });
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({ ...kDowngradeTarget, intent: "downgrade", recoveryMode: "config_only" });
    expect(api.applyOpenclawVersion.mock.calls.at(-1)[0]).not.toHaveProperty("allowBackupReuse");
  });

  it("an unchecked consent (or no eligible archive) sends no allowBackupReuse at all", async () => {
    setCached(kBackupsCacheKey, makeInventory());
    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValue({ ok: true, operationId: "op-1", events: "/e" });
    await state.onConfirmApply(); await renderHook({}).backupPreflight.confirm();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({ recoveryMode: "config_only", ...kDowngradeTarget, intent: "downgrade" });
    expect("allowBackupReuse" in api.applyOpenclawVersion.mock.calls[0][0]).toBe(false);

    // Checked but nothing eligible: still no consent field.
    harness.reset();
    invalidateCache(kBackupsCacheKey);
    setCached(kBackupsCacheKey, makeInventory([]));
    api.applyOpenclawVersion.mockClear();
    state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.onToggleBackupReuseConsent).toBeUndefined();
    state = renderHook({});
    await state.onConfirmApply(); await renderHook({}).backupPreflight.confirm();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({ recoveryMode: "config_only", ...kDowngradeTarget, intent: "downgrade" });
  });

  it("a legacy quick failure never offers retired archive reuse", async () => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockRejectedValueOnce(Object.assign(new Error("Legacy backup failed"), { code: "backup_failed", reusableBackup: kReusableBackup }));
    requestDowngrade(state);
    state = renderHook({});
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();

    state = renderHook({});
    expect(state.backupReuseOffer).toBeUndefined();
    expect(state.onRequestBackupReuseRetry).toBeUndefined();
    expect(findActionButtonByLabel(renderView(state), "Retry using the backup taken 2 hours ago")).toBeUndefined();
    expect(state.applyError.message).toBe("Legacy backup failed"); state.onDismissApplyError(); expect(renderHook({}).applyError).toBeNull();
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(1);
  });

  it("a quick 409 backup_required_for_migration offers the no-backup consent; the confirm is inert until checked, then resends the bare target with confirmNoBackup: true only (#79 (b))", async () => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockRejectedValueOnce(
      Object.assign(new Error(kMigrationError.message), kMigrationError),
    );
    state.onRequestApply({ payload: kSoftTarget, label: "2026.7.2", isDowngrade: false });
    state = renderHook({});
    // A routine same-channel confirm: no reuse consent line at all.
    expect(state.pendingApply.confirm.hardGate).toBe(false);
    expect(state.pendingApply.confirm.backupReuse).toBeNull();
    await state.onConfirmApply(); await renderHook({}).backupPreflight.confirm();
    state = renderHook({});

    expect(state.operation).toBeNull();
    expect(state.applyError).toEqual(
      expect.objectContaining({ code: "backup_required_for_migration", hint: kMigrationError.hint }),
    );
    // The overridable code offers the no-backup consent, never the reuse offer.
    expect(state.backupReuseOffer).toBeUndefined();
    expect(state.noBackupConsentOffer).toEqual(
      expect.objectContaining({
        code: "backup_required_for_migration",
        message: kMigrationError.message,
        target: kSoftTarget,
        label: "2026.7.2",
      }),
    );
    expect(state.noBackupConsentPrompt).toBe(false);
    expect(state.noBackupConsentChecked).toBe(false);

    // The CTA only opens the dialog, checkbox OFF.
    state.onRequestNoBackupConsent();
    state = renderHook({});
    expect(state.noBackupConsentPrompt).toBe(true);
    expect(state.noBackupConsentChecked).toBe(false);
    // Unchecked: the confirm does nothing.
    await state.onConfirmNoBackupConsent();
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(1);
    state = renderHook({});
    expect(state.noBackupConsentPrompt).toBe(true);

    state.onToggleNoBackupConsent(true);
    state = renderHook({});
    expect(state.noBackupConsentChecked).toBe(true);
    api.applyOpenclawVersion.mockResolvedValueOnce({
      ok: true,
      operationId: "op-3",
      events: "/api/operations/op-3/events",
    });
    api.requestOpenclawBackupRiskConsent.mockResolvedValueOnce({
      ok: true, operationId: kMigrationError.operationId, target: kSoftTarget,
      confirmNoBackupToken: "t".repeat(43), expiresAt: new Date(Date.now() + 600000).toISOString(),
    });
    await state.onConfirmNoBackupConsent();
    expect(api.requestOpenclawBackupRiskConsent).toHaveBeenCalledWith(kMigrationError.operationId);
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(2);
    expect(api.applyOpenclawVersion).toHaveBeenLastCalledWith({ recoveryMode: "config_only",
      channel: "stable",
      version: "2026.7.2",
      intent: "update",
      confirmNoBackup: true,
      confirmNoBackupToken: "t".repeat(43),
    });
    expect("allowBackupReuse" in api.applyOpenclawVersion.mock.calls[1][0]).toBe(false);
    state = renderHook({});
    expect(state.noBackupConsentOffer).toBeNull();
    expect(state.noBackupConsentPrompt).toBe(false);
    expect(state.noBackupConsentChecked).toBe(false);
    expect(state.applyError).toBeNull();
    // The recorded operation target stays the BARE payload — a later
    // "Re-stage version" never inherits this attempt's consent.
    expect(state.operation).toEqual(
      expect.objectContaining({ phase: "running", operationId: "op-3", target: kSoftTarget }),
    );
  });

  it.each(["onCancelNoBackupConsent", "onDismissApplyError"])("%s retires an in-flight token response and double submission cannot dispatch", async (cancelAction) => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockRejectedValueOnce(Object.assign(new Error(kMigrationError.message), kMigrationError));
    state.onRequestApply({ payload: kSoftTarget, label: "2026.7.2" });
    state = renderHook({});
    await state.onConfirmApply(); await renderHook({}).backupPreflight.confirm();
    state = renderHook({});
    state.onRequestNoBackupConsent();
    state = renderHook({});
    state.onToggleNoBackupConsent(true);
    state = renderHook({});
    let resolveConsent;
    api.requestOpenclawBackupRiskConsent.mockImplementationOnce(() => new Promise((resolve) => { resolveConsent = resolve; }));
    const confirm = state.onConfirmNoBackupConsent();
    await state.onConfirmNoBackupConsent();
    expect(api.requestOpenclawBackupRiskConsent).toHaveBeenCalledTimes(1);
    state[cancelAction]();
    resolveConsent({ operationId: kMigrationError.operationId, target: kSoftTarget, confirmNoBackupToken: "t".repeat(43) });
    await confirm;
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(1);
    state = renderHook({});
    expect(state.noBackupConsentPrompt).toBe(false);
    expect(state.noBackupConsentStarting).toBe(false);
    expect(state.noBackupConsentChecked).toBe(false);
  });

  it("cancelling the no-backup dialog or dismissing the error retires the checkbox and the offer without calling the API; a 409 backup_failed never offers the consent", async () => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockRejectedValueOnce(
      Object.assign(new Error(kMigrationError.message), kMigrationError),
    );
    state.onRequestApply({ payload: kSoftTarget, label: "2026.7.2", isDowngrade: false });
    state = renderHook({});
    await state.onConfirmApply(); await renderHook({}).backupPreflight.confirm();
    state = renderHook({});
    state.onRequestNoBackupConsent();
    state = renderHook({});
    state.onToggleNoBackupConsent(true);
    state = renderHook({});
    expect(state.noBackupConsentChecked).toBe(true);

    state.onCancelNoBackupConsent();
    state = renderHook({});
    expect(state.noBackupConsentPrompt).toBe(false);
    expect(state.noBackupConsentChecked).toBe(false);
    // The offer survives a cancel (the CTA can be reopened)…
    expect(state.noBackupConsentOffer).toBeTruthy();
    // …but reopening starts unchecked again — never remembered.
    state.onRequestNoBackupConsent();
    state = renderHook({});
    expect(state.noBackupConsentChecked).toBe(false);

    state.onDismissApplyError();
    state = renderHook({});
    expect(state.applyError).toBeNull();
    expect(state.noBackupConsentOffer).toBeNull();
    expect(state.noBackupConsentPrompt).toBe(false);
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(1);

    // backup_failed (hard gate, not overridable): no consent offer.
    api.applyOpenclawVersion.mockRejectedValueOnce(
      Object.assign(new Error("Backup failed"), {
        code: "backup_failed",
        reusableBackup: kReusableBackup,
      }),
    );
    requestDowngrade(state);
    state = renderHook({});
    await state.onConfirmApply(); await renderHook({}).backupPreflight.confirm();
    state = renderHook({});
    expect(state.backupReuseOffer).toBeUndefined();
    expect(state.noBackupConsentOffer).toBeNull();
  });

  it("dismissing a legacy quick failure clears it without retrying retired archive reuse", async () => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockRejectedValueOnce(Object.assign(new Error("Legacy backup failed"), { code: "backup_failed", reusableBackup: kReusableBackup }));
    requestDowngrade(state);
    state = renderHook({});
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();

    state = renderHook({});
    expect(state.backupReuseOffer).toBeUndefined();
    expect(state.onRequestBackupReuseRetry).toBeUndefined();
    expect(findActionButtonByLabel(renderView(state), "Retry using the backup taken 2 hours ago")).toBeUndefined();
    expect(state.applyError.message).toBe("Legacy backup failed"); state.onDismissApplyError(); expect(renderHook({}).applyError).toBeNull();
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(1);
  });

  it("R5: useBackupsInventory reads cache-friendly on mount and forces the server on refreshBackups", async () => {
    harness.beginRender();
    let state = useBackupsInventory();
    // The hook declares subscription + mount read. Mount both, then drive
    // mutation refreshes against that same subscribed consumer.
    harness.runEffect(0);
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
    await state.onConfirmApply(); await renderHook({}).backupPreflight.confirm();
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

  it("a refreshed historical inventory does not add archive consent to the open checkpoint confirm", async () => {
    setCached(kBackupsCacheKey, makeInventory());

    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toBeNull();
    expect(state.onToggleBackupReuseConsent).toBeUndefined();
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValue({ ok: true, noop: true });
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({ ...kDowngradeTarget, intent: "downgrade", recoveryMode: "config_only" });
    expect(api.applyOpenclawVersion.mock.calls.at(-1)[0]).not.toHaveProperty("allowBackupReuse");
  });

  it("stale checked archive consent is never sent when the historical digest changes", async () => {
    setCached(kBackupsCacheKey, makeInventory([makeEntry({ sha256: "b".repeat(64) })]));

    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toBeNull();
    expect(state.onToggleBackupReuseConsent).toBeUndefined();
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValue({ ok: true, noop: true });
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({ ...kDowngradeTarget, intent: "downgrade", recoveryMode: "config_only" });
    expect(api.applyOpenclawVersion.mock.calls.at(-1)[0]).not.toHaveProperty("allowBackupReuse");
  });

  it("toggling a retired archive consent callback cannot authorize reuse", async () => {
    setCached(kBackupsCacheKey, makeInventory());

    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toBeNull();
    expect(state.onToggleBackupReuseConsent).toBeUndefined();
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValue({ ok: true, noop: true });
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({ ...kDowngradeTarget, intent: "downgrade", recoveryMode: "config_only" });
    expect(api.applyOpenclawVersion.mock.calls.at(-1)[0]).not.toHaveProperty("allowBackupReuse");
  });

  it("a missing historical archive cannot become a fallback for the config checkpoint", async () => {
    setCached(kBackupsCacheKey, makeInventory([]));

    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toBeNull();
    expect(state.onToggleBackupReuseConsent).toBeUndefined();
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValue({ ok: true, noop: true });
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({ ...kDowngradeTarget, intent: "downgrade", recoveryMode: "config_only" });
    expect(api.applyOpenclawVersion.mock.calls.at(-1)[0]).not.toHaveProperty("allowBackupReuse");
  });

  it("old historical archives do not alter checkpoint requests", async () => {
    setCached(kBackupsCacheKey, makeInventory([makeEntry({ at: kNow - 48 * 3_600_000 })]));

    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toBeNull();
    expect(state.onToggleBackupReuseConsent).toBeUndefined();
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValue({ ok: true, noop: true });
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({ ...kDowngradeTarget, intent: "downgrade", recoveryMode: "config_only" });
    expect(api.applyOpenclawVersion.mock.calls.at(-1)[0]).not.toHaveProperty("allowBackupReuse");
  });

  it("legacy reuse windows do not alter checkpoint requests", async () => {
    setCached(kBackupsCacheKey, makeInventory(undefined, { reuseAfter: kNow }));

    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toBeNull();
    expect(state.onToggleBackupReuseConsent).toBeUndefined();
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValue({ ok: true, noop: true });
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({ ...kDowngradeTarget, intent: "downgrade", recoveryMode: "config_only" });
    expect(api.applyOpenclawVersion.mock.calls.at(-1)[0]).not.toHaveProperty("allowBackupReuse");
  });

  it("a backup_failed WITHOUT an offer, or a different code, yields no offer", async () => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockRejectedValueOnce(
      Object.assign(new Error("disk full"), { code: "backup_failed" }),
    );
    requestDowngrade(state);
    state = renderHook({});
    await state.onConfirmApply(); await renderHook({}).backupPreflight.confirm();
    state = renderHook({});
    expect(state.applyError.message).toBe("disk full");
    expect(state.backupReuseOffer).toBeUndefined();
  });

  it("a legacy streamed failure never offers retired archive reuse", async () => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockResolvedValueOnce({ ok: true, operationId: "legacy-run", events: "/events" });
    requestDowngrade(state);
    state = renderHook({});
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    api.subscribeOpenclawApplyEvents.mock.calls.at(-1)[0].onMessage({ event: "error", data: { code: "backup_failed", error: "Legacy backup failed", reusableBackup: kReusableBackup } });
    state = renderHook({});
    expect(state.backupReuseOffer).toBeUndefined();
    expect(state.onRequestBackupReuseRetry).toBeUndefined();
    expect(findActionButtonByLabel(renderView(state), "Retry using the backup taken 2 hours ago")).toBeUndefined();
    expect(state.operation.error.message).toBe("Legacy backup failed"); state.onDismissOperation(); expect(renderHook({}).operation).toBeNull();
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(1);
  });

  it("a resumed legacy failed run retains its error but never offers archive reuse", async () => {
    // Mount with an unfinished persisted run: the rehydration effect resumes
    // it with NO SSE stream, so the outcome can only arrive through the resume
    // poll's lastUpdateRun.result — which the server stamps with the same
    // reusableBackup offer as the 409 body (retry e2e: "must also reach the
    // resume poll"). Neither the quick-result nor the streamed path exercises
    // this branch; a reload mid-update is exactly when an operator needs it.
    const persistedRun = {
      operationId: "op-7",
      state: "running",
      target: kDowngradeTarget,
      startedAt: kNow - 60_000,
      finishedAt: null,
      ok: null,
      steps: [{ name: "backup", status: "running", at: kNow - 50_000 }],
    };
    api.fetchOpenclawRuns.mockResolvedValue({ runs: [persistedRun] });
    let state = await hydrate();
    // Effect #1 in declaration order is the rehydration effect.
    harness.findEffect("resumeLedgerOperation")();
    state = renderHook({});
    expect(state.operation).toEqual(
      expect.objectContaining({ resumed: true, phase: "running", operationId: "op-7" }),
    );
    expect(api.subscribeOpenclawApplyEvents).not.toHaveBeenCalled();

    // The next poll sees the run settled: failed at the backup, with the offer
    // on the persisted result envelope.
    api.fetchOpenclawRun.mockResolvedValue({
        run: {
          ...persistedRun,
          state: "failed",
          finishedAt: kNow,
          ok: false,
          steps: [{ name: "backup", status: "failed", at: kNow, error: "state lease lost" }],
          result: {
            ok: false,
            code: "backup_failed",
            message: "Backup failed: state lease lost (after 3 attempts, 2 with the gateway paused)",
            hint: "Newest surviving archive: …",
            reusableBackup: kReusableBackup,
          },
        },
    });
    api.fetchOpenclawRun.mockClear();
    expect(api.fetchOpenclawBackups).not.toHaveBeenCalled();
    vi.useFakeTimers();
    // Pin the faked clock to the fixture epoch: fake timers start at the REAL
    // now by default, and the hook's Date.now()-based 24 h reuse window aged
    // the kNow-relative archives out of eligibility once the wall clock passed
    // 2026-09-03 (a time bomb, not a product change).
    vi.setSystemTime(kNow);
    let stopPoll = null;
    try {
      // Effect #6 is the resume poll: the four page effects (mount load,
      // rehydration, tick, shell publish) and the inventory hook's two
      // effects precede it. It arms a 3 s timer, then reads the channel.
      stopPoll = harness.findEffect("read.refresh().catch")();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.fetchOpenclawRun).toHaveBeenCalledWith("op-7", expect.any(Object));
    } finally {
      if (typeof stopPoll === "function") stopPoll();
      vi.useRealTimers();
    }
    await flushAsync();

    state = renderHook({});
    harness.findEffect("terminalKey")();
    await flushAsync();
    state = renderHook({});
    expect(state.operation).toEqual(
      expect.objectContaining({ resumed: true, phase: "failed", finishedAt: kNow }),
    );
    expect(state.operation.error).toEqual(
      expect.objectContaining({
        code: "backup_failed",
        hint: "Newest surviving archive: …",
      }),
    );
    expect(state.backupReuseOffer).toBeUndefined();
    expect(state.onRequestBackupReuseRetry).toBeUndefined();
    expect(api.fetchOpenclawBackups).toHaveBeenCalledWith({ force: true });
    expect(findActionButtonByLabel(renderView(state), "Retry using the backup taken 2 hours ago")).toBeUndefined();
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
    await state.onConfirmApply(); await renderHook({}).backupPreflight.confirm();
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
    expect(findActionButtonByLabel(failedCard, "Retry using the backup taken 2 hours ago")).toBeUndefined();

    // Run repair is rejected before an operationId exists (busy / 5xx).
    api.runOpenclawRepair.mockRejectedValueOnce(
      Object.assign(new Error("Another operation is in progress"), { code: "busy", status: 409 }),
    );
    expect(state.onRequestBackupReuseRetry).toBeUndefined();
    state = renderHook({});
    expect(state.backupReuseRetryPrompt).toBeUndefined();
    await state.onRunRepair();
    state = renderHook({});
    expect(state.operation).toBeNull();
    expect(state.applyError.message).toBe("Another operation is in progress");
    expect(state.backupReuseOffer).toBeUndefined();
    expect(state.backupReuseRetryPrompt).toBeUndefined();
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

  it("historical inventory errors do not authorize a checkpoint fallback", async () => {
    setCached(kBackupsCacheKey, makeInventory());
    api.fetchOpenclawBackups.mockRejectedValue(new Error("inventory offline"));
    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toBeNull();
    expect(state.onToggleBackupReuseConsent).toBeUndefined();
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValue({ ok: true, noop: true });
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({ ...kDowngradeTarget, intent: "downgrade", recoveryMode: "config_only" });
    expect(api.applyOpenclawVersion.mock.calls.at(-1)[0]).not.toHaveProperty("allowBackupReuse");
  });

  it("unreadable historical inventories do not authorize a checkpoint fallback", async () => {
    setCached(kBackupsCacheKey, makeInventory([], { readable: false }));

    let state = await hydrate();
    requestDowngrade(state);
    state = renderHook({});
    expect(state.pendingApply.confirm.backupReuse).toBeNull();
    expect(state.onToggleBackupReuseConsent).toBeUndefined();
    state = renderHook({});
    api.applyOpenclawVersion.mockResolvedValue({ ok: true, noop: true });
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({ ...kDowngradeTarget, intent: "downgrade", recoveryMode: "config_only" });
    expect(api.applyOpenclawVersion.mock.calls.at(-1)[0]).not.toHaveProperty("allowBackupReuse");
  });

  it("dismissing a legacy streamed failure clears it without retrying retired archive reuse", async () => {
    let state = await hydrate();
    api.applyOpenclawVersion.mockResolvedValueOnce({ ok: true, operationId: "legacy-run", events: "/events" });
    requestDowngrade(state);
    state = renderHook({});
    await state.onConfirmApply();
    await renderHook({}).backupPreflight.confirm();
    api.subscribeOpenclawApplyEvents.mock.calls.at(-1)[0].onMessage({ event: "error", data: { code: "backup_failed", error: "Legacy backup failed", reusableBackup: kReusableBackup } });
    state = renderHook({});
    expect(state.backupReuseOffer).toBeUndefined();
    expect(state.onRequestBackupReuseRetry).toBeUndefined();
    expect(findActionButtonByLabel(renderView(state), "Retry using the backup taken 2 hours ago")).toBeUndefined();
    expect(state.operation.error.message).toBe("Legacy backup failed"); state.onDismissOperation(); expect(renderHook({}).operation).toBeNull();
    expect(api.applyOpenclawVersion).toHaveBeenCalledTimes(1);
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

  it("the rollback fence retains verified recovery coverage for the confirmation dialog", async () => {
    const recovery = { kind: "database_set", checkpoint: { file: "/backups/recovery-op", verified: true }, databases: { complete: true, verified: true }, restore: { configAvailable: true, databaseSetAvailable: true } };
    api.rollbackOpenclaw.mockRejectedValueOnce(Object.assign(new Error("migrated"), { code: "rollback_requires_confirmation", backupFile: recovery.checkpoint.file, backupFileExists: true, recovery }));
    let state = await hydrate();
    state.onRequestRollback();
    await renderHook({}).onRollback();
    state = renderHook({});
    expect(state.rollbackDataRisk).toMatchObject({ recovery, backupFile: recovery.checkpoint.file, backupFileExists: true });
    expect(treeText(renderView(state))).toContain("matching source build");
    expect(treeText(renderView(state))).toContain("does not restore database data automatically");
  });
});
