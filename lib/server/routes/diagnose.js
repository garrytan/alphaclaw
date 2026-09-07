// GET /api/diagnose — the running server's side of `alphaclaw diagnose`
// (issue #76 Part A, plan A9). ONE collector, two callers: the CLI runs it
// with the server down and reads disk only; this route hands the SAME
// collector (lib/server/diagnose/collect.js) the process's live seams —
// watchdog status, channel info, the incidents DB, the release-channel store
// — so the bundle an operator pastes from a sick-but-serving box carries what
// only the running process knows. Sections the CLI would read from disk
// (boot reports, the self-version stamp, the schema table) are read from the
// store's managed dir here too: they are files, and the server phase writes
// them through the same modules.
//
// Contract:
//   - every section is try/caught INSIDE the collector: a throwing seam
//     degrades its OWN section to `unavailable` + reason and the response
//     stays 200 (CEO registry: "bundle says which sections are missing");
//   - the bundle is secret-redacted by the collector (`.env` values from
//     readEnvFile(), openclaw.json secrets, secret-named env keys, shapes)
//     before it returns, so this route adds nothing and strips nothing;
//   - default `?format=json` answers `{ ok: true, bundle }` where `bundle` is
//     exactly the object `alphaclaw diagnose --json` prints; `?format=text`
//     renders the markdown the CLI prints (text/markdown);
//   - anything that escapes the collector as a whole (it should not) is one
//     500 `{ ok: false, error }` like the neighbouring watchdog routes.
const path = require("path");

const { wrapAsync } = require("../utils/wrap-async");
const { collectDiagnose } = require("../diagnose/collect");
const { renderDiagnoseMarkdown } = require("../diagnose/render");

const kDiagnoseFormats = Object.freeze(["json", "text"]);
const kDiagnoseTextContentType = "text/markdown; charset=utf-8";

// `undefined` (not null) lets the collector's own defaults apply for the
// inputs a caller did not supply.
const orUndefined = (value) => (value === null ? undefined : value);

const registerDiagnoseRoutes = ({
  app,
  requireAuth,
  // Collector inputs (see collectDiagnose in diagnose/collect.js). rootDir
  // falls back to the openclaw dir's parent: constants.OPENCLAW_DIR is
  // <root>/.openclaw, and every other on-volume path derives from rootDir.
  fsModule = null,
  rootDir = null,
  openclawDir = null,
  env = null,
  installDir = null,
  nowFn = null,
  channelStore = null,
  // () => [{ key, value }] — lib/server/env.js readEnvFile; the collector's
  // redaction source. Called per request so a rotated secret is scrubbed on
  // the next paste. null → the collector reads <rootDir>/.env itself.
  readEnvFile = null,
  // (maxBytes) => string — log-writer readLogTail (the process's own log).
  readLogTail = null,
  // Live seams; each null → that section reads disk or is `unavailable`
  // with a reason naming the CLI path.
  incidentsDb = null,
  getWatchdogStatus = null,
  getChannelInfo = null,
  bootReports = null,
  selfVersion = null,
  schemaTable = null,
  // Test seams.
  collect = collectDiagnose,
  render = renderDiagnoseMarkdown,
  logger = console,
}) => {
  const resolvedRootDir =
    rootDir ?? (typeof openclawDir === "string" && openclawDir ? path.dirname(openclawDir) : null);

  app.get(
    "/api/diagnose",
    requireAuth,
    wrapAsync(async (req, res) => {
      const format = String(req.query.format ?? "json")
        .trim()
        .toLowerCase();
      if (!kDiagnoseFormats.includes(format)) {
        res.status(400).json({
          ok: false,
          error: "invalid_format",
          hint: `format must be one of ${kDiagnoseFormats.join(", ")}`,
        });
        return;
      }

      let bundle;
      try {
        bundle = await collect({
          fsModule: orUndefined(fsModule),
          rootDir: orUndefined(resolvedRootDir),
          openclawDir: orUndefined(openclawDir),
          env: orUndefined(env),
          nowFn: orUndefined(nowFn),
          installDir,
          channelStore,
          envFileVars: typeof readEnvFile === "function" ? readEnvFile() : null,
          readLogTail,
          incidentsDb,
          getWatchdogStatus,
          getChannelInfo,
          bootReports,
          selfVersion,
          schemaTable,
        });
      } catch (err) {
        logger.warn(`[diagnose] bundle failed: ${err?.message || err}`);
        res.status(500).json({ ok: false, error: err.message });
        return;
      }

      if (format === "text") {
        res.setHeader("Content-Type", kDiagnoseTextContentType);
        res.status(200).send(render(bundle));
        return;
      }
      res.json({ ok: true, bundle });
    }),
  );
};

module.exports = {
  kDiagnoseFormats,
  kDiagnoseTextContentType,
  registerDiagnoseRoutes,
};
