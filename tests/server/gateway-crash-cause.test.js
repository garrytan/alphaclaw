// Crash-cause classifier (issue #76 A3): one verbatim fixture per cause,
// hostile fixtures (buried signatures, noise, lookalikes), the precedence
// order, fingerprint stability and the per-cause corroboration matrix.
const {
  kGatewayCrashCauses,
  kVersionFamilyGatewayCrashCauses,
  kCorroboratedGatewayCrashCauses,
  classifyGatewayCrash,
  fingerprintGatewayCrash,
  normalizeCrashLine,
  corroborateGatewayCrash,
} = require("../../lib/server/gateway-crash-cause");
const watchdog = require("../../lib/server/watchdog");
const { kBackupTailClassifyLines } = require("../../lib/server/constants");

// ── verbatim upstream wording ───────────────────────────────────────────────
// The #76 incident's exact line (2026.7.1-2 build refusing a 2026.9.1-beta.1
// state DB).
const kIncidentStateLine =
  "OpenClaw state database /data/.openclaw/state/openclaw.sqlite uses newer schema version 12; this OpenClaw build supports 1";
// 2026.9.2 dist wording (dist/sqlite-user-version-*.js): "this build
// supports" + a "Refused by" continuation line.
const kStateLine92 =
  "OpenClaw state database /data/.openclaw/state/openclaw.sqlite uses newer schema version 21; this build supports 15.";
const kRefusedByLine = "Refused by OpenClaw 2026.9.2 (npm).";
const kAgentLine =
  "OpenClaw agent database /data/.openclaw/agents/main/agent/openclaw-agent.sqlite uses newer schema version 21; this build supports 19.";
const kMigrationRefusalLine =
  "OpenClaw refused to start: state database schema migration pending (run openclaw doctor --fix)";
const kLegacyExecApprovalsLine =
  "Legacy exec approvals exist at /data/.openclaw/exec-approvals.json. Run `openclaw doctor --fix` before using exec approvals.";
const kIncidentPluginLine =
  "plugin requires plugin API >=2026.9.1-beta.1, but this host is 2026.7.1-2";
const kPluginLine92 =
  "[plugins] codex: plugin requires plugin API >=2026.9.1, but this host is 2026.7.1-2; skipping discovery (check the plugin's package.json)";
const kPluginRuntimeLine =
  "codex requires plugin API ^2026.9, but this OpenClaw runtime exposes 2026.7.1-2.";
// The 2026-09-01 incident's CLI crash (doctor-classify-cli fixture).
const kIncidentCrash =
  "Could not start the CLI.\nReason: Unable to resolve bundled plugin public surface codex/api.js";
const kCliErrorEnvelope = JSON.stringify({
  ok: false,
  error: { type: "cli_error", message: "Could not start the CLI. Unable to resolve bundled plugin public surface codex/api.js" },
});
// Ownership wording from the lock-contention table.
const kStateWriterLine = "state directory is locked by agent-embedded (pid 777)";
const kGatewayConflictLine = "gateway already running (pid 4321); lock timeout after 5000ms";
const kEaddrinuseLine = "Error: listen EADDRINUSE: address already in use 127.0.0.1:18789";
const kHeapOomLine =
  "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory";

const noise = (count, prefix = "log") =>
  Array.from({ length: count }, (_, i) => `[gateway] ${prefix} line ${i} still running fine`);

describe("kGatewayCrashCauses", () => {
  it("is the frozen 11-value enum in precedence order", () => {
    expect(Object.isFrozen(kGatewayCrashCauses)).toBe(true);
    expect(kGatewayCrashCauses).toEqual([
      "state_schema_too_new",
      "agent_schema_too_new",
      "state_schema_migration_failed",
      "legacy_exec_approvals",
      "plugin_api_too_old",
      "cli_startup_crash",
      "port_in_use",
      "state_dir_owned",
      "oom",
      "config_invalid",
      "unknown",
    ]);
    expect(kVersionFamilyGatewayCrashCauses).toEqual(kGatewayCrashCauses.slice(0, 6));
    expect(Object.isFrozen(kVersionFamilyGatewayCrashCauses)).toBe(true);
  });

  it("the corroboration table covers exactly the plan's three rows", () => {
    expect([...kCorroboratedGatewayCrashCauses].sort()).toEqual(
      [
        "state_schema_too_new",
        "agent_schema_too_new",
        "plugin_api_too_old",
        "cli_startup_crash",
        "legacy_exec_approvals",
      ].sort(),
    );
    for (const cause of kCorroboratedGatewayCrashCauses) {
      expect(kVersionFamilyGatewayCrashCauses).toContain(cause);
    }
  });

  it("watchdog.js exports the shared signatures the classifier delegates to (declared once)", () => {
    expect(watchdog.kStateMigrationRefusalPattern).toBeInstanceOf(RegExp);
    expect(watchdog.kHeapOomPattern).toBeInstanceOf(RegExp);
    expect(watchdog.kOpenclawConfigErrorExitCode).toBe(78);
    expect(watchdog.kHeapOomPattern.test(kHeapOomLine)).toBe(true);
    expect(watchdog.kStateMigrationRefusalPattern.test(kMigrationRefusalLine)).toBe(true);
  });
});

describe("classifyGatewayCrash — version family", () => {
  it("the incident's exact state-DB refusal → state_schema_too_new with found/supports and the DB path", () => {
    const result = classifyGatewayCrash({ code: 1, signal: null, stderrTail: [kIncidentStateLine] });
    expect(result).toEqual({
      cause: "state_schema_too_new",
      detail: "state DB /data/.openclaw/state/openclaw.sqlite carries schema 12; the exited build supports 1",
      matchedLine: kIncidentStateLine,
      versions: { found: 12, supports: 1 },
      dbPath: "/data/.openclaw/state/openclaw.sqlite",
    });
  });

  it("the 2026.9.2 wording ('this build supports', trailing period, Refused-by line) classifies the same way", () => {
    const result = classifyGatewayCrash({
      code: 1,
      stderrTail: ["[gateway] starting", kStateLine92, kRefusedByLine, "Use a build that supports schema 21 or newer with this state directory."],
    });
    expect(result).toMatchObject({
      cause: "state_schema_too_new",
      matchedLine: kStateLine92,
      versions: { found: 21, supports: 15 },
      dbPath: "/data/.openclaw/state/openclaw.sqlite",
    });
  });

  it("an agent DB (openclaw-agent.sqlite / 'agent database' label) → agent_schema_too_new", () => {
    const byPath = classifyGatewayCrash({ code: 1, stderrTail: [kAgentLine] });
    expect(byPath).toMatchObject({
      cause: "agent_schema_too_new",
      versions: { found: 21, supports: 19 },
      dbPath: "/data/.openclaw/agents/main/agent/openclaw-agent.sqlite",
    });
    // Label-only fallback: a build that drops the path still names the kind.
    const byLabel = classifyGatewayCrash({
      code: 1,
      stderrTail: ["OpenClaw agent database uses newer schema version 21; this build supports 19."],
    });
    expect(byLabel).toMatchObject({ cause: "agent_schema_too_new", dbPath: null, versions: { found: 21, supports: 19 } });
    const stateByLabel = classifyGatewayCrash({
      code: 1,
      stderrTail: ["OpenClaw state database uses newer schema version 12; this OpenClaw build supports 1"],
    });
    expect(stateByLabel).toMatchObject({ cause: "state_schema_too_new", dbPath: null });
  });

  it("the state-migration EX_CONFIG refusal → state_schema_migration_failed (delegates to the watchdog's pattern; beats config_invalid on exit 78)", () => {
    const result = classifyGatewayCrash({ code: 78, stderrTail: ["[gateway] boot", kMigrationRefusalLine] });
    expect(result).toEqual({
      cause: "state_schema_migration_failed",
      detail: 'the exited build refused to start: "state database schema migration pending"',
      matchedLine: kMigrationRefusalLine,
    });
  });

  it("'Legacy exec approvals exist at <file>.' → legacy_exec_approvals naming the file (issue #23)", () => {
    const result = classifyGatewayCrash({ code: 1, stderrTail: [kLegacyExecApprovalsLine] });
    expect(result).toEqual({
      cause: "legacy_exec_approvals",
      detail: "legacy exec-approvals file /data/.openclaw/exec-approvals.json is existence-fatal on the exited build",
      matchedLine: kLegacyExecApprovalsLine,
    });
  });

  it("plugin API range vs host version → plugin_api_too_old with versions { requires, host } in all three spellings", () => {
    expect(classifyGatewayCrash({ code: 1, stderrTail: [kIncidentPluginLine] })).toEqual({
      cause: "plugin_api_too_old",
      detail: "a plugin requires plugin API >=2026.9.1-beta.1; the exited build exposes 2026.7.1-2",
      matchedLine: kIncidentPluginLine,
      versions: { requires: ">=2026.9.1-beta.1", host: "2026.7.1-2" },
    });
    // 2026.9.2 loader form: the host token is terminated by ";".
    expect(classifyGatewayCrash({ code: 1, stderrTail: [kPluginLine92] })).toMatchObject({
      cause: "plugin_api_too_old",
      versions: { requires: ">=2026.9.1", host: "2026.7.1-2" },
    });
    // Runtime form: sentence-final period is not part of the version.
    expect(classifyGatewayCrash({ code: 1, stderrTail: [kPluginRuntimeLine] })).toMatchObject({
      cause: "plugin_api_too_old",
      versions: { requires: "^2026.9", host: "2026.7.1-2" },
    });
  });

  it("'Could not start the CLI' (plain text or a cli_error envelope) → cli_startup_crash via matchesCliStartupFailure", () => {
    const plain = classifyGatewayCrash({ code: 1, stderrTail: kIncidentCrash });
    expect(plain).toEqual({
      cause: "cli_startup_crash",
      detail: "Could not start the CLI.",
      matchedLine: "Could not start the CLI.",
    });
    const envelope = classifyGatewayCrash({ code: 1, stderrTail: ["log noise", kCliErrorEnvelope] });
    expect(envelope).toMatchObject({ cause: "cli_startup_crash", matchedLine: kCliErrorEnvelope });
    // A multi-line envelope only parses as a whole: the line carrying the
    // crash text is named (the type line when no line does).
    const multiLine = JSON.stringify(
      { ok: false, error: { type: "cli_error", message: "Could not start the CLI." } },
      null,
      2,
    ).split("\n");
    const spread = classifyGatewayCrash({ code: 1, stderrTail: multiLine });
    expect(spread.cause).toBe("cli_startup_crash");
    expect(spread.matchedLine).toBe('"message": "Could not start the CLI."');
    const bootstrapOnly = JSON.stringify(
      { ok: false, error: { type: "cli_error", message: "bundled plugin surface missing" } },
      null,
      2,
    ).split("\n");
    const typeLine = classifyGatewayCrash({ code: 1, stderrTail: bootstrapOnly });
    expect(typeLine.cause).toBe("cli_startup_crash");
    expect(typeLine.matchedLine).toBe('"type": "cli_error",');
  });

  it("a sub-command cli_error envelope (backup ENOENT) is NOT a startup crash", () => {
    const subCommand = JSON.stringify({
      ok: false,
      error: { type: "cli_error", message: "ENOENT: no such file or directory, realpath '/data/openclaw-agent.sqlite'" },
    });
    expect(classifyGatewayCrash({ code: 1, stderrTail: [subCommand] }).cause).toBe("unknown");
  });
});

describe("classifyGatewayCrash — ownership, port, oom, config, unknown, null", () => {
  it("ownership wording → state_dir_owned carrying classifyOwnershipConflict's verdict and the conflict line", () => {
    const writer = classifyGatewayCrash({
      code: 1,
      stderrTail: ["[gateway] starting (pid 100)", kStateWriterLine],
    });
    expect(writer).toEqual({
      cause: "state_dir_owned",
      detail: "state_writer_conflict held by agent-embedded (pid 777)",
      matchedLine: kStateWriterLine,
      conflict: { kind: "state_writer_conflict", holderPid: 777, holderRole: "agent-embedded" },
    });
    const gateway = classifyGatewayCrash({ code: 1, stderrTail: [kGatewayConflictLine] });
    expect(gateway).toMatchObject({
      cause: "state_dir_owned",
      detail: "gateway_conflict (pid 4321)",
      conflict: { kind: "gateway_conflict", holderPid: 4321, holderRole: null },
    });
    expect(
      classifyGatewayCrash({ code: 1, stderrTail: ["failed to acquire gateway state ownership"] }),
    ).toMatchObject({ cause: "state_dir_owned", detail: "state_writer_conflict" });
  });

  it("EADDRINUSE / 'address already in use' → port_in_use", () => {
    expect(classifyGatewayCrash({ code: 1, stderrTail: [kEaddrinuseLine] })).toEqual({
      cause: "port_in_use",
      detail: "the gateway port is already bound (EADDRINUSE)",
      matchedLine: kEaddrinuseLine,
    });
    expect(classifyGatewayCrash({ code: 1, stderrTail: ["bind: address already in use"] }).cause).toBe(
      "port_in_use",
    );
  });

  it("heap OOM text → oom (heap); exit 137 or SIGKILL with no text → oom (kernel, not conclusive)", () => {
    expect(classifyGatewayCrash({ code: null, signal: "SIGABRT", stderrTail: [kHeapOomLine] })).toEqual({
      cause: "oom",
      detail: "V8 heap exhausted (JavaScript heap out of memory)",
      matchedLine: kHeapOomLine,
    });
    expect(classifyGatewayCrash({ code: 137, stderrTail: [] })).toEqual({
      cause: "oom",
      detail: "force-killed (exit 137) — commonly the kernel OOM killer; not conclusive",
      matchedLine: null,
    });
    expect(classifyGatewayCrash({ code: null, signal: "SIGKILL", stderrTail: noise(3) })).toMatchObject({
      cause: "oom",
      detail: "force-killed (signal SIGKILL) — commonly the kernel OOM killer; not conclusive",
    });
    // SIGTERM is a stop, not an OOM.
    expect(classifyGatewayCrash({ code: null, signal: "SIGTERM" }).cause).toBe("unknown");
  });

  it("exit 78 without any signature → config_invalid with the tail's error-shaped line (or null)", () => {
    const withCause = classifyGatewayCrash({
      code: 78,
      stderrTail: ["[gateway] loading config", "Error: gateway.auth.mode must be one of token, password", "exiting"],
    });
    expect(withCause).toEqual({
      cause: "config_invalid",
      detail: "exit 78 (EX_CONFIG) without a schema, migration or exec-approvals signature",
      matchedLine: "Error: gateway.auth.mode must be one of token, password",
    });
    expect(classifyGatewayCrash({ code: "78", stderrTail: [] })).toMatchObject({
      cause: "config_invalid",
      matchedLine: null,
    });
  });

  it("an unrecognized exit → unknown with pickCauseLine's pick (no last-line fallback)", () => {
    expect(classifyGatewayCrash({ code: 1, stderrTail: ["[gateway] boot", "Error: x is not a function", "done"] })).toEqual({
      cause: "unknown",
      detail: "exit 1 without a recognized stderr signature",
      matchedLine: "Error: x is not a function",
    });
    expect(classifyGatewayCrash({ code: 2, stderrTail: ["just chatter", "more chatter"] })).toEqual({
      cause: "unknown",
      detail: "exit 2 without a recognized stderr signature",
      matchedLine: null,
    });
    expect(classifyGatewayCrash({ code: 1 })).toMatchObject({ cause: "unknown", matchedLine: null });
  });

  it("returns null only when there is nothing to classify (no code, no signal, empty tail)", () => {
    expect(classifyGatewayCrash()).toBeNull();
    expect(classifyGatewayCrash({})).toBeNull();
    expect(classifyGatewayCrash({ code: null, signal: null, stderrTail: [] })).toBeNull();
    expect(classifyGatewayCrash({ stderrTail: "" })).toBeNull();
    expect(classifyGatewayCrash({ stderrTail: ["   ", ""] })).toBeNull();
    // A tail without an exit code still classifies (probe-death evidence).
    expect(classifyGatewayCrash({ stderrTail: [kIncidentStateLine] }).cause).toBe("state_schema_too_new");
  });

  it("every emitted cause is a member of the enum", () => {
    const fixtures = [
      { code: 1, stderrTail: [kIncidentStateLine] },
      { code: 1, stderrTail: [kAgentLine] },
      { code: 78, stderrTail: [kMigrationRefusalLine] },
      { code: 1, stderrTail: [kLegacyExecApprovalsLine] },
      { code: 1, stderrTail: [kIncidentPluginLine] },
      { code: 1, stderrTail: kIncidentCrash },
      { code: 1, stderrTail: [kEaddrinuseLine] },
      { code: 1, stderrTail: [kStateWriterLine] },
      { code: 137 },
      { code: 78 },
      { code: 1 },
    ];
    const seen = new Set();
    for (const fixture of fixtures) {
      const { cause } = classifyGatewayCrash(fixture);
      expect(kGatewayCrashCauses).toContain(cause);
      seen.add(cause);
    }
    expect(seen.size).toBe(kGatewayCrashCauses.length);
  });
});

describe("classifyGatewayCrash — hostile fixtures", () => {
  it("reads ONLY the last kBackupTailClassifyLines non-empty lines: a signature older than the window is not matched", () => {
    expect(kBackupTailClassifyLines).toBe(20);
    const buried = [kIncidentStateLine, ...noise(kBackupTailClassifyLines)];
    expect(classifyGatewayCrash({ code: 1, stderrTail: buried }).cause).toBe("unknown");
    // Exactly at the boundary the signature is still inside the window.
    const atEdge = [kIncidentStateLine, ...noise(kBackupTailClassifyLines - 1)];
    expect(classifyGatewayCrash({ code: 1, stderrTail: atEdge }).cause).toBe("state_schema_too_new");
    // Blank lines do not consume window slots.
    const padded = [kIncidentStateLine, ...noise(kBackupTailClassifyLines - 1).flatMap((l) => [l, "", "   "])];
    expect(classifyGatewayCrash({ code: 1, stderrTail: padded }).cause).toBe("state_schema_too_new");
  });

  it("a string tail, an array tail and an ANSI-decorated tail classify identically", () => {
    const asArray = classifyGatewayCrash({ code: 1, stderrTail: ["[gateway] boot", kIncidentStateLine] });
    const asString = classifyGatewayCrash({ code: 1, stderrTail: `[gateway] boot\r\n${kIncidentStateLine}\n` });
    const asAnsi = classifyGatewayCrash({
      code: 1,
      stderrTail: [`\x1b[31m${kIncidentStateLine}\x1b[0m`],
    });
    expect(asString).toEqual(asArray);
    expect(asAnsi).toEqual(asArray);
  });

  it("the most RECENT matching line wins inside the window", () => {
    const result = classifyGatewayCrash({
      code: 1,
      stderrTail: [kIncidentStateLine, "[gateway] retrying", kStateLine92],
    });
    expect(result).toMatchObject({ matchedLine: kStateLine92, versions: { found: 21, supports: 15 } });
  });

  it("lookalikes do not classify: the quarantine-store line (no 'supports' clause), prose containing 'startup', a healthy-listening line", () => {
    for (const line of [
      "OpenClaw quarantine store /data/.openclaw/quarantine.sqlite uses newer schema version 3.",
      "the doctor said startup was slow but the CLI came up",
      "Gateway listening on ws://127.0.0.1:18789",
      "requires plugin API but nothing else on this line",
    ]) {
      expect(classifyGatewayCrash({ code: 1, stderrTail: [line] }).cause, line).toBe("unknown");
    }
  });
});

describe("classifyGatewayCrash — precedence (version family → ownership → oom → config → unknown)", () => {
  it("a schema refusal outranks EADDRINUSE, heap OOM and exit 78 in the same tail", () => {
    const result = classifyGatewayCrash({
      code: 78,
      stderrTail: [kHeapOomLine, kEaddrinuseLine, kGatewayConflictLine, kIncidentStateLine],
    });
    expect(result.cause).toBe("state_schema_too_new");
  });

  it("inside the version family the enum order holds: schema > migration > exec-approvals > plugin > CLI crash", () => {
    expect(
      classifyGatewayCrash({ code: 78, stderrTail: [kMigrationRefusalLine, kAgentLine] }).cause,
    ).toBe("agent_schema_too_new");
    expect(
      classifyGatewayCrash({ code: 78, stderrTail: [kLegacyExecApprovalsLine, kMigrationRefusalLine] }).cause,
    ).toBe("state_schema_migration_failed");
    expect(
      classifyGatewayCrash({ code: 1, stderrTail: [kIncidentPluginLine, kLegacyExecApprovalsLine] }).cause,
    ).toBe("legacy_exec_approvals");
    expect(
      classifyGatewayCrash({ code: 1, stderrTail: [kIncidentPluginLine, ...kIncidentCrash.split("\n")] }).cause,
    ).toBe("plugin_api_too_old");
  });

  it("ownership outranks port, oom and config; oom outranks config", () => {
    expect(classifyGatewayCrash({ code: 78, stderrTail: [kEaddrinuseLine, kStateWriterLine, kHeapOomLine] }).cause).toBe(
      "state_dir_owned",
    );
    expect(classifyGatewayCrash({ code: 78, stderrTail: [kHeapOomLine, kEaddrinuseLine] }).cause).toBe("port_in_use");
    expect(classifyGatewayCrash({ code: 78, stderrTail: [kHeapOomLine] }).cause).toBe("oom");
    expect(classifyGatewayCrash({ code: 137, stderrTail: [kIncidentCrash] }).cause).toBe("cli_startup_crash");
  });
});

describe("fingerprintGatewayCrash / normalizeCrashLine", () => {
  it("normalizes paths, digits, ANSI, case and whitespace", () => {
    expect(normalizeCrashLine(`\x1b[31m  ${kIncidentStateLine}  \x1b[0m`)).toBe(
      "openclaw state database <path> uses newer schema version #; this openclaw build supports #",
    );
    expect(normalizeCrashLine(kGatewayConflictLine)).toBe("gateway already running (pid #); lock timeout after #ms");
    expect(normalizeCrashLine(null)).toBe("");
  });

  it("is a 12-char lowercase hex digest, deterministic for identical input", () => {
    const a = fingerprintGatewayCrash({ cause: "state_schema_too_new", code: 1, matchedLine: kIncidentStateLine });
    const b = fingerprintGatewayCrash({ cause: "state_schema_too_new", code: 1, matchedLine: kIncidentStateLine });
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).toBe(b);
  });

  it("digit-only and path-only differences share a fingerprint (the same crash on another box / another schema pair)", () => {
    const incident = classifyGatewayCrash({ code: 1, stderrTail: [kIncidentStateLine] });
    const later = classifyGatewayCrash({
      code: 1,
      stderrTail: ["OpenClaw state database /srv/volume/state/openclaw.sqlite uses newer schema version 21; this OpenClaw build supports 15"],
    });
    expect(fingerprintGatewayCrash({ ...incident, code: 1 })).toBe(fingerprintGatewayCrash({ ...later, code: 1 }));
    const pidA = classifyGatewayCrash({ code: 1, stderrTail: [kGatewayConflictLine] });
    const pidB = classifyGatewayCrash({ code: 1, stderrTail: ["gateway already running (pid 99); lock timeout after 9ms"] });
    expect(fingerprintGatewayCrash({ ...pidA, code: 1 })).toBe(fingerprintGatewayCrash({ ...pidB, code: 1 }));
  });

  it("a different cause, exit code or wording yields a different fingerprint", () => {
    const base = { cause: "state_schema_too_new", code: 1, matchedLine: kIncidentStateLine };
    expect(fingerprintGatewayCrash({ ...base, cause: "agent_schema_too_new" })).not.toBe(fingerprintGatewayCrash(base));
    expect(fingerprintGatewayCrash({ ...base, code: 78 })).not.toBe(fingerprintGatewayCrash(base));
    expect(fingerprintGatewayCrash({ ...base, matchedLine: kMigrationRefusalLine })).not.toBe(
      fingerprintGatewayCrash(base),
    );
  });

  it("a signal-terminated child contributes its signal in the exit slot; an invalid cause hashes as unknown", () => {
    const kill = fingerprintGatewayCrash({ cause: "oom", code: null, signal: "SIGKILL", matchedLine: null });
    const abort = fingerprintGatewayCrash({ cause: "oom", code: null, signal: "SIGABRT", matchedLine: null });
    expect(kill).not.toBe(abort);
    expect(fingerprintGatewayCrash({ cause: "oom", code: null, signal: "SIGKILL" })).toBe(kill);
    expect(fingerprintGatewayCrash({ cause: "not_a_cause", code: 1, matchedLine: "x" })).toBe(
      fingerprintGatewayCrash({ cause: "unknown", code: 1, matchedLine: "x" }),
    );
    expect(fingerprintGatewayCrash({ code: 1 })).toBe(fingerprintGatewayCrash({ cause: "unknown", code: 1, matchedLine: null }));
  });
});

describe("corroborateGatewayCrash — per-cause table", () => {
  const kStatePath = "/data/.openclaw/state/openclaw.sqlite";
  const kAgentPath = "/data/.openclaw/agents/main/agent/openclaw-agent.sqlite";
  const stateTooNew = classifyGatewayCrash({ code: 1, stderrTail: [kIncidentStateLine] }); // found 12
  const agentTooNew = classifyGatewayCrash({ code: 1, stderrTail: [kAgentLine] }); // found 21
  const notCorroborated = { corroborated: false, by: null };

  it("state/agent schema: stderr's found equals the named DB's observed user_version → by user_version", () => {
    expect(
      corroborateGatewayCrash({ classification: stateTooNew, facts: { userVersionsByPath: { [kStatePath]: 12 } } }),
    ).toEqual({ corroborated: true, by: "user_version" });
    expect(
      corroborateGatewayCrash({ classification: agentTooNew, facts: { userVersionsByPath: { [kAgentPath]: 21 } } }),
    ).toEqual({ corroborated: true, by: "user_version" });
  });

  it("state/agent schema: the observed user_version exceeds the exited build's supported schema (per kind) → by supported_schema", () => {
    expect(
      corroborateGatewayCrash({
        classification: stateTooNew,
        facts: { userVersionsByPath: { [kStatePath]: 15 }, supportedSchema: { state: 1, agent: 19 } },
      }),
    ).toEqual({ corroborated: true, by: "supported_schema" });
    // The agent cause reads supportedSchema.agent, never .state.
    expect(
      corroborateGatewayCrash({
        classification: agentTooNew,
        facts: { userVersionsByPath: { [kAgentPath]: 20 }, supportedSchema: { state: 1, agent: 21 } },
      }),
    ).toEqual(notCorroborated);
    expect(
      corroborateGatewayCrash({
        classification: agentTooNew,
        facts: { userVersionsByPath: { [kAgentPath]: 20 }, supportedSchema: { state: 1, agent: 19 } },
      }),
    ).toEqual({ corroborated: true, by: "supported_schema" });
    // observed == supported means the build CAN read it: stderr lied.
    expect(
      corroborateGatewayCrash({
        classification: stateTooNew,
        facts: { userVersionsByPath: { [kStatePath]: 15 }, supportedSchema: { state: 15 } },
      }),
    ).toEqual(notCorroborated);
  });

  it("state/agent schema: no observed user_version → never corroborated, even when stderr's own numbers say found > supports", () => {
    expect(corroborateGatewayCrash({ classification: stateTooNew, facts: {} })).toEqual(notCorroborated);
    expect(corroborateGatewayCrash({ classification: stateTooNew })).toEqual(notCorroborated);
    // Steerability guard: the table says the build supports 1 and stderr
    // claims 12, but nothing independent read the DB.
    expect(
      corroborateGatewayCrash({ classification: stateTooNew, facts: { supportedSchema: { state: 1 } } }),
    ).toEqual(notCorroborated);
    // A DB the caller could not read (null) is not evidence either.
    expect(
      corroborateGatewayCrash({
        classification: stateTooNew,
        facts: { userVersionsByPath: { [kStatePath]: null }, supportedSchema: { state: 1 } },
      }),
    ).toEqual(notCorroborated);
    // Mismatching observed value with no supported schema: stderr disagrees with the DB.
    expect(
      corroborateGatewayCrash({ classification: stateTooNew, facts: { userVersionsByPath: { [kStatePath]: 11 } } }),
    ).toEqual(notCorroborated);
  });

  it("state/agent schema: the named DB resolves by exact path, then by a UNIQUE basename; ambiguous agent DBs do not", () => {
    // Symlinked volume: stderr spells the state DB differently from the enumerated path.
    expect(
      corroborateGatewayCrash({
        classification: stateTooNew,
        facts: { userVersionsByPath: { "/srv/volume/state/openclaw.sqlite": 12 } },
      }),
    ).toEqual({ corroborated: true, by: "user_version" });
    // Two agents share the basename; the stderr path matches neither exactly.
    const twoAgents = {
      "/srv/agents/a/agent/openclaw-agent.sqlite": 21,
      "/srv/agents/b/agent/openclaw-agent.sqlite": 21,
    };
    expect(corroborateGatewayCrash({ classification: agentTooNew, facts: { userVersionsByPath: twoAgents } })).toEqual(
      notCorroborated,
    );
    // …but an exact key among several still resolves.
    expect(
      corroborateGatewayCrash({
        classification: agentTooNew,
        facts: { userVersionsByPath: { ...twoAgents, [kAgentPath]: 21 } },
      }),
    ).toEqual({ corroborated: true, by: "user_version" });
    // A classification without a DB path cannot be corroborated by user_version.
    const noPath = classifyGatewayCrash({
      code: 1,
      stderrTail: ["OpenClaw state database uses newer schema version 12; this OpenClaw build supports 1"],
    });
    expect(
      corroborateGatewayCrash({ classification: noPath, facts: { userVersionsByPath: { [kStatePath]: 12 } } }),
    ).toEqual(notCorroborated);
  });

  it("plugin_api_too_old / cli_startup_crash: corroborated by installedDiverged only", () => {
    const plugin = classifyGatewayCrash({ code: 1, stderrTail: [kIncidentPluginLine] });
    const crash = classifyGatewayCrash({ code: 1, stderrTail: kIncidentCrash });
    for (const classification of [plugin, crash]) {
      expect(corroborateGatewayCrash({ classification, facts: { installedDiverged: true } })).toEqual({
        corroborated: true,
        by: "installed_diverged",
      });
      expect(corroborateGatewayCrash({ classification, facts: { installedDiverged: false } })).toEqual(notCorroborated);
      expect(corroborateGatewayCrash({ classification, facts: {} })).toEqual(notCorroborated);
      // Truthy-but-not-true never passes (a string "true" from a JSON file).
      expect(corroborateGatewayCrash({ classification, facts: { installedDiverged: "true" } })).toEqual(notCorroborated);
      // Unrelated rich facts do not leak across rows.
      expect(
        corroborateGatewayCrash({
          classification,
          facts: { legacyExecApprovalsPresent: true, userVersionsByPath: { [kStatePath]: 12 }, supportedSchema: { state: 1 } },
        }),
      ).toEqual(notCorroborated);
    }
  });

  it("legacy_exec_approvals: corroborated by the file's presence only", () => {
    const classification = classifyGatewayCrash({ code: 1, stderrTail: [kLegacyExecApprovalsLine] });
    expect(corroborateGatewayCrash({ classification, facts: { legacyExecApprovalsPresent: true } })).toEqual({
      corroborated: true,
      by: "legacy_exec_approvals_file",
    });
    expect(corroborateGatewayCrash({ classification, facts: { legacyExecApprovalsPresent: false } })).toEqual(
      notCorroborated,
    );
    expect(corroborateGatewayCrash({ classification, facts: { installedDiverged: true } })).toEqual(notCorroborated);
  });

  it.each([
    ["state_schema_migration_failed", { code: 78, stderrTail: [kMigrationRefusalLine] }],
    ["port_in_use", { code: 1, stderrTail: [kEaddrinuseLine] }],
    ["state_dir_owned", { code: 1, stderrTail: [kStateWriterLine] }],
    ["oom", { code: 137 }],
    ["config_invalid", { code: 78 }],
    ["unknown", { code: 1 }],
  ])("%s has no corroborator: never corroborated regardless of facts", (cause, exit) => {
    const classification = classifyGatewayCrash(exit);
    expect(classification.cause).toBe(cause);
    expect(
      corroborateGatewayCrash({
        classification,
        facts: {
          installedDiverged: true,
          legacyExecApprovalsPresent: true,
          userVersionsByPath: { [kStatePath]: 12, [kAgentPath]: 21 },
          supportedSchema: { state: 1, agent: 1 },
        },
      }),
    ).toEqual(notCorroborated);
  });

  it("a null classification or a prototype-shaped cause is never corroborated (and never throws)", () => {
    expect(corroborateGatewayCrash({ classification: null, facts: { installedDiverged: true } })).toEqual(notCorroborated);
    expect(corroborateGatewayCrash()).toEqual(notCorroborated);
    for (const cause of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(corroborateGatewayCrash({ classification: { cause }, facts: { installedDiverged: true } }), cause).toEqual(
        notCorroborated,
      );
    }
    // Returned verdicts are fresh objects (a caller mutating one cannot poison the shared constant).
    const first = corroborateGatewayCrash({ classification: { cause: "oom" } });
    first.corroborated = true;
    expect(corroborateGatewayCrash({ classification: { cause: "oom" } })).toEqual(notCorroborated);
  });
});
