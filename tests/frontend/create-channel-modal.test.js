import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same per-slot hook harness as upgrade-tab.test.js: state survives across
// renders; effects are collected and run manually.
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

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchChannelAccountToken: vi.fn(async () => ({ token: "" })),
  fetchOpenclawCapabilities: vi.fn(),
}));
// channels.js drags in a CDN import chain — stub the two named imports.
vi.mock("../../lib/public/js/components/channels.js", () => ({
  ALL_CHANNELS: ["telegram", "discord", "slack", "whatsapp", "clickclack"],
  getChannelMeta: (id) => ({
    label: id === "clickclack" ? "ClickClack" : id,
    icon: null,
  }),
}));
vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
}));
const kCapsState = { payload: null };
vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: () => ({ data: kCapsState.payload, loading: false }),
}));

import * as preactHooks from "preact/hooks";
import {
  CreateChannelModal,
  buildSlackManifest,
} from "../../lib/public/js/components/agents-tab/create-channel-modal.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { SecretInput } from "../../lib/public/js/components/secret-input.js";

const harness = preactHooks.__harness;

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

const kProps = {
  visible: true,
  mode: "create",
  agents: [{ id: "main", name: "Main" }],
  existingChannels: [],
  initialAgentId: "main",
  initialProvider: "clickclack",
};

const render = (props = kProps) => {
  harness.beginRender();
  const tree = expandTree(CreateChannelModal(props));
  return tree;
};

// Mount + run collected effects (provider/name initialization), then re-render.
const mount = (props = kProps) => {
  render(props);
  for (const effect of [...harness.effects]) {
    try {
      effect();
    } catch {}
  }
  return render(props);
};

const findSecretInputByPlaceholder = (tree, fragment) =>
  collectNodes(tree).find(
    (vnode) =>
      vnode.type === SecretInput &&
      String(vnode.props.placeholder || "").includes(fragment),
  );

const findActionButtonByLabel = (tree, label) =>
  collectNodes(tree).find(
    (vnode) => vnode.type === ActionButton && vnode.props.idleLabel === label,
  );

describe("frontend/create-channel-modal slack manifest (3.1)", () => {
  it("includes the /login slash command and stays under Slack's 25-command cap", () => {
    const manifest = JSON.parse(buildSlackManifest("My Claw"));
    const commands = manifest.features?.slash_commands || manifest.slash_commands || [];
    const flat = JSON.stringify(manifest);
    expect(flat).toContain('"/login"');
    const commandCount = (flat.match(/"command":/g) || []).length;
    expect(commandCount).toBeGreaterThan(0);
    expect(commandCount).toBeLessThanOrEqual(25);
    void commands;
  });
});

describe("frontend/create-channel-modal clickclack (5.1/5.3/D15)", () => {
  beforeEach(() => {
    harness.reset();
    kCapsState.payload = { capabilities: { clickclackGuidedSetup: true } };
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the guided paste field FIRST with D15 copy, then the manual fields", () => {
    const tree = mount();
    const text = collectText(tree).join(" ");
    expect(text).toContain("ClickClack setup code or URL");
    expect(text).toContain("single-use and expire in 10 minutes");
    expect(text).toContain("Or configure manually with a bot token:");
    expect(text).toContain("Base URL (manual setup)");
    // The paste field is a SecretInput (never echoed).
    expect(
      findSecretInputByPlaceholder(tree, "Paste the code or URL"),
    ).toBeTruthy();
  });

  it("falls back to setup-URL-only copy when the beta code flow is unsupported", () => {
    kCapsState.payload = { capabilities: { clickclackGuidedSetup: false } };
    const tree = mount();
    const text = collectText(tree).join(" ");
    expect(text).toContain("ClickClack setup URL");
    expect(text).toContain("Raw setup codes need OpenClaw 2026.8+");
    expect(
      findSecretInputByPlaceholder(tree, "Paste the setup URL"),
    ).toBeTruthy();
  });

  it("guided submit sends setupValue (no token) and CLEARS the pasted secret (D15)", async () => {
    const onSubmit = vi.fn(async () => {});
    const props = { ...kProps, onSubmit };
    let tree = mount(props);

    const pasteField = findSecretInputByPlaceholder(tree, "Paste the code or URL");
    pasteField.props.onInput({ target: { value: "cc-setup-code-123" } });
    tree = render(props);

    const submit = findActionButtonByLabel(tree, "Create Channel");
    expect(submit).toBeTruthy();
    await submit.props.onClick();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.provider).toBe("clickclack");
    expect(payload.setupValue).toBe("cc-setup-code-123");
    expect(payload.token).toBeUndefined();

    // Single-use: the pasted value never survives a submit attempt.
    tree = render(props);
    expect(
      findSecretInputByPlaceholder(tree, "Paste the code or URL").props.value,
    ).toBe("");
  });

  it("manual submit sends token + baseUrl and no setupValue", async () => {
    const onSubmit = vi.fn(async () => {});
    const props = { ...kProps, onSubmit };
    let tree = mount(props);

    const tokenField = findSecretInputByPlaceholder(tree, "Paste bot token");
    tokenField.props.onInput({ target: { value: "ccb_manual" } });
    tree = render(props);
    const baseUrlInput = collectNodes(tree).find(
      (vnode) =>
        vnode.type === "input" &&
        String(vnode.props.placeholder || "").includes("clickclack.dev"),
    );
    // Plain-DOM vnodes carry the lowercased attribute name.
    (baseUrlInput.props.oninput || baseUrlInput.props.onInput)({
      target: { value: "https://ws.clickclack.dev" },
    });
    tree = render(props);

    await findActionButtonByLabel(tree, "Create Channel").props.onClick();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.token).toBe("ccb_manual");
    expect(payload.baseUrl).toBe("https://ws.clickclack.dev");
    expect(payload.setupValue).toBeUndefined();
  });
});

describe("frontend/create-channel-modal option toggles reset per session (3.1)", () => {
  beforeEach(() => {
    harness.reset();
    kCapsState.payload = { capabilities: { clickclackGuidedSetup: true } };
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  const findSelectByOptionText = (tree, fragment) =>
    collectNodes(tree).find(
      (vnode) =>
        vnode.type === "select" &&
        collectText(vnode.props.children).join(" ").includes(fragment),
    );

  it("does not leak the previous account's Slack toggle into the next edit session", async () => {
    const onSubmit = vi.fn(async () => {});
    const accountA = {
      provider: "slack",
      id: "default",
      name: "Slack A",
      ownerAgentId: "main",
      token: "",
    };
    const propsA = {
      ...kProps,
      mode: "edit",
      account: accountA,
      initialProvider: "slack",
      onSubmit,
    };

    let tree = mount(propsA);
    const select = findSelectByOptionText(tree, "Emoji status reactions");
    expect(select).toBeTruthy();
    // Plain-DOM vnodes carry the lowercased attribute name.
    (select.props.oninput || select.props.onInput)({ target: { value: "on" } });
    tree = render(propsA);

    await findActionButtonByLabel(tree, "Save Changes").props.onClick();
    expect(onSubmit.mock.calls[0][0].statusReactions).toBe("on");

    // Reopen for a DIFFERENT account — the modal stays mounted, so the toggle
    // MUST reset to default and never ride account B's submit. A different
    // account means a different (provider, id): the init key is identity-
    // based so background list refreshes can't reset an open form mid-edit.
    const accountB = { ...accountA, id: "second", name: "Slack B" };
    const propsB = { ...propsA, account: accountB };
    mount(propsB);
    tree = render(propsB);
    await findActionButtonByLabel(tree, "Save Changes").props.onClick();
    expect(onSubmit.mock.calls[1][0].statusReactions).toBeUndefined();
  });
});
