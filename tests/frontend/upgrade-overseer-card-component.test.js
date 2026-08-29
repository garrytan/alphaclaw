import { beforeEach, describe, expect, it, vi } from "vitest";

// Hook harness (team-tab-component.test.js pattern): the card renders without
// a DOM; its useSavedSetting effect is collected and run manually.
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
  fetchOpenclawOverseer: vi.fn(),
  updateOpenclawOverseer: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { UpgradeOverseerCard } from "../../lib/public/js/components/upgrade-tab/overseer-card.js";
import { SavedToggle } from "../../lib/public/js/components/saved-toggle.js";
import { ToggleSwitch } from "../../lib/public/js/components/toggle-switch.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { invalidateCache } from "../../lib/public/js/lib/api-cache.js";

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

const renderCard = (props = {}) => {
  harness.beginRender();
  return expandTree(UpgradeOverseerCard({ runs: [], ...props }));
};

const toggleProps = (tree) => findAllByType(tree, ToggleSwitch)[0]?.props;
const savedToggleProps = (tree) => findAllByType(tree, SavedToggle)[0]?.props;

beforeEach(() => {
  harness.reset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  invalidateCache("/api/openclaw/overseer");
});

describe("frontend/upgrade overseer card (component)", () => {
  it("renders the full card immediately with a Loading toggle — never a hostage shell", () => {
    api.fetchOpenclawOverseer.mockReturnValue(new Promise(() => {}));
    const tree = renderCard();
    const text = collectText(tree).join(" ");
    expect(text).toContain("Overseer report"); // header present pre-fetch
    expect(text).toContain("advisory only");
    expect(toggleProps(tree).label).toBe("Loading...");
    expect(toggleProps(tree).disabled).toBe(true);
  });

  it("hydrates enabled + availability from the settings GET", async () => {
    api.fetchOpenclawOverseer.mockResolvedValue({
      ok: true,
      enabled: true,
      availability: { available: true, message: "claude 1.2.3" },
    });
    renderCard();
    harness.effects[0]();
    await flushAsync();
    const tree = renderCard();
    expect(toggleProps(tree).label).toBe("Enabled");
    expect(toggleProps(tree).checked).toBe(true);
    expect(collectText(tree).join(" ")).toContain("Available (claude 1.2.3)");
  });

  it("flips optimistically with a Saving... label, then settles with a toast", async () => {
    api.fetchOpenclawOverseer.mockResolvedValue({ ok: true, enabled: false });
    const putGate = deferred();
    api.updateOpenclawOverseer.mockReturnValue(putGate.promise);
    renderCard();
    harness.effects[0]();
    await flushAsync();
    let tree = renderCard();
    expect(toggleProps(tree).label).toBe("Disabled");

    const clicked = savedToggleProps(tree).onChange(true);
    tree = renderCard();
    expect(toggleProps(tree).checked).toBe(true); // instant — no snap-back
    expect(toggleProps(tree).label).toBe("Saving...");
    expect(toggleProps(tree).disabled).toBe(true);

    putGate.resolve({ ok: true, enabled: true });
    await clicked;
    tree = renderCard();
    expect(toggleProps(tree).label).toBe("Enabled");
    expect(showToast).toHaveBeenCalledWith(
      "Overseer enabled — it reviews future update runs",
      "info",
    );
  });

  it("reverts loudly with an inline chip on save failure — no error toast", async () => {
    api.fetchOpenclawOverseer.mockResolvedValue({ ok: true, enabled: false });
    const error = Object.assign(new Error("disk full"), {
      hint: "Check disk space on the data volume.",
    });
    api.updateOpenclawOverseer.mockRejectedValue(error);
    renderCard();
    harness.effects[0]();
    await flushAsync();
    let tree = renderCard();

    await savedToggleProps(tree).onChange(true);
    tree = renderCard();
    expect(toggleProps(tree).checked).toBe(false); // reverted
    const text = collectText(tree).join(" ");
    expect(text).toContain(
      "Couldn't confirm enabling the overseer — showing the server's current state.",
    );
    expect(text).toContain("disk full");
    expect(text).toContain("Check disk space on the data volume.");
    expect(showToast).not.toHaveBeenCalled();
  });

  it("a stale settings GET landing after a user toggle cannot clobber it", async () => {
    const getGate = deferred();
    api.fetchOpenclawOverseer.mockReturnValue(getGate.promise);
    api.updateOpenclawOverseer.mockResolvedValue({ ok: true, enabled: true });
    let tree = renderCard();
    harness.effects[0](); // GET in flight

    await savedToggleProps(tree).onChange(true); // fast PUT
    tree = renderCard();
    expect(toggleProps(tree).checked).toBe(true);

    getGate.resolve({
      ok: true,
      enabled: false, // pre-write snapshot lands late
      availability: { available: true, message: "claude 1.2.3" },
    });
    await flushAsync();
    tree = renderCard();
    expect(toggleProps(tree).checked).toBe(true); // the user's choice stands
    // Non-user-mutable payload still applied: availability line renders.
    expect(collectText(tree).join(" ")).toContain("Available (claude 1.2.3)");
  });

  it("renders a load-failure chip instead of presenting Disabled as fact", async () => {
    api.fetchOpenclawOverseer.mockRejectedValue(new Error("offline"));
    renderCard();
    harness.effects[0]();
    await flushAsync();
    const tree = renderCard();
    expect(toggleProps(tree).disabled).toBe(true);
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBeGreaterThan(0);
    expect(collectText(tree).join(" ")).toContain("Couldn't load this setting.");
  });

  it("shows the no-report-yet note only when enabled, and the report from the runs prop", async () => {
    api.fetchOpenclawOverseer.mockResolvedValue({ ok: true, enabled: true });
    renderCard();
    harness.effects[0]();
    await flushAsync();
    let tree = renderCard({ runs: [] });
    expect(collectText(tree).join(" ")).toContain("No overseer report yet");

    tree = renderCard({
      runs: [
        {
          overseer: {
            state: "done",
            verdict: "healthy",
            summary: "All good.",
            appliesToCurrent: true,
          },
        },
      ],
    });
    const text = collectText(tree).join(" ");
    expect(text).toContain("All good.");
    expect(text).toContain("Mark as good now");
  });
});
