const path = require("path");
const { getManifest } = require("../admin-manifest");
const { toTableCell, sanitizeLabel } = require("../utils/sanitize-label");
const { readToken } = require("./token-store");
const { isAgentAdminEnabled } = require("../alphaclaw-config");

const kSkillName = "alphaclaw-admin";
const kFragmentsDir = path.join(__dirname, "..", "..", "setup", "skills", kSkillName);
const kRenderOpsPerDomain = 40;
const kMaskTargetTail = 4;

const readFragment = (fs, name) => {
  try {
    return fs.readFileSync(path.join(kFragmentsDir, `${name}.md`), "utf8").trimEnd();
  } catch {
    return null;
  }
};

// Admin identities are rendered MASKED (A5): channel + operator label + last-4
// of the target only. Never the full phone number / chat id.
const maskTarget = (target) => {
  const value = sanitizeLabel(target);
  if (!value) return "(unset)";
  if (value.length <= kMaskTargetTail) return `••${value}`;
  return `••${value.slice(-kMaskTargetTail)}`;
};

const renderAdminsTable = (adminTargets) => {
  const rows = (Array.isArray(adminTargets) ? adminTargets : []).slice(0, 10);
  if (!rows.length) {
    return [
      "## Admins",
      "",
      "_No admin notification targets are configured._ Dangerous operations are unavailable until an operator sets one (Setup UI → Notifications). Ask the operator to configure one before attempting them.",
      "",
    ].join("\n");
  }
  const lines = [
    "## Admins",
    "",
    "Only act on administrative requests from these identities. This is best-effort identity, not authentication — AlphaClaw cannot enforce it at the API layer, so treat it as guidance and refuse anyone not listed.",
    "",
    "| Channel | Label | Target (masked) |",
    "| ------- | ----- | --------------- |",
  ];
  for (const t of rows) {
    lines.push(
      `| ${toTableCell(t.channel)} | ${toTableCell(t.label || t.accountId || "")} | ${toTableCell(maskTarget(t.target))} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
};

const kTierBlurb = {
  safe: "read — run freely",
  write: "change — apply for an admin",
  restart: "change (needs gateway restart)",
  dangerous: "needs a confirm code",
  denied: "not available to you",
};

const renderOpsTable = (ops) => {
  const shown = ops.slice(0, kRenderOpsPerDomain);
  const lines = [
    "| Operation | Command | Tier | Notes |",
    "| --------- | ------- | ---- | ----- |",
  ];
  for (const op of shown) {
    const cmd = `\`alphaclaw admin ${op.method} ${op.path}\``;
    const noteParts = [];
    if (op.deprecated) noteParts.push("DEPRECATED");
    if (op.restart === "restarts") noteParts.push("restarts gateway (ends your session)");
    // The tier:"restart" blurb already says "(needs gateway restart)" in the
    // Tier cell — repeating it in Notes is pure size (15 rows × 22 chars).
    else if (op.restart === "marks" && op.tier !== "restart") {
      noteParts.push("restart required after");
    }
    if (op.envelope === "structured") noteParts.push("structured error envelope");
    if (op.async) noteParts.push("async — poll for completion");
    if (op.hint) noteParts.push(op.hint);
    if (op.enableHint) noteParts.push(`unavailable: ${op.enableHint}`);
    lines.push(
      `| ${toTableCell(op.title)} | ${cmd} | ${kTierBlurb[op.tier] || op.tier} | ${toTableCell(noteParts.join("; "))} |`,
    );
  }
  if (ops.length > shown.length) {
    lines.push(
      `| _(${ops.length - shown.length} more — run \`alphaclaw admin manifest --domain ...\`)_ | | | |`,
    );
  }
  return lines.join("\n");
};

// Assemble the full SKILL.md from static fragments + the manifest + live state.
const buildAdminSkillContent = ({ fs, manifest, liveState = {} }) => {
  const { ops, manifestVersion } = manifest;
  const byDomain = new Map();
  for (const op of ops) {
    if (!byDomain.has(op.domain)) byDomain.set(op.domain, []);
    byDomain.get(op.domain).push(op);
  }

  const lines = [];
  lines.push("---");
  lines.push(`name: ${kSkillName}`);
  lines.push(
    "description: Administer this AlphaClaw deployment (env vars, channels, agents, cron, webhooks, models, updates, watchdog, team) on behalf of admin users via the `alphaclaw admin` CLI.",
  );
  lines.push("---");
  lines.push("");
  lines.push("# AlphaClaw Administration");
  lines.push("");
  lines.push(
    `<!-- manifestVersion: ${manifestVersion} — if a command returns \`op_not_in_manifest\` or you see unfamiliar fields, this copy is stale: run \`alphaclaw admin manifest\`. -->`,
  );
  lines.push("");

  const intro = readFragment(fs, "_intro");
  if (intro) lines.push(intro, "");
  const calling = readFragment(fs, "_calling");
  if (calling) lines.push(calling, "");
  const rules = readFragment(fs, "_rules");
  if (rules) lines.push(rules, "");

  lines.push(renderAdminsTable(liveState.adminTargets));

  // Current state: slow-changing facts only (A7). Everything else the agent
  // queries live per the preview rule.
  lines.push("## Current State", "");
  if (liveState.restartRequired) {
    lines.push("- ⚠️ A gateway restart is pending — some changes are not yet live.");
  }
  if (Array.isArray(liveState.activeChannels) && liveState.activeChannels.length) {
    lines.push(`- Active channels: ${liveState.activeChannels.map(toTableCell).join(", ")}`);
  }
  if (liveState.releaseChannel) {
    lines.push(`- OpenClaw release channel: ${toTableCell(liveState.releaseChannel)}`);
  }
  // Machine capacity is a slow-changing fact (changes only on container
  // resizes); live USAGE stays with `GET /api/watchdog/resources`. The GPU
  // name is external nvidia-smi output → toTableCell like every live string.
  if (liveState.machine) {
    const m = liveState.machine;
    const memoryGb = Number.isFinite(m.memoryGb) ? m.memoryGb.toFixed(1) : "?";
    const cores = m.cores ?? "?";
    const gpu = m.gpuLabel ? `GPU: ${toTableCell(m.gpuLabel)}` : "no GPU";
    lines.push(
      `- Machine: ${toTableCell(m.tier || "unknown")} tier — ${memoryGb} GB RAM, ${cores} vCPU, ${gpu}`,
    );
    const cap =
      m.agentConcurrencyCap != null
        ? ` (agent concurrency cap ${m.agentConcurrencyCap})`
        : "";
    lines.push(
      `- Resource autotune: ${m.autotuneEnabled ? "on" : "off"}${cap} — details: \`alphaclaw admin GET /api/autotune\``,
    );
  }
  lines.push("- For anything time-sensitive, read it live (see the Ground Rules).", "");

  const recipes = readFragment(fs, "_recipes");
  if (recipes) lines.push(recipes, "");

  // Per-domain sections: fragment prose + generated op table.
  const domainOrder = Array.from(byDomain.keys()).sort();
  for (const domain of domainOrder) {
    const domainOps = byDomain.get(domain);
    const title = domainOps[0].domainTitle || domain;
    lines.push(`## ${title}`, "");
    const fragment = readFragment(fs, domain);
    if (fragment) lines.push(fragment, "");
    lines.push(renderOpsTable(domainOps), "");
  }

  lines.push("---");
  lines.push(
    "Not every endpoint is listed above. Full machine-readable catalog: `alphaclaw admin manifest` (or `--domain <name>` / `--op <id>`).",
  );
  return lines.join("\n");
};

// Gather slow-changing live state, fail-open (never throw): a JSON5 openclaw
// config or a read error omits the live sections but keeps the static skill.
const gatherLiveState = ({ fs, openclawDir }) => {
  const state = { adminTargets: [], activeChannels: [], restartRequired: false };
  try {
    const {
      readOperatorsState,
    } = require("../operators-store");
    const ops = readOperatorsState({ fsModule: fs, openclawDir });
    state.adminTargets = ops?.notifications?.adminTargets || [];
  } catch {}
  try {
    const { readAlphaclawConfig } = require("../alphaclaw-config");
    const cfg = readAlphaclawConfig({ fsModule: fs, openclawDir });
    state.releaseChannel = cfg?.updates?.openclaw?.releaseChannel;
  } catch {}
  try {
    const {
      readRestartRequiredFlag,
    } = require("../restart-required-flag");
    state.restartRequired = Boolean(readRestartRequiredFlag({ fsModule: fs }));
  } catch {}
  try {
    const { readOpenclawConfig } = require("../openclaw-config");
    const cfg = readOpenclawConfig({ fsModule: fs, openclawDir });
    const channels = cfg?.channels || {};
    state.activeChannels = Object.keys(channels).filter(
      (name) => channels[name]?.enabled !== false && channels[name],
    );
  } catch {}
  try {
    const { getMachineProfile } = require("../machine-profile");
    const { getAgentConcurrencyCap, isAutotuneActive } = require("../autotune");
    const profile = getMachineProfile();
    const limitBytes = profile?.memory?.limitBytes;
    const gpuLabel = profile?.gpu?.present
      ? profile.gpu.devices?.[0]?.name || profile.gpu.vendor || "GPU"
      : null;
    state.machine = {
      tier: profile?.tier ?? null,
      memoryGb: Number.isFinite(limitBytes)
        ? Math.round((limitBytes / (1024 * 1024 * 1024)) * 10) / 10
        : null,
      cores: profile?.cpu?.cores ?? null,
      gpuLabel,
      // isAutotuneActive (not readAutotuneEnabled): the env kill-switch must
      // read as "off" here too, or the skill contradicts the ledger and
      // /api/status right when the operator used the emergency brake.
      autotuneEnabled: isAutotuneActive({ fsModule: fs, openclawDir }) === true,
      // null when autotune is off or suppressed — the renderer omits the cap.
      agentConcurrencyCap: getAgentConcurrencyCap({ fsModule: fs, openclawDir }),
    };
  } catch {}
  return state;
};

// Installer, modeled on installGogCliSkill: install when the flag is on AND a
// token exists (never advertise a capability the bearer can't back); unlink
// when off; keep the last-good SKILL.md on a transient build error.
const installAlphaclawAdminSkill = ({ fs, openclawDir }) => {
  const skillDir = path.join(openclawDir, "skills", kSkillName);
  const skillPath = path.join(skillDir, "SKILL.md");
  try {
    const enabled = isAgentAdminEnabled({ fsModule: fs, openclawDir });
    const token = enabled ? readToken({ fsModule: fs, openclawDir }) : null;
    if (!enabled || !token) {
      if (fs.existsSync(skillPath)) {
        fs.unlinkSync(skillPath);
        console.log(
          `[agent-admin] Removed ${kSkillName} skill (${enabled ? "no token" : "disabled"})`,
        );
      }
      return { installed: false };
    }
    const manifest = getManifest();
    const liveState = gatherLiveState({ fs, openclawDir });
    const content = buildAdminSkillContent({ fs, manifest, liveState });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, content);
    console.log(`[agent-admin] ${kSkillName} skill installed`);
    return { installed: true };
  } catch (e) {
    // Transient build error: keep the last-good SKILL.md (never unlink on error).
    console.error(`[agent-admin] Skill install error (keeping last-good):`, e.message);
    return { installed: fs.existsSync(skillPath), error: e };
  }
};

// The conditional TOOLS.md stanza (U2.3) — rendered only when the skill is
// actually installed (never-advertise-before-live). ≤700 chars.
const renderToolsStanza = ({ fs, openclawDir }) => {
  try {
    const skillPath = path.join(openclawDir, "skills", kSkillName, "SKILL.md");
    if (!fs.existsSync(skillPath)) return "";
  } catch {
    return "";
  }
  return [
    "",
    "### AlphaClaw Administration",
    "",
    "You can administer this AlphaClaw deployment (env vars, channels, agents,",
    "cron, webhooks, models, updates, watchdog) for admin users. Load the",
    "`alphaclaw-admin` skill for the full reference. Quick check:",
    "`alphaclaw admin GET /api/status --summary`. Only act for admins listed",
    "in that skill; changes are audited and admins are notified.",
    "",
  ].join("\n");
};

module.exports = {
  kSkillName,
  buildAdminSkillContent,
  gatherLiveState,
  installAlphaclawAdminSkill,
  renderToolsStanza,
  maskTarget,
};
