const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const {
  resolveOpenclawStateDbPath,
  openWritableOpenclawStateDb,
  hasTable,
} = require("./openclaw-state-db");

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
//
// "absent" and "mismatch" are deliberately distinct: an absent table is the
// normal file-era state (silent no-op), while an EXISTING table whose columns
// changed means upstream reshaped its schema under us — that must warn and
// read as "unsupported", never as success.
const tableSchemaState = (db, tableName, columns, logger = console) => {
  if (!kIdentifier.test(tableName)) return "mismatch";
  if (!hasTable(db, tableName)) return "absent";
  const rows = db.prepare(`PRAGMA table_info("${tableName}")`).all();
  const present = new Set(rows.map((row) => String(row.name)));
  if (columns.every((column) => present.has(column))) return "ok";
  warnOnce(
    logger,
    `schema-${tableName}`,
    `[alphaclaw] openclaw table "${tableName}" exists but is missing expected column(s) ${columns.filter((c) => !present.has(c)).join(", ")} — treating it as unsupported (upstream schema changed)`,
  );
  return "mismatch";
};

const tableHasColumns = (db, tableName, columns, logger = console) =>
  tableSchemaState(db, tableName, columns, logger) === "ok";

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

// ── Relocated shared auth store (>= 2026.9.1-beta.1) ─────────────────────────
//
// The beta's doctor --fix moves the MAIN agent's auth rows from the agent db
// (key 'primary') into state/openclaw.sqlite (auth_profile_stores /
// auth_profile_state, key 'shared') and flips this machine-state row. The
// flag — migration completion — is the ONLY authority for which store the
// runtime reads; a version or capability signal must never flip the auth
// backend (split-brain). "unreadable" (db present but unopenable, e.g. a
// transient lock) is distinct from "legacy": readers may fall back to the
// agent db, writers must fail closed.
const readAuthSharedStoreLocation = ({ fsModule = fs, openclawDir, logger = console } = {}) => {
  try {
    const databasePath = resolveOpenclawStateDbPath({ openclawDir });
    if (typeof fsModule.existsSync !== "function" || !fsModule.existsSync(databasePath)) {
      return "legacy";
    }
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      // config_machine_state only exists on the beta schema; its absence on
      // an older state db is a definitive "legacy".
      if (!tableHasColumns(db, "config_machine_state", ["state_key", "value_json"])) {
        return "legacy";
      }
      const row = db
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get("auth.sharedStore");
      if (!row?.value_json) return "legacy";
      const value = JSON.parse(row.value_json);
      return value?.location === "state-db" ? "state-db" : "legacy";
    } finally {
      db.close();
    }
  } catch (error) {
    warnOnce(
      logger,
      "auth-shared-store-flag",
      `[alphaclaw] could not read the auth.sharedStore machine state (${error.message || error}) — reads fall back to the agent db, writes fail closed`,
    );
    return "unreadable";
  }
};

// ── Channel pairing store (sqlite on the beta; files pre-import) ─────────────
//
// The beta's gateway startup imports credentials/<ch>-pairing.json and
// *-allowFrom.json into these tables and DELETES the files, so readers union
// both sources (at most one carries data outside the brief import window —
// no era hint needed, and notification targets can never come up empty
// because of a transient probe failure). Mutations are the documented
// direct-write exception: neither version ships a pairing reject/cleanup CLI.
const normalizePairingAccountId = (value) =>
  String(value || "").trim().toLowerCase() || "default";

const kAllowEntryColumns = ["channel_key", "account_id", "entry"];
const kPairingRequestColumns = ["channel_key", "account_id", "request_id", "code"];

// Map<accountId, Set<entry>> from channel_pairing_allow_entries.
const readChannelAllowEntriesByAccount = ({
  fsModule = fs,
  openclawDir,
  channel,
  logger = console,
} = {}) =>
  withReadonlyStateDb(
    { fsModule, openclawDir, logger },
    "channel-allow-entries",
    (db) => {
      const map = new Map();
      if (!tableHasColumns(db, "channel_pairing_allow_entries", kAllowEntryColumns)) {
        return map;
      }
      const rows = db
        .prepare(
          "SELECT account_id, entry FROM channel_pairing_allow_entries WHERE channel_key = ?",
        )
        .all(String(channel || "").trim().toLowerCase());
      for (const row of rows) {
        const accountId = normalizePairingAccountId(row.account_id);
        const entry = String(row.entry || "").trim();
        if (!entry) continue;
        if (!map.has(accountId)) map.set(accountId, new Set());
        map.get(accountId).add(entry);
      }
      return map;
    },
    new Map(),
  );

// Deletes a pending pairing request by its user-facing code. Returns
// { ok: true, deleted } or { ok: false, error } — a failure (locked db)
// must surface as retryable to the caller, never be guessed around.
const deletePairingRequestByCode = ({
  openclawDir,
  channel,
  code,
  accountId = "",
  logger = console,
} = {}) => {
  let opened = null;
  try {
    opened = openWritableOpenclawStateDb({ openclawDir });
    if (!opened) return { ok: true, deleted: 0 };
    const schema = tableSchemaState(
      opened.db,
      "channel_pairing_requests",
      kPairingRequestColumns,
      logger,
    );
    if (schema === "absent") return { ok: true, deleted: 0 };
    if (schema === "mismatch") {
      return { ok: false, error: "channel_pairing_requests schema is unsupported (upstream changed it)" };
    }
    const normalizedChannel = String(channel || "").trim().toLowerCase();
    const normalizedCode = String(code || "").trim();
    const normalizedAccountId = String(accountId || "").trim().toLowerCase();
    const statement = normalizedAccountId
      ? opened.db.prepare(
          "DELETE FROM channel_pairing_requests WHERE channel_key = ? AND UPPER(code) = UPPER(?) AND account_id = ?",
        )
      : opened.db.prepare(
          "DELETE FROM channel_pairing_requests WHERE channel_key = ? AND UPPER(code) = UPPER(?)",
        );
    const result = normalizedAccountId
      ? statement.run(normalizedChannel, normalizedCode, normalizedAccountId)
      : statement.run(normalizedChannel, normalizedCode);
    return { ok: true, deleted: Number(result?.changes || 0) };
  } catch (error) {
    logger.warn?.(
      `[alphaclaw] could not delete pairing request from the state db: ${error.message || error}`,
    );
    return { ok: false, error: error.message || String(error) };
  } finally {
    try {
      opened?.db?.close();
    } catch {}
  }
};

// Best-effort cleanup for account deletion / imported-pairing clearing:
// removes an account's allow entries and pending requests. On a file-era box
// the tables are empty and this is a no-op.
const deleteChannelPairingRows = ({
  openclawDir,
  channel,
  accountId = null,
  logger = console,
} = {}) => {
  let opened = null;
  try {
    opened = openWritableOpenclawStateDb({ openclawDir });
    if (!opened) return { ok: true, allowEntriesDeleted: 0, requestsDeleted: 0 };
    const normalizedChannel = String(channel || "").trim().toLowerCase();
    const normalizedAccountId =
      accountId == null ? null : normalizePairingAccountId(accountId);
    let allowEntriesDeleted = 0;
    let requestsDeleted = 0;
    const allowSchema = tableSchemaState(
      opened.db,
      "channel_pairing_allow_entries",
      kAllowEntryColumns,
      logger,
    );
    const requestSchema = tableSchemaState(
      opened.db,
      "channel_pairing_requests",
      kPairingRequestColumns,
      logger,
    );
    if (allowSchema === "mismatch" || requestSchema === "mismatch") {
      return { ok: false, error: "pairing tables schema is unsupported (upstream changed it)" };
    }
    if (allowSchema === "ok") {
      const statement = normalizedAccountId
        ? opened.db.prepare(
            "DELETE FROM channel_pairing_allow_entries WHERE channel_key = ? AND account_id = ?",
          )
        : opened.db.prepare(
            "DELETE FROM channel_pairing_allow_entries WHERE channel_key = ?",
          );
      const result = normalizedAccountId
        ? statement.run(normalizedChannel, normalizedAccountId)
        : statement.run(normalizedChannel);
      allowEntriesDeleted = Number(result?.changes || 0);
    }
    if (requestSchema === "ok") {
      const statement = normalizedAccountId
        ? opened.db.prepare(
            "DELETE FROM channel_pairing_requests WHERE channel_key = ? AND account_id = ?",
          )
        : opened.db.prepare(
            "DELETE FROM channel_pairing_requests WHERE channel_key = ?",
          );
      const result = normalizedAccountId
        ? statement.run(normalizedChannel, normalizedAccountId)
        : statement.run(normalizedChannel);
      requestsDeleted = Number(result?.changes || 0);
    }
    return { ok: true, allowEntriesDeleted, requestsDeleted };
  } catch (error) {
    logger.warn?.(
      `[alphaclaw] could not clear pairing rows from the state db: ${error.message || error}`,
    );
    return { ok: false, error: error.message || String(error) };
  } finally {
    try {
      opened?.db?.close();
    } catch {}
  }
};

module.exports = {
  kSqliteEra,
  kFileEra,
  kIndeterminate,
  createStateEra,
  hasExecApprovalsRow,
  tableHasColumns,
  tableSchemaState,
  readAuthSharedStoreLocation,
  readChannelAllowEntriesByAccount,
  deletePairingRequestByCode,
  deleteChannelPairingRows,
  normalizePairingAccountId,
};
