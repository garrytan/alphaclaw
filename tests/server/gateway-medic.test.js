const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createGatewayMedic,
  extractBlamedConfigPaths,
} = require("../../lib/server/gateway-medic");

const kSilentLogger = { log() {}, warn() {}, error() {} };

// The verbatim stderr of the production incident this module exists for: a
// stable-pin gateway rejecting the beta-only Control-UI stripe with EX_CONFIG.
const kStripeCrashStderr = [
  "Gateway failed to start: Invalid config at /data/.openclaw/openclaw.json:",
  'gateway.controlUi: Unrecognized key: "environment"',
  'Run "openclaw doctor --fix" to repair, then retry.',
];

const mkOpenclawDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-medic-"));
  return dir;
};

const writeConfig = (openclawDir, config) => {
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
};

const readConfig = (openclawDir) =>
  JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"));

const listMedicBackups = (openclawDir) =>
  fs
    .readdirSync(openclawDir)
    .filter((name) => /^openclaw\.json\.medic-.+\.bak$/.test(name));

const createMedic = (openclawDir, overrides = {}) =>
  createGatewayMedic({
    openclawDir,
    logger: kSilentLogger,
    env: {},
    ...overrides,
  });

describe("server/gateway-medic", () => {
  describe("extractBlamedConfigPaths", () => {
    it("parses the production stripe-crash stderr", () => {
      const blamed = extractBlamedConfigPaths(kStripeCrashStderr);
      expect(blamed.unrecognized).toEqual(["gateway.controlUi.environment"]);
      expect(blamed.invalid).toEqual([]);
    });

    it("parses root-level unrecognized keys and bullet-form invalid values", () => {
      const blamed = extractBlamedConfigPaths([
        'Unrecognized key: "audit"',
        "  - gateway.controlUi: Invalid input",
        "  - gateway.port: Expected number, received string",
      ]);
      expect(blamed.unrecognized).toEqual(["audit"]);
      expect(blamed.invalid).toEqual([
        { path: "gateway.controlUi", problem: "Invalid input" },
        { path: "gateway.port", problem: "Expected number, received string" },
      ]);
    });
  });

  it("deterministically removes a blamed managed key, with a backup, pruning empty parents", async () => {
    const openclawDir = mkOpenclawDir();
    const original = {
      update: { channel: "beta" },
      gateway: {
        controlUi: { environment: { label: "BETA · 2026.8.1", color: "amber" } },
        trustedProxies: ["127.0.0.1"],
      },
    };
    writeConfig(openclawDir, original);
    const medic = createMedic(openclawDir);

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: kStripeCrashStderr,
    });

    expect(outcome).toMatchObject({
      fixed: true,
      tier: "managed_key",
      actions: ["removed gateway.controlUi.environment"],
    });
    const after = readConfig(openclawDir);
    expect(after.gateway?.controlUi).toBeUndefined(); // empty parent pruned
    expect(after.gateway.trustedProxies).toEqual(["127.0.0.1"]); // untouched
    expect(after.update).toEqual({ channel: "beta" });
    // The pre-fix config survives verbatim in the backup.
    const backups = listMedicBackups(openclawDir);
    expect(backups).toHaveLength(1);
    expect(outcome.backup).toBe(backups[0]);
    expect(
      JSON.parse(fs.readFileSync(path.join(openclawDir, backups[0]), "utf8")),
    ).toEqual(original);
  });

  it("never removes an unmanaged key without the AI tier's concurrence", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { audit: { legacy: true } });
    const medic = createMedic(openclawDir); // no llmClient, no runDoctorFix

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: ['Unrecognized key: "audit"'],
    });

    expect(outcome.fixed).toBe(false);
    expect(readConfig(openclawDir).audit).toEqual({ legacy: true });
    expect(listMedicBackups(openclawDir)).toHaveLength(0);
  });

  it("falls back to doctor --fix when no frontier key is configured", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { audit: { legacy: true } });
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    const medic = createMedic(openclawDir, { runDoctorFix });

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: ['Unrecognized key: "audit"'],
      allowDoctorFix: true,
    });

    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ fixed: true, tier: "doctor_fix" });
    expect(listMedicBackups(openclawDir)).toHaveLength(1);
  });

  it("suppresses doctor --fix when the caller disallows it (stabilization window)", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { audit: { legacy: true } });
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    const medic = createMedic(openclawDir, { runDoctorFix });

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: ['Unrecognized key: "audit"'],
      allowDoctorFix: false,
    });

    expect(runDoctorFix).not.toHaveBeenCalled();
    expect(outcome.fixed).toBe(false);
  });

  describe("AI tier", () => {
    const fakeLlm = (responseText, capture = {}) => ({
      getAvailability: () => ({
        available: true,
        provider: "anthropic",
        model: "claude-fable-5",
      }),
      complete: vi.fn(async ({ system, prompt }) => {
        capture.system = system;
        capture.prompt = prompt;
        return {
          ok: true,
          provider: "anthropic",
          model: "claude-fable-5",
          text: responseText,
        };
      }),
    });

    it("applies remove_keys for a blamed unmanaged key the model approves", async () => {
      const openclawDir = mkOpenclawDir();
      writeConfig(openclawDir, { audit: { legacy: true }, keep: 1 });
      const medic = createMedic(openclawDir, {
        llmClient: fakeLlm(
          JSON.stringify({
            diagnosis: "Legacy 2026.7 audit block rejected by the strict root.",
            remedy: "remove_keys",
            keys: ["audit"],
            confidence: "high",
          }),
        ),
      });

      const outcome = await medic.run({
        exitCode: 78,
        stderrTail: ['Unrecognized key: "audit"'],
      });

      expect(outcome).toMatchObject({
        fixed: true,
        tier: "ai_remove_keys",
        model: "anthropic/claude-fable-5",
      });
      expect(outcome.diagnosis).toMatch(/audit block/);
      const after = readConfig(openclawDir);
      expect("audit" in after).toBe(false);
      expect(after.keep).toBe(1);
      expect(listMedicBackups(openclawDir)).toHaveLength(1);
    });

    it("rejects model-proposed keys outside the blamed-key whitelist", async () => {
      const openclawDir = mkOpenclawDir();
      writeConfig(openclawDir, { audit: {}, gateway: { auth: { mode: "token" } } });
      const medic = createMedic(openclawDir, {
        llmClient: fakeLlm(
          JSON.stringify({
            diagnosis: "d",
            remedy: "remove_keys",
            keys: ["gateway.auth"], // NOT blamed by stderr
            confidence: "high",
          }),
        ),
      });

      const outcome = await medic.run({
        exitCode: 78,
        stderrTail: ['Unrecognized key: "audit"'],
      });

      expect(outcome.fixed).toBe(false);
      expect(outcome.error).toMatch(/whitelist/);
      expect(readConfig(openclawDir).gateway.auth).toEqual({ mode: "token" });
    });

    it("treats low confidence as remedy none and surfaces the diagnosis", async () => {
      const openclawDir = mkOpenclawDir();
      writeConfig(openclawDir, { audit: {} });
      const runDoctorFix = vi.fn(async () => ({ ok: true }));
      const medic = createMedic(openclawDir, {
        llmClient: fakeLlm(
          JSON.stringify({
            diagnosis: "Cannot tell which side is wrong.",
            remedy: "remove_keys",
            keys: ["audit"],
            confidence: "low",
          }),
        ),
        runDoctorFix,
      });

      const outcome = await medic.run({
        exitCode: 78,
        stderrTail: ['Unrecognized key: "audit"'],
      });

      expect(outcome.fixed).toBe(false);
      expect(outcome.diagnosis).toMatch(/Cannot tell/);
      // An explicit model decision is final — no doctor fallback behind it.
      expect(runDoctorFix).not.toHaveBeenCalled();
    });

    it("runs doctor_fix when the model picks it and the caller allows it", async () => {
      const openclawDir = mkOpenclawDir();
      writeConfig(openclawDir, { bridge: { legacy: true } });
      const runDoctorFix = vi.fn(async () => ({ ok: true }));
      const medic = createMedic(openclawDir, {
        llmClient: fakeLlm(
          JSON.stringify({
            diagnosis: "2026.7-era bridge.* keys need the doctor migration.",
            remedy: "doctor_fix",
            confidence: "high",
          }),
        ),
        runDoctorFix,
      });

      const outcome = await medic.run({
        exitCode: 78,
        stderrTail: ["bridge: Invalid input"],
        allowDoctorFix: true,
      });

      expect(runDoctorFix).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({ fixed: true, tier: "ai_doctor_fix" });
    });

    it("reports failure when the model-chosen doctor_fix fails", async () => {
      const openclawDir = mkOpenclawDir();
      writeConfig(openclawDir, { bridge: { legacy: true } });
      const runDoctorFix = vi.fn(async () => ({ ok: false }));
      const medic = createMedic(openclawDir, {
        llmClient: fakeLlm(
          JSON.stringify({ diagnosis: "d", remedy: "doctor_fix", confidence: "high" }),
        ),
        runDoctorFix,
      });

      const outcome = await medic.run({
        exitCode: 78,
        stderrTail: ["bridge: Invalid input"],
        allowDoctorFix: true,
      });

      expect(outcome).toMatchObject({
        fixed: false,
        tier: "ai_doctor_fix",
        error: "doctor --fix failed",
      });
    });

    it("refuses a model-requested doctor_fix when the caller disallows it", async () => {
      const openclawDir = mkOpenclawDir();
      writeConfig(openclawDir, { bridge: { legacy: true } });
      const runDoctorFix = vi.fn(async () => ({ ok: true }));
      const medic = createMedic(openclawDir, {
        llmClient: fakeLlm(
          JSON.stringify({ diagnosis: "d", remedy: "doctor_fix", confidence: "high" }),
        ),
        runDoctorFix,
      });

      const outcome = await medic.run({
        exitCode: 78,
        stderrTail: ["bridge: Invalid input"],
        allowDoctorFix: false, // stabilization window
      });

      expect(runDoctorFix).not.toHaveBeenCalled();
      expect(outcome.fixed).toBe(false);
      expect(outcome.error).toMatch(/not permitted/);
    });

    it("scrubs secret-shaped values from every evidence stream before the API call", async () => {
      const openclawDir = mkOpenclawDir();
      writeConfig(openclawDir, {
        gateway: { auth: { token: "supersecret-token-value" } },
        audit: {},
      });
      const capture = {};
      const medic = createMedic(openclawDir, {
        llmClient: fakeLlm(
          JSON.stringify({ diagnosis: "d", remedy: "none", confidence: "high" }),
          capture,
        ),
        collectDoctorJson: async () =>
          "doctor saw supersecret-token-value in the config",
        env: { WEBHOOK_SECRET: "hook-secret-value" },
      });

      await medic.run({
        exitCode: 78,
        stderrTail: [
          'Unrecognized key: "audit"',
          "auth failed for token supersecret-token-value / hook-secret-value",
        ],
      });

      expect(capture.prompt).toContain("***");
      expect(capture.prompt).not.toContain("supersecret-token-value");
      expect(capture.prompt).not.toContain("hook-secret-value");
      // The evidence itself still made it into the prompt.
      expect(capture.prompt).toContain('Unrecognized key: "audit"');
    });

    it("includes the numeric machine summary in the trusted FAILURE section", async () => {
      const openclawDir = mkOpenclawDir();
      writeConfig(openclawDir, { audit: {} });
      const capture = {};
      const medic = createMedic(openclawDir, {
        llmClient: fakeLlm(
          JSON.stringify({ diagnosis: "d", remedy: "none", confidence: "high" }),
          capture,
        ),
        getMachineSummary: () => ({
          memoryMb: 4096,
          cores: 2,
          tier: "medium",
          activeGatewayHeapMb: 2048,
          pendingGatewayHeapMb: 3072,
        }),
      });

      await medic.run({ exitCode: 78, stderrTail: ['Unrecognized key: "audit"'] });

      expect(capture.prompt).toContain('"memoryMb": 4096');
      expect(capture.prompt).toContain('"tier": "medium"');
      expect(capture.prompt).toContain('"activeGatewayHeapMb": 2048');
      expect(capture.prompt).toContain('"pendingGatewayHeapMb": 3072');
      // Still inside the trusted section, with the untrusted framing intact.
      expect(capture.prompt).toContain(
        "=== FAILURE (trusted, AlphaClaw-generated) ===",
      );
      expect(capture.prompt).toContain("UNTRUSTED");
    });

    it("omits the machine field when getMachineSummary throws (fail-open)", async () => {
      const openclawDir = mkOpenclawDir();
      writeConfig(openclawDir, { audit: {} });
      const capture = {};
      const medic = createMedic(openclawDir, {
        llmClient: fakeLlm(
          JSON.stringify({ diagnosis: "d", remedy: "none", confidence: "high" }),
          capture,
        ),
        getMachineSummary: () => {
          throw new Error("profile exploded");
        },
      });

      const outcome = await medic.run({
        exitCode: 78,
        stderrTail: ['Unrecognized key: "audit"'],
      });

      // The prompt still built and the run completed — no machine field.
      expect(capture.prompt).toContain('"removableKeyPaths"');
      expect(capture.prompt).not.toContain('"machine"');
      expect(outcome.tier).toBe("ai");
    });
  });

  it("runs doctor --fix even when openclaw.json is missing (backup is best-effort)", async () => {
    // doctor --fix can regenerate a broken/missing config — exactly the case
    // where the backup source is absent. A backup failure must never abort
    // the remedy.
    const openclawDir = mkOpenclawDir(); // no openclaw.json written
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    const medic = createMedic(openclawDir, { runDoctorFix });

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: ["Invalid config at /data/.openclaw/openclaw.json:"],
      allowDoctorFix: true,
    });

    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ fixed: true, tier: "doctor_fix", backup: null });
  });

  it("never walks __proto__/constructor paths, even with AI concurrence", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { keep: 1 });
    const medic = createMedic(openclawDir, {
      llmClient: {
        getAvailability: () => ({ available: true, provider: "anthropic", model: "m" }),
        complete: vi.fn(async () => ({
          ok: true,
          provider: "anthropic",
          model: "m",
          text: JSON.stringify({
            diagnosis: "d",
            remedy: "remove_keys",
            keys: ["__proto__.toString"],
            confidence: "high",
          }),
        })),
      },
    });

    const outcome = await medic.run({
      exitCode: 78,
      // Crafted stderr: the blamed-path whitelist itself is attacker-shaped.
      stderrTail: ['__proto__: Unrecognized key: "toString"'],
    });

    expect(outcome.fixed).toBe(false);
    expect(typeof {}.toString).toBe("function"); // Object.prototype intact
    expect(readConfig(openclawDir)).toEqual({ keep: 1 });
  });

  it("falls back to doctor --fix when the model answers unusably", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { audit: {} });
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    const medic = createMedic(openclawDir, {
      llmClient: {
        getAvailability: () => ({ available: true, provider: "anthropic", model: "m" }),
        complete: vi.fn(async () => ({
          ok: true,
          provider: "anthropic",
          model: "m",
          text: "Sure! I think you should probably look into the config.",
        })),
      },
      runDoctorFix,
    });

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: ['Unrecognized key: "audit"'],
      allowDoctorFix: true,
    });

    // Unparseable is NOT a decision — the deterministic remedy still runs.
    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ fixed: true, tier: "doctor_fix" });
  });

  it("never auto-removes a hand-set stripe, even when the gateway blames its path", async () => {
    const openclawDir = mkOpenclawDir();
    const handSet = { label: "PRODUCTION", color: "red" };
    writeConfig(openclawDir, {
      gateway: { controlUi: { environment: { ...handSet } } },
    });
    const capture = {};
    const medic = createMedic(openclawDir, {
      isManagedStripeValue: (value) => value == null || value?.label !== "PRODUCTION",
      llmClient: {
        getAvailability: () => ({ available: true, provider: "anthropic", model: "m" }),
        complete: vi.fn(async ({ prompt }) => {
          capture.prompt = prompt;
          return {
            ok: true,
            provider: "anthropic",
            model: "m",
            text: JSON.stringify({
              diagnosis: "d",
              remedy: "remove_keys",
              keys: ["gateway.controlUi.environment"],
              confidence: "high",
            }),
          };
        }),
      },
    });

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: ['gateway.controlUi: Unrecognized key: "environment"'],
    });

    // Excluded from tier 1 AND from the AI whitelist.
    expect(outcome.fixed).toBe(false);
    expect(readConfig(openclawDir).gateway.controlUi.environment).toEqual(handSet);
    expect(capture.prompt).toContain('"removableKeyPaths": []');
  });

  it("shape-redacts bearer/JWT/sk- tokens and withholds an unparseable config", async () => {
    const openclawDir = mkOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      '{ broken json with "secret": "short" and trailing',
    );
    const capture = {};
    const medic = createMedic(openclawDir, {
      llmClient: {
        getAvailability: () => ({ available: true, provider: "anthropic", model: "m" }),
        complete: vi.fn(async ({ prompt }) => {
          capture.prompt = prompt;
          return {
            ok: true,
            provider: "anthropic",
            model: "m",
            text: JSON.stringify({ diagnosis: "d", remedy: "none", confidence: "high" }),
          };
        }),
      },
      readEnvFile: () => [{ key: "MY_TOKEN", value: "envfile-secret-value" }],
    });

    await medic.run({
      exitCode: 78,
      stderrTail: [
        'Unrecognized key: "audit"',
        "upstream said: Authorization: Bearer sk-live-AbCdEfGh1234567890",
        "session eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM was rejected",
        "env leak: envfile-secret-value",
      ],
    });

    expect(capture.prompt).not.toContain("sk-live-AbCdEfGh1234567890");
    expect(capture.prompt).not.toContain("eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM");
    expect(capture.prompt).not.toContain("envfile-secret-value");
    // Unparseable config: body withheld entirely rather than sent raw.
    expect(capture.prompt).toContain("body withheld");
    expect(capture.prompt).not.toContain("broken json");
  });

  it("reports failure when doctor --fix itself fails (fallback tier)", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { audit: { legacy: true } });
    const runDoctorFix = vi.fn(async () => ({ ok: false, code: 1 }));
    const medic = createMedic(openclawDir, { runDoctorFix });

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: ['Unrecognized key: "audit"'],
      allowDoctorFix: true,
    });

    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      fixed: false,
      tier: "doctor_fix",
      error: "doctor --fix failed",
    });
  });

  it("caps the doctor --fix timeout to the remaining run budget", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { audit: {} });
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    const medic = createMedic(openclawDir, { runDoctorFix });

    await medic.run({
      exitCode: 78,
      stderrTail: ['Unrecognized key: "audit"'],
      allowDoctorFix: true,
      budgetMs: 120_000,
    });

    const [{ timeoutMs }] = runDoctorFix.mock.calls[0];
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(120_000);
  });

  it("escalates to doctor when the blamed managed key is already absent (stale blame)", async () => {
    // One stale managed-key blame line must not disable the whole medic.
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { gateway: { port: 18789 } }); // no stripe present
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    const medic = createMedic(openclawDir, { runDoctorFix });

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: kStripeCrashStderr,
      allowDoctorFix: true,
    });

    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ fixed: true, tier: "doctor_fix" });
  });

  it("never removes an ANCESTOR of a protected path (section-wide delete bypass)", async () => {
    // Deleting "gateway" or "gateway.controlUi" would take gateway.auth /
    // allowedOrigins down with it — the exact fail-open the denylist exists
    // to prevent.
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, {
      gateway: {
        auth: { mode: "token" },
        controlUi: { allowedOrigins: ["https://x"] },
      },
    });
    const capture = {};
    const medic = createMedic(openclawDir, {
      llmClient: {
        getAvailability: () => ({ available: true, provider: "anthropic", model: "m" }),
        complete: vi.fn(async ({ prompt }) => {
          capture.prompt = prompt;
          return {
            ok: true,
            provider: "anthropic",
            model: "m",
            text: JSON.stringify({
              diagnosis: "d",
              remedy: "remove_keys",
              keys: ["gateway", "gateway.controlUi"],
              confidence: "high",
            }),
          };
        }),
      },
    });

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: [
        'Unrecognized key: "gateway"',
        'gateway: Unrecognized key: "controlUi"',
      ],
    });

    expect(outcome.fixed).toBe(false);
    const after = readConfig(openclawDir);
    expect(after.gateway.auth).toEqual({ mode: "token" });
    expect(after.gateway.controlUi.allowedOrigins).toEqual(["https://x"]);
    expect(capture.prompt).toContain('"removableKeyPaths": []');
  });

  it("scrubs secrets out of the parsed blame structure, not just the raw tail", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { audit: {} });
    const capture = {};
    const medic = createMedic(openclawDir, {
      llmClient: {
        getAvailability: () => ({ available: true, provider: "anthropic", model: "m" }),
        complete: vi.fn(async ({ prompt }) => {
          capture.prompt = prompt;
          return {
            ok: true,
            provider: "anthropic",
            model: "m",
            text: JSON.stringify({ diagnosis: "d", remedy: "none", confidence: "high" }),
          };
        }),
      },
    });

    await medic.run({
      exitCode: 78,
      stderrTail: [
        'Unrecognized key: "audit"',
        // A validator echoing a secret VALUE inside an Invalid-value line: the
        // captured `problem` text rides the "trusted" FAILURE JSON section.
        "apiKey: Invalid value sk-ant-SuperSecretValue123 is malformed",
      ],
    });

    expect(capture.prompt).not.toContain("sk-ant-SuperSecretValue123");
  });

  it("re-checks hand-set-ness inside the config lock and fails CLOSED on check errors", async () => {
    const openclawDir = mkOpenclawDir();
    const stripe = { label: "BETA · 2026.8.1", color: "amber" };
    writeConfig(openclawDir, {
      gateway: { controlUi: { environment: { ...stripe } } },
    });
    const medic = createMedic(openclawDir, {
      isManagedStripeValue: () => {
        throw new Error("ownership store unreadable");
      },
    });

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: kStripeCrashStderr,
    });

    // Unverifiable ownership = treated as hand-set = never auto-removed.
    expect(outcome.fixed).toBe(false);
    expect(readConfig(openclawDir).gateway.controlUi.environment).toEqual(stripe);
  });

  it("never treats a security-critical blamed path as removable", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { gateway: { auth: { mode: "token" } } });
    const capture = {};
    const medic = createMedic(openclawDir, {
      llmClient: {
        getAvailability: () => ({ available: true, provider: "anthropic", model: "m" }),
        complete: vi.fn(async ({ prompt }) => {
          capture.prompt = prompt;
          return {
            ok: true,
            provider: "anthropic",
            model: "m",
            text: JSON.stringify({
              diagnosis: "d",
              remedy: "remove_keys",
              keys: ["gateway.auth"],
              confidence: "high",
            }),
          };
        }),
      },
    });

    const outcome = await medic.run({
      exitCode: 78,
      // The gateway (or an injected line) blames the auth subtree directly.
      stderrTail: ['gateway: Unrecognized key: "auth"'],
    });

    expect(outcome.fixed).toBe(false);
    expect(readConfig(openclawDir).gateway.auth).toEqual({ mode: "token" });
    // The protected path never reached the model's removable list either.
    expect(capture.prompt).toContain('"removableKeyPaths": []');
  });

  it("ignores unrecognized-key text embedded mid-line (echoed values)", () => {
    const blamed = extractBlamedConfigPaths([
      'Invalid input: received "gateway: Unrecognized key: \\"auth\\"" for field x',
    ]);
    expect(blamed.unrecognized).toEqual([]);
  });

  it("removes a literal dotted ROOT key instead of walking it as a path", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, {
      "channels.telegram.enabled": true, // literal root key with dots
      channels: { telegram: { enabled: true } }, // unrelated nested setting
    });
    const medic = createMedic(openclawDir, {
      llmClient: {
        getAvailability: () => ({ available: true, provider: "anthropic", model: "m" }),
        complete: vi.fn(async () => ({
          ok: true,
          provider: "anthropic",
          model: "m",
          text: JSON.stringify({
            diagnosis: "d",
            remedy: "remove_keys",
            keys: ["channels.telegram.enabled"],
            confidence: "high",
          }),
        })),
      },
    });

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: ['Unrecognized key: "channels.telegram.enabled"'],
    });

    expect(outcome.fixed).toBe(true);
    const after = readConfig(openclawDir);
    expect("channels.telegram.enabled" in after).toBe(false);
    expect(after.channels.telegram.enabled).toBe(true); // nested untouched
  });

  it("shape-redacts provider keys, cookies, and signed URLs bound for the model", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { audit: {} });
    const capture = {};
    const medic = createMedic(openclawDir, {
      llmClient: {
        getAvailability: () => ({ available: true, provider: "anthropic", model: "m" }),
        complete: vi.fn(async ({ prompt }) => {
          capture.prompt = prompt;
          return {
            ok: true,
            provider: "anthropic",
            model: "m",
            text: JSON.stringify({ diagnosis: "d", remedy: "none", confidence: "high" }),
          };
        }),
      },
    });

    await medic.run({
      exitCode: 78,
      stderrTail: [
        'Unrecognized key: "audit"',
        "google key AIzaSyA1234567890abcdefghijklmnopqrs rejected",
        "github token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345 expired",
        "slack xoxb-1234567890-abcdefghijk failed",
        "aws AKIAIOSFODNN7EXAMPLE denied",
        "webhook https://hooks.slack.com/services/T000/B000/XXXX unreachable",
        "db postgres://admin:hunter2pass@db.internal:5432/prod down",
        "Cookie: session=deadbeefcafe1234; theme=dark",
        "fetch https://bucket.s3.amazonaws.com/f?X-Amz-Signature=abc123def456 failed",
      ],
    });

    const prompt = capture.prompt;
    expect(prompt).not.toContain("AIzaSyA1234567890abcdefghijklmnopqrs");
    expect(prompt).not.toContain("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345");
    expect(prompt).not.toContain("xoxb-1234567890-abcdefghijk");
    expect(prompt).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(prompt).not.toContain("T000/B000/XXXX");
    expect(prompt).not.toContain("hunter2pass");
    expect(prompt).not.toContain("session=deadbeefcafe1234");
    expect(prompt).not.toContain("X-Amz-Signature=abc123def456");
    // Evidence structure survives redaction.
    expect(prompt).toContain("postgres://***@db.internal:5432/prod");
    expect(prompt).toContain('Unrecognized key: "audit"');
  });

  it("refuses to mutate when the budget expired during the model call", async () => {
    let now = 0;
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { audit: {} });
    const medic = createMedic(openclawDir, {
      nowFn: () => now,
      llmClient: {
        getAvailability: () => ({ available: true, provider: "anthropic", model: "m" }),
        complete: vi.fn(async () => {
          now += 200_000; // the model call ate the whole budget
          return {
            ok: true,
            provider: "anthropic",
            model: "m",
            text: JSON.stringify({
              diagnosis: "d",
              remedy: "remove_keys",
              keys: ["audit"],
              confidence: "high",
            }),
          };
        }),
      },
    });

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: ['Unrecognized key: "audit"'],
      budgetMs: 120_000,
    });

    // The watchdog may already have latched and released the lock — no
    // mutation past the budget.
    expect(outcome.fixed).toBe(false);
    expect(outcome.error).toMatch(/budget exhausted/);
    expect(readConfig(openclawDir).audit).toEqual({});
  });

  it("refuses to start doctor --fix with less than the runway floor", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { audit: {} });
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    const medic = createMedic(openclawDir, { runDoctorFix });

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: ['Unrecognized key: "audit"'],
      allowDoctorFix: true,
      budgetMs: 20_000, // below kMinDoctorRunwayMs
    });

    expect(runDoctorFix).not.toHaveBeenCalled();
    expect(outcome.fixed).toBe(false);
    expect(outcome.error).toMatch(/budget exhausted/);
  });

  it("treats an unknown remedy string as unusable and falls to doctor", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, { audit: {} });
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    const medic = createMedic(openclawDir, {
      llmClient: {
        getAvailability: () => ({ available: true, provider: "anthropic", model: "m" }),
        complete: vi.fn(async () => ({
          ok: true,
          provider: "anthropic",
          model: "m",
          text: JSON.stringify({ diagnosis: "d", remedy: "reboot_universe", confidence: "high" }),
        })),
      },
      runDoctorFix,
    });

    const outcome = await medic.run({
      exitCode: 78,
      stderrTail: ['Unrecognized key: "audit"'],
      allowDoctorFix: true,
    });

    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ fixed: true, tier: "doctor_fix" });
  });

  it("keeps only the newest three medic backups", async () => {
    const openclawDir = mkOpenclawDir();
    writeConfig(openclawDir, {
      gateway: { controlUi: { environment: { label: "BETA", color: "amber" } } },
    });
    let now = Date.UTC(2026, 7, 29);
    const medic = createMedic(openclawDir, { nowFn: () => now });
    for (let i = 0; i < 5; i += 1) {
      writeConfig(openclawDir, {
        gateway: { controlUi: { environment: { label: "BETA", color: "amber" } } },
      });
      now += 60_000;
      await medic.run({ exitCode: 78, stderrTail: kStripeCrashStderr });
    }
    expect(listMedicBackups(openclawDir)).toHaveLength(3);
  });

  it("reports availability from the config gate and the llm client", () => {
    const openclawDir = mkOpenclawDir();
    const medic = createMedic(openclawDir, {
      isEnabled: () => false,
      llmClient: {
        getAvailability: () => ({ available: false, reason: "no_api_key" }),
      },
    });
    expect(medic.isEnabled()).toBe(false);
    expect(medic.getAvailability()).toEqual({
      enabled: false,
      ai: { available: false, reason: "no_api_key" },
    });
  });
});
