import { describe, expect, it, vi } from "vitest";

// The confirm modal is a pure component (no hooks), so it renders directly.
// ModalShell portals into document.body (absent under the node environment);
// walk its children props instead of expanding it.
import { ClaudeCodeConfirmModal } from "../../lib/public/js/components/claude-code-confirm-modal.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { ModalShell } from "../../lib/public/js/components/modal-shell.js";

const kSkipExpand = new Set([ModalShell]);

const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function" && !kSkipExpand.has(node.type)) {
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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

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

// htm splits interpolations into separate text nodes; collapse whitespace so
// assertions match the rendered prose, not the template's node boundaries.
const treeText = (tree) => collectText(tree).join(" ").replace(/\s+/g, " ");

const renderModal = (props = {}) =>
  expandTree(
    ClaudeCodeConfirmModal({
      visible: true,
      onStart: vi.fn(),
      onCancel: vi.fn(),
      ...props,
    }),
  );

describe("ClaudeCodeConfirmModal copy", () => {
  it("routine mode explains the autonomous billed run", () => {
    const tree = renderModal();
    const text = treeText(tree);
    expect(text).toContain("Start a Claude Code session?");
    expect(text).toContain(
      "This fires your routine — an autonomous run on your claude.ai account that uses subscription usage.",
    );
  });

  it("local mode names the server, the injection risk, and the data disclosure", () => {
    const tree = renderModal({ mode: "local", permissionMode: "acceptEdits" });
    const text = treeText(tree);
    expect(text).toContain(
      "Start a rescue Claude Code session on this server?",
    );
    expect(text).toContain(
      "It can read content on this box — including untrusted logs, which carry a prompt-injection risk — and transmits selected content to Anthropic as part of operating Claude Code.",
    );
  });

  it("names the permission mode the session will run under (codex 13)", () => {
    expect(
      treeText(renderModal({ mode: "local", permissionMode: "bypassPermissions" })),
    ).toContain(
      "Permission mode: bypassPermissions — the session runs commands and edits files WITHOUT any approval prompts.",
    );
    expect(
      treeText(renderModal({ mode: "local", permissionMode: "acceptEdits" })),
    ).toContain(
      "Permission mode: acceptEdits — file edits are auto-approved; commands still require approval in the session.",
    );
    expect(treeText(renderModal({ mode: "local" }))).toContain(
      "Permission mode: default.",
    );
  });
});

describe("ClaudeCodeConfirmModal buttons", () => {
  it("renders bare size=md ActionButtons (no className fighting the size internals)", () => {
    const tree = renderModal({ mode: "local", permissionMode: "acceptEdits" });
    const buttons = findAllByType(tree, ActionButton);
    expect(buttons.map((vnode) => vnode.props.idleLabel)).toEqual([
      "Cancel",
      "Start session",
    ]);
    for (const button of buttons) {
      expect(button.props.size).toBe("md");
      expect(button.props.className).toBeUndefined();
    }
  });

  it("wires Start and Cancel, and Escape/overlay close is Cancel", () => {
    const onStart = vi.fn();
    const onCancel = vi.fn();
    const tree = renderModal({ onStart, onCancel });
    const buttons = findAllByType(tree, ActionButton);
    buttons.find((vnode) => vnode.props.idleLabel === "Start session").props.onClick();
    expect(onStart).toHaveBeenCalledTimes(1);
    buttons.find((vnode) => vnode.props.idleLabel === "Cancel").props.onClick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    const shell = findAllByType(tree, ModalShell)[0];
    shell.props.onClose();
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
