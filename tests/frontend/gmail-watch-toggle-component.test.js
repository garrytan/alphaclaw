import { describe, expect, it, vi } from "vitest";
import { GmailWatchToggle } from "../../lib/public/js/components/google/gmail-watch-toggle.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { ToggleSwitch } from "../../lib/public/js/components/toggle-switch.js";
import { Badge } from "../../lib/public/js/components/badge.js";

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

const kAccount = { id: "a1", email: "ada@example.com", activeScopes: ["gmail:read"] };

const render = (props) => expandTree(GmailWatchToggle({ account: kAccount, ...props }));

const badgeText = (tree) => collectText(findAllByType(tree, Badge)[0]).join(" ");

describe("frontend/gmail-watch-toggle", () => {
  it("shows Stopped only when the status genuinely loaded", () => {
    const tree = render({ watchStatus: null, statusError: null });
    expect(badgeText(tree)).toContain("Stopped");
    expect(findAllByType(tree, InlineErrorChip).length).toBe(0);
  });

  it("shows Unknown + inline chip + Retry when the status failed to load", () => {
    const onRetryStatus = vi.fn();
    const tree = render({
      watchStatus: null,
      statusError: new Error("config boom"),
      onRetryStatus,
    });

    expect(badgeText(tree)).toContain("Unknown");
    expect(badgeText(tree)).not.toContain("Stopped");

    const chip = findAllByType(tree, InlineErrorChip)[0];
    expect(chip.props.headline).toBe("Couldn't load Gmail watch status.");
    chip.props.onRetry();
    expect(onRetryStatus).toHaveBeenCalledTimes(1);

    // The toggle is gated while the state is unknown.
    const toggle = findAllByType(tree, ToggleSwitch)[0];
    expect(toggle.props.disabled).toBe(true);
  });

  it("renders a persistent chip for a failed enable/disable attempt", () => {
    const tree = render({
      watchStatus: { enabled: false, running: false },
      saveError: { attempted: true, error: new Error("watch boom") },
    });
    const chip = findAllByType(tree, InlineErrorChip)[0];
    expect(chip.props.headline).toBe(
      "Couldn't enable Gmail watch — showing the server's current state.",
    );

    const disableTree = render({
      watchStatus: { enabled: true, running: true },
      saveError: { attempted: false, error: new Error("watch boom") },
    });
    expect(findAllByType(disableTree, InlineErrorChip)[0].props.headline).toBe(
      "Couldn't disable Gmail watch — showing the server's current state.",
    );
  });

  it("keeps the busy affordance while starting/stopping", () => {
    const tree = render({ watchStatus: { enabled: false }, busy: true });
    expect(badgeText(tree)).toContain("Starting");
    const toggle = findAllByType(tree, ToggleSwitch)[0];
    expect(toggle.props.disabled).toBe(true);
    expect(toggle.props.busy).toBe(true);
  });

  it("shows Loading (not a confident Stopped) while the initial config load is in flight", () => {
    const tree = render({ watchStatus: null, statusLoading: true });
    expect(badgeText(tree)).toContain("Loading");
    expect(badgeText(tree)).not.toContain("Stopped");
    const toggle = findAllByType(tree, ToggleSwitch)[0];
    expect(toggle.props.disabled).toBe(true);
    // A loaded status wins over a lingering loading flag.
    const loaded = render({
      watchStatus: { enabled: false },
      statusLoading: true,
    });
    expect(badgeText(loaded)).toContain("Stopped");
  });
});

describe("frontend/gmail watch toggle danger state", () => {
  it("enabled-but-not-running states the observed fact with a VISIBLE remedy", () => {
    const tree = render({ watchStatus: { enabled: true, running: false } });
    const badge = collectNodes(tree).find(
      (node) => node.props?.label === "Watch not running",
    );
    expect(badge).toBeTruthy();
    expect(badge.props.tone).toBe("danger");
    expect(badge.props.text).toContain("renew the watch");
    const text = collectText(tree).join(" ");
    // Required action lives in visible text (doctrine: tooltips never open on
    // touch) and the bare "Error" label is gone.
    expect(text).toContain("renew the watch or check the account's Pub/Sub setup");
    expect(text).not.toMatch(/\bError\b/);
  });
});
