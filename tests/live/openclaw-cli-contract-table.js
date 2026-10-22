// The OpenClaw CLI and plugin-sdk contract AlphaClaw encodes, one typed row
// per assumption, each pointing at the code that relies on it. The live tier
// (openclaw-live-cli-contract.e2e.test.js) runs every row against the pinned
// build; set OPENCLAW_CONTRACT_INSTALL_DIR to a directory holding
// node_modules/openclaw to run the same rows against a candidate pin first.
//
// Row kinds:
//   help        `<argv> --help` prints `Usage: openclaw <usage>` (not a parent's
//               help, not "has no command"), defines every flag AlphaClaw
//               passes, and lists every subcommand AlphaClaw calls.
//   enum        the value list in an option's help includes every value
//               AlphaClaw passes or gates on.
//   hidden-verb a verb that help does not list, checked by its real exit
//               status and JSON answer.
//   json-shape  `--json` stdout is exactly one JSON document (runCliJson) and
//               carries the fields AlphaClaw reads.
//   config-path the config schema knows a path AlphaClaw reads.
//   sdk-export  a plugin-sdk subpath AlphaClaw imports exports each name.
//
// A row's optional `config` is written as openclaw.json before the probe, so
// a row can pin an answer that must hold with plugins disabled.

/**
 * @typedef {object} ContractRowBase
 * @property {string} site Where AlphaClaw relies on the row.
 * @property {object} [config] openclaw.json contents for the probe.
 *
 * @typedef {ContractRowBase & { kind: "help", argv: string[], usage?: string, flags?: string[], subcommands?: string[] }} HelpRow
 * @typedef {ContractRowBase & { kind: "enum", argv: string[], option: string, values: string[] }} EnumRow
 * @typedef {ContractRowBase & { kind: "hidden-verb" | "json-shape", argv: string[], exits?: number[], check: (doc: any) => void }} JsonRow
 * @typedef {ContractRowBase & { kind: "config-path", path: string }} ConfigPathRow
 * @typedef {ContractRowBase & { kind: "sdk-export", subpath: string, names: string[] }} SdkExportRow
 * @typedef {HelpRow | EnumRow | JsonRow | ConfigPathRow | SdkExportRow} ContractRow
 */

const kRestartHandoffProtocol = "openclaw.gateway.restart-handoff";

const kPluginsDisabledConfigs = [
  { label: "plugins.allow=[telegram]", config: { plugins: { allow: ["telegram"] } } },
  {
    label: "clickclack disabled",
    config: { plugins: { entries: { clickclack: { enabled: false } } } },
  },
];

/** @type {ContractRow[]} */
const kCliContractRows = [
  // Backup and the capability-gated verbs.
  { kind: "help", argv: ["backup", "create"], flags: ["--output", "--verify", "--json"], site: "openclaw-runtime.js startBackup" },
  { kind: "help", argv: ["backup", "sqlite"], site: "openclaw-capabilities.js backupSqlite" },
  { kind: "help", argv: ["database", "preflight"], site: "openclaw-capabilities.js databasePreflight" },
  { kind: "help", argv: ["secrets", "store"], site: "openclaw-capabilities.js secretsStore" },
  { kind: "help", argv: ["update", "repair"], site: "openclaw-capabilities.js updateRepair" },
  // Exec approvals and config.
  { kind: "help", argv: ["approvals"], subcommands: ["get", "set", "pending"], site: "openclaw-capabilities.js execApprovalsCli/execApprovalsEra" },
  { kind: "help", argv: ["approvals", "get"], flags: ["--json"], site: "routes/nodes.js exec approvals" },
  { kind: "help", argv: ["approvals", "set"], flags: ["--file"], site: "exec approvals CLI backend" },
  { kind: "help", argv: ["config", "get"], flags: ["--json"], site: "routes/nodes.js exec config" },
  { kind: "help", argv: ["config", "set"], flags: ["--strict-json"], site: "routes/nodes.js exec config" },
  { kind: "config-path", path: "gateway.auth.trustedProxy.deviceAutoApprove.enabled", site: "openclaw-capabilities.js trustedProxyTeam" },
  // Doctor.
  { kind: "help", argv: ["doctor"], flags: ["--fix", "--yes", "--lint", "--json"], site: "doctor-fix-runner.js, watchdog.js, doctor/openclaw-doctor.js" },
  {
    kind: "json-shape",
    argv: ["doctor", "--lint", "--json"],
    // Exit 1 carries findings; exit 2 is the CLI failing before findings
    // (doctor/classify-doctor-cli.js).
    exits: [0, 1],
    site: "doctor/openclaw-doctor.js extractDoctorPayload",
    check: (doc) => {
      expect(Array.isArray(doc.findings)).toBe(true);
      expect(doc.findings.length).toBeGreaterThan(0);
      for (const finding of doc.findings) {
        expect(typeof finding.checkId).toBe("string");
        expect(["error", "warning", "info"]).toContain(finding.severity);
        expect(typeof finding.message).toBe("string");
      }
    },
  },
  // Gateway lifecycle, calls and the restart handoff.
  { kind: "help", argv: ["gateway", "run"], site: "gateway.js kGatewayLaunchSpawnArgs" },
  { kind: "help", argv: ["gateway", "restart"], flags: ["--wait"], site: "gateway.js stop ladder ask" },
  { kind: "help", argv: ["gateway", "call"], flags: ["--expect-final", "--json", "--timeout", "--params"], site: "doctor/service.js agent dispatch" },
  {
    kind: "hidden-verb",
    argv: ["gateway", "restart-handoff", "capabilities", "--json"],
    site: "openclaw-capabilities.js restartHandoff",
    check: (doc) => {
      expect(doc.protocol).toBe(kRestartHandoffProtocol);
      expect(Number(doc.protocolVersion)).toBeGreaterThanOrEqual(1);
      expect(doc.operations).toContain("consume");
    },
  },
  {
    kind: "hidden-verb",
    argv: ["gateway", "restart-handoff", "consume", "--expected-pid", "999999", "--json"],
    site: "gateway-restart-handoff.js runConsume",
    check: (doc) => {
      expect(doc.protocol).toBe(kRestartHandoffProtocol);
      expect(doc.status).toBe("none");
    },
  },
  {
    kind: "hidden-verb",
    argv: ["gateway", "restart-handoff", "consume", "--expected-pid", "not-a-pid", "--json"],
    exits: [2],
    site: "gateway-restart-handoff.js (exit 2 = invalid-expected-pid)",
    check: (doc) => {
      expect(doc.reason).toBe("invalid-expected-pid");
    },
  },
  { kind: "help", argv: ["dashboard"], flags: ["--no-open"], site: "gateway-dashboard-url.js" },
  // Channels.
  { kind: "help", argv: ["channels", "add"], flags: ["--channel", "--account", "--name"], site: "agents/channels.js, gateway.js channel sync" },
  { kind: "enum", argv: ["channels", "add"], option: "--channel", values: ["telegram", "discord", "slack", "whatsapp", "clickclack", "buzz"], site: "agents/channels.js, openclaw-capabilities.js buzzChannel" },
  { kind: "help", argv: ["channels", "add", "telegram"], usage: "channels add", flags: ["--token"], site: "agents/channels.js, gateway.js channel sync" },
  { kind: "help", argv: ["channels", "add", "discord"], usage: "channels add", flags: ["--token"], site: "agents/channels.js, gateway.js channel sync" },
  { kind: "help", argv: ["channels", "add", "slack"], usage: "channels add", flags: ["--bot-token", "--app-token"], site: "agents/channels.js, gateway.js channel sync" },
  { kind: "help", argv: ["channels", "add", "whatsapp"], usage: "channels add", flags: ["--account", "--name"], site: "agents/channels.js WhatsApp setup" },
  { kind: "help", argv: ["channels", "add", "clickclack"], usage: "channels add", flags: ["--code", "--token", "--base-url", "--account", "--name"], site: "agents/channels.js ClickClack setup, openclaw-capabilities.js clickclackCode" },
  ...kPluginsDisabledConfigs.flatMap(({ label, config }) => [
    { kind: "enum", argv: ["channels", "add"], option: "--channel", values: ["buzz", "clickclack"], config, site: `openclaw-capabilities.js buzzChannel with ${label}` },
    { kind: "help", argv: ["channels", "add", "clickclack"], usage: "channels add", flags: ["--code"], config, site: `openclaw-capabilities.js clickclackCode with ${label}` },
  ]),
  { kind: "help", argv: ["channels", "remove"], flags: ["--channel", "--account", "--delete"], site: "agents/channels.js, gateway.js channel sync" },
  { kind: "help", argv: ["channels", "login"], flags: ["--channel", "--account"], site: "agents/channels.js WhatsApp login" },
  { kind: "help", argv: ["channels", "status"], flags: ["--probe"], site: "buzz-setup.js" },
  { kind: "help", argv: ["agents", "bind"], flags: ["--agent", "--bind"], site: "agents/channels.js ClickClack bind" },
  { kind: "help", argv: ["message", "send"], flags: ["--channel", "--target", "--message"], site: "watchdog-notify.js sendWhatsApp" },
  { kind: "help", argv: ["agent"], flags: ["--agent", "--message", "--deliver", "--reply-channel", "--reply-to", "--reply-account", "--session-id"], site: "routes/system.js agent message" },
  // Pairing, devices and nodes.
  { kind: "help", argv: ["pairing", "list"], flags: ["--channel", "--json"], site: "routes/pairings.js" },
  { kind: "help", argv: ["pairing", "approve"], flags: ["--channel", "--account"], site: "routes/pairings.js" },
  {
    kind: "json-shape",
    argv: ["pairing", "list", "--channel", "telegram", "--json"],
    site: "routes/pairings.js parsePendingPairings",
    check: (doc) => {
      expect(Array.isArray(doc.requests)).toBe(true);
    },
  },
  { kind: "help", argv: ["devices", "list"], flags: ["--json"], site: "routes/pairings.js" },
  { kind: "help", argv: ["devices", "reject"], site: "routes/pairings.js" },
  { kind: "help", argv: ["devices", "remove"], site: "routes/nodes.js" },
  { kind: "help", argv: ["nodes", "status"], flags: ["--json"], site: "routes/nodes.js" },
  { kind: "help", argv: ["nodes", "pending"], flags: ["--json"], site: "routes/nodes.js" },
  { kind: "help", argv: ["nodes", "approve"], site: "routes/nodes.js" },
  { kind: "help", argv: ["nodes", "invoke"], flags: ["--node", "--command", "--params", "--invoke-timeout", "--json"], site: "routes/nodes.js browser proxy" },
  // Models, sessions, plugins.
  { kind: "help", argv: ["models", "list"], flags: ["--all", "--json"], site: "model-catalog-cache.js" },
  { kind: "help", argv: ["models", "set"], site: "routes/models.js, onboarding/index.js" },
  { kind: "help", argv: ["models", "status"], flags: ["--json"], site: "routes/models.js" },
  {
    kind: "json-shape",
    argv: ["models", "list", "--all", "--json"],
    site: "model-catalog-cache.js parseCatalogModelsFromOutput",
    check: (doc) => {
      expect(Array.isArray(doc.models)).toBe(true);
      expect(doc.models.length).toBeGreaterThan(0);
      for (const model of doc.models) expect(typeof model.key).toBe("string");
    },
  },
  {
    kind: "json-shape",
    argv: ["models", "status", "--json"],
    site: "routes/models.js /api/models/status",
    check: (doc) => {
      expect("resolvedDefault" in doc || "defaultModel" in doc).toBe(true);
      expect(Array.isArray(doc.fallbacks)).toBe(true);
      expect("imageModel" in doc).toBe(true);
    },
  },
  { kind: "help", argv: ["sessions"], flags: ["--json", "--all-agents"], site: "utils/agent-session-lookup.js" },
  {
    kind: "json-shape",
    argv: ["sessions", "--json", "--all-agents"],
    site: "utils/agent-session-lookup.js",
    check: (doc) => {
      expect(Array.isArray(doc.sessions)).toBe(true);
    },
  },
  { kind: "help", argv: ["plugins", "list"], flags: ["--json"], site: "gateway.js plugin preflight, scripts/reconcile-codex-plugin.js" },
  { kind: "help", argv: ["plugins", "install"], site: "buzz-setup.js" },
  {
    kind: "json-shape",
    argv: ["plugins", "list", "--json"],
    site: "scripts/reconcile-codex-plugin.js getInstalledCodexPlugin",
    check: (doc) => {
      expect(Array.isArray(doc.plugins)).toBe(true);
      expect(doc.plugins.length).toBeGreaterThan(0);
      for (const plugin of doc.plugins) {
        expect(typeof plugin.id).toBe("string");
        expect(typeof plugin.origin).toBe("string");
      }
    },
  },
  // Cron.
  { kind: "help", argv: ["cron", "run"], site: "cron-service.js runJobNow" },
  { kind: "help", argv: ["cron", "enable"], site: "cron-service.js setJobEnabled" },
  { kind: "help", argv: ["cron", "disable"], site: "cron-service.js setJobEnabled" },
  { kind: "help", argv: ["cron", "edit"], flags: ["--message", "--system-event", "--session", "--wake", "--announce", "--no-deliver", "--channel", "--to"], site: "cron-service.js updateJobPrompt/updateJobRouting" },
  { kind: "enum", argv: ["cron", "edit"], option: "--wake", values: ["now", "next-heartbeat"], site: "cron-service.js updateJobRouting" },
  // Onboarding.
  {
    kind: "help",
    argv: ["onboard"],
    flags: ["--non-interactive", "--accept-risk", "--flow", "--gateway-bind", "--gateway-port", "--gateway-auth", "--gateway-token", "--no-install-daemon", "--skip-health", "--workspace", "--auth-choice", "--token-provider", "--token", "--openai-api-key", "--anthropic-api-key", "--gemini-api-key"],
    site: "onboarding/openclaw.js buildOnboardArgs",
  },
  { kind: "enum", argv: ["onboard"], option: "--flow", values: ["quickstart"], site: "onboarding/openclaw.js buildOnboardArgs" },
  { kind: "enum", argv: ["onboard"], option: "--gateway-bind", values: ["loopback"], site: "onboarding/openclaw.js buildOnboardArgs" },
  { kind: "enum", argv: ["onboard"], option: "--gateway-auth", values: ["token"], site: "onboarding/openclaw.js buildOnboardArgs" },
  { kind: "enum", argv: ["onboard"], option: "--auth-choice", values: ["token", "apiKey", "openai-api-key", "gemini-api-key", "skip"], site: "onboarding/openclaw.js buildOnboardArgs" },
  // Plugin-sdk imports.
  { kind: "sdk-export", subpath: "plugin-sdk/device-bootstrap", names: ["approveDevicePairing"], site: "routes/pairings.js" },
  { kind: "sdk-export", subpath: "plugin-sdk/secret-input", names: ["coerceSecretRef"], site: "gateway-dashboard-url.js" },
  { kind: "sdk-export", subpath: "plugin-sdk/secret-ref-runtime", names: ["resolveSecretRefValues"], site: "gateway-dashboard-url.js" },
];

module.exports = { kCliContractRows };
