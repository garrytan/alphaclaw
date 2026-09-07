// Markdown view of a diagnose bundle (plan A9) — what `alphaclaw diagnose`
// prints and what the informative give-up / rescue bundle (B3/B4) paste.
//
// Rules: one `##` heading per section, in the collector's order; the heading
// names the section's source (live / disk / unavailable); an unavailable
// section says WHY on the next line; every timestamp is UTC ISO-8601 (ms
// epochs and date strings alike — an operator reading two boxes must never
// convert time zones by hand). The renderer trusts nothing about the data
// shape: a field it does not recognise falls back to a fenced JSON block
// rather than a crash, because the bundle is the last thing standing in an
// incident. It receives an already-REDACTED bundle and adds no new data.
const kDiagnoseSectionTitles = Object.freeze({
  selfVersion: "AlphaClaw version",
  bootReports: "Boot reports",
  channelState: "Channel state",
  pidfile: "Server pidfile",
  stateDb: "State databases",
  supportedSchema: "Supported schema",
  incidents: "Incidents",
  runs: "Update runs",
  restartOperation: "Restart operation",
  gatewayState: "Gateway state",
  backups: "Backups",
  watchdog: "Watchdog",
  logTail: "Process log tail",
});

const kIsoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// ms epoch | ISO string | Date → UTC ISO; anything else → "n/a".
const iso = (value) => {
  if (value === null || value === undefined || value === "") return "n/a";
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "n/a";
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : "n/a";
  }
  if (typeof value === "string") {
    if (kIsoPattern.test(value)) return value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  return "n/a";
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const show = (value) => {
  if (value === null || value === undefined || value === "") return "n/a";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
};

const code = (value) => `\`${show(value)}\``;

const bytes = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "n/a";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

const fenced = (value, lang = "json") => [
  `\`\`\`${lang}`,
  lang === "json" ? JSON.stringify(value ?? null, null, 2) : String(value ?? ""),
  "```",
];

const bullet = (label, value) => `- ${label}: ${value}`;

// ── per-section renderers: (data, section) → string[] ───────────────────────

const renderSelfVersion = (data) => {
  const record = data?.record;
  if (!record) {
    return [`- no stamp at ${code(data?.path)} (${data?.present ? "present but unreadable" : "first boot of a box, or a pre-0.9.77 AlphaClaw"})`];
  }
  return [
    bullet("version", `${code(record.version)} (commit ${show(record.commit ?? "n/a")})`),
    bullet("boots of this version", `${show(record.bootCount)} — first ${iso(record.firstBootAt)}, last ${iso(record.lastBootAt)}`),
    bullet(
      "previous",
      record.previous
        ? `${code(record.previous.version)} (commit ${show(record.previous.commit ?? "n/a")}, last boot ${iso(record.previous.lastBootAt)})`
        : "none",
    ),
  ];
};

const verdictText = (report) => {
  const server = isPlainObject(report?.serverPhase) ? report.serverPhase : {};
  if (Array.isArray(server.verdict)) {
    return server.verdict.length === 0 ? "consistent" : `INCONSISTENT — ${server.verdict.map((v) => `\`${v}\``).join(", ")}`;
  }
  return `no verdict (server phase ${show(server.status ?? "unknown")})`;
};

const renderBootReport = (report, { compact = false } = {}) => {
  const openclaw = isPlainObject(report?.openclaw) ? report.openclaw : {};
  const alphaclaw = isPlainObject(report?.alphaclaw) ? report.alphaclaw : {};
  const bootSync = isPlainObject(openclaw.bootSync) ? openclaw.bootSync : {};
  const pidfile = isPlainObject(report?.pidfile) ? report.pidfile : {};
  const server = isPlainObject(report?.serverPhase) ? report.serverPhase : {};
  const head = `boot ${code(report?.bootId)} at ${iso(report?.at)} — ${verdictText(report)}`;
  if (compact) {
    return [
      `- ${head}; alphaclaw ${show(alphaclaw.version)}; openclaw expected ${show(openclaw.expected)} / installed ${show(openclaw.installedAtBoot)}; sync ${show(bootSync.action)}${bootSync.reason ? ` (${bootSync.reason})` : ""}; pidfile ${show(pidfile.decision)}/${show(pidfile.reason)}`,
    ];
  }
  const lines = [
    `- ${head}`,
    bullet("alphaclaw", `${show(alphaclaw.version)} (commit ${show(alphaclaw.commit ?? "n/a")}, previous ${show(alphaclaw.previousVersion ?? "n/a")}${alphaclaw.firstBootOfVersion ? ", first boot of this version" : ""})`),
    bullet(
      "openclaw",
      `pin ${show(openclaw.declaredPin)}, applied ${show(openclaw.channelApplied)}, expected ${show(openclaw.expected)}, installed at boot ${show(openclaw.installedAtBoot)}, resolved for launch ${show(openclaw.resolvedForLaunch)}`,
    ),
    bullet(
      "overlay",
      `present ${show(openclaw.overlayPresent)}, complete ${show(openclaw.overlayComplete)}, sentinel matches ${show(openclaw.sentinelMatches)}`,
    ),
    bullet("boot sync", `${show(bootSync.action)}${bootSync.reason ? ` (${bootSync.reason})` : ""}${Array.isArray(bootSync.warnings) && bootSync.warnings.length ? `; warnings: ${bootSync.warnings.join(" | ")}` : ""}`),
    bullet("pidfile", `${show(pidfile.decision)} (${show(pidfile.reason)})`),
    bullet("bin phase", show(report?.binPhase?.status)),
    bullet("server phase", `${show(server.status)}${server.reason ? ` (${server.reason})` : ""} at ${iso(server.at)}`),
  ];
  if (Array.isArray(server.stateDb) && server.stateDb.length) {
    lines.push(
      bullet(
        "state DBs at boot",
        server.stateDb.map((entry) => `${show(entry.kind)} user_version ${show(entry.userVersion)}${entry.status && entry.status !== "ok" ? ` (${entry.status})` : ""}`).join("; "),
      ),
    );
  }
  if (isPlainObject(server.supportedSchema)) {
    lines.push(bullet("supported schema at boot", `state ${show(server.supportedSchema.state)}, agent ${show(server.supportedSchema.agent)} (${show(server.supportedSchema.source)})`));
  }
  if (server.legacyExecApprovalsPresent !== undefined) {
    lines.push(bullet("legacy exec-approvals.json present", show(server.legacyExecApprovalsPresent)));
  }
  return lines;
};

const renderBootReports = (data) => {
  const lines = [];
  lines.push("### Current boot");
  if (data?.current) lines.push(...renderBootReport(data.current));
  else lines.push(`- no boot-report.json under ${code(data?.managedDir)} (pre-0.9.77 box, or the bin phase never wrote)`);
  lines.push("", "### Previous boots");
  if (Array.isArray(data?.previous) && data.previous.length) {
    for (const report of data.previous) lines.push(...renderBootReport(report, { compact: true }));
  } else {
    lines.push("- none rotated yet");
  }
  lines.push("", "### Pinned incident report");
  if (data?.incident) {
    lines.push(`- pinned ${iso(data.incident.pinnedAt)}`);
    lines.push(...renderBootReport(data.incident));
  } else {
    lines.push("- none (no INCONSISTENT boot has been recorded)");
  }
  if (Array.isArray(data?.unreadable) && data.unreadable.length) {
    lines.push("", `- unreadable files: ${data.unreadable.map(code).join(", ")}`);
  }
  return lines;
};

const renderChannelState = (data) => {
  const lines = [];
  if (data?.stateCorrupted) {
    lines.push(`- **state file CORRUPTED** (${code(data.statePath)}) — the fields below are defaults, not evidence; the gateway hold is UNKNOWN, not "none"`);
  } else {
    lines.push(bullet("state file", `${code(data?.statePath)} readable`));
  }
  const applied = data?.applied;
  lines.push(bullet("pin", show(data?.pinVersion)));
  lines.push(
    bullet(
      "applied",
      applied ? `${show(applied.channel)} ${show(applied.version)}${applied.at ? ` at ${iso(applied.at)}` : ""}${applied.acceptedAt ? `, accepted ${iso(applied.acceptedAt)}` : ""}` : "none (the pin runs)",
    ),
  );
  lines.push(bullet("installed version", show(data?.installedVersion)));
  const info = data?.info;
  if (isPlainObject(info)) {
    lines.push(
      bullet(
        "live channel info",
        `channel ${show(info.releaseChannel)}, expected ${show(info.expectedVersion)} (${show(info.expectedKind)}), installed ${show(info.installedVersion)}, installedIsPin ${show(info.installedIsPin)}, installedDiverged ${show(info.installedDiverged)}, pinDiverged ${show(info.pinDiverged)}, in stabilization window ${show(info.inStabilizationWindow)}`,
      ),
    );
  }
  // Normalized shape: { package: "<version>" | null, dev: "<id>" | null }.
  const lkg = isPlainObject(data?.lastKnownGood) ? data.lastKnownGood : {};
  lines.push(
    bullet(
      "last known good",
      lkg.package || lkg.dev ? `package ${show(lkg.package ?? "none")}, dev ${show(lkg.dev ?? "none")}` : "none",
    ),
  );
  const hold = data?.gatewayHold;
  lines.push(
    bullet(
      "gateway hold",
      data?.stateCorrupted
        ? "UNKNOWN (state unreadable)"
        : hold
          ? `${show(hold.reason)}${hold.at ? ` since ${iso(hold.at)}` : ""}${hold.installed ? `, installed ${show(hold.installed)}` : ""}${hold.expected ? `, expected ${show(hold.expected)}` : ""}`
          : "none",
    ),
  );
  const lastBoot = data?.lastBoot;
  lines.push(
    bullet(
      "last boot",
      lastBoot ? `${show(lastBoot.action)}${lastBoot.reason ? ` (${lastBoot.reason})` : ""} at ${iso(lastBoot.at)}${Array.isArray(lastBoot.warnings) && lastBoot.warnings.length ? `; warnings: ${lastBoot.warnings.join(" | ")}` : ""}` : "none recorded",
    ),
  );
  const run = data?.lastUpdateRun;
  lines.push(bullet("last update run", run ? `${show(run.operationId)} ${show(run.state)}${run.startedAt ? ` started ${iso(run.startedAt)}` : ""}${run.finishedAt ? `, finished ${iso(run.finishedAt)}` : ""}` : "none"));
  const migration = data?.configMigration;
  lines.push(bullet("config migration", migration ? `completed for ${show(migration.completedForVersion)}${migration.lastRestore ? `, last restore ${iso(migration.lastRestore.at)} (${show(migration.lastRestore.reason)})` : ""}` : "none"));
  const transition = data?.lastTransition;
  lines.push(bullet("last transition", transition ? `${show(transition.from)} → ${show(transition.to)} at ${iso(transition.at)}, ok ${show(transition.ok)}${transition.consumedAt ? `, consumed ${iso(transition.consumedAt)}` : ""}` : "none"));
  lines.push(bullet("pin lag", data?.pinLag ? show(data.pinLag) : "none"));
  const blocklist = Array.isArray(data?.blocklist) ? data.blocklist : [];
  // Normalized entries are { id: "<channel>:<version>", reason, exitCode, at }.
  lines.push(bullet("blocklist", blocklist.length ? blocklist.map((entry) => code(isPlainObject(entry) ? `${entry.id ?? "?"}${entry.reason ? ` (${entry.reason})` : ""}` : entry)).join(", ") : "empty"));
  const latches = ["rollbackRefused", "forwardRecovery", "noBootableVersion"].filter((key) => data?.[key]);
  lines.push(bullet("recovery latches", latches.length ? latches.map((key) => `${key}=${show(data[key])}`).join("; ") : "none"));
  lines.push(bullet("backups recorded in state", show(data?.backupsRecorded ?? 0)));
  return lines;
};

const renderPidfile = (data) => [
  bullet("path", code(data?.path)),
  bullet("decision", `${show(data?.decision?.decision)} (${show(data?.decision?.reason)})`),
  bullet("audit line", code(data?.line)),
];

const renderStateDb = (data) => {
  const lines = [bullet("state dir", `${code(data?.stateDir)}${data?.stateDirFromEnv ? " (from OPENCLAW_STATE_DIR)" : ""}`)];
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  if (!entries.length) {
    lines.push("- no databases found");
    return lines;
  }
  lines.push("", "| database | kind | user_version | status | size |", "| --- | --- | --- | --- | --- |");
  for (const entry of entries) {
    const status = entry.status === "ok" ? "ok" : `${show(entry.status)}${entry.error?.code ? ` (${entry.error.code})` : ""}`;
    lines.push(`| ${code(entry.path)} | ${show(entry.kind)}${entry.agentId ? ` (${entry.agentId})` : ""} | ${show(entry.userVersion)} | ${status} | ${bytes(entry.sizeBytes)} |`);
  }
  return lines;
};

const renderSupportedSchema = (data) => {
  const lines = [
    bullet("installed build", `${show(data?.installedVersion)} at ${code(data?.packageDir)}`),
    bullet(
      "declared (dist constants)",
      `state ${show(data?.declared?.state)}, agent ${show(data?.declared?.agent)}${Array.isArray(data?.declared?.files) && data.declared.files.length ? ` — ${data.declared.files.map(code).join(", ")}` : " — no constant-bearing chunk found"}`,
    ),
    bullet(
      "supported for the installed build",
      `state ${show(data?.supported?.state)} (${show(data?.supported?.source?.state)}), agent ${show(data?.supported?.agent)} (${show(data?.supported?.source?.agent)})`,
    ),
    bullet("schema table", `${code(data?.table?.path)} origin ${show(data?.table?.origin)}`),
  ];
  const byVersion = isPlainObject(data?.table?.byVersion) ? data.table.byVersion : {};
  const versions = Object.keys(byVersion);
  if (versions.length) {
    lines.push("", "| version | state | agent | source | observed |", "| --- | --- | --- | --- | --- |");
    for (const version of versions) {
      const entry = byVersion[version] || {};
      const observed = isPlainObject(entry.observed) ? `state ${show(entry.observed.state)} / agent ${show(entry.observed.agent)}` : "—";
      lines.push(`| ${code(version)} | ${show(entry.state)} | ${show(entry.agent)} | ${show(entry.source)} | ${observed} |`);
    }
  }
  return lines;
};

const causeText = (cause) => {
  if (cause == null) return "none recorded";
  if (typeof cause === "string") return code(cause);
  if (isPlainObject(cause)) {
    const head = cause.cause ?? cause.kind ?? cause.code ?? null;
    const parts = [head ? code(head) : null, cause.detail ? show(cause.detail) : null, cause.fingerprint ? `fingerprint ${code(cause.fingerprint)}` : null, cause.corroborated !== undefined ? `corroborated ${show(cause.corroborated)}` : null].filter(Boolean);
    return parts.length ? parts.join(", ") : JSON.stringify(cause);
  }
  return show(cause);
};

const renderIncidents = (data) => {
  const incidents = Array.isArray(data?.incidents) ? data.incidents : [];
  const lines = [bullet("source", data?.dbPath ? code(data.dbPath) : "live watchdog database")];
  if (!incidents.length) {
    lines.push("- no incidents recorded");
    return lines;
  }
  for (const incident of incidents) {
    const summary = isPlainObject(incident.summary) ? incident.summary : {};
    lines.push(
      `- #${show(incident.id)} ${code(incident.incidentKey)} ${show(incident.status)} — opened ${iso(incident.openedAt)}${incident.resolvedAt ? `, closed ${iso(incident.resolvedAt)}` : ""}${incident.eventCount != null ? `, ${incident.eventCount} events` : ""}`,
    );
    lines.push(`  - cause: ${causeText(incident.cause)}`);
    if (summary.unreadable) lines.push("  - summary: unreadable");
    else if (Object.keys(summary).length) {
      lines.push(`  - summary: trigger ${show(summary.trigger)}, severity ${show(summary.severity)}${summary.outcome ? `, outcome ${show(summary.outcome)}` : ""}${summary.durationMs != null ? `, ${Math.round(Number(summary.durationMs) / 1000)}s` : ""}`);
    }
  }
  return lines;
};

const renderRun = (run) => {
  const target = isPlainObject(run.target) ? `${show(run.target.kind ?? run.target.channel)} ${show(run.target.version)}` : show(run.target);
  const steps = Array.isArray(run.steps) && run.steps.length ? run.steps.map((step) => (isPlainObject(step) ? `${show(step.name ?? step.step ?? step.id)}=${show(step.status ?? step.state)}` : show(step))).join(" ") : "no steps";
  const backup = isPlainObject(run.backup) ? (run.backup.noBackup ? "no backup" : `backup ${show(run.backup.file ? run.backup.file.split("/").pop() : run.backup.mode)}${run.backup.verified === false ? " (unverified)" : ""}`) : null;
  return [
    `- ${code(run.operationId)} ${show(run.state)} → ${target}; started ${iso(run.startedAt)}, finished ${iso(run.finishedAt)}, ok ${show(run.ok)}${backup ? `; ${backup}` : ""}${run.result?.code ? `; code ${code(run.result.code)}` : ""}${run.result?.error ? `; error ${show(run.result.error)}` : ""}`,
    `  - steps: ${steps}`,
  ];
};

const renderRuns = (data) => {
  const lines = [bullet("runs on disk", show(data?.total ?? 0))];
  const recent = Array.isArray(data?.recent) ? data.recent.filter(Boolean) : [];
  const running = Array.isArray(data?.running) ? data.running.filter(Boolean) : [];
  lines.push("", "### Most recent");
  if (recent.length) for (const run of recent) lines.push(...renderRun(run));
  else lines.push("- none");
  if (running.length) {
    lines.push("", "### Still running (older than the recent set)");
    for (const run of running) lines.push(...renderRun(run));
  }
  return lines;
};

const renderRecordFile = (data, describe) => {
  if (!data?.present) return [`- no file at ${code(data?.path)}`];
  if (!data.record) return [`- ${code(data.path)} is present but unreadable`];
  return describe(data.record);
};

const renderRestartOperation = (data) =>
  renderRecordFile(data, (record) => [
    bullet("operation", `${code(record.operationId)} ${show(record.kind)} ${show(record.status)}`),
    bullet("boot id", show(record.bootId)),
    bullet("started", iso(record.startedAt)),
    bullet("completed", iso(record.completedAt)),
    bullet("expires", iso(record.expiresAt)),
    bullet("last step", show(record.lastStep)),
    bullet("code", show(record.code)),
    bullet("error summary", show(record.errorSummary)),
    bullet("cause", causeText(record.cause)),
    ...(isPlainObject(record.stateDb) ? [bullet("state DB at request", `user_version ${show(record.stateDb.userVersion)}, agents ${show(record.stateDb.agentUserVersions)}`)] : []),
    ...(Array.isArray(record.reasonsSnapshot) && record.reasonsSnapshot.length ? [bullet("reasons", record.reasonsSnapshot.map(code).join(", "))] : []),
    ...(record.evidenceTail ? ["- evidence tail:", ...fenced(record.evidenceTail, "text")] : []),
  ]);

const renderGatewayState = (data) =>
  renderRecordFile(data, (record) => [
    bullet("state", `${show(record.state)} since ${iso(record.since)}`),
    bullet("boot id", show(record.bootId)),
    bullet("cause", causeText(record.cause)),
    bullet("version mismatch", isPlainObject(record.versionMismatch) ? `running ${show(record.versionMismatch.running)}, expected ${show(record.versionMismatch.expected)} (${show(record.versionMismatch.source)}, detected ${iso(record.versionMismatch.detectedAt)})` : "none"),
  ]);

const renderBackups = (data) => {
  if (!data?.present) return [`- no backups directory at ${code(data?.dir)}`];
  const totals = isPlainObject(data.totals) ? data.totals : {};
  const totalLine = (label, bucket) => bullet(label, `${show(bucket?.count ?? 0)} (${bytes(bucket?.bytes ?? 0)})`);
  const lines = [
    bullet("directory", code(data.dir)),
    totalLine("verified-name archives", totals.archives),
    totalLine(".tmp debris", totals.tmp),
    totalLine(".unverified quarantine", totals.unverified),
    totalLine("other entries", totals.other),
  ];
  const listEntries = (title, entries) => {
    if (!Array.isArray(entries) || !entries.length) return;
    lines.push("", `### ${title}`);
    for (const entry of entries) {
      lines.push(`- ${code(entry.name)} ${entry.directory ? "(directory)" : bytes(entry.sizeBytes)} modified ${iso(entry.mtimeMs)}`);
    }
  };
  listEntries("Archives (newest first)", data.archives);
  listEntries("Temp debris", data.tmp);
  listEntries("Quarantined", data.unverified);
  listEntries("Other", data.other);
  return lines;
};

const renderWatchdog = (data) => {
  if (!isPlainObject(data)) return ["- no status"];
  const lines = [];
  for (const [key, value] of Object.entries(data)) {
    const rendered = /At$|Since$/.test(key) && value != null ? iso(value) : isPlainObject(value) || Array.isArray(value) ? JSON.stringify(value) : show(value);
    lines.push(bullet(key, rendered));
  }
  return lines;
};

const renderLogTail = (data) => {
  const lines = [
    bullet("source", code(data?.path)),
    bullet("filter", code(`/${show(data?.pattern)}/`)),
    bullet("lines", `${show(data?.matchedLines ?? 0)} matched of ${show(data?.scannedLines ?? 0)} scanned${data?.truncated ? ` — showing the last ${Array.isArray(data?.lines) ? data.lines.length : 0}` : ""}`),
  ];
  const tail = Array.isArray(data?.lines) ? data.lines : [];
  lines.push("", ...fenced(tail.length ? tail.join("\n") : "(no matching lines)", "text"));
  return lines;
};

const kSectionRenderers = Object.freeze({
  selfVersion: renderSelfVersion,
  bootReports: renderBootReports,
  channelState: renderChannelState,
  pidfile: renderPidfile,
  stateDb: renderStateDb,
  supportedSchema: renderSupportedSchema,
  incidents: renderIncidents,
  runs: renderRuns,
  restartOperation: renderRestartOperation,
  gatewayState: renderGatewayState,
  backups: renderBackups,
  watchdog: renderWatchdog,
  logTail: renderLogTail,
});

const renderSection = (name, section) => {
  const title = kDiagnoseSectionTitles[name] || name;
  const source = show(section?.source ?? "unavailable");
  const lines = [`## ${title} (${source})`];
  if (!section || section.source === "unavailable") {
    lines.push(`_Unavailable: ${show(section?.reason ?? "no section")}_`);
  } else {
    const renderer = kSectionRenderers[name];
    let body;
    try {
      body = renderer ? renderer(section.data, section) : fenced(section.data);
    } catch (error) {
      body = [`_Renderer failed (${error?.message || error}); raw section follows._`, ...fenced(section.data)];
    }
    lines.push(...body);
  }
  if (Array.isArray(section?.warnings) && section.warnings.length) {
    lines.push("");
    for (const warning of section.warnings) lines.push(`> ⚠ ${show(warning)}`);
  }
  return lines;
};

const renderDiagnoseMarkdown = (bundle) => {
  const sections = isPlainObject(bundle?.sections) ? bundle.sections : {};
  const paths = isPlainObject(bundle?.paths) ? bundle.paths : {};
  const sources = isPlainObject(bundle?.summary?.sources) ? bundle.summary.sources : {};
  const unavailable = Array.isArray(bundle?.summary?.unavailable) ? bundle.summary.unavailable : [];
  const verdict = bundle?.summary?.bootVerdict;
  const lines = [
    "# AlphaClaw diagnose",
    "",
    bullet("generated", iso(bundle?.generatedAt ?? bundle?.generatedAtMs)),
    bullet("mode", `${show(bundle?.mode)} (${show(bundle?.mode) === "server" ? "live sections from the running server" : "disk only"})`),
    bullet("root", code(paths.rootDir)),
    bullet("openclaw dir", code(paths.openclawDir)),
    bullet("state dir", code(paths.stateDir)),
    bullet("install dir", code(paths.installDir)),
    bullet(
      "sections",
      `${Object.keys(sections).length} — live ${show(sources.live ?? 0)}, disk ${show(sources.disk ?? 0)}, unavailable ${show(sources.unavailable ?? 0)}${unavailable.length ? ` (${unavailable.join(", ")})` : ""}`,
    ),
    bullet(
      "current boot verdict",
      Array.isArray(verdict) ? (verdict.length ? `INCONSISTENT — ${verdict.map((v) => `\`${v}\``).join(", ")}` : "consistent") : "unknown",
    ),
    bullet("channel state", bundle?.summary?.stateCorrupted === true ? "**CORRUPTED**" : bundle?.summary?.stateCorrupted === false ? "readable" : "unknown"),
  ];
  if (Array.isArray(bundle?.warnings) && bundle.warnings.length) {
    lines.push("");
    for (const warning of bundle.warnings) lines.push(`> ⚠ ${show(warning)}`);
  }
  // Collector order first, then any section the renderer does not know.
  const known = Object.keys(kDiagnoseSectionTitles).filter((name) => name in sections);
  const extra = Object.keys(sections).filter((name) => !(name in kDiagnoseSectionTitles));
  for (const name of [...known, ...extra]) {
    lines.push("", ...renderSection(name, sections[name]));
  }
  return `${lines.join("\n")}\n`;
};

module.exports = {
  kDiagnoseSectionTitles,
  renderDiagnoseMarkdown,
  renderSection,
  iso,
};
