import { describe, expect, it } from "vitest";
import {
  WatchdogResourcesCard,
  buildDiskSpaceModel,
} from "../../lib/public/js/components/watchdog-tab/resources/index.js";
import { Badge } from "../../lib/public/js/components/badge.js";
import { Tooltip } from "../../lib/public/js/components/tooltip.js";

const kGiB = 1024 ** 3;

const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function" && node.type !== Tooltip) {
    try {
      out.rendered = expandTree(node.type(node.props || {}));
    } catch {
      out.rendered = null;
    }
  }
  if (out.props.children !== undefined) out.props = { ...out.props, children: expandTree(out.props.children) };
  return out;
};
const collect = (node, visit) => {
  if (node == null) return;
  if (Array.isArray(node)) return node.forEach((child) => collect(child, visit));
  visit(node);
  if (typeof node === "object") {
    collect(node.props?.children, visit);
    collect(node.rendered, visit);
  }
};
const treeText = (tree) => {
  const parts = [];
  collect(tree, (node) => { if (typeof node === "string" || typeof node === "number") parts.push(String(node)); });
  return parts.join("").replace(/\s+/g, " ");
};
const badges = (tree) => {
  const found = [];
  collect(tree, (node) => { if (node?.type === Badge) found.push(node); });
  return found;
};

const volume = (overrides = {}) => ({
  id: "state",
  sampleStatus: "fresh",
  state: "ok",
  freeBytes: 14 * kGiB,
  sizeBytes: 200 * kGiB,
  lowThresholdBytes: 20 * kGiB,
  fillEstimate: { status: "filling", daysToFull: 7.4, growthBytesPerDay: 2 * kGiB, spanMs: 3 * 86_400_000 },
  ...overrides,
});
const kResources = {
  memory: { usedBytes: 1024, totalBytes: 4096, percent: 25 },
  disk: { usedBytes: 10, totalBytes: 100, percent: 10, path: "/data" },
};
const renderCard = (diskSpace) => expandTree(WatchdogResourcesCard({ resources: { ...kResources, diskSpace } }));

describe("frontend/watchdog resources card: days until the disk is full", () => {
  it("shows the estimate next to the low-space warning", () => {
    const tree = renderCard({ volumes: [volume({ state: "low" })] });
    const text = treeText(tree);
    expect(text).toContain("Disk space low");
    expect(text).toContain("14.0 GB free, under the 20.0 GB warning line");
    expect(text).toContain("· Full in about 7 days at the current rate");
    expect(badges(tree).map((badge) => badge.props.tone)).toEqual(["warning"]);
  });

  it("uses the danger tone when the disk is almost full, and says less than a day", () => {
    const model = buildDiskSpaceModel({ volumes: [volume({ state: "critical", fillEstimate: { status: "filling", daysToFull: 0.3 } })] });
    expect(model.warning).toMatchObject({ tone: "danger", label: "Disk almost full" });
    expect(model.fill).toBe("Full in less than a day at the current rate");
    expect(buildDiskSpaceModel({ volumes: [volume({ fillEstimate: { status: "filling", daysToFull: 1.6 } })] }).fill)
      .toBe("Full in about 1 day at the current rate");
  });

  it("shows the estimate alone, without a warning, while space is above the warning line", () => {
    const tree = renderCard({ volumes: [volume()] });
    expect(treeText(tree)).toContain("Full in about 7 days at the current rate");
    expect(treeText(tree)).not.toContain("warning line");
    expect(badges(tree)).toHaveLength(0);
  });

  it("says the disk is filling fast, not under the warning line, when the last hour's growth opened the warning", () => {
    const fast = volume({ state: "low", trigger: "eta", currentTier: "low", freeBytes: 60 * kGiB, etaMs: 4.2 * 3_600_000 });
    const tree = renderCard({ volumes: [fast] });
    const text = treeText(tree);
    expect(text).toContain("Disk filling fast");
    expect(text).toContain("60.0 GB free and filling fast: full in about 4 hours at the last hour's rate");
    expect(text).not.toContain("warning line");
    expect(text).not.toContain("Disk space low");
    expect(badges(tree).map((badge) => badge.props.tone)).toEqual(["warning"]);

    const critical = buildDiskSpaceModel({ volumes: [volume({ state: "critical", trigger: "eta", currentTier: "critical", freeBytes: 60 * kGiB, etaMs: 40 * 60_000 })] });
    expect(critical.warning).toEqual({
      tone: "danger",
      label: "Disk filling fast",
      text: "60.0 GB free and filling fast: full in less than an hour at the last hour's rate",
    });
    expect(buildDiskSpaceModel({ volumes: [volume({ state: "low", trigger: "eta", currentTier: "low", freeBytes: 60 * kGiB, etaMs: 70 * 60_000 })] }).warning.text)
      .toBe("60.0 GB free and filling fast: full in about 1 hour at the last hour's rate");
    expect(buildDiskSpaceModel({ volumes: [volume({ state: "low", trigger: "eta", currentTier: "low", freeBytes: 60 * kGiB, etaMs: null })] }).warning.text)
      .toBe("60.0 GB free and filling fast");
    expect(buildDiskSpaceModel({ volumes: [volume({ state: "low", trigger: "eta", etaMs: 3 * 3_600_000 })] }).warning)
      .toMatchObject({ label: "Disk space low", text: "14.0 GB free, under the 20.0 GB warning line" });
  });

  it("claims neither low space nor fast filling while a recovering disk sits between the warning line and the clear line", () => {
    const recovering = (overrides) => buildDiskSpaceModel({ volumes: [volume({ state: "low", currentTier: "ok", freeBytes: 22 * kGiB, etaMs: null, ...overrides })] });
    for (const trigger of ["level", "eta"]) {
      expect(recovering({ trigger }).warning).toEqual({
        tone: "warning",
        label: "Disk warning still open",
        text: "22.0 GB free, above the 20.0 GB warning line and not filling fast",
      });
    }
    expect(recovering({ trigger: "level", state: "critical" }).warning).toMatchObject({ tone: "danger", label: "Disk warning still open" });
    expect(recovering({ trigger: "level", currentTier: "low", etaMs: 5 * 3_600_000 }).warning).toMatchObject({
      label: "Disk filling fast",
      text: "22.0 GB free and filling fast: full in about 5 hours at the last hour's rate",
    });
    const tree = renderCard({ volumes: [volume({ state: "low", trigger: "level", currentTier: "ok", freeBytes: 22 * kGiB })] });
    expect(treeText(tree)).toContain("Disk warning still open");
    expect(treeText(tree)).not.toContain("Disk filling fast");
    expect(treeText(tree)).not.toContain("under the");
  });

  it("says not enough data yet before there is a trend", () => {
    const model = buildDiskSpaceModel({ volumes: [volume({ fillEstimate: { status: "not_enough_data", daysToFull: null } })] });
    expect(model).toEqual({ warning: null, fill: "Days until the disk is full: not enough data yet", filling: false });
    expect(treeText(renderCard({ volumes: [volume({ state: "low", fillEstimate: { status: "not_enough_data", daysToFull: null } })] })))
      .toContain("not enough data yet");
  });

  it("shows nothing when the disk is not filling, the number is unusable, or there is no fresh reading", () => {
    expect(buildDiskSpaceModel({ volumes: [volume({ fillEstimate: { status: "not_filling", daysToFull: null } })] })).toBe(null);
    expect(buildDiskSpaceModel({ volumes: [volume({ fillEstimate: { status: "filling", daysToFull: -3 } })] })).toBe(null);
    expect(buildDiskSpaceModel({ volumes: [volume({ fillEstimate: { status: "filling", daysToFull: null } })] })).toBe(null);
    expect(buildDiskSpaceModel({ volumes: [volume({ sampleStatus: "unknown" })] })).toBe(null);
    expect(buildDiskSpaceModel({ volumes: [volume({ id: "diagnostic" })] })).toBe(null);
    expect(buildDiskSpaceModel(null)).toBe(null);
    const lowNotFilling = buildDiskSpaceModel({ volumes: [volume({ state: "low", fillEstimate: { status: "not_filling", daysToFull: null } })] });
    expect(lowNotFilling).toMatchObject({ fill: null, warning: { label: "Disk space low" } });
    expect(treeText(renderCard(null))).not.toContain("Full in");
  });
});
