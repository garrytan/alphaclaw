import { describe, expect, it } from "vitest";
import {
  WatchdogResourcesCard,
  buildCapacityHeaderModel,
  buildMemoryTrendModel,
} from "../../lib/public/js/components/watchdog-tab/resources/index.js";
import { ResourceBar } from "../../lib/public/js/components/watchdog-tab/resource-bar.js";
import { AsyncSection } from "../../lib/public/js/components/async-section.js";
import { Badge } from "../../lib/public/js/components/badge.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { Tooltip } from "../../lib/public/js/components/tooltip.js";

// Stateless component: invoke directly and walk the vnode tree (the
// saved-toggle-component.test.js pattern) — no DOM renderer needed.
const kSkipExpand = new Set([Tooltip]);

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

const treeText = (tree) => collectText(tree).join(" ");

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const kResources = {
  memory: { usedBytes: 1024, totalBytes: 4096, percent: 25 },
  disk: { usedBytes: 10, totalBytes: 100, percent: 10, path: "/data" },
  cpu: { percent: 5, cores: 2 },
};

const renderCard = (props = {}) => expandTree(WatchdogResourcesCard(props));

describe("frontend/watchdog resources card", () => {
  it("keeps the card frame while loading instead of unmounting", () => {
    const tree = renderCard({ resources: null, error: null });
    // The frame (root div) is present with a scoped loading line.
    expect(collectNodes(tree).some((n) => n.type === "div")).toBe(true);
    expect(treeText(tree)).toContain("Loading system resources...");
    expect(findAllByType(tree, ResourceBar).length).toBe(0);
  });

  it("renders an inline error with Retry when the poll fails before any data", () => {
    const onRetry = () => {};
    const tree = renderCard({ resources: null, error: new Error("boom"), onRetry });
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.onRetry).toBe(onRetry);
    expect(treeText(tree)).toContain("Couldn't load system resources.");
    expect(treeText(tree)).not.toContain("Loading system resources...");
  });

  it("keeps stale bars on screen with a refresh-failed note", () => {
    const tree = renderCard({ resources: kResources, error: new Error("flaky") });
    expect(findAllByType(tree, ResourceBar).length).toBe(3); // stale data still shown
    expect(treeText(tree)).toContain(
      "Couldn't refresh system resources — showing the last loaded values.",
    );
  });

  it("renders the three bars with no chip when healthy", () => {
    const tree = renderCard({ resources: kResources });
    expect(findAllByType(tree, ResourceBar).length).toBe(3);
    expect(findAllByType(tree, InlineErrorChip).length).toBe(0);
    expect(findAllByType(tree, AsyncSection).length).toBe(0);
  });

  it("renders the expanded memory bar with process segments", () => {
    const tree = renderCard({
      resources: {
        ...kResources,
        processes: { gateway: { rssBytes: 256 }, alphaclaw: { rssBytes: 128 } },
      },
      memoryExpanded: true,
    });
    const bars = findAllByType(tree, ResourceBar);
    expect(bars.length).toBe(1);
    expect(bars[0].props.expanded).toBe(true);
    expect(bars[0].props.segments.map((segment) => segment.label)).toEqual([
      "Gateway 256 B",
      "AlphaClaw 128 B",
      "Other 640 B",
    ]);
  });
});

const kGb = 1024 * 1024 * 1024;

const kProfile = {
  detectedAt: 1756400000000,
  memory: { limitBytes: 8 * kGb, source: "cgroup-v2" },
  cpu: { cores: 4, hostCores: 8, source: "cgroup-v2" },
  disk: { totalBytes: 80 * kGb, path: "/" },
  gpu: { present: false },
  tier: "medium",
  environment: "container",
};

const badgeTexts = (tree) =>
  findAllByType(tree, Badge).map((badge) => ({
    tone: badge.props.tone,
    text: collectText(badge.props.children).join(""),
  }));

describe("frontend/watchdog resources card — capacity header", () => {
  it("renders nothing extra without a profile (older server)", () => {
    const tree = renderCard({ resources: kResources });
    expect(findAllByType(tree, Badge).length).toBe(0);
    expect(buildCapacityHeaderModel(null)).toBeNull();
  });

  it("happy path: text anchor + ONE neutral tier badge, no source badge, no GPU chip", () => {
    const tree = renderCard({ resources: kResources, profile: kProfile });
    expect(treeText(tree)).toContain("4 vCPU · 8.0 GB memory · 80.0 GB disk");
    expect(badgeTexts(tree)).toEqual([{ tone: "neutral", text: "Medium" }]);
    // Never a happy-path source badge and never a "no GPU" chip.
    expect(treeText(tree)).not.toContain("Host values");
    expect(treeText(tree).toLowerCase()).not.toContain("no gpu");
    expect(treeText(tree).toLowerCase()).not.toContain("cgroup");
  });

  it("degraded source: warning 'Host values' badge appears", () => {
    const tree = renderCard({
      resources: kResources,
      profile: {
        ...kProfile,
        memory: { limitBytes: 64 * kGb, source: "host" },
      },
    });
    expect(badgeTexts(tree)).toContainEqual({
      tone: "warning",
      text: "Host values",
    });
  });

  it("bare metal: host values are the correct values — no source badge at all", () => {
    const tree = renderCard({
      resources: kResources,
      profile: {
        ...kProfile,
        memory: { limitBytes: 64 * kGb, source: "host" },
        environment: "bare-metal",
      },
    });
    expect(treeText(tree)).not.toContain("Host values");
    // The warning stays reserved for degraded detection (container/unknown).
    expect(
      buildCapacityHeaderModel({
        ...kProfile,
        memory: { limitBytes: 64 * kGb, source: "host" },
        environment: "unknown",
      }).hostValues,
    ).toBe(true);
  });

  it("GPU chip renders ONLY when present: first device + '+N more', cyan tone", () => {
    const tree = renderCard({
      resources: kResources,
      profile: {
        ...kProfile,
        gpu: {
          present: true,
          vendor: "nvidia",
          devices: [
            { name: "NVIDIA A10G", vramBytes: 24 * kGb },
            { name: "NVIDIA A10G", vramBytes: 24 * kGb },
          ],
        },
      },
    });
    expect(badgeTexts(tree)).toContainEqual({
      tone: "cyan",
      text: "NVIDIA A10G +1 more",
    });
  });

  it("presence-only GPU (nvidia-smi failed) still gets a chip from the vendor", () => {
    const model = buildCapacityHeaderModel({
      ...kProfile,
      gpu: { present: true, vendor: "nvidia" },
    });
    expect(model.gpuLabel).toBe("nvidia");
  });

  it("disk row is omitted from the anchor when detection failed", () => {
    const model = buildCapacityHeaderModel({ ...kProfile, disk: null });
    expect(model.text).toBe("4 vCPU · 8.0 GB memory");
  });
});

// Every trend-enum state renders its HONEST copy (review 4A/6C): off and
// collecting are stated, never dressed up as healthy; badge = word + tone.
describe("buildMemoryTrendModel", () => {
  const kNow = Date.parse("2026-08-31T09:00:00.000Z");
  const base = {
    rssMb: 812,
    slopeMbPerHour: 65,
    effectiveCapMb: 1024,
    sampleCount: 12,
    requiredSamples: 24,
    projectedExhaustionAt: null,
  };

  it("hides the row for missing/legacy payloads and no_gateway", () => {
    expect(buildMemoryTrendModel(null)).toBeNull();
    expect(buildMemoryTrendModel(undefined)).toBeNull();
    expect(buildMemoryTrendModel({ ...base, state: "no_gateway" })).toBeNull();
  });

  it("disabled states the fact and points at Settings", () => {
    const model = buildMemoryTrendModel({ ...base, state: "disabled" });
    expect(model.tone).toBe("neutral");
    expect(model.label).toBe("Detection off");
    expect(model.detail).toContain("Settings");
    expect(model.alwaysVisible).toBe(false);
  });

  it("warming/insufficient show sample progress, never a verdict", () => {
    for (const state of ["warming_up", "insufficient_samples"]) {
      const model = buildMemoryTrendModel({ ...base, state });
      expect(model.label).toBe("Collecting");
      expect(model.detail).toContain("(12/24)");
    }
  });

  it("normal is a subtle Stable badge with the numbers", () => {
    const model = buildMemoryTrendModel({ ...base, state: "normal" });
    expect(model.tone).toBe("success");
    expect(model.label).toBe("Stable");
    expect(model.detail).toContain("812 MB of 1024 MB cap");
  });

  it("watch is a warning marked unconfirmed", () => {
    const model = buildMemoryTrendModel({ ...base, state: "watch" });
    expect(model.tone).toBe("warning");
    expect(model.detail).toContain("unconfirmed");
    expect(model.alwaysVisible).toBe(false);
  });

  it("leak_suspected reads calm-narrative with slope + projection, always visible", () => {
    const model = buildMemoryTrendModel(
      {
        ...base,
        state: "leak_suspected",
        projectedExhaustionAt: new Date(kNow + 3 * 60 * 60 * 1000).toISOString(),
      },
      { nowMs: kNow },
    );
    expect(model.tone).toBe("warning");
    expect(model.label).toBe("Leak suspected");
    expect(model.detail).toContain("Memory rising steadily");
    expect(model.detail).toContain("+65 MB/h");
    expect(model.detail).toContain("projected to reach its limit in ~3h");
    expect(model.detail).not.toMatch(/LEAK DETECTED|!{2,}/);
    expect(model.alwaysVisible).toBe(true);
  });

  it("critical is danger-toned and always visible", () => {
    const model = buildMemoryTrendModel({ ...base, state: "critical" });
    expect(model.tone).toBe("danger");
    expect(model.label).toBe("Critical");
    expect(model.alwaysVisible).toBe(true);
  });

  it("an unknown future state hides rather than guessing", () => {
    expect(buildMemoryTrendModel({ ...base, state: "novel_state" })).toBeNull();
  });
});
