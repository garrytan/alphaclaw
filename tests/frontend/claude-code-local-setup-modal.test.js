import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as rescue-session-card tests): hook
// state lives in per-call-index slots so component functions can be invoked
// directly without a DOM renderer. Effects are collected, not run.
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, effects: [] };
  harness.beginRender = () => {
    harness.cursor = 0;
    harness.effects = [];
  };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
    harness.effects = [];
  };
  const useState = (initialValue) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] =
        typeof initialValue === "function" ? initialValue() : initialValue;
    }
    const setState = (next) => {
      harness.slots[index] =
        typeof next === "function" ? next(harness.slots[index]) : next;
    };
    return [harness.slots[index], setState];
  };
  const useRef = (initialValue = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = { current: initialValue };
    }
    return harness.slots[index];
  };
  const useMemo = (factory) => factory();
  const useCallback = (fn) => fn;
  const useEffect = (effect) => {
    harness.effects.push(effect);
  };
  return { useState, useRef, useMemo, useCallback, useEffect, __harness: harness };
});

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import {
  ClaudeCodeLocalSetupModal,
  deriveSetupStage,
} from "../../lib/public/js/components/claude-code-local-setup-modal.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { ModalShell } from "../../lib/public/js/components/modal-shell.js";

const harness = preactHooks.__harness;

// ModalShell portals into document.body (absent under the node environment);
// walk its children props instead of expanding it.
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

const treeText = (tree) => collectText(tree).join(" ").replace(/\s+/g, " ");

const buttonLabels = (tree) =>
  findAllByType(tree, ActionButton).map((vnode) => vnode.props.idleLabel);

const kOauthUrl = "https://claude.ai/oauth/authorize?code=true";

const loginLocal = (phase, extras = {}) => ({
  enabled: true,
  state: "login_in_progress",
  login: { phase, ...extras },
});

const renderModal = (props = {}) => {
  harness.beginRender();
  return expandTree(
    ClaudeCodeLocalSetupModal({
      visible: true,
      local: { enabled: true, state: "needs_login" },
      onClose: vi.fn(),
      onBeginLogin: vi.fn(),
      onSubmitCode: vi.fn(),
      onCancelLogin: vi.fn(),
      onStartSession: vi.fn(),
      fetchTail: vi.fn(),
      ...props,
    }),
  );
};

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
});

describe("deriveSetupStage", () => {
  it("maps login phases and terminal states", () => {
    expect(deriveSetupStage({ state: "needs_login" }, false)).toBe("intro");
    expect(deriveSetupStage(loginLocal("starting"), true)).toBe("starting");
    expect(
      deriveSetupStage(loginLocal("awaiting_code", { oauthUrl: kOauthUrl }), true),
    ).toBe("awaiting_code");
    expect(deriveSetupStage(loginLocal("verifying"), true)).toBe("verifying");
    expect(
      deriveSetupStage({ state: "ready", login: { phase: "success" } }, true),
    ).toBe("success");
    expect(
      deriveSetupStage(
        { state: "needs_login", login: { phase: "failed", error: "nope" } },
        true,
      ),
    ).toBe("failed");
    // A stale success from a PREVIOUS login (before this open) is not a
    // success screen — the operator just opened the modal to log in again.
    expect(
      deriveSetupStage({ state: "needs_login", login: { phase: "success" } }, false),
    ).toBe("intro");
  });
});

describe("ClaudeCodeLocalSetupModal render states", () => {
  it("intro explains credential storage and offers the login CTA", () => {
    const tree = renderModal();
    const text = treeText(tree);
    expect(text).toContain("a private directory on this server");
    expect(text).toContain("never in .env");
    expect(buttonLabels(tree)).toContain("Log in with claude.ai");
  });

  it("starting shows a spinner line", () => {
    const tree = renderModal({ local: loginLocal("starting") });
    expect(treeText(tree)).toContain("Starting the Claude CLI login");
  });

  it("awaiting_code shows the OAuth link (new tab, noopener), a monospace input, and Submit", () => {
    const tree = renderModal({
      local: loginLocal("awaiting_code", { oauthUrl: kOauthUrl }),
    });
    const link = findAllByType(tree, "a").find(
      (vnode) => vnode.props.href === kOauthUrl,
    );
    expect(link).toBeTruthy();
    expect(link.props.target).toBe("_blank");
    expect(link.props.rel).toBe("noopener");
    const input = findAllByType(tree, "input")[0];
    expect(input).toBeTruthy();
    expect(String(input.props.class)).toContain("font-mono");
    expect(buttonLabels(tree)).toContain("Submit");
  });

  it("Submit hands the pasted code to onSubmitCode", async () => {
    const onSubmitCode = vi.fn().mockResolvedValue({ ok: true });
    renderModal({
      local: loginLocal("awaiting_code", { oauthUrl: kOauthUrl }),
      onSubmitCode,
    });
    // Slot 1 is the code input state (begunThisOpen, code, busy, tail, ...).
    harness.slots[1] = "  ABC-123  ";
    const tree = renderModal({
      local: loginLocal("awaiting_code", { oauthUrl: kOauthUrl }),
      onSubmitCode,
    });
    const submit = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Submit",
    );
    await submit.props.onClick();
    expect(onSubmitCode).toHaveBeenCalledWith("ABC-123");
  });

  it("verifying shows the verification line", () => {
    const tree = renderModal({ local: loginLocal("verifying") });
    expect(treeText(tree)).toContain("Verifying the login");
  });

  it("success offers Start rescue session now, wired through onStartSession", () => {
    harness.slots[0] = true; // begunThisOpen
    const onStartSession = vi.fn();
    const onClose = vi.fn();
    const tree = renderModal({
      local: { enabled: true, state: "ready", login: { phase: "success" } },
      onStartSession,
      onClose,
    });
    const startButton = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Start rescue session now",
    );
    expect(startButton).toBeTruthy();
    startButton.props.onClick();
    expect(onClose).toHaveBeenCalled();
    expect(onStartSession).toHaveBeenCalled();
  });

  it("failed shows the error, Retry, and the CLI-output escape hatch (login tail)", async () => {
    const fetchTail = vi.fn().mockResolvedValue({ ok: true, tail: "cli says no" });
    const tree = renderModal({
      local: {
        enabled: true,
        state: "needs_login",
        login: { phase: "failed", error: "The CLI rejected the login code." },
      },
      fetchTail,
    });
    const text = treeText(tree);
    expect(text).toContain("The CLI rejected the login code.");
    expect(buttonLabels(tree)).toContain("Retry");
    const toggle = findAllByType(tree, "button").find((vnode) =>
      collectText(vnode.props.children).join("").includes("Show CLI output"),
    );
    expect(toggle).toBeTruthy();
    await toggle.props.onclick();
    expect(fetchTail).toHaveBeenCalledWith({ source: "login" });
  });

  it("closing mid-flow cancels the server-side login", () => {
    const onCancelLogin = vi.fn().mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    const tree = renderModal({
      local: loginLocal("awaiting_code", { oauthUrl: kOauthUrl }),
      onCancelLogin,
      onClose,
    });
    const shell = findAllByType(tree, ModalShell)[0];
    shell.props.onClose();
    expect(onCancelLogin).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closing from intro does NOT cancel (nothing is in flight)", () => {
    const onCancelLogin = vi.fn();
    const onClose = vi.fn();
    const tree = renderModal({ onCancelLogin, onClose });
    const shell = findAllByType(tree, ModalShell)[0];
    shell.props.onClose();
    expect(onCancelLogin).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
