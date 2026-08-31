const loadDoctorHelpers = async () =>
  import("../../lib/public/js/components/doctor/helpers.js");

describe("frontend/doctor helpers", () => {
  it("groups cards by status and counts priorities", async () => {
    const helpers = await loadDoctorHelpers();
    const cards = [
      { id: 1, priority: "P0", status: "open" },
      { id: 2, priority: "P1", status: "dismissed" },
      { id: 3, priority: "P2", status: "fixed" },
      { id: 4, priority: "P2", status: "open" },
      { id: 5, priority: "P2", status: "working" },
    ];

    expect(helpers.buildDoctorPriorityCounts(cards)).toEqual({
      P0: 1,
      P1: 1,
      P2: 3,
    });
    expect(helpers.groupDoctorCardsByStatus(cards)).toEqual({
      open: [
        { id: 1, priority: "P0", status: "open" },
        { id: 4, priority: "P2", status: "open" },
      ],
      working: [{ id: 5, priority: "P2", status: "working" }],
      dismissed: [{ id: 2, priority: "P1", status: "dismissed" }],
      fixed: [{ id: 3, priority: "P2", status: "fixed" }],
    });
  });

  it("only shows the warning for stale Doctor states with meaningful changes", async () => {
    const helpers = await loadDoctorHelpers();

    expect(
      helpers.shouldShowDoctorWarning({
        needsInitialRun: true,
        stale: true,
        changeSummary: { hasMeaningfulChanges: true },
      }),
    ).toBe(false);
    expect(
      helpers.shouldShowDoctorWarning({
        needsInitialRun: false,
        stale: false,
        changeSummary: { hasMeaningfulChanges: true },
      }),
    ).toBe(false);
    expect(
      helpers.shouldShowDoctorWarning({
        needsInitialRun: false,
        stale: true,
        changeSummary: { hasMeaningfulChanges: false },
      }),
    ).toBe(false);
    expect(
      helpers.shouldShowDoctorWarning(
        {
          needsInitialRun: false,
          stale: true,
          changeSummary: { hasMeaningfulChanges: true },
        },
        Date.now() + 1000,
      ),
    ).toBe(false);
    expect(
      helpers.shouldShowDoctorWarning({
        needsInitialRun: false,
        stale: true,
        changeSummary: { hasMeaningfulChanges: true },
      }),
    ).toBe(true);
    expect(
      helpers.getDoctorWarningMessage({
        needsInitialRun: false,
        stale: true,
        changeSummary: { changedFilesCount: 3 },
      }),
    ).toBe(
      "Drift Doctor has not been run in the last week and 3 files changed since the last review.",
    );
  });

  it("formats categories and run filter options", async () => {
    const helpers = await loadDoctorHelpers();

    expect(helpers.formatDoctorCategory("token_efficiency")).toBe(
      "Token Efficiency",
    );
    expect(helpers.getDoctorCategoryTone("token_efficiency")).toBe("info");
    expect(helpers.getDoctorCategoryTone("redundancy")).toBe("accent");
    expect(helpers.getDoctorCategoryTone("workspace_state")).toBe("secondary");
    expect(
      helpers.buildDoctorRunMarkers({
        status: "completed",
        cardCount: 0,
        priorityCounts: { P0: 0, P1: 0, P2: 0 },
      }),
    ).toEqual([{ tone: "success", count: 0, label: "No findings" }]);
    expect(
      helpers.buildDoctorRunMarkers({
        status: "completed",
        cardCount: 3,
        priorityCounts: { P0: 2, P1: 1, P2: 0 },
      }),
    ).toEqual([
      { tone: "danger", count: 0, label: "P0" },
      { tone: "warning", count: 0, label: "P1" },
    ]);
    expect(
      helpers.buildDoctorRunMarkers({
        status: "running",
      }),
    ).toEqual([{ tone: "cyan", count: 0, label: "Running" }]);
    expect(helpers.getDoctorRunPillDetail({ status: "failed" })).toBe("Failed");
    expect(
      helpers.getDoctorRunPillDetail({ status: "completed", cardCount: 0 }),
    ).toBe("No findings");
    expect(helpers.getDoctorChangeLabel({ changedFilesCount: 0 })).toBe(
      "No changes since last run",
    );
    expect(helpers.getDoctorChangeLabel({ changedFilesCount: 2 })).toBe(
      "2 changes since last run",
    );
    expect(helpers.getDoctorChangeLabel({ changedFilesCount: 1 })).toBe(
      "1 change since last run",
    );
    expect(helpers.getDoctorStatusTone("fixed")).toBe("success");
    expect(helpers.getDoctorStatusTone("working")).toBe("info");
    expect(helpers.buildDoctorStatusFilterOptions()).toEqual([
      { value: "open", label: "Open" },
      { value: "working", label: "Working" },
      { value: "dismissed", label: "Dismissed" },
      { value: "fixed", label: "Fixed" },
    ]);
  });

  it("formats persistent Project Context truncation warnings", async () => {
    const helpers = await loadDoctorHelpers();
    const fileLimitStatus = {
      bootstrapContext: {
        hasActiveTruncation: true,
        hasActiveNearLimitFiles: false,
        hasActiveWarnings: true,
        hasTotalLimitTruncation: false,
        bootstrapMaxChars: 20000,
        bootstrapTotalMaxChars: 150000,
        truncationGuidance:
          "OpenClaw trims oversized injected files by keeping the first 70%, keeping the last 20%, and cutting the middle 10% without a warning.",
        activeTruncatedFiles: [
          { path: "AGENTS.md", rawChars: 24500, injectedChars: 20000 },
        ],
        activeNearLimitFiles: [],
      },
    };
    const multiFileStatus = {
      bootstrapContext: {
        hasActiveTruncation: true,
        hasActiveNearLimitFiles: true,
        hasActiveWarnings: true,
        hasTotalLimitTruncation: true,
        bootstrapMaxChars: 20000,
        bootstrapTotalMaxChars: 150000,
        truncationGuidance:
          "OpenClaw trims oversized injected files by keeping the first 70%, keeping the last 20%, and cutting the middle 10% without a warning.",
        activeTruncatedFiles: [
          { path: "AGENTS.md", rawChars: 24500, injectedChars: 20000 },
          {
            path: "hooks/bootstrap/AGENTS.md",
            rawChars: 1800,
            injectedChars: 1000,
          },
        ],
        activeNearLimitFiles: [
          { path: "TOOLS.md", rawChars: 20000 },
          {
            path: "hooks/bootstrap/TOOLS.md",
            rawChars: 19500,
            injectedChars: 19500,
          },
        ],
      },
    };

    const nearLimitStatus = {
      bootstrapContext: {
        hasActiveTruncation: false,
        hasActiveNearLimitFiles: true,
        hasActiveWarnings: true,
        bootstrapMaxChars: 20000,
        bootstrapTotalMaxChars: 150000,
        activeTruncatedFiles: [],
        activeNearLimitFiles: [
          { path: "TOOLS.md", rawChars: 19000, injectedChars: 19000 },
        ],
      },
    };

    expect(helpers.hasDoctorBootstrapWarnings(fileLimitStatus)).toBe(true);
    expect(helpers.getDoctorBootstrapWarningTitle(fileLimitStatus)).toBe(
      "One of your main files is being truncated:",
    );
    expect(helpers.getDoctorBootstrapWarningTitle(multiFileStatus)).toBe(
      "Some of your main files are being truncated or nearing the limit:",
    );
    expect(helpers.getDoctorBootstrapTruncationItems(multiFileStatus)).toEqual([
      {
        path: "AGENTS.md",
        size: "24,500 chars",
        statusText: "-4,500 cut",
        statusTone: "danger",
      },
      {
        path: "TOOLS.md",
        size: "20,000 chars",
        statusText: "Near limit",
        statusTone: "warning",
      },
    ]);
    expect(helpers.getDoctorBootstrapWarningTitle(nearLimitStatus)).toBe(
      "One of your main files is nearing the limit:",
    );
    expect(helpers.getDoctorBootstrapTruncationItems(fileLimitStatus)).toEqual([
      {
        path: "AGENTS.md",
        size: "24,500 chars",
        statusText: "-4,500 cut",
        statusTone: "danger",
      },
    ]);
    expect(helpers.getDoctorBootstrapTruncationItems(nearLimitStatus)).toEqual([
      {
        path: "TOOLS.md",
        size: "19,000 chars",
        statusText: "Near limit",
        statusTone: "warning",
      },
    ]);
  });
});

describe("frontend/doctor scan-limited banner copy", () => {
  it("renders real numbers from the workspaceScan payload", async () => {
    const helpers = await loadDoctorHelpers();
    const line = helpers.getDoctorScanLimitedLine({
      capsUsed: { maxFiles: 200000, maxFileBytes: 50 * 1024 * 1024 },
      stats: {
        totalFiles: 234567,
        skippedLargeCount: 3,
        hashBudgetSkippedCount: 2,
        skippedDirCount: 1,
      },
    });
    expect(line).toContain("234,567");
    expect(line).toContain("cap 200,000");
    expect(line).toContain("3 files over 50MB skipped");
    expect(line).toContain("2 files beyond the hash budget skipped");
    expect(line).toContain("1 unreadable folder skipped");
    // The old banner hardcoded these — they must come from data now.
    expect(line).not.toContain("50k files / 10MB");
  });

  it("marks a saturated count and omits zero-count clauses", async () => {
    const helpers = await loadDoctorHelpers();
    const line = helpers.getDoctorScanLimitedLine({
      capsUsed: { maxFiles: 1000, maxFileBytes: 10 * 1024 * 1024 },
      stats: { totalFiles: 1000000, totalFilesSaturated: true, skippedLargeCount: 0 },
    });
    expect(line).toContain("1,000,000+ files found");
    expect(line).not.toContain("over 10MB skipped");
  });

  it("falls back to generic copy when the server predates workspaceScan", async () => {
    const helpers = await loadDoctorHelpers();
    expect(helpers.getDoctorScanLimitedLine(null)).toBe(
      "Drift detection is partial: the workspace exceeds the scan caps.",
    );
    expect(helpers.getDoctorScanLimitedLine({ stats: null })).toContain(
      "exceeds the scan caps",
    );
  });
});

describe("frontend/doctor scan-limited banner fallback shapes", () => {
  it("falls back to workspaceScan.effective when capsUsed is missing", async () => {
    const helpers = await loadDoctorHelpers();
    const line = helpers.getDoctorScanLimitedLine({
      effective: { maxFiles: 200000, maxFileBytes: 50 * 1024 * 1024 },
      stats: { totalFiles: 250000, skippedLargeCount: 1 },
    });
    expect(line).toContain("cap 200,000");
    expect(line).toContain("1 file over 50MB skipped");
  });
});
