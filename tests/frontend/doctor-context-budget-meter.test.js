import { describe, expect, it } from "vitest";
import {
  ContextBudgetMeter,
  buildContextBudgetMeterModel,
} from "../../lib/public/js/components/doctor/context-budget-meter.js";

const kBaseFile = {
  kind: "root",
  exists: true,
  active: true,
  injectable: true,
  skipped: false,
  truncated: false,
  truncatedByFileLimit: false,
  truncatedByTotalLimit: false,
  nearFileLimit: false,
  reason: "",
  activeReason: "",
};

const statusWithContext = (overrides = {}) => ({
  bootstrapContext: {
    estimated: true,
    bootstrapMaxChars: 20000,
    bootstrapTotalMaxChars: 60000,
    activeInjectedChars: 30000,
    hasActiveTruncation: false,
    hasActiveNearLimitFiles: false,
    nearTotalLimit: false,
    totalLimitReached: false,
    hardening: { state: "injected", files: [] },
    files: [],
    ...overrides,
  },
});

describe("frontend/doctor context budget meter model", () => {
  it("is hidden for missing statuses and old payloads", () => {
    expect(buildContextBudgetMeterModel(null)).toBe(null);
    expect(buildContextBudgetMeterModel({})).toBe(null);
    // Old server: no bootstrapContext.files array.
    expect(
      buildContextBudgetMeterModel({
        bootstrapContext: { activeTruncatedFiles: [] },
      }),
    ).toBe(null);
    // Old server: files present but hardening block absent.
    expect(
      buildContextBudgetMeterModel({
        bootstrapContext: {
          files: [{ ...kBaseFile, path: "AGENTS.md" }],
        },
      }),
    ).toBe(null);
  });

  it("is hidden when no relevant files exist (fresh install)", () => {
    expect(buildContextBudgetMeterModel(statusWithContext())).toBe(null);
    // Non-existing files and inactive root files are filtered out.
    expect(
      buildContextBudgetMeterModel(
        statusWithContext({
          files: [
            { ...kBaseFile, path: "AGENTS.md", exists: false },
            { ...kBaseFile, path: "NOTES.md", active: false },
          ],
        }),
      ),
    ).toBe(null);
  });

  it("computes the budget bar and per-file rows", () => {
    const model = buildContextBudgetMeterModel(
      statusWithContext({
        activeInjectedChars: 30000,
        files: [
          {
            ...kBaseFile,
            path: "AGENTS.md",
            rawChars: 10000,
            capChars: 20000,
            injectedChars: 10000,
          },
          {
            ...kBaseFile,
            path: "TOOLS.md",
            rawChars: 19500,
            capChars: 20000,
            injectedChars: 19500,
            nearFileLimit: true,
          },
          {
            ...kBaseFile,
            path: "hooks/bootstrap/extra.md",
            kind: "extra",
            active: true,
            activeReason: "",
            rawChars: 500,
            capChars: 20000,
            injectedChars: 500,
          },
          { ...kBaseFile, path: "missing.md", exists: false },
        ],
      }),
    );

    expect(model.usedChars).toBe(30000);
    expect(model.budgetChars).toBe(60000);
    expect(model.percentUsed).toBe(50);
    expect(model.barTone).toBe("ok");
    expect(model.summary).toBe("30,000 / 60,000 chars");
    expect(model.rows.map((row) => row.path)).toEqual([
      "AGENTS.md",
      "TOOLS.md",
      "hooks/bootstrap/extra.md",
    ]);
    expect(model.rows[0].state).toBe("ok");
    expect(model.rows[0].chip).toEqual({ tone: "success", label: "OK" });
    expect(model.rows[0].detail).toBe("10,000 / 10,000 chars");
    expect(model.rows[1].state).toBe("near-limit");
    expect(model.rows[1].chip.tone).toBe("warning");
  });

  it("clamps the percent (used for aria-valuenow) to an integer within 0-100", () => {
    // Rounds to a whole number.
    const rounded = buildContextBudgetMeterModel(
      statusWithContext({
        activeInjectedChars: 20000,
        files: [
          { ...kBaseFile, path: "AGENTS.md", rawChars: 100, injectedChars: 100 },
        ],
      }),
    );
    expect(rounded.percentUsed).toBe(33);
    // Over-budget totals clamp at 100.
    const overBudget = buildContextBudgetMeterModel(
      statusWithContext({
        activeInjectedChars: 120000,
        files: [
          { ...kBaseFile, path: "AGENTS.md", rawChars: 100, injectedChars: 100 },
        ],
      }),
    );
    expect(overBudget.percentUsed).toBe(100);
    // A missing budget renders 0, never NaN.
    const noBudget = buildContextBudgetMeterModel(
      statusWithContext({
        bootstrapTotalMaxChars: 0,
        activeInjectedChars: 500,
        files: [
          { ...kBaseFile, path: "AGENTS.md", rawChars: 100, injectedChars: 100 },
        ],
      }),
    );
    expect(noBudget.percentUsed).toBe(0);
  });

  it("flags truncated, starved, and blocked files with matching bar tones", () => {
    const model = buildContextBudgetMeterModel(
      statusWithContext({
        activeInjectedChars: 61000,
        hasActiveTruncation: true,
        totalLimitReached: true,
        files: [
          {
            ...kBaseFile,
            path: "AGENTS.md",
            rawChars: 25000,
            injectedChars: 20000,
            truncated: true,
            truncatedByFileLimit: true,
            reason: "file_limit",
          },
          {
            ...kBaseFile,
            path: "hooks/bootstrap/starved.md",
            kind: "extra",
            active: false,
            rawChars: 4000,
            injectedChars: 0,
            skipped: true,
            reason: "starved",
          },
          {
            ...kBaseFile,
            path: "hooks/bootstrap/blocked.md",
            kind: "extra",
            active: false,
            rawChars: 900,
            injectedChars: 0,
            injectable: false,
            skipped: true,
            reason: "",
          },
        ],
      }),
    );

    expect(model.percentUsed).toBe(100);
    expect(model.barTone).toBe("danger");
    expect(model.rows.map((row) => row.state)).toEqual([
      "truncated",
      "starved",
      "blocked",
    ]);
    // Vocabulary unification with the General hardening card: a fully-cut
    // file is "Dropped" to a user, never the internal "starved".
    expect(model.rows[0].chip).toEqual({ tone: "danger", label: "Truncated" });
    expect(model.rows[1].chip).toEqual({ tone: "warning", label: "Dropped" });
    expect(model.rows[2].chip).toEqual({ tone: "danger", label: "Blocked" });
    // Rows expose the reason and cause+short tooltip copy for the chips.
    expect(model.rows[0].reason).toBe("file_limit");
    expect(model.rows[0].chipTooltip).toContain("per-file injection cap");
    expect(model.rows[1].chipTooltip).toContain("dropped entirely");

    const nearModel = buildContextBudgetMeterModel(
      statusWithContext({
        nearTotalLimit: true,
        files: [
          {
            ...kBaseFile,
            path: "AGENTS.md",
            rawChars: 1000,
            injectedChars: 1000,
          },
        ],
      }),
    );
    expect(nearModel.barTone).toBe("warning");
  });

  it("flags a non-active extra (hooks disabled) as blocked, never OK", () => {
    const model = buildContextBudgetMeterModel(
      statusWithContext({
        files: [
          // Hooks disabled: the analyzer keeps injectable:true but marks the
          // extra active:false — it is not reaching the agent.
          {
            ...kBaseFile,
            path: "hooks/bootstrap/SECURITY.md",
            kind: "extra",
            active: false,
            activeReason: "hook_disabled",
            injectable: true,
            skipped: false,
            rawChars: 1200,
            injectedChars: 0,
          },
          // Same shape with a basename rejection reason: also blocked.
          {
            ...kBaseFile,
            path: "hooks/bootstrap/BAD NAME.md",
            kind: "extra",
            active: false,
            activeReason: "invalid_basename",
            injectable: true,
            skipped: false,
            rawChars: 800,
            injectedChars: 0,
          },
          // A root file that is active stays OK.
          {
            ...kBaseFile,
            path: "AGENTS.md",
            rawChars: 1000,
            injectedChars: 1000,
          },
        ],
      }),
    );

    expect(model.rows.map((row) => [row.path, row.state])).toEqual([
      ["hooks/bootstrap/SECURITY.md", "blocked"],
      ["hooks/bootstrap/BAD NAME.md", "blocked"],
      ["AGENTS.md", "ok"],
    ]);
    expect(model.rows[0].chip).toEqual({ tone: "danger", label: "Blocked" });
  });

  it("renders nothing while the status is loading or the payload is old", () => {
    expect(ContextBudgetMeter({ doctorStatus: null })).toBe(null);
    expect(ContextBudgetMeter({ doctorStatus: {} })).toBe(null);
    // A modern payload with files renders a vnode.
    const vnode = ContextBudgetMeter({
      doctorStatus: statusWithContext({
        files: [
          {
            ...kBaseFile,
            path: "AGENTS.md",
            rawChars: 100,
            injectedChars: 100,
          },
        ],
      }),
    });
    expect(vnode).not.toBe(null);
  });
});

describe("frontend/doctor context budget meter rejected-read hints", () => {
  const blockedStatus = (reason, files) => ({
    bootstrapContext: {
      estimated: true,
      bootstrapMaxChars: 20000,
      bootstrapTotalMaxChars: 60000,
      activeInjectedChars: 100,
      hardening: { state: "blocked", reason, files },
      files: [
        {
          kind: "root",
          exists: true,
          active: true,
          injectable: true,
          skipped: false,
          truncated: false,
          nearFileLimit: false,
          reason: "",
          activeReason: "",
          path: "AGENTS.md",
          injectedChars: 100,
          rawChars: 100,
        },
      ],
    },
  });

  it("points at rejected-read files the row filter cannot show", () => {
    // exists:false files never appear as rows — the hint line is the meter's
    // honest pointer at them ("everything here looks OK" must not happen
    // while General says BLOCKED).
    const model = buildContextBudgetMeterModel(
      blockedStatus("escapes_workspace", [
        {
          path: "hooks/bootstrap/AGENTS.md",
          exists: false,
          reason: "escapes_workspace",
        },
      ]),
    );
    expect(model.rejectedHints).toEqual([
      "hooks/bootstrap/AGENTS.md is rejected before it can be read — run a scan for the full finding.",
    ]);
  });

  it("phrases plain-missing files as missing, not rejected", () => {
    const model = buildContextBudgetMeterModel(
      blockedStatus("missing_file", [
        { path: "hooks/bootstrap/AGENTS.md", exists: false, reason: "" },
      ]),
    );
    expect(model.rejectedHints).toEqual([
      "hooks/bootstrap/AGENTS.md is missing from disk — run a scan for the full finding.",
    ]);
  });

  it("points at the not_configured synthetic entry the rows cannot show", () => {
    // The on-disk-but-unconfigured file exists only in hardening.files —
    // never as a meter row — so the hint is its only pointer here.
    expect(
      buildContextBudgetMeterModel(
        blockedStatus("", [
          { path: "hooks/bootstrap/AGENTS.md", exists: true, reason: "not_configured" },
        ]),
      ).rejectedHints,
    ).toEqual([
      "hooks/bootstrap/AGENTS.md is on disk but has no bootstrap config entry — run a scan for the full finding.",
    ]);
  });

  it("emits no hints for row-visible blocked causes or empty file lists", () => {
    // invalid_basename/hook_disabled files exist and render as Blocked rows —
    // no hint needed on top.
    expect(
      buildContextBudgetMeterModel(
        blockedStatus("", [
          { path: "hooks/bootstrap/TOOLS.md", exists: true, reason: "invalid_basename" },
        ]),
      ).rejectedHints,
    ).toEqual([]);
    const healthy = buildContextBudgetMeterModel(
      blockedStatus("escapes_workspace", []),
    );
    expect(healthy.rejectedHints).toEqual([]);
  });
});

describe("frontend/doctor context budget meter healthy rows", () => {
  it("healthy and near-limit rows never carry failure tooltip copy", () => {
    const model = buildContextBudgetMeterModel(
      statusWithContext({
        files: [
          { ...kBaseFile, path: "AGENTS.md", rawChars: 100, injectedChars: 100 },
          {
            ...kBaseFile,
            path: "SOUL.md",
            rawChars: 19500,
            injectedChars: 19500,
            nearFileLimit: true,
          },
        ],
      }),
    );
    expect(model.rows[0].state).toBe("ok");
    expect(model.rows[0].chipTooltip).toBe("");
    expect(model.rows[1].state).toBe("near-limit");
    expect(model.rows[1].chipTooltip).toBe("");
  });
});
