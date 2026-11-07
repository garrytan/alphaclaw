import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => {
  const harness = { effects: [] };
  globalThis.__overflowMenuHarness = harness;
  return {
    useRef: (initialValue = null) => ({ current: initialValue }),
    useEffect: (effect) => {
      harness.effects.push(effect);
    },
  };
});

const { OverflowMenu } = await import("../../lib/public/js/components/overflow-menu.js");

const harness = globalThis.__overflowMenuHarness;

const findRef = (node) => {
  if (!node || typeof node !== "object") return null;
  if (typeof node.ref === "function") return node.ref;
  const children = [].concat(node.props?.children ?? []);
  for (const child of children) {
    const ref = findRef(child);
    if (ref) return ref;
  }
  return null;
};

const keyEvent = (key) => Object.assign(new Event("keydown"), { key });

describe("frontend/overflow-menu dismissal", () => {
  let target;
  let cleanups;

  beforeEach(() => {
    harness.effects = [];
    cleanups = [];
    target = new EventTarget();
    vi.stubGlobal("window", target);
  });

  afterEach(() => {
    cleanups.forEach((cleanup) => cleanup?.());
    vi.unstubAllGlobals();
  });

  const openMenu = ({ inside = false } = {}) => {
    const onClose = vi.fn();
    const tree = OverflowMenu({ open: true, onClose });
    findRef(tree)({ contains: () => inside });
    harness.effects.forEach((effect) => cleanups.push(effect()));
    return onClose;
  };

  it("closes on Escape", () => {
    const onClose = openMenu();
    target.dispatchEvent(keyEvent("Enter"));
    expect(onClose).not.toHaveBeenCalled();
    target.dispatchEvent(keyEvent("Escape"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on an outside click", () => {
    const onClose = openMenu();
    target.dispatchEvent(new Event("click"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open for clicks inside the menu", () => {
    const onClose = openMenu({ inside: true });
    target.dispatchEvent(new Event("click"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
