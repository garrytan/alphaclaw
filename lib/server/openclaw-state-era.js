const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { resolveOpenclawStateDbPath, hasTable } = require("./openclaw-state-db");

// OpenClaw "state era" detection — the shared answer to "does the installed
// OpenClaw keep this state in SQLite (>= 2026.9.1-beta.1) or in legacy files?"
//
// Why this module exists (issue #23 + the v0.9.43 regression): neither the
// state DB's existence nor a table's existence discriminates versions —
// 2026.7.1-2 eagerly creates EVERY schema table (including
// exec_approvals_config) at user_version=1 and then never writes a row. The
// signals that do work, combined here:
//
//   state signal   a ROW in exec_approvals_config (only the sqlite era writes
//                  one) — one-way-correct evidence about the state dir, but
//                  historical: it survives backup-restores and downgrades, so
//                  it must never authorize destructive actions alone.
//   version gate   installed version >= 2026.9.1-beta.1 — conclusive in BOTH
//                  directions when a version is known; null on dev builds.
//   CLI probe      `approvals --help` lists the `pending` subcommand only on
//                  the sqlite era. Probing the PARENT help is load-bearing:
//                  commander 15 prints the parent help and exits 0 for an
//                  unknown subcommand + --help, so `approvals pending --help`
//                  would return true on both eras.
//
// The composed hint is tri-state (sqlite-era | file-era | indeterminate) and
// consumers pick their fail-closed direction per operation: creating the
// legacy file requires a DETERMINATE file-era answer; renaming it away
// requires the row AND a sqlite-era hint.
const kSqliteEra = "sqlite-era";
const kFileEra = "file-era";
const kIndeterminate = "indeterminate";

const kIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Warn once per (process, key): detector failures must be visible, but the
// row check runs on every boot and must not spam a wedged box's logs.
const warnedKeys = new Set();
const warnOnce = (logger, key, message) => {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  logger?.warn?.(message);
};

// Schema guard: direct access to openclaw's private tables is only safe when
// the table still has the columns we read/write — a future schema change must
// degrade to "unsupported" (fail closed), never to a bad query against a
// reshaped table. Table names come from internal constants only (identifier
// check because PRAGMA cannot be parameterized).
const tableHasColumns = (db, tableName, columns) => {
  if (!kIdentifier.test(tableName)) return false;
  if (!hasTable(db, tableName)) return false;
  const rows = db.prepare(`PRAGMA table_info("${tableName}")`).all();
  const present = new Set(rows.map((row) => String(row.name)));
  return columns.every((column) => present.has(column));
};

// The injected fsModule answers "is there a state db" so memory-fs harnesses
// can steer the answer; the actual queries need a real DatabaseSync (same
// contract as the v0.9.43 detector). Any error degrades to `fallback` with a
// once-per-process warning — never silently.
const withReadonlyStateDb = ({ fsModule = fs, openclawDir, logger = console }, key, fn, fallback) => {
  try {
    const databasePath = resolveOpenclawStateDbPath({ openclawDir });
    if (typeof fsModule.existsSync !== "function" || !fsModule.existsSync(databasePath)) {
      return fallback;
    }
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch (error) {
    warnOnce(
      logger,
      key,
      `[alphaclaw] openclaw state-db check "${key}" failed (${error.message || error}) — treating as ${JSON.stringify(fallback)}`,
    );
    return fallback;
  }
};

// TRUE only when the sqlite era actually recorded exec approvals (a row, not
// the eagerly-created empty table).
const hasExecApprovalsRow = ({ fsModule = fs, openclawDir, logger = console } = {}) =>
  withReadonlyStateDb(
    { fsModule, openclawDir, logger },
    "exec-approvals-row",
    (db) => {
      if (!tableHasColumns(db, "exec_approvals_config", ["config_key", "raw_json"])) {
        return false;
      }
      return !!db.prepare("SELECT 1 AS present FROM exec_approvals_config LIMIT 1").get();
    },
    false,
  );

const createStateEra = ({
  openclawDir,
  fsModule = fs,
  // async (key) => probe value; wired to openclawCapabilities.get. The
  // execApprovalsSqlite probe answers "sqlite" | "file" | "unknown".
  getCapability = null,
  // () => ({ version, features }); wired to openclawFeatureGates.features.
  gatesInfo = null,
  logger = console,
} = {}) => {
  // Per-boot memo: the hint can cost a CLI spawn; consumers may ask often.
  let hintPromise = null;

  const resolveEraHint = () => {
    hintPromise ||= (async () => {
      // 1) Version gate — conclusive in both directions when a version is
      //    known (a known version below the floor IS a determinate file era).
      try {
        const info = typeof gatesInfo === "function" ? gatesInfo() : null;
        if (info && info.version) {
          return {
            hint: info.features?.execApprovalsSqlite ? kSqliteEra : kFileEra,
            signal: "gate",
          };
        }
      } catch (error) {
        warnOnce(logger, "era-gate", `[alphaclaw] state-era gate check failed: ${error.message || error}`);
      }
      // 2) CLI probe — covers dev builds (gates fail closed on a sha).
      try {
        if (typeof getCapability === "function") {
          const probed = await getCapability("execApprovalsSqlite");
          if (probed === "sqlite") return { hint: kSqliteEra, signal: "probe" };
          if (probed === "file") return { hint: kFileEra, signal: "probe" };
        }
      } catch (error) {
        warnOnce(logger, "era-probe", `[alphaclaw] state-era probe failed: ${error.message || error}`);
      }
      return { hint: kIndeterminate, signal: "indeterminate" };
    })();
    return hintPromise;
  };

  // The one decision exec-approvals consumers act on. `backend` says where
  // managed writes belong; `reapAllowed` additionally requires the ACTIVE
  // runtime to be sqlite-era before the legacy file may be renamed away —
  // row presence alone is historical state (backup restores, downgrades).
  const resolveExecApprovalsBackend = async () => {
    const rowPresent = hasExecApprovalsRow({ fsModule, openclawDir, logger });
    const { hint, signal } = await resolveEraHint();
    if (rowPresent) {
      return {
        backend: "sqlite",
        signal: "row",
        hint,
        hintSignal: signal,
        rowPresent,
        reapAllowed: hint === kSqliteEra,
      };
    }
    if (hint === kSqliteEra) {
      return { backend: "sqlite", signal, hint, hintSignal: signal, rowPresent, reapAllowed: false };
    }
    if (hint === kFileEra) {
      return { backend: "file", signal, hint, hintSignal: signal, rowPresent, reapAllowed: false };
    }
    return {
      backend: "indeterminate",
      signal: "indeterminate",
      hint,
      hintSignal: signal,
      rowPresent,
      reapAllowed: false,
    };
  };

  // The hint is version-derived; drop the memo whenever the installed
  // version may have changed (callers hook this beside capability
  // invalidation).
  const invalidate = () => {
    hintPromise = null;
  };

  return {
    resolveEraHint,
    resolveExecApprovalsBackend,
    hasExecApprovalsRow: () => hasExecApprovalsRow({ fsModule, openclawDir, logger }),
    invalidate,
  };
};

module.exports = {
  kSqliteEra,
  kFileEra,
  kIndeterminate,
  createStateEra,
  hasExecApprovalsRow,
  tableHasColumns,
};
