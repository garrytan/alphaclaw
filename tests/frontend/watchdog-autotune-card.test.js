import { beforeEach, describe, expect, it, vi } from "vitest";

// Hook harness (the use-saved-setting.test.js pattern): hook state lives in
// per-call-index slots so the CONTAINER can be invoked directly without a DOM
// renderer. Effects are collected, not run. Inert for the stateless view
// tests below — none of the expanded components call hooks.
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

// The container's fetches never fire under the harness (effects are collected,
// not run) — the save path is what the container tests drive directly.
vi.mock("../../lib/public/js/lib/api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchAutotune: vi.fn(async () => ({ ok: true })),
    updateAutotuneSettings: vi.fn(async () => ({ ok: true })),
  };
});

import * as preactHooks from "preact/hooks";
import {
  AutotuneCardView,
  WatchdogAutotuneCard,
  buildAutotuneCounts,
  buildAutotuneDisabledParagraph,
  buildAutotuneEnvironmentNote,
  buildAutotuneMachineEcho,
  buildAutotuneOverridesLine,
  buildAutotuneRecommendationModel,
  buildAutotuneResizeBanner,
  buildAutotuneRowModel,
  buildAutotuneSummaryModel,
  buildAutotuneToggleToast,
  formatAutotuneValue,
  kAutotuneAlphaclawRestartReason,
  kAutotuneCacheKey,
  kAutotuneHeapContext,
  kAutotuneKillSwitchToast,
} from "../../lib/public/js/components/watchdog-tab/autotune-card.js";
import { Badge } from "../../lib/public/js/components/badge.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { updateAutotuneSettings } from "../../lib/public/js/lib/api.js";
import { invalidateCache, setCached } from "../../lib/public/js/lib/api-cache.js";

const hookHarness = preactHooks.__harness;

// Stateless view: invoke directly and walk the vnode tree (the
// watchdog-resources-card.test.js pattern) — no DOM renderer needed. All
// hooks live in the container; every state arrives as props.
// A component that throws during expansion is nulled from the tree — which
// would let negative assertions ("no button exists") pass vacuously. Every
// expansion error is recorded here; tests whose guarantees rest on the tree
// being fully expanded assert expectNoExpandErrors().
const kExpandErrors = [];

const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function") {
    try {
      out.rendered = expandTree(node.type(node.props || {}));
    } catch (error) {
      kExpandErrors.push({ component: node.type.name || "anonymous", error });
      out.rendered = null;
    }
  }
  if (out.props.children !== undefined) {
    out.props = { ...out.props, children: expandTree(out.props.children) };
  }
  return out;
};

const expectNoExpandErrors = () => {
  expect(kExpandErrors).toEqual([]);
};

beforeEach(() => {
  kExpandErrors.length = 0;
});

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

const treeText = (tree) => collectText(tree).join(" ").replace(/\s+/g, " ");

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const findRowByKnob = (tree, knob) =>
  collectNodes(tree).find((vnode) => vnode.props?.["data-knob"] === knob);

const kGb = 1024 * 1024 * 1024;

const kProfile = {
  detectedAt: 1756400000000,
  memory: { limitBytes: 2 * kGb, source: "cgroup-v2" },
  cpu: { cores: 1, hostCores: 8, source: "cgroup-v2" },
  disk: { totalBytes: 80 * kGb, path: "/" },
  gpu: { present: false },
  tier: "small",
  environment: "container",
};

const makeLedger = (patch = {}) => ({
  enabled: true,
  suppressed: false,
  suppressedReason: null,
  updatedAt: 1756400000000,
  trigger: "boot",
  profile: kProfile,
  derived: {},
  overrides: {},
  rows: [],
  lastResize: null,
  activeGatewayEnv: null,
  ...patch,
});

const appliedRow = (knob, value) => ({
  knob,
  value,
  target: "gateway",
  status: "applied",
  restartTarget: null,
  reason: null,
  appliedAt: 1756400000000,
});

const renderView = (props = {}) =>
  expandTree(
    AutotuneCardView({
      ledger: makeLedger(),
      error: null,
      onRetry: () => {},
      enabled: true,
      settingHydrated: true,
      settingSaving: false,
      settingSavingContext: null,
      settingSaveError: null,
      settingLoadError: null,
      onRetryLoadSetting: () => {},
      onToggleEnabled: () => {},
      heapDraftValue: "",
      heapDirty: false,
      onHeapInput: () => {},
      onHeapSave: () => {},
      reapplying: false,
      reapplyError: null,
      onReapply: () => {},
      dismissingResize: false,
      onDismissResize: () => {},
      onRestartGateway: () => {},
      restartingGateway: false,
      ...props,
    }),
  );

describe("frontend/watchdog autotune card — view models", () => {
  it("humanizes values per knob unit (never raw MB counts)", () => {
    expect(formatAutotuneValue("gatewayHeapMb", 4096)).toBe("4.0 GB");
    expect(formatAutotuneValue("sqliteCacheMb", 64)).toBe("64 MB");
    expect(formatAutotuneValue("backupMaxTotalGb", 20)).toBe("20.0 GB");
    expect(formatAutotuneValue("agentConcurrencyCap", 32)).toBe("32 agents");
    expect(formatAutotuneValue("uvThreadpoolSize", 8)).toBe("8 threads");
    expect(formatAutotuneValue("gatewayHeapMb", null)).toBe("—");
  });

  it("count arithmetic: tuned = applied + pending; clamped is a flag; manual and skipped excluded", () => {
    const counts = buildAutotuneCounts([
      appliedRow("gatewayHeapMb", 1024),
      { knob: "uvThreadpoolSize", status: "pending_restart", restartTarget: "gateway" },
      { knob: "openAiCompatBodyLimitMb", status: "pending_restart", restartTarget: "alphaclaw" },
      // A clamped override that still needs a restart — both facts count.
      {
        knob: "sqliteCacheMb",
        status: "pending_restart",
        restartTarget: "alphaclaw",
        clamped: true,
      },
      { knob: "agentConcurrencyCap", status: "skipped" },
      { knob: "adminHeapRecommendedMb", status: "manual" },
    ]);
    expect(counts.tuned).toBe(4);
    expect(counts.applied).toBe(1);
    expect(counts.pendingGateway).toBe(1);
    expect(counts.pendingAlphaclaw).toBe(2);
    expect(counts.clamped).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(counts.manual).toBe(1);
  });

  it("a clamped pending gateway row keeps the restart affordance AND the clamp reason", () => {
    const model = buildAutotuneRowModel({
      knob: "gatewayHeapMb",
      value: 1741,
      status: "pending_restart",
      restartTarget: "gateway",
      clamped: true,
      reason: "override 16384 exceeds this machine — 1741 applied instead",
    });
    expect(model.showGatewayRestart).toBe(true);
    expect(model.chip.label).toBe("Restart gateway");
    expect(model.reasonLine).toContain("1741 applied instead");
  });

  it("summary line carries the spec'd counts copy and warning tone when pending", () => {
    const rows = [
      ...Array.from({ length: 6 }, (unused, i) => appliedRow(`knob${i}`, 1)),
      { knob: "gatewayHeapMb", status: "pending_restart", restartTarget: "gateway" },
      { knob: "uvThreadpoolSize", status: "pending_restart", restartTarget: "gateway" },
    ];
    const summary = buildAutotuneSummaryModel(makeLedger({ rows }));
    expect(summary.text).toBe(
      "8 settings tuned — 6 applied, 2 pending gateway restart",
    );
    expect(summary.tone).toBe("warning");
    expect(summary.partial).toBe(true);
  });

  it("summary: all applied reads as no-action-needed with muted tone", () => {
    const rows = [appliedRow("gatewayHeapMb", 1024)];
    const summary = buildAutotuneSummaryModel(makeLedger({ rows }));
    expect(summary.text).toBe(
      "Tuned for this 2.0 GB / 1 vCPU container — no action needed.",
    );
    expect(summary.tone).toBe("muted");
    expect(summary.partial).toBe(false);
  });

  it("summary: all applied without a full profile (older server) never renders dash filler", () => {
    const rows = [appliedRow("gatewayHeapMb", 1024)];
    const noProfile = buildAutotuneSummaryModel(
      makeLedger({ rows, profile: null }),
    );
    expect(noProfile.text).toBe("Tuned for this container — no action needed.");
    const noMemory = buildAutotuneSummaryModel(
      makeLedger({ rows, profile: { ...kProfile, memory: {} } }),
    );
    expect(noMemory.text).toBe("Tuned for this container — no action needed.");
    const noCores = buildAutotuneSummaryModel(
      makeLedger({ rows, profile: { ...kProfile, cpu: {} } }),
    );
    expect(noCores.text).toBe("Tuned for this container — no action needed.");
  });

  it("disabled paragraph: capitalized tier label, tier clause omitted when missing/unknown", () => {
    expect(buildAutotuneDisabledParagraph(kProfile)).toBe(
      "Autotune is off. AlphaClaw and the gateway run with built-in defaults sized for small containers. Detection stays on — Small tier (2.0 GB / 1 vCPU).",
    );
    expect(
      buildAutotuneDisabledParagraph({ ...kProfile, tier: "unknown" }),
    ).toBe(
      "Autotune is off. AlphaClaw and the gateway run with built-in defaults sized for small containers. Detection stays on — 2.0 GB / 1 vCPU.",
    );
    expect(buildAutotuneDisabledParagraph({ ...kProfile, tier: null })).toBe(
      "Autotune is off. AlphaClaw and the gateway run with built-in defaults sized for small containers. Detection stays on — 2.0 GB / 1 vCPU.",
    );
    expect(buildAutotuneDisabledParagraph(null)).toBe(
      "Autotune is off. AlphaClaw and the gateway run with built-in defaults sized for small containers. Detection stays on.",
    );
  });

  it("disabled paragraph: a still-tuned running gateway is never described as defaults", () => {
    const activeGatewayEnv = {
      gatewayHeapMb: 1741,
      uvThreadpoolSize: 8,
      at: 1756400000000,
    };
    expect(buildAutotuneDisabledParagraph(kProfile, activeGatewayEnv)).toBe(
      "Autotune is off, but the running gateway still uses its previous tuned values — built-in defaults apply after the next gateway restart. Detection stays on — Small tier (2.0 GB / 1 vCPU).",
    );
    // null activeGatewayEnv (or an older server omitting it) keeps the
    // defaults-active copy.
    expect(buildAutotuneDisabledParagraph(kProfile, null)).toContain(
      "AlphaClaw and the gateway run with built-in defaults",
    );
  });

  // The container's onToggleEnabled outcome path lives behind preact hooks
  // this stateless harness can't run, so the kill-switch honesty rule is
  // pinned at the builder the container calls with the adopted ledger.
  it("toggle toast: a 'successful' enable overridden by the kill-switch reports honestly", () => {
    const killSwitchLedger = makeLedger({
      enabled: false,
      killSwitchActive: true,
    });
    expect(buildAutotuneToggleToast(true, killSwitchLedger)).toEqual({
      message: kAutotuneKillSwitchToast,
      tone: "info",
    });
    expect(kAutotuneKillSwitchToast).toBe(
      "Autotune stays off: the ALPHACLAW_AUTOTUNE_DISABLED environment kill-switch is set on this deployment — remove it to enable.",
    );
    // Normal outcomes keep the normal copy — including enabled=false WITHOUT
    // the kill-switch (older server) and a disable while the switch is set.
    expect(
      buildAutotuneToggleToast(true, makeLedger({ enabled: true })).message,
    ).toContain("Resource autotune enabled");
    expect(
      buildAutotuneToggleToast(true, makeLedger({ enabled: false })).message,
    ).toContain("Resource autotune enabled");
    expect(buildAutotuneToggleToast(false, killSwitchLedger).message).toContain(
      "Resource autotune disabled",
    );
  });

  it("row model: clamped keeps the server's override-clamp reason inline", () => {
    const model = buildAutotuneRowModel(
      {
        knob: "gatewayHeapMb",
        value: 4096,
        status: "clamped",
        restartTarget: null,
        reason:
          "Your override (16 GB) is larger than this machine can hold — 4.0 GB applied instead.",
      },
      { trigger: "boot" },
    );
    expect(model.chip).toEqual({ tone: "info", label: "Clamped" });
    expect(model.reasonLine).toContain("larger than this machine can hold");
    expect(model.showGatewayRestart).toBe(false);
  });

  it("row model: verified renders in the value line only (no second checkmark system)", () => {
    const model = buildAutotuneRowModel(
      {
        knob: "agentConcurrencyCap",
        value: 32,
        effectiveValue: 24,
        effectiveSource: "telegram demand",
        status: "pending_restart",
        restartTarget: "gateway",
        verified: true,
      },
      { trigger: "boot" },
    );
    expect(model.valueLine).toContain("confirmed in openclaw.json");
    expect(model.effectiveLine).toBe("Effective: 24 agents (telegram demand)");
    expect(model.chip.label).toBe("Restart gateway");
  });

  it("machine echo and environment notes branch on suppression and environment", () => {
    expect(buildAutotuneMachineEcho(kProfile)).toBe(
      "Detected: 2.0 GB RAM · 1 vCPU · small tier",
    );
    expect(
      buildAutotuneEnvironmentNote(makeLedger({ suppressed: true })),
    ).toEqual({
      tone: "warning",
      text: "Autotune held the built-in defaults because this container's limits are unreadable.",
    });
    const bareMetal = buildAutotuneEnvironmentNote(
      makeLedger({
        profile: {
          ...kProfile,
          memory: { limitBytes: 64 * kGb, source: "host" },
          cpu: { cores: 16 },
          environment: "bare-metal",
        },
      }),
    );
    expect(bareMetal.tone).toBe("muted");
    const unknownHost = buildAutotuneEnvironmentNote(
      makeLedger({
        profile: {
          ...kProfile,
          memory: { limitBytes: 64 * kGb, source: "host" },
          cpu: { cores: 16 },
          environment: "unknown",
        },
      }),
    );
    expect(unknownHost.tone).toBe("warning");
    expect(unknownHost.text).toContain("64.0 GB / 16 cores");
    expect(buildAutotuneEnvironmentNote(makeLedger())).toBeNull();
  });

  it("resize banner derives from lastResize.acknowledged and pending rows", () => {
    expect(buildAutotuneResizeBanner(makeLedger())).toBeNull();
    const lastResize = {
      from: { memoryLimitBytes: 2 * kGb, cpuCores: 1 },
      to: { memoryLimitBytes: 8 * kGb, cpuCores: 4 },
      at: 1756400000000,
      acknowledged: false,
    };
    const bootRetune = buildAutotuneResizeBanner(makeLedger({ lastResize }));
    expect(bootRetune.text).toBe(
      "Container resized 2.0 GB → 8.0 GB, 1 vCPU → 4 vCPU — settings retuned.",
    );
    expect(bootRetune.showRestart).toBe(false);
    const liveResize = buildAutotuneResizeBanner(
      makeLedger({
        lastResize,
        rows: [
          { knob: "gatewayHeapMb", status: "pending_restart", restartTarget: "gateway" },
        ],
      }),
    );
    expect(liveResize.text).toContain("Restart the gateway to finish applying.");
    expect(liveResize.showRestart).toBe(true);
    expect(
      buildAutotuneResizeBanner(
        makeLedger({ lastResize: { ...lastResize, acknowledged: true } }),
      ),
    ).toBeNull();
  });

  it("recommendation hides when within 10% of the running admin heap", () => {
    const row = {
      knob: "adminHeapRecommendedMb",
      value: 512,
      status: "manual",
      restartTarget: "alphaclaw",
    };
    const shown = buildAutotuneRecommendationModel(
      makeLedger({ rows: [{ ...row, effectiveValue: 2048 }] }),
    );
    // The README's per-process form — the flag on the start command, never a
    // blanket NODE_OPTIONS env var (children like the self-update npm install
    // would inherit that).
    expect(shown.command).toBe(
      "node --max-old-space-size=512 bin/alphaclaw.js start",
    );
    expect(shown.text).toContain(
      "add --max-old-space-size=512 to your AlphaClaw start command",
    );
    expect(shown.text).not.toContain("NODE_OPTIONS=");
    expect(shown.owner).toContain("does not apply on a gateway restart");
    expect(
      buildAutotuneRecommendationModel(
        makeLedger({ rows: [{ ...row, effectiveValue: 520 }] }),
      ),
    ).toBeNull();
  });

  it("overrides line lists set keys with humanized values", () => {
    expect(buildAutotuneOverridesLine({})).toBeNull();
    expect(buildAutotuneOverridesLine({ gatewayHeapMb: null })).toBeNull();
    expect(
      buildAutotuneOverridesLine({ gatewayHeapMb: 4096, uvThreadpoolSize: 8 }),
    ).toBe("Overrides: gatewayHeapMb 4.0 GB, uvThreadpoolSize 8 threads");
  });
});

describe("frontend/watchdog autotune card — per-state renders", () => {
  it("LOADING: keeps the card frame with a scoped loading line", () => {
    const tree = renderView({ ledger: null, error: null });
    const text = treeText(tree);
    expect(text).toContain("Resource autotune");
    expect(text).toContain("Loading autotune status...");
    expect(text).not.toContain("Recalculate and apply settings");
  });

  it("ERROR (first load): inline error with Retry, no fabricated content", () => {
    const onRetry = () => {};
    const tree = renderView({ ledger: null, error: new Error("boom"), onRetry });
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.onRetry).toBe(onRetry);
    expect(treeText(tree)).toContain("Couldn't load autotune status.");
  });

  it("ERROR (refresh with data on screen): keeps rows plus a stale-refresh chip", () => {
    const tree = renderView({
      ledger: makeLedger({ rows: [appliedRow("gatewayHeapMb", 1024)] }),
      error: new Error("flaky"),
    });
    const text = treeText(tree);
    expect(text).toContain(
      "Couldn't refresh autotune status — showing the last loaded values.",
    );
    expect(text).toContain("Gateway memory limit (V8 heap)");
    expect(findRowByKnob(tree, "gatewayHeapMb")).toBeTruthy();
  });

  it("DISABLED: machine echo stays, rows are replaced by the muted paragraph, overrides row survives", () => {
    const tree = renderView({
      enabled: false,
      ledger: makeLedger({
        enabled: false,
        rows: [appliedRow("gatewayHeapMb", 1024)],
      }),
    });
    const text = treeText(tree);
    expect(text).toContain("Detected: 2.0 GB RAM · 1 vCPU · small tier");
    expect(text).toContain(
      "Autotune is off. AlphaClaw and the gateway run with built-in defaults sized for small containers. Detection stays on — Small tier (2.0 GB / 1 vCPU).",
    );
    // No ghost/derived values and no mutation affordance while off.
    expect(text).not.toContain("Gateway memory limit (V8 heap)");
    expect(text).not.toContain("Recalculate and apply settings");
    // The overrides row ALWAYS renders — the heap-OOM journey depends on it.
    expect(text).toContain("Overrides: none set");
    expect(text).toContain("Gateway heap override (MB)");
  });

  it("DISABLED with a still-tuned gateway: the paragraph switches on activeGatewayEnv", () => {
    const tree = renderView({
      enabled: false,
      ledger: makeLedger({
        enabled: false,
        activeGatewayEnv: {
          gatewayHeapMb: 1741,
          uvThreadpoolSize: 8,
          at: 1756400000000,
        },
      }),
    });
    const text = treeText(tree);
    expect(text).toContain(
      "Autotune is off, but the running gateway still uses its previous tuned values — built-in defaults apply after the next gateway restart.",
    );
    expect(text).not.toContain(
      "AlphaClaw and the gateway run with built-in defaults",
    );
    expect(text).toContain("Detection stays on — Small tier (2.0 GB / 1 vCPU).");
  });

  it("DEGRADED/SUPPRESSED: held-defaults warning above skipped rows", () => {
    const tree = renderView({
      ledger: makeLedger({
        suppressed: true,
        suppressedReason: "container limits unavailable",
        profile: {
          ...kProfile,
          memory: { limitBytes: 64 * kGb, source: "host" },
          cpu: { cores: 16 },
          environment: "container",
        },
        rows: [
          {
            knob: "gatewayHeapMb",
            value: null,
            status: "skipped",
            restartTarget: null,
            reason: "container limits unavailable",
          },
          {
            knob: "agentConcurrencyCap",
            value: null,
            status: "skipped",
            restartTarget: null,
            reason: "container limits unavailable",
          },
        ],
      }),
    });
    const text = treeText(tree);
    expect(text).toContain(
      "Autotune held the built-in defaults because this container's limits are unreadable.",
    );
    expect(text).toContain("No settings tuned — 2 settings skipped");
    const badges = findAllByType(tree, Badge);
    const skippedBadges = badges.filter(
      (badge) =>
        badge.props.tone === "warning" &&
        collectText(badge.props.children).join("") === "Skipped",
    );
    expect(skippedBadges.length).toBe(2);
  });

  it("PARTIAL: summary carries counts and a Partially applied chip, never amber styling alone", () => {
    const rows = [
      ...Array.from({ length: 6 }, (unused, i) => appliedRow(`knob${i}`, 1)),
      { knob: "gatewayHeapMb", status: "pending_restart", restartTarget: "gateway", value: 4096 },
      { knob: "uvThreadpoolSize", status: "pending_restart", restartTarget: "gateway", value: 8 },
    ];
    const tree = renderView({ ledger: makeLedger({ rows }) });
    const text = treeText(tree);
    expect(text).toContain(
      "8 settings tuned — 6 applied, 2 pending gateway restart",
    );
    const partialBadge = findAllByType(tree, Badge).find(
      (badge) =>
        collectText(badge.props.children).join("") === "Partially applied",
    );
    expect(partialBadge).toBeTruthy();
    expect(partialBadge.props.tone).toBe("warning");
  });

  it("EMPTY: no rows yet renders the boot note with the machine echo", () => {
    const tree = renderView({ ledger: makeLedger({ rows: [] }) });
    const text = treeText(tree);
    expect(text).toContain("Detected: 2.0 GB RAM · 1 vCPU · small tier");
    expect(text).toContain("No tunings applied yet — they apply at boot.");
  });

  it("micro tier adds the too-small note and drops the admin-heap recommendation row", () => {
    const tree = renderView({
      ledger: makeLedger({
        profile: {
          ...kProfile,
          memory: { limitBytes: 512 * 1024 * 1024, source: "cgroup-v2" },
          tier: "micro",
        },
        rows: [appliedRow("gatewayHeapMb", 256)],
      }),
    });
    const text = treeText(tree);
    expect(text).toContain(
      "This is a very small container — memory is tight; 1 GB+ is recommended.",
    );
    expect(text).not.toContain("Recommendation");
  });

  it("resize-banner buttons carry the house disabled classes while their action is in flight", () => {
    const ledger = makeLedger({
      lastResize: {
        from: { memoryLimitBytes: 2 * kGb, cpuCores: 1 },
        to: { memoryLimitBytes: 8 * kGb, cpuCores: 4 },
        at: 1756400000000,
        acknowledged: false,
      },
      rows: [
        { knob: "gatewayHeapMb", status: "pending_restart", restartTarget: "gateway" },
      ],
    });
    const buttonByText = (tree, text) =>
      collectNodes(tree).find(
        (vnode) =>
          vnode.type === "button" &&
          collectText(vnode).join(" ").trim() === text,
      );

    const idle = renderView({ ledger });
    const idleRestart = buttonByText(idle, "Restart gateway");
    const idleDismiss = buttonByText(idle, "Dismiss");
    expect(idleRestart.props.class).not.toContain("opacity-50 cursor-not-allowed");
    expect(idleDismiss.props.class).not.toContain("opacity-50 cursor-not-allowed");

    const busy = renderView({
      ledger,
      restartingGateway: true,
      dismissingResize: true,
    });
    const busyRestart = buttonByText(busy, "Restarting...");
    const busyDismiss = buttonByText(busy, "Dismissing...");
    expect(busyRestart.props.disabled).toBe(true);
    expect(busyRestart.props.class).toContain("opacity-50 cursor-not-allowed");
    expect(busyDismiss.props.disabled).toBe(true);
    expect(busyDismiss.props.class).toContain("opacity-50 cursor-not-allowed");
    expectNoExpandErrors();
  });
});

describe("frontend/watchdog autotune card — restart ownership (restartTarget)", () => {
  const kPendingRows = [
    {
      knob: "uvThreadpoolSize",
      value: 8,
      status: "pending_restart",
      restartTarget: "gateway",
    },
    {
      knob: "openAiCompatBodyLimitMb",
      value: 32,
      status: "pending_restart",
      restartTarget: "alphaclaw",
    },
  ];

  it("gateway rows get the Restart gateway chip and an inline restart wired to onRestartGateway", () => {
    const onRestartGateway = () => {};
    const tree = renderView({
      ledger: makeLedger({ rows: kPendingRows }),
      onRestartGateway,
    });
    expectNoExpandErrors();
    const gatewayRow = findRowByKnob(tree, "uvThreadpoolSize");
    expect(gatewayRow).toBeTruthy();
    const gatewayButtons = collectNodes(gatewayRow).filter(
      (vnode) => vnode.type === "button",
    );
    expect(gatewayButtons.length).toBe(1);
    expect(gatewayButtons[0].props.onclick).toBe(onRestartGateway);
    expect(collectText(gatewayRow).join(" ")).toContain("Restart gateway");
  });

  it("alphaclaw rows NEVER render a gateway-restart affordance — reason text owns the exit", () => {
    const onRestartGateway = () => {};
    const tree = renderView({
      ledger: makeLedger({ rows: kPendingRows }),
      onRestartGateway,
    });
    // Negative assertions below are only meaningful over a FULLY expanded
    // tree — a swallowed subtree would hide a rogue button.
    expectNoExpandErrors();
    const alphaclawRow = findRowByKnob(tree, "openAiCompatBodyLimitMb");
    expect(alphaclawRow).toBeTruthy();
    const buttons = collectNodes(alphaclawRow).filter(
      (vnode) => vnode.type === "button",
    );
    expect(buttons.length).toBe(0);
    expect(collectText(alphaclawRow).join(" ")).toContain(
      kAutotuneAlphaclawRestartReason,
    );
  });

  it("with ONLY alphaclaw-target pending rows, nothing in the card invokes onRestartGateway", () => {
    const onRestartGateway = () => {};
    const tree = renderView({
      ledger: makeLedger({ rows: [kPendingRows[1]] }),
      onRestartGateway,
    });
    expectNoExpandErrors();
    const wired = collectNodes(tree).filter(
      (vnode) => vnode.props?.onclick === onRestartGateway,
    );
    expect(wired.length).toBe(0);
    // And no gateway-pending banner either — the pending notice is
    // gateway-owned; alphaclaw rows explain themselves inline.
    expect(treeText(tree)).not.toContain("waiting on a gateway restart");
  });
});

describe("frontend/watchdog autotune card — container heap override draft", () => {
  // Renders the CONTAINER through the hook harness (cache-seeded so both
  // hooks hydrate synchronously; effects are collected, not run) and returns
  // the props it passed to the view.
  const renderContainer = () => {
    hookHarness.beginRender();
    const tree = WatchdogAutotuneCard({});
    const view = collectNodes(tree).find(
      (vnode) => vnode.type === AutotuneCardView,
    );
    expect(view).toBeTruthy();
    return view.props;
  };

  beforeEach(() => {
    hookHarness.reset();
    invalidateCache(kAutotuneCacheKey);
    updateAutotuneSettings.mockReset();
  });

  it("failed heap-override save drops the rejected draft — the field shows the server value", async () => {
    setCached(kAutotuneCacheKey, {
      ok: true,
      ledger: makeLedger({ overrides: { gatewayHeapMb: 1024 } }),
    });
    let view = renderContainer();
    expect(view.settingHydrated).toBe(true);
    expect(view.heapDraftValue).toBe("1024");

    view.onHeapInput({ target: { value: "2048" } });
    view = renderContainer();
    expect(view.heapDraftValue).toBe("2048");
    expect(view.heapDirty).toBe(true);

    updateAutotuneSettings.mockRejectedValueOnce(new Error("boom"));
    await view.onHeapSave();
    view = renderContainer();
    // The hook reverted to the server value AND the rejected draft is gone —
    // the chip's "showing the server's current state" claim stays true and
    // Save is no longer armed with the never-adopted value.
    expect(updateAutotuneSettings).toHaveBeenCalledWith({
      overrides: { gatewayHeapMb: 2048 },
    });
    expect(view.heapDraftValue).toBe("1024");
    expect(view.heapDirty).toBe(false);
    expect(view.settingSaveError?.context).toBe(kAutotuneHeapContext);
  });
});
