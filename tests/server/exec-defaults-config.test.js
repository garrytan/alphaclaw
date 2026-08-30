const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  ensureManagedExecDefaults,
  ensureManagedExecApprovalsDefaults,
  detectSqliteExecApprovals,
  mergeStrayLegacyExecApprovals,
  reapStrayLegacyExecApprovals,
} = require("../../lib/server/exec-defaults-config");
const { kOpenclawStateDbPath } = require("../../lib/server/openclaw-state-db");

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-exec-defaults-test-"));

// State-db fixture with the REAL exec_approvals_config shape. Crucial nuance
// (the v0.9.43 regression): the pinned 2026.7.1-2 eagerly creates this table
// EMPTY in every state db — only the sqlite era (>= 2026.9.1-beta.1) ever
// writes a row. `withRow: false` therefore models a pinned-version box.
const createExecApprovalsStateDb = (openclawDir, { withRow = false } = {}) => {
  const databasePath = path.join(openclawDir, kOpenclawStateDbPath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(
    "CREATE TABLE exec_approvals_config (config_key TEXT NOT NULL PRIMARY KEY, raw_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL DEFAULT 0)",
  );
  if (withRow) {
    db.prepare(
      "INSERT INTO exec_approvals_config (config_key, raw_json, updated_at_ms) VALUES ('current', '{}', 1)",
    ).run();
  }
  db.close();
  return databasePath;
};

// Era resolver fakes (production wires openclaw-state-era's resolver).
const backendResolver = (backend, { reapAllowed = false, signal = "test" } = {}) =>
  async () => ({ backend, signal, reapAllowed });

const quietLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("server/exec-defaults-config", () => {
  it("fills missing managed exec defaults for openclaw.json and exec-approvals.json on a file-era box", async () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify(
        {
          tools: {
            profile: "full",
          },
          channels: {
            telegram: { enabled: true },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      resolveExecApprovalsBackend: backendResolver("file"),
      logger: quietLogger(),
    });

    expect(result).toMatchObject({
      changed: true,
      openclawChanged: true,
      approvalsChanged: true,
      approvalsBackend: "file",
    });

    const openclawConfig = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    // The seed uses tools.exec.mode — valid on BOTH the pinned 2026.7.1-2 and
    // the 2026.9.x beta, where the old security/ask pair is legacy-flagged.
    expect(openclawConfig.tools).toEqual({
      profile: "full",
      exec: {
        mode: "full",
        strictInlineEval: false,
      },
    });
    expect(openclawConfig.channels.telegram).toEqual({ enabled: true });

    const approvals = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "exec-approvals.json"), "utf8"),
    );
    expect(approvals).toEqual({
      version: 1,
      defaults: {
        security: "full",
        ask: "off",
        askFallback: "full",
      },
      agents: {},
    });
  });

  it("preserves existing exec settings when they are already configured", async () => {
    const openclawDir = createTempOpenclawDir();
    const openclawPath = path.join(openclawDir, "openclaw.json");
    const approvalsPath = path.join(openclawDir, "exec-approvals.json");
    const openclawContent = JSON.stringify(
      {
        tools: {
          profile: "full",
          exec: {
            host: "node",
            node: "mac-1",
            security: "allowlist",
            ask: "always",
            strictInlineEval: true,
          },
        },
      },
      null,
      2,
    );
    const approvalsContent =
      JSON.stringify(
        {
          version: 1,
          defaults: {
            security: "allowlist",
            ask: "always",
            askFallback: "deny",
          },
          agents: {
            main: {
              security: "allowlist",
            },
          },
        },
        null,
        2,
      ) + "\n";
    fs.writeFileSync(openclawPath, openclawContent, "utf8");
    fs.writeFileSync(approvalsPath, approvalsContent, "utf8");

    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      resolveExecApprovalsBackend: backendResolver("file"),
      logger: quietLogger(),
    });

    expect(result).toMatchObject({
      changed: false,
      openclawChanged: false,
      approvalsChanged: false,
    });
    expect(fs.readFileSync(openclawPath, "utf8")).toBe(openclawContent);
    expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsContent);
  });

  it("does not add or change openclaw exec subkeys when tools.exec already exists", async () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify(
        {
          tools: {
            profile: "full",
            exec: {
              host: "gateway",
              ask: "off",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      resolveExecApprovalsBackend: backendResolver("file"),
      logger: quietLogger(),
    });

    expect(result).toMatchObject({
      changed: true,
      openclawChanged: false,
      approvalsChanged: true,
    });

    const openclawConfig = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    expect(openclawConfig.tools.exec).toEqual({
      host: "gateway",
      ask: "off",
    });
  });

  it("does not add or change exec approvals defaults when defaults is a non-empty object", async () => {
    const openclawDir = createTempOpenclawDir();
    const openclawPath = path.join(openclawDir, "openclaw.json");
    const approvalsPath = path.join(openclawDir, "exec-approvals.json");
    const openclawContent = JSON.stringify(
      {
        tools: {
          profile: "full",
          exec: {
            host: "gateway",
          },
        },
      },
      null,
      2,
    );
    const approvalsContent =
      JSON.stringify(
        {
          socket: {
            path: "/data/.openclaw/exec-approvals.sock",
            token: "",
          },
          defaults: {
            ask: "always",
          },
        },
        null,
        2,
      ) + "\n";
    fs.writeFileSync(openclawPath, openclawContent, "utf8");
    fs.writeFileSync(approvalsPath, approvalsContent, "utf8");

    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      resolveExecApprovalsBackend: backendResolver("file"),
      logger: quietLogger(),
    });

    expect(result).toMatchObject({
      changed: false,
      openclawChanged: false,
      approvalsChanged: false,
    });
    expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsContent);
  });

  it("guarantees the agents shape on the returned file without marking it changed", () => {
    // Non-empty defaults skip the seed branch, which used to be the only
    // place that normalized `agents` — the returned document could carry a
    // missing/array agents field. Shape-normalization alone must never flag
    // `changed` (that would rewrite byte-identical files on every boot).
    const ensured = ensureManagedExecApprovalsDefaults({
      version: 1,
      defaults: { ask: "always" },
    });
    expect(ensured.changed).toBe(false);
    expect(ensured.file.agents).toEqual({});
  });

  it("never creates exec-approvals.json on a sqlite-era box", async () => {
    const openclawDir = createTempOpenclawDir();
    createExecApprovalsStateDb(openclawDir, { withRow: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ tools: { profile: "full" } }, null, 2),
      "utf8",
    );

    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      resolveExecApprovalsBackend: backendResolver("sqlite"),
      logger: quietLogger(),
    });

    // The openclaw.json half still seeds; the legacy approvals file must not
    // be created — its existence breaks the sqlite-era gateway (issue #23).
    expect(result).toMatchObject({
      changed: true,
      openclawChanged: true,
      approvalsChanged: false,
      approvalsBackend: "sqlite",
    });
    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json"))).toBe(
      false,
    );
  });

  it("fails closed on file creation when the era is indeterminate", async () => {
    // A broken/timed-out probe on a possibly-beta box must not write the
    // legacy file (creating it there is the outage). Skipping the seed on a
    // real file-era box is harmless — old openclaw self-seeds.
    const openclawDir = createTempOpenclawDir();
    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      resolveExecApprovalsBackend: backendResolver("indeterminate"),
      logger: quietLogger(),
    });
    expect(result.approvalsChanged).toBe(false);
    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json"))).toBe(
      false,
    );
  });

  it("[REG v0.9.43] a pinned-version box (table without rows) is FILE-era: seeds normally, never reaps", async () => {
    // The v0.9.43 detector keyed on table EXISTENCE and misclassified every
    // pinned box as sqlite-era — skipping the seeding and renaming away the
    // LIVE approvals file each boot. Table-without-row must mean file era.
    const openclawDir = createTempOpenclawDir();
    createExecApprovalsStateDb(openclawDir, { withRow: false });
    const legacyPath = path.join(openclawDir, "exec-approvals.json");
    const liveContent =
      JSON.stringify(
        {
          version: 1,
          socket: { path: "/x.sock", token: "tok" },
          defaults: { security: "full", ask: "off", askFallback: "full" },
          agents: { "*": { allowlist: [{ pattern: "ls *", id: "a" }] } },
        },
        null,
        2,
      ) + "\n";
    fs.writeFileSync(legacyPath, liveContent, "utf8");

    expect(detectSqliteExecApprovals({ fsModule: fs, openclawDir })).toBe(false);

    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      resolveExecApprovalsBackend: backendResolver("file"),
      logger: quietLogger(),
    });
    expect(result.reaped).toBe(false);
    // The live file survives byte-identical — defaults already managed.
    expect(fs.readFileSync(legacyPath, "utf8")).toBe(liveContent);
  });

  it("detects the sqlite era by ROW presence, not table presence", () => {
    const tableOnly = createTempOpenclawDir();
    createExecApprovalsStateDb(tableOnly, { withRow: false });
    expect(detectSqliteExecApprovals({ fsModule: fs, openclawDir: tableOnly })).toBe(false);

    const withRow = createTempOpenclawDir();
    createExecApprovalsStateDb(withRow, { withRow: true });
    expect(detectSqliteExecApprovals({ fsModule: fs, openclawDir: withRow })).toBe(true);

    const noDb = createTempOpenclawDir();
    expect(detectSqliteExecApprovals({ fsModule: fs, openclawDir: noDb })).toBe(false);
  });
});

describe("server/exec-defaults-config stray reaper", () => {
  it("renames a stray legacy file out of the way when the caller's era decision allows it", () => {
    const openclawDir = createTempOpenclawDir();
    createExecApprovalsStateDb(openclawDir, { withRow: true });
    const legacyPath = path.join(openclawDir, "exec-approvals.json");
    const legacyContent = JSON.stringify({ version: 1, agents: {} }, null, 2);
    fs.writeFileSync(legacyPath, legacyContent, "utf8");
    const logger = quietLogger();

    const result = reapStrayLegacyExecApprovals({
      fsModule: fs,
      openclawDir,
      logger,
      nowFn: () => 1712345678901,
      reapAllowed: true,
    });

    const strayPath = `${legacyPath}.stray-1712345678901`;
    expect(result).toEqual({ reaped: true, strayPath });
    // Renamed, never deleted: the content survives verbatim.
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.readFileSync(strayPath, "utf8")).toBe(legacyContent);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(strayPath),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("never reaps without an explicit era decision — row presence alone is historical state", () => {
    // A restored backup or a forced downgrade can leave a sqlite row next to
    // a live file the old runtime still needs; only row + sqlite-era hint
    // (the caller's reapAllowed) may rename it.
    const openclawDir = createTempOpenclawDir();
    createExecApprovalsStateDb(openclawDir, { withRow: true });
    const legacyPath = path.join(openclawDir, "exec-approvals.json");
    fs.writeFileSync(legacyPath, JSON.stringify({ version: 1 }), "utf8");
    const logger = quietLogger();

    const result = reapStrayLegacyExecApprovals({
      fsModule: fs,
      openclawDir,
      logger,
    });

    expect(result).toEqual({ reaped: false });
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("is a no-op when the legacy file does not exist", () => {
    const openclawDir = createTempOpenclawDir();
    createExecApprovalsStateDb(openclawDir, { withRow: true });

    const result = reapStrayLegacyExecApprovals({
      fsModule: fs,
      openclawDir,
      reapAllowed: true,
    });

    expect(result).toEqual({ reaped: false });
  });

  it("[REG #23] sqlite-era boot reaps a stray file once and never resurrects it", async () => {
    const openclawDir = createTempOpenclawDir();
    createExecApprovalsStateDb(openclawDir, { withRow: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ tools: {} }, null, 2),
      "utf8",
    );
    // Box poisoned by an older alphaclaw: the legacy file is present.
    const legacyPath = path.join(openclawDir, "exec-approvals.json");
    fs.writeFileSync(legacyPath, JSON.stringify({ version: 1 }, null, 2), "utf8");
    const logger = quietLogger();

    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      resolveExecApprovalsBackend: backendResolver("sqlite", { reapAllowed: true }),
      logger,
      nowFn: () => 42,
    });

    expect(result.reaped).toBe(true);
    expect(result.approvalsChanged).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(`${legacyPath}.stray-42`)).toBe(true);
  });

  it("sqlite-era boot with an INDETERMINATE hint neither reaps nor writes", async () => {
    const openclawDir = createTempOpenclawDir();
    createExecApprovalsStateDb(openclawDir, { withRow: true });
    const legacyPath = path.join(openclawDir, "exec-approvals.json");
    fs.writeFileSync(legacyPath, JSON.stringify({ version: 1 }), "utf8");

    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      // Row present but the version hint could not be resolved this boot.
      resolveExecApprovalsBackend: backendResolver("sqlite", { reapAllowed: false }),
      logger: quietLogger(),
    });

    expect(result.reaped).toBe(false);
    expect(result.approvalsChanged).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });
});

describe("server/exec-defaults-config stray-merge remediation", () => {
  it("recovers allowlists across ALL strays (oldest carries the original) and the oldest socket token", () => {
    // v0.9.43 boots stacked strays: boot 1 renamed the ORIGINAL file, openclaw
    // re-seeded a default, boot 2 renamed THAT. Newest-only recovery would
    // recover nothing.
    const openclawDir = createTempOpenclawDir();
    const original = {
      version: 1,
      socket: { path: "/x.sock", token: "original-token" },
      defaults: { security: "full", ask: "off", askFallback: "full" },
      agents: {
        "*": {
          allowlist: [
            { pattern: "ls *", id: "a", lastUsedAt: 1 },
            { pattern: "git status", id: "b" },
          ],
        },
      },
    };
    const reseededDefault = {
      version: 1,
      defaults: { security: "full", ask: "off", askFallback: "deny" },
      agents: {},
    };
    fs.writeFileSync(
      path.join(openclawDir, "exec-approvals.json.stray-100"),
      JSON.stringify(original, null, 2),
      "utf8",
    );
    fs.writeFileSync(
      path.join(openclawDir, "exec-approvals.json.stray-200"),
      JSON.stringify(reseededDefault, null, 2),
      "utf8",
    );
    const logger = quietLogger();

    const result = mergeStrayLegacyExecApprovals({
      fsModule: fs,
      openclawDir,
      logger,
    });

    expect(result.merged).toBe(true);
    expect(result.recoveredEntries).toBe(2);
    const live = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "exec-approvals.json"), "utf8"),
    );
    expect(live.socket).toEqual({ path: "/x.sock", token: "original-token" });
    expect(live.agents["*"].allowlist.map((e) => e.pattern)).toEqual([
      "ls *",
      "git status",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Recovered 2"));
    // Strays are marked processed (renamed, never deleted) — idempotent boots.
    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json.stray-100"))).toBe(false);
    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json.stray-100.merged"))).toBe(true);
    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json.stray-200.merged"))).toBe(true);

    // Second run: nothing left to merge.
    const again = mergeStrayLegacyExecApprovals({ fsModule: fs, openclawDir, logger });
    expect(again).toEqual({ merged: false, strays: 0 });
  });

  it("merges into an existing live file without duplicating entries or clobbering its socket", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        socket: { path: "/live.sock", token: "live-token" },
        defaults: { security: "full", ask: "off", askFallback: "full" },
        agents: { "*": { allowlist: [{ pattern: "ls *", id: "live" }] } },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(openclawDir, "exec-approvals.json.stray-100"),
      JSON.stringify({
        version: 1,
        socket: { path: "/stray.sock", token: "stray-token" },
        agents: {
          "*": { allowlist: [{ pattern: "ls *", id: "dup" }, { pattern: "cat *", id: "new" }] },
        },
      }),
      "utf8",
    );

    const result = mergeStrayLegacyExecApprovals({
      fsModule: fs,
      openclawDir,
      logger: quietLogger(),
    });

    expect(result.merged).toBe(true);
    expect(result.recoveredEntries).toBe(1);
    const live = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "exec-approvals.json"), "utf8"),
    );
    expect(live.socket.token).toBe("live-token");
    expect(live.agents["*"].allowlist.map((e) => e.pattern)).toEqual(["ls *", "cat *"]);
  });

  it("file-era boot runs the remediation before seeding", async () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "exec-approvals.json.stray-7"),
      JSON.stringify({
        version: 1,
        agents: { "*": { allowlist: [{ pattern: "make *", id: "m" }] } },
      }),
      "utf8",
    );

    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      resolveExecApprovalsBackend: backendResolver("file"),
      logger: quietLogger(),
    });

    expect(result.approvalsBackend).toBe("file");
    const live = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "exec-approvals.json"), "utf8"),
    );
    expect(live.agents["*"].allowlist.map((e) => e.pattern)).toEqual(["make *"]);
    // Seeding still applied the managed defaults after the merge.
    expect(live.defaults).toEqual({ security: "full", ask: "off", askFallback: "full" });
  });
});
