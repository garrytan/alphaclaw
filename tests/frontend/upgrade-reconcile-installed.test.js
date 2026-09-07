import { describe, expect, it, vi } from "vitest";
import { ReconcileInstalledCard } from "../../lib/public/js/components/upgrade-tab/reconcile-installed-card.js";
import { buildReconcileInstalledModel } from "../../lib/public/js/components/upgrade-tab/helpers.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { kReconcileInstalledCopy, kLifecycleActionBlockReasons } from "../../lib/server/gateway-state.js";

// Stateless component: invoke it directly and walk the vnode tree
// (upgrade-cards-states.test.js pattern) — no DOM renderer needed.
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
const findAllByType = (tree, type) => collectNodes(tree).filter((vnode) => vnode.type === type);

// The server's GET /api/openclaw/channel block, as the route serializes it:
// the whole catalog entry rides along so the client never inlines copy.
const makeChannelInfo = (overrides = {}, block = {}) => ({
  installedVersion: "2026.7.1-2",
  expectedVersion: "2026.9.1-beta.1",
  installedDiverged: true,
  reconcileInstalled: {
    available: true,
    blocked: null,
    copy: kReconcileInstalledCopy,
    ...block,
  },
  ...overrides,
});

describe("frontend/upgrade-tab reconcile-installed model (#76 B1.2 / CEO 11.1)", () => {
  it("renders only while installedDiverged AND the server advertises the action, with the catalog copy verbatim", () => {
    const model = buildReconcileInstalledModel(makeChannelInfo());
    expect(model).toEqual({
      title: kReconcileInstalledCopy.title,
      description: kReconcileInstalledCopy.description,
      actionLabel: kReconcileInstalledCopy.actionLabel,
      loadingLabel: kReconcileInstalledCopy.loadingLabel,
      installed: "2026.7.1-2",
      expected: "2026.9.1-beta.1",
      disabledReason: null,
      blockedCode: null,
    });
    expect(buildReconcileInstalledModel(makeChannelInfo({ installedDiverged: false }))).toBeNull();
    expect(buildReconcileInstalledModel(makeChannelInfo({}, { available: false }))).toBeNull();
    // Older server: no block at all → no card (never a card with empty copy).
    expect(buildReconcileInstalledModel({ installedDiverged: true })).toBeNull();
    expect(buildReconcileInstalledModel(makeChannelInfo({}, { copy: null }))).toBeNull();
    expect(buildReconcileInstalledModel(null)).toBeNull();
  });

  it("carries the server's blocker verdict as the disabled reason", () => {
    const model = buildReconcileInstalledModel(
      makeChannelInfo(
        {},
        {
          blocked: {
            code: "apply_in_progress",
            disabledReason: kLifecycleActionBlockReasons.operation,
          },
        },
      ),
    );
    expect(model.disabledReason).toBe(kLifecycleActionBlockReasons.operation);
    expect(model.blockedCode).toBe("apply_in_progress");
  });
});

describe("frontend/upgrade-tab ReconcileInstalledCard states", () => {
  const idleModel = () => buildReconcileInstalledModel(makeChannelInfo());

  it("hidden without a model", () => {
    expect(ReconcileInstalledCard({ model: null })).toBe(null);
  });

  it("idle: title, versions, description and an enabled primary action wired to onReconcileInstalled", () => {
    const onReconcileInstalled = vi.fn();
    const tree = expandTree(ReconcileInstalledCard({ model: idleModel(), onReconcileInstalled }));
    const text = collectText(tree).join(" ");
    expect(text).toContain(kReconcileInstalledCopy.title);
    expect(text).toContain(kReconcileInstalledCopy.description);
    expect(text).toContain("2026.7.1-2");
    expect(text).toContain("2026.9.1-beta.1");
    const [button] = findAllByType(tree, ActionButton);
    expect(button.props).toEqual(
      expect.objectContaining({
        idleLabel: kReconcileInstalledCopy.actionLabel,
        loadingLabel: kReconcileInstalledCopy.loadingLabel,
        loading: false,
        disabled: false,
        tone: "primary",
      }),
    );
    button.props.onClick();
    expect(onReconcileInstalled).toHaveBeenCalledTimes(1);
  });

  it("loading: the ActionButton shows its loading label and stays enabled for itself while other actions are disabled", () => {
    const tree = expandTree(
      ReconcileInstalledCard({ model: idleModel(), reconcilingInstalled: true, actionsDisabled: true }),
    );
    const [button] = findAllByType(tree, ActionButton);
    expect(button.props.loading).toBe(true);
    expect(button.props.disabled).toBe(false);
    // A sibling operation (not this one) disables the action.
    const other = expandTree(ReconcileInstalledCard({ model: idleModel(), actionsDisabled: true }));
    expect(findAllByType(other, ActionButton)[0].props.disabled).toBe(true);
  });

  it("blocked: disabled button + the server's disabledReason chip verbatim", () => {
    const model = buildReconcileInstalledModel(
      makeChannelInfo(
        {},
        { blocked: { code: "booting", disabledReason: kLifecycleActionBlockReasons.operation } },
      ),
    );
    const tree = expandTree(ReconcileInstalledCard({ model }));
    const [button] = findAllByType(tree, ActionButton);
    expect(button.props.disabled).toBe(true);
    expect(button.props.title).toBe(kLifecycleActionBlockReasons.operation);
    expect(collectText(tree).join(" ")).toContain(kLifecycleActionBlockReasons.operation);
  });

  it("error: a persistent InlineErrorChip with the envelope + a Dismiss button", () => {
    const onDismiss = vi.fn();
    const error = Object.assign(new Error("A gateway process is still running"), {
      code: "incumbent_running",
      hint: "Stop the process, then retry.",
    });
    const tree = expandTree(
      ReconcileInstalledCard({
        model: idleModel(),
        reconcileInstalledError: { headline: kReconcileInstalledCopy.errorHeadline, error },
        onDismissReconcileInstalledError: onDismiss,
      }),
    );
    const [chip] = findAllByType(tree, InlineErrorChip);
    expect(chip.props.headline).toBe(kReconcileInstalledCopy.errorHeadline);
    expect(chip.props.error).toBe(error);
    const dismiss = collectNodes(tree).find(
      (vnode) => vnode.type === "button" && collectText(vnode.props.children).join("").includes("Dismiss"),
    );
    expect(dismiss).toBeTruthy();
    dismiss.props.onclick();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
