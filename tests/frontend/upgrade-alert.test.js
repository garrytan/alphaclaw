import { beforeEach, describe, expect, it, vi } from "vitest";

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
      harness.slots[index] = typeof initialValue === "function" ? initialValue() : initialValue;
    }
    const setState = (next) => {
      harness.slots[index] = typeof next === "function" ? next(harness.slots[index]) : next;
    };
    return [harness.slots[index], setState];
  };
  const useRef = (initialValue = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initialValue };
    return harness.slots[index];
  };
  const useEffect = (effect) => harness.effects.push(effect);
  return { useState, useRef, useMemo: (f) => f(), useCallback: (fn) => fn, useEffect, __harness: harness };
});

const cachedData = { current: null };
vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: () => ({ data: cachedData.current, error: null, refresh: vi.fn(async () => cachedData.current) }),
}));
vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchUpgradeStatus: vi.fn(),
  dismissUpgradeNotice: vi.fn(async () => ({ ok: true })),
  createOpenclawBackup: vi.fn(async () => ({ ok: true })),
  fetchSnapshotProposal: vi.fn(),
  enableSnapshots: vi.fn(),
  fetchDoctorOutput: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import { UpgradeAlert } from "../../lib/public/js/components/upgrade-alert/index.js";
import { RetryUpgradeDialog } from "../../lib/public/js/components/upgrade-alert/retry-upgrade-dialog.js";
import { buildSnapshotRowModel, describeBackupLine, describeRetryDowntime, describeUnchanged } from "../../lib/public/js/components/upgrade-alert/model.js";
import { requestUpgradeRetryConfirm, consumeUpgradeRetryRequest } from "../../lib/public/js/components/upgrade-alert/retry-request.js";
import { gatewayShellStore } from "../../lib/public/js/components/restart-progress-card.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";

const harness = preactHooks.__harness;

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
  if (out.props.children !== undefined) out.props = { ...out.props, children: expandTree(out.props.children) };
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
const treeText = (tree) => collectText(tree).join(" ").replace(/\s+/g, " ");
// Only the alert card itself (the closed dialogs' children are in the
// collect-only tree too).
const section = (tree) => collectNodes(tree).find((n) => n.type === "section") || null;
const buttons = (tree) => collectNodes(section(tree)).filter((n) => n.type === ActionButton).map((n) => n.props.idleLabel);
const render = () => {
  harness.beginRender();
  return expandTree(UpgradeAlert({ isActive: true }));
};

const kAdminFailed = {
  ok: true,
  alert: {
    kind: "failed",
    tone: "error",
    headline: "OpenClaw's data upgrade didn't finish",
    sentence: "One of OpenClaw's upgrade checks failed: plugins.",
    detail: "Failing check plugins: broken",
    snapshot: { sentence: "This run had no safety snapshot: /data lets other users replace the folders inside it, so OpenClaw won't stage a snapshot there.", cause: "SQLite staging ancestor must not allow another user to replace its child: /data" },
    actions: ["enable_snapshots", "retry_upgrade", "view_logs", "back_up"],
    at: Date.parse("2026-10-16T10:00:00Z"),
  },
  retry: { available: true, unchanged: true, unchangedSince: Date.parse("2026-10-16T10:00:00Z"), lastSuccessDurationMs: 330_000 },
  backup: { count: 1, newest: { name: "b.tar.gz", ageMs: 3_600_000, verification: "unknown" }, verified: null },
};

describe("frontend/upgrade-alert", () => {
  beforeEach(() => {
    harness.reset();
    gatewayShellStore.reset();
  });

  it("admin failure row: plain sentence, snapshot line, raw text behind a disclosure, actions in order", () => {
    cachedData.current = kAdminFailed;
    const tree = render();
    const text = treeText(section(tree));
    expect(text).toContain("OpenClaw's data upgrade didn't finish");
    expect(text).toContain("One of OpenClaw's upgrade checks failed: plugins.");
    expect(text).toContain("This run had no safety snapshot");
    expect(text).toContain("Nothing has changed since this failed");
    expect(text).toContain("Newest backup: b.tar.gz · 1h ago · verification unknown");
    const details = collectNodes(tree).find((n) => n.type === "details");
    expect(treeText(details)).toContain("What OpenClaw said");
    expect(treeText(details)).toContain("Failing check plugins: broken");
    expect(buttons(tree)).toEqual(["Enable snapshots", "Retry upgrade", "View Doctor output", "Back up now"]);
    expect(text).not.toContain("An administrator needs to finish this upgrade.");
  });

  it("member view: the headline and the member line, no buttons, no paths", () => {
    cachedData.current = {
      ok: true,
      alert: { kind: "failed", tone: "error", headline: "OpenClaw's data upgrade didn't finish", sentence: "One of OpenClaw's upgrade checks failed: plugins.", memberLine: "An administrator needs to finish this upgrade.", actions: [] },
    };
    const tree = render();
    expect(treeText(section(tree))).toContain("An administrator needs to finish this upgrade.");
    expect(buttons(tree)).toEqual([]);
    expect(collectNodes(tree).some((n) => n.type === "details")).toBe(false);
  });

  it("renders nothing when there is no alert", () => {
    cachedData.current = { ok: true, alert: null };
    harness.beginRender();
    expect(UpgradeAlert({ isActive: true })).toBeNull();
  });

  it("Try again from another surface opens the confirm (pending request survives navigation)", () => {
    const fakeWindow = { location: { hash: "#/watchdog" }, dispatchEvent: vi.fn() };
    vi.stubGlobal("window", fakeWindow);
    try {
      requestUpgradeRetryConfirm();
      expect(fakeWindow.location.hash).toBe("/general");
      expect(consumeUpgradeRetryRequest()).toBe(true);
      expect(consumeUpgradeRetryRequest()).toBe(false);
      fakeWindow.location.hash = "#/general";
      requestUpgradeRetryConfirm();
      expect(fakeWindow.dispatchEvent).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the confirm names the downtime and asks for Retry anyway when nothing changed", () => {
    expect(describeRetryDowntime({ lastSuccessDurationMs: 330_000 })).toContain("The last successful run took 5m 30s.");
    expect(describeUnchanged({ unchanged: true, unchangedSince: null })).toBe("Nothing has changed since this failed, so OpenClaw will most likely refuse it again.");
    harness.beginRender();
    const tree = expandTree(RetryUpgradeDialog({ visible: true, retry: { unchanged: false }, onRetry: vi.fn(), onCancel: vi.fn() }));
    expect(collectNodes(tree).find((n) => n.props?.confirmLabel)?.props.confirmLabel).toBe("Retry upgrade");
  });

  it("the confirm gives the expected duration and the disk warnings for this state (ALPH-23)", () => {
    const disk = { verdict: "warn", sentences: ["Only 45.0 GB is free for 30.0 GB of OpenClaw state."], expectedMinutes: 24 };
    expect(describeRetryDowntime({ disk })).toContain("For this much state expect about 24 min");
    expect(describeRetryDowntime({ lastSuccessDurationMs: 330_000, disk })).toContain("The last successful run took 5m 30s.");
    harness.beginRender();
    const tree = expandTree(RetryUpgradeDialog({ visible: true, retry: { unchanged: false, disk }, onRetry: vi.fn(), onCancel: vi.fn() }));
    const details = collectNodes(tree).find((n) => n.props?.confirmLabel)?.props.details;
    expect(JSON.stringify(details)).toContain("Only 45.0 GB is free for 30.0 GB of OpenClaw state.");
  });

  it("backup line: 'verified' only with archive-bound evidence, and says which state it holds", () => {
    expect(describeBackupLine({ verified: { name: "a.tar.gz", ageMs: 3 * 86_400_000, scope: "pre_upgrade", openclawVersion: "2026.10.2" } })).toBe(
      "Newest verified backup: a.tar.gz · 3d ago · taken before this upgrade, under OpenClaw 2026.10.2",
    );
    expect(describeBackupLine({ newest: null, verified: null })).toBe("No backups in the backups folder yet.");
    expect(
      describeBackupLine({
        newest: { name: "b.tar.gz", ageMs: 3_600_000, verification: "unknown" },
        verified: { name: "a.tar.gz", ageMs: 3 * 86_400_000, scope: "pre_upgrade", openclawVersion: "2026.10.2" },
      }),
    ).toBe("Newest backup: b.tar.gz · 1h ago · verification unknown. Newest verified backup: a.tar.gz · 3d ago · taken before this upgrade, under OpenClaw 2026.10.2");
  });

  it("Backups snapshot row: On / Off with Enable snapshots or the manual fix", () => {
    expect(buildSnapshotRowModel({ preflight: { captureAvailable: true } })).toMatchObject({ label: "On", canEnable: false });
    expect(buildSnapshotRowModel({ preflight: { captureAvailable: false, sentence: "s", fixable: { canFix: true } } })).toMatchObject({ label: "Off", canEnable: true });
    expect(buildSnapshotRowModel({ preflight: { captureAvailable: false, sentence: "s", fixable: { canFix: false }, manualFix: "Run chmod +t /data as root" } })).toMatchObject({ canEnable: false, manualFix: "Run chmod +t /data as root" });
    expect(buildSnapshotRowModel({ alert: null })).toBeNull();
  });
});
