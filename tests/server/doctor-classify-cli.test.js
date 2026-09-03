// Doctor-CLI outcome classifier (post-incident 2026-09-01): one fixture per
// precedence branch, both gating negatives, and the incident's literal error.
const {
  classifyDoctorCliResult,
  classifyFromRunStream,
  classifyFromClawCmd,
  matchesCliStartupFailure,
} = require("../../lib/server/doctor/classify-doctor-cli");

// The incident's exact upstream failure text (openclaw 2026.9.1-beta.1).
const kIncidentCrash =
  "Could not start the CLI.\nReason: Unable to resolve bundled plugin public surface codex/api.js";
const kFindings = JSON.stringify({
  ok: false,
  findings: [{ checkId: "core/x", severity: "warn", message: "m" }],
});
const kEnvelope = JSON.stringify({
  ok: false,
  error: { type: "cli_error", message: kIncidentCrash.replace(/\n/g, " ") },
});

describe("classifyDoctorCliResult precedence", () => {
  it("findings payload in a clean capture => usable, EVEN with a stray envelope or crash text in noise", () => {
    // Hostile fixture: a finding quoting a prior cli_error report plus crash
    // text on stderr must NOT manufacture a doctor outage.
    const hostile = classifyDoctorCliResult({
      ok: true,
      code: 0,
      stdout: `log noise ${kEnvelope}\n${kFindings}`,
      stderr: kIncidentCrash,
    });
    expect(hostile).toMatchObject({ status: "usable", reason: "findings" });

    // Envelope NESTED inside a finding message.
    const nested = classifyDoctorCliResult({
      ok: true,
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        findings: [{ checkId: "c", message: `saw ${kEnvelope}` }],
      }),
    });
    expect(nested.status).toBe("usable");
  });

  it("clean-exit non-structured output => usable/legacy (the pinned stable must never read unavailable)", () => {
    const legacy = classifyDoctorCliResult({
      ok: true,
      code: 0,
      stdout: "Doctor summary:\n  gateway: healthy\n  channels: 3 ok",
    });
    expect(legacy).toMatchObject({ status: "usable", reason: "legacy" });
    // Clean-exit error-SHAPED JSON is still the CLI's own successful output
    // (evidence-grade; the bridge separately requires findings for cards).
    const errorShaped = classifyDoctorCliResult({
      ok: true,
      code: 0,
      stdout: JSON.stringify({ status: "error-ish report", items: [] }),
    });
    expect(errorShaped.status).toBe("usable");
  });

  it("cli_error envelope => unavailable ONLY on a failed run with the exact type", () => {
    const real = classifyDoctorCliResult({ ok: false, code: 1, stdout: kEnvelope });
    expect(real).toMatchObject({ status: "unavailable", reason: "cli_error" });
    expect(real.detail).toContain("codex/api.js");

    // Gating negative 1: a non-cli_error envelope type never classifies.
    const otherType = classifyDoctorCliResult({
      ok: false,
      code: 1,
      stdout: JSON.stringify({ ok: false, error: { type: "backup_error", message: "x" } }),
    });
    expect(otherType.reason).toBe("nonzero_exit");

    // Gating negative 2: crash text with ok:true stays on the usable path.
    const okWithCrashText = classifyDoctorCliResult({
      ok: true,
      code: 0,
      stdout: `report done; earlier a subprocess said "Could not start the CLI"`,
    });
    expect(okWithCrashText.status).toBe("usable");
  });

  it("plain-text startup crash (the incident's stderr shape) => unavailable/cli_startup_crash", () => {
    const crash = classifyDoctorCliResult({
      ok: false,
      code: 1,
      stdout: "",
      stderr: kIncidentCrash,
    });
    expect(crash).toMatchObject({
      status: "unavailable",
      reason: "cli_startup_crash",
    });
    expect(crash.detail).toContain("Could not start the CLI");
  });

  it("timeout => unusable (a busy upstream lease is NOT a broken CLI); truncated => unusable", () => {
    expect(
      classifyDoctorCliResult({ ok: false, timedOut: true }),
    ).toMatchObject({ status: "unusable", reason: "timeout" });
    expect(
      classifyDoctorCliResult({ ok: false, truncated: true }),
    ).toMatchObject({ status: "unusable", reason: "truncated" });
    // A truncated/timed-out capture never gets payload-first trust.
    expect(
      classifyDoctorCliResult({ ok: false, truncated: true, stdout: kFindings }),
    ).toMatchObject({ status: "unusable" });
  });

  it("exit 2 => unavailable/exit_2 even when a payload parses (the CLI's own failure verdict wins)", () => {
    expect(
      classifyDoctorCliResult({ ok: false, code: 2, stdout: kFindings }),
    ).toMatchObject({ status: "unavailable", reason: "exit_2" });
  });

  it("spawn error and the defaults (exit 127 => nonzero_exit; ok+empty => no_payload)", () => {
    expect(
      classifyDoctorCliResult({ spawnError: new Error("spawn openclaw ENOENT") }),
    ).toMatchObject({ status: "unavailable", reason: "spawn_failed" });
    expect(
      classifyDoctorCliResult({ ok: false, code: 127, stdout: "", stderr: "sh: openclaw: not found" }),
    ).toMatchObject({ status: "unavailable", reason: "nonzero_exit" });
    expect(classifyDoctorCliResult({ ok: true, code: 0, stdout: "" })).toMatchObject(
      { status: "unusable", reason: "no_payload" },
    );
  });
});

describe("per-producer adapters", () => {
  it("classifyFromRunStream: error/timedOut/truncated trio", () => {
    expect(
      classifyFromRunStream({ ok: false, error: new Error("boom") }),
    ).toMatchObject({ status: "unavailable", reason: "spawn_failed" });
    expect(classifyFromRunStream({ ok: false, timedOut: true })).toMatchObject({
      status: "unusable",
      reason: "timeout",
    });
    expect(classifyFromRunStream({ ok: false, truncated: true })).toMatchObject(
      { status: "unusable", reason: "truncated" },
    );
    expect(
      classifyFromRunStream({ ok: true, code: 0, stdout: kFindings }),
    ).toMatchObject({ status: "usable", reason: "findings" });
  });

  it("classifyFromClawCmd: split streams; maxBuffer-kill reads as timedOut by producer contract", () => {
    expect(
      classifyFromClawCmd({ ok: false, code: 1, stdout: "", stderr: kIncidentCrash }),
    ).toMatchObject({ status: "unavailable", reason: "cli_startup_crash" });
    // clawCmd reports maxBuffer overflow as timedOut (killed+SIGTERM) — the
    // adapter deliberately classifies it as a retryable capture problem.
    expect(
      classifyFromClawCmd({ ok: false, code: null, timedOut: true }),
    ).toMatchObject({ status: "unusable", reason: "timeout" });
  });
});

describe("matchesCliStartupFailure (T6-narrowed: bootstrap failures only)", () => {
  it("matches crash text and bootstrap-flavored cli_error envelopes", () => {
    expect(matchesCliStartupFailure(kIncidentCrash)).toBe(true);
    expect(matchesCliStartupFailure(kEnvelope)).toBe(true);
  });
  it("does NOT match sub-command cli_error envelopes (backup failures etc.)", () => {
    const subCommand = JSON.stringify({
      ok: false,
      error: {
        type: "cli_error",
        message: "ENOENT: no such file or directory, realpath '/data/openclaw-agent.sqlite'",
      },
    });
    expect(matchesCliStartupFailure(subCommand)).toBe(false);
    expect(matchesCliStartupFailure("routine log line")).toBe(false);
  });
});
