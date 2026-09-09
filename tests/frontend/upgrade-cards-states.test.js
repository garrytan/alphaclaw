import { describe, expect, it, vi } from "vitest";
import { UpgradeStatusCard } from "../../lib/public/js/components/upgrade-tab/status-card.js";
import { UpgradeProgressCard } from "../../lib/public/js/components/upgrade-tab/progress-card.js";
import { UpgradeCatalogCard } from "../../lib/public/js/components/upgrade-tab/catalog-card.js";
import { UpgradeBackupsCard } from "../../lib/public/js/components/upgrade-tab/backups-card.js";
import { SegmentedControl } from "../../lib/public/js/components/segmented-control.js";

// Stateless components: invoke them directly and walk the vnode tree
// (saved-toggle-component.test.js pattern) — no DOM renderer needed.
const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function") {
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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

describe("frontend/upgrade-tab status-card loading frame", () => {
  it("renders the frame with disabled channel options instead of blanking while loading", () => {
    expect(UpgradeStatusCard({ model: null, loadingChannel: false })).toBe(null);

    const tree = expandTree(
      UpgradeStatusCard({ model: null, loadingChannel: true, activeChannel: "stable" }),
    );
    const controls = findAllByType(tree, SegmentedControl);
    expect(controls.length).toBe(1);
    expect(controls[0].props.disabled).toBe(true);
    const text = collectText(tree).join(" ");
    expect(text).toContain("Release channel");
    expect(text).toContain("Loading version info...");
  });
});

describe("frontend/upgrade-tab progress-card failure affordances", () => {
  const failedOperation = {
    phase: "failed",
    label: "2026.8.1",
    steps: [],
    startedAt: 0,
    finishedAt: 60_000,
    error: { message: "npm run build failed" },
  };

  it("offers Dismiss (wired to onDismissOperation) with the re-enable hint on failure", () => {
    const onDismissOperation = vi.fn();
    const tree = expandTree(
      UpgradeProgressCard({ operation: failedOperation, nowMs: 60_000, onDismissOperation }),
    );
    const dismiss = collectNodes(tree).find(
      (vnode) =>
        vnode.type === "button" &&
        collectText(vnode.props.children).join("").includes("Dismiss"),
    );
    expect(dismiss).toBeTruthy();
    dismiss.props.onclick();
    expect(onDismissOperation).toHaveBeenCalledTimes(1);
    const text = collectText(tree).join(" ");
    expect(text).toContain("Update to 2026.8.1 failed");
    expect(text).toContain("Dismiss to re-enable updates");
    expect(text).toContain("npm run build failed");

    // Still-running operations get no Dismiss affordance.
    const running = expandTree(
      UpgradeProgressCard({
        operation: { phase: "applying", label: "2026.8.1", steps: [], startedAt: 0 },
        nowMs: 1_000,
      }),
    );
    const runningDismiss = collectNodes(running).find(
      (vnode) =>
        vnode.type === "button" &&
        collectText(vnode.props.children).join("").includes("Dismiss"),
    );
    expect(runningDismiss).toBeUndefined();
    expect(collectText(running).join(" ")).not.toContain("Dismiss to re-enable");
  });
});

describe("frontend/upgrade-tab catalog-card refresh failure", () => {
  it("keeps stale data with a refresh warning instead of replacing it with the error panel", () => {
    const catalog = { stable: [], beta: [], dev: null, staleAsOf: 0 };
    const tree = expandTree(
      UpgradeCatalogCard({
        catalog,
        catalogError: new Error("registry unreachable"),
        nowMs: 1_000,
      }),
    );
    const text = collectText(tree).join(" ");
    expect(text).toContain("Could not refresh the catalog");
    expect(text).toContain("registry unreachable");
    // The hard-error panel (status-error paragraph) is reserved for no-data.
    const errorParagraphs = collectNodes(tree).filter(
      (vnode) =>
        vnode.type === "p" &&
        String(vnode.props.class || "").includes("text-status-error") &&
        !String(vnode.props.class || "").includes("warning"),
    );
    expect(errorParagraphs.length).toBe(0);

    const noData = expandTree(
      UpgradeCatalogCard({ catalog: null, catalogError: new Error("registry unreachable") }),
    );
    const noDataText = collectText(noData).join(" ");
    expect(noDataText).toContain("registry unreachable");
    expect(noDataText).not.toContain("Could not refresh the catalog");
  });
});

describe("frontend/upgrade-tab catalog-card Check now availability (v0.9.81, RC1a)", () => {
  const findCheckNow = (tree) =>
    collectNodes(tree).find((vnode) => vnode?.props?.idleLabel === "Check now");

  it("is never gated by actionsDisabled — only by an in-flight refresh", () => {
    const catalog = { stable: [], beta: [], dev: null, staleAsOf: 0 };
    const onCheckNow = vi.fn();
    const disabledPage = findCheckNow(
      expandTree(UpgradeCatalogCard({ catalog, actionsDisabled: true, onCheckNow, nowMs: 1_000 })),
    );
    expect(disabledPage).toBeTruthy();
    expect(disabledPage.props.disabled).toBe(false);
    expect(disabledPage.props.loading).toBe(false);

    const refreshing = findCheckNow(
      expandTree(
        UpgradeCatalogCard({
          catalog,
          actionsDisabled: true,
          refreshingCatalog: true,
          onCheckNow,
          nowMs: 1_000,
        }),
      ),
    );
    expect(refreshing.props.disabled).toBe(true);
    expect(refreshing.props.loading).toBe(true);
  });
});

// v0.9.81 (C3/C4): Back up now on the Backups card; the right CTA on a
// failed or completed operation card.
describe("frontend/upgrade-tab backups-card Back up now (v0.9.81)", () => {
  const findButton = (tree, label) =>
    collectNodes(tree).find((vnode) => vnode?.props?.idleLabel === label);
  const inventory = { readable: true, entries: [], truncated: false };

  it("renders the button wired to onBackupNow, disabled by the page-wide flag, loading while the request starts", () => {
    const onBackupNow = vi.fn();
    const live = findButton(expandTree(UpgradeBackupsCard({ inventory, onBackupNow, nowMs: 1_000 })), "Back up now");
    expect(live).toBeTruthy();
    expect(live.props.disabled).toBe(false);
    live.props.onClick();
    expect(onBackupNow).toHaveBeenCalledTimes(1);
    const disabled = findButton(
      expandTree(UpgradeBackupsCard({ inventory, onBackupNow, backupNowDisabled: true, nowMs: 1_000 })),
      "Back up now",
    );
    expect(disabled.props.disabled).toBe(true);
    const starting = findButton(
      expandTree(UpgradeBackupsCard({ inventory, onBackupNow, backupNowStarting: true, nowMs: 1_000 })),
      "Back up now",
    );
    expect(starting.props.loading).toBe(true);
    const text = collectText(expandTree(UpgradeBackupsCard({ inventory, nowMs: 1_000 }))).join(" ");
    expect(text).toContain("Pauses the gateway for the copy");
    expect(text).toContain("Back up now takes one on demand");
  });

  it("shows the ledger-derived 'Last manual backup' line in its tone, and nothing when no manual backup ever ran", () => {
    const ok = collectText(
      expandTree(
        UpgradeBackupsCard({
          inventory,
          nowMs: 1_000,
          lastManualBackup: { state: "completed", tone: "success", text: "Last manual backup: 3 minutes ago — verified" },
        }),
      ),
    ).join(" ");
    expect(ok).toContain("Last manual backup: 3 minutes ago — verified");
    const failed = expandTree(
      UpgradeBackupsCard({
        inventory,
        nowMs: 1_000,
        lastManualBackup: { state: "failed", tone: "danger", text: "Last manual backup: 1 hour ago — failed: no space" },
      }),
    );
    const line = collectNodes(failed).find((vnode) => vnode?.props?.["data-testid"] === "last-manual-backup");
    expect(String(line.props.class)).toContain("text-status-error-muted");
    expect(collectText(expandTree(UpgradeBackupsCard({ inventory, nowMs: 1_000 }))).join(" ")).not.toContain("Last manual backup");
  });
});

describe("frontend/upgrade-tab progress-card recovery CTAs (v0.9.81, C4)", () => {
  const findButton = (tree, label) =>
    collectNodes(tree).find((vnode) => vnode?.props?.idleLabel === label);
  const base = { steps: [], startedAt: 0, finishedAt: 60_000, output: "", lastOutputAt: null };

  it("a backup-class apply failure offers Retry backup (never Re-stage) with the honest hint; an install-class failure keeps Re-stage", () => {
    const onRetryBackup = vi.fn();
    const onRetryApply = vi.fn();
    const backupFailed = expandTree(
      UpgradeProgressCard({
        operation: {
          ...base,
          phase: "failed",
          label: "2026.9.3",
          target: { channel: "stable", version: "2026.9.3" },
          intent: "update",
          error: { message: "The pre-update backup failed", code: "backup_failed" },
        },
        nowMs: 60_000,
        onRetryBackup,
        onRetryApply,
      }),
    );
    const retry = findButton(backupFailed, "Retry backup");
    expect(retry).toBeTruthy();
    retry.props.onClick();
    expect(onRetryBackup).toHaveBeenCalledTimes(1);
    expect(findButton(backupFailed, "Re-stage version")).toBeUndefined();
    const text = collectText(backupFailed).join(" ");
    expect(text).toContain("Re-staging the version would not help");
    expect(text).not.toContain("Re-staging downloads and installs");

    const installFailed = expandTree(
      UpgradeProgressCard({
        operation: {
          ...base,
          phase: "failed",
          label: "2026.9.3",
          target: { channel: "stable", version: "2026.9.3" },
          error: { message: "verify failed", code: "verify_failed" },
        },
        nowMs: 60_000,
        onRetryApply,
      }),
    );
    expect(findButton(installFailed, "Re-stage version")).toBeTruthy();
    expect(findButton(installFailed, "Retry backup")).toBeUndefined();
    expect(collectText(installFailed).join(" ")).toContain("Re-staging downloads and installs");
  });

  it("a failed standalone backup is headed 'Backup failed' and offers Retry backup; a completed one names the archive and offers 'Retry update to X' only when it repaired a failed update", () => {
    const onRetryUpdate = vi.fn();
    const onDismissOperation = vi.fn();
    const failed = expandTree(
      UpgradeProgressCard({
        operation: {
          ...base,
          phase: "failed",
          label: "manual backup",
          target: { kind: "backup" },
          error: { message: "The backup CLI made no progress for 3 minutes", code: "backup_failed" },
        },
        nowMs: 60_000,
      }),
    );
    const failedText = collectText(failed).join(" ");
    expect(failedText).toContain("Backup failed");
    expect(findButton(failed, "Retry backup")).toBeTruthy();
    expect(findButton(failed, "Re-stage version")).toBeUndefined();
    // Backup-specific dismiss hint and empty-step fallback — never "retry from
    // the catalog or roll back" / "Starting update..." on a backup card.
    expect(failedText).toContain("then retry the backup");
    expect(failedText).not.toContain("roll back below");
    const running = collectText(
      expandTree(UpgradeProgressCard({ operation: { ...base, finishedAt: undefined, phase: "running", label: "manual backup", target: { kind: "backup" } }, nowMs: 60_000 })),
    ).join(" ");
    expect(running).toContain("Starting backup...");
    expect(running).not.toContain("Starting update...");

    const completedRepair = expandTree(
      UpgradeProgressCard({
        operation: {
          ...base,
          phase: "completed",
          label: "manual backup",
          target: { kind: "backup" },
          result: { ok: true, archive: { file: "/data/backups/openclaw/openclaw-2026-09-09.alphaclaw.tar.gz", verified: true } },
          retryUpdate: { payload: { channel: "stable", version: "2026.9.3" }, label: "2026.9.3", intent: "update" },
        },
        nowMs: 60_000,
        onRetryUpdate,
        onDismissOperation,
      }),
    );
    const text = collectText(completedRepair).join(" ");
    expect(text).toContain("Backup completed");
    expect(text).toContain("Archive written: openclaw-2026-09-09.alphaclaw.tar.gz — verified");
    const retryUpdate = findButton(completedRepair, "Retry update to 2026.9.3");
    expect(retryUpdate).toBeTruthy();
    retryUpdate.props.onClick();
    expect(onRetryUpdate).toHaveBeenCalledTimes(1);
    expect(collectNodes(completedRepair).some((vnode) => vnode.type === "button" && collectText(vnode.props.children).join("").includes("Dismiss"))).toBe(true);

    const completedPlain = expandTree(
      UpgradeProgressCard({
        operation: {
          ...base,
          phase: "completed",
          label: "manual backup",
          target: { kind: "backup" },
          result: { ok: true, noBackup: true },
        },
        nowMs: 60_000,
      }),
    );
    expect(collectText(completedPlain).join(" ")).toContain("Nothing to back up yet");
    expect(collectNodes(completedPlain).some((vnode) => /Retry update/.test(String(vnode?.props?.idleLabel || "")))).toBe(false);
  });
});
