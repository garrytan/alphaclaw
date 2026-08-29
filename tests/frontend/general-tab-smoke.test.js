import { describe, expect, it, vi } from "vitest";

// Smoke test that EXECUTES GeneralTab's own function body (children stay
// un-invoked vnodes). This exists because an undeclared identifier in the
// body (a ReferenceError at render) once shipped uncaught — no other test
// renders GeneralTab.
vi.mock("../../lib/public/js/components/general/use-general-tab.js", () => ({
  useGeneralTab: () => ({
    state: {
      channels: { telegram: { enabled: true } },
      gatewayStatus: null,
      watchdogStatus: null,
      doctorStatus: null,
      hasUnpaired: false,
      pairingStatusRefreshing: false,
      pending: [],
      devicePending: [],
      repairingWatchdog: false,
      googleAccounts: [],
    },
    actions: new Proxy({}, { get: () => () => {} }),
  }),
}));
vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: () => ({ data: null, loading: false, refresh: () => {} }),
}));
// channel-login-modal.js imports preact from a CDN URL, which Node's ESM
// loader can't resolve in tests — stub the whole module.
vi.mock("../../lib/public/js/components/channel-login-modal.js", () => ({
  ChannelLoginModal: () => null,
  kPreservedChannelLoginModalState: {},
  cloneLoginModalState: (value) => ({ ...(value || {}) }),
}));
vi.mock("preact/hooks", () => ({
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v = null) => ({ current: v }),
}));

import { GeneralTab } from "../../lib/public/js/components/general/index.js";

describe("frontend/general-tab smoke", () => {
  it("renders without throwing (guards undeclared identifiers in the body)", () => {
    const vnode = GeneralTab({
      statusData: { alphaclaw: { team: { enabled: false } } },
      watchdogData: null,
      doctorStatusData: null,
      agents: [],
      isActive: true,
    });
    expect(vnode).toBeTruthy();
    expect(typeof vnode).toBe("object");
  });
});
