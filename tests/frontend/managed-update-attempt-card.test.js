import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => {
  const slots = [];
  let cursor = 0;
  return {
    useState: (initial) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = value; }];
    },
    useEffect: () => {},
    __render: () => { cursor = 0; },
    __reset: () => { slots.length = 0; cursor = 0; },
  };
});
import * as hooks from "preact/hooks";
import { ManagedUpdateAttemptCard } from "../../lib/public/js/components/managed-update-attempt-card.js";
import { ConfirmDialog } from "../../lib/public/js/components/confirm-dialog.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";

const nodes = (node) => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object"
  ? [node, ...nodes(node.props?.children)] : [];
const render = (managedUpdate) => { hooks.__render(); return ManagedUpdateAttemptCard({ managedUpdate }); };
const find = (tree, type) => nodes(tree).find((node) => node.type === type);
const control = (tree, label) => nodes(tree).find((node) => node.type === ActionButton && node.props.idleLabel === label);
const text = (node) => Array.isArray(node) ? node.map(text).join(" ") : node && typeof node === "object" ? text(node.props?.children) : String(node || "");

describe("managed deployment resolution card", () => {
  beforeEach(() => hooks.__reset());
  const model = (overrides = {}) => ({
    attempt: { id: "attempt-1", state: "unknown", target: { alphaclawVersion: "1.1", ref: "main" } },
    blocked: true, isAdmin: true, resolving: false, retry: vi.fn(), resolve: vi.fn().mockResolvedValue(true),
    ...overrides,
  });

  it("requires an unchecked provider confirmation before resolving the selected attempt", async () => {
    const managed = model();
    let tree = render(managed);
    control(tree, "Provider finished the deployment").props.onClick();
    tree = render(managed);
    let dialog = find(tree, ConfirmDialog);
    expect(dialog.props.visible).toBe(true);
    expect(dialog.props.confirmDisabled).toBe(true);
    await dialog.props.onConfirm();
    expect(managed.resolve).not.toHaveBeenCalled();
    find(dialog.props.details, "input").props.onchange({ currentTarget: { checked: true } });
    tree = render(managed); dialog = find(tree, ConfirmDialog);
    expect(dialog.props.confirmDisabled).toBe(false);
    await dialog.props.onConfirm();
    expect(managed.resolve).toHaveBeenCalledWith("attempt-1", "deployed");
  });

  it("a checked confirmation cannot resolve a newer attempt", async () => {
    const managed = model();
    control(render(managed), "Provider cancelled or did not deploy").props.onClick();
    let dialog = find(render(managed), ConfirmDialog);
    find(dialog.props.details, "input").props.onchange({ currentTarget: { checked: true } });
    const newer = { ...managed, attempt: { ...managed.attempt, id: "attempt-2" } };
    dialog = find(render(newer), ConfirmDialog);
    expect(dialog.props.confirmDisabled).toBe(true);
    await dialog.props.onConfirm();
    expect(managed.resolve).not.toHaveBeenCalled();
  });

  it("shows the pending state to a member without exposing resolution actions", () => {
    const tree = render(model({ isAdmin: false }));
    expect(text(tree)).toContain("Deployment status unknown");
    expect(text(tree)).toContain("An administrator must check");
    expect(control(tree, "Provider finished the deployment")).toBeUndefined();
  });

  it("shows unreadable state with Doctor guidance and a read-only Retry", () => {
    const managed = model({ blocked: false, attempt: null, error: { code: "config_unreadable", message: "Saved state is unreadable" } });
    const tree = render(managed);
    expect(text(tree)).toContain("Open Doctor");
    control(tree, "Retry status check").props.onClick();
    expect(managed.retry).toHaveBeenCalledOnce();
    expect(managed.resolve).not.toHaveBeenCalled();
  });
});
