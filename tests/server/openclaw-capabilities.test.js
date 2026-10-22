const {
  createOpenclawCapabilities,
  kPinnedCapabilities,
  kNegativeTtlMs,
  kTimedOutTtlMs,
  kCapabilityKeys,
} = require("../../lib/server/openclaw-capabilities");

const ok = (stdout = "", stderr = "") => ({ ok: true, stdout, stderr });
const fail = (stdout = "", stderr = "") => ({ ok: false, stdout, stderr, code: 1 });

describe("server/openclaw-capabilities pinned answers", () => {
  it("getAll answers the pinned constants for every key without spawning", async () => {
    const clawCmd = vi.fn(async () => fail("", "should not run"));
    const caps = createOpenclawCapabilities({ clawCmd, getInstalledVersion: () => null });
    expect(await caps.getAll()).toEqual({
      restartHandoff: { supported: true, protocolVersion: 1, consume: true },
      databasePreflight: true,
      backupSqlite: true,
      secretsStore: true,
      updateRepair: true,
      execApprovalsCli: true,
      execApprovalsSqlite: "sqlite",
      buzzChannel: true,
      clickclackGuidedSetup: true,
      trustedProxyTeam: true,
    });
    expect(kCapabilityKeys.sort()).toEqual(Object.keys(kPinnedCapabilities).sort());
    expect(clawCmd).not.toHaveBeenCalled();
  });

  it("a wedged CLI no longer reports Buzz or Team as unavailable", async () => {
    const clawCmd = vi.fn(async () => ({ ok: false, stdout: "", stderr: "", timedOut: true }));
    const caps = createOpenclawCapabilities({ clawCmd, getInstalledVersion: () => "2026.10.4" });
    const all = await caps.getAll();
    expect(all.buzzChannel).toBe(true);
    expect(all.trustedProxyTeam).toBe(true);
    expect(await caps.get("trustedProxyTeam")).toBe(true);
    expect(await caps.get("clickclackGuidedSetup")).toBe(true);
    expect(clawCmd).not.toHaveBeenCalled();
  });

  it("getAll hands out a copy, so a caller cannot change the constants", async () => {
    const caps = createOpenclawCapabilities({ clawCmd: async () => ok("") });
    const first = await caps.getAll();
    first.buzzChannel = false;
    expect((await caps.getAll()).buzzChannel).toBe(true);
    expect(Object.isFrozen(kPinnedCapabilities)).toBe(true);
  });

  it("rejects an unknown key, including the deleted doctorJsonShape", async () => {
    const caps = createOpenclawCapabilities({ clawCmd: async () => ok(""), getInstalledVersion: () => "v" });
    await expect(caps.get("doctorJsonShape")).rejects.toThrow(/unknown OpenClaw capability/);
    expect(kCapabilityKeys).not.toContain("doctorJsonShape");
  });
});

describe("server/openclaw-capabilities internal probes (until PR 16b)", () => {
  it("execApprovalsCli detects the approvals group via --help and caches it per version", async () => {
    let version = "2026.10.4";
    const clawCmd = vi.fn(async () => ok("Usage: openclaw approvals [options] [command]"));
    const caps = createOpenclawCapabilities({ clawCmd, getInstalledVersion: () => version });
    expect(await caps.get("execApprovalsCli")).toBe(true);
    expect(await caps.get("execApprovalsCli")).toBe(true);
    expect(clawCmd).toHaveBeenCalledTimes(1);
    expect(clawCmd).toHaveBeenCalledWith("approvals --help", expect.objectContaining({ quiet: true }));
    version = "2026.10.5";
    await caps.get("execApprovalsCli");
    expect(clawCmd).toHaveBeenCalledTimes(2);
  });

  it("execApprovalsCli classifies an unknown command as unsupported", async () => {
    const caps = createOpenclawCapabilities({
      clawCmd: vi.fn(async () => fail("", "unknown command 'approvals'")),
      getInstalledVersion: () => "old",
    });
    expect(await caps.get("execApprovalsCli")).toBe(false);
  });

  it("explicit invalidation forces a fresh probe", async () => {
    const clawCmd = vi.fn(async () => ok("Usage: ..."));
    const caps = createOpenclawCapabilities({ clawCmd, getInstalledVersion: () => "v" });
    await caps.get("execApprovalsCli");
    caps.invalidate("execApprovalsCli");
    await caps.get("execApprovalsCli");
    caps.invalidate();
    await caps.get("execApprovalsCli");
    expect(clawCmd).toHaveBeenCalledTimes(3);
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
    expect(await caps.get("execApprovalsCli")).toBe(false);
    await caps.get("execApprovalsCli");
    expect(clawCmd).toHaveBeenCalledTimes(1);
    clock += kNegativeTtlMs + 1;
    await caps.get("execApprovalsCli");
    expect(clawCmd).toHaveBeenCalledTimes(2);
  });

  it("re-probes a TIMED-OUT result on a shorter TTL than a plain negative", async () => {
    let clock = 0;
    const clawCmd = vi.fn(async () => ({ ok: false, stdout: "", stderr: "", timedOut: true }));
    const caps = createOpenclawCapabilities({
      clawCmd,
      getInstalledVersion: () => "v",
      nowFn: () => clock,
      logger: { warn: () => {} },
    });
    expect(await caps.get("execApprovalsSqlite")).toBe("unknown");
    clock += kTimedOutTtlMs - 1;
    await caps.get("execApprovalsSqlite");
    expect(clawCmd).toHaveBeenCalledTimes(1);
    clock += 2;
    await caps.get("execApprovalsSqlite");
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
