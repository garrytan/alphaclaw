import { describe, expect, it, vi } from "vitest";

// Same DOM-less harness pattern as upgrade-tab.test.js: stub hooks + portal so the
// component renders to a walkable vnode tree.
vi.mock("preact/hooks", () => ({
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useRef: (v = null) => ({ current: v }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useEffect: () => {},
}));
vi.mock("preact/compat", () => ({
  createPortal: (children) => children,
}));

import { WizardShell } from "../../lib/public/js/components/wizard-shell.js";

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

const render = (props) => expandTree(WizardShell(props));

describe("frontend/wizard-shell (2.6)", () => {
  const kSteps = ["Requirements", "Identity", "Review"];

  it("renders the Step N of M heading and label", () => {
    const text = collectText(
      render({ visible: true, label: "Team Setup", steps: kSteps, step: 1 }),
    )
      .join(" ")
      .replace(/\s+/g, " ");
    expect(text).toContain("Team Setup");
    expect(text).toContain("Step 2 of 3 : Identity");
  });

  it("marks the active progress segment with aria-current=step", () => {
    const tree = render({ visible: true, steps: kSteps, step: 1 });
    const segments = collectNodes(tree).filter(
      (n) => n.props?.role === "listitem",
    );
    expect(segments).toHaveLength(3);
    expect(segments[0].props["aria-current"]).toBe(undefined);
    expect(segments[1].props["aria-current"]).toBe("step");
    expect(segments[2].props["aria-current"]).toBe(undefined);
  });

  it("exposes dialog semantics and a focusable step heading", () => {
    const tree = render({ visible: true, label: "Buzz Setup", steps: kSteps, step: 0 });
    const dialog = collectNodes(tree).find((n) => n.props?.role === "dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.props["aria-modal"]).toBe("true");
    expect(dialog.props["aria-label"]).toBe("Buzz Setup");
    const heading = collectNodes(tree).find((n) => n.type === "h3");
    expect(heading.props.tabindex).toBe("-1");
  });

  it("clamps an out-of-range step index", () => {
    const text = collectText(render({ visible: true, steps: kSteps, step: 99 }))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(text).toContain("Step 3 of 3 : Review");
  });

  it("renders body children and the footer slot", () => {
    const tree = render({
      visible: true,
      steps: kSteps,
      step: 0,
      children: "BODY-CONTENT",
      footer: "FOOTER-NAV",
    });
    const text = collectText(tree).join(" ");
    expect(text).toContain("BODY-CONTENT");
    expect(text).toContain("FOOTER-NAV");
  });
});
