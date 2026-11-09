const fs = require("fs");
const path = require("path");

// Tools kept on the persistent disk (the state dir's bin, then ~/.local/bin
// where uv installs tools) outlive a container rebuild, but the links that
// put them on PATH live in the container layer and do not. Boot
// relinks them into /usr/local/bin (bin/alphaclaw.js, root installs only).
// A tool never takes over a name the image or the system already provides,
// unless the owner lists it in alphaclaw.json tools.allowShadow, and a file
// or link AlphaClaw did not create is never replaced.
const kSafeToolName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const kNeverLinkNames = Object.freeze([
  "git",
  "node",
  "npm",
  "npx",
  "openclaw",
  "alphaclaw",
  "claude",
  "systemctl",
  "sh",
  "bash",
  "dash",
  "env",
  "sudo",
  "python3",
  "curl",
  "tar",
  "ssh",
]);

const isExecutableFile = (fsModule, filePath) => {
  try {
    const stat = fsModule.statSync(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

// Only entries directly in the folder: a subdirectory is never walked.
const listToolNames = (fsModule, dir) => {
  let entries;
  try {
    entries = fsModule.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && kSafeToolName.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => isExecutableFile(fsModule, path.join(dir, name)))
    .sort();
};

// { linked, kept, skipped: [{ name, reason, stillLinked? }] }. linked: created
// or repaired this boot; kept: already linked to this copy. The first source
// dir wins a name. Reasons: reserved, shadows=<path>, regular_file,
// foreign_symlink, link_failed=<errno>. Nothing is ever deleted: a shadowed
// name whose old link into a source dir is still there (the owner dropped it
// from allowShadow) is marked stillLinked, so the log says which copy runs.
const relinkPersistentBins = ({
  sourceDirs = [],
  linkDir,
  pathDirs = [],
  neverLink = kNeverLinkNames,
  allowShadow = [],
  fs: fsModule = fs,
} = {}) => {
  const sources = sourceDirs.map((dir) => path.resolve(dir));
  const resolvedLinkDir = path.resolve(linkDir);
  const otherPathDirs = [
    ...new Set(
      pathDirs
        .filter(Boolean)
        .map((dir) => path.resolve(dir))
        .filter((dir) => dir !== resolvedLinkDir && !sources.includes(dir)),
    ),
  ];
  const realpathOrNull = (filePath) => {
    try {
      return fsModule.realpathSync(filePath);
    } catch {
      return null;
    }
  };
  const result = { linked: [], kept: [], skipped: [] };
  const seen = new Set();
  for (const sourceDir of sources) {
    for (const name of listToolNames(fsModule, sourceDir)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (neverLink.includes(name)) {
        result.skipped.push({ name, reason: "reserved" });
        continue;
      }
      const target = path.join(sourceDir, name);
      const linkPath = path.join(resolvedLinkDir, name);
      let existing = null;
      try {
        existing = fsModule.lstatSync(linkPath);
      } catch {}
      let current = null;
      if (existing?.isSymbolicLink()) {
        try {
          current = path.resolve(resolvedLinkDir, fsModule.readlinkSync(linkPath));
        } catch {}
      }
      const intoSources = current !== null && sources.includes(path.dirname(current));
      const ownCopy = realpathOrNull(target);
      const shadowed = allowShadow.includes(name)
        ? null
        : otherPathDirs
            .map((dir) => path.join(dir, name))
            .find((candidate) => isExecutableFile(fsModule, candidate) && realpathOrNull(candidate) !== ownCopy);
      if (shadowed) {
        result.skipped.push({ name, reason: `shadows=${shadowed}`, ...(intoSources ? { stillLinked: true } : {}) });
        continue;
      }
      if (existing && !existing.isSymbolicLink()) {
        result.skipped.push({ name, reason: "regular_file" });
        continue;
      }
      if (current === target) {
        result.kept.push(name);
        continue;
      }
      if (existing && !intoSources && (current === null || fsModule.existsSync(linkPath))) {
        result.skipped.push({ name, reason: "foreign_symlink" });
        continue;
      }
      try {
        if (existing) fsModule.unlinkSync(linkPath);
        fsModule.symlinkSync(target, linkPath);
        result.linked.push(name);
      } catch (error) {
        result.skipped.push({ name, reason: `link_failed=${error?.code || "unknown"}` });
      }
    }
  }
  return result;
};

const describeSkipFix = ({ name, reason, stillLinked }, linkDir) => {
  if (reason === "reserved") return "AlphaClaw never links this name; call the tool by its full path";
  if (reason.startsWith("shadows=") && stillLinked) {
    return `${path.join(linkDir, name)} still links to the persistent copy, so that copy runs; remove the link to use the image's copy, or add "${name}" to tools.allowShadow in alphaclaw.json to keep it`;
  }
  if (reason.startsWith("shadows=")) {
    return `the image already provides it; add "${name}" to tools.allowShadow in alphaclaw.json to use the persistent copy instead, or call it by its full path`;
  }
  if (reason === "regular_file") {
    return `${path.join(linkDir, name)} is a file AlphaClaw did not create; remove it to use the persistent copy`;
  }
  if (reason === "foreign_symlink") {
    return `${path.join(linkDir, name)} links somewhere else; remove it to use the persistent copy`;
  }
  return `check that ${linkDir} is writable`;
};

// The boot log: one summary line, then one line per skipped name with its
// fix. Nothing when the source dirs hold no tools (or do not exist).
const formatPersistentBinsLog = ({ result, sourceDirs, linkDir }) => {
  if (result.linked.length + result.kept.length + result.skipped.length === 0) return [];
  return [
    `[alphaclaw] persistent tools: linked=${result.linked.length} kept=${result.kept.length} skipped=${result.skipped.length} (${sourceDirs.join(", ")})`,
    ...result.skipped.map(
      (skip) => `[alphaclaw] persistent tools: skipped ${skip.name} (${skip.reason}): ${describeSkipFix(skip, linkDir)}`,
    ),
  ];
};

module.exports = {
  kNeverLinkNames,
  relinkPersistentBins,
  formatPersistentBinsLog,
};
