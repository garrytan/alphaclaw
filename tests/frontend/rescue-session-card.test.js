import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as gateway-card tests): hook state lives
// in per-call-index slots so component functions can be invoked directly
// without a DOM renderer. Effects are collected, not run.
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

vi.mock("../../lib/public/js/hooks/use-claude-code-local.js", () => ({
  useClaudeCodeLocal: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import { useClaudeCodeLocal } from "../../lib/public/js/hooks/use-claude-code-local.js";
import {
  WatchdogRescueSessionCard,
  buildRescueQrModel,
  kRescueStateBadge,
} from "../../lib/public/js/components/watchdog-tab/rescue-session-card.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { Badge } from "../../lib/public/js/components/badge.js";
import { ModalShell } from "../../lib/public/js/components/modal-shell.js";
import { ClaudeCodeConfirmModal } from "../../lib/public/js/components/claude-code-confirm-modal.js";
import { ClaudeCodeLocalSetupModal } from "../../lib/public/js/components/claude-code-local-setup-modal.js";

const harness = preactHooks.__harness;

const kLocalSessionUrl = "https://claude.ai/code/rescue_01XYZ";

// ModalShell portals into document.body (absent under the node environment);
// the modals stay unexpanded — their own suite covers them.
const kSkipExpand = new Set([ModalShell, ClaudeCodeConfirmModal, ClaudeCodeLocalSetupModal]);

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

// htm splits interpolations into separate text nodes — collapse whitespace so
// assertions match the rendered prose, not the template's node boundaries.
const treeText = (tree) => collectText(tree).join(" ").replace(/\s+/g, " ");

const buttonLabels = (tree) =>
  findAllByType(tree, ActionButton).map((vnode) => vnode.props.idleLabel);

const makeHookState = (local) => ({
  local,
  refresh: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  login: { begin: vi.fn(), submitCode: vi.fn(), cancel: vi.fn() },
  logout: vi.fn(),
  fetchTail: vi.fn(),
});

const renderCard = (local) => {
  useClaudeCodeLocal.mockReturnValue(makeHookState(local));
  harness.beginRender();
  return expandTree(WatchdogRescueSessionCard({}));
};

const baseLocal = (overrides = {}) => ({
  enabled: true,
  state: "ready",
  hosting: "tmux",
  claudeVersion: "2.1.237",
  sessionName: "alphaclaw-rescue",
  sessionUrl: null,
  sessionId: null,
  permissionMode: "acceptEdits",
  livePermissionMode: null,
  autostart: false,
  spawnOnIncident: true,
  cwd: "/data/claude-code-local/workspace",
  startedAt: null,
  spawnedBy: null,
  socketPath: "/data/claude-code-local/tmux.sock",
  warnings: [],
  freshAt: Date.now(),
  ...overrides,
});

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
});

describe("buildRescueQrModel (known vector)", () => {
  it("encodes a fixed URL to a stable, deterministic module grid", () => {
    const first = buildRescueQrModel(kLocalSessionUrl);
    const second = buildRescueQrModel(kLocalSessionUrl);
    // Pinned against qrcode-generator 2.0.4 (type auto, level M): a bump that
    // changes the encoding surfaces here, not as a silently different QR.
    expect(first.moduleCount).toBe(29);
    expect(first.viewBoxSize).toBe(33);
    expect(first.path.length).toBeGreaterThan(0);
    expect(first.path.match(/h1v1h-1z/g).length).toBe(428);
    expect(second).toEqual(first);
  });

  it("returns null for empty input (card falls back to the plain URL)", () => {
    expect(buildRescueQrModel("")).toBe(null);
    expect(buildRescueQrModel(null)).toBe(null);
  });
});

describe("WatchdogRescueSessionCard render states", () => {
  it("renders nothing without a local block (old server)", () => {
    expect(renderCard(null)).toBe(null);
  });

  it("shows the right badge for every state", () => {
    for (const [state, badge] of Object.entries(kRescueStateBadge)) {
      harness.reset();
      const local = baseLocal({
        state,
        sessionUrl: state === "running" ? kLocalSessionUrl : null,
        startedAt: state === "running" ? Date.now() - 60_000 : null,
        error:
          state === "error"
            ? { code: "spawn_failed", message: "boom", tailSanitized: "tail" }
            : undefined,
      });
      const tree = renderCard(local);
      const badges = findAllByType(tree, Badge);
      expect(
        badges.some((vnode) => collectText(vnode.props.children).join("") === badge.label),
        `badge for ${state}`,
      ).toBe(true);
    }
  });

  it("lists warnings", () => {
    const tree = renderCard(
      baseLocal({ warnings: ["tmux is not installed — sessions die with AlphaClaw"] }),
    );
    expect(treeText(tree)).toContain("tmux is not installed");
  });

  it("needs_login shows the Log in CTA", () => {
    const tree = renderCard(baseLocal({ state: "needs_login" }));
    expect(buttonLabels(tree)).toContain("Log in to Claude");
    expect(buttonLabels(tree)).not.toContain("Start session");
  });

  it("ready shows Start + Log out", () => {
    const tree = renderCard(baseLocal({ state: "ready" }));
    expect(buttonLabels(tree)).toContain("Start session");
    expect(buttonLabels(tree)).toContain("Log out");
  });

  it("running shows URL link, QR, attach hint, spawnedBy, and Stop", () => {
    const tree = renderCard(
      baseLocal({
        state: "running",
        sessionUrl: kLocalSessionUrl,
        startedAt: Date.now() - 5 * 60_000,
        spawnedBy: "click",
        livePermissionMode: "acceptEdits",
      }),
    );
    const labels = buttonLabels(tree);
    expect(labels).toContain("Stop session");
    expect(labels).not.toContain("Start session");
    // Plain selectable URL always renders (D16 — never QR-only).
    const urlLink = findAllByType(tree, "a").find(
      (vnode) => vnode.props.href === kLocalSessionUrl,
    );
    expect(urlLink).toBeTruthy();
    expect(urlLink.props.rel).toBe("noopener");
    const svg = findAllByType(tree, "svg").find(
      (vnode) => vnode.props.role === "img",
    );
    expect(svg).toBeTruthy();
    expect(svg.props["aria-label"]).toBe("QR code for the rescue session URL");
    const text = treeText(tree);
    expect(text).toContain("started by click");
    expect(text).toContain("tmux -S");
    expect(text).toContain("/data/claude-code-local/tmux.sock");
    expect(text).toContain("alphaclaw-rescue");
    expect(text).toContain("running since");
  });

  it("running with mode drift shows the restart-to-apply hint", () => {
    const tree = renderCard(
      baseLocal({
        state: "running",
        sessionUrl: kLocalSessionUrl,
        startedAt: Date.now(),
        permissionMode: "bypassPermissions",
        livePermissionMode: "acceptEdits",
      }),
    );
    const text = treeText(tree);
    expect(text).toContain("restart the");
    expect(text).toContain("bypassPermissions");
  });

  it("script hosting omits the tmux attach hint", () => {
    const tree = renderCard(
      baseLocal({
        state: "running",
        hosting: "script",
        sessionUrl: kLocalSessionUrl,
        startedAt: Date.now(),
      }),
    );
    expect(treeText(tree)).not.toContain("tmux -S");
  });

  it("error shows the message and the collapsible tail toggle", () => {
    const tree = renderCard(
      baseLocal({
        state: "error",
        error: {
          code: "url_extract_timeout",
          message: "URL never appeared",
          tailSanitized: "raw tail",
        },
      }),
    );
    const text = treeText(tree);
    expect(text).toContain("URL never appeared");
    expect(text).toContain("Show CLI output");
    expect(buttonLabels(tree)).toContain("Retry start");
  });

  it("disabled with a live session collapses to stop-only", () => {
    // E2: the kill switch hides the launch path but must never cut off an
    // operator mid-rescue.
    const tree = renderCard(
      baseLocal({
        state: "disabled",
        enabled: false,
        startedAt: Date.now() - 60_000,
        warnings: ["Local rescue is disabled but a session is still live — stop it from this card."],
      }),
    );
    const labels = buttonLabels(tree);
    expect(labels).toContain("Stop session");
    expect(labels).not.toContain("Start session");
    expect(labels).not.toContain("Log in to Claude");
    expect(treeText(tree)).toContain("session is still live");
  });

  it("passes the configured permission mode to the local confirm modal", () => {
    const tree = renderCard(baseLocal({ permissionMode: "bypassPermissions" }));
    const modal = findAllByType(tree, ClaudeCodeConfirmModal)[0];
    expect(modal).toBeTruthy();
    expect(modal.props.mode).toBe("local");
    expect(modal.props.permissionMode).toBe("bypassPermissions");
  });
});
