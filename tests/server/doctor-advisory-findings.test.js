// #87 B3/X6: structured Doctor finding → readiness advisory. Fixtures use the
// real OpenClaw 2026.9.3 checkIds in BOTH upstream shapes (security-audit:
// severity "warn" + title/detail; doctor-lint: severity "warning" + message).
const {
  classifySecretFindings,
  extractSecretRuntimeFinding,
} = require("../../lib/server/doctor/advisory-findings");
const {
  createDoctorTextSanitizer,
} = require("../../lib/server/doctor/sanitize");
const { kStructuralCheckIdPattern } = require("../../lib/server/doctor/constants");

const payloadOf = (...findings) => JSON.stringify({ ok: false, findings });

// Security-audit shape (real 2026.9.3 id and field names).
const secretRefUnavailable = {
  checkId: "gateway.probe_auth_secretref_unavailable",
  severity: "warn",
  title: "Gateway auth SecretRef unavailable",
  detail: "Gateway auth token SecretRef could not be resolved at probe time.",
  remediation: "Check the secret provider and restart the gateway.",
};
// Hygiene ids (security-audit shape) — Drift Doctor's job, never a readiness cause.
const plaintextSecrets = {
  checkId: "config.plaintext_secrets",
  severity: "warn",
  title: "Plaintext secrets in config",
  detail: "Move secrets to a SecretRef instead of plaintext values.",
};
const passwordInConfig = {
  checkId: "config.secrets.gateway_password_in_config",
  severity: "warn",
  title: "Gateway password stored in config",
  detail: "gateway.auth.password is stored in plaintext.",
};
const hooksTokenInConfig = {
  checkId: "config.secrets.hooks_token_in_config",
  severity: "warn",
  title: "Hooks token stored in config",
  detail: "hooks.token is stored in plaintext.",
};
// Doctor-lint shape (real generic gateway id, SecretRef named in message).
const gatewayHealthSecretRef = {
  checkId: "core/doctor/gateway-health",
  severity: "warning",
  message: "Gateway health degraded: SecretRef for gateway.auth.token is unavailable.",
  path: "~/.openclaw/openclaw.json",
};

// Control characters are built at runtime so the fixture source stays
// printable: ESC, CR, LF, NUL, TAB, and NEL (C1 range, U+0085).
const ch = (code) => String.fromCharCode(code);
const isControlChar = (c) => {
  const code = c.charCodeAt(0);
  return code < 32 || code === 127 || (code >= 128 && code <= 159);
};

describe("#87 server/doctor/advisory-findings", () => {
  it("#87 matches the security-audit shape (warn + title/detail) as a runtime secrets finding", () => {
    const result = classifySecretFindings(payloadOf(secretRefUnavailable));
    expect(result.reason).toBe("found");
    expect(result.hygieneCheckIds).toEqual([]);
    expect(result.finding).toEqual({
      checkId: "gateway.probe_auth_secretref_unavailable",
      severity: "warning",
      kind: "runtime",
      component: "secrets",
      message: secretRefUnavailable.detail,
    });
    // The fixture id is admitted by the structural pattern (never "unknown").
    expect(kStructuralCheckIdPattern.test(result.finding.checkId)).toBe(true);
  });

  it("#87 matches the doctor-lint shape (core/doctor/gateway-health + SecretRef message) as runtime", () => {
    const finding = extractSecretRuntimeFinding(payloadOf(gatewayHealthSecretRef));
    expect(finding).toEqual({
      checkId: "core/doctor/gateway-health",
      severity: "warning",
      kind: "runtime",
      component: "secrets",
      message: gatewayHealthSecretRef.message,
    });
    // `error` maps through too; the other generic gateway ids apply the same rule.
    for (const checkId of [
      "core/doctor/gateway-auth",
      "core/doctor/gateway-config",
      "core/doctor/security",
    ]) {
      const variant = extractSecretRuntimeFinding(
        payloadOf({ checkId, severity: "error", message: "secret ref unresolved" }),
      );
      expect(variant).toMatchObject({ checkId, severity: "error", kind: "runtime" });
    }
  });

  it("#87 F6 a core/doctor gateway id needs a SecretRef mention AND an unavailability verb: 'could not be resolved' is runtime; 'consider a SecretRef' hygiene advice is not secret-related at all (no_finding, not hygiene)", () => {
    const unresolved = extractSecretRuntimeFinding(
      payloadOf({
        checkId: "core/doctor/gateway-auth",
        severity: "error",
        message: "SecretRef env:GATEWAY_TOKEN could not be resolved",
      }),
    );
    expect(unresolved).toMatchObject({
      checkId: "core/doctor/gateway-auth",
      kind: "runtime",
      severity: "error",
      message: "SecretRef env:GATEWAY_TOKEN could not be resolved",
    });
    for (const message of [
      "SecretRef for gateway.auth.token is unavailable",
      "secret ref unresolved",
      "SecretRef lookup failed for gateway.auth.token",
      "SecretRef provider cannot be reached",
      "SecretRef could not resolve env:GATEWAY_TOKEN",
      "SecretRef env:GATEWAY_TOKEN is missing",
    ]) {
      expect(
        extractSecretRuntimeFinding(
          payloadOf({ checkId: "core/doctor/gateway-config", severity: "warning", message }),
        ),
      ).toMatchObject({ kind: "runtime" });
    }
    for (const message of [
      "consider a SecretRef for gateway.auth.token",
      "Tip: move gateway.auth.token to a SecretRef",
      "SecretRef support is available for hooks tokens",
    ]) {
      const result = classifySecretFindings(
        payloadOf({ checkId: "core/doctor/gateway-config", severity: "warning", message }),
      );
      expect(result.finding).toBeNull();
      expect(result.reason).toBe("no_finding");
      expect(result.hygieneCheckIds).toEqual([]);
    }
  });

  it("#87 hygiene-only findings return null with reason hygiene_only and the structural ids", () => {
    const result = classifySecretFindings(
      payloadOf(plaintextSecrets, passwordInConfig, hooksTokenInConfig),
    );
    expect(result.finding).toBeNull();
    expect(result.reason).toBe("hygiene_only");
    expect(result.hygieneCheckIds).toEqual([
      "config.plaintext_secrets",
      "config.secrets.gateway_password_in_config",
      "config.secrets.hooks_token_in_config",
    ]);
    expect(extractSecretRuntimeFinding(payloadOf(plaintextSecrets))).toBeNull();
  });

  it("#87 a SecretRef mention in a hygiene finding's message stays hygiene (message rule is core/doctor-only)", () => {
    // plaintext_secrets' remediation legitimately says "use a SecretRef".
    const result = classifySecretFindings(payloadOf(plaintextSecrets));
    expect(result.reason).toBe("hygiene_only");
    expect(result.finding).toBeNull();
  });

  it("#87 ignores info-severity runtime findings (reason no_finding)", () => {
    const result = classifySecretFindings(
      payloadOf({ ...secretRefUnavailable, severity: "info" }),
    );
    expect(result).toEqual({ finding: null, reason: "no_finding", hygieneCheckIds: [] });
    // Unknown severities are not promoted either.
    expect(
      extractSecretRuntimeFinding(payloadOf({ ...secretRefUnavailable, severity: "notice" })),
    ).toBeNull();
  });

  it("#87 ignores non-secret checkIds whose message merely says secret … error", () => {
    const result = classifySecretFindings(
      payloadOf(
        {
          checkId: "core/doctor/tools-md-migration",
          severity: "error",
          message: "secret handling error: TOOLS.md still references a legacy secret store",
        },
        // A generic gateway id WITHOUT a SecretRef mention is not secret-related.
        {
          checkId: "core/doctor/gateway-health",
          severity: "error",
          message: "gateway auth error: token secret rejected",
        },
      ),
    );
    expect(result).toEqual({ finding: null, reason: "no_finding", hygieneCheckIds: [] });
  });

  it("#87 legacy prose (the pinned stable's non-structured output) → no_payload", () => {
    const prose = "OpenClaw doctor\n  gateway: ok\n  secrets: SecretRef unavailable — error\n";
    expect(classifySecretFindings(prose)).toEqual({
      finding: null,
      reason: "no_payload",
      hygieneCheckIds: [],
    });
    expect(classifySecretFindings("")).toMatchObject({ reason: "no_payload" });
    expect(classifySecretFindings(null)).toMatchObject({ reason: "no_payload" });
    // A JSON object WITHOUT a findings array is not a payload either.
    expect(classifySecretFindings('{"ok":true,"secret":"error"}')).toMatchObject({
      reason: "no_payload",
    });
  });

  it("#87 tolerates a noisy stdout wrapper around the payload and non-object entries", () => {
    const noisy =
      `[plugins] loading {"stage":"warm"}\nwarming up... {not json}\n` +
      JSON.stringify({ findings: [null, "text", 42, secretRefUnavailable] }) +
      "\ntrailing noise }";
    const finding = extractSecretRuntimeFinding(noisy);
    expect(finding).toMatchObject({
      checkId: "gateway.probe_auth_secretref_unavailable",
      kind: "runtime",
    });
  });

  it("#87 caps an oversize message at 200 chars and strips control characters (default sanitizer)", () => {
    const long = "SecretRef unavailable: " + "x".repeat(400);
    const capped = extractSecretRuntimeFinding(
      payloadOf({ ...secretRefUnavailable, detail: long }),
    );
    expect(capped.message.length).toBeLessThanOrEqual(200);
    expect(capped.message.endsWith("…")).toBe(true);

    // ESC[31m colour code, CR/LF line forgery, NUL, TAB, and a C1 control.
    const dirty = [
      "line one ",
      ch(27),
      "[31m",
      ch(13),
      ch(10),
      "line two injected ",
      ch(0),
      ch(9),
      "tab",
      ch(0x85),
      "end",
    ].join("");
    const cleaned = extractSecretRuntimeFinding(
      payloadOf({ ...secretRefUnavailable, detail: dirty }),
    );
    expect([...cleaned.message].some(isControlChar)).toBe(false);
    expect(cleaned.message).toContain("line one");
    expect(cleaned.message).toContain("line two");
    expect(cleaned.message).toContain("end");
    // Single line: the forged line break collapsed into the same row.
    expect(cleaned.message.split("\n")).toHaveLength(1);
  });

  it("#87 message goes through the shared Doctor sanitizer (secret values redacted)", () => {
    const { sanitize } = createDoctorTextSanitizer({
      env: { GATEWAY_AUTH_TOKEN: "tok-live-abcdef123456" },
    });
    const result = classifySecretFindings(
      payloadOf({
        ...secretRefUnavailable,
        detail: "SecretRef resolved to tok-live-abcdef123456 but the provider rejected it",
      }),
      { sanitize },
    );
    expect(result.finding.message).toBe(
      "SecretRef resolved to [redacted] but the provider rejected it",
    );
  });

  it("#87 SEC: a token-shaped value inside `detail` is masked by shape (redactSecretShapes) even when no store knows it — after the strip, before the cap", () => {
    const anthropicShaped = "sk-ant-" + "a1B2c3D4e5".repeat(4);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop";
    const finding = extractSecretRuntimeFinding(
      payloadOf({
        ...secretRefUnavailable,
        detail: `SecretRef resolved to ${anthropicShaped} (Bearer ${jwt}) but the provider rejected it`,
      }),
    );
    expect(finding.message).not.toContain(anthropicShaped);
    expect(finding.message).not.toContain(jwt);
    expect(finding.message).toContain("SecretRef resolved to ***");
    expect(finding.message).toContain("but the provider rejected it");
    // A token straddling the cap is masked whole, never leaked as a prefix.
    // Prefix 23 + 165 + 1 = 189 chars: the token starts inside the 200 cap
    // and runs past it, so a cap-first pipeline would keep a token prefix.
    const padded = "SecretRef unavailable: " + "x".repeat(165) + " " + anthropicShaped;
    const capped = extractSecretRuntimeFinding(
      payloadOf({ ...secretRefUnavailable, detail: padded }),
    );
    expect(capped.message.length).toBeLessThanOrEqual(200);
    expect(capped.message).not.toContain("sk-ant-a1B2");
    // The injected sanitizer still runs (value redaction) alongside the shape pass.
    const { sanitize } = createDoctorTextSanitizer({ env: { GATEWAY_AUTH_TOKEN: "tok-live-abcdef123456" } });
    const both = classifySecretFindings(
      payloadOf({ ...secretRefUnavailable, detail: `tok-live-abcdef123456 and ${anthropicShaped}` }),
      { sanitize },
    ).finding;
    expect(both.message).toBe("[redacted] and ***");
  });

  it('#87 a checkId outside the structural pattern is reported as "unknown"', () => {
    // Spaces / markup: secret-related (matches /secretref/) but not structural.
    const markup = extractSecretRuntimeFinding(
      payloadOf({
        checkId: "gateway secretref <b>unavailable</b>",
        severity: "warn",
        detail: "SecretRef unavailable",
      }),
    );
    expect(markup).toMatchObject({ checkId: "unknown", kind: "runtime", severity: "warning" });
    // Over-long ids fall back too (pattern caps at 100 chars).
    const overlong = extractSecretRuntimeFinding(
      payloadOf({
        checkId: "gateway.secretref_unavailable." + "a".repeat(120),
        severity: "error",
        message: "SecretRef unavailable",
      }),
    );
    expect(overlong.checkId).toBe("unknown");
    // Hygiene ids are filtered the same way in the reason list.
    const hygiene = classifySecretFindings(
      payloadOf({ checkId: "config secrets <x>", severity: "warn", title: "t" }),
    );
    expect(hygiene).toEqual({ finding: null, reason: "hygiene_only", hygieneCheckIds: ["unknown"] });
  });

  it("#87 returns the FIRST actionable runtime finding; hygiene ids are still listed alongside", () => {
    const result = classifySecretFindings(
      payloadOf(
        plaintextSecrets,
        { ...secretRefUnavailable, severity: "info" }, // skipped: info
        gatewayHealthSecretRef, // first actionable runtime
        { ...secretRefUnavailable, detail: "second runtime finding" },
        plaintextSecrets, // duplicate hygiene id deduped
      ),
    );
    expect(result.reason).toBe("found");
    expect(result.finding.checkId).toBe("core/doctor/gateway-health");
    expect(result.finding.message).toBe(gatewayHealthSecretRef.message);
    expect(result.hygieneCheckIds).toEqual(["config.plaintext_secrets"]);
  });

  it("#87 falls back through message → detail → title and never emits a runtime finding without secrets", () => {
    const titleOnly = extractSecretRuntimeFinding(
      payloadOf({
        checkId: "gateway.probe_auth_secretref_unavailable",
        severity: "warn",
        title: "Only a title",
      }),
    );
    expect(titleOnly.message).toBe("Only a title");
    const detailWins = extractSecretRuntimeFinding(
      payloadOf({
        checkId: "gateway.probe_auth_secretref_unavailable",
        severity: "warn",
        title: "T",
        detail: "D",
        message: "   ",
      }),
    );
    expect(detailWins.message).toBe("D");
    // "unavailable" alone (no secret in the id) is not a secrets finding.
    expect(
      extractSecretRuntimeFinding(
        payloadOf({ checkId: "gateway.probe_unavailable", severity: "error", detail: "down" }),
      ),
    ).toBeNull();
  });

  it("#87 caps the hygiene id list at 10 distinct structural ids (deduped, first-seen order) and skips entries whose checkId is not a string, whose severity is unknown, or that are not objects at all", () => {
    const hygiene = Array.from({ length: 12 }, (_, i) => ({
      checkId: `config.secrets.plaintext_${i}`,
      severity: "warn",
      title: `Hygiene ${i}`,
    }));
    const result = classifySecretFindings(
      payloadOf(
        ...hygiene,
        hygiene[0], // duplicate of an already-listed id
        { checkId: 42, severity: "critical", detail: "secret unavailable" }, // non-string id: not a secret finding
        { ...secretRefUnavailable, severity: "weird" }, // unknown severity: never an advisory
        { ...secretRefUnavailable, severity: "info" }, // info: never an advisory
        "gateway.probe_auth_secretref_unavailable", // string entry: ignored
        null,
        [secretRefUnavailable], // array entry: ignored
      ),
    );
    expect(result.finding).toBeNull();
    expect(result.reason).toBe("hygiene_only");
    expect(result.hygieneCheckIds).toHaveLength(10);
    expect(result.hygieneCheckIds).toEqual(hygiene.slice(0, 10).map((finding) => finding.checkId));
    expect(extractSecretRuntimeFinding(payloadOf({ checkId: 42, severity: "critical", detail: "secret unavailable" }))).toBeNull();
    // A findings payload that is not an array of findings is no payload.
    expect(classifySecretFindings(JSON.stringify({ ok: false, findings: "none" }))).toMatchObject({
      finding: null,
      reason: "no_payload",
      hygieneCheckIds: [],
    });
    expect(classifySecretFindings("")).toMatchObject({ finding: null, reason: "no_payload" });
    expect(classifySecretFindings(null)).toMatchObject({ finding: null, reason: "no_payload" });
  });
});
