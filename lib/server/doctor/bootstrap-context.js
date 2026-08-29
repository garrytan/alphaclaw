const fs = require("fs");
const path = require("path");
const {
  kDoctorBootstrapMaxChars,
  kDoctorBootstrapMinFileBudgetChars,
  kDoctorBootstrapNearLimitRatio,
  kDoctorBootstrapTotalMaxChars,
  kDoctorContextTruncationGuidance,
  kStableProfile,
} = require("./context-profiles");
const { kAlphaclawHardeningPrefix, kDoctorCardSource } = require("./constants");
const { parsePositiveInt } = require("../utils/number");

// Models OpenClaw's Project Context injection so Drift Doctor can warn about
// truncation/starvation BEFORE the agent quietly loses guidance. This is an
// ESTIMATE of main-session injection: session-scope filtering, per-agent
// config, and upstream runtime accounting can differ — `/context` on the
// agent is authoritative. Facts and budgets live in ./context-profiles (with
// tarball citations); this module only applies them.
//
// Allocation model (verified upstream behavior, both versions):
//   per-file limit  = min(bootstrapMaxChars, USER.md hard cap on beta)
//   total budget    = bootstrapTotalMaxChars, spent in injection order —
//                     root files first (profile order), hook extras LAST, so
//                     extras starve first on oversized workspaces
//   remaining < 64  = the file is skipped entirely ("starved")

const readWorkspaceFileChars = (workspaceRoot, relativePath) => {
  const fullPath = path.join(workspaceRoot, relativePath);
  try {
    const content = fs.readFileSync(fullPath, "utf8");
    return { exists: true, chars: content.length };
  } catch {
    return { exists: false, chars: 0 };
  }
};

const effectiveFileCap = (profile, fileName, bootstrapMaxChars) => {
  if (profile.userFileCapChars && fileName === "USER.md") {
    return Math.min(bootstrapMaxChars, profile.userFileCapChars);
  }
  return bootstrapMaxChars;
};

const analyzeBootstrapContext = ({
  workspaceRoot = "",
  profile = kStableProfile,
  // Hook extras from openclaw.json hooks.internal.entries["bootstrap-extra-files"]
  // (workspace-relative paths). `hooksEnabled` covers BOTH hooks.internal.enabled
  // and the entry's own enabled flag.
  extraFilePaths = [],
  hooksEnabled = true,
  // BOOTSTRAP.md is gated on workspace-setup-completed state upstream;
  // AlphaClaw's onboarded.json marker is the documented proxy for it.
  onboarded = true,
  bootstrapMaxChars = kDoctorBootstrapMaxChars,
  bootstrapTotalMaxChars = kDoctorBootstrapTotalMaxChars,
  readFileChars = readWorkspaceFileChars,
} = {}) => {
  const allowedBasenames = new Set(profile.allowedExtraBasenames);

  const rootFiles = profile.injectedRootFiles.map((fileName) => {
    const fileState = readFileChars(workspaceRoot, fileName);
    const setupGated = fileName === "BOOTSTRAP.md" && onboarded;
    return {
      path: fileName,
      kind: "root",
      exists: fileState.exists,
      rawChars: fileState.chars,
      injectable: true,
      active: !setupGated,
      activeReason: setupGated ? "setup_gated" : "",
    };
  });

  const extraFiles = extraFilePaths.map((relativePath) => {
    const normalizedPath = String(relativePath || "").trim();
    // Upstream drops extras that resolve outside the workspace (security
    // diagnostic) and expands glob patterns; this estimator cannot expand
    // globs, so pattern entries are excluded from the budget model entirely
    // rather than misread as missing literal files.
    const isPattern = /[*?[]/.test(normalizedPath);
    const escapesWorkspace =
      !isPattern &&
      workspaceRoot &&
      !path
        .resolve(workspaceRoot, normalizedPath)
        .startsWith(`${path.resolve(workspaceRoot)}${path.sep}`);
    const fileState =
      isPattern || escapesWorkspace
        ? { exists: false, chars: 0 }
        : readFileChars(workspaceRoot, normalizedPath);
    const injectable =
      !escapesWorkspace && allowedBasenames.has(path.posix.basename(normalizedPath));
    return {
      path: normalizedPath,
      kind: "extra",
      exists: fileState.exists,
      rawChars: fileState.chars,
      injectable: isPattern ? true : injectable,
      active: hooksEnabled && injectable && !isPattern && !escapesWorkspace,
      activeReason: isPattern
        ? "pattern_unmodeled"
        : escapesWorkspace
          ? "escapes_workspace"
          : !hooksEnabled
            ? "hook_disabled"
            : !injectable
              ? "invalid_basename"
              : "",
    };
  });

  // Root files first, extras last — the order the total budget is spent in.
  const files = [...rootFiles, ...extraFiles].map((file) => {
    const capChars = effectiveFileCap(profile, file.path, bootstrapMaxChars);
    const fileLimitChars = Math.min(file.rawChars, capChars);
    return {
      ...file,
      capChars,
      fileLimitChars,
      injectedChars: 0,
      skipped: false,
      truncatedByFileLimit: file.rawChars > capChars,
      truncatedByTotalLimit: false,
      truncated: file.rawChars > capChars,
      nearFileLimit:
        file.rawChars > 0 &&
        file.rawChars <= capChars &&
        file.rawChars >= Math.floor(capChars * kDoctorBootstrapNearLimitRatio),
      reason: file.rawChars > capChars ? "file_limit" : "",
    };
  });

  let injectedTotalChars = 0;
  for (const file of files) {
    if (!file.active || !file.exists) continue;
    const remainingChars = Math.max(0, bootstrapTotalMaxChars - injectedTotalChars);
    if (remainingChars < kDoctorBootstrapMinFileBudgetChars) {
      // Upstream skips the file entirely below the minimum budget.
      file.skipped = true;
      file.truncatedByTotalLimit = true;
      file.truncated = true;
      file.reason = "starved";
      continue;
    }
    file.injectedChars = Math.min(file.fileLimitChars, remainingChars);
    file.truncatedByTotalLimit = file.fileLimitChars > file.injectedChars;
    file.truncated = file.truncatedByFileLimit || file.truncatedByTotalLimit;
    if (file.truncatedByFileLimit && file.truncatedByTotalLimit) {
      file.reason = "file_and_total_limit";
    } else if (file.truncatedByFileLimit) {
      file.reason = "file_limit";
    } else if (file.truncatedByTotalLimit) {
      file.reason = "total_limit";
    }
    injectedTotalChars += file.injectedChars;
  }

  const activeFiles = files.filter((file) => file.active && file.exists);
  const activeTruncatedFiles = activeFiles.filter((file) => file.truncated);
  const activeNearLimitFiles = activeFiles.filter(
    (file) => file.nearFileLimit && !file.truncated,
  );
  const inactiveTruncatedFiles = files.filter(
    (file) => !file.active && file.exists && file.truncated,
  );
  const blockedExtraFiles = files.filter(
    (file) => file.kind === "extra" && file.exists && !file.injectable,
  );
  const hasTotalLimitTruncation = activeTruncatedFiles.some(
    (file) =>
      file.reason === "total_limit" ||
      file.reason === "file_and_total_limit" ||
      file.reason === "starved",
  );
  const activeInjectedChars = activeFiles.reduce(
    (sum, file) => sum + file.injectedChars,
    0,
  );

  // AlphaClaw's own prompt-hardening extras (hooks/bootstrap/*): the state
  // that feeds the General-tab badge. "Partial" (starved OR truncated) and
  // "blocked" (basename-rejected) both mean the agent is not seeing the full
  // hardening rules. Emitting the P0 card for this state belongs to the
  // deterministic checks (single owner) — this is data only.
  const hardeningFiles = files.filter(
    (file) => file.kind === "extra" && file.path.startsWith(kAlphaclawHardeningPrefix),
  );
  const presentHardeningFiles = hardeningFiles.filter((file) => file.exists);
  let hardeningState = "unknown";
  if (presentHardeningFiles.length > 0) {
    if (presentHardeningFiles.some((file) => !file.injectable) || !hooksEnabled) {
      hardeningState = "blocked";
    } else if (presentHardeningFiles.some((file) => file.skipped || file.truncated)) {
      hardeningState = "starved";
    } else {
      hardeningState = "injected";
    }
  } else {
    // No hardening extra CONFIGURED — but if the merged hardening file exists
    // on disk, the config entry was lost (manual edit, upstream repair):
    // that's "blocked" (agent runs without safety rules), not "unknown".
    // The boot resync recreates the entry; this makes the gap loud meanwhile.
    const onDisk = readFileChars(workspaceRoot, "hooks/bootstrap/AGENTS.md");
    if (onDisk.exists) {
      hardeningState = "blocked";
      hardeningFiles.push({
        path: "hooks/bootstrap/AGENTS.md",
        kind: "extra",
        exists: true,
        rawChars: onDisk.chars,
        injectable: false,
        active: false,
        activeReason: "not_configured",
        skipped: false,
        truncated: false,
        reason: "not_configured",
      });
    }
  }

  return {
    estimated: true,
    profileId: profile.id,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    hooksEnabled,
    truncationGuidance: kDoctorContextTruncationGuidance,
    files,
    activeFiles,
    activeRawChars: activeFiles.reduce((sum, file) => sum + file.rawChars, 0),
    activeInjectedChars,
    hasActiveTruncation: activeTruncatedFiles.length > 0,
    hasActiveNearLimitFiles: activeNearLimitFiles.length > 0,
    hasActiveWarnings:
      activeTruncatedFiles.length > 0 || activeNearLimitFiles.length > 0,
    hasAnyTruncation:
      activeTruncatedFiles.length > 0 || inactiveTruncatedFiles.length > 0,
    activeTruncatedFiles,
    activeNearLimitFiles,
    inactiveTruncatedFiles,
    blockedExtraFiles,
    hasTotalLimitTruncation,
    totalLimitReached: activeInjectedChars >= bootstrapTotalMaxChars,
    nearTotalLimit:
      activeInjectedChars >=
      Math.floor(bootstrapTotalMaxChars * kDoctorBootstrapNearLimitRatio),
    hardening: {
      state: hardeningState,
      files: hardeningFiles.map((file) => ({
        path: file.path,
        exists: file.exists,
        injectable: file.injectable,
        skipped: file.skipped,
        truncated: file.truncated,
        reason: file.reason || file.activeReason || "",
      })),
    },
  };
};

// Stat-cached analyzer for the status hot path (every buildStatus call plus
// the 30s SSE tick). One mtime+size-keyed cache covers ALL analyzer inputs:
// each context file AND the openclaw.json read (budget overrides, hook
// enablement, extras list) — openclaw-config.js has no caching of its own.
const createBootstrapContextAnalyzer = ({
  workspaceRoot,
  managedRoot = "",
  getProfile = () => kStableProfile,
  readOpenclawConfig = null,
  isOnboarded = () => true,
  fsModule = fs,
} = {}) => {
  const fileCache = new Map();
  const configCache = { statKey: "", value: null };

  const statKeyFor = (fullPath) => {
    try {
      const stat = fsModule.statSync(fullPath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  };

  const readFileCharsCached = (rootDir, relativePath) => {
    const fullPath = path.join(rootDir, relativePath);
    const statKey = statKeyFor(fullPath);
    const cached = fileCache.get(fullPath);
    if (cached && cached.statKey === statKey) return cached.value;
    let value;
    if (statKey === "missing") {
      value = { exists: false, chars: 0 };
    } else {
      try {
        value = {
          exists: true,
          chars: fsModule.readFileSync(fullPath, "utf8").length,
        };
      } catch {
        value = { exists: false, chars: 0 };
      }
    }
    fileCache.set(fullPath, { statKey, value });
    return value;
  };

  const readConfigInputs = () => {
    if (!readOpenclawConfig || !managedRoot) {
      return {
        extraFilePaths: [],
        hooksEnabled: false,
        bootstrapMaxChars: kDoctorBootstrapMaxChars,
        bootstrapTotalMaxChars: kDoctorBootstrapTotalMaxChars,
      };
    }
    const configPath = path.join(managedRoot, "openclaw.json");
    const statKey = statKeyFor(configPath);
    if (configCache.statKey === statKey && configCache.value) {
      return configCache.value;
    }
    let config = null;
    try {
      config = readOpenclawConfig({ openclawDir: managedRoot, fallback: null });
    } catch {
      config = null;
    }
    const hooksInternal = config?.hooks?.internal;
    const entry = hooksInternal?.entries?.["bootstrap-extra-files"];
    const extraFilePaths = Array.isArray(entry?.paths)
      ? entry.paths.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    const hooksEnabled = hooksInternal?.enabled === true && entry?.enabled === true;
    const defaults = config?.agents?.defaults || {};
    const value = {
      extraFilePaths,
      hooksEnabled,
      bootstrapMaxChars: parsePositiveInt(
        defaults.bootstrapMaxChars,
        kDoctorBootstrapMaxChars,
      ),
      bootstrapTotalMaxChars: parsePositiveInt(
        defaults.bootstrapTotalMaxChars,
        kDoctorBootstrapTotalMaxChars,
      ),
    };
    configCache.statKey = statKey;
    configCache.value = value;
    return value;
  };

  const analyze = () => {
    const profile = getProfile() || kStableProfile;
    const configInputs = readConfigInputs();
    return analyzeBootstrapContext({
      workspaceRoot,
      profile,
      extraFilePaths: configInputs.extraFilePaths,
      hooksEnabled: configInputs.hooksEnabled,
      onboarded: safeIsOnboarded(isOnboarded),
      bootstrapMaxChars: configInputs.bootstrapMaxChars,
      bootstrapTotalMaxChars: configInputs.bootstrapTotalMaxChars,
      readFileChars: readFileCharsCached,
    });
  };

  return { analyze };
};

const safeIsOnboarded = (isOnboarded) => {
  try {
    return isOnboarded() !== false;
  } catch {
    return true;
  }
};

const formatChars = (value = 0) => `${Number(value || 0).toLocaleString()} chars`;

// Generic Project Context truncation cards. The AlphaClaw-hardening P0 card
// is deliberately NOT emitted here — the deterministic checks are its single
// owner (one source_key); this module only supplies the analyzed state.
// Cards carry their own structured identity (source/sourceKey) — the module
// that creates a card owns its dedupe key; deriving it elsewhere from the
// display title would break dismissal suppression on any copy edit.
const buildBootstrapTruncationCards = (bootstrapContext = null) => {
  if (!bootstrapContext?.hasActiveTruncation) return [];

  const cards = bootstrapContext.activeTruncatedFiles
    .filter((file) => file.reason === "file_limit")
    .map((file) => ({
      source: kDoctorCardSource.bootstrap,
      sourceKey: `boot:file_limit:${file.path}`,
      priority: "P0",
      category: "project context",
      title: `${file.path} is being truncated in Project Context`,
      summary:
        `${file.path} is ${formatChars(file.rawChars)}, above its per-file Project Context limit ` +
        `of ${formatChars(file.capChars)}. The agent is not seeing the full file.`,
      recommendation:
        `Move the most important rules to the top of ${file.path}, shorten or split low-priority content, ` +
        `and increase OpenClaw's bootstrap limits if this file legitimately needs more room. ` +
        bootstrapContext.truncationGuidance,
      evidence: [
        { type: "path", path: file.path },
        {
          type: "text",
          text:
            `Raw size: ${formatChars(file.rawChars)}. ` +
            `Per-file limit: ${formatChars(file.capChars)}.`,
        },
      ],
      targetPaths: [{ path: file.path }],
      fixPrompt:
        `Reorganize ${file.path} so the most important instructions appear at the top and reduce unnecessary length. ` +
        `Do not change unrelated behavior.`,
      status: "open",
    }));

  const totalLimitedFiles = bootstrapContext.activeTruncatedFiles.filter(
    (file) =>
      file.reason === "total_limit" ||
      file.reason === "file_and_total_limit" ||
      file.reason === "starved",
  );
  if (totalLimitedFiles.length > 0) {
    cards.unshift({
      source: kDoctorCardSource.bootstrap,
      sourceKey: "boot:total_limit",
      priority: "P0",
      category: "project context",
      title: "Project Context total bootstrap limit is truncating injected files",
      summary:
        `Injected workspace guidance needs ${formatChars(bootstrapContext.activeRawChars)} raw across active ` +
        `Project Context files, exceeding the total bootstrap budget of ` +
        `${formatChars(bootstrapContext.bootstrapTotalMaxChars)}. Files late in the injection order ` +
        `(including AlphaClaw's hooks/bootstrap extras) are cut first.`,
      recommendation:
        `Reduce total Project Context size across injected guidance files, keep critical instructions near the top, ` +
        `and raise OpenClaw's total bootstrap budget if the workspace legitimately needs more injected guidance. ` +
        bootstrapContext.truncationGuidance,
      evidence: totalLimitedFiles.map((file) => ({
        type: "text",
        text:
          file.reason === "starved"
            ? `${file.path}: raw ${formatChars(file.rawChars)}, skipped entirely — the total budget was exhausted before it.`
            : `${file.path}: raw ${formatChars(file.rawChars)}, injected ${formatChars(file.injectedChars)} ` +
              `before the total limit stopped more content from being included.`,
      })),
      targetPaths: totalLimitedFiles.map((file) => ({ path: file.path })),
      fixPrompt:
        `Reduce the combined size of the affected Project Context files and keep the most important instructions near the top. ` +
        `Only edit the files listed in the finding.`,
      status: "open",
    });
  }

  return cards;
};

module.exports = {
  analyzeBootstrapContext,
  buildBootstrapTruncationCards,
  createBootstrapContextAnalyzer,
  formatChars,
};
