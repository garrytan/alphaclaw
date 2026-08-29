import { describe, expect, it } from "vitest";
import { SavedToggle } from "../../lib/public/js/components/saved-toggle.js";
import { AsyncSection } from "../../lib/public/js/components/async-section.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { ToggleSwitch } from "../../lib/public/js/components/toggle-switch.js";

// Stateless components: invoke them directly and walk the vnode tree
// (upgrade-tab.test.js pattern) — no DOM renderer needed.
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

const renderToggle = (props) => expandTree(SavedToggle(props));
const toggleProps = (tree) => findAllByType(tree, ToggleSwitch)[0]?.props;

describe("frontend/saved-toggle", () => {
  it("renders the label matrix: Loading / Saving / on / off", () => {
    expect(toggleProps(renderToggle({ hydrated: false })).label).toBe("Loading...");
    expect(toggleProps(renderToggle({ hydrated: true, saving: true })).label).toBe("Saving...");
    expect(toggleProps(renderToggle({ hydrated: true, value: true })).label).toBe("Enabled");
    expect(toggleProps(renderToggle({ hydrated: true, value: false })).label).toBe("Disabled");
  });

  it("supports custom on/off labels", () => {
    const tree = renderToggle({
      hydrated: true,
      value: true,
      labels: { on: "Running", off: "Stopped" },
    });
    expect(toggleProps(tree).label).toBe("Running");
    expect(
      toggleProps(renderToggle({ hydrated: true, value: false, labels: { on: "Running", off: "Stopped" } })).label,
    ).toBe("Stopped");
  });

  it("disables while saving, unhydrated, load-failed, or explicitly disabled", () => {
    expect(toggleProps(renderToggle({ hydrated: false })).disabled).toBe(true);
    expect(toggleProps(renderToggle({ hydrated: true, saving: true })).disabled).toBe(true);
    expect(toggleProps(renderToggle({ hydrated: true, loadError: new Error("x") })).disabled).toBe(true);
    expect(toggleProps(renderToggle({ hydrated: true, disabled: true })).disabled).toBe(true);
    expect(toggleProps(renderToggle({ hydrated: true })).disabled).toBe(false);
  });

  it("marks the toggle busy for screen readers while saving", () => {
    expect(toggleProps(renderToggle({ hydrated: true, saving: true })).busy).toBe(true);
    expect(toggleProps(renderToggle({ hydrated: true })).busy).toBe(false);
  });

  it("renders a load-failure chip with Retry instead of presenting the default as fact", () => {
    const onRetryLoad = () => {};
    const tree = renderToggle({ hydrated: true, loadError: new Error("offline"), onRetryLoad });
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.onRetry).toBe(onRetryLoad);
    expect(collectText(tree).join(" ")).toContain("Couldn't load this setting.");
  });

  it("renders the save-error chip with the describe() headline and envelope detail", () => {
    const error = Object.assign(new Error("write failed"), { hint: "Check disk space." });
    const tree = renderToggle({
      hydrated: true,
      value: false,
      saveError: { attempted: true, error, context: null },
      describe: (attempted) =>
        attempted ? "Couldn't enable the overseer — still disabled." : "Couldn't disable the overseer — still enabled.",
    });
    const text = collectText(tree).join(" ");
    expect(text).toContain("Couldn't enable the overseer — still disabled.");
    expect(text).toContain("write failed");
    expect(text).toContain("Check disk space.");
  });

  it("scopes saving and errors by context on document-level hooks", () => {
    // The in-flight commit belongs to a sibling control: this one disables
    // but must not claim "Saving..." or render the sibling's error.
    const sibling = renderToggle({
      hydrated: true,
      value: true,
      saving: true,
      savingContext: "notify",
      context: "autoRepair",
      saveError: { attempted: false, error: new Error("nope"), context: "notify" },
    });
    expect(toggleProps(sibling).label).toBe("Enabled");
    expect(toggleProps(sibling).disabled).toBe(true);
    expect(findAllByType(sibling, InlineErrorChip).length).toBe(0);

    const mine = renderToggle({
      hydrated: true,
      value: false,
      saving: true,
      savingContext: "autoRepair",
      context: "autoRepair",
    });
    expect(toggleProps(mine).label).toBe("Saving...");
  });
});

describe("frontend/async-section", () => {
  const render = (props) => expandTree(AsyncSection(props));

  it("renders the error chip (with Retry) ahead of everything else", () => {
    const onRetry = () => {};
    const tree = render({ error: new Error("boom"), onRetry, loading: true, empty: true });
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.onRetry).toBe(onRetry);
  });

  it("renders a loading line while loading", () => {
    const tree = render({ loading: true, loadingLabel: "Loading incidents..." });
    expect(collectText(tree).join(" ")).toContain("Loading incidents...");
  });

  it("renders a distinct empty state", () => {
    const tree = render({ empty: true, emptyLabel: "No incidents recorded." });
    expect(collectText(tree).join(" ")).toContain("No incidents recorded.");
  });

  it("renders children when there is data", () => {
    const tree = render({ children: "the-list" });
    expect(collectText(tree).join(" ")).toContain("the-list");
  });
});

describe("frontend/inline-error-chip", () => {
  it("returns null with neither error nor headline", () => {
    expect(InlineErrorChip({})).toBe(null);
  });

  it("announces politely and carries hint + docsUrl from the envelope", () => {
    const error = Object.assign(new Error("failed"), {
      hint: "Try again.",
      docsUrl: "https://docs.example/x",
    });
    const tree = expandTree(InlineErrorChip({ error, headline: "Couldn't save." }));
    const root = collectNodes(tree).find((n) => n.type === "div");
    expect(root.props.role).toBe("status");
    expect(root.props["aria-live"]).toBe("polite");
    const text = collectText(tree).join(" ");
    expect(text).toContain("Couldn't save.");
    expect(text).toContain("failed");
    expect(text).toContain("Try again.");
    const link = collectNodes(tree).find((n) => n.type === "a");
    expect(link.props.href).toBe("https://docs.example/x");
  });

  it("never renders a non-http(s) docsUrl as a link", () => {
    // Envelopes chain from gateway/CLI response bodies — a javascript: URL
    // must not become an anchor in the admin UI.
    for (const docsUrl of [
      // eslint-disable-next-line no-script-url
      "javascript:alert(1)",
      "data:text/html,x",
      "not a url",
    ]) {
      const error = Object.assign(new Error("failed"), { docsUrl });
      const tree = expandTree(InlineErrorChip({ error, headline: "Oops." }));
      expect(collectNodes(tree).find((n) => n.type === "a")).toBe(undefined);
    }
    // http stays allowed alongside https.
    const httpError = Object.assign(new Error("failed"), {
      docsUrl: "http://docs.example/x",
    });
    const httpTree = expandTree(InlineErrorChip({ error: httpError }));
    expect(collectNodes(httpTree).find((n) => n.type === "a").props.href).toBe(
      "http://docs.example/x",
    );
  });
});
