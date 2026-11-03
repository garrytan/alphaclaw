const path = require("path");
const { sanitizeLabel } = require("../utils/sanitize-label");
const { kAlphaclawHardeningPrefix } = require("../doctor/constants");

// OpenClaw's per-run system prompt report (SessionSystemPromptReport, the
// `contextWeight` of sessions.usage) reduced to what the Doctor tab and the
// admin op show. Paths become workspace-relative before workspaceDir is
// dropped, names are sanitized and bounded, and session keys never leave.
const kMaxFiles = 64;
const kTopEntries = 10;
const kMaxNameChars = 120;

const toCount = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
};

const cleanName = (value) => sanitizeLabel(String(value ?? ""), { maxLength: kMaxNameChars });

const toWorkspaceRelative = (filePath, workspaceDir, fallbackName) => {
  const raw = String(filePath || "");
  if (!raw) return cleanName(fallbackName);
  if (!path.isAbsolute(raw)) return cleanName(raw.split(path.sep).join("/"));
  const root = String(workspaceDir || "");
  if (root && path.isAbsolute(root)) {
    const relative = path.relative(root, raw);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return cleanName(relative.split(path.sep).join("/"));
    }
  }
  return cleanName(path.basename(raw));
};

const kSessionKinds = new Set(["main", "direct", "group", "cron", "subagent"]);

const classifySessionKind = (row = {}) => {
  const key = String(row.key || "");
  if (row.isMain === true || row.classification === "main") return "main";
  if (/:subagent:/.test(key) || row.kind === "subagent") return "subagent";
  if (/:cron:/.test(key) || row.kind === "cron") return "cron";
  if (row.kind === "group" || /:group:/.test(key)) return "group";
  return "direct";
};

const topEntries = (entries, valueKey) =>
  (Array.isArray(entries) ? entries : [])
    .map((entry) => ({ name: cleanName(entry?.name || "(unknown)"), chars: toCount(entry?.[valueKey]) }))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, kTopEntries);

const normalizeFiles = (files, workspaceDir) =>
  (Array.isArray(files) ? files : []).slice(0, kMaxFiles).map((file) => {
    const relativePath = toWorkspaceRelative(file?.path, workspaceDir, file?.name);
    const verified = file?.injectionStatus !== "native_unverified";
    return {
      path: relativePath,
      name: cleanName(file?.name || path.posix.basename(relativePath)),
      missing: file?.missing === true,
      rawChars: toCount(file?.rawChars),
      injectedChars: verified ? toCount(file?.injectedChars) : null,
      truncated: verified ? file?.truncated === true : null,
      verified,
      managed: relativePath.startsWith(kAlphaclawHardeningPrefix),
    };
  });

const normalizeContextWeight = (report, { sessionKind = "direct" } = {}) => {
  if (!report || typeof report !== "object" || report.source !== "run") return null;
  const files = normalizeFiles(report.injectedWorkspaceFiles, report.workspaceDir);
  const verifiedFiles = files.filter((file) => file.verified && !file.missing);
  const skills = report.skills || {};
  const tools = report.tools || {};
  const systemPrompt = report.systemPrompt || {};
  return {
    generatedAt: toCount(report.generatedAt) || null,
    provider: cleanName(report.provider || ""),
    model: cleanName(report.model || ""),
    sessionKind: kSessionKinds.has(sessionKind) ? sessionKind : "direct",
    bootstrapMaxChars: toCount(report.bootstrapMaxChars) || null,
    bootstrapTotalMaxChars: toCount(report.bootstrapTotalMaxChars) || null,
    systemPrompt: {
      chars: toCount(systemPrompt.chars),
      projectContextChars: toCount(systemPrompt.projectContextChars),
      nonProjectContextChars: toCount(systemPrompt.nonProjectContextChars),
    },
    currentTurn: report.currentTurn
      ? {
          promptChars: toCount(report.currentTurn.promptChars),
          runtimeContextChars: toCount(report.currentTurn.runtimeContextChars),
        }
      : null,
    files,
    filesTotal: {
      injectedChars: verifiedFiles.reduce((sum, file) => sum + file.injectedChars, 0),
      managedInjectedChars: verifiedFiles
        .filter((file) => file.managed)
        .reduce((sum, file) => sum + file.injectedChars, 0),
      truncatedFiles: verifiedFiles.filter((file) => file.truncated).length,
      unverifiedFiles: files.filter((file) => !file.verified).length,
    },
    skills: {
      promptChars: toCount(skills.promptChars),
      count: Array.isArray(skills.entries) ? skills.entries.length : 0,
      top: topEntries(skills.entries, "blockChars"),
    },
    tools: {
      schemaChars: toCount(tools.schemaChars),
      count: Array.isArray(tools.entries) ? tools.entries.length : 0,
      top: topEntries(tools.entries, "schemaChars"),
    },
  };
};

module.exports = { normalizeContextWeight, classifySessionKind, toWorkspaceRelative, kMaxFiles, kTopEntries };
