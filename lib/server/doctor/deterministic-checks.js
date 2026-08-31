const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { kEpisodeIdPattern } = require("../gateway-memory-monitor");

// Post-restart evidence card window: how long a finished leak episode stays
// surfaced after the process that leaked was replaced.
const kRecentLeakEpisodeWindowMs = 24 * 60 * 60 * 1000;
const { kAlphaclawHardeningPrefix, kDoctorCardSource } = require("./constants");
const {
  kDoctorSkillPromptOverheadChars,
  kDoctorSkillsMaxInPrompt,
  kDoctorSkillsMaxPromptChars,
} = require("./context-profiles");
const { formatChars } = require("./bootstrap-context");

// Deterministic workspace-health checks: no LLM, no gateway — pure local
// reads, recomputed on EVERY run (including fingerprint-reuse runs) because
// their inputs live outside the fingerprinted workspace tree. Card safety
// rules: fixPrompts are template-built from path names and our own copy only;
// workspace-derived text goes through the injected sanitizer and appears in
// display-only fields. Each check emits at most one card per stable
// sourceKey so dismissals suppress it across runs.

// Skills scan bounds mirror upstream's own discovery caps so a pathological
// skills/ tree cannot stall a run (grouped layouts scan up to 6 levels deep,
// ~300 candidates, 256KB per SKILL.md — docs/tools/skills.md).
const kSkillsScanMaxDepth = 6;
const kSkillsScanMaxCandidates = 300;
// Depth and candidate caps alone leave a hole: a WIDE tree of millions of
// non-SKILL dirents is still walked synchronously. Every visited dirent
// counts against this budget; hitting it marks the scan truncated (the same
// "estimate only" honesty the candidate cap uses).
const kSkillsScanMaxVisitedDirents = 10000;
const kSkillsNearLimitRatio = 0.85;
const kDisplayTextMaxChars = 300;
// Path-ish values lifted verbatim from openclaw.json render in card display
// fields: bounded so a pathological config value cannot flood the DB/UI.
const kDisplayPathMaxChars = 200;
// sourceKeys must stay bounded and stable: a well-formed path is its own
// suffix (unchanged from day one); anything longer than this — or failing
// the path pattern — keys on a short content hash instead (mirrors the
// content-hash sourceKey pattern in openclaw-doctor.js).
const kSourceKeyPathMaxChars = 120;
// fixPrompts are agent-dispatched: only path-shaped identifiers (no
// whitespace/control chars, bounded length) may be interpolated into them;
// anything else falls back to a generic template and stays display-only.
const kFixPromptPathPattern = /^[^\s\x00-\x1f\x7f]{1,200}$/;

const fileExists = (rootDir, relativePath) => {
  try {
    return fs.existsSync(path.join(rootDir, relativePath));
  } catch {
    return false;
  }
};

// Exact-name directory listing: immune to case-insensitive filesystems lying
// about whether MEMORY.md and memory.md are distinct entries.
const rootEntryNames = (workspaceRoot) => {
  try {
    return new Set(fs.readdirSync(workspaceRoot));
  } catch {
    return new Set();
  }
};

// Minimal explicit frontmatter reader (first `---` block, name:/description:
// lines) — the repo has no server-side YAML parser and two fields do not
// justify a dependency. Frontmatter is by definition at the head of the
// file, so only the first few KB are read (256KB is upstream's whole-file
// cap, not a frontmatter bound); one reusable buffer serves the whole scan
// (reads are sequential) — no per-file zero-filled allocation.
const kSkillsFrontmatterReadBytes = 8 * 1024;
const kSkillsFrontmatterBuffer = Buffer.allocUnsafe(kSkillsFrontmatterReadBytes);

// Block-scalar markers (|, |-, |+, >, >-, >+): the value continues on the
// following more-indented lines. OpenClaw parses the FULL YAML value into
// the skills prompt, so those continuation chars must count toward the
// estimate; folded (>) is treated like literal — char count is what matters
// here, not exact folding semantics.
const kSkillsBlockScalarPattern = /^[|>][+-]?$/;

const readSkillFrontmatter = (filePath) => {
  let content = "";
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const bytesRead = fs.readSync(
        fd,
        kSkillsFrontmatterBuffer,
        0,
        kSkillsFrontmatterBuffer.length,
        0,
      );
      content = kSkillsFrontmatterBuffer.toString("utf8", 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = content.split("\n");
  if ((lines[0] || "").trim() !== "---") return { name: "", description: "" };
  const result = { name: "", description: "" };
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") break;
    const match = /^(name|description):\s*(.*)$/.exec(line);
    if (!match) continue;
    const inlineValue = match[2].trim();
    if (!kSkillsBlockScalarPattern.test(inlineValue)) {
      result[match[1]] = inlineValue;
      continue;
    }
    // Accumulate the block's continuation lines: the key sits at column 0
    // (the key regex is column-anchored), so any non-empty line back at
    // column 0 — the next key or the closing `---` — terminates the block.
    // Bounded by the 8KB read window like the rest of the parser.
    const blockLines = [];
    let scan = index + 1;
    for (; scan < lines.length; scan += 1) {
      const candidate = lines[scan];
      if (candidate.trim() === "") {
        blockLines.push("");
        continue;
      }
      if (candidate.length === candidate.trimStart().length) break;
      blockLines.push(candidate);
    }
    // Strip the common indent shared by the non-empty continuation lines.
    const indents = blockLines
      .filter((blockLine) => blockLine.trim() !== "")
      .map((blockLine) => blockLine.length - blockLine.trimStart().length);
    const commonIndent = indents.length ? Math.min(...indents) : 0;
    result[match[1]] = blockLines
      .map((blockLine) => blockLine.slice(commonIndent))
      .join("\n")
      .trim();
    index = scan - 1;
  }
  return result;
};

const scanWorkspaceSkills = (
  workspaceRoot,
  { maxVisitedDirents = kSkillsScanMaxVisitedDirents } = {},
) => {
  const skillsRoot = path.join(workspaceRoot, "skills");
  const found = [];
  let truncated = false;
  let visitedDirents = 0;
  const walk = (dir, depth) => {
    if (depth > kSkillsScanMaxDepth || found.length >= kSkillsScanMaxCandidates) {
      truncated = truncated || found.length >= kSkillsScanMaxCandidates;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        found.length >= kSkillsScanMaxCandidates ||
        visitedDirents >= maxVisitedDirents
      ) {
        truncated = true;
        return;
      }
      visitedDirents += 1;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        const frontmatter = readSkillFrontmatter(fullPath);
        if (frontmatter) {
          found.push({
            // Relative to the skills root — callers compose "skills/<location>".
            location: path.relative(skillsRoot, dir).split(path.sep).join("/"),
            name: frontmatter.name || path.basename(dir),
            description: frontmatter.description || "",
          });
        }
      }
    }
  };
  walk(skillsRoot, 1);
  return { skills: found, truncated };
};

const buildDeterministicCards = ({
  workspaceRoot = "",
  managedRoot = "",
  profile,
  bootstrapContext = null,
  onboarded = true,
  releaseChannel = "",
  skillsLimits = {},
  // Gateway memory-leak trend (runtime data — the watchdog's cached snapshot;
  // recomputed fresh every run including reuse runs) + the shared heap-raise
  // advice string derived by the watchdog. Both optional.
  memoryTrend = null,
  heapAdvice = "",
  // Test seam: production always scans with the default dirent budget.
  skillsScanMaxVisitedDirents = kSkillsScanMaxVisitedDirents,
  sanitize = (text) => String(text ?? ""),
} = {}) => {
  const cards = [];
  const addCard = ({ sourceKey, ...card }) => {
    cards.push({
      ...card,
      status: "open",
      source: kDoctorCardSource.deterministic,
      sourceKey,
    });
  };

  // 1. Retired root files on the beta contract: their guidance is invisible
  //    to the agent. Migration debt (P1), not alarm-grade — presence alone
  //    doesn't prove critical guidance was lost.
  for (const retiredFile of profile?.retiredRootFiles || []) {
    if (!fileExists(workspaceRoot, retiredFile)) continue;
    addCard({
      sourceKey: `det:retired:${retiredFile}`,
      priority: "P1",
      category: "stale guidance",
      title: `${retiredFile} is retired on this OpenClaw version`,
      summary:
        `${retiredFile} exists in the workspace but this OpenClaw version never injects it — ` +
        `any guidance inside is invisible to the agent.`,
      recommendation:
        `Run \`openclaw doctor --fix\` to migrate ${retiredFile} (it archives the file and moves the ` +
        `content where this version reads it), or fold the guidance into AGENTS.md yourself.`,
      evidence: [{ type: "path", path: retiredFile }],
      targetPaths: [{ path: retiredFile }],
      fixPrompt:
        `Run \`openclaw doctor --fix\` to migrate the retired ${retiredFile}, or move its still-relevant ` +
        `guidance into AGENTS.md and archive the file. Verify the workspace still behaves as expected.`,
    });
  }

  // 2. Invalid or degraded bootstrap extras. AlphaClaw's own hardening extra
  //    (hooks/bootstrap/*) rejected/starved/truncated is alarm-grade: it is
  //    provably ours and provably broken. Other configured extras with
  //    rejected basenames are the user's — P1.
  const hardeningState = bootstrapContext?.hardening?.state || "unknown";
  if (hardeningState === "blocked" || hardeningState === "starved") {
    // "blocked" with reason "missing_file" is its own cause: the config entry
    // is intact but the file itself vanished from disk (the boot resync
    // rewrites it, so something removed it since) — the generic blocked copy
    // ("missing config entry, rejected basename, or disabled hook") would
    // point the user at the wrong things.
    const hardeningMissingFile =
      hardeningState === "blocked" &&
      String(bootstrapContext?.hardening?.reason || "") === "missing_file";
    const hardeningFiles = hardeningMissingFile
      ? (bootstrapContext?.hardening?.files || []).filter((file) => !file.exists)
      : (bootstrapContext?.hardening?.files || [])
          .filter((file) => file.exists && (file.reason || !file.injectable));
    // "Starved" covers two distinct causes needing opposite advice: the
    // hardening file itself over its per-file cap (shrink OUR merged content
    // / raise bootstrapMaxChars) vs. the total budget exhausted by earlier
    // root files (shrink THOSE / raise bootstrapTotalMaxChars).
    const perFileCapHit =
      hardeningState === "starved" &&
      hardeningFiles.some((file) =>
        ["file_limit", "file_and_total_limit"].includes(String(file.reason || "")),
      );
    addCard({
      // Distinct keys per severity variant: dismissing the milder starved
      // card must never suppress a later "blocked" (no safety rules at all).
      sourceKey: `det:hardening:${hardeningState}`,
      priority: "P0",
      category: "project context",
      title:
        hardeningState === "blocked"
          ? "AlphaClaw prompt hardening is not being injected"
          : "AlphaClaw prompt hardening is truncated or starved by the context budget",
      summary:
        hardeningState === "blocked"
          ? hardeningMissingFile
            ? "openclaw.json still configures AlphaClaw's hooks/bootstrap hardening extra, but the file itself is " +
              "missing from disk — something removed it since the boot resync last wrote it. The agent is running " +
              "WITHOUT AlphaClaw's safety rules."
            : "AlphaClaw's hooks/bootstrap hardening file is not being injected (missing config entry, rejected " +
              "basename, or disabled hook) — the agent is running WITHOUT AlphaClaw's safety rules."
          : perFileCapHit
            ? "AlphaClaw's merged hooks/bootstrap hardening file exceeds OpenClaw's per-file injection cap — " +
              "the tail of the hardening content (tool guidance, topic registry) is cut from the agent's context."
            : "AlphaClaw's hooks/bootstrap hardening file is only partially injected — extras are last in the " +
              "injection order, so an oversized workspace starves them first and the agent sees incomplete safety rules.",
      recommendation:
        hardeningState === "blocked"
          ? hardeningMissingFile
            ? "Restart AlphaClaw — the boot resync rewrites the hardening file. If it goes missing again, look " +
              "for external cleanup jobs, manual deletions, or agent edits under hooks/bootstrap/."
            : "AlphaClaw re-syncs its hardening on every boot; if this persists after a restart, check that " +
              "hooks.internal is enabled in openclaw.json and that no external change removed the " +
              "bootstrap-extra-files entry."
          : perFileCapHit
            ? "Raise agents.defaults.bootstrapMaxChars in openclaw.json, or reduce what AlphaClaw merges into " +
              "the hardening file (e.g. prune unused Telegram topics or Google accounts so their sections shrink)."
            : "Reduce the size of the root context files (AGENTS.md, SOUL.md, MEMORY.md) so the full hardening " +
              "content fits inside OpenClaw's total bootstrap budget, or raise agents.defaults.bootstrapTotalMaxChars.",
      evidence: hardeningFiles.map((file) => ({
        type: "text",
        text: hardeningMissingFile
          ? `${file.path}: configured in openclaw.json but missing from disk`
          : `${file.path}: ${file.reason || "not injectable"}`,
      })),
      targetPaths: [],
      // Advisory only: hooks/bootstrap/* is AlphaClaw-managed and locked —
      // the fix is config or the unmanaged root files, never editing ours.
      fixPrompt: hardeningMissingFile
        ? "AlphaClaw's configured hooks/bootstrap hardening file is missing from disk. Restart AlphaClaw so its " +
          "boot resync regenerates the file, then verify it exists again. Do not edit files under " +
          "hooks/bootstrap/ by hand — they are AlphaClaw-managed and regenerated."
        : hardeningState === "starved" && perFileCapHit
          ? "AlphaClaw's merged hardening file exceeds the per-file injection cap. Raise " +
            "agents.defaults.bootstrapMaxChars in openclaw.json (or reduce registered Telegram topics / Google " +
            "accounts so AlphaClaw's generated sections shrink). Do not edit files under hooks/bootstrap/ — " +
            "they are AlphaClaw-managed and regenerated."
          : "Reduce the combined size of the workspace root context files (AGENTS.md, SOUL.md, MEMORY.md) so " +
            "AlphaClaw's hooks/bootstrap hardening fits in the total bootstrap budget. Do not edit files under " +
            "hooks/bootstrap/ — they are AlphaClaw-managed and regenerated.",
    });
  }
  for (const blocked of bootstrapContext?.blockedExtraFiles || []) {
    if (blocked.path.startsWith(kAlphaclawHardeningPrefix)) continue;
    // blocked.path comes verbatim from openclaw.json — only a path-shaped
    // value may reach the agent-dispatched fixPrompt, and even display-only
    // fields must not carry control chars or unbounded length into the
    // DB/UI. sourceKeys stay byte-stable for well-formed paths; anything
    // pathological keys on a short content hash instead (bounded, and still
    // stable per raw value so dismissal suppression keeps working).
    const rawPath = String(blocked.path || "");
    const pathIsWellFormed = kFixPromptPathPattern.test(rawPath);
    const displayPath = sanitize(rawPath, {
      maxChars: kDisplayPathMaxChars,
      singleLine: true,
    });
    const sourceKeySuffix =
      pathIsWellFormed && rawPath.length <= kSourceKeyPathMaxChars
        ? rawPath
        : crypto.createHash("sha256").update(rawPath).digest("hex").slice(0, 12);
    const fixPromptSubject = pathIsWellFormed
      ? `The bootstrap extra ${rawPath}`
      : "A configured bootstrap extra";
    addCard({
      sourceKey: `det:extra-invalid:${sourceKeySuffix}`,
      priority: "P1",
      category: "project context",
      title: `Configured bootstrap extra ${displayPath} is not injectable on this version`,
      summary:
        `openclaw.json lists ${displayPath} under bootstrap-extra-files, but its basename is not in this ` +
        `OpenClaw version's allowlist — it is silently never injected.`,
      recommendation:
        `Rename the file to an allowed bootstrap basename (${(profile?.allowedExtraBasenames || []).join(", ")}) ` +
        `or fold its content into an injected file, then update the bootstrap-extra-files entry.`,
      evidence: [{ type: "path", path: displayPath }],
      targetPaths: [{ path: displayPath }],
      fixPrompt:
        `${fixPromptSubject} is configured but never injected on this OpenClaw version ` +
        `(basename not allowed). Move its content into a file OpenClaw injects, and remove the stale entry ` +
        `from hooks.internal.entries["bootstrap-extra-files"].paths in openclaw.json.`,
    });
  }

  // 3. MEMORY.md near/over its injection budget: the curated long-term file
  //    should be distilled, not truncated (docs/concepts/memory.md doctrine).
  const memoryFile = (bootstrapContext?.files || []).find(
    (file) => file.path === "MEMORY.md" && file.exists,
  );
  if (memoryFile?.truncatedByFileLimit) {
    addCard({
      // Distinct from the near-limit key: dismissing the early P2 warning
      // must not suppress the later, more severe truncation escalation.
      sourceKey: "det:memory-budget:over",
      priority: "P1",
      category: "memory hygiene",
      title: "MEMORY.md exceeds its Project Context budget",
      summary:
        `MEMORY.md is ${formatChars(memoryFile.rawChars)} against a ${formatChars(memoryFile.capChars)} ` +
        `injection cap — the agent sees a truncated copy of its long-term memory every session.`,
      recommendation:
        "Distill MEMORY.md into a shorter durable summary and move detailed history into memory/*.md daily " +
        "files (retrieved on demand via memory tools), or intentionally raise the bootstrap limits.",
      evidence: [
        { type: "path", path: "MEMORY.md" },
        {
          type: "text",
          text: `Raw ${formatChars(memoryFile.rawChars)}, cap ${formatChars(memoryFile.capChars)}.`,
        },
      ],
      targetPaths: [{ path: "MEMORY.md" }],
      fixPrompt:
        "Distill MEMORY.md: keep only curated durable facts, move detailed or dated history into memory/*.md " +
        "daily files, and keep the most important entries near the top. Do not delete information — relocate it.",
    });
  } else if (memoryFile?.nearFileLimit) {
    addCard({
      sourceKey: "det:memory-budget:near",
      priority: "P2",
      category: "memory hygiene",
      title: "MEMORY.md is approaching its Project Context budget",
      summary:
        `MEMORY.md is ${formatChars(memoryFile.rawChars)} — within 15% of its ${formatChars(memoryFile.capChars)} ` +
        `injection cap. It will start truncating silently for the agent as it grows.`,
      recommendation:
        "Start distilling now: fold older detail into memory/*.md daily files before truncation begins.",
      evidence: [{ type: "path", path: "MEMORY.md" }],
      targetPaths: [{ path: "MEMORY.md" }],
      fixPrompt:
        "Trim MEMORY.md below its injection cap by moving older or verbose entries into memory/*.md daily files. " +
        "Keep the durable summary intact.",
    });
  }

  // 4. MEMORY.md + lowercase memory.md coexisting: upstream treats the
  //    lowercase file as legacy repair input only.
  const entryNames = rootEntryNames(workspaceRoot);
  if (entryNames.has("MEMORY.md") && entryNames.has("memory.md")) {
    addCard({
      sourceKey: "det:memory-case",
      priority: "P1",
      category: "memory hygiene",
      title: "Both MEMORY.md and memory.md exist at the workspace root",
      summary:
        "OpenClaw injects MEMORY.md and treats lowercase memory.md as legacy repair input only — keeping both " +
        "invites divergent memories and confusion about which file the agent actually sees.",
      recommendation:
        "Merge any still-relevant content from memory.md into MEMORY.md (or memory/*.md daily files) and delete " +
        "the lowercase file.",
      evidence: [
        { type: "path", path: "MEMORY.md" },
        { type: "path", path: "memory.md" },
      ],
      targetPaths: [{ path: "memory.md" }],
      fixPrompt:
        "Merge still-relevant content from memory.md into MEMORY.md or memory/*.md, then delete memory.md. " +
        "OpenClaw only injects MEMORY.md; the lowercase file is legacy repair input.",
    });
  }

  // 5. BOOTSTRAP.md left over after onboarding: costs budget on setup-gated
  //    runs and the docs say to delete it after the ritual.
  if (onboarded && entryNames.has("BOOTSTRAP.md")) {
    addCard({
      sourceKey: "det:bootstrap-leftover",
      priority: "P2",
      category: "workspace state",
      title: "BOOTSTRAP.md is still present after setup",
      summary:
        "The one-time setup ritual is complete, but BOOTSTRAP.md still sits at the workspace root. OpenClaw's " +
        "own template says to delete it after the ritual.",
      recommendation: "Archive or delete BOOTSTRAP.md.",
      evidence: [{ type: "path", path: "BOOTSTRAP.md" }],
      targetPaths: [{ path: "BOOTSTRAP.md" }],
      fixPrompt:
        "Delete BOOTSTRAP.md from the workspace root (or move it into an archive folder) — setup is complete " +
        "and the file is no longer injected.",
    });
  }

  // 6. Skills prompt bloat — ESTIMATED cost against upstream's limits; fires
  //    only at >=85% so the estimation margin absorbs error. Scans the
  //    workspace skills root only (other skill roots are out of scope).
  const maxSkillsInPrompt =
    Number(skillsLimits.maxSkillsInPrompt) > 0
      ? Number(skillsLimits.maxSkillsInPrompt)
      : kDoctorSkillsMaxInPrompt;
  const maxSkillsPromptChars =
    Number(skillsLimits.maxSkillsPromptChars) > 0
      ? Number(skillsLimits.maxSkillsPromptChars)
      : kDoctorSkillsMaxPromptChars;
  const { skills, truncated: skillsScanTruncated } = scanWorkspaceSkills(workspaceRoot, {
    maxVisitedDirents: skillsScanMaxVisitedDirents,
  });
  if (skills.length > 0) {
    const estimatedChars = skills.reduce(
      (sum, skill) =>
        sum +
        kDoctorSkillPromptOverheadChars +
        skill.name.length +
        skill.description.length +
        skill.location.length,
      0,
    );
    const overCount = skills.length >= maxSkillsInPrompt;
    const overChars = estimatedChars >= maxSkillsPromptChars;
    const nearCount = skills.length >= Math.floor(maxSkillsInPrompt * kSkillsNearLimitRatio);
    const nearChars = estimatedChars >= Math.floor(maxSkillsPromptChars * kSkillsNearLimitRatio);
    if (overCount || overChars || nearCount || nearChars) {
      const longest = [...skills]
        .sort((a, b) => b.description.length - a.description.length)
        .slice(0, 3);
      addCard({
        sourceKey: "det:skills-bloat",
        priority: overCount || overChars ? "P1" : "P2",
        category: "skills",
        title:
          overCount || overChars
            ? "Workspace skills exceed OpenClaw's prompt budget"
            : "Workspace skills are approaching OpenClaw's prompt budget",
        summary:
          `~${skills.length} workspace skills at an estimated ${formatChars(estimatedChars)} of prompt cost ` +
          `(limits: ${maxSkillsInPrompt} skills / ${formatChars(maxSkillsPromptChars)}). Past the limit, ` +
          `OpenClaw shortens or drops skill descriptions — degrading the agent's skill selection.` +
          (skillsScanTruncated ? " (Scan hit its safety cap; the real count is higher.)" : ""),
        recommendation:
          "Shorten the longest skill descriptions (they are pure prompt cost) and remove unused skills. " +
          "Estimate only — `openclaw skills check` on the agent is authoritative.",
        evidence: longest.map((skill) => ({
          type: "text",
          text: sanitize(
            `skills/${skill.location}: description ${skill.description.length} chars`,
            { maxChars: kDisplayTextMaxChars },
          ),
        })),
        targetPaths: longest.map((skill) => ({
          path: `skills/${skill.location}/SKILL.md`,
        })),
        fixPrompt:
          "Shorten the longest SKILL.md frontmatter descriptions under skills/ (keep them one concise sentence) " +
          "and delete skills that are no longer used. Do not change skill behavior.",
      });
    }
  }

  // 7. Hourly git sync disabled: agent work is not being persisted/backed up.
  try {
    const syncStatePath = path.join(managedRoot, "cron", "system-sync.json");
    if (fs.existsSync(syncStatePath)) {
      const syncState = JSON.parse(fs.readFileSync(syncStatePath, "utf8"));
      if (syncState?.enabled === false) {
        addCard({
          sourceKey: "det:git-sync-disabled",
          priority: "P1",
          category: "workspace state",
          title: "Hourly git sync is disabled — agent work is not being persisted",
          summary:
            "cron/system-sync.json has enabled:false, so workspace changes are no longer committed and pushed. " +
            "On an ephemeral container, unpushed work is lost on redeploy.",
          recommendation:
            "Re-enable the repo sync schedule from the General tab (or set enabled:true in cron/system-sync.json) " +
            "unless this is intentionally paused.",
          // Text evidence, not a path: the file lives in the managed root,
          // outside workspaceRoot — a path entry would be refused a snippet
          // by the workspace containment and dead-link in browse.
          evidence: [
            {
              type: "text",
              text: "<OPENCLAW_DIR>/cron/system-sync.json — enabled: false",
            },
          ],
          targetPaths: [],
          fixPrompt:
            "Re-enable AlphaClaw's hourly git sync: set enabled to true in cron/system-sync.json under the " +
            "OpenClaw directory, then confirm the next hourly commit lands.",
        });
      }
    }
  } catch {
    // unreadable sync state: no card — the git-sync path has its own alerts
  }

  // 8. Gateway memory-leak trend (runtime data via the watchdog's cached
  //    snapshot; null when the monitor is off/absent → no card, fail-soft).
  //    Episode-scoped sourceKeys: dismissing one false-positive episode must
  //    never silence a future real leak, while re-scans inside the SAME
  //    episode stay dismissal-suppressed. Emission is exclusive by severity —
  //    critical REPLACES the P1 card, never duplicates it — and the severity
  //    suffix keeps "dismissing mild never suppresses severe". Numbers come
  //    from our own detector; no gateway-echoed strings enter any field.
  if (memoryTrend && typeof memoryTrend === "object") {
    const episodeId = kEpisodeIdPattern.test(String(memoryTrend.episodeId || ""))
      ? memoryTrend.episodeId
      : null;
    const statsLine = () => {
      const cap = memoryTrend.effectiveCapMb
        ? ` of its ${memoryTrend.effectiveCapMb}MB effective cap`
        : "";
      const slope =
        memoryTrend.slopeMbPerHour != null
          ? `, rising ~${memoryTrend.slopeMbPerHour} MB/h`
          : "";
      return `Gateway RSS is ${memoryTrend.rssMb ?? "?"}MB${cap}${slope}.`;
    };
    const heapAdviceLine =
      typeof heapAdvice === "string" && heapAdvice.trim()
        ? ` ${heapAdvice.trim()}`
        : "";
    const buildLeakFixPrompt = () =>
      "Diagnose a suspected gateway memory leak (RSS trend, may also be allocator fragmentation — " +
      "recurrence after a restart is the discriminating signal). Steps: " +
      "(1) confirm the live trend with `alphaclaw admin GET /api/watchdog/resources` (gatewayMemoryTrend); " +
      "(2) review recently added or changed plugins.load.paths / plugins.entries and channel config in openclaw.json " +
      "as an investigative step — plugins run inside the gateway process; " +
      "(3) scan the gateway log tail for runaway session or queue growth; " +
      `(4) memory-limit guidance for this box:${heapAdviceLine || " (no machine-specific advice available — do not raise limits blindly; raising a limit only delays a leak and can trade a V8 abort for a kernel OOM kill)"} ` +
      "(5) a Watchdog-tab gateway restart is a MITIGATION, not a fix — if you restart, keep the diagnosis going and report findings.";
    if (memoryTrend.state === "critical" && episodeId) {
      addCard({
        sourceKey: `det:gateway-memory-leak-critical:${episodeId}`,
        priority: "P0",
        category: "workspace state",
        title: "Gateway memory critical — exhaustion imminent",
        summary:
          `${statsLine()} The trend is confirmed and pressure is at or above 90% of the effective cap — ` +
          "without action the gateway will be killed by V8 or the kernel.",
        recommendation:
          "Mitigate now (restart the gateway from the Watchdog tab, or enable auto-restart in Watchdog settings), " +
          "then diagnose the leak — a restart alone only resets the clock.",
        evidence: [
          {
            type: "text",
            text: `memory trend: ${statsLine()} projected exhaustion ${memoryTrend.projectedExhaustionAt || "unknown"} (episode ${episodeId})`,
          },
        ],
        targetPaths: [],
        fixPrompt: buildLeakFixPrompt(),
      });
    } else if (memoryTrend.state === "leak_suspected" && episodeId) {
      addCard({
        sourceKey: `det:gateway-memory-leak:${episodeId}`,
        priority: "P1",
        category: "workspace state",
        title: "Gateway memory rising steadily — leak suspected",
        summary:
          `${statsLine()} Per-bucket RSS floors have risen for a sustained window — ` +
          "consistent with a slow memory leak (or, less often, allocator fragmentation).",
        recommendation:
          "Diagnose before it becomes critical: confirm the trend on the Watchdog tab's Resources card, " +
          "then work through the fix prompt's runbook.",
        evidence: [
          {
            type: "text",
            text: `memory trend: ${statsLine()}${memoryTrend.projectedExhaustionAt ? ` projected exhaustion ${memoryTrend.projectedExhaustionAt}` : ""} (episode ${episodeId})`,
          },
        ],
        targetPaths: [],
        fixPrompt: buildLeakFixPrompt(),
      });
    } else if (
      memoryTrend.lastEpisodeSummary &&
      kEpisodeIdPattern.test(String(memoryTrend.lastEpisodeSummary.episodeId || "")) &&
      // Strict gate, both bounds: endedAt must round-trip as exact ISO (lenient
      // Date.parse accepts paren-comment payloads that would land verbatim in
      // card copy) and must not be in the future (a future date would keep the
      // card alive indefinitely via a negative age).
      (() => {
        const parsed = Date.parse(String(memoryTrend.lastEpisodeSummary.endedAt || ""));
        return (
          Number.isFinite(parsed) &&
          new Date(parsed).toISOString() === memoryTrend.lastEpisodeSummary.endedAt &&
          parsed <= Date.now() &&
          Date.now() - parsed < kRecentLeakEpisodeWindowMs
        );
      })()
    ) {
      // Post-restart evidence card: after a mitigation restart or OOM the
      // live trend is the REPLACEMENT process's warm-up — without this card
      // the episode would never surface in a scan.
      const summary = memoryTrend.lastEpisodeSummary;
      addCard({
        sourceKey: `det:gateway-memory-leak-recent:${summary.episodeId}`,
        priority: "P2",
        category: "workspace state",
        title: "A gateway memory-leak episode ended recently",
        summary:
          `A memory-leak episode ended at ${summary.endedAt} (peak ${summary.peakRssMb ?? "?"}MB` +
          `${summary.slopeMbPerHour != null ? `, ~${summary.slopeMbPerHour} MB/h` : ""}, ` +
          `${
            summary.reason === "process_exited"
              ? "ended by a gateway restart/exit"
              : summary.reason === "detection_disabled"
                ? "detection was turned off mid-episode"
                : "recovered on its own"
          }). ` +
          "Recurrence after a restart distinguishes a real leak from fragmentation.",
        recommendation:
          "Watch the Resources card over the next hours; if the climb resumes, run the leak runbook via " +
          "\"Ask agent to fix\" on the new episode's card.",
        evidence: [
          {
            type: "text",
            text: `last episode: ${summary.episodeId} pid ${summary.pid ?? "?"} peak ${summary.peakRssMb ?? "?"}MB ended ${summary.endedAt} (${summary.reason})`,
          },
        ],
        targetPaths: [],
        fixPrompt: buildLeakFixPrompt(),
      });
    }
  }

  // Dev-channel blind spot (documented): the context contract of a dev build
  // is unverifiable, so profile-gated checks silently run in stable mode.
  if (releaseChannel === "dev") {
    addCard({
      sourceKey: "det:dev-contract-unverified",
      priority: "P2",
      category: "workspace state",
      title: "Dev channel: context contract unverified",
      summary:
        "A dev build's context-injection contract cannot be verified from its version, so Drift Doctor is " +
        "analyzing with the stable profile — hardening-injection checks may miss dev-only breakage.",
      recommendation:
        "Use /context on the agent to verify what is actually injected while running the dev channel.",
      evidence: [],
      targetPaths: [],
      fixPrompt:
        "No workspace change needed — verify injected context manually with /context while on the dev channel.",
    });
  }

  return cards;
};

module.exports = {
  buildDeterministicCards,
};
