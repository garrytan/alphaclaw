const fs = require("fs");
const path = require("path");
const {
  formatDoctorMissingFileMarker,
  kDoctorBootstrapMaxChars,
  kDoctorBootstrapMinFileBudgetChars,
  kDoctorBootstrapNearLimitRatio,
  kDoctorBootstrapTotalMaxChars,
  kDoctorContextTruncationGuidance,
  kStableProfile,
} = require("./context-profiles");
const { kAlphaclawHardeningPrefix, kDoctorCardSource } = require("./constants");

// Models OpenClaw's Project Context injection so Drift Doctor can warn about
// truncation/starvation BEFORE the agent quietly loses guidance. This is an
// ESTIMATE of main-session injection: session-scope filtering, per-agent
// config, and upstream runtime accounting can differ — `/context` on the
// agent is authoritative. Facts and budgets live in ./context-profiles (with
// tarball citations); this module only applies them.
//
// Allocation model (verified upstream behavior, both versions):
//   raw read cap    = 2 MiB per file, enforced BEFORE any budgeting: an
//                     over-cap file is rejected outright, never truncated
//                     (see kDoctorBootstrapReadMaxBytes below)
//   per-file limit  = min(bootstrapMaxChars, USER.md hard cap on beta —
//                     applied by BASENAME, so extras named USER.md count)
//   total budget    = bootstrapTotalMaxChars, spent in injection order —
//                     root files first (profile order), hook extras LAST, so
//                     extras starve first on oversized workspaces
//   missing root    = a "[MISSING] Expected at: <path>" marker charged to the
//                     total budget (clamped to the remaining budget; exempt
//                     from the per-file cap and the 64-char floor). Profile
//                     omit-list files charge nothing; missing extras are
//                     never appended by the hook at all.
//   remaining < 64  = the allocator STOPS: every later file (and marker) is
//                     dropped ("starved")

// Upstream reads every bootstrap file (root and extra) through a guarded
// open that REJECTS the whole read — it never truncates — when the file
// exceeds 2 MiB: stable dist/workspace-DkQ7irPD.js openRootFile({ maxBytes:
// MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES }) fails the open outright
// (dist/pinned-open-CED4V9Dl.js `stat.size > maxBytes` → validation); beta
// dist/workspace-bootstrap-read-BUXIGyyB.js readFileDescriptorBounded throws
// past the cap. See docs/designs/openclaw-context-contract.md ("Raw read
// cap"). Modeling an over-cap file as injected would hide that the agent
// never receives it — and buffering it here would stall the status hot path.
const kDoctorBootstrapReadMaxBytes = 2 * 1024 * 1024;

// Bounded, containment-checked read shared by the plain and stat-cached
// readers. Returns { exists, chars } plus a `rejected` reason when the
// guarded open upstream would refuse the file:
//   "escapes_workspace" — the resolved real path leaves the workspace (an
//     in-workspace symlink pointing outside; same realpath guard as
//     service.js readFileSnippet — upstream's openRootFile boundary check
//     rejects it, contract doc "pattern resolves outside the workspace")
//   "file_too_large"    — above upstream's 2 MiB read cap (rejected, never
//     truncated — see kDoctorBootstrapReadMaxBytes)
// Rejected files keep exists:false — like a lexically escaping extra, the
// file may be on disk but its content is never injected.
const readBoundedWorkspaceFileChars = (fsModule, rootDir, relativePath) => {
  const fullPath = path.join(rootDir, relativePath);
  try {
    const realRoot = fsModule.realpathSync(path.resolve(rootDir));
    const realPath = fsModule.realpathSync(fullPath);
    if (!realPath.startsWith(realRoot + path.sep)) {
      return { exists: false, chars: 0, rejected: "escapes_workspace" };
    }
    // fd-based read so nothing larger than the cap is ever buffered.
    const fd = fsModule.openSync(realPath, "r");
    try {
      const stats = fsModule.fstatSync(fd);
      if (!stats.isFile()) return { exists: false, chars: 0 };
      if (stats.size > kDoctorBootstrapReadMaxBytes) {
        return { exists: false, chars: 0, rejected: "file_too_large" };
      }
      const buffer = Buffer.allocUnsafe(stats.size);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = fsModule.readSync(
          fd,
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead,
        );
        if (chunk <= 0) break;
        bytesRead += chunk;
      }
      return {
        exists: true,
        chars: buffer.toString("utf8", 0, bytesRead).length,
      };
    } finally {
      fsModule.closeSync(fd);
    }
  } catch {
    return { exists: false, chars: 0 };
  }
};

const readWorkspaceFileChars = (workspaceRoot, relativePath) =>
  readBoundedWorkspaceFileChars(fs, workspaceRoot, relativePath);

const effectiveFileCap = (profile, filePath, bootstrapMaxChars) => {
  // Upstream applies the USER cap by BASENAME, case-insensitively (beta dist
  // bootstrap-budget-*.js effectiveBootstrapFileLimit: `name.toLowerCase()
  // === "user.md"` where name is the basename) — an extra configured as
  // hooks/bootstrap/USER.md gets the same fixed cap as the root file.
  if (
    profile.userFileCapChars &&
    path.posix.basename(String(filePath || "")).toLowerCase() === "user.md"
  ) {
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
  // openclaw.json exists on disk but our strict JSON parser could not read it
  // (openclaw itself accepts JSON5/${ENV}/$include configs — see
  // openclaw-config.js). The extras list is then UNKNOWN, not empty.
  configUnreadable = false,
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
    // The lexical check above cannot see an in-workspace symlink pointing
    // outside the workspace, and cannot know the file exceeds upstream's
    // 2 MiB read cap — readFileChars performs both guards at read time and
    // reports them as `rejected`. Upstream refuses either read the same way
    // (security diagnostic, file omitted), so a rejected extra models exactly
    // like a lexically escaping one: never injected, exists stays false.
    const rejectedReason = escapesWorkspace
      ? "escapes_workspace"
      : !isPattern
        ? String(fileState.rejected || "")
        : "";
    const injectable =
      !rejectedReason && allowedBasenames.has(path.posix.basename(normalizedPath));
    return {
      path: normalizedPath,
      kind: "extra",
      exists: fileState.exists,
      rawChars: fileState.chars,
      injectable: isPattern ? true : injectable,
      active: hooksEnabled && injectable && !isPattern && !rejectedReason,
      activeReason: isPattern
        ? "pattern_unmodeled"
        : rejectedReason
          ? rejectedReason
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
      missingMarkerChars: 0,
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

  const omittedWhenAbsent = new Set(profile.omittedWhenAbsentRootFiles || []);
  let spentTotalChars = 0;
  let missingMarkerChars = 0;
  // Mirrors the upstream allocator's `break`: once the total budget is
  // exhausted (or the <64-char floor is hit by a content file), NOTHING later
  // is injected — not even missing-file markers.
  let allocatorStopped = false;
  for (const file of files) {
    if (!file.active) continue;
    const remainingChars = Math.max(0, bootstrapTotalMaxChars - spentTotalChars);
    if (remainingChars <= 0) allocatorStopped = true;
    if (!file.exists) {
      // A missing ROOT file still costs budget: upstream injects a visible
      // "[MISSING] Expected at: <path>" marker charged to the TOTAL budget,
      // clamped to the remaining budget and exempt from both the per-file cap
      // and the 64-char floor (the allocator's missing branch runs before
      // that check). Profile omit-list files (MEMORY.md; USER.md on beta) are
      // dropped with no marker, and missing extras are never appended by the
      // hook loader at all.
      if (
        allocatorStopped ||
        file.kind !== "root" ||
        omittedWhenAbsent.has(file.path)
      ) {
        continue;
      }
      file.missingMarkerChars = Math.min(
        formatDoctorMissingFileMarker(path.join(workspaceRoot, file.path)).length,
        remainingChars,
      );
      spentTotalChars += file.missingMarkerChars;
      missingMarkerChars += file.missingMarkerChars;
      continue;
    }
    if (allocatorStopped || remainingChars < kDoctorBootstrapMinFileBudgetChars) {
      // Upstream stops the allocator entirely below the minimum budget.
      allocatorStopped = true;
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
    spentTotalChars += file.injectedChars;
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
  // Total context spend as upstream sees it: injected file content PLUS the
  // missing-file markers. Markers stay out of the per-file rows (activeFiles
  // holds existing files only; per-file marker costs live on
  // file.missingMarkerChars) but must count in the meter total and the
  // total-limit flags, or the model under-reports near-limit pressure.
  const activeInjectedChars =
    activeFiles.reduce((sum, file) => sum + file.injectedChars, 0) +
    missingMarkerChars;

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
  let hardeningReason = "";
  if (presentHardeningFiles.length > 0) {
    if (presentHardeningFiles.some((file) => !file.injectable) || !hooksEnabled) {
      hardeningState = "blocked";
    } else if (presentHardeningFiles.some((file) => file.skipped || file.truncated)) {
      hardeningState = "starved";
    } else {
      hardeningState = "injected";
    }
  } else if (
    !configUnreadable &&
    hardeningFiles.some((file) => file.activeReason !== "pattern_unmodeled")
  ) {
    // Hardening extras ARE configured (in a readable config) but none of the
    // literal entries exist on disk. The boot resync rewrites the file, so
    // this state means something removed it since — the agent receives no
    // safety rules. Loud is right: "blocked", never a neutral "unknown".
    // Pattern entries stay unmodeled (globs may match files this estimator
    // cannot see) and fall through to the on-disk check below.
    //
    // Per docs/designs/openclaw-context-contract.md ("Raw read cap"), a
    // rejected read (escaping symlink, over-cap file) keeps upstream's
    // missing/omitted semantics — per-file `exists` stays false — but OUR
    // top-level diagnosis must name the true cause: "missing_file" advice
    // ("restart, the resync rewrites it") cannot fix a symlink escape or a
    // >2 MiB file. Deterministic precedence when causes are mixed across
    // files (severity order, never first-file-wins):
    //   escapes_workspace > file_too_large > missing_file
    hardeningState = "blocked";
    const kRejectedReadPrecedence = ["escapes_workspace", "file_too_large"];
    hardeningReason =
      kRejectedReadPrecedence.find((reason) =>
        hardeningFiles.some((file) => file.activeReason === reason),
      ) || "missing_file";
  } else if (configUnreadable) {
    // openclaw.json exists but is unreadable to our strict parser (a legal
    // JSON5/${ENV}/$include config upstream): the extras list is unknown, so
    // "no hardening extra modeled" proves nothing. Mirroring the onboarding
    // reconcile doctrine, an unreadable config is not ours to judge — report
    // "unknown", never a false permanent "blocked" P0.
    hardeningState = "unknown";
    hardeningReason = "config_unreadable";
  } else {
    // No hardening extra CONFIGURED — but if the merged hardening file exists
    // on disk, the config entry was lost (manual edit, upstream repair):
    // that's "blocked" (agent runs without safety rules), not "unknown".
    // The boot resync recreates the entry; this makes the gap loud meanwhile.
    // A rejected read (escaping symlink, over-cap file) still counts as "on
    // disk": the entry is gone AND the file is uninjectable — loud either way.
    const onDisk = readFileChars(workspaceRoot, "hooks/bootstrap/AGENTS.md");
    if (onDisk.exists || onDisk.rejected) {
      hardeningState = "blocked";
      hardeningFiles.push({
        path: "hooks/bootstrap/AGENTS.md",
        kind: "extra",
        exists: onDisk.exists,
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
    missingMarkerChars,
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
      reason: hardeningReason,
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

// Mirrors the bundled handler's config-key alias ladder exactly (dist
// bundled/bootstrap-extra-files/handler.js resolveExtraBootstrapPatterns):
// trimmed-string-list normalization per key, then paths if non-empty, ELSE
// patterns if non-empty, ELSE files. A config using the patterns/files
// aliases injects extras upstream, so modeling only entry.paths misread it
// as "no extras" (false hardening-blocked, missed budget accounting).
const normalizeTrimmedStringList = (value) =>
  Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];

const resolveExtraBootstrapPatterns = (entry) => {
  const fromPaths = normalizeTrimmedStringList(entry?.paths);
  if (fromPaths.length > 0) return fromPaths;
  const fromPatterns = normalizeTrimmedStringList(entry?.patterns);
  if (fromPatterns.length > 0) return fromPatterns;
  return normalizeTrimmedStringList(entry?.files);
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
    // Same containment + 2 MiB rejection as the plain reader (statSync above
    // follows symlinks, so the cache key tracks the resolved target).
    const value =
      statKey === "missing"
        ? { exists: false, chars: 0 }
        : readBoundedWorkspaceFileChars(fsModule, rootDir, relativePath);
    fileCache.set(fullPath, { statKey, value });
    return value;
  };

  const readConfigInputs = () => {
    if (!readOpenclawConfig || !managedRoot) {
      return {
        extraFilePaths: [],
        hooksEnabled: false,
        configUnreadable: false,
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
    // A null read with the config file PRESENT on disk means our strict
    // parser cannot read it (JSON5/${ENV}/$include are legal upstream) — not
    // that nothing is configured. A missing file is a fresh install and keeps
    // the "no extras" modeling.
    const configUnreadable = config == null && statKey !== "missing";
    const hooksInternal = config?.hooks?.internal;
    const entry = hooksInternal?.entries?.["bootstrap-extra-files"];
    const extraFilePaths = resolveExtraBootstrapPatterns(entry);
    const hooksEnabled = hooksInternal?.enabled === true && entry?.enabled === true;
    const value = {
      extraFilePaths,
      hooksEnabled,
      configUnreadable,
      // Effective budgets for the MAIN agent: per-agent roster overrides win
      // over agents.defaults, with the dist validation ladder (see
      // resolveMainBootstrapBudget above).
      bootstrapMaxChars: resolveMainBootstrapBudget(
        config,
        "bootstrapMaxChars",
        kDoctorBootstrapMaxChars,
      ),
      bootstrapTotalMaxChars: resolveMainBootstrapBudget(
        config,
        "bootstrapTotalMaxChars",
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
      configUnreadable: configInputs.configUnreadable === true,
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

// Effective bootstrap budgets for the MAIN agent, mirroring upstream's
// per-agent precedence (the analyzer models the main session):
//   resolveBootstrapMaxChars(cfg, agentId) =
//     resolveAgentConfig(cfg, agentId)?.bootstrapMaxChars
//       ?? cfg.agents?.defaults?.bootstrapMaxChars
//   → positive-finite-number → Math.floor, else the built-in default.
// The roster is agents.entries (object map keyed by agent id) when that
// property exists, else agents.list (array of entries with .id); with NO
// roster property, main is implicit with no overrides (defaults-only). Note
// the dist ladder: a non-nullish but INVALID per-agent value (0, negative,
// string) does NOT fall through to agents.defaults — it fails validation and
// lands on the built-in default.
// Cited: beta dist/agent-scope-config-CKOJa4MC.js (resolveAgentEntry,
// readAgentRosterProperty) + dist/bootstrap-CaqLzAOR.js
// (resolveBootstrapMaxChars/resolveBootstrapTotalMaxChars); stable
// dist/agent-scope-config-BxAUeF6t.js + dist/embedded-agent-helpers-DZZ4Y-Tw.js
// (same ladder; stable's roster is agents.list only — reading entries-first
// here matches each version's own resolver for the shapes it supports).
const kMainAgentId = "main";

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Dist normalizeAgentId: trim, accept /^[a-z0-9][a-z0-9_-]{0,63}$/i lowercased,
// else replace invalid runs with "-", strip edge dashes, cap 64 — empty/
// unrepresentable falls back to the default id "main" (both tarballs).
const normalizeAgentId = (value) => {
  const trimmed = String(value ?? "").trim();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return trimmed.toLowerCase();
  return (
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || kMainAgentId
  );
};

// Dist readAgentRosterProperty + resolveAgentEntry for the main id only: an
// existing-but-malformed roster property means "no entry" (it does NOT fall
// through to the other representation).
const resolveMainAgentEntry = (config) => {
  const agents = config?.agents;
  if (!isPlainObject(agents)) return null;
  if (Object.hasOwn(agents, "entries") && agents.entries !== undefined) {
    const entries = agents.entries;
    if (!isPlainObject(entries)) return null;
    for (const key of Object.keys(entries)) {
      const entry = entries[key];
      if (isPlainObject(entry) && normalizeAgentId(key) === kMainAgentId) {
        return entry;
      }
    }
    return null;
  }
  if (Object.hasOwn(agents, "list") && agents.list !== undefined) {
    if (!Array.isArray(agents.list)) return null;
    return (
      agents.list.find(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          normalizeAgentId(entry.id) === kMainAgentId,
      ) || null
    );
  }
  return null;
};

const resolveMainBootstrapBudget = (config, budgetKey, defaultValue) => {
  const mainEntry = resolveMainAgentEntry(config);
  const raw = mainEntry
    ? (mainEntry[budgetKey] ?? config?.agents?.defaults?.[budgetKey])
    : config?.agents?.defaults?.[budgetKey];
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return defaultValue;
};

const formatChars = (value = 0) => `${Number(value || 0).toLocaleString()} chars`;

// Generic Project Context truncation cards. The AlphaClaw-hardening P0 card
// is deliberately NOT emitted here — the deterministic checks are its single
// owner (one source_key); this module only supplies the analyzed state.
// AlphaClaw's own hardening files (hooks/bootstrap/*) are GENERATED and
// re-synced on every boot: a generic card telling the fixer to reorganize
// them would direct edits at a file the det:hardening card explicitly says
// not to touch — so they are filtered out of these cards' targets/evidence
// entirely (they still count in the analyzed totals the summary reports).
// Cards carry their own structured identity (source/sourceKey) — the module
// that creates a card owns its dedupe key; deriving it elsewhere from the
// display title would break dismissal suppression on any copy edit.
const isAlphaclawHardeningPath = (filePath) =>
  String(filePath || "").startsWith(kAlphaclawHardeningPrefix);

const buildBootstrapTruncationCards = (bootstrapContext = null) => {
  if (!bootstrapContext?.hasActiveTruncation) return [];

  const cards = bootstrapContext.activeTruncatedFiles
    .filter(
      (file) => file.reason === "file_limit" && !isAlphaclawHardeningPath(file.path),
    )
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

  // Hardening files are the LAST in injection order, so they are often the
  // first total-limit casualties — but the det:hardening card owns that
  // state; listing them here would aim the fixPrompt ("only edit the files
  // listed") at the generated file. When ONLY hardening files are
  // total-limited, no generic card is emitted at all.
  const totalLimitedFiles = bootstrapContext.activeTruncatedFiles.filter(
    (file) =>
      (file.reason === "total_limit" ||
        file.reason === "file_and_total_limit" ||
        file.reason === "starved") &&
      !isAlphaclawHardeningPath(file.path),
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
  kDoctorBootstrapReadMaxBytes,
  // The service's env signature must hash the SAME effective budgets the
  // analyzer models (per-agent main overrides win over agents.defaults).
  resolveMainBootstrapBudget,
};
