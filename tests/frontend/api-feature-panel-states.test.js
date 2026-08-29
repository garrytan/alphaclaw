import { describe, expect, it } from "vitest";
import { ApiFeaturePanel } from "../../lib/public/js/components/api-feature-panel.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { ToggleSwitch } from "../../lib/public/js/components/toggle-switch.js";

// Stateless component: invoke it directly and walk the vnode tree
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

const render = (props) => expandTree(ApiFeaturePanel(props));

describe("frontend/api-feature-panel save failure", () => {
  it("renders the failed-enable chip stating the setting is still disabled", () => {
    const error = Object.assign(new Error("config write failed"), {
      hint: "Check permissions.",
    });
    const tree = render({
      openAiCompatApi: { enabled: false, hydrated: true },
      openAiCompatApiError: { attempted: true, error },
    });
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    const text = collectText(tree).join(" ");
    expect(text).toContain("Couldn't enable the API — still disabled.");
    expect(text).toContain("config write failed");
    expect(text).toContain("Check permissions.");
  });

  it("renders the failed-disable variant and no chip when the last save succeeded", () => {
    const failedDisable = render({
      openAiCompatApi: { enabled: true, hydrated: true },
      openAiCompatApiError: { attempted: false, error: new Error("nope") },
    });
    expect(collectText(failedDisable).join(" ")).toContain(
      "Couldn't disable the API — still enabled.",
    );

    const clean = render({
      openAiCompatApi: { enabled: false, hydrated: true },
      openAiCompatApiError: null,
    });
    expect(findAllByType(clean, InlineErrorChip).length).toBe(0);
  });

  it("marks the toggle busy and disabled with a Saving label while a save is in flight", () => {
    const saving = findAllByType(
      render({
        openAiCompatApi: { enabled: false, hydrated: true },
        savingOpenAiCompatApi: true,
      }),
      ToggleSwitch,
    )[0].props;
    expect(saving.busy).toBe(true);
    expect(saving.disabled).toBe(true);
    expect(saving.label).toBe("Saving...");

    const unhydrated = findAllByType(
      render({ openAiCompatApi: { enabled: false } }),
      ToggleSwitch,
    )[0].props;
    expect(unhydrated.disabled).toBe(true);
    expect(unhydrated.label).toBe("Loading...");
  });
});
