import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (team-tab-component pattern): hook state lives in
// per-call-index slots so the component can be invoked directly without a
// DOM renderer. Effects are collected, not run — tests invoke effects[0]
// (the mount refresh) explicitly; the window message-listener effect is
// never run (no DOM in node env).
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
  fetchEnvVars: vi.fn(),
  saveEnvVars: vi.fn(),
  fetchModels: vi.fn(),
  fetchModelStatus: vi.fn(),
  setPrimaryModel: vi.fn(),
  fetchCodexStatus: vi.fn(),
  disconnectCodex: vi.fn(),
  exchangeCodexOAuth: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

vi.mock("../../lib/public/js/lib/api-cache.js", () => ({
  getCached: vi.fn(() => null),
  setCached: vi.fn(),
  invalidateCache: vi.fn(),
  invalidateCachePrefix: vi.fn(),
  cachedFetch: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/codex-oauth-window.js", () => ({
  isCodexAuthCallbackMessage: vi.fn(() => false),
  openCodexAuthWindow: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { invalidateCache, invalidateCachePrefix } from "../../lib/public/js/lib/api-cache.js";
import { openCodexAuthWindow } from "../../lib/public/js/lib/codex-oauth-window.js";
import { SecretInput } from "../../lib/public/js/components/secret-input.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import {
  Providers,
  mergeEnvVarsPreservingDrafts,
} from "../../lib/public/js/components/providers.js";

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

const findButtonByText = (tree, text) =>
  findAllByType(tree, "button").find((vnode) =>
    collectText(vnode).join(" ").includes(text),
  );

const findActionButtonByLabel = (tree, idleLabel) =>
  findAllByType(tree, ActionButton).find(
    (vnode) => vnode.props.idleLabel === idleLabel,
  );

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const renderProviders = () => {
  harness.beginRender();
  return expandTree(Providers({}));
};

const hydrateProviders = async () => {
  renderProviders();
  harness.effects[0]?.();
  await flushAsync();
  return renderProviders();
};

const kDefaultEnv = {
  vars: [{ key: "ANTHROPIC_API_KEY", value: "", editable: true }],
};
const kDefaultCatalog = {
  models: [
    { key: "anthropic/claude-opus-4-8", label: "Opus 4.8" },
    { key: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" },
  ],
};

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  api.fetchEnvVars.mockResolvedValue(kDefaultEnv);
  api.fetchModels.mockResolvedValue(kDefaultCatalog);
  api.fetchModelStatus.mockResolvedValue({ modelKey: "" });
  api.fetchCodexStatus.mockResolvedValue({ connected: false });
  api.saveEnvVars.mockResolvedValue({ ok: true });
  api.setPrimaryModel.mockResolvedValue({ ok: true });
  api.disconnectCodex.mockResolvedValue({ ok: true });
});

describe("frontend/providers component", () => {
  // NOTE: runs first, before any test hydrates the module-level tab cache.
  it("cold-load renders the frame immediately: disabled select, loading credential inputs, loading label", () => {
    const tree = renderProviders();

    const select = findAllByType(tree, "select")[0];
    expect(select).toBeTruthy();
    expect(select.props.disabled).toBe(true);
    const secretInputs = findAllByType(tree, SecretInput);
    expect(secretInputs.length).toBeGreaterThan(0);
    expect(secretInputs[0].props.loading).toBe(true);
    expect(findActionButtonByLabel(tree, "Save changes").props.disabled).toBe(
      true,
    );
    expect(collectText(tree).join(" ")).toContain("Loading model catalog...");
  });

  it("Reconnect Codex actually starts the OAuth flow while connected (no connected-guard no-op)", async () => {
    api.fetchCodexStatus.mockResolvedValue({ connected: true });
    const tree = await hydrateProviders();

    const reconnect = findButtonByText(tree, "Reconnect Codex");
    expect(reconnect).toBeTruthy();
    reconnect.props.onclick();

    expect(openCodexAuthWindow).toHaveBeenCalledTimes(1);
  });

  it("Codex disconnect shows a pending label, is single-flight, and surfaces failures inline", async () => {
    api.fetchCodexStatus.mockResolvedValue({ connected: true });
    let tree = await hydrateProviders();

    const gate = deferred();
    api.disconnectCodex.mockReturnValue(gate.promise);
    const disconnect = findActionButtonByLabel(tree, "Disconnect");
    const clickPromise = disconnect.props.onClick();

    tree = renderProviders();
    const pending = findActionButtonByLabel(tree, "Disconnect");
    expect(pending.props.loading).toBe(true);
    // Second click while in flight is a no-op.
    await pending.props.onClick();
    expect(api.disconnectCodex).toHaveBeenCalledTimes(1);
    // Sibling Reconnect is disabled while the disconnect is in flight.
    expect(findButtonByText(tree, "Reconnect Codex").props.disabled).toBe(true);

    gate.reject(new Error("gateway offline"));
    await clickPromise;

    tree = renderProviders();
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.headline).toBe("Couldn't disconnect Codex.");
    expect(collectText(tree).join(" ")).toContain("gateway offline");
    expect(findActionButtonByLabel(tree, "Disconnect").props.loading).toBe(
      false,
    );
  });

  it("a failed codex status check keeps the last-known status and shows a retryable chip (never fabricates 'Not connected')", async () => {
    api.fetchCodexStatus.mockResolvedValue({ connected: true });
    let tree = await hydrateProviders();

    api.disconnectCodex.mockResolvedValue({ ok: true });
    api.fetchCodexStatus.mockRejectedValue(new Error("status endpoint down"));
    await findActionButtonByLabel(tree, "Disconnect").props.onClick();

    tree = renderProviders();
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.headline).toBe(
      "Status check failed — showing the last known Codex status",
    );
    const text = collectText(tree).join(" ");
    expect(text).toContain("Connected");
    expect(text).toContain("status endpoint down");
    expect(text).not.toContain("Not connected");

    // Retry re-runs the same status check and clears the chip on success.
    api.fetchCodexStatus.mockResolvedValue({ connected: true });
    await chips[0].props.onRetry();
    tree = renderProviders();
    expect(findAllByType(tree, InlineErrorChip).length).toBe(0);
    expect(collectText(tree).join(" ")).not.toContain("Status check failed");
  });

  it("a quiet-period codex status (unavailable: true) keeps the last-known 'Connected' under an 'Unavailable during backup' badge — never 'Not connected'", async () => {
    api.fetchCodexStatus.mockResolvedValue({ connected: true });
    let tree = await hydrateProviders();
    expect(collectText(tree).join(" ")).toContain("Connected");

    api.fetchCodexStatus.mockResolvedValue({
      connected: false,
      unavailable: true,
      reason: "backup_in_progress",
    });
    // Disconnect's follow-up status read is the quiet-period one.
    api.disconnectCodex.mockResolvedValue({ ok: true });
    await findActionButtonByLabel(tree, "Disconnect").props.onClick();
    tree = renderProviders();

    const text = collectText(tree).join(" ");
    expect(text).toContain("Unavailable during backup");
    expect(text).toContain(
      "Credential store unavailable during a backup — showing the last known Codex status (connected).",
    );
    expect(text).not.toContain("Not connected");
    // Not a failed check: no error chip.
    expect(findAllByType(tree, InlineErrorChip).length).toBe(0);
  });

  it("a deferred manual exchange (202 deferred:true) toasts the honest message and badges the pending save", async () => {
    api.fetchCodexStatus.mockResolvedValue({
      connected: false,
      unavailable: true,
      reason: "backup_in_progress",
    });
    api.exchangeCodexOAuth.mockResolvedValue({
      ok: true,
      deferred: true,
      reason: "backup_in_progress",
    });
    let tree = await hydrateProviders();
    // The tab cache may carry a last-known "connected" from an earlier test
    // (kept under the unavailable marker — that is the point), so the entry
    // point is either Connect or Reconnect; both start the same flow.
    (
      findButtonByText(tree, "Connect Codex OAuth") ||
      findButtonByText(tree, "Reconnect Codex")
    ).props.onclick();
    tree = renderProviders();
    findAllByType(tree, "input")
      .find((vnode) => String(vnode.props.placeholder || "").includes("auth/callback"))
      .props.onInput({
        target: { value: "http://localhost:1455/auth/callback?code=abc&state=def" },
      });
    tree = renderProviders();
    await findActionButtonByLabel(tree, "Complete Codex OAuth").props.onClick();
    tree = renderProviders();

    expect(showToast).toHaveBeenCalledWith(
      "Codex connected — saved after the backup finishes",
      "success",
    );
    const text = collectText(tree).join(" ");
    expect(text).toContain("Connected — saved after the backup finishes");
    expect(text).not.toContain("Not connected");
  });

  it("saving env vars and the primary model invalidates the affected caches", async () => {
    let tree = await hydrateProviders();

    findAllByType(tree, SecretInput)[0].props.onInput({
      target: { value: "sk-ant-new" },
    });
    findAllByType(tree, "select")[0].props.onInput({
      target: { value: "anthropic/claude-opus-4-8" },
    });
    api.fetchModelStatus.mockResolvedValue({
      modelKey: "anthropic/claude-opus-4-8",
    });

    tree = renderProviders();
    await findActionButtonByLabel(tree, "Save changes").props.onClick();

    expect(api.saveEnvVars).toHaveBeenCalledTimes(1);
    expect(api.setPrimaryModel).toHaveBeenCalledWith(
      "anthropic/claude-opus-4-8",
    );
    expect(invalidateCache).toHaveBeenCalledWith("/api/env");
    expect(invalidateCache).toHaveBeenCalledWith("/api/models");
    expect(invalidateCache).toHaveBeenCalledWith("/api/codex/status");
    // Prefix, not exact key: scoped /api/models/config?agentId=... entries
    // embed the global primary this save just changed.
    expect(invalidateCachePrefix).toHaveBeenCalledWith("/api/models/config");
  });

  // Kept last: leaves an intentionally dirty draft in the module tab cache.
  it("a refresh landing mid-edit keeps the credential draft and the model selection (stale-clobber regression)", async () => {
    const envGate = deferred();
    api.fetchEnvVars.mockReturnValue(envGate.promise);

    let tree = renderProviders();
    harness.effects[0](); // mount refresh now in flight

    tree = renderProviders();
    findAllByType(tree, SecretInput)[0].props.onInput({
      target: { value: "sk-ant-draft" },
    });
    findAllByType(tree, "select")[0].props.onInput({
      target: { value: "openai/gpt-5.6-sol" },
    });

    envGate.resolve({
      vars: [{ key: "ANTHROPIC_API_KEY", value: "sk-ant-server", editable: true }],
    });
    api.fetchModelStatus.mockResolvedValue({
      modelKey: "anthropic/claude-opus-4-8",
    });
    await flushAsync();

    tree = renderProviders();
    expect(findAllByType(tree, SecretInput)[0].props.value).toBe(
      "sk-ant-draft",
    );
    expect(findAllByType(tree, "select")[0].props.value).toBe(
      "openai/gpt-5.6-sol",
    );
    expect(findAllByType(tree, "select")[0].props.disabled).toBe(false);
  });
});

describe("frontend/providers mergeEnvVarsPreservingDrafts", () => {
  const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

  it("adopts server values where the draft still equals the saved baseline", () => {
    const merged = mergeEnvVarsPreservingDrafts(
      [{ key: "ANTHROPIC_API_KEY", value: "server", editable: true }],
      [{ key: "ANTHROPIC_API_KEY", value: "old", editable: true }],
      { ANTHROPIC_API_KEY: "old" },
      keys,
    );
    expect(merged).toEqual([
      { key: "ANTHROPIC_API_KEY", value: "server", editable: true },
    ]);
  });

  it("keeps dirty drafts, including cleared values and draft-only keys", () => {
    const merged = mergeEnvVarsPreservingDrafts(
      [{ key: "ANTHROPIC_API_KEY", value: "server", editable: true }],
      [
        { key: "ANTHROPIC_API_KEY", value: "", editable: true },
        { key: "OPENAI_API_KEY", value: "sk-draft", editable: true },
      ],
      { ANTHROPIC_API_KEY: "old", OPENAI_API_KEY: "" },
      keys,
    );
    expect(merged).toEqual([
      { key: "ANTHROPIC_API_KEY", value: "", editable: true },
      { key: "OPENAI_API_KEY", value: "sk-draft", editable: true },
    ]);
  });

  it("leaves non-credential keys entirely to the server", () => {
    const merged = mergeEnvVarsPreservingDrafts(
      [{ key: "SOME_FLAG", value: "server", editable: true }],
      [{ key: "SOME_FLAG", value: "draft", editable: true }],
      {},
      keys,
    );
    expect(merged).toEqual([
      { key: "SOME_FLAG", value: "server", editable: true },
    ]);
  });
});
