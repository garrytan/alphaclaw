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
            active: false,
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
    expect(model.rows[0].chip).toEqual({ tone: "danger", label: "Truncated" });
    expect(model.rows[1].chip).toEqual({ tone: "warning", label: "Starved" });
    expect(model.rows[2].chip).toEqual({ tone: "danger", label: "Blocked" });

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
