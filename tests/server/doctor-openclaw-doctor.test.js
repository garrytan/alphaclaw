const {
  extractDoctorPayload,
  runOpenclawDoctorBridge,
} = require("../../lib/server/doctor/openclaw-doctor");

const passthroughSanitize = (text, { maxChars = 0 } = {}) => {
  const value = String(text ?? "");
  return maxChars > 0 && value.length > maxChars
    ? `${value.slice(0, maxChars - 1)}…`
    : value;
};

const makeResult = (payload, { code = 0, truncated = false, noise = "" } = {}) => ({
  ok: code === 0,
  code,
  truncated,
  stdout: `${noise}${JSON.stringify(payload)}\ntrailing noise`,
});

describe("server/doctor/openclaw-doctor", () => {
  it("extracts a findings payload from noisy stdout", () => {
    const payload = { ok: false, findings: [{ checkId: "a/b", severity: "info", message: "m" }] };
    const extracted = extractDoctorPayload(
      `warming up...\n${JSON.stringify(payload)}\nbye`,
    );
    expect(extracted).toEqual(payload);
    expect(extractDoctorPayload("no json here")).toBeNull();
    expect(extractDoctorPayload('{"ok":true}')).toBeNull();
  });

  it("maps findings to sourced cards with severity → priority", async () => {
    const result = await runOpenclawDoctorBridge({
      runLintJson: async () =>
        makeResult({
          ok: false,
          findings: [
            {
              checkId: "core/doctor/gateway-config",
              severity: "error",
              message: "gateway token missing",
              path: "openclaw.json",
              line: 12,
              fixHint: "Run openclaw doctor --fix to regenerate the token.",
            },
            { checkId: "core/doctor/skills-readiness", severity: "warning", message: "skill x unusable" },
            { checkId: "memory-core/embedding", severity: "info", message: "embeddings cold" },
          ],
        }),
      sanitize: passthroughSanitize,
    });

    expect(result.ok).toBe(true);
    expect(result.cards).toHaveLength(3);
    expect(result.cards[0]).toMatchObject({
      priority: "P0",
      category: "openclaw doctor",
      source: "openclaw_doctor",
      sourceKey: "ocd:core/doctor/gateway-config:openclaw.json",
      targetPaths: [{ path: "openclaw.json" }],
    });
    expect(result.cards[0].evidence).toEqual([
      { type: "path", path: "openclaw.json", startLine: 12 },
      { type: "text", text: "gateway token missing" },
    ]);
    // Template-only fixPrompt built from structural identifiers.
    expect(result.cards[0].fixPrompt).toContain("core/doctor/gateway-config");
    expect(result.cards[0].fixPrompt).toContain("openclaw doctor --lint --json");
    expect(result.cards[0].fixPrompt).not.toContain("gateway token missing");
    expect(result.cards[1].priority).toBe("P1");
    expect(result.cards[2].priority).toBe("P2");
    // Path-less findings key on a stable content hash.
    expect(result.cards[1].sourceKey).toBe("ocd:core/doctor/skills-readiness:168b43dbdda4");
  });

  it("suppresses upstream findings Drift Doctor covers deterministically", async () => {
    const result = await runOpenclawDoctorBridge({
      runLintJson: async () =>
        makeResult({
          ok: false,
          findings: [
            { checkId: "core/doctor/tools-md-migration", severity: "warning", message: "TOOLS.md found" },
            { checkId: "core/doctor/bootstrap-budget", severity: "warning", message: "AGENTS.md truncated in injection" },
            { checkId: "core/doctor/other", severity: "info", message: "fine" },
          ],
        }),
      sanitize: passthroughSanitize,
    });
    expect(result.cards.map((card) => card.sourceKey)).toEqual([
      "ocd:core/doctor/other:d14a58bae804",
    ]);
  });

  it("hard-caps mapped cards P0/P1-first and reports the drop count", async () => {
    const findings = [];
    for (let index = 0; index < 30; index += 1) {
      findings.push({
        checkId: `plugin/check-${index}`,
        severity: index < 5 ? "info" : "warning",
        message: `finding ${index}`,
      });
    }
    const result = await runOpenclawDoctorBridge({
      runLintJson: async () => makeResult({ ok: false, findings }),
      sanitize: passthroughSanitize,
    });
    expect(result.cards).toHaveLength(20);
    expect(result.droppedCount).toBe(10);
    expect(result.cards.every((card) => card.priority !== "P2" || result.cards.length < 20 || card.priority === "P2")).toBe(true);
    // All 20 kept cards are the P1s (25 warnings > 20 cap; infos dropped first).
    expect(result.cards.every((card) => card.priority === "P1")).toBe(true);
  });

  it("fails soft on spawn errors, exit 2, truncated capture, and garbage", async () => {
    const spawnError = await runOpenclawDoctorBridge({
      runLintJson: async () => {
        throw new Error("ENOENT");
      },
      sanitize: passthroughSanitize,
    });
    expect(spawnError).toMatchObject({ ok: false, cards: [] });

    const exitTwo = await runOpenclawDoctorBridge({
      runLintJson: async () => makeResult({ findings: [] }, { code: 2 }),
      sanitize: passthroughSanitize,
    });
    expect(exitTwo).toMatchObject({ ok: false, cards: [] });

    const truncated = await runOpenclawDoctorBridge({
      runLintJson: async () => makeResult({ findings: [] }, { truncated: true }),
      sanitize: passthroughSanitize,
    });
    expect(truncated).toMatchObject({ ok: false, cards: [] });

    const garbage = await runOpenclawDoctorBridge({
      runLintJson: async () => ({ ok: true, code: 0, truncated: false, stdout: "not json" }),
      sanitize: passthroughSanitize,
    });
    expect(garbage).toMatchObject({ ok: false, cards: [] });
  });

  it("accepts exit 1 (findings above threshold) as a valid payload", async () => {
    const result = await runOpenclawDoctorBridge({
      runLintJson: async () =>
        makeResult(
          { ok: false, findings: [{ checkId: "x/y", severity: "error", message: "boom" }] },
          { code: 1 },
        ),
      sanitize: passthroughSanitize,
    });
    expect(result.ok).toBe(true);
    expect(result.cards).toHaveLength(1);
  });

  it("caps mapped field lengths through the sanitizer", async () => {
    const longMessage = "m".repeat(2000);
    const result = await runOpenclawDoctorBridge({
      runLintJson: async () =>
        makeResult({
          ok: false,
          findings: [{ checkId: "x/y", severity: "info", message: longMessage }],
        }),
      sanitize: passthroughSanitize,
    });
    expect(result.cards[0].summary.length).toBeLessThanOrEqual(500);
  });
});
