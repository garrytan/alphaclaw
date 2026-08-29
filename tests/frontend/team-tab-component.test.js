import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as watchdog-notifications-settings):
// hook state lives in per-call-index slots so component functions can be
// invoked directly without a DOM renderer. Effects are collected, not run.
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
  fetchTeamOperators: vi.fn(),
  fetchTeamStatus: vi.fn(),
  saveTeamOperators: vi.fn(),
  setTeamEnabled: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { TeamTab } from "../../lib/public/js/components/team-tab/index.js";

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

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const renderTab = () => {
  harness.beginRender();
  return expandTree(TeamTab({}));
};

const hydrateTab = async () => {
  renderTab();
  // Run the load effect (without its cleanup), then re-render loaded state.
  harness.effects[0]?.();
  await flushAsync();
  return renderTab();
};

describe("frontend/team tab component", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    api.fetchTeamStatus.mockResolvedValue({ enabled: false });
    api.fetchTeamOperators.mockResolvedValue({ operators: [] });
    api.saveTeamOperators.mockResolvedValue({ operators: [] });
    api.setTeamEnabled.mockResolvedValue({ ok: true, enabled: true });
  });

  it("saves operators with blank-id rows filtered out and fields trimmed", async () => {
    api.fetchTeamOperators.mockResolvedValue({
      operators: [
        { id: " ada ", name: " Ada ", email: " ada@example.com ", avatar: "" },
        { id: "   ", name: "ghost", email: "ghost@example.com", avatar: "" },
        { id: "", name: "", email: "", avatar: "" },
      ],
    });
    api.saveTeamOperators.mockResolvedValue({
      operators: [
        { id: "ada", name: "Ada", email: "ada@example.com", avatar: "" },
      ],
    });
    const tree = await hydrateTab();

    await findButtonByText(tree, "Save").props.onclick();

    expect(api.saveTeamOperators).toHaveBeenCalledTimes(1);
    expect(api.saveTeamOperators).toHaveBeenCalledWith([
      { id: "ada", name: "Ada", email: "ada@example.com", avatar: "" },
    ]);
    expect(showToast).toHaveBeenCalledWith("Operators saved", "success");
  });

  it("toggles team mode only after confirmation, using the pending value", async () => {
    let tree = await hydrateTab();

    // Clicking the toggle button opens the confirm dialog — no API call yet.
    findButtonByText(tree, "Enable team mode").props.onclick();
    expect(api.setTeamEnabled).not.toHaveBeenCalled();

    tree = renderTab();
    const confirmButton = findButtonByText(tree, "Enable and restart");
    expect(confirmButton).toBeTruthy();

    api.fetchTeamStatus.mockClear();
    await confirmButton.props.onclick();

    expect(api.setTeamEnabled).toHaveBeenCalledTimes(1);
    expect(api.setTeamEnabled).toHaveBeenCalledWith(true);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("Team mode enabled"),
      "success",
    );
    // Confirmation is consumed and status is refetched.
    expect(api.fetchTeamStatus).toHaveBeenCalledTimes(1);
    tree = renderTab();
    expect(findButtonByText(tree, "Enable and restart")).toBeUndefined();
  });

  it("shows an error toast and refetches status when the toggle fails", async () => {
    api.setTeamEnabled.mockRejectedValue(new Error("gateway restart failed"));
    let tree = await hydrateTab();

    findButtonByText(tree, "Enable team mode").props.onclick();
    tree = renderTab();

    api.fetchTeamStatus.mockClear();
    await findButtonByText(tree, "Enable and restart").props.onclick();

    expect(showToast).toHaveBeenCalledWith("gateway restart failed", "error");
    expect(api.fetchTeamStatus).toHaveBeenCalledTimes(1);
  });

  it("renders the frame while loading instead of a hostage page", () => {
    const tree = renderTab();

    // Scaffolding is present immediately; the badge says Loading and the
    // toggle is gated until status hydrates.
    expect(collectText(tree).join(" ")).toContain("Team web view");
    expect(collectText(tree).join(" ")).toContain("Loading...");
    const toggle = findButtonByText(tree, "Enable team mode");
    expect(toggle).toBeTruthy();
    expect(toggle.props.disabled).toBe(true);
  });

  it("surfaces a load failure as an inline chip with Retry, not as 'Disabled'", async () => {
    api.fetchTeamStatus.mockRejectedValue(new Error("status boom"));
    let tree = await hydrateTab();

    const text = collectText(tree).join(" ");
    expect(text).toContain("Unknown");
    expect(text).not.toContain("Disabled");
    expect(text).toContain("Couldn't load team settings.");
    expect(findButtonByText(tree, "Enable team mode").props.disabled).toBe(true);

    const chip = collectNodes(tree).find((node) => node.type === InlineErrorChip);
    expect(chip).toBeTruthy();

    // Retry recovers: status hydrates and the toggle is usable again.
    api.fetchTeamStatus.mockResolvedValue({ enabled: false });
    await chip.props.onRetry();
    tree = renderTab();
    expect(collectText(tree).join(" ")).toContain("Disabled");
    expect(findButtonByText(tree, "Enable team mode").props.disabled).toBe(false);
    expect(
      collectNodes(tree).find((node) => node.type === InlineErrorChip),
    ).toBeUndefined();
  });

  it("keeps unsaved operator edits when a background refresh lands", async () => {
    api.fetchTeamOperators.mockResolvedValue({
      operators: [{ id: "ada", name: "Ada", email: "", avatar: "" }],
    });
    let tree = await hydrateTab();

    const nameInput = findAllByType(tree, "input").find(
      (node) => node.props["aria-label"] === "Operator name",
    );
    nameInput.props.onInput({ target: { value: "Ada Lovelace" } });
    tree = renderTab();

    // Toggle flow triggers a refresh; the server still has the stale name.
    findButtonByText(tree, "Enable team mode").props.onclick();
    tree = renderTab();
    await findButtonByText(tree, "Enable and restart").props.onclick();
    tree = renderTab();

    const refreshedInput = findAllByType(tree, "input").find(
      (node) => node.props["aria-label"] === "Operator name",
    );
    expect(refreshedInput.props.value).toBe("Ada Lovelace");

    // Saving cleans the form, so the post-save refresh may overwrite again.
    api.saveTeamOperators.mockResolvedValue({
      operators: [{ id: "ada", name: "Ada Lovelace", email: "", avatar: "" }],
    });
    await findButtonByText(tree, "Save").props.onclick();
    expect(api.saveTeamOperators).toHaveBeenCalledWith([
      { id: "ada", name: "Ada Lovelace", email: "", avatar: "" },
    ]);
    tree = renderTab();
    const savedInput = findAllByType(tree, "input").find(
      (node) => node.props["aria-label"] === "Operator name",
    );
    expect(savedInput.props.value).toBe("Ada");
  });
});
