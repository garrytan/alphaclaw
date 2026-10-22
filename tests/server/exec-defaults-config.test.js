const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  ensureManagedExecDefaults,
  reapStrayLegacyExecApprovals,
} = require("../../lib/server/exec-defaults-config");
const { createStateEra } = require("../../lib/server/openclaw-state-era");
const { kOpenclawStateDbPath } = require("../../lib/server/openclaw-state-db");

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-exec-defaults-test-"));

// State-db fixture with the REAL exec_approvals_config shape. Crucial nuance
// (the v0.9.43 regression): the pinned 2026.7.1-2 eagerly creates this table
// EMPTY in every state db — only the sqlite era (>= 2026.9.1-beta.1) ever
// writes a row. `withRow: false` therefore models that empty table.
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
  it("fills missing openclaw.json exec defaults and never creates exec-approvals.json", async () => {
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
      resolveExecApprovalsBackend: backendResolver("sqlite"),
      logger: quietLogger(),
    });

    expect(result).toMatchObject({
      changed: true,
      openclawChanged: true,
      approvalsBackend: "sqlite",
      reaped: false,
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

    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json"))).toBe(false);
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
      resolveExecApprovalsBackend: backendResolver("sqlite"),
      logger: quietLogger(),
    });

    expect(result).toMatchObject({
      changed: false,
      openclawChanged: false,
      reaped: false,
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
      resolveExecApprovalsBackend: backendResolver("sqlite"),
      logger: quietLogger(),
    });

    expect(result).toMatchObject({
      changed: false,
      openclawChanged: false,
    });
    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json"))).toBe(false);

    const openclawConfig = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    expect(openclawConfig.tools.exec).toEqual({
      host: "gateway",
      ask: "off",
    });
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
      approvalsBackend: "sqlite",
    });
    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json"))).toBe(
      false,
    );
  });

  it("announces a reap through the notify hook with a per-file id (auto-fix coverage)", async () => {
    const openclawDir = createTempOpenclawDir();
    createExecApprovalsStateDb(openclawDir, { withRow: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ tools: { profile: "full" } }, null, 2),
      "utf8",
    );
    fs.writeFileSync(
      path.join(openclawDir, "exec-approvals.json"),
      JSON.stringify({ version: 1 }),
      "utf8",
    );
    const notify = vi.fn(async () => ({ ok: true }));

    await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      resolveExecApprovalsBackend: backendResolver("sqlite", {
        reapAllowed: true,
      }),
      logger: quietLogger(),
      nowFn: () => 1712345678901,
      notify,
    });

    // The stray file would fail the gateway closed — renaming it is a real
    // auto-fix and must announce itself. Per-file id: a re-created stray is a
    // new event; same-file boot loops dedupe in the outbox.
    const reapCall = notify.mock.calls.find((call) =>
      String(call?.[0] || "").includes("stray legacy exec-approvals.json"),
    );
    expect(reapCall).toBeTruthy();
    expect(reapCall[0]).toContain("exec-approvals.json.stray-1712345678901");
    expect(reapCall[1]).toEqual(
      expect.objectContaining({
        eventType: "recovery",
        id: "exec-approvals-reaped-exec-approvals.json.stray-1712345678901",
      }),
    );
  });

  it("a throwing notify hook never breaks the ensure step", async () => {
    const openclawDir = createTempOpenclawDir();
    createExecApprovalsStateDb(openclawDir, { withRow: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ tools: { profile: "full" } }, null, 2),
      "utf8",
    );
    fs.writeFileSync(
      path.join(openclawDir, "exec-approvals.json"),
      JSON.stringify({ version: 1 }),
      "utf8",
    );

    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      resolveExecApprovalsBackend: backendResolver("sqlite", {
        reapAllowed: true,
      }),
      logger: quietLogger(),
      notify: () => {
        throw new Error("notifier exploded");
      },
    });

    // Blanket rule: a notifier failure must never turn a successful cleanup
    // into a failed boot step.
    expect(result.changed).toBe(true);
    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json"))).toBe(
      false,
    );
  });

  it("a throwing or missing era resolver neither reaps nor writes the legacy file", async () => {
    for (const resolveExecApprovalsBackend of [
      async () => {
        throw new Error("state db locked");
      },
      null,
    ]) {
      const openclawDir = createTempOpenclawDir();
      createExecApprovalsStateDb(openclawDir, { withRow: true });
      const legacyPath = path.join(openclawDir, "exec-approvals.json");
      fs.writeFileSync(legacyPath, JSON.stringify({ version: 1 }), "utf8");
      const result = await ensureManagedExecDefaults({
        fsModule: fs,
        openclawDir,
        resolveExecApprovalsBackend,
        logger: quietLogger(),
      });
      expect(result.reaped).toBe(false);
      expect(fs.readFileSync(legacyPath, "utf8")).toBe(JSON.stringify({ version: 1 }));
    }
  });

  it("[REG v0.9.43] a table without rows never authorizes reaping the legacy file", async () => {
    // The v0.9.43 detector keyed on table EXISTENCE (2026.7.1-2 creates the
    // table empty) and renamed away the LIVE approvals file each boot. Only a
    // ROW is sqlite-era evidence; without one the file awaits doctor import.
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

    const era = createStateEra({ openclawDir, getInstalledVersion: () => "2026.10.4" });
    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      resolveExecApprovalsBackend: era.resolveExecApprovalsBackend,
      logger: quietLogger(),
    });
    expect(result.reaped).toBe(false);
    // The file survives byte-identical.
    expect(fs.readFileSync(legacyPath, "utf8")).toBe(liveContent);
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
    // a live file the old runtime still needs; only row + SQLite-era runtime
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
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(`${legacyPath}.stray-42`)).toBe(true);
  });

  it("a row without the resolver's reap decision neither reaps nor writes", async () => {
    const openclawDir = createTempOpenclawDir();
    createExecApprovalsStateDb(openclawDir, { withRow: true });
    const legacyPath = path.join(openclawDir, "exec-approvals.json");
    fs.writeFileSync(legacyPath, JSON.stringify({ version: 1 }), "utf8");

    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      // Row present but the runtime is not known to be on the SQLite era.
      resolveExecApprovalsBackend: backendResolver("sqlite", { reapAllowed: false }),
      logger: quietLogger(),
    });

    expect(result.reaped).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });
});

describe("server/exec-defaults-config with the real era resolver (refactor plan PR 16b)", () => {
  const legacyContent = JSON.stringify({ version: 1, agents: { "*": { allowlist: [{ pattern: "ls *" }] } } }, null, 2) + "\n";
  const bootFor = async ({ withRow, version, logger = quietLogger() }) => {
    const openclawDir = createTempOpenclawDir();
    if (withRow !== null) createExecApprovalsStateDb(openclawDir, { withRow });
    const legacyPath = path.join(openclawDir, "exec-approvals.json");
    fs.writeFileSync(legacyPath, legacyContent, "utf8");
    const era = createStateEra({ openclawDir, getInstalledVersion: () => version, logger });
    const result = await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      resolveExecApprovalsBackend: era.resolveExecApprovalsBackend,
      logger,
      nowFn: () => 7,
    });
    return { result, legacyPath };
  };

  it("row + the pinned SQLite-era runtime: the stray legacy file is renamed away", async () => {
    const { result, legacyPath } = await bootFor({ withRow: true, version: "2026.10.4" });
    expect(result).toMatchObject({ approvalsBackend: "sqlite", approvalsBackendSignal: "row", reaped: true });
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.readFileSync(`${legacyPath}.stray-7`, "utf8")).toBe(legacyContent);
  });

  it("row + an OLDER runtime (restored backup / forced downgrade): the live file survives byte-identical", async () => {
    const { result, legacyPath } = await bootFor({ withRow: true, version: "2026.7.1-2" });
    expect(result.reaped).toBe(false);
    expect(fs.readFileSync(legacyPath, "utf8")).toBe(legacyContent);
  });

  it("row + an UNKNOWN runtime (dev sha or unreadable version): the file survives byte-identical", async () => {
    for (const version of [null, "a1b2c3d"]) {
      const { result, legacyPath } = await bootFor({ withRow: true, version });
      expect(result.reaped).toBe(false);
      expect(fs.readFileSync(legacyPath, "utf8")).toBe(legacyContent);
    }
  });

  it("no row (a legacy file awaiting doctor import, or the empty eagerly-created table): never reaped", async () => {
    for (const withRow of [false, null]) {
      const { result, legacyPath } = await bootFor({ withRow, version: "2026.10.4" });
      expect(result).toMatchObject({ approvalsBackend: "sqlite", approvalsBackendSignal: "pin", reaped: false });
      expect(fs.readFileSync(legacyPath, "utf8")).toBe(legacyContent);
    }
  });
});
