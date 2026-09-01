// Post-incident (2026-09-01) restart-hardening units: ready-budget clamp,
// shared operation budget, cause-line picker, evidence redaction composition,
// atomic 0600 writes, and deployment-only env provenance.
const fs = require("fs");
const os = require("os");
const path = require("path");

const kConstantsPath = "../../lib/server/constants";

const loadConstantsWithEnv = async (value) => {
  vi.resetModules();
  if (value === undefined) {
    vi.stubEnv("GATEWAY_RESTART_READY_TIMEOUT", "");
    delete process.env.GATEWAY_RESTART_READY_TIMEOUT;
  } else {
    vi.stubEnv("GATEWAY_RESTART_READY_TIMEOUT", value);
  }
  // Fresh evaluation — the constant is read at module load by design.
  return await import(kConstantsPath);
};

describe("GATEWAY_RESTART_READY_TIMEOUT clamp (module-load read)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("defaults to 300s and derives the shared operation budget", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const constants = await loadConstantsWithEnv(undefined);
    expect(constants.kGatewayRestartReadyTimeoutMs).toBe(300_000);
    // budget = ready + 240s preflight worst case + 90s margin, floored at
    // the 10-min lease.
    expect(constants.kGatewayRestartOperationBudgetMs).toBe(
      Math.max(600_000, 300_000 + 240_000 + 90_000),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("GATEWAY_RESTART_READY_TIMEOUT"),
    );
  });

  it("honors an in-range value silently", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const constants = await loadConstantsWithEnv("45");
    expect(constants.kGatewayRestartReadyTimeoutMs).toBe(45_000);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("GATEWAY_RESTART_READY_TIMEOUT"),
    );
  });

  it("clamps below the floor with a warning (agent-hostile tiny values)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const constants = await loadConstantsWithEnv("5");
    expect(constants.kGatewayRestartReadyTimeoutMs).toBe(30_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("clamped to 30s"),
    );
  });

  it("clamps above the ceiling with a warning (the ms-typo case)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const constants = await loadConstantsWithEnv("300000");
    expect(constants.kGatewayRestartReadyTimeoutMs).toBe(480_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("clamped to 480s"),
    );
    // Even at the cap, the derived budget covers the wait with margin.
    expect(constants.kGatewayRestartOperationBudgetMs).toBe(
      480_000 + 240_000 + 90_000,
    );
  });

  it("falls back to the default on junk — WITH a warning (an operator who set the var mid-incident must hear back)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const constants = await loadConstantsWithEnv("not-a-number");
    expect(constants.kGatewayRestartReadyTimeoutMs).toBe(300_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("GATEWAY_RESTART_READY_TIMEOUT=not-a-number"),
    );
  });
});

describe("pickCauseLine (no last-line fallback)", () => {
  const { pickCauseLine } = require("../../lib/server/utils/cause-line");

  it("picks the incident's state-lock line over trailing benign lock chatter", () => {
    // Modeled on the 2026-09-01 tail: the real blocker, then benign noise
    // AFTER it that also contains error-regex words.
    const tail = [
      "loading plugins (72)...",
      "ERROR another OpenClaw process owns state-lifecycle: /tmp/openclaw-state-locks-0",
      "retrying lock acquisition...",
      "lock acquired for telemetry flush",
      "shutdown summary: failed=0 ok=12",
    ].join("\n");
    expect(pickCauseLine(tail)).toBe(
      "ERROR another OpenClaw process owns state-lifecycle: /tmp/openclaw-state-locks-0",
    );
  });

  it("returns null for empty and for noise-only tails (never promotes noise)", () => {
    expect(pickCauseLine("")).toBeNull();
    expect(pickCauseLine(null)).toBeNull();
    expect(
      pickCauseLine("plugins loaded\nlistening soon\nall good here"),
    ).toBeNull();
    // Benign matches alone do not qualify.
    expect(
      pickCauseLine("lock acquired\nlocks released\nfailed=0\n0 failed"),
    ).toBeNull();
  });

  it("matches spelled-out bind conflicts and errno-style lines", () => {
    expect(pickCauseLine("bind: address already in use")).toBe(
      "bind: address already in use",
    );
    expect(pickCauseLine("open /data/x: EACCES")).toBe("open /data/x: EACCES");
  });
});

describe("evidence redaction composition", () => {
  const {
    redactSecrets,
    scrubTokenParams,
    redactSecretShapes,
    stripAnsi,
    stripControlChars,
  } = require("../../lib/server/utils/redact");

  const compose = (text, secrets) =>
    redactSecretShapes(
      scrubTokenParams(
        redactSecrets(stripControlChars(stripAnsi(text)), { secrets }),
      ),
    );

  it("masks shape-only secrets the collected set does not know (JWT, Bearer, sk-)", () => {
    const jwt = "eyJhbGciOi.eyJzdWIiOjE.SflKxwRJSMeKKF2QT4";
    const out = compose(
      `auth: Bearer abc123def456 jwt=${jwt} key=sk-live1234567890abc`,
      new Set(),
    );
    expect(out).not.toContain("abc123def456");
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("sk-live1234567890abc");
  });

  it("value-masks collected secrets — the {secrets} arg is load-bearing", () => {
    const out = compose("token was supersecrettoken123 here", new Set(["supersecrettoken123"]));
    expect(out).toContain("***");
    expect(out).not.toContain("supersecrettoken123");
    // Regression guard for the dropped-arg mistake: without secrets the
    // value survives redactSecrets (shape layer won't catch this plain one).
    expect(
      redactSecrets("token was supersecrettoken123 here"),
    ).toContain("supersecrettoken123");
  });

  it("strips ANSI BEFORE matching — an escape inside a token must not defeat redaction", () => {
    // ANSI color code injected INSIDE the Bearer token.
    const poisoned = "Authorization: Bearer abcd\x1b[31mefgh1234ijkl";
    const out = compose(poisoned, new Set());
    expect(out).not.toContain("abcdefgh1234ijkl");
    expect(out).toContain("***");
  });

  it("strips NUL and control bytes from persisted evidence", () => {
    const out = compose("line\x00with\x08controls", new Set());
    expect(out).toBe("linewithcontrols");
  });
});

describe("writeFileAtomic mode option", () => {
  const { writeFileAtomic } = require("../../lib/server/utils/safe-file");

  it("tightens a pre-existing 0644 file to 0600 via a fresh temp inode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-mode-"));
    const target = path.join(dir, "op.json");
    fs.writeFileSync(target, "{}", { mode: 0o644 });
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);

    writeFileAtomic(target, '{"a":1}', { mode: 0o600 });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(target, "utf8")).toBe('{"a":1}');
    // No temp litter.
    expect(fs.readdirSync(dir)).toEqual(["op.json"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("callers that omit mode keep umask-default behavior (no third arg leaks to mocks)", () => {
    const calls = [];
    const fakeFs = {
      mkdirSync: () => {},
      writeFileSync: (...args) => calls.push(args),
    };
    writeFileAtomic("/x/y.json", "data", { fsModule: fakeFs });
    expect(calls).toEqual([["/x/y.json", "data"]]);
  });
});

describe("deployment-only env keys cover BOTH load paths", () => {
  const {
    kDeploymentOnlyEnvKeys,
  } = require("../../lib/server/deployment-only-env");

  it("lists the gateway hatches AND the restart-hardening knob", () => {
    expect(kDeploymentOnlyEnvKeys).toEqual(
      expect.arrayContaining([
        "ALPHACLAW_GATEWAY_ENV_UNRESTRICTED",
        "ALPHACLAW_GATEWAY_ENV_PASSTHROUGH",
        "GATEWAY_RESTART_READY_TIMEOUT",
      ]),
    );
  });

  it("bin/alphaclaw.js boot loader consumes the shared list (no hardcoded drift)", () => {
    // Contract test: the boot .env load is the path that matters for
    // module-load-read constants — it must read the SAME list, not its own
    // hardcoded pair (the pre-fix state this incident round closed).
    const binSource = fs.readFileSync(
      path.join(__dirname, "../../bin/alphaclaw.js"),
      "utf8",
    );
    expect(binSource).toContain('require("../lib/server/deployment-only-env")');
    expect(binSource).toContain("kDeploymentOnlyEnvKeys.includes(key)");
    expect(binSource).not.toMatch(
      /key === "ALPHACLAW_GATEWAY_ENV_UNRESTRICTED" \|\| key === "ALPHACLAW_GATEWAY_ENV_PASSTHROUGH"/,
    );
  });
});
