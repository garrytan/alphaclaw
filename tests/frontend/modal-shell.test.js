import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => {
  const harness = { effects: [] };
  globalThis.__modalShellHarness = harness;
  return {
    useRef: (initialValue = null) => ({ current: initialValue }),
    useEffect: (effect) => {
      harness.effects.push(effect);
    },
  };
});
vi.mock("preact/compat", () => ({ createPortal: (children) => children }));

const { ModalShell, getFocusableElements, trapTabKey } = await import(
  "../../lib/public/js/components/modal-shell.js"
);

const harness = globalThis.__modalShellHarness;

const collect = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, out));
    return out;
  }
  out.push(node);
  collect(node.props?.children, out);
  return out;
};

let doc;
let target;
let cleanups;

const makeElement = (name, extra = {}) => {
  const element = {
    name,
    id: "",
    disabled: false,
    type: "",
    isConnected: true,
    attrs: {},
    getAttribute(key) {
      return key in this.attrs ? this.attrs[key] : null;
    },
    setAttribute(key, value) {
      this.attrs[key] = String(value);
    },
    ...extra,
  };
  element.focus = vi.fn(() => {
    doc.activeElement = element;
  });
  return element;
};

const makePanel = ({ controls = [], heading = null, autofocus = null } = {}) => {
  const panel = makeElement("panel");
  panel.contains = (element) => element === panel || controls.includes(element) || element === heading;
  panel.querySelectorAll = () => controls;
  panel.querySelector = (selector) => {
    if (selector.startsWith("h1")) return heading;
    if (selector.includes("autofocus")) return autofocus;
    return null;
  };
  return panel;
};

const keyEvent = (key, extra = {}) =>
  Object.assign(new Event("keydown", { cancelable: true }), { key, ...extra });

const open = ({ panel = makePanel(), ...props } = {}) => {
  harness.effects = [];
  const onClose = props.onClose || vi.fn();
  const tree = ModalShell({ visible: true, ...props, onClose });
  const dialog = collect(tree).find((node) => node.props?.role === "dialog");
  dialog.ref.current = panel;
  const effects = harness.effects;
  harness.effects = [];
  const own = effects.map((effect) => effect()).filter(Boolean);
  cleanups.push(...own);
  const close = () => {
    own.forEach((cleanup) => cleanup());
    own.forEach((cleanup) => cleanups.splice(cleanups.indexOf(cleanup), 1));
  };
  return { tree, dialog, panel, onClose, close };
};

beforeEach(() => {
  harness.effects = [];
  cleanups = [];
  target = new EventTarget();
  doc = { body: makeElement("body"), activeElement: null };
  doc.activeElement = doc.body;
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", doc);
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

describe("frontend/modal-shell dialog semantics", () => {
  it("renders nothing while hidden", () => {
    expect(ModalShell({ visible: false })).toBe(null);
  });

  it("is a modal dialog named by ariaLabel", () => {
    const { dialog } = open({ ariaLabel: "Add agent" });
    expect(dialog.props["aria-modal"]).toBe("true");
    expect(dialog.props["aria-label"]).toBe("Add agent");
    expect(dialog.props.tabindex).toBe("-1");
  });

  it("takes aria-labelledby when the caller names its title", () => {
    const { dialog } = open({ ariaLabelledby: "my-title" });
    expect(dialog.props["aria-labelledby"]).toBe("my-title");
    expect(dialog.props["aria-label"]).toBe(undefined);
  });

  it("names an unlabelled dialog by its first heading", () => {
    const heading = makeElement("h2");
    const panel = makePanel({ heading });
    open({ panel });
    expect(heading.id).toMatch(/^ac-dialog-title-\d+$/);
    expect(panel.attrs["aria-labelledby"]).toBe(heading.id);
  });

  it("keeps the existing panel class and adds its own hook", () => {
    const { dialog } = open({ panelClassName: "bg-modal p-5" });
    expect(dialog.props.class).toBe("ac-dialog-panel bg-modal p-5");
  });
});

describe("frontend/modal-shell Escape", () => {
  it("closes on Escape", () => {
    const { onClose } = open();
    target.dispatchEvent(keyEvent("Enter"));
    expect(onClose).not.toHaveBeenCalled();
    const event = keyEvent("Escape");
    target.dispatchEvent(event);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("only the topmost dialog handles Escape", () => {
    const outer = open();
    const inner = open();
    target.dispatchEvent(keyEvent("Escape"));
    expect(inner.onClose).toHaveBeenCalledTimes(1);
    expect(outer.onClose).not.toHaveBeenCalled();
    inner.close();
    target.dispatchEvent(keyEvent("Escape"));
    expect(outer.onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores an Escape another handler already used or an IME is composing", () => {
    target.addEventListener("keydown", (event) => {
      if (event.consumed) event.preventDefault();
    });
    const { onClose } = open();
    target.dispatchEvent(keyEvent("Escape", { consumed: true }));
    target.dispatchEvent(keyEvent("Escape", { isComposing: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open on Escape when closeOnEscape is false, and still blocks the dialog below", () => {
    const outer = open();
    const inner = open({ closeOnEscape: false });
    target.dispatchEvent(keyEvent("Escape"));
    expect(inner.onClose).not.toHaveBeenCalled();
    expect(outer.onClose).not.toHaveBeenCalled();
  });
});

describe("frontend/modal-shell focus", () => {
  it("moves focus into the dialog and restores it to the opener on close", () => {
    const opener = makeElement("opener");
    doc.activeElement = opener;
    const { panel, close } = open();
    expect(panel.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(doc.activeElement).toBe(panel);
    close();
    expect(opener.focus).toHaveBeenCalledTimes(1);
    expect(doc.activeElement).toBe(opener);
  });

  it("focuses an autofocus control instead of the panel", () => {
    const field = makeElement("field");
    const panel = makePanel({ controls: [field], autofocus: field });
    open({ panel });
    expect(field.focus).toHaveBeenCalled();
    expect(panel.focus).not.toHaveBeenCalled();
  });

  it("leaves focus alone when a child already moved it inside", () => {
    const field = makeElement("field");
    const panel = makePanel({ controls: [field] });
    doc.activeElement = field;
    open({ panel });
    expect(panel.focus).not.toHaveBeenCalled();
  });

  it("does not pull focus back when it already moved elsewhere, or the opener is gone", () => {
    const opener = makeElement("opener");
    doc.activeElement = opener;
    const first = open();
    const elsewhere = makeElement("elsewhere");
    doc.activeElement = elsewhere;
    first.close();
    expect(opener.focus).not.toHaveBeenCalled();

    const removed = makeElement("removed", { isConnected: false });
    doc.activeElement = removed;
    const second = open();
    second.close();
    expect(removed.focus).not.toHaveBeenCalled();
  });

  it("restores a nested dialog's focus to the control in the dialog below", () => {
    const opener = makeElement("opener");
    const outerButton = makeElement("outer-button");
    doc.activeElement = opener;
    const outer = open({ panel: makePanel({ controls: [outerButton] }) });
    doc.activeElement = outerButton;
    const inner = open();
    inner.close();
    expect(doc.activeElement).toBe(outerButton);
    outer.close();
    expect(doc.activeElement).toBe(opener);
  });
});

describe("frontend/modal-shell focus trap", () => {
  const setup = () => {
    const first = makeElement("first");
    const middle = makeElement("middle");
    const last = makeElement("last");
    const panel = makePanel({ controls: [first, middle, last] });
    return { first, middle, last, panel };
  };

  it("wraps Tab from the last control to the first and Shift+Tab back", () => {
    const { first, middle, last, panel } = setup();
    open({ panel });
    doc.activeElement = last;
    const tab = keyEvent("Tab");
    target.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(first);

    const shiftTab = keyEvent("Tab", { shiftKey: true });
    target.dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(last);

    doc.activeElement = middle;
    const inner = keyEvent("Tab");
    target.dispatchEvent(inner);
    expect(inner.defaultPrevented).toBe(false);
  });

  it("brings focus that escaped the dialog back in", () => {
    const { first, panel } = setup();
    open({ panel });
    doc.activeElement = makeElement("page-link");
    target.dispatchEvent(keyEvent("Tab"));
    expect(doc.activeElement).toBe(first);
  });

  it("Shift+Tab from the focused panel goes to the last control", () => {
    const { last, panel } = setup();
    open({ panel });
    expect(doc.activeElement).toBe(panel);
    target.dispatchEvent(keyEvent("Tab", { shiftKey: true }));
    expect(doc.activeElement).toBe(last);
  });

  it("only the topmost dialog traps Tab", () => {
    const outer = setup();
    open({ panel: outer.panel });
    const inner = setup();
    open({ panel: inner.panel });
    doc.activeElement = inner.last;
    target.dispatchEvent(keyEvent("Tab"));
    expect(doc.activeElement).toBe(inner.first);
    expect(outer.first.focus).not.toHaveBeenCalled();
  });

  it("skips disabled, hidden, aria-hidden and tabindex=-1 controls", () => {
    const visible = makeElement("visible", { getClientRects: () => [1] });
    const disabled = makeElement("disabled", { disabled: true });
    const hiddenInput = makeElement("hidden-input", { type: "hidden" });
    const offscreen = makeElement("display-none", { getClientRects: () => [] });
    const ariaHidden = makeElement("aria-hidden");
    ariaHidden.attrs["aria-hidden"] = "true";
    const roving = makeElement("roving");
    roving.attrs.tabindex = "-1";
    const panel = makePanel({ controls: [disabled, hiddenInput, offscreen, ariaHidden, roving, visible] });
    expect(getFocusableElements(panel)).toEqual([visible]);
  });

  it("treats a radio group as one stop, so Shift+Tab from the checked radio wraps", () => {
    const keep = makeElement("radio-keep", { type: "radio", name: "reset-mode", checked: false });
    const rediscover = makeElement("radio-rediscover", { type: "radio", name: "reset-mode", checked: true });
    const confirm = makeElement("confirm");
    const panel = makePanel({ controls: [keep, rediscover, confirm] });
    expect(getFocusableElements(panel)).toEqual([rediscover, confirm]);
    rediscover.checked = false;
    expect(getFocusableElements(panel)).toEqual([keep, confirm]);
  });

  it("keeps focus on the panel when it has no controls", () => {
    const panel = makePanel();
    const event = keyEvent("Tab");
    trapTabKey(event, panel);
    expect(event.defaultPrevented).toBe(true);
    expect(panel.focus).toHaveBeenCalled();
  });
});
