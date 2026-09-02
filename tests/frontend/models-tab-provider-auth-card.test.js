import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (team-tab-component pattern): hook state lives in
// per-call-index slots so components can be invoked directly without a DOM
// renderer. Effects are collected, not run.
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
  exchangeCodexOAuth: vi.fn(),
  disconnectCodex: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

vi.mock("../../lib/public/js/lib/codex-oauth-window.js", () => ({
  isCodexAuthCallbackMessage: vi.fn(() => false),
  openCodexAuthWindow: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { Badge } from "../../lib/public/js/components/badge.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { ProviderAuthCard } from "../../lib/public/js/components/models-tab/provider-auth-card.js";

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

const findActionButtonByLabel = (tree, idleLabel) =>
  findAllByType(tree, ActionButton).find(
    (vnode) => vnode.props.idleLabel === idleLabel,
  );

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const kBaseProps = {
  provider: "openai-codex",
  authProfiles: [],
  authOrder: {},
  codexStatus: { connected: true },
  codexStatusError: "",
  codexStatusKnown: true,
  onEditProfile: () => {},
  onEditAuthOrder: () => {},
  getProfileValue: () => null,
  getEffectiveOrder: () => null,
  onRefreshCodex: vi.fn(async () => {}),
};

const renderCard = (props = {}) => {
  harness.beginRender();
  return expandTree(ProviderAuthCard({ ...kBaseProps, ...props }));
};

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
});

describe("frontend/models-tab provider auth card codex section", () => {
  it("disconnect shows a pending label, is single-flight, and surfaces failures inline", async () => {
    const gate = deferred();
    api.disconnectCodex.mockReturnValue(gate.promise);

    let tree = renderCard();
    const clickPromise = findActionButtonByLabel(tree, "Disconnect").props.onClick();

    tree = renderCard();
    const pending = findActionButtonByLabel(tree, "Disconnect");
    expect(pending.props.loading).toBe(true);
    await pending.props.onClick(); // in-flight click is a no-op
    expect(api.disconnectCodex).toHaveBeenCalledTimes(1);

    gate.reject(new Error("gateway offline"));
    await clickPromise;

    tree = renderCard();
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.headline).toBe("Couldn't disconnect Codex.");
    expect(collectText(tree).join(" ")).toContain("gateway offline");
    expect(findActionButtonByLabel(tree, "Disconnect").props.loading).toBe(
      false,
    );
  });

  it("clears the inline error on the next attempt and refreshes status on success", async () => {
    api.disconnectCodex.mockRejectedValueOnce(new Error("boom"));
    let tree = renderCard();
    await findActionButtonByLabel(tree, "Disconnect").props.onClick();
    tree = renderCard();
    expect(findAllByType(tree, InlineErrorChip).length).toBe(1);

    api.disconnectCodex.mockResolvedValueOnce({ ok: true });
    await findActionButtonByLabel(tree, "Disconnect").props.onClick();
    tree = renderCard();

    expect(findAllByType(tree, InlineErrorChip).length).toBe(0);
    expect(kBaseProps.onRefreshCodex).toHaveBeenCalledTimes(1);
  });

  it("renders the status-check-failed chip without overriding the last-known badge", () => {
    const tree = renderCard({ codexStatusError: "status endpoint down" });
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.headline).toBe(
      "Status check failed — showing the last known Codex status",
    );
    // The retry re-runs the same status fetch the card was given.
    expect(chips[0].props.onRetry).toBe(kBaseProps.onRefreshCodex);
    const text = collectText(tree).join(" ");
    expect(text).toContain("status endpoint down");
    expect(text).toContain("Connected");
    expect(text).not.toContain("Not connected");
  });

  it("a failed FIRST check says the status is unknown instead of claiming last-known data", () => {
    const tree = renderCard({
      codexStatus: { connected: false },
      codexStatusError: "cold boot failure",
      codexStatusKnown: false,
    });
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.headline).toBe(
      "Status check failed — Codex status unknown",
    );
    expect(collectText(tree).join(" ")).not.toContain(
      "showing the last known",
    );
  });

  it("a quiet-period status renders 'Unavailable during backup' with the last-known line — never 'Not connected'", () => {
    const tree = renderCard({
      codexStatus: { connected: true, unavailable: true, reason: "backup_in_progress" },
      codexStatusKnown: true,
    });
    const badge = findAllByType(tree, Badge).find((vnode) =>
      collectText(vnode).join(" ").includes("Unavailable during backup"),
    );
    expect(badge).toBeTruthy();
    expect(badge.props.tone).toBe("warning");
    const text = collectText(tree).join(" ");
    expect(text).toContain(
      "Credential store unavailable during a backup — showing the last known Codex status (connected).",
    );
    expect(text).not.toContain("Not connected");

    // Never checked + unavailable: says unknown-until-it-finishes, not "not connected".
    const cold = collectText(
      renderCard({
        codexStatus: { connected: false, unavailable: true, reason: "backup_in_progress" },
        codexStatusKnown: false,
      }),
    ).join(" ");
    expect(cold).toContain("Codex status unknown until it finishes");
    expect(cold).not.toContain("Not connected");
  });

  it("a deferred exchange (202 deferred:true) toasts the honest message and shows 'Connected — saved after the backup finishes' until the store confirms", async () => {
    api.exchangeCodexOAuth.mockResolvedValue({
      ok: true,
      deferred: true,
      reason: "backup_in_progress",
    });
    let tree = renderCard({
      codexStatus: { connected: false, unavailable: true, reason: "backup_in_progress" },
      codexStatusKnown: false,
    });
    // Start the flow (popup blocked → manual paste path), paste, complete.
    findAllByType(tree, "button")
      .find((vnode) => collectText(vnode).join(" ").includes("Connect Codex OAuth"))
      .props.onclick();
    tree = renderCard({
      codexStatus: { connected: false, unavailable: true, reason: "backup_in_progress" },
      codexStatusKnown: false,
    });
    findAllByType(tree, "input")[0].props.onInput({
      target: { value: "http://localhost:1455/auth/callback?code=abc&state=def" },
    });
    tree = renderCard({
      codexStatus: { connected: false, unavailable: true, reason: "backup_in_progress" },
      codexStatusKnown: false,
    });
    await findActionButtonByLabel(tree, "Complete Codex OAuth").props.onClick();

    expect(showToast).toHaveBeenCalledWith(
      "Codex connected — saved after the backup finishes",
      "success",
    );
    expect(kBaseProps.onRefreshCodex).toHaveBeenCalledTimes(1);
    tree = renderCard({
      codexStatus: { connected: false, unavailable: true, reason: "backup_in_progress" },
      codexStatusKnown: false,
    });
    const badge = findAllByType(tree, Badge).find((vnode) =>
      collectText(vnode).join(" ").includes("saved after the backup finishes"),
    );
    expect(badge).toBeTruthy();
    expect(badge.props.tone).toBe("info");
    expect(collectText(tree).join(" ")).not.toContain("Not connected");

    // The store confirms the saved connection: the ordinary badge is back.
    // (Running the collected effects includes the window message listener —
    // stub a window for it; node has none.)
    const originalWindow = globalThis.window;
    globalThis.window = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    try {
      tree = renderCard({ codexStatus: { connected: true }, codexStatusKnown: true });
      for (const effect of harness.effects) effect();
    } finally {
      globalThis.window = originalWindow;
    }
    tree = renderCard({ codexStatus: { connected: true }, codexStatusKnown: true });
    // (The harness walks props.children AND rendered, so a badge's text
    // collects twice — match by inclusion, not equality.)
    const labels = findAllByType(tree, Badge).map((vnode) => collectText(vnode).join(" "));
    expect(labels.some((label) => label.includes("Connected"))).toBe(true);
    expect(labels.join(" ")).not.toContain("saved after");
    expect(labels.join(" ")).not.toContain("Unavailable");
  });
});
