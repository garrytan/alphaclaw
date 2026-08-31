import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (welcome-form-step pattern): state lives in
// per-call-index slots; effects are collected and run manually.
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

vi.mock("../../lib/public/js/lib/api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, saveGoogleCredentials: vi.fn() };
});

import * as preactHooks from "preact/hooks";
import { saveGoogleCredentials } from "../../lib/public/js/lib/api.js";
import { CredentialsModal } from "../../lib/public/js/components/credentials-modal.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";

const harness = preactHooks.__harness;

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectNodes(node.props.children, out);
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
  if (node && typeof node === "object" && node.props) {
    collectText(node.props.children, out);
  }
  return out;
};

const kProps = {
  visible: true,
  onClose: vi.fn(),
  onSaved: vi.fn(),
  initialValues: {
    clientId: "cid.apps.googleusercontent.com",
    clientSecret: "GOCSPX-secret",
    email: "ada@example.com",
  },
};

const renderModal = () => {
  harness.beginRender();
  return CredentialsModal(kProps);
};

const findSubmitButton = (tree) =>
  collectNodes(tree).find(
    (node) =>
      node.type === ActionButton && node.props.idleLabel === "Connect Google",
  );

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("frontend/credentials-modal save failure", () => {
  it("surfaces the thrown error's message instead of the static 'Request failed'", async () => {
    renderModal();
    // The visibility effect hydrates the fields from initialValues.
    harness.effects[0]();
    let tree = renderModal();

    saveGoogleCredentials.mockRejectedValue(new Error("gateway quota exceeded"));
    await findSubmitButton(tree).props.onClick();

    tree = renderModal();
    const text = collectText(tree).join(" ");
    expect(text).toContain("gateway quota exceeded");
    expect(text).not.toContain("Request failed");
  });

  it("keeps the 'Request failed' fallback when the rejection carries no message", async () => {
    renderModal();
    harness.effects[0]();
    let tree = renderModal();

    saveGoogleCredentials.mockRejectedValue({});
    await findSubmitButton(tree).props.onClick();

    tree = renderModal();
    expect(collectText(tree).join(" ")).toContain("Request failed");
  });
});
