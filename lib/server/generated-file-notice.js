const path = require("path");
const { isGitSyncOff } = require("../cli/git-sync");

// With git sync off another writer owns the repository, so a generated file
// AlphaClaw rewrote with new content stays uncommitted until that writer
// commits it. Say so once per change, naming the repository-relative path
// only (never the command, never an absolute path).
const noteGeneratedFileChanged = ({
  filePath,
  openclawDir,
  fallbackName,
  env = process.env,
  logger = console,
}) => {
  if (!isGitSyncOff(env)) return;
  const relativePath = path.relative(openclawDir, filePath);
  const name =
    relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
      ? relativePath.split(path.sep).join("/")
      : fallbackName;
  const hasWriter = String(env.ALPHACLAW_GIT_WRITER_COMMAND || "").trim() !== "";
  const how = hasWriter
    ? "commit it with this repository's writer (ALPHACLAW_GIT_WRITER_COMMAND)"
    : "commit it with the tool that owns this repository";
  logger.log(
    `[alphaclaw] ${name} was regenerated with new content and git sync is off (ALPHACLAW_GIT_SYNC=off); ${how}`,
  );
};

module.exports = { noteGeneratedFileChanged };
