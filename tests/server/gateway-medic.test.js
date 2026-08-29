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
