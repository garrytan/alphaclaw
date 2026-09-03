import { beforeEach, describe, expect, it, vi } from "vitest";

// Pass-through hook mocks (general-tab-smoke.test.js pattern): GeneralTab's
// own body executes; children stay un-invoked vnodes we can inspect.
vi.mock("preact/hooks", () => ({
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v = null) => ({ current: v }),
}));
vi.mock("../../lib/public/js/components/general/use-general-tab.js", () => ({
  useGeneralTab: vi.fn(),
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

import { useGeneralTab } from "../../lib/public/js/components/general/use-general-tab.js";
import { GeneralTab } from "../../lib/public/js/components/general/index.js";
import { GeneralHardeningCard } from "../../lib/public/js/components/general/hardening-card.js";
import { GeneralDoctorWarning } from "../../lib/public/js/components/doctor/general-warning.js";

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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const mockGeneralState = (doctorStatus) => {
  useGeneralTab.mockReturnValue({
    state: {
      channels: { telegram: { enabled: true } },
      gatewayStatus: null,
      watchdogStatus: null,
      doctorStatus,
      hasUnpaired: false,
      pairingStatusRefreshing: false,
      pending: [],
      devicePending: [],
      repairingWatchdog: false,
      googleAccounts: [],
    },
    actions: new Proxy({}, { get: () => () => {} }),
  });
};

const kBlockedDoctorStatus = {
  releaseChannel: "stable",
  bootstrapContext: {
    hardening: {
      state: "blocked",
      reason: "missing_file",
      files: [{ path: "hooks/bootstrap/AGENTS.md", exists: false, reason: "" }],
    },
  },
};

const renderTab = (onSwitchTab) =>
  GeneralTab({
    statusData: { alphaclaw: { team: { enabled: false } } },
    isActive: true,
    onSwitchTab,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("frontend/general-tab hardening card wiring", () => {
  it("a hardening problem replaces the generic doctor warning — never two stacked alert cards", () => {
    mockGeneralState(kBlockedDoctorStatus);
    const tree = renderTab(vi.fn());

    const cards = findAllByType(tree, GeneralHardeningCard);
    expect(cards).toHaveLength(1);
    expect(cards[0].props.doctorStatus).toBe(kBlockedDoctorStatus);
    // The hardening card subsumes the "go run the doctor" prompt.
    expect(findAllByType(tree, GeneralDoctorWarning)).toHaveLength(0);
  });

  it("the card's CTA deep-links to the doctor context section (doctor?focus=context)", () => {
    mockGeneralState(kBlockedDoctorStatus);
    const onSwitchTab = vi.fn();
    const tree = renderTab(onSwitchTab);

    const card = findAllByType(tree, GeneralHardeningCard)[0];
    card.props.onOpenDoctor();
    expect(onSwitchTab).toHaveBeenCalledWith("doctor?focus=context");
  });

  it("with healthy hardening the generic doctor warning card returns, targeting plain #/doctor", () => {
    mockGeneralState(null);
    const onSwitchTab = vi.fn();
    const tree = renderTab(onSwitchTab);

    const warnings = findAllByType(tree, GeneralDoctorWarning);
    expect(warnings).toHaveLength(1);
    warnings[0].props.onOpenDoctor();
    expect(onSwitchTab).toHaveBeenCalledWith("doctor");
  });
});
