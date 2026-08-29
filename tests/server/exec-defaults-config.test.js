const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  ensureManagedExecDefaults,
  ensureManagedExecApprovalsDefaults,
  detectSqliteExecApprovals,
  reapStrayLegacyExecApprovals,
} = require("../../lib/server/exec-defaults-config");
const { kOpenclawStateDbPath } = require("../../lib/server/openclaw-state-db");

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-exec-defaults-test-"));

// SQLite-era openclaw fixture: a real state db carrying the
// exec_approvals_config table (>= 2026.9.1-beta.1 stores exec approvals
// there and hard-fails while the legacy file exists).
const createExecApprovalsStateDb = (openclawDir) => {
  const databasePath = path.join(openclawDir, kOpenclawStateDbPath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE exec_approvals_config (id TEXT PRIMARY KEY, payload TEXT)");
  db.close();
  return databasePath;
};

describe("server/exec-defaults-config", () => {
  it("fills missing managed exec defaults for openclaw.json and exec-approvals.json on a file-era box", () => {
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

    const result = ensureManagedExecDefaults({ fsModule: fs, openclawDir });

    expect(result).toEqual({
      changed: true,
      openclawChanged: true,
      approvalsChanged: true,
    });

    const openclawConfig = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    expect(openclawConfig.tools).toEqual({
      profile: "full",
      exec: {
        security: "full",
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

  it("preserves existing exec settings when they are already configured", () => {
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

    const result = ensureManagedExecDefaults({ fsModule: fs, openclawDir });

    expect(result).toEqual({
      changed: false,
      openclawChanged: false,
      approvalsChanged: false,
    });
    expect(fs.readFileSync(openclawPath, "utf8")).toBe(openclawContent);
    expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsContent);
  });

  it("does not add or change openclaw exec subkeys when tools.exec already exists", () => {
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

    const result = ensureManagedExecDefaults({ fsModule: fs, openclawDir });

    expect(result).toEqual({
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

  it("does not add or change exec approvals defaults when defaults is a non-empty object", () => {
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

    const result = ensureManagedExecDefaults({ fsModule: fs, openclawDir });

    expect(result).toEqual({
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

  it("does not create exec-approvals.json on a sqlite-era box", () => {
    const openclawDir = createTempOpenclawDir();
    createExecApprovalsStateDb(openclawDir);
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ tools: { profile: "full" } }, null, 2),
      "utf8",
    );

    const result = ensureManagedExecDefaults({ fsModule: fs, openclawDir });

    // The openclaw.json half still seeds; the legacy approvals file must not
    // be created — its existence breaks the sqlite-era gateway (issue #23).
    expect(result).toEqual({
      changed: true,
      openclawChanged: true,
      approvalsChanged: false,
    });
    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json"))).toBe(
      false,
    );
  });

  it("keeps file-era behavior when the state db exists without the approvals table", () => {
    const openclawDir = createTempOpenclawDir();
    const databasePath = path.join(openclawDir, kOpenclawStateDbPath);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE cron_jobs (id TEXT PRIMARY KEY)");
    db.close();

    expect(detectSqliteExecApprovals({ fsModule: fs, openclawDir })).toBe(false);
    const result = ensureManagedExecDefaults({ fsModule: fs, openclawDir });
    expect(result.approvalsChanged).toBe(true);
    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json"))).toBe(
      true,
    );
  });
});

describe("server/exec-defaults-config stray reaper", () => {
  it("renames a stray legacy file out of the way on a sqlite-era box and logs", () => {
    const openclawDir = createTempOpenclawDir();
    createExecApprovalsStateDb(openclawDir);
    const legacyPath = path.join(openclawDir, "exec-approvals.json");
    const legacyContent = JSON.stringify({ version: 1, agents: {} }, null, 2);
    fs.writeFileSync(legacyPath, legacyContent, "utf8");
    const logger = { warn: vi.fn(), error: vi.fn() };

    const result = reapStrayLegacyExecApprovals({
      fsModule: fs,
      openclawDir,
      logger,
      nowFn: () => 1712345678901,
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

  it("leaves the legacy file alone on a file-era box", () => {
    const openclawDir = createTempOpenclawDir();
    const legacyPath = path.join(openclawDir, "exec-approvals.json");
    fs.writeFileSync(legacyPath, JSON.stringify({ version: 1 }), "utf8");
    const logger = { warn: vi.fn(), error: vi.fn() };

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
    createExecApprovalsStateDb(openclawDir);

    const result = reapStrayLegacyExecApprovals({ fsModule: fs, openclawDir });

    expect(result).toEqual({ reaped: false });
  });

  it("[REG #23] sqlite-era boot never writes exec-approvals.json and reaps a stray one", () => {
    const openclawDir = createTempOpenclawDir();
    createExecApprovalsStateDb(openclawDir);
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ tools: {} }, null, 2),
      "utf8",
    );
    // Box poisoned by an older alphaclaw: the legacy file is present.
    const legacyPath = path.join(openclawDir, "exec-approvals.json");
    fs.writeFileSync(legacyPath, JSON.stringify({ version: 1 }, null, 2), "utf8");
    const logger = { warn: vi.fn(), error: vi.fn() };

    // Boot order: the pre-server reaper (runtime-init, beside
    // migrateManagedInternalFiles) …
    const reaped = reapStrayLegacyExecApprovals({
      fsModule: fs,
      openclawDir,
      logger,
      nowFn: () => 42,
    });
    expect(reaped.reaped).toBe(true);

    // … then the onboarded boot sequence's first step must not resurrect it.
    const result = ensureManagedExecDefaults({ fsModule: fs, openclawDir });
    expect(result.approvalsChanged).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(`${legacyPath}.stray-42`)).toBe(true);
  });
});
