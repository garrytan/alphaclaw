const path = require("path");
const {
  kOpenclawReleaseChannels,
  readOpenclawMedicEnabled,
  readOpenclawOverseerEnabled,
  updateOpenclawMedicEnabled,
  updateOpenclawOverseerEnabled,
  updateOpenclawReleaseChannel,
} = require("../alphaclaw-config");
const { channelError } = require("../openclaw-channel-sync");
const { parseJsonValueFromNoisyOutput } = require("../utils/json");
const {
  kOpenclawSqliteBackupDir,
  kOpenclawBackupTimeoutMs,
} = require("../constants");
const { resolveWhatsNew } = require("../openclaw-whats-new");

// Semver-shaped only: catalog membership is the real gate, but the format
// check alone must already exclude traversal-shaped input ("..", ".") that
// would otherwise reach overlay filesystem paths.
const kVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const kVersionMaxLength = 64;
const kShaPattern = /^[0-9a-f]{7,40}$/;
// How long to wait for a synchronous outcome (noop, validation/gate failure)
// before handing the client an operation id to stream instead.
const kQuickResultWindowMs = 400;

// Verified `backup sqlite` contract (openclaw 2026.8.1 beta): `create`
// accepts ONLY --global/--agent <id>/--repository (required)/--json — there
// is no --verify flag (an unknown option fails the whole run) and no --all:
// each invocation snapshots exactly ONE database, either the shared global
// state DB or one per-agent DB (per-agent DBs hold that agent's sessions and
// auth profiles). Verification is a separate `backup sqlite verify
// <snapshotPath>` against the exact snapshot the create reported (create
// --json emits `{ ok, snapshotPath, manifest }`). Split of each database's
// budget share: create does the heavy online-backup + VACUUM work; verify is
// a bounded read-back pass.
const kSqliteCreateBudgetShare = 0.8;

// The CLI can interleave log noise with the pretty-printed JSON report — the
// shared string-aware scanner keeps scanning past valid-but-wrong JSON until
// the create report ({ok, snapshotPath, ...}) is found.
const parseSnapshotPath = (tail) => {
  const parsed = parseJsonValueFromNoisyOutput(tail, {
    validate: (candidate) =>
      Boolean(candidate) &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      candidate.ok === true &&
      typeof candidate.snapshotPath === "string" &&
      candidate.snapshotPath.length > 0,
  });
  return parsed ? parsed.snapshotPath : null;
};

// Containment guard for the parsed snapshotPath: the create report is fished
// out of interleaved CLI chatter, so a forged/corrupt value (e.g. "--help",
// "/etc", "../outside") must never reach the verify argv — "--help" would
// turn verify into a successful help invocation and report an UNVERIFIED
// snapshot as verified. Only an absolute path that resolves INSIDE the
// repository we passed to create is trusted; the resolved result carries the
// repository prefix, so by construction it can never be option-shaped.
const containSnapshotPath = (snapshotPath, repositoryDir) => {
  if (!snapshotPath || !path.isAbsolute(snapshotPath)) return null;
  const resolved = path.resolve(snapshotPath);
  return resolved.startsWith(path.resolve(repositoryDir) + path.sep)
    ? resolved
    : null;
};

// The create report carries a per-database manifest that can exceed the
// run-stream's default 64KB tail; machine-contract parsers must raise it
// (openclaw-run-stream.js doctrine).
const kSqliteBackupTailBytes = 512 * 1024;

// Databases to snapshot: always the global state DB, plus one per configured
// agent (per-agent DBs hold sessions and auth profiles; the sqlite CLI has no
// --all, so each is its own create+verify). Roster precedence mirrors the
// dist readAgentRosterProperty contract (same as onboarding/workspace.js's
// resolveAllAgentWorkspaces): a PRESENT `agents.entries` keyed map wins over
// the `agents.list` array — property presence short-circuits even when both
// exist — and with NO roster property the gateway runs the implicit sole
// agent "main". A missing/unreadable openclaw.json also falls back to
// ["main"]: attempting a nonexistent agent DB fails loudly, silently
// skipping a real one would not. Ids are passed as configured (trimmed) —
// the sqlite CLI resolves agent ids itself.
const resolveBackupAgentIds = ({ fsModule, openclawDir }) => {
  try {
    const cfg = JSON.parse(
      fsModule.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    const agents =
      cfg.agents && typeof cfg.agents === "object" && !Array.isArray(cfg.agents)
        ? cfg.agents
        : {};
    let rosterEntries;
    if (agents.entries !== undefined) {
      const entriesMap =
        agents.entries &&
        typeof agents.entries === "object" &&
        !Array.isArray(agents.entries)
          ? agents.entries
          : {};
      rosterEntries = Object.keys(entriesMap).map((agentId) => ({
        id: agentId,
      }));
    } else if (agents.list !== undefined) {
      rosterEntries = Array.isArray(agents.list) ? agents.list : [];
    } else {
      return ["main"];
    }
    const ids = [];
    for (const entry of rosterEntries) {
      const agentId = String(entry?.id || "").trim();
      if (agentId && !ids.includes(agentId)) ids.push(agentId);
    }
    return ids;
  } catch {
    return ["main"];
  }
};

// One database's create -> contain snapshotPath -> verify pass. Every failure
// tail names the database (`target`) so a multi-database run's aggregate
// failure says exactly which snapshot cannot be trusted.
const backupOneDatabase = async ({
  runStreamed,
  getEnv,
  repositoryDir,
  target,
  scopeArgs,
  createTimeoutMs,
  verifyTimeoutMs,
}) => {
  const create = await runStreamed({
    command: "openclaw",
    args: [
      "backup",
      "sqlite",
      "create",
      ...scopeArgs,
      "--repository",
      repositoryDir,
      "--json",
    ],
    env: getEnv(),
    timeoutMs: createTimeoutMs,
    tailBytes: kSqliteBackupTailBytes,
  });
  if (!create.ok) {
    return {
      ok: false,
      step: "create",
      snapshotPath: null,
      code: create.code,
      timedOut: create.timedOut,
      tail: `Create FAILED for database ${target}.\n${create.tail}`,
    };
  }
  const snapshotPath = containSnapshotPath(
    parseSnapshotPath(create.tail),
    repositoryDir,
  );
  if (!snapshotPath) {
    return {
      ok: false,
      step: "create",
      snapshotPath: null,
      code: create.code,
      timedOut: create.timedOut,
      tail: `Create output for database ${target} had no parsable snapshotPath — snapshot not verified.\n${create.tail}`,
    };
  }
  const verify = await runStreamed({
    command: "openclaw",
    args: ["backup", "sqlite", "verify", snapshotPath, "--json"],
    env: getEnv(),
    timeoutMs: verifyTimeoutMs,
    tailBytes: kSqliteBackupTailBytes,
  });
  if (!verify.ok) {
    return {
      ok: false,
      step: "verify",
      snapshotPath,
      code: verify.code,
      timedOut: verify.timedOut,
      tail: `Snapshot for database ${target} created at ${snapshotPath} but verify FAILED — do not trust this snapshot.\n${verify.tail}`,
    };
  }
  return {
    ok: true,
    step: "verify",
    snapshotPath,
    code: verify.code,
    timedOut: verify.timedOut,
    tail: verify.tail,
  };
};

// ok=true ONLY when EVERY database (global + one per configured agent) was
// created AND its snapshotPath parsed AND verify passed on that snapshot — a
// created-but-unverified snapshot, or an agent database that was never
// reached, is reported as a failure with the output tail, never as
// "verified". The top-level step/snapshotPath/code/timedOut/tail keep the
// pre-existing single-database shape (they describe the first failure, or the
// last success); the per-database outcomes are in `databases`.
const createSqliteBackupRunner = ({
  runStreamed,
  getEnv,
  fsModule,
  openclawDir = null,
  repositoryDir = kOpenclawSqliteBackupDir,
  timeoutMs = kOpenclawBackupTimeoutMs,
}) => {
  return async () => {
    fsModule.mkdirSync(repositoryDir, { recursive: true });
    const targets = [
      { target: "global", scopeArgs: ["--global"] },
      ...resolveBackupAgentIds({ fsModule, openclawDir }).map((agentId) => ({
        target: `agent:${agentId}`,
        scopeArgs: ["--agent", agentId],
      })),
    ];
    // The one backup budget covers every database: a fair per-database share,
    // then the same create/verify split as before within each share.
    const perDatabaseTimeoutMs = Math.floor(timeoutMs / targets.length);
    const createTimeoutMs = Math.floor(
      perDatabaseTimeoutMs * kSqliteCreateBudgetShare,
    );
    const verifyTimeoutMs = perDatabaseTimeoutMs - createTimeoutMs;
    const databases = [];
    let lastOutcome = null;
    for (let index = 0; index < targets.length; index += 1) {
      const { target, scopeArgs } = targets[index];
      const outcome = await backupOneDatabase({
        runStreamed,
        getEnv,
        repositoryDir,
        target,
        scopeArgs,
        createTimeoutMs,
        verifyTimeoutMs,
      });
      databases.push({
        target,
        ok: outcome.ok,
        step: outcome.step,
        snapshotPath: outcome.snapshotPath,
        code: outcome.code,
        timedOut: outcome.timedOut,
      });
      if (!outcome.ok) {
        // Budget honesty: stop here — the remaining databases keep no claim
        // to the failed one's budget, and the result must say they were NOT
        // attempted instead of pretending they were covered.
        const notAttempted = targets
          .slice(index + 1)
          .map((entry) => entry.target);
        for (const skippedTarget of notAttempted) {
          databases.push({
            target: skippedTarget,
            ok: false,
            step: "skipped",
            snapshotPath: null,
            code: null,
            timedOut: false,
          });
        }
        return {
          ok: false,
          step: outcome.step,
          snapshotPath: outcome.snapshotPath,
          code: outcome.code,
          timedOut: outcome.timedOut,
          tail: notAttempted.length
            ? `${outcome.tail}\nDatabases not attempted after this failure: ${notAttempted.join(", ")}.`
            : outcome.tail,
          databases,
        };
      }
      lastOutcome = outcome;
    }
    return {
      ok: true,
      step: "verify",
      snapshotPath: lastOutcome.snapshotPath,
      code: lastOutcome.code,
      timedOut: lastOutcome.timedOut,
      tail: `Verified ${databases.length}/${databases.length} databases: ${targets.map((entry) => entry.target).join(", ")}.\n${lastOutcome.tail}`,
      databases,
    };
  };
};

const registerOpenclawChannelRoutes = ({
  app,
  fs,
  OPENCLAW_DIR,
  isOnboarded,
  openclawChannelService,
  openclawReleasesService,
  operationEvents,
  restartRequiredState,
  openclawFeatureGates = null,
  operatorsStore = null,
  upgradeOverseer = null,
  gatewayMedic = null,
  runBackupSqlite = null,
}) => {
  // Parsed openclaw.json for D5 flip filtering; null (= keep all flips) when
  // missing or unreadable.
  const readInstalledOpenclawConfig = () => {
    try {
      return JSON.parse(
        fs.readFileSync(`${OPENCLAW_DIR}/openclaw.json`, "utf8"),
      );
    } catch {
      return null;
    }
  };
  const badRequest = (res, code, message, hint = null) =>
    res.status(400).json(channelError(code, message, hint));

  const stateWriteError = (res, err) =>
    res
      .status(500)
      .json(
        channelError(
          "channel_state_write_failed",
          err?.message || "Could not update the channel state",
          "Check disk space on the data volume.",
        ),
      );

  // Every response that advertised an operationId must eventually publish a
  // terminal event, or a subscriber to the stream hangs forever. applyUpdate
  // normally terminates it in finish(); this covers the early gates
  // (operation_in_progress, not_onboarded) and unexpected throws.
  const ensureOperationTerminated = (operationId, body) => {
    try {
      const op = operationEvents.getOperation(operationId);
      if (op && op.status === "pending") {
        operationEvents.fail(
          operationId,
          Object.assign(new Error(body?.message || "Update failed"), {
            code: body?.code,
            hint: body?.hint,
            docsUrl: body?.docsUrl,
          }),
        );
      }
    } catch {}
  };

  app.put(
    "/api/alphaclaw/config/updates/openclaw-release-channel",
    async (req, res) => {
      const { releaseChannel } = req.body || {};
      if (!kOpenclawReleaseChannels.includes(releaseChannel)) {
        return badRequest(
          res,
          "invalid_channel",
          `releaseChannel must be one of: ${kOpenclawReleaseChannels.join(", ")}`,
        );
      }
      try {
        const { config, changed } = updateOpenclawReleaseChannel({
          fsModule: fs,
          openclawDir: OPENCLAW_DIR,
          releaseChannel,
        });
        // Channel selection is a catalog preference — it installs and
        // activates NOTHING until an explicit Apply, so it must not flag the
        // app restart-required. (It used to: the global "restart required"
        // banner then contradicted the Upgrade page's "still running stable,
        // press Apply" state.) The boot-time openclaw.json mirror converges
        // the preference at the next natural restart.
        res.json({
          ok: true,
          changed,
          config,
          restartRequired: false,
        });
      } catch (err) {
        res
          .status(500)
          .json(
            channelError(
              "config_write_failed",
              err.message || "Could not update the release channel",
              "Check disk space on the data volume.",
            ),
          );
      }
    },
  );

  // Version-gated feature map (fail-closed): the frontend hides beta-only
  // affordances against an older gateway instead of breaking.
  app.get("/api/openclaw/features", (req, res) => {
    try {
      if (!openclawFeatureGates) {
        return res.json({ ok: true, version: null, features: {} });
      }
      res.json({ ok: true, ...openclawFeatureGates.features() });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError("features_unavailable", err.message || "Could not read features"),
        );
    }
  });

  // Notification routing preferences (admin targets are PII — they live in
  // the non-synced state dir store, not alphaclaw.json).
  app.get("/api/openclaw/notifications", (req, res) => {
    try {
      if (!operatorsStore) {
        return res.json({
          ok: true,
          notifications: { preferredChannel: null, adminTargets: [] },
        });
      }
      res.json({
        ok: true,
        notifications: operatorsStore.read().notifications,
        // The UI renders its channel select from this so the client list can
        // never drift from what the store accepts.
        supportedChannels: operatorsStore.kSupportedChannels || [],
      });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "notifications_unavailable",
            err.message || "Could not read notification settings",
          ),
        );
    }
  });

  app.put("/api/openclaw/notifications", (req, res) => {
    try {
      if (!operatorsStore) {
        return res
          .status(503)
          .json(channelError("notifications_unavailable", "Store not available"));
      }
      const { preferredChannel = null, adminTargets = [] } = req.body || {};
      // Reject rather than silently normalize away: an API consumer must not
      // get 200 ok for settings the store discarded (matches the overseer
      // route's invalid_setting behavior).
      const supported = operatorsStore.kSupportedChannels || [];
      if (preferredChannel != null && !supported.includes(String(preferredChannel).toLowerCase())) {
        return badRequest(
          res,
          "invalid_setting",
          `preferredChannel must be one of: ${supported.join(", ")} (or null)`,
        );
      }
      if (!Array.isArray(adminTargets)) {
        return badRequest(res, "invalid_setting", "adminTargets must be an array");
      }
      for (const entry of adminTargets) {
        const channel = String(entry?.channel || "").toLowerCase();
        if (!supported.includes(channel) || !String(entry?.target || "").trim()) {
          return badRequest(
            res,
            "invalid_setting",
            "Each adminTarget needs a supported channel and a non-empty target",
          );
        }
      }
      const store = operatorsStore.setNotificationPrefs({
        preferredChannel,
        adminTargets,
      });
      res.json({ ok: true, notifications: store.notifications });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "notifications_write_failed",
            err.message || "Could not save notification settings",
            "Check disk space on the data volume.",
          ),
        );
    }
  });

  // Upgrade overseer (Claude Code advisory review) settings + availability.
  // Availability is surfaced, never silently degraded: the UI shows exactly
  // why the overseer cannot run (no `claude` binary, no Anthropic credential).
  app.get("/api/openclaw/overseer", async (req, res) => {
    try {
      const enabled = readOpenclawOverseerEnabled({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
      });
      const availability = upgradeOverseer
        ? await upgradeOverseer.getAvailability()
        : { available: false, reason: "not_wired", message: "Overseer service unavailable." };
      res.json({ ok: true, enabled, availability });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "overseer_unavailable",
            err.message || "Could not read overseer settings",
          ),
        );
    }
  });

  app.put("/api/openclaw/overseer", (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return badRequest(res, "invalid_setting", "enabled must be a boolean");
    }
    try {
      updateOpenclawOverseerEnabled({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
        enabled,
      });
      res.json({ ok: true, enabled });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "overseer_write_failed",
            err.message || "Could not save overseer settings",
            "Check disk space on the data volume.",
          ),
        );
    }
  });

  // Gateway startup medic (automatic EX_CONFIG repair) settings +
  // availability. Same never-silently-degraded contract as the overseer: the
  // response says exactly which frontier model the AI tier would use, or why
  // none is reachable (no provider key configured). The availability field is
  // deliberately named `ai` (not the overseer's `availability`): the medic's
  // deterministic tiers stay available even when no AI is reachable, so the
  // field describes only the escalation tier.
  app.get("/api/openclaw/medic", (req, res) => {
    try {
      const availability = gatewayMedic
        ? gatewayMedic.getAvailability()
        : {
            enabled: readOpenclawMedicEnabled({
              fsModule: fs,
              openclawDir: OPENCLAW_DIR,
            }),
            ai: {
              available: false,
              reason: "not_wired",
              message: "Medic service unavailable.",
            },
          };
      res.json({
        ok: true,
        enabled: availability.enabled,
        ai: availability.ai,
      });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "medic_unavailable",
            err.message || "Could not read medic settings",
          ),
        );
    }
  });

  app.put("/api/openclaw/medic", (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return badRequest(res, "invalid_setting", "enabled must be a boolean");
    }
    try {
      updateOpenclawMedicEnabled({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
        enabled,
      });
      res.json({ ok: true, enabled });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "medic_write_failed",
            err.message || "Could not save medic settings",
            "Check disk space on the data volume.",
          ),
        );
    }
  });

  // Verified SQLite backup: one `backup sqlite create --repository <dir>
  // --json` + `backup sqlite verify <snapshotPath>` pass PER database (the
  // global state DB, then every configured agent's DB) — version-gated: the
  // subcommand ships in the 2026.8.1 beta line, so the route fails closed
  // with a clear message on older installs. Any create that succeeds without
  // a passing verify is a failure (tail says which database and step).
  app.post("/api/openclaw/backup-sqlite", async (req, res) => {
    try {
      if (!openclawFeatureGates?.supportsFeature?.("sqliteBackup")) {
        return res
          .status(503)
          .json(
            channelError(
              "feature_unsupported",
              "The installed OpenClaw version has no `backup sqlite` command.",
              "SQLite backups require OpenClaw 2026.8.1-beta.1 or newer — switch channels on the Upgrade page first.",
            ),
          );
      }
      if (typeof runBackupSqlite !== "function") {
        return res
          .status(503)
          .json(
            channelError("backup_unavailable", "SQLite backup runner is not wired."),
          );
      }
      const result = await runBackupSqlite();
      if (!result?.ok) {
        return res.status(500).json({
          ...channelError(
            "backup_failed",
            "The verified SQLite backup did not complete.",
            "Check disk space on the data volume, then retry.",
          ),
          tail: String(result?.tail || "").slice(-4000),
        });
      }
      res.json({
        ok: true,
        snapshotPath: result.snapshotPath || null,
        tail: String(result.tail || "").slice(-4000),
      });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError("backup_failed", err.message || "SQLite backup failed"),
        );
    }
  });

  // Update run ledger: per-operation records + durable logs that survive the
  // activation restart. Log reads resolve ONLY through a validated
  // operationId (never a stored path) and stream rather than buffer.
  app.get("/api/openclaw/runs", (req, res) => {
    try {
      const ledger = openclawChannelService.runLedger;
      if (!ledger) return res.json({ ok: true, runs: [] });
      const runs = ledger.listRuns().map((run) => ({
        ...run,
        // Steps can be large; the list view only needs the summary. The full
        // record (steps included) is available per-run.
        steps: undefined,
        stepCount: run.steps.length,
      }));
      res.json({ ok: true, runs });
    } catch (err) {
      res
        .status(500)
        .json(channelError("runs_unavailable", err.message || "Could not list runs"));
    }
  });

  app.get("/api/openclaw/runs/:operationId", (req, res) => {
    try {
      const ledger = openclawChannelService.runLedger;
      const { operationId } = req.params;
      if (!ledger?.isValidOperationId(operationId)) {
        return badRequest(res, "invalid_operation_id", "Malformed operation id.");
      }
      const run = ledger.readRun(operationId);
      if (!run) {
        return res
          .status(404)
          .json(channelError("run_not_found", "No such update run."));
      }
      res.json({ ok: true, run });
    } catch (err) {
      res
        .status(500)
        .json(channelError("run_unavailable", err.message || "Could not read run"));
    }
  });

  app.get("/api/openclaw/runs/:operationId/log", (req, res) => {
    try {
      const ledger = openclawChannelService.runLedger;
      const { operationId } = req.params;
      if (!ledger?.isValidOperationId(operationId)) {
        return badRequest(res, "invalid_operation_id", "Malformed operation id.");
      }
      // ?tail=<bytes> serves only the end of the log (capped at 1MB); the UI
      // uses it by default so multi-MB dev logs never freeze the browser.
      const tailRaw = Number.parseInt(String(req.query.tail || ""), 10);
      const tailBytes =
        Number.isFinite(tailRaw) && tailRaw > 0
          ? Math.min(tailRaw, 1024 * 1024)
          : null;
      const opened = ledger.openLogStream(operationId, { tailBytes });
      if (!opened) {
        return res
          .status(404)
          .json(channelError("log_not_found", "No log recorded for this run."));
      }
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Length", String(opened.size));
      res.setHeader("X-Log-Total-Bytes", String(opened.totalSize));
      if (opened.truncatedHead) res.setHeader("X-Log-Truncated-Head", "1");
      opened.stream.on("error", () => {
        try {
          res.destroy();
        } catch {}
      });
      opened.stream.pipe(res);
    } catch (err) {
      res
        .status(500)
        .json(channelError("log_unavailable", err.message || "Could not read log"));
    }
  });

  app.get("/api/openclaw/channel", (req, res) => {
    try {
      res.json({ ok: true, ...openclawChannelService.getChannelInfo() });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "channel_state_unavailable",
            err.message || "Could not read channel state",
          ),
        );
    }
  });

  app.get("/api/openclaw/catalog", async (req, res) => {
    try {
      const forceRefresh = String(req.query.refresh || "") === "1";
      const catalog = await openclawReleasesService.getCatalog({ forceRefresh });
      if (!catalog.ok) {
        return res.status(503).json(catalog);
      }
      const info = openclawChannelService.getChannelInfo();
      const currentId =
        info.applied?.channel === "dev"
          ? info.applied.sha
          : info.installedVersion || info.pinVersion;
      const annotated = openclawReleasesService.annotateCatalog(catalog, {
        currentId,
        lastKnownGood: info.lastKnownGood,
        blocklist: info.blocklist,
      });
      res.json({
        ok: true,
        catalog: annotated,
        // Curated highlights + security-default flips for the selected channel's
        // latest minor; null when no curated entry exists (UI shows a fallback).
        // Flips are filtered to the ones that affect THIS installation (D5):
        // an explicitly-set key keeps its value across the upgrade.
        whatsNew: resolveWhatsNew({
          catalog: annotated,
          releaseChannel: info.releaseChannel,
          installedConfig: readInstalledOpenclawConfig(),
        }),
        channel: {
          releaseChannel: info.releaseChannel,
          installedVersion: info.installedVersion,
          pinVersion: info.pinVersion,
          appliedId: info.appliedId,
        },
      });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "catalog_failed",
            err.message || "Could not load the version catalog",
            "Check network access to npmjs.org and github.com.",
          ),
        );
    }
  });

  app.post("/api/openclaw/apply", async (req, res) => {
    const { channel, version = null, sha = null } = req.body || {};
    // Strict boolean: a JSON string "false" must not start a 30-minute build.
    const devHead = (req.body || {}).devHead === true;
    if (!kOpenclawReleaseChannels.includes(channel)) {
      return badRequest(
        res,
        "invalid_channel",
        `channel must be one of: ${kOpenclawReleaseChannels.join(", ")}`,
      );
    }
    // Strict allowlists: these values feed process invocations. Format first,
    // then server-side catalog membership — a well-formed but unknown target
    // is rejected too.
    if (channel === "dev") {
      if (!devHead) {
        if (typeof sha !== "string" || !kShaPattern.test(sha)) {
          return badRequest(
            res,
            "invalid_target",
            "sha must be a 7-40 character lowercase hex commit id",
          );
        }
        if (!openclawReleasesService.isKnownCommit(sha)) {
          return badRequest(
            res,
            "unknown_commit",
            `${sha.slice(0, 12)} is not in the current dev commit list.`,
            'Refresh the catalog ("Check now") and pick a listed commit.',
          );
        }
      }
    } else {
      if (
        typeof version !== "string" ||
        version.length > kVersionMaxLength ||
        !kVersionPattern.test(version)
      ) {
        return badRequest(
          res,
          "invalid_target",
          "version must be a plain version string",
        );
      }
      // Channel-scoped membership: a beta version is not applyable AS stable
      // (and vice versa) — the recorded channel must match the artifact.
      if (!openclawReleasesService.isKnownVersion(version, channel)) {
        return badRequest(
          res,
          "unknown_version",
          `${version} is not a published OpenClaw version in the catalog.`,
          'Refresh the catalog ("Check now") and pick a listed version.',
        );
      }
    }

    const { operationId } = operationEvents.createOperation({
      type: "openclaw-apply",
    });
    const applyPromise = openclawChannelService
      .applyUpdate({ channel, version, sha, devHead, operationId })
      .catch((err) => ({
        status: 500,
        body: {
          ok: false,
          code: "apply_failed",
          message: err.message || "The update failed unexpectedly",
          hint: null,
          docsUrl: null,
        },
      }));
    const quick = await Promise.race([
      applyPromise,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), kQuickResultWindowMs);
        timer.unref?.();
      }),
    ]);
    // Whenever the apply settles as an error, make sure the stream reaches a
    // terminal event even if applyUpdate never got as far as its own finish().
    applyPromise.then((result) => {
      if (result && result.body && !result.body.ok) {
        ensureOperationTerminated(operationId, result.body);
      }
    });
    if (quick) {
      return res
        .status(quick.status)
        .json({ ...quick.body, operationId });
    }
    // Long-running (build/download in progress): stream the rest.
    const eventsPath = `/api/operations/${encodeURIComponent(operationId)}/events`;
    res.status(202).json({
      ok: true,
      operationId,
      events: eventsPath,
      // Same field name the pre-existing 202 endpoints use for this handle.
      streamUrl: eventsPath,
    });
  });

  // "Run repair" (2.3): dev-checkout recovery only — package channels re-stage
  // through /api/openclaw/apply instead (overlay ownership, E-C7). Same quick-result
  // + SSE shape as apply.
  app.post("/api/openclaw/repair", async (req, res) => {
    const { operationId } = operationEvents.createOperation({
      type: "openclaw-repair",
    });
    const repairPromise = openclawChannelService
      .runUpdateRepair({ operationId })
      .catch((err) => ({
        status: 500,
        body: {
          ok: false,
          code: "repair_failed",
          message: err.message || "Repair failed unexpectedly",
          hint: null,
          docsUrl: null,
        },
      }));
    const quick = await Promise.race([
      repairPromise,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), kQuickResultWindowMs);
        timer.unref?.();
      }),
    ]);
    repairPromise.then((result) => {
      if (result && result.body && !result.body.ok) {
        ensureOperationTerminated(operationId, result.body);
      }
    });
    if (quick) {
      return res.status(quick.status).json({ ...quick.body, operationId });
    }
    const eventsPath = `/api/operations/${encodeURIComponent(operationId)}/events`;
    res.status(202).json({
      ok: true,
      operationId,
      events: eventsPath,
      streamUrl: eventsPath,
    });
  });

  // These three write the channel state file — a full data volume throws
  // synchronously, and Express's default handler would answer with an HTML
  // stack trace instead of the envelope every client here parses.
  app.post("/api/openclaw/rollback", (req, res) => {
    try {
      const result = openclawChannelService.requestChannelRollback({
        reason: "manual",
      });
      if (!result.ok) {
        // A failed marker WRITE is a server/disk failure (ENOSPC class), not
        // a conflict — match the sibling routes' 500 semantics for it.
        return res
          .status(result.code === "rollback_marker_write_failed" ? 500 : 409)
          .json(result);
      }
      res.json(result);
    } catch (err) {
      stateWriteError(res, err);
    }
  });

  app.post("/api/openclaw/mark-good", (req, res) => {
    try {
      const result = openclawChannelService.markGoodNow({ source: "manual" });
      if (!result.ok) {
        return res.status(409).json(result);
      }
      res.json(result);
    } catch (err) {
      stateWriteError(res, err);
    }
  });

  app.post("/api/openclaw/blocklist/clear", (req, res) => {
    const { id = null } = req.body || {};
    if (id !== null && (typeof id !== "string" || id.length > 64)) {
      return badRequest(res, "invalid_target", "id must be a short string");
    }
    try {
      openclawChannelService.store.clearBlocklist(id || undefined);
      res.json({
        ok: true,
        blocklist: openclawChannelService.store.readState().blocklist,
      });
    } catch (err) {
      stateWriteError(res, err);
    }
  });
};

module.exports = { registerOpenclawChannelRoutes, createSqliteBackupRunner };
