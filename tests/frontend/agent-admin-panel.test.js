import { describe, expect, it, vi } from "vitest";

// Render-only harness: state setters are never exercised here, so plain
// pass-through hooks are enough (general-hardening-badge.test.js style).
vi.mock("preact/hooks", () => ({
  useState: (initialValue) => [
    typeof initialValue === "function" ? initialValue() : initialValue,
    () => {},
  ],
  useEffect: () => {},
  useRef: (initialValue = null) => ({ current: initialValue }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
}));

vi.mock("../../lib/public/js/hooks/usePolling.js", () => ({
  usePolling: vi.fn(() => ({ data: null })),
}));

vi.mock("../../lib/public/js/lib/api.js", () => ({
  updateAgentAdminFeature: vi.fn(),
  rotateAgentAdminToken: vi.fn(),
  fetchAgentAdminConfirms: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
}));

import {
  AgentAdminPanel,
  getTokenUnavailableDetail,
} from "../../lib/public/js/components/agent-admin-panel.js";

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

const renderText = (agentAdmin) =>
  collectText(AgentAdminPanel({ agentAdmin, isActive: true }))
    .join(" ")
    .replace(/\s+/g, " ");

describe("frontend/agent-admin-panel token-unavailable detail", () => {
  it("prefers the server hint over the per-reason fallback", () => {
    expect(
      getTokenUnavailableDetail({
        state: "unavailable",
        reason: "token_missing",
        hint: "Flag is on but no token file exists (mint failure?) — check server logs.",
      }),
    ).toBe(
      "Flag is on but no token file exists (mint failure?) — check server logs.",
    );
  });

  it("falls back per reason when the server sends no hint", () => {
    expect(
      getTokenUnavailableDetail({ state: "unavailable", reason: "token_missing" }),
    ).toBe("Flag is on but no token file exists — check server logs.");
    expect(
      getTokenUnavailableDetail({ state: "unavailable", reason: "error" }),
    ).toBe("Status probe failed — check server logs.");
    // Unknown/missing reason: the probe-failed copy, never a fabricated cause.
    expect(getTokenUnavailableDetail({ state: "unavailable" })).toBe(
      "Status probe failed — check server logs.",
    );
  });

  it("renders the reason-specific detail without the '(mint failure)' claim", () => {
    const text = renderText({ state: "unavailable", reason: "token_missing" });
    expect(text).toContain("⚠ Token unavailable —");
    expect(text).toContain(
      "Flag is on but no token file exists — check server logs.",
    );
    expect(text).not.toContain("(mint failure)");
  });

  it("renders the server hint verbatim when present", () => {
    const text = renderText({
      state: "unavailable",
      reason: "error",
      hint: "Token store is on a read-only volume — remount and restart.",
    });
    expect(text).toContain(
      "Token store is on a read-only volume — remount and restart.",
    );
    expect(text).not.toContain("Status probe failed");
  });
});
