import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../lib/public/js/components/confirm-dialog.js";
import { ModalShell } from "../../lib/public/js/components/modal-shell.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";

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
const buttons = (tree) => collect(tree).filter((node) => node.type === ActionButton);

describe("frontend/confirm dialog on ModalShell", () => {
  it("renders through ModalShell, named by its title", () => {
    const onCancel = vi.fn();
    const tree = ConfirmDialog({ visible: true, title: "Delete channel?", onCancel });
    expect(tree.type).toBe(ModalShell);
    expect(tree.props.visible).toBe(true);
    expect(tree.props.ariaLabel).toBe("Delete channel?");
    expect(tree.props.closeOnEscape).toBe(true);
    expect(tree.props.closeOnOverlayClick).toBe(true);
    tree.props.onClose();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("passes the Escape and overlay opt-outs through", () => {
    const tree = ConfirmDialog({ visible: true, closeOnEscape: false, closeOnOverlayClick: false });
    expect(tree.props.closeOnEscape).toBe(false);
    expect(tree.props.closeOnOverlayClick).toBe(false);
    expect(() => tree.props.onClose()).not.toThrow();
  });

  it("renders nothing while hidden", () => {
    expect(ConfirmDialog({ visible: false })).toBe(null);
    expect(ConfirmDialog({})).toBe(null);
  });

  it("keeps the defaults of the old API", () => {
    const tree = ConfirmDialog({ visible: true });
    const text = collect(tree).flatMap((node) => [].concat(node.props?.children ?? []))
      .filter((child) => typeof child === "string").join(" ");
    expect(text).toContain("Confirm action");
    expect(text).toContain("Are you sure you want to continue?");
    expect(buttons(tree).map((button) => button.props.idleLabel)).toEqual(["Cancel", "Confirm"]);
    expect(buttons(tree)[1].props.loadingLabel).toBe("Working...");
  });

  it("wires message, details, labels, loading and disabled state", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const details = { type: "div", props: { children: "DETAILS" } };
    const tree = ConfirmDialog({
      visible: true,
      title: "Restart gateway?",
      message: "Running turns stop.",
      details,
      confirmLabel: "Restart",
      confirmLoadingLabel: "Restarting...",
      cancelLabel: "Keep running",
      onConfirm,
      onCancel,
      confirmLoading: true,
      confirmDisabled: true,
    });
    const nodes = collect(tree);
    expect(nodes.find((node) => node.type === "h2").props.children).toBe("Restart gateway?");
    expect(nodes.find((node) => node.type === "p").props.children).toBe("Running turns stop.");
    expect(nodes).toContain(details);
    const [cancel, confirm] = buttons(tree);
    expect(cancel.props.idleLabel).toBe("Keep running");
    expect(cancel.props.disabled).toBe(true);
    expect(cancel.props.onClick).toBe(onCancel);
    expect(confirm.props.idleLabel).toBe("Restart");
    expect(confirm.props.loadingLabel).toBe("Restarting...");
    expect(confirm.props.loading).toBe(true);
    expect(confirm.props.disabled).toBe(true);
    expect(confirm.props.onClick).toBe(onConfirm);
  });

  it("maps confirmTone as before: danger and warning stay, anything else is primary", () => {
    const toneOf = (confirmTone) => buttons(ConfirmDialog({ visible: true, confirmTone }))[1].props.tone;
    expect(toneOf("danger")).toBe("danger");
    expect(toneOf("warning")).toBe("warning");
    expect(toneOf("success")).toBe("primary");
    expect(toneOf(undefined)).toBe("primary");
  });

  it("stays centred and scrolls inside a short viewport", () => {
    const tree = ConfirmDialog({ visible: true });
    expect(tree.props.panelClassName).toContain("my-auto");
    expect(tree.props.panelClassName).toContain("max-h-[calc(100dvh-2rem)] overflow-y-auto");
  });
});
