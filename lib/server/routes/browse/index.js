const path = require("path");
const { kLockedBrowsePaths, kProtectedBrowsePaths } = require("../../constants");
const {
  kDefaultTreeDepth,
  kMaxTreeDepth,
  kIgnoredDirectoryNames,
  kCommitHistoryLimit,
} = require("./constants");
const {
  normalizePolicyPath,
  resolveSafePath,
  toRelativePath,
  matchesPolicyPath,
  containsPolicyPath,
  directoryContainsPolicyPath,
} = require("./path-utils");
const { shouldRequireRestartForBrowsePath } = require("./restart-rules");
const { writeFileAtomic } = require("../../utils/safe-file");
const { logRejectedInput } = require("../../utils/input-audit");
const {
  isLikelyBinaryFile,
  getImageMimeType,
  getAudioMimeType,
  isSqliteFilePath,
} = require("./file-helpers");
const { readSqliteSummary, readSqliteTableData } = require("./sqlite");
const {
  runGitCommand,
  runGitCommandWithExitCode,
  parseGithubRepoSlug,
  normalizeChangedPath,
  parseBranchTracking,
} = require("./git");
const { wrapAsync } = require("../../utils/wrap-async");

const registerBrowseRoutes = ({ app, fs, kRootDir, restartRequiredState = null }) => {
  // Canonicalize the root once so tree/relative paths agree with the
  // canonical absolute paths resolveSafePath returns (the configured root may
  // itself sit behind a symlink, e.g. /tmp on macOS).
  const kRootResolved = (() => {
    const lexicalRoot = path.resolve(kRootDir);
    if (!fs.existsSync(lexicalRoot)) {
      fs.mkdirSync(lexicalRoot, { recursive: true });
    }
    try {
      return fs.realpathSync(lexicalRoot);
    } catch {
      return lexicalRoot;
    }
  })();
  const kRootWithSep = `${kRootResolved}${path.sep}`;
  const kRootDisplayName = "kRootDir/.openclaw";

  const resolvePathInRoot = (inputPath) =>
    resolveSafePath(inputPath, kRootResolved, kRootWithSep, kRootDisplayName, {
      fsModule: fs,
    });

  // The root itself ("" / "." / "/") is never a mutation target: the old
  // delete handler resolved it to the state dir and rm -rf'd everything
  // (fix wave F147).
  const rejectRootPath = (req, res, resolvedPath, rawValue) => {
    if (String(resolvedPath.relativePath || "").trim()) return false;
    logRejectedInput({ req, field: "path", reason: "root_path", value: rawValue ?? "" });
    res.status(400).json({ ok: false, error: "path is required" });
    return true;
  };

  const rejectPolicyPath = (req, res, { reason, value, error }) => {
    logRejectedInput({ req, field: "path", reason, value });
    return res.status(403).json({ ok: false, error });
  };

  // Ancestor-aware locked/protected check for move and delete: lexical first,
  // then (for a directory) an on-disk walk for any protected entry inside.
  const targetCarriesPolicyPath = (resolvedPath) => {
    const normalized = normalizePolicyPath(resolvedPath.relativePath);
    if (
      containsPolicyPath(kLockedBrowsePaths, normalized) ||
      containsPolicyPath(kProtectedBrowsePaths, normalized)
    ) {
      return { contains: true, reason: "locked_or_protected" };
    }
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(resolvedPath.absolutePath).isDirectory();
    } catch {}
    if (!isDirectory) return { contains: false };
    const walked = directoryContainsPolicyPath({
      fsModule: fs,
      absoluteDir: resolvedPath.absolutePath,
      rootResolved: kRootResolved,
      policyPathSets: [kLockedBrowsePaths, kProtectedBrowsePaths],
    });
    return walked.contains ? { contains: true, reason: walked.reason } : { contains: false };
  };

  // Restart-required is recorded SERVER-side, only after the fs operation
  // succeeded, so every tab and the agent actor see the same banner (F152).
  const markRestartIfNeeded = (...relativePaths) => {
    const required = relativePaths.some((relativePath) =>
      shouldRequireRestartForBrowsePath(relativePath),
    );
    if (required && typeof restartRequiredState?.markRequired === "function") {
      try {
        restartRequiredState.markRequired("browse_edit");
      } catch (error) {
        console.warn(`[browse] could not persist restart-required: ${error?.message || error}`);
      }
    }
    return required;
  };

  const readVisibleDirectoryEntries = (absolutePath) =>
    fs
      .readdirSync(absolutePath, { withFileTypes: true })
      .filter((entry) => {
        if (entry.isDirectory() && kIgnoredDirectoryNames.has(entry.name)) {
          return false;
        }
        return entry.isDirectory() || entry.isFile();
      });

  const buildTreeNode = (absolutePath, depthRemaining) => {
    const stats = fs.statSync(absolutePath);
    const nodeName = path.basename(absolutePath);
    const nodePath = toRelativePath(absolutePath, kRootResolved);

    if (!stats.isDirectory()) {
      return { type: "file", name: nodeName, path: nodePath };
    }

    if (depthRemaining <= 0) {
      const hasMoreChildren = readVisibleDirectoryEntries(absolutePath).length > 0;
      return {
        type: "folder",
        name: nodeName,
        path: nodePath,
        children: [],
        truncated: hasMoreChildren,
      };
    }

    const children = readVisibleDirectoryEntries(absolutePath)
      .map((entry) =>
        buildTreeNode(path.join(absolutePath, entry.name), depthRemaining - 1),
      )
      .sort((leftNode, rightNode) => {
        if (leftNode.type !== rightNode.type) {
          return leftNode.type === "folder" ? -1 : 1;
        }
        return leftNode.name.localeCompare(rightNode.name);
      });

    return { type: "folder", name: nodeName, path: nodePath, children };
  };

  app.get("/api/browse/tree", (req, res) => {
    const depthValue = Number.parseInt(String(req.query.depth || ""), 10);
    const requestedDepth =
      Number.isFinite(depthValue) && depthValue > 0
        ? depthValue
        : kDefaultTreeDepth;
    const depth = Math.min(requestedDepth, kMaxTreeDepth);
    const requestedPath = String(req.query.path || "").trim();
    try {
      const resolvedPath = requestedPath
        ? resolvePathInRoot(requestedPath)
        : { ok: true, absolutePath: kRootResolved };
      if (!resolvedPath.ok) {
        return res.status(400).json({ ok: false, error: resolvedPath.error });
      }
      const stats = fs.statSync(resolvedPath.absolutePath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ ok: false, error: "Path is not a folder" });
      }
      const tree = buildTreeNode(resolvedPath.absolutePath, depth);
      return res.json({ ok: true, root: tree });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not build file tree",
      });
    }
  });

  app.get("/api/browse/read", (req, res) => {
    const resolvedPath = resolvePathInRoot(req.query.path);
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }

    try {
      const stats = fs.statSync(resolvedPath.absolutePath);
      if (!stats.isFile()) {
        return res.status(400).json({ ok: false, error: "Path is not a file" });
      }
      if (isSqliteFilePath(resolvedPath.absolutePath)) {
        const sqliteSummary = readSqliteSummary(resolvedPath.absolutePath);
        return res.json({
          ok: true,
          path: resolvedPath.relativePath,
          kind: "sqlite",
          sqliteSummary,
          content: "",
        });
      }
      // Size gates: base64-inlining a large media file materializes ~1.33x
      // its size as a JS string (twice, after res.json) — a direct OOM vector
      // on small instances. Oversized files get 413 instead of a preview.
      const kMaxTextPreviewBytes = 5 * 1024 * 1024;
      const kMaxMediaPreviewBytes = 20 * 1024 * 1024;
      const fileSizeBytes = (() => {
        try {
          return fs.statSync(resolvedPath.absolutePath).size;
        } catch {
          return 0;
        }
      })();
      const tooLarge = (limit) => fileSizeBytes > limit;
      const audioMimeType = getAudioMimeType(resolvedPath.absolutePath);
      if (audioMimeType) {
        if (tooLarge(kMaxMediaPreviewBytes)) {
          return res
            .status(413)
            .json({ ok: false, error: "File too large to preview" });
        }
        const audioBytes = fs.readFileSync(resolvedPath.absolutePath);
        const audioDataUrl = `data:${audioMimeType};base64,${audioBytes.toString("base64")}`;
        return res.json({
          ok: true,
          path: resolvedPath.relativePath,
          kind: "audio",
          mimeType: audioMimeType,
          audioDataUrl,
          content: "",
        });
      }
      if (isLikelyBinaryFile(fs, resolvedPath.absolutePath)) {
        const imageMimeType = getImageMimeType(resolvedPath.absolutePath);
        if (!imageMimeType) {
          return res
            .status(400)
            .json({ ok: false, error: "Binary files are not editable" });
        }
        if (tooLarge(kMaxMediaPreviewBytes)) {
          return res
            .status(413)
            .json({ ok: false, error: "File too large to preview" });
        }
        const imageBytes = fs.readFileSync(resolvedPath.absolutePath);
        const imageDataUrl = `data:${imageMimeType};base64,${imageBytes.toString("base64")}`;
        return res.json({
          ok: true,
          path: resolvedPath.relativePath,
          kind: "image",
          mimeType: imageMimeType,
          imageDataUrl,
          content: "",
        });
      }
      if (tooLarge(kMaxTextPreviewBytes)) {
        return res
          .status(413)
          .json({ ok: false, error: "File too large to preview" });
      }
      const content = fs.readFileSync(resolvedPath.absolutePath, "utf8");
      return res.json({
        ok: true,
        path: resolvedPath.relativePath,
        kind: "text",
        content,
      });
    } catch (error) {
      return res
        .status(500)
        .json({ ok: false, error: error.message || "Could not read file" });
    }
  });

  app.get("/api/browse/download", (req, res) => {
    const resolvedPath = resolvePathInRoot(req.query.path);
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    try {
      const stats = fs.statSync(resolvedPath.absolutePath);
      if (!stats.isFile()) {
        return res.status(400).json({ ok: false, error: "Path is not a file" });
      }
      const fileName = path.basename(resolvedPath.relativePath || resolvedPath.absolutePath);
      return res.download(resolvedPath.absolutePath, fileName, (error) => {
        if (!error || res.headersSent) return;
        return res
          .status(500)
          .json({ ok: false, error: error.message || "Could not download file" });
      });
    } catch (error) {
      return res
        .status(500)
        .json({ ok: false, error: error.message || "Could not download file" });
    }
  });

  app.get("/api/browse/git-summary", wrapAsync(async (req, res) => {
    try {
      const envRepoSlug = parseGithubRepoSlug(
        process.env.GITHUB_WORKSPACE_REPO || "",
      );
      const statusResult = await runGitCommand(
        ["status", "--porcelain", "--branch"],
        kRootResolved,
      );
      if (!statusResult.ok) {
        if (/not a git repository/i.test(statusResult.error || "")) {
          return res.json({
            ok: true,
            isRepo: false,
            repoPath: kRootResolved,
          });
        }
        return res.status(500).json({
          ok: false,
          error: statusResult.error || "Could not read git status",
        });
      }

      const statusLines = statusResult.stdout
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean);
      const branchLine = statusLines.find((line) => line.startsWith("##")) || "";
      const branchTracking = parseBranchTracking(branchLine);
      const branch = branchTracking.branch;
      const diffNumstatResult = await runGitCommand(
        ["diff", "--numstat", "HEAD"],
        kRootResolved,
      );
      const diffStatsByPath = new Map();
      if (diffNumstatResult.ok) {
        diffNumstatResult.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => {
            const [addedRaw = "", deletedRaw = "", rawPath = ""] =
              line.split("\t");
            const normalizedPath = normalizeChangedPath(rawPath);
            if (!normalizedPath) return;
            const addedLines = Number.parseInt(addedRaw, 10);
            const deletedLines = Number.parseInt(deletedRaw, 10);
            diffStatsByPath.set(normalizedPath, {
              addedLines: Number.isFinite(addedLines) ? addedLines : null,
              deletedLines: Number.isFinite(deletedLines) ? deletedLines : null,
            });
          });
      }
      const changedFiles = statusLines
        .filter((line) => !line.startsWith("##"))
        .map((line) => {
          const rawStatus = line.slice(0, 2);
          const pathValue = normalizeChangedPath(line.slice(3));
          const stats = diffStatsByPath.get(pathValue) || {
            addedLines: null,
            deletedLines: null,
          };
          const statusKind =
            rawStatus === "??" || rawStatus.includes("A")
              ? "U"
              : rawStatus.includes("D")
                ? "D"
                : "M";
          return {
            status: rawStatus.trim() || "M",
            statusKind,
            path: pathValue,
            addedLines: stats.addedLines,
            deletedLines: stats.deletedLines,
          };
        });

      let repoSlug = envRepoSlug;
      if (!repoSlug) {
        const remoteResult = await runGitCommand(
          ["remote", "get-url", "origin"],
          kRootResolved,
        );
        if (remoteResult.ok) {
          repoSlug = parseGithubRepoSlug(remoteResult.stdout || "");
        }
      }
      const repoUrl = repoSlug ? `https://github.com/${repoSlug}` : "";

      const logResult = await runGitCommand(
        [
          "log",
          "--pretty=format:%H%x09%h%x09%s%x09%ct",
          "-n",
          String(kCommitHistoryLimit),
        ],
        kRootResolved,
      );
      const commits = logResult.ok
        ? logResult.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [hash = "", shortHash = "", message = "", unixTs = "0"] =
                line.split("\t");
              return {
                hash,
                shortHash,
                message,
                timestamp: Number.parseInt(unixTs, 10) || 0,
                url: repoSlug && hash ? `${repoUrl}/commit/${hash}` : "",
              };
            })
        : [];

      return res.json({
        ok: true,
        isRepo: true,
        repoPath: kRootResolved,
        repoSlug,
        repoUrl,
        branch,
        upstreamBranch: branchTracking.upstreamBranch,
        hasUpstream: branchTracking.hasUpstream,
        upstreamGone: branchTracking.upstreamGone,
        aheadCount: branchTracking.aheadCount,
        behindCount: branchTracking.behindCount,
        syncState: branchTracking.syncState,
        isDirty: changedFiles.length > 0,
        changedFilesCount: changedFiles.length,
        changedFiles: changedFiles.slice(0, 16),
        commits,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not build git summary",
      });
    }
  }));

  app.get("/api/browse/sqlite-table", (req, res) => {
    const resolvedPath = resolvePathInRoot(req.query.path);
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    if (!isSqliteFilePath(resolvedPath.absolutePath)) {
      return res.status(400).json({ ok: false, error: "Path is not a sqlite file" });
    }
    const tableName = String(req.query.table || "").trim();
    const limit = req.query.limit;
    const offset = req.query.offset;
    const sqliteResult = readSqliteTableData(
      resolvedPath.absolutePath,
      tableName,
      limit,
      offset,
    );
    if (!sqliteResult.ok) {
      return res.status(400).json({
        ok: false,
        error: sqliteResult.error || "Could not read sqlite table",
      });
    }
    return res.json({
      ok: true,
      path: resolvedPath.relativePath,
      table: sqliteResult.table,
      columns: sqliteResult.columns,
      rows: sqliteResult.rows,
      limit: sqliteResult.limit,
      offset: sqliteResult.offset,
      totalRows: sqliteResult.totalRows,
    });
  });

  app.get("/api/browse/git-diff", wrapAsync(async (req, res) => {
    const resolvedPath = resolvePathInRoot(req.query.path);
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    const relativePath = String(resolvedPath.relativePath || "").trim();
    if (!relativePath) {
      return res.status(400).json({ ok: false, error: "path is required" });
    }

    try {
      const statusResult = await runGitCommandWithExitCode(
        ["status", "--porcelain", "--", relativePath],
        kRootResolved,
      );
      if (
        !statusResult.ok &&
        /not a git repository/i.test(statusResult.stderr || "")
      ) {
        return res.status(400).json({ ok: false, error: "No git repo at this root" });
      }
      const statusLines = statusResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const rawStatus = statusLines[0]?.slice(0, 2) || "";
      const isUntracked = statusLines.some((line) => line.startsWith("??"));
      const statusKind =
        rawStatus === "??" || rawStatus.includes("A")
          ? "U"
          : rawStatus.includes("D")
            ? "D"
            : "M";

      const diffResult = isUntracked
        ? await runGitCommandWithExitCode(
            ["diff", "--no-index", "--", "/dev/null", resolvedPath.absolutePath],
            kRootResolved,
          )
        : await runGitCommandWithExitCode(
            ["diff", "HEAD", "--", relativePath],
            kRootResolved,
          );

      const untrackedAllowedFailure =
        isUntracked && diffResult.exitCode === 1 && diffResult.stdout;
      if (!diffResult.ok && !untrackedAllowedFailure) {
        return res.status(500).json({
          ok: false,
          error: diffResult.stderr || diffResult.error || "Could not load file diff",
        });
      }

      const content = String(diffResult.stdout || "")
        .replaceAll(resolvedPath.absolutePath, relativePath)
        .trimEnd();
      return res.json({
        ok: true,
        path: relativePath,
        content,
        statusKind,
        isDeleted: statusKind === "D",
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not load file diff",
      });
    }
  }));

  app.post("/api/browse/git-sync", wrapAsync(async (req, res) => {
    try {
      const commitMessageRaw = String(req.body?.message || "").trim();
      const commitMessage = commitMessageRaw || "sync changes";
      const statusResult = await runGitCommand(
        ["status", "--porcelain", "--branch"],
        kRootResolved,
      );
      if (!statusResult.ok) {
        if (/not a git repository/i.test(statusResult.error || "")) {
          return res.status(400).json({ ok: false, error: "No git repo at this root" });
        }
        return res.status(500).json({
          ok: false,
          error: statusResult.error || "Could not read git status",
        });
      }
      const statusLines = statusResult.stdout
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean);
      const branchLine = statusLines.find((line) => line.startsWith("##")) || "";
      const branchTracking = parseBranchTracking(branchLine);
      const hasChanges =
        statusLines
          .filter((line) => !line.startsWith("##"))
          .map((line) => line.trim())
          .filter(Boolean).length > 0;
      let committed = false;
      let pushed = false;
      let shortHash = "";
      if (!hasChanges) {
        const hasAheadCommits =
          branchTracking.hasUpstream && branchTracking.aheadCount > 0;
        if (!hasAheadCommits) {
          return res.json({
            ok: true,
            committed: false,
            pushed: false,
            message: "No changes to sync",
          });
        }
      }
      if (hasChanges) {
        const addResult = await runGitCommand(["add", "-A"], kRootResolved);
        if (!addResult.ok) {
          return res.status(500).json({
            ok: false,
            error: addResult.error || "Could not stage changes",
          });
        }
        const commitResult = await runGitCommand(
          ["commit", "-m", commitMessage],
          kRootResolved,
        );
        if (!commitResult.ok) {
          if (/nothing to commit/i.test(commitResult.error || "")) {
            return res.json({
              ok: true,
              committed: false,
              pushed: false,
              message: "No changes to sync",
            });
          }
          return res.status(500).json({
            ok: false,
            error: commitResult.error || "Could not commit changes",
          });
        }
        committed = true;
        const shortHashResult = await runGitCommand(
          ["rev-parse", "--short", "HEAD"],
          kRootResolved,
        );
        shortHash = shortHashResult.ok
          ? String(shortHashResult.stdout || "").trim()
          : "";
      }
      const shouldPush = branchTracking.hasUpstream
        ? branchTracking.aheadCount > 0 || committed
        : committed;
      if (shouldPush) {
        const pushArgs = branchTracking.hasUpstream
          ? ["push"]
          : ["push", "-u", "origin", "HEAD"];
        const pushResult = await runGitCommand(pushArgs, kRootResolved);
        if (pushResult.ok) {
          pushed = true;
        } else {
          return res.json({
            ok: true,
            committed,
            pushed: false,
            shortHash,
            message: committed
              ? `Committed ${shortHash || "changes"} locally; push failed`
              : "Could not push commits",
            pushError: pushResult.error || "Could not push commits",
          });
        }
      }
      const syncMessage = pushed
        ? committed
          ? `Committed and pushed ${shortHash || "changes"}`
          : "Pushed local commits"
        : committed
          ? `Committed ${shortHash || "changes"}`
          : "No changes to sync";
      return res.json({
        ok: true,
        committed,
        pushed,
        shortHash,
        message: syncMessage,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not sync changes",
      });
    }
  }));

  app.put("/api/browse/write", wrapAsync(async (req, res) => {
    const { path: targetPath, content } = req.body || {};
    const resolvedPath = resolvePathInRoot(targetPath);
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    if (rejectRootPath(req, res, resolvedPath, targetPath)) return;
    const normalizedPolicyPath = normalizePolicyPath(resolvedPath.relativePath);
    if (matchesPolicyPath(kLockedBrowsePaths, normalizedPolicyPath)) {
      return rejectPolicyPath(req, res, {
        reason: "locked_path",
        value: targetPath,
        error: "This file is managed by AlphaClaw and cannot be edited.",
      });
    }
    if (typeof content !== "string") {
      return res.status(400).json({ ok: false, error: "content must be a string" });
    }

    try {
      const stats = fs.statSync(resolvedPath.absolutePath);
      if (!stats.isFile()) {
        return res.status(400).json({ ok: false, error: "Path is not a file" });
      }
      // Atomic (temp + fsync + rename) so the gateway's config watcher and
      // other readers never observe a torn openclaw.json (F153); the file's
      // own mode is preserved on the fresh inode.
      writeFileAtomic(resolvedPath.absolutePath, content, {
        fsModule: fs,
        mode: stats.mode & 0o777,
      });
      const restartRequired = markRestartIfNeeded(resolvedPath.relativePath);
      return res.json({
        ok: true,
        path: resolvedPath.relativePath,
        ...(restartRequired ? { restartRequired: true } : {}),
      });
    } catch (error) {
      return res
        .status(500)
        .json({ ok: false, error: error.message || "Could not save file" });
    }
  }));

  app.post("/api/browse/create-file", (req, res) => {
    const targetPath = String(req.body?.path || "").trim();
    if (!targetPath) {
      return res.status(400).json({ ok: false, error: "path is required" });
    }
    const resolvedPath = resolvePathInRoot(targetPath);
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    const normalizedPolicyPath = normalizePolicyPath(resolvedPath.relativePath);
    if (matchesPolicyPath(kLockedBrowsePaths, normalizedPolicyPath)) {
      return rejectPolicyPath(req, res, {
        reason: "locked_path",
        value: targetPath,
        error: "Cannot create files in a locked path.",
      });
    }
    try {
      if (fs.existsSync(resolvedPath.absolutePath)) {
        return res
          .status(409)
          .json({ ok: false, error: "A file or folder already exists at this path" });
      }
      const parentDir = path.dirname(resolvedPath.absolutePath);
      fs.mkdirSync(parentDir, { recursive: true });
      fs.writeFileSync(resolvedPath.absolutePath, "", "utf8");
      const restartRequired = markRestartIfNeeded(resolvedPath.relativePath);
      return res.json({
        ok: true,
        path: resolvedPath.relativePath,
        ...(restartRequired ? { restartRequired: true } : {}),
      });
    } catch (error) {
      return res
        .status(500)
        .json({ ok: false, error: error.message || "Could not create file" });
    }
  });

  app.post("/api/browse/create-folder", (req, res) => {
    const targetPath = String(req.body?.path || "").trim();
    if (!targetPath) {
      return res.status(400).json({ ok: false, error: "path is required" });
    }
    const resolvedPath = resolvePathInRoot(targetPath);
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    const normalizedPolicyPath = normalizePolicyPath(resolvedPath.relativePath);
    if (matchesPolicyPath(kLockedBrowsePaths, normalizedPolicyPath)) {
      return res.status(403).json({
        ok: false,
        error: "Cannot create folders in a locked path.",
      });
    }
    try {
      if (fs.existsSync(resolvedPath.absolutePath)) {
        return res
          .status(409)
          .json({ ok: false, error: "A file or folder already exists at this path" });
      }
      fs.mkdirSync(resolvedPath.absolutePath, { recursive: true });
      return res.json({ ok: true, path: resolvedPath.relativePath });
    } catch (error) {
      return res
        .status(500)
        .json({ ok: false, error: error.message || "Could not create folder" });
    }
  });

  app.post("/api/browse/move", (req, res) => {
    const fromPath = String(req.body?.from || "").trim();
    const toPath = String(req.body?.to || "").trim();
    if (!fromPath || !toPath) {
      return res.status(400).json({ ok: false, error: "from and to are required" });
    }
    const resolvedFrom = resolvePathInRoot(fromPath);
    if (!resolvedFrom.ok) {
      return res.status(400).json({ ok: false, error: resolvedFrom.error });
    }
    const resolvedTo = resolvePathInRoot(toPath);
    if (!resolvedTo.ok) {
      return res.status(400).json({ ok: false, error: resolvedTo.error });
    }
    if (rejectRootPath(req, res, resolvedFrom, fromPath)) return;
    if (rejectRootPath(req, res, resolvedTo, toPath)) return;
    const normalizedToPolicy = normalizePolicyPath(resolvedTo.relativePath);
    // Source: at/under a policy path OR an ancestor carrying one (F148).
    const sourceCarries = targetCarriesPolicyPath(resolvedFrom);
    if (sourceCarries.contains) {
      return rejectPolicyPath(req, res, {
        reason: `source_${sourceCarries.reason}`,
        value: fromPath,
        error: "Source path is protected and cannot be moved.",
      });
    }
    // Destination: never into, onto, or over an ancestor of a locked or
    // protected path.
    if (containsPolicyPath(kLockedBrowsePaths, normalizedToPolicy)) {
      return rejectPolicyPath(req, res, {
        reason: "destination_locked",
        value: toPath,
        error: "Cannot move into a locked path.",
      });
    }
    if (containsPolicyPath(kProtectedBrowsePaths, normalizedToPolicy)) {
      return rejectPolicyPath(req, res, {
        reason: "destination_protected",
        value: toPath,
        error: "Cannot move onto a protected path.",
      });
    }
    try {
      if (!fs.existsSync(resolvedFrom.absolutePath)) {
        return res.status(404).json({ ok: false, error: "Source path does not exist" });
      }
      if (fs.existsSync(resolvedTo.absolutePath)) {
        return res.status(409).json({ ok: false, error: "A file or folder already exists at the destination" });
      }
      const parentDir = path.dirname(resolvedTo.absolutePath);
      fs.mkdirSync(parentDir, { recursive: true });
      fs.renameSync(resolvedFrom.absolutePath, resolvedTo.absolutePath);
      const restartRequired = markRestartIfNeeded(
        resolvedFrom.relativePath,
        resolvedTo.relativePath,
      );
      return res.json({
        ok: true,
        from: resolvedFrom.relativePath,
        to: resolvedTo.relativePath,
        ...(restartRequired ? { restartRequired: true } : {}),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || "Could not move path" });
    }
  });

  app.delete("/api/browse/delete", (req, res) => {
    const targetPath = String(req.body?.path || "").trim();
    const resolvedPath = resolvePathInRoot(targetPath);
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    if (rejectRootPath(req, res, resolvedPath, req.body?.path)) return;
    const carries = targetCarriesPolicyPath(resolvedPath);
    if (carries.contains) {
      return rejectPolicyPath(req, res, {
        reason: carries.reason,
        value: targetPath,
        error: "This path cannot be deleted from the explorer.",
      });
    }
    try {
      if (!fs.existsSync(resolvedPath.absolutePath)) {
        return res.status(404).json({ ok: false, error: "Path does not exist" });
      }
      const stats = fs.statSync(resolvedPath.absolutePath);
      const isDirectory = stats.isDirectory();
      if (!stats.isFile() && !isDirectory) {
        return res.status(400).json({ ok: false, error: "Path is not a file or folder" });
      }
      fs.rmSync(resolvedPath.absolutePath, { recursive: isDirectory, force: true });
      const restartRequired = markRestartIfNeeded(resolvedPath.relativePath);
      return res.json({
        ok: true,
        path: resolvedPath.relativePath,
        type: isDirectory ? "folder" : "file",
        ...(restartRequired ? { restartRequired: true } : {}),
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not delete path",
      });
    }
  });

  app.post("/api/browse/restore", wrapAsync(async (req, res) => {
    const { path: targetPath } = req.body || {};
    const resolvedPath = resolvePathInRoot(targetPath);
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    const relativePath = String(resolvedPath.relativePath || "").trim();
    if (!relativePath) {
      return res.status(400).json({ ok: false, error: "path is required" });
    }
    const restoreResult = await runGitCommand(
      ["restore", "--staged", "--worktree", "--", relativePath],
      kRootResolved,
    );
    const fallbackResult = !restoreResult.ok
      ? await runGitCommand(["checkout", "--", relativePath], kRootResolved)
      : { ok: true };
    if (!restoreResult.ok && !fallbackResult.ok) {
      return res.status(500).json({
        ok: false,
        error:
          restoreResult.error ||
          fallbackResult.error ||
          "Could not restore file from git",
      });
    }
    const restartRequired = markRestartIfNeeded(relativePath);
    return res.json({
      ok: true,
      path: relativePath,
      restored: fs.existsSync(resolvedPath.absolutePath),
      ...(restartRequired ? { restartRequired: true } : {}),
    });
  }));
};

module.exports = { registerBrowseRoutes };
