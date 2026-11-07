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

  const openMenu = ({ inside = false, trigger = null } = {}) => {
    const onClose = vi.fn();
    const tree = OverflowMenu({ open: true, onClose });
    findRef(tree)({ contains: () => inside, querySelector: () => trigger });
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

  it("ignores an Escape another handler used or an IME is composing", () => {
    target.addEventListener("keydown", (event) => {
      if (event.consumed) event.preventDefault();
    });
    const onClose = openMenu();
    target.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape", consumed: true }));
    target.dispatchEvent(Object.assign(keyEvent("Escape"), { isComposing: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus to the trigger and claims the Escape", () => {
    const trigger = { focus: vi.fn() };
    const onClose = openMenu({ trigger });
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    target.dispatchEvent(event);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(trigger.focus).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("listens for Escape in the capture phase so a menu inside a dialog goes first", () => {
    const spy = vi.spyOn(target, "addEventListener");
    openMenu();
    expect(spy).toHaveBeenCalledWith("keydown", expect.any(Function), true);
  });

  it("stays open for clicks inside the menu", () => {
    const onClose = openMenu({ inside: true });
    target.dispatchEvent(new Event("click"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
