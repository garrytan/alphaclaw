const fs = require("fs");
const os = require("os");
const path = require("path");

const { createUpgradeOverseer } = require("../../lib/server/upgrade-overseer");
const { createRunLedger } = require("../../lib/server/openclaw-run-ledger");
const {
  normalizeAlphaclawConfig,
  readOpenclawOverseerEnabled,
  updateOpenclawOverseerEnabled,
} = require("../../lib/server/alphaclaw-config");

const kOpId = "aaaaaaaa-0000-4000-8000-000000000001";

const makeLedger = () => {
  const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-test-"));
  return {
    openclawDir,
    ledger: createRunLedger({ openclawDir, logger: { log: () => {} } }),
  };
};

const seedFailedRun = (ledger, { operationId = kOpId } = {}) => {
  ledger.createRun({
    operationId,
    target: { channel: "beta", version: "2026.8.1-beta.3", sha: null, devHead: false },
  });
  ledger.completeRun(operationId, {
    state: "failed",
    ok: false,
    result: { ok: false, code: "verify_failed", message: "did not start" },
  });
};

// Dispatching runStream mock: responds per spawned command/args and records
// every call so tests can assert the exact env each child received.
const makeRunner = ({
  versionOk = true,
  helpText = "--output-format ... --disallowedTools ...",
  mainResult = null,
  mainThrows = false,
  onMainCall = null,
} = {}) => {
  const calls = [];
  const runStreamed = vi.fn(async (opts) => {
    calls.push(opts);
    const first = opts.args?.[0];
    if (first === "--version") {
      return { ok: versionOk, code: versionOk ? 0 : 1, tail: "1.2.3" };
    }
    if (first === "--help") {
      return { ok: true, code: 0, tail: helpText };
    }
    if (first === "doctor") {
      return { ok: true, code: 0, tail: '{"ok":true}' };
    }
    // main `claude -p ...` call
    if (typeof onMainCall === "function") onMainCall(opts);
    if (mainThrows) throw new Error("spawn ENOENT");
    return (
      mainResult || {
        ok: true,
        code: 0,
        tail: JSON.stringify({
          result: JSON.stringify({
            verdict: "healthy",
            summary: "All steps completed and doctor is clean.",
            recommendation: "Consider Mark as good.",
          }),
        }),
      }
    );
  });
  return { runStreamed, calls };
};

const makeOverseer = ({
  ledger,
  runner,
  env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-test-key" },
  enabled = true,
  channelInfo = () => ({ appliedId: "2026.8.1-beta.3", acceptedAt: 111 }),
  notify = vi.fn(async () => ({ ok: true })),
  getDoctorJson = async () => '{"ok":true}',
  getMachineSummary = undefined,
} = {}) => {
  const overseer = createUpgradeOverseer({
    ledger,
    runStream: runner,
    env,
    isEnabled: () => enabled,
    getChannelInfo: channelInfo,
    notify,
    getDoctorJson,
    ...(getMachineSummary !== undefined ? { getMachineSummary } : {}),
    logger: { log: () => {} },
  });
  return { overseer, notify };
};

describe("server/upgrade-overseer", () => {
  it("does nothing when disabled (default off)", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    const runner = makeRunner();
    const { overseer } = makeOverseer({ ledger, runner, enabled: false });

    const result = await overseer.maybeRunForLatest();

    expect(result).toEqual({ skipped: "disabled" });
    expect(runner.runStreamed).not.toHaveBeenCalled();
    expect(ledger.readRun(kOpId).overseer).toBeNull();
  });

  it("records an honest unavailable state when the Anthropic credential is missing", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    const runner = makeRunner();
    const { overseer, notify } = makeOverseer({
      ledger,
      runner,
      env: { PATH: "/usr/bin" }, // no ANTHROPIC_API_KEY
    });

    await overseer.maybeRunForLatest();

    const record = ledger.readRun(kOpId);
    expect(record.overseer.state).toBe("unavailable");
    expect(record.overseer.reason).toBe("no_anthropic_credential");
    expect(notify).not.toHaveBeenCalled();
    // The claude binary was never spawned without a credential.
    expect(runner.runStreamed).not.toHaveBeenCalled();
  });

  it("records unavailable when the claude binary probe fails", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    const runner = makeRunner({ versionOk: false });
    const { overseer } = makeOverseer({ ledger, runner });

    await overseer.maybeRunForLatest();

    const record = ledger.readRun(kOpId);
    expect(record.overseer.state).toBe("unavailable");
    expect(record.overseer.reason).toBe("claude_not_found");
    const availability = await overseer.getAvailability();
    expect(availability.available).toBe(false);
  });

  it("runs claude on a failed run and persists + notifies a valid verdict", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    const runner = makeRunner();
    const { overseer, notify } = makeOverseer({ ledger, runner });

    const result = await overseer.maybeRunForLatest();

    expect(result).toEqual({ ran: true, operationId: kOpId });
    const record = ledger.readRun(kOpId);
    expect(record.overseer.state).toBe("done");
    expect(record.overseer.verdict).toBe("healthy");
    expect(record.overseer.summary).toContain("doctor is clean");
    expect(record.overseer.toolRestriction).toBe("cli-flags");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("looks healthy");
    expect(notify.mock.calls[0][0]).toContain("Mark as good");
    expect(notify.mock.calls[0][1]).toEqual(
      // "healthy" verdict → informational (verbose); suspect/broken verdicts
      // stay important (plan Phase-3 predicate split).
      expect.objectContaining({
        operationId: kOpId,
        eventType: "overseer",
        verbose: true,
      }),
    );
    // The main call carried the discovered headless flags with tools disabled.
    const mainCall = runner.calls.find((c) => c.args?.[0] === "-p");
    expect(mainCall.args).toContain("--output-format");
    expect(mainCall.args).toContain("--disallowedTools");
    // The untrusted-log warning made it into the prompt.
    expect(mainCall.input).toContain("UNTRUSTED");
  });

  it("includes the numeric machine summary in the prompt's trusted block", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    const runner = makeRunner();
    const { overseer } = makeOverseer({
      ledger,
      runner,
      getMachineSummary: () => ({
        memoryMb: 2048,
        cores: 1,
        tier: "small",
        activeGatewayHeapMb: 1024,
      }),
    });

    await overseer.maybeRunForLatest();

    const mainCall = runner.calls.find((c) => c.args?.[0] === "-p");
    expect(mainCall.input).toContain("=== MACHINE (trusted, AlphaClaw-generated) ===");
    expect(mainCall.input).toContain('"memoryMb": 2048');
    expect(mainCall.input).toContain('"tier": "small"');
    // The untrusted-log framing is untouched.
    expect(mainCall.input).toContain("UNTRUSTED");
  });

  it("omits the machine section when getMachineSummary throws (fail-open)", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    const runner = makeRunner();
    const { overseer } = makeOverseer({
      ledger,
      runner,
      getMachineSummary: () => {
        throw new Error("profile exploded");
      },
    });

    await overseer.maybeRunForLatest();

    // The review still ran to a verdict; the section is simply absent.
    const mainCall = runner.calls.find((c) => c.args?.[0] === "-p");
    expect(mainCall.input).not.toContain("=== MACHINE");
    expect(mainCall.input).toContain("=== CHANNEL STATE (trusted, AlphaClaw-generated) ===");
    expect(ledger.readRun(kOpId).overseer.verdict).toBe("healthy");
  });

  it("stores an unparseable verdict honestly and does not notify", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    const runner = makeRunner({
      mainResult: { ok: true, code: 0, tail: "sure! the build looks fine to me" },
    });
    const { overseer, notify } = makeOverseer({ ledger, runner });

    await overseer.maybeRunForLatest();

    const record = ledger.readRun(kOpId);
    expect(record.overseer.state).toBe("done");
    expect(record.overseer.verdict).toBe("unparseable");
    expect(record.overseer.summary).toBe("overseer produced unparseable output");
    expect(notify).not.toHaveBeenCalled();
  });

  it("marks the verdict stale (and does not notify) when appliedId changed mid-run", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    // The watchdog rolls back while claude is thinking.
    let appliedId = "2026.8.1-beta.3";
    const runner = makeRunner({
      onMainCall: () => {
        appliedId = "2026.7.1-2";
      },
    });
    const { overseer, notify } = makeOverseer({
      ledger,
      runner,
      channelInfo: () => ({ appliedId, acceptedAt: 111 }),
    });

    await overseer.maybeRunForLatest();

    const record = ledger.readRun(kOpId);
    expect(record.overseer.state).toBe("stale");
    expect(record.overseer.verdict).toBe("healthy");
    expect(notify).not.toHaveBeenCalled();
  });

  it("spawns claude with an isolated env: no gateway secrets, temp HOME, only the Anthropic key", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    let mainEnv = null;
    const runner = makeRunner({ onMainCall: (opts) => (mainEnv = opts.env) });
    const hostEnv = {
      PATH: "/usr/bin",
      HOME: "/data",
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      OPENCLAW_GATEWAY_TOKEN: "gateway-secret-token",
      TELEGRAM_BOT_TOKEN: "telegram-secret-token",
      OPENAI_API_KEY: "sk-openai-secret",
      GITHUB_TOKEN: "ghp_secret",
    };
    const { overseer } = makeOverseer({ ledger, runner, env: hostEnv });

    await overseer.maybeRunForLatest();

    expect(mainEnv).toBeTruthy();
    expect(mainEnv.ANTHROPIC_API_KEY).toBe("sk-ant-test-key");
    expect(mainEnv.PATH).toBe("/usr/bin");
    expect(mainEnv.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(mainEnv.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(mainEnv.OPENAI_API_KEY).toBeUndefined();
    expect(mainEnv.GITHUB_TOKEN).toBeUndefined();
    // HOME is an isolated temp dir, never the data volume.
    expect(mainEnv.HOME).not.toBe("/data");
    expect(mainEnv.HOME).toContain("alphaclaw-overseer-home-");
    // Nothing beyond the documented allowlist + credential + HOME leaks in.
    const allowed = new Set([
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "TERM",
      "NO_COLOR",
      "ANTHROPIC_API_KEY",
    ]);
    for (const key of Object.keys(mainEnv)) {
      expect(allowed.has(key), `unexpected env key ${key}`).toBe(true);
    }
  });

  it("fails open when the claude spawn throws: verdict recorded as failed, no throw", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    const runner = makeRunner({ mainThrows: true });
    const { overseer, notify } = makeOverseer({ ledger, runner });

    await expect(overseer.maybeRunForLatest()).resolves.toEqual(
      expect.objectContaining({ ran: true }),
    );

    const record = ledger.readRun(kOpId);
    expect(record.overseer.state).toBe("failed");
    expect(record.overseer.summary).toContain("spawn ENOENT");
    expect(notify).not.toHaveBeenCalled();
  });

  it("never runs before the acceptance hold resolves on an activated run", async () => {
    const { ledger } = makeLedger();
    ledger.createRun({
      operationId: kOpId,
      target: { channel: "beta", version: "2026.8.1-beta.3" },
    });
    ledger.completeRun(kOpId, { state: "activated", ok: true, result: { ok: true } });
    const runner = makeRunner();
    let acceptedAt = null;
    const { overseer, notify } = makeOverseer({
      ledger,
      runner,
      channelInfo: () => ({ appliedId: "2026.8.1-beta.3", acceptedAt }),
    });

    // Acceptance hold still pending: nothing runs.
    expect(await overseer.maybeRunForLatest()).toEqual({
      skipped: "no_eligible_run",
    });
    expect(ledger.readRun(kOpId).overseer).toBeNull();

    // Acceptance resolved (markGoodNow fired): the overseer runs.
    acceptedAt = 999;
    expect(await overseer.maybeRunForLatest()).toEqual({
      ran: true,
      operationId: kOpId,
    });
    expect(ledger.readRun(kOpId).overseer.state).toBe("done");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("skips runs that already carry an overseer verdict", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    ledger.updateRun(kOpId, (record) => {
      record.overseer = { state: "done", verdict: "broken", at: Date.now() };
      return record;
    });
    const runner = makeRunner();
    const { overseer } = makeOverseer({ ledger, runner });

    expect(await overseer.maybeRunForLatest()).toEqual({
      skipped: "no_eligible_run",
    });
    expect(runner.runStreamed).not.toHaveBeenCalled();
  });

  it("falls back to a prompt-only tool restriction when --help advertises no tool flags", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    const runner = makeRunner({ helpText: "usage: claude [options]" });
    const { overseer } = makeOverseer({ ledger, runner });

    await overseer.maybeRunForLatest();

    const record = ledger.readRun(kOpId);
    expect(record.overseer.toolRestriction).toBe("prompt-only");
    const mainCall = runner.calls.find((c) => c.args?.[0] === "-p");
    expect(mainCall.args).not.toContain("--disallowedTools");
    // The system-prompt restriction is always present regardless.
    expect(mainCall.input).toContain("read-only release overseer");
  });

  it("delivers the prompt to claude via stdin (opts.input), never argv", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    const runner = makeRunner();
    const { overseer } = makeOverseer({ ledger, runner });

    await overseer.maybeRunForLatest();

    const mainCall = runner.calls.find((c) => c.args?.[0] === "-p");
    expect(mainCall).toBeTruthy();
    // argv carries only short flags — the prompt body (run record, log,
    // doctor evidence) must never appear as an argument (E2BIG / `ps` leak).
    for (const arg of mainCall.args) {
      expect(String(arg).length).toBeLessThan(200);
      expect(String(arg)).not.toContain("RUN RECORD");
      expect(String(arg)).not.toContain(kOpId);
    }
    // The full prompt, including the run record, went over stdin instead.
    expect(mainCall.input).toContain("=== RUN RECORD");
    expect(mainCall.input).toContain(kOpId);
    expect(mainCall.input).toContain("verify_failed");
  });

  it("stamps appliesToCurrent=true when the reviewed target is the applied build", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger); // target version matches the harness appliedId
    const runner = makeRunner();
    const { overseer } = makeOverseer({ ledger, runner });

    await overseer.maybeRunForLatest();

    const record = ledger.readRun(kOpId);
    expect(record.overseer.state).toBe("done");
    expect(record.overseer.verdict).toBe("healthy");
    expect(record.overseer.appliesToCurrent).toBe(true);
  });

  it("does not stamp appliesToCurrent on a failed run whose target is not the applied build, even when healthy", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger); // reviewed target: 2026.8.1-beta.3 (never activated)
    const runner = makeRunner();
    const { overseer } = makeOverseer({
      ledger,
      runner,
      // A different, older build is still live — Mark-good/Roll-back act on
      // it, so a verdict about the failed build must not be actionable.
      channelInfo: () => ({ appliedId: "2026.7.1-2", acceptedAt: 111 }),
    });

    await overseer.maybeRunForLatest();

    const record = ledger.readRun(kOpId);
    expect(record.overseer.state).toBe("done");
    expect(record.overseer.verdict).toBe("healthy");
    expect(record.overseer.appliesToCurrent).not.toBe(true);
  });

  it("redacts host secret values from the doctor output before it reaches the claude prompt", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    const runner = makeRunner();
    const gatewaySecret = "gateway-secret-token-value";
    const { overseer } = makeOverseer({
      ledger,
      runner,
      env: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        OPENCLAW_GATEWAY_TOKEN: gatewaySecret,
      },
      // doctor --json runs under gatewayEnv and can echo provider secrets.
      getDoctorJson: async () =>
        JSON.stringify({ ok: false, gateway: { token: gatewaySecret } }),
    });

    await overseer.maybeRunForLatest();

    const mainCall = runner.calls.find((c) => c.args?.[0] === "-p");
    expect(mainCall).toBeTruthy();
    expect(mainCall.input).not.toContain(gatewaySecret);
    expect(mainCall.input).toContain("[redacted]");
  });

  it("appends the claude transcript tail to the run log", async () => {
    const { ledger } = makeLedger();
    seedFailedRun(ledger);
    const runner = makeRunner();
    const { overseer } = makeOverseer({ ledger, runner });

    await overseer.maybeRunForLatest();

    const opened = ledger.openLogStream(kOpId);
    expect(opened).toBeTruthy();
    const content = fs.readFileSync(opened.filePath, "utf8");
    expect(content).toContain("[overseer] --- claude transcript tail ---");
  });

  it("start() warms the availability cache before any request asks for it", async () => {
    const { ledger } = makeLedger();
    const runner = makeRunner();
    const { overseer } = makeOverseer({ ledger, runner });
    try {
      expect(runner.runStreamed).not.toHaveBeenCalled();
      overseer.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The warm probe ran WITHOUT any getAvailability() caller — every
      // restart (i.e. every upgrade) starts cold, and the settings GET must
      // not stall behind the 10s `claude --version` probe.
      const versionCalls = runner.calls.filter(
        (call) => call.args?.[0] === "--version",
      );
      expect(versionCalls.length).toBe(1);
      // A later read is served from the warmed cache (SWR may kick a
      // background refresh once warm — assert the value, not call totals).
      const availability = await overseer.getAvailability();
      expect(availability.available).toBe(true);
    } finally {
      overseer.stop();
    }
  });

  it("never hands the Anthropic credential to the version/help probes", async () => {
    const { ledger } = makeLedger();
    const runner = makeRunner();
    const { overseer } = makeOverseer({ ledger, runner });
    await overseer.getAvailability();
    const probeCalls = runner.calls.filter((call) =>
      ["--version", "--help"].includes(call.args?.[0]),
    );
    expect(probeCalls.length).toBeGreaterThan(0);
    for (const call of probeCalls) {
      // A planted/compromised `claude` on PATH must not receive the API key
      // from a mere availability probe (boot-warm runs even when disabled);
      // only real overseer runs get the credentialed env.
      expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    }
  });

  it("single-flights concurrent cold availability probes", async () => {
    const { ledger } = makeLedger();
    const runner = makeRunner();
    const { overseer } = makeOverseer({ ledger, runner });
    const [first, second] = await Promise.all([
      overseer.getAvailability(),
      overseer.getAvailability(),
    ]);
    expect(first.available).toBe(true);
    expect(second.available).toBe(true);
    const versionCalls = runner.calls.filter(
      (call) => call.args?.[0] === "--version",
    );
    expect(versionCalls.length).toBe(1);
  });
});

describe("server/alphaclaw-config overseer setting", () => {
  it("defaults to disabled and normalizes anything non-true to false", () => {
    expect(
      normalizeAlphaclawConfig({}).updates.openclaw.overseer.enabled,
    ).toBe(false);
    expect(
      normalizeAlphaclawConfig({
        updates: { openclaw: { overseer: { enabled: "yes" } } },
      }).updates.openclaw.overseer.enabled,
    ).toBe(false);
    expect(
      normalizeAlphaclawConfig({
        updates: { openclaw: { overseer: { enabled: true } } },
      }).updates.openclaw.overseer.enabled,
    ).toBe(true);
  });

  it("round-trips enable/disable through the config helpers", () => {
    const openclawDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "overseer-config-"),
    );
    expect(readOpenclawOverseerEnabled({ openclawDir })).toBe(false);

    const enabledResult = updateOpenclawOverseerEnabled({
      openclawDir,
      enabled: true,
    });
    expect(enabledResult.changed).toBe(true);
    expect(readOpenclawOverseerEnabled({ openclawDir })).toBe(true);

    // Existing settings (release channel) survive the write.
    const raw = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "alphaclaw.json"), "utf8"),
    );
    expect(raw.updates.openclaw.releaseChannel).toBe("stable");

    const disabledResult = updateOpenclawOverseerEnabled({
      openclawDir,
      enabled: false,
    });
    expect(disabledResult.changed).toBe(true);
    expect(readOpenclawOverseerEnabled({ openclawDir })).toBe(false);
  });
});
