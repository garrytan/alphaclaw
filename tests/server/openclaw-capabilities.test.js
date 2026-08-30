const {
  createOpenclawCapabilities,
  kPluginDependentTtlMs,
  kNegativeTtlMs,
  kTimedOutTtlMs,
} = require("../../lib/server/openclaw-capabilities");

const ok = (stdout = "", stderr = "") => ({ ok: true, stdout, stderr });
const fail = (stdout = "", stderr = "") => ({ ok: false, stdout, stderr, code: 1 });

describe("server/openclaw-capabilities", () => {
  it("detects a supported subcommand via --help and caches it per version", async () => {
    const clawCmd = vi.fn(async () => ok("Usage: openclaw backup sqlite ..."));
    const caps = createOpenclawCapabilities({
      clawCmd,
      getInstalledVersion: () => "2026.8.1-beta.3",
    });

    expect(await caps.get("backupSqlite")).toBe(true);
    // Second read is served from cache — clawCmd not called again.
    expect(await caps.get("backupSqlite")).toBe(true);
    expect(clawCmd).toHaveBeenCalledTimes(1);
  });

  it("classifies an unknown subcommand as unsupported", async () => {
    const clawCmd = vi.fn(async () => fail("", "unknown command 'sqlite'"));
    const caps = createOpenclawCapabilities({
      clawCmd,
      getInstalledVersion: () => "2026.7.1-2",
    });
    expect(await caps.get("backupSqlite")).toBe(false);
  });

  it("parses the restart-handoff capabilities JSON contract", async () => {
    const clawCmd = vi.fn(async () =>
      ok(JSON.stringify({ protocolVersion: 1, consume: true })),
    );
    const caps = createOpenclawCapabilities({ clawCmd, getInstalledVersion: () => "v" });
    const hs = await caps.get("restartHandoff");
    expect(hs).toEqual({ supported: true, protocolVersion: 1, consume: true });
  });

  it("treats restart-handoff without consume as unsupported", async () => {
    const clawCmd = vi.fn(async () => ok(JSON.stringify({ protocolVersion: 1 })));
    const caps = createOpenclawCapabilities({ clawCmd, getInstalledVersion: () => "v" });
    const hs = await caps.get("restartHandoff");
    expect(hs.supported).toBe(false);
  });

  it("detects the structured doctor --json shape vs legacy", async () => {
    const structured = createOpenclawCapabilities({
      clawCmd: async () => ok(JSON.stringify({ ok: true, findings: [] })),
      getInstalledVersion: () => "v",
    });
    expect(await structured.get("doctorJsonShape")).toBe("structured");

    const legacy = createOpenclawCapabilities({
      clawCmd: async () => ok(JSON.stringify({ healthy: true })),
      getInstalledVersion: () => "v",
    });
    expect(await legacy.get("doctorJsonShape")).toBe("legacy");
  });

  it("detects clickclack guided setup via the --code flag", async () => {
    const withCode = createOpenclawCapabilities({
      clawCmd: async () => ok("Options:\n  --code <value>  setup code\n  --token"),
      getInstalledVersion: () => "v",
    });
    expect(await withCode.get("clickclackGuidedSetup")).toBe(true);

    const withoutCode = createOpenclawCapabilities({
      clawCmd: async () => ok("Options:\n  --token <value>\n  --base-url"),
      getInstalledVersion: () => "v",
    });
    expect(await withoutCode.get("clickclackGuidedSetup")).toBe(false);
  });

  it("classifies trustedProxyTeam by config-path recognition", async () => {
    const supported = createOpenclawCapabilities({
      clawCmd: async () => ok("null"),
      getInstalledVersion: () => "v",
    });
    expect(await supported.get("trustedProxyTeam")).toBe(true);

    const unsupported = createOpenclawCapabilities({
      clawCmd: async () => fail("", "unknown config path"),
      getInstalledVersion: () => "v",
    });
    expect(await unsupported.get("trustedProxyTeam")).toBe(false);
  });

  it("re-probes after the installed version changes", async () => {
    let version = "2026.7.1-2";
    const clawCmd = vi.fn(async () => fail("", "unknown command"));
    const caps = createOpenclawCapabilities({
      clawCmd,
      getInstalledVersion: () => version,
    });
    expect(await caps.get("backupSqlite")).toBe(false);
    version = "2026.8.1-beta.3";
    clawCmd.mockResolvedValue(ok("Usage: ..."));
    expect(await caps.get("backupSqlite")).toBe(true);
    expect(clawCmd).toHaveBeenCalledTimes(2);
  });

  it("expires plugin-dependent positives after the TTL but keeps stable ones", async () => {
    let clock = 1_000_000;
    const clawCmd = vi.fn(async () => ok("Usage: ... --code"));
    const caps = createOpenclawCapabilities({
      clawCmd,
      getInstalledVersion: () => "v",
      nowFn: () => clock,
    });
    // clickclack is plugin-dependent (TTL-bounded); backupSqlite is stable (no TTL).
    expect(await caps.get("clickclackGuidedSetup")).toBe(true);
    expect(await caps.get("backupSqlite")).toBe(true);
    expect(clawCmd).toHaveBeenCalledTimes(2);

    clock += kPluginDependentTtlMs + 1;
    await caps.get("clickclackGuidedSetup"); // re-probes
    await caps.get("backupSqlite"); // still cached
    expect(clawCmd).toHaveBeenCalledTimes(3);
  });

  it("explicit invalidation forces a fresh probe", async () => {
    const clawCmd = vi.fn(async () => ok("Usage: ..."));
    const caps = createOpenclawCapabilities({ clawCmd, getInstalledVersion: () => "v" });
    await caps.get("secretsStore");
    caps.invalidate("secretsStore");
    await caps.get("secretsStore");
    expect(clawCmd).toHaveBeenCalledTimes(2);
  });

  it("fail-safes to unsupported on a probe error with a short negative TTL", async () => {
    let clock = 0;
    const clawCmd = vi.fn(async () => {
      throw new Error("spawn failed");
    });
    const caps = createOpenclawCapabilities({
      clawCmd,
      getInstalledVersion: () => "v",
      nowFn: () => clock,
      logger: { warn: () => {} },
    });
    expect(await caps.get("secretsStore")).toBe(false);
    // Within the negative TTL the failure is cached (no re-probe).
    await caps.get("secretsStore");
    expect(clawCmd).toHaveBeenCalledTimes(1);
    // After the negative TTL it re-probes.
    clock += kNegativeTtlMs + 1;
    await caps.get("secretsStore");
    expect(clawCmd).toHaveBeenCalledTimes(2);
  });

  it("re-probes a TIMED-OUT result on a shorter TTL than a plain negative", async () => {
    // openclaw >= 2026.9.1-beta.1 serializes every CLI call on a startup-
    // migration lease that a long doctor --fix can hold for minutes: a probe
    // timing out during that window means "try again shortly", never
    // "unsupported for the next minute".
    let clock = 0;
    const clawCmd = vi.fn(async () => ({
      ok: false,
      stdout: "",
      stderr: "",
      timedOut: true,
    }));
    const caps = createOpenclawCapabilities({
      clawCmd,
      getInstalledVersion: () => "v",
      nowFn: () => clock,
      logger: { warn: () => {} },
    });

    expect(await caps.get("secretsStore")).toBe(false);
    // Cached inside the timed-out TTL…
    clock += kTimedOutTtlMs - 1;
    await caps.get("secretsStore");
    expect(clawCmd).toHaveBeenCalledTimes(1);
    // …but re-probed before the regular negative TTL would have expired.
    clock += 2;
    await caps.get("secretsStore");
    expect(clawCmd).toHaveBeenCalledTimes(2);
    expect(kTimedOutTtlMs).toBeLessThan(kNegativeTtlMs);
  });

  it("discriminates the exec-approvals era via the parent approvals help (pending subcommand)", async () => {
    // Probing `approvals pending --help` would be wrong: commander 15 prints
    // the PARENT help and exits 0 for unknown-subcommand + --help, reporting
    // true on both eras. The parent help's subcommand list is the signal.
    const betaHelp = ok(
      [
        "Usage: openclaw approvals [options] [command]",
        "Commands:",
        "  get [options]        Fetch approvals",
        "  set [options]        Replace approvals",
        "  allowlist            Manage allowlist",
        "  pending [options]    List pending approval requests",
        "  resolve <id> <decision>",
      ].join("\n"),
    );
    const pinnedHelp = ok(
      [
        "Usage: openclaw approvals [options] [command]",
        "Commands:",
        "  get [options]        Fetch approvals",
        "  set [options]        Replace approvals",
        "  allowlist            Manage allowlist",
      ].join("\n"),
    );

    const betaCaps = createOpenclawCapabilities({
      clawCmd: vi.fn(async () => betaHelp),
      getInstalledVersion: () => "beta",
    });
    expect(await betaCaps.get("execApprovalsSqlite")).toBe("sqlite");

    const pinnedCaps = createOpenclawCapabilities({
      clawCmd: vi.fn(async () => pinnedHelp),
      getInstalledVersion: () => "pin",
    });
    expect(await pinnedCaps.get("execApprovalsSqlite")).toBe("file");

    // No approvals group at all: an ancient build — determinate file era.
    const ancientCaps = createOpenclawCapabilities({
      clawCmd: vi.fn(async () =>
        fail("", 'OpenClaw does not know the command "approvals".'),
      ),
      getInstalledVersion: () => "old",
    });
    expect(await ancientCaps.get("execApprovalsSqlite")).toBe("file");

    // Timeout / hard failure: UNKNOWN (indeterminate) — never a guess.
    const timedOutCaps = createOpenclawCapabilities({
      clawCmd: vi.fn(async () => ({ ok: false, stdout: "", stderr: "", timedOut: true })),
      getInstalledVersion: () => "busy",
    });
    expect(await timedOutCaps.get("execApprovalsSqlite")).toBe("unknown");
  });
});

describe("server/openclaw-capabilities buzz probe (5.2)", () => {
  const {
    createOpenclawCapabilities,
  } = require("../../lib/server/openclaw-capabilities");
  const ok = (stdout = "", stderr = "") => ({ ok: true, stdout, stderr });

  it("keys on the supported-channel enum, not --help exit status", async () => {
    // Stable: --help succeeds but the enum lacks buzz — must be FALSE.
    const stableHelp = ok(
      "Usage: openclaw channels add [options]\n--channel <name> Channel\n(telegram|whatsapp|discord|slack|\nclickclack|twitch)",
    );
    const stable = createOpenclawCapabilities({
      clawCmd: vi.fn(async () => stableHelp),
      getInstalledVersion: () => "2026.7.1-2",
    });
    expect(await stable.get("buzzChannel")).toBe(false);

    // Beta with the plugin: buzz appears in the enum — TRUE (even wrapped
    // across help-text lines).
    const betaHelp = ok(
      "Usage: openclaw channels add [options]\n--channel <name> Channel\n(telegram|whatsapp|discord|slack|\nbuzz|clickclack|twitch)",
    );
    const beta = createOpenclawCapabilities({
      clawCmd: vi.fn(async () => betaHelp),
      getInstalledVersion: () => "2026.8.1-beta.3",
    });
    expect(await beta.get("buzzChannel")).toBe(true);
  });
});
