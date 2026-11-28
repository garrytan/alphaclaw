// OpenClaw from a sha-pinned package on the data disk (GST-3014).
//
// A deployment can run a patched build of the exact OpenClaw version AlphaClaw
// would otherwise run (the package.json pin, or the deployment's exact hold),
// for example to carry a fix before it is released. The deployment env names
// each build as <version>:<absolute path to the .tgz>:<sha256>, comma or
// newline separated, in ALPHACLAW_OPENCLAW_PACKAGES (deployment env only).
//
// Every AlphaClaw start (bin phase, before anything runs openclaw):
//   recover a torn swap → pick the entry for the stock version → verify the
//   file (path rules, sha256 of the bytes read) → unpack a private copy into
//   node_modules/.openclaw-next-<sha12> → check version, dependencies,
//   declared schemas and engines against the stock package → carry the stock
//   tree's nested node_modules over → run the package's own postinstall →
//   record a manifest of the shipped files → swap the directories.
// Before every gateway launch (gateway.js prepareGatewayLaunch): the tree
// must still be the applied build: every manifest file present and
// unchanged. Files OpenClaw adds at runtime (plugin stages and runtime
// dependencies under dist/extensions) are not in the manifest and never
// refuse a launch. When something edited the applied files and no gateway
// runs from the tree, the launch applies the package again from the verified
// file, the same way a start does, and the owner hears which files changed
// once a day (GST-3061); only a failed re-apply refuses the launch.
//
// It is never version selection: a build for any other version is ignored,
// and one that declares other databases or dependencies is refused. Any
// problem refuses the gateway (fail closed); removing the setting runs the
// image's stock build on purpose.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { satisfiesEngines } = require("../engines-range");
const { resolveOpenclawChildConfigPath } = require("./openclaw-config-path");

const kOpenclawPackagesEnvKey = "ALPHACLAW_OPENCLAW_PACKAGES";
const kPackageName = "openclaw";
const kPackageMarkerName = ".alphaclaw-package.json";
const kStagingPrefix = ".openclaw-next-";
const kStockAsidePrefix = ".openclaw-stock-";
const kSwapJournalName = ".openclaw-package-swap.json";
const kPostinstallRelativePath = "scripts/postinstall-bundled-plugins.mjs";
const kLifecyclePendingRelativePath = ".openclaw-lifecycle-pending";
const kPostinstallTimeoutMs = 120 * 1000;
const kMaxPackageBytes = 1024 * 1024 * 1024;
const kVerdictFileName = "openclaw-package.json";
const kManifestDirName = "openclaw-package";
const kExactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const kEntryPattern = /^(?:(@openclaw\/codex)@)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?):(\/.+):([0-9a-fA-F]{64})$/;
// OpenClaw's npm package does not ship the Codex plugin; a build that patches
// it too ships @openclaw/codex as a second package, installed the way
// `openclaw plugins install <tgz>` installs it: <state dir>/extensions/codex.
const kCodexPackageName = "@openclaw/codex";
const kCodexPluginDirName = "codex";
const kCodexBeforeName = "codex-before.json";
const kPluginInstallTimeoutMs = 300 * 1000;
const kCodexRollbackTimeoutMs = 120 * 1000;
const kCodexRollbackRetryMs = 30 * 60 * 1000;
const kReapplyChildPath = path.join(__dirname, "openclaw-package-reapply-child.js");
const kReapplyTimeoutMs = 10 * 60 * 1000;
const kEditedFilesKept = 20;
const kCodexVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const kGatewayProcessTitle = "openclaw-gateway";
const kGatewayServingCmdlinePattern = /(^|\s)gateway\s+(run|--force)(\s|$)|openclaw-gateway/;
const kSystemPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// Every reason a pinned package is refused, with the operator sentence.
const kRefusalCopy = Object.freeze({
  invalid_setting: "the setting has an entry that is not <version>:<absolute path>:<sha256>",
  no_entry_for_pin: "no entry is for the OpenClaw version this AlphaClaw runs",
  missing: "the package file does not exist",
  not_regular_file: "the package path is not a regular file (a symlink or a directory)",
  unsafe_mode: "the package file is writable by group or others",
  unsafe_location: "the package file is inside the OpenClaw state directory, which is synced and backed up",
  too_large: "the package file is larger than 1 GiB",
  sha_mismatch: "the package file's sha256 is not the one in the setting",
  unsafe_archive: "the package archive has an entry that is not a plain file or directory under package/",
  unpack_failed: "the package could not be unpacked",
  version_mismatch: "the package's version is not the version its entry names",
  dependencies_differ: "the package needs different dependencies than the image installed",
  schema_differs: "the package declares different database schemas than the stock build of the same version",
  node_unsupported: "the package does not support the running Node.js",
  postinstall_failed: "the package's own postinstall failed",
  plugin_mismatch: "the @openclaw/codex entry's package is not @openclaw/codex at the version its entry names",
  plugin_install_failed: "the pinned @openclaw/codex package could not be installed",
  codex_after_doctor: "the pinned @openclaw/codex package is installed once Doctor has migrated OpenClaw's data for this version, and that has not happened yet",
  plugin_not_built: "the @openclaw/codex package has no built JavaScript for an entry its package.json names (it was packed from source without a build), so OpenClaw refuses to install it",
  lifecycle_pending: "the package's postinstall did not finish its lifecycle",
  swap_failed: "the unpacked package could not be moved into place",
  deferred: "a gateway was running from the OpenClaw tree at start, so the package was not applied",
  restore_failed: "the stock build could not be restored after the setting was removed",
  stock_unreadable: "the stock OpenClaw package in the image could not be read",
  not_applied: "AlphaClaw did not apply the package at this start",
  tree_changed: "the OpenClaw files on disk are no longer the verified package",
  reapply_failed: "applying the package again before the launch failed",
});
// Refusals the file itself can clear: the self-heal watch restarts AlphaClaw
// once the file at the path verifies again.
const kFileRefusals = new Set(["missing", "not_regular_file", "unsafe_mode", "too_large", "sha_mismatch"]);

class OpenclawPackageRefusal extends Error {
  constructor(reason, detail = null) {
    super(kRefusalCopy[reason] ? `${kRefusalCopy[reason]}${detail ? ` (${detail})` : ""}` : String(reason));
    this.name = "OpenclawPackageRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const shortSha = (sha) => String(sha || "").slice(0, 12);

const readJson = (filePath, fsModule = fs) => {
  try {
    return JSON.parse(fsModule.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const writeJsonAtomic = (filePath, value, fsModule = fs) => {
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fsModule.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsModule.renameSync(tmp, filePath);
};

const removeTree = (target, fsModule = fs) => {
  try {
    fsModule.rmSync(target, { recursive: true, force: true });
  } catch {}
};

// rename(2), or a full copy then removal where the kernel refuses to rename a
// directory across layers (EXDEV: Docker's overlayfs for any directory the
// image shipped). The copy lands under a temporary name first, so `to`
// exists only once it is complete, and `<from>.moved` marks `from` as
// garbage while it is being removed. So after a crash every directory that
// exists without that mark is complete (settleMove clears the rest).
const kMovedSuffix = ".moved";

const moveDir = (from, to, fsModule = fs) => {
  try {
    fsModule.renameSync(from, to);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
  }
  const partial = `${to}.partial`;
  removeTree(partial, fsModule);
  fsModule.cpSync(from, partial, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  fsModule.renameSync(partial, to);
  fsModule.writeFileSync(`${from}${kMovedSuffix}`, "");
  fsModule.rmSync(from, { recursive: true, force: true });
  fsModule.rmSync(`${from}${kMovedSuffix}`, { force: true });
};

const settleMove = (target, fsModule = fs) => {
  removeTree(`${target}.partial`, fsModule);
  if (!fsModule.existsSync(`${target}${kMovedSuffix}`)) return;
  removeTree(target, fsModule);
  removeTree(`${target}${kMovedSuffix}`, fsModule);
};

// { set, entries: [{ name, version, file, sha256 }], errors: [entry text] }.
// An entry is [@openclaw/codex@]<version>:<absolute path>:<sha256>; without
// the prefix it is OpenClaw itself.
const parseOpenclawPackagesSetting = (raw) => {
  const text = String(raw ?? "").trim();
  if (!text) return { set: false, entries: [], errors: [] };
  const entries = [];
  const errors = [];
  for (const part of text.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean)) {
    const match = kEntryPattern.exec(part);
    const name = match?.[1] || kPackageName;
    if (!match || path.posix.normalize(match[3]) !== match[3] || entries.some((entry) => entry.name === name && entry.version === match[2])) {
      errors.push(part.slice(0, 200));
      continue;
    }
    entries.push({ name, version: match[2], file: match[3], sha256: match[4].toLowerCase() });
  }
  return { set: true, entries, errors };
};

const packagePaths = (installDir) => {
  const nodeModulesDir = path.join(installDir, "node_modules");
  return {
    nodeModulesDir,
    packageDir: path.join(nodeModulesDir, kPackageName),
    journalPath: path.join(nodeModulesDir, kSwapJournalName),
  };
};

// The facts a pinned package must share with the stock build it replaces.
const pickPackageFacts = (pkg) => ({
  version: pkg?.version ?? null,
  dependencies: pkg?.dependencies ?? {},
  optionalDependencies: pkg?.optionalDependencies ?? {},
  peerDependencies: pkg?.peerDependencies ?? {},
  bundleDependencies: pkg?.bundleDependencies ?? pkg?.bundledDependencies ?? [],
  schemaVersions: pkg?.openclaw?.schemaVersions ?? null,
  engines: pkg?.engines ?? null,
});

// What sits at node_modules/openclaw now: the image's stock build, or a
// package this module applied (its marker carries the stock facts).
const readTreeState = ({ installDir, fsModule = fs }) => {
  const { nodeModulesDir, packageDir } = packagePaths(installDir);
  const marker = readJson(path.join(packageDir, kPackageMarkerName), fsModule);
  const pkg = readJson(path.join(packageDir, "package.json"), fsModule);
  const version = typeof pkg?.version === "string" ? pkg.version : null;
  const staleMarker = Boolean(marker) && version !== null && marker.version !== version;
  if (marker && typeof marker.sha256 === "string" && !staleMarker) {
    return {
      applied: true,
      marker,
      version,
      stockVersion: marker.stockVersion ?? null,
      stockPackage: marker.stockPackage ?? null,
      stockAsideDir: marker.stockVersion ? path.join(nodeModulesDir, kStockAsidePrefix + marker.stockVersion) : null,
    };
  }
  return { applied: false, marker: null, staleMarker, version, stockVersion: version, stockPackage: pkg ? pickPackageFacts(pkg) : null, stockAsideDir: null };
};

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
};
const sameJson = (a, b) => JSON.stringify(sortKeys(a ?? null)) === JSON.stringify(sortKeys(b ?? null));
const differingKeys = (a, b) =>
  [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter((key) => (a || {})[key] !== (b || {})[key]).sort();

// Version, dependencies, schemas and engines of the unpacked package against
// the stock build. bundleDependencies may add names (a build that ships a
// dependency inside its tarball) when each extra is a declared dependency and
// is physically in the package. Returns { bundledExtras }.
const comparePackageFacts = ({ entry, candidate, stock, packageDir, nodeVersion, fsModule = fs }) => {
  if (candidate.version !== entry.version) {
    throw new OpenclawPackageRefusal("version_mismatch", `entry ${entry.version}, package ${candidate.version || "unreadable"}`);
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!sameJson(candidate[field], stock[field])) {
      throw new OpenclawPackageRefusal(
        "dependencies_differ",
        `${field}: ${differingKeys(candidate[field], stock[field]).slice(0, 8).join(", ") || "shape"}`,
      );
    }
  }
  const candidateBundled = candidate.bundleDependencies || [];
  for (const name of stock.bundleDependencies || []) {
    if (!candidateBundled.includes(name)) {
      throw new OpenclawPackageRefusal("dependencies_differ", `bundleDependencies: ${name} is no longer bundled`);
    }
  }
  const declared = { ...(candidate.dependencies || {}), ...(candidate.optionalDependencies || {}) };
  const bundledExtras = [];
  for (const name of candidateBundled) {
    if ((stock.bundleDependencies || []).includes(name)) continue;
    const present = fsModule.existsSync(path.join(packageDir, "node_modules", ...name.split("/"), "package.json"));
    if (!declared[name] || !present) {
      throw new OpenclawPackageRefusal("dependencies_differ", `bundleDependencies: ${name} is not a declared dependency shipped in the package`);
    }
    bundledExtras.push(name);
  }
  if (!sameJson(candidate.schemaVersions, stock.schemaVersions)) {
    throw new OpenclawPackageRefusal(
      "schema_differs",
      `stock ${JSON.stringify(stock.schemaVersions)}, package ${JSON.stringify(candidate.schemaVersions)}`,
    );
  }
  const range = candidate.engines?.node;
  if (typeof range === "string" && range.trim() && !satisfiesEngines(range, nodeVersion)) {
    throw new OpenclawPackageRefusal("node_unsupported", `Node ${nodeVersion}, package needs ${range}`);
  }
  return { bundledExtras };
};

const resolvedRoots = (dir, fsModule) => {
  const roots = [path.resolve(dir)];
  try {
    roots.push(fsModule.realpathSync(dir));
  } catch {}
  return roots;
};

// Path rules, then the bytes: one read through an O_NOFOLLOW descriptor,
// hashed and returned, so the bytes that are unpacked are the bytes checked.
const readVerifiedPackage = ({ entry, openclawDir, fsModule = fs }) => {
  const name = path.basename(entry.file);
  let lst;
  try {
    lst = fsModule.lstatSync(entry.file);
  } catch {
    throw new OpenclawPackageRefusal("missing", name);
  }
  if (!lst.isFile()) throw new OpenclawPackageRefusal("not_regular_file", name);
  if (lst.mode & 0o022) throw new OpenclawPackageRefusal("unsafe_mode", `mode ${(lst.mode & 0o777).toString(8)}`);
  if (lst.size > kMaxPackageBytes) throw new OpenclawPackageRefusal("too_large", `${lst.size} bytes`);
  let real = entry.file;
  try {
    real = fsModule.realpathSync(entry.file);
  } catch {}
  if (openclawDir && resolvedRoots(openclawDir, fsModule).some((dir) => real === dir || real.startsWith(dir + path.sep))) {
    throw new OpenclawPackageRefusal("unsafe_location", name);
  }
  let fd;
  try {
    fd = fsModule.openSync(entry.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch {
    throw new OpenclawPackageRefusal("not_regular_file", name);
  }
  try {
    const stat = fsModule.fstatSync(fd);
    if (!stat.isFile()) throw new OpenclawPackageRefusal("not_regular_file", name);
    if (stat.size > kMaxPackageBytes) throw new OpenclawPackageRefusal("too_large", `${stat.size} bytes`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = fsModule.readSync(fd, bytes, offset, stat.size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    const data = offset === stat.size ? bytes : bytes.subarray(0, offset);
    const actual = sha256Hex(data);
    if (actual !== entry.sha256) {
      throw new OpenclawPackageRefusal("sha_mismatch", `expected ${shortSha(entry.sha256)}…, file ${shortSha(actual)}…`);
    }
    return { data };
  } finally {
    try {
      fsModule.closeSync(fd);
    } catch {}
  }
};

// Only plain files and directories under package/, no absolute or ".." names,
// no setuid/setgid bits. Lists the archive before anything is written.
const validateArchive = ({ archivePath, tar }) => {
  const problems = [];
  tar.t({
    file: archivePath,
    sync: true,
    onReadEntry: (entry) => {
      const name = String(entry.path || "");
      const parts = name.split("/");
      const typeOk = entry.type === "File" || entry.type === "Directory" || entry.type === "OldFile";
      const nameOk = parts[0] === "package" && !name.startsWith("/") && !parts.includes("..") && !name.includes("\\");
      const modeOk = !((entry.mode || 0) & 0o6000);
      if (!typeOk || !nameOk || !modeOk) problems.push(`${entry.type} ${name.slice(0, 120)}`);
    },
  });
  if (problems.length) throw new OpenclawPackageRefusal("unsafe_archive", problems.slice(0, 3).join("; "));
};

const extractArchive = ({ archivePath, cwd, tar, filter = null }) =>
  tar.x({
    file: archivePath,
    cwd,
    sync: true,
    strip: 1,
    preserveOwner: false,
    filter: (entryPath, entry) =>
      (entry.type === "File" || entry.type === "Directory" || entry.type === "OldFile") && (!filter || filter(entryPath)),
  });

// Relative path of every file under dir, sorted; skips the marker.
const listFiles = (dir, fsModule = fs) => {
  const out = [];
  const walk = (rel) => {
    for (const dirent of fsModule.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const childRel = rel ? path.posix.join(rel, dirent.name) : dirent.name;
      if (!rel && dirent.name === kPackageMarkerName) continue;
      if (dirent.isDirectory()) walk(childRel);
      else if (dirent.isFile()) out.push(childRel);
    }
  };
  walk("");
  return out.sort();
};

const hashFile = (filePath, fsModule = fs) => sha256Hex(fsModule.readFileSync(filePath));

// The reason a child OpenClaw command failed, for the refusal detail. OpenClaw
// prints progress on stdout and the error on stderr, so the last stderr lines
// come first; stdout's tail is the fallback when stderr is empty.
const kAnsiEscape = /\u001b\[[0-9;]*[A-Za-z]/g;
const describeChildFailure = (result) => {
  if (result.error) return String(result.error.message).slice(0, 300);
  const lastLines = (text) =>
    String(text || "")
      .replace(kAnsiEscape, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3);
  const stderr = lastLines(result.stderr);
  const tail = (stderr.length ? stderr : lastLines(result.stdout)).join(" | ").slice(0, 500);
  return `exit ${result.status ?? result.signal}${tail ? `: ${tail}` : ""}`;
};

// OpenClaw's install rule for a plugin package's entries (2026.11.10
// package-entry-resolution): an entry named in openclaw.runtimeExtensions (or
// runtimeSetupEntry) must exist; otherwise a TypeScript entry needs one of its
// built candidates (./dist/<name>.js and the like), since only source
// checkouts may run TypeScript. Returns the first entry that fails, or null.
const findUnbuiltPluginEntry = (pkg, hasFile) => {
  const meta = pkg?.openclaw && typeof pkg.openclaw === "object" ? pkg.openclaw : {};
  const strings = (value) => (Array.isArray(value) ? value : []).filter((item) => typeof item === "string" && item.trim());
  const extensions = strings(meta.extensions);
  const runtime = strings(meta.runtimeExtensions);
  const entries = extensions.map((entry, index) => [entry, runtime.length === extensions.length ? runtime[index] : null]);
  if (typeof meta.setupEntry === "string" && meta.setupEntry.trim()) {
    entries.push([meta.setupEntry, typeof meta.runtimeSetupEntry === "string" && meta.runtimeSetupEntry.trim() ? meta.runtimeSetupEntry : null]);
  }
  const relative = (entry) => path.posix.normalize(entry.replace(/\\/g, "/")).replace(/^\.\//, "");
  for (const [entry, runtimeEntry] of entries) {
    if (runtimeEntry) {
      if (!hasFile(relative(runtimeEntry))) return { entry, expected: [runtimeEntry] };
      continue;
    }
    const ext = path.extname(entry).toLowerCase();
    if (![".ts", ".tsx", ".mts", ".cts"].includes(ext)) continue;
    const base = relative(entry).replace(/\.[^.]+$/, "");
    const exts = ext === ".mts" ? [".mjs", ".js", ".cjs"] : ext === ".cts" ? [".cjs", ".js", ".mjs"] : [".js", ".mjs", ".cjs"];
    const stems = [base.startsWith("src/") ? `dist/${base.slice(4)}` : `dist/${base}`, ...(base.startsWith("src/") ? [`dist/${base}`] : []), base];
    const candidates = stems.flatMap((stem) => exts.map((suffix) => `${stem}${suffix}`));
    if (!candidates.some(hasFile)) return { entry, expected: candidates.map((candidate) => `./${candidate}`) };
  }
  return null;
};

const assertPluginBuilt = (pkg, hasFile) => {
  const unbuilt = findUnbuiltPluginEntry(pkg, hasFile);
  if (unbuilt) throw new OpenclawPackageRefusal("plugin_not_built", `${unbuilt.entry}: expected ${unbuilt.expected.slice(0, 3).join(", ")}`);
};

const buildManifest = (dir, fsModule = fs) =>
  listFiles(dir, fsModule).map((rel) => {
    const filePath = path.join(dir, rel);
    const stat = fsModule.statSync(filePath);
    return [rel, stat.size, Math.trunc(stat.mtimeMs), hashFile(filePath, fsModule)];
  });

// The stock tree's nested node_modules entries the package does not ship
// (npm's conflict nesting) move into the package, so dependency resolution is
// the stock install's. Returns the moved names.
// The names to carry: every nested entry the package does not ship. Planned
// before anything moves, so the journal can name them all.
const planNestedDependencies = ({ stockDir, stagingDir, fsModule = fs }) => {
  const from = path.join(stockDir, "node_modules");
  const planned = [];
  let names;
  try {
    names = fsModule.readdirSync(from);
  } catch {
    return planned;
  }
  const consider = (name) => {
    if (!fsModule.existsSync(path.join(stagingDir, "node_modules", name))) planned.push(name);
  };
  for (const name of names.sort()) {
    if (name === ".bin" || name.startsWith(".")) continue;
    if (!name.startsWith("@")) {
      consider(name);
      continue;
    }
    let scoped = [];
    try {
      scoped = fsModule.readdirSync(path.join(from, name));
    } catch {}
    for (const child of scoped.sort()) consider(`${name}/${child}`);
  }
  return planned;
};

const carryNestedDependencies = ({ stockDir, stagingDir, planned = null, fsModule = fs }) => {
  const moved = [];
  for (const name of planned || planNestedDependencies({ stockDir, stagingDir, fsModule })) {
    const target = path.join(stagingDir, "node_modules", name);
    fsModule.mkdirSync(path.dirname(target), { recursive: true });
    moveDir(path.join(stockDir, "node_modules", name), target, fsModule);
    moved.push(name);
  }
  return moved;
};

const putNestedDependenciesBack = ({ packageDir, stockDir, moved = [], fsModule = fs }) => {
  for (const name of moved) {
    const source = path.join(packageDir, "node_modules", name);
    const target = path.join(stockDir, "node_modules", name);
    if (!fsModule.existsSync(source) || fsModule.existsSync(target)) continue;
    fsModule.mkdirSync(path.dirname(target), { recursive: true });
    moveDir(source, target, fsModule);
  }
};

// A start that died while applying (journal kind "apply", written before the
// stock tree's nested dependencies move) or restoring (kind "restore").
// Half-removed sources of an interrupted copy are cleared first, so every
// directory left is complete. Applying completed only when
// node_modules/openclaw carries this package's marker. Otherwise, with the
// stock copy set aside, whatever sits at node_modules/openclaw gives way to it
// once every carried dependency is back in it; before that, stock is still in
// place and only its carried dependencies return. Restoring completed once
// stock reached node_modules/openclaw (phase "in"); before that the same
// carry-back and move run again. Leftover staging, retired trees and partial
// copies are removed.
const recoverTornSwap = ({ installDir, fsModule = fs, logger = console }) => {
  const { nodeModulesDir, packageDir, journalPath } = packagePaths(installDir);
  const journal = readJson(journalPath, fsModule);
  if (journal) {
    const restoring = journal.kind === "restore";
    const moved = journal.movedNested || [];
    const stockAside = journal.stockAsideDir || null;
    const carriedIn = restoring ? journal.retiredDir : journal.stagingDir;
    const trees = [packageDir, stockAside, carriedIn].filter(Boolean);
    for (const tree of trees) settleMove(tree, fsModule);
    for (const tree of trees) {
      for (const name of moved) settleMove(path.join(tree, "node_modules", name), fsModule);
    }
    const swapped = !restoring && Boolean(journal.sha256) && readJson(path.join(packageDir, kPackageMarkerName), fsModule)?.sha256 === journal.sha256;
    const asideReady = Boolean(stockAside) && fsModule.existsSync(stockAside);
    if (restoring && journal.phase === "in" && fsModule.existsSync(packageDir)) {
      removeTree(stockAside, fsModule);
    } else if (!swapped && asideReady) {
      for (const source of [carriedIn, packageDir]) {
        if (source && fsModule.existsSync(source)) putNestedDependenciesBack({ packageDir: source, stockDir: stockAside, moved, fsModule });
      }
      removeTree(packageDir, fsModule);
      moveDir(stockAside, packageDir, fsModule);
      logger.warn(`[alphaclaw] openclaw package: restored the stock OpenClaw after an interrupted ${restoring ? "restore" : "swap"}`);
    } else if (!swapped && !restoring && carriedIn && fsModule.existsSync(carriedIn) && fsModule.existsSync(packageDir)) {
      putNestedDependenciesBack({ packageDir: carriedIn, stockDir: packageDir, moved, fsModule });
    }
    if (journal.retiredDir) removeTree(journal.retiredDir, fsModule);
    try {
      fsModule.unlinkSync(journalPath);
    } catch {}
  }
  let names = [];
  try {
    names = fsModule.readdirSync(nodeModulesDir);
  } catch {}
  for (const name of names) {
    if (name.startsWith(kStagingPrefix) || (name.startsWith(".openclaw-") && name.endsWith(".partial"))) {
      removeTree(path.join(nodeModulesDir, name), fsModule);
    } else if (name.endsWith(kMovedSuffix) && (name.startsWith("openclaw") || name.startsWith(".openclaw-"))) {
      removeTree(path.join(nodeModulesDir, name), fsModule);
    }
  }
};

const isGatewayRunningFrom = ({ packageDir, fsModule = fs }) => {
  let pids = [];
  try {
    pids = fsModule.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return false;
  }
  const binLink = path.join(path.dirname(packageDir), ".bin", kPackageName);
  return pids.some((pid) => {
    try {
      const argv = fsModule.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const cmdline = argv.join(" ");
      if (!kGatewayServingCmdlinePattern.test(cmdline)) return false;
      // OpenClaw's process.title overwrites its argv with the bare title, so
      // such a gateway cannot be placed: it counts as running from here.
      if (argv.length === 1 && argv[0].trim() === kGatewayProcessTitle) return true;
      return cmdline.includes(packageDir) || cmdline.includes(binLink);
    } catch {
      return false;
    }
  });
};

const verdictPath = (managedDir) => path.join(managedDir, kVerdictFileName);
const manifestPath = (managedDir, sha256) => path.join(managedDir, kManifestDirName, `${shortSha(sha256)}-manifest.json`);
const readVerdict = ({ managedDir, fsModule = fs }) => readJson(verdictPath(managedDir), fsModule);

// Puts the stock build back when the setting was removed (host installs: on
// Render a removed setting arrives with a fresh image anyway).
const restoreStock = ({ installDir, fsModule = fs, logger = console }) => {
  const { packageDir, nodeModulesDir } = packagePaths(installDir);
  const tree = readTreeState({ installDir, fsModule });
  if (!tree.applied) return false;
  const stockAside = tree.stockAsideDir;
  if (!stockAside || !fsModule.existsSync(stockAside)) throw new OpenclawPackageRefusal("restore_failed", "the stock copy is gone; redeploy, or reinstall this OpenClaw version with npm");
  const retired = path.join(nodeModulesDir, `${kStagingPrefix}retired-${shortSha(tree.marker.sha256)}`);
  const { journalPath } = packagePaths(installDir);
  const journal = { kind: "restore", phase: "out", stockAsideDir: stockAside, retiredDir: retired, movedNested: tree.marker.movedNested || [] };
  writeJsonAtomic(journalPath, journal, fsModule);
  try {
    putNestedDependenciesBack({ packageDir, stockDir: stockAside, moved: journal.movedNested, fsModule });
    moveDir(packageDir, retired, fsModule);
    writeJsonAtomic(journalPath, { ...journal, phase: "in" }, fsModule);
    moveDir(stockAside, packageDir, fsModule);
  } catch (error) {
    try {
      recoverTornSwap({ installDir, fsModule, logger });
    } catch {}
    throw new OpenclawPackageRefusal("restore_failed", String(error?.message || error).slice(0, 200));
  }
  removeTree(retired, fsModule);
  try {
    fsModule.unlinkSync(journalPath);
  } catch {}
  logger.log(`[alphaclaw] openclaw package: restored the stock OpenClaw ${tree.stockVersion}`);
  return true;
};

const defaultRunPostinstall = ({ packageDir, env = process.env }) => {
  const script = path.join(packageDir, kPostinstallRelativePath);
  if (!fs.existsSync(script)) return { ok: true, skipped: true };
  const result = spawnSync(process.execPath, [script], {
    cwd: packageDir,
    env: { PATH: kSystemPath, HOME: env.HOME || os.homedir(), TMPDIR: env.TMPDIR || os.tmpdir(), npm_lifecycle_event: "postinstall" },
    encoding: "utf8",
    timeout: kPostinstallTimeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (result.status === 0) return { ok: true };
  return { ok: false, detail: describeChildFailure(result) };
};

// Every shipped file present and unchanged: a stat match is trusted, a moved
// stat is re-hashed. Additions are not checked (OpenClaw writes plugin
// stages and runtime dependencies under dist/extensions at runtime).
const checkManifest = ({ managedDir, sha256, packageDir, fsModule = fs }) => {
  const manifest = readJson(manifestPath(managedDir, sha256), fsModule);
  if (!manifest || manifest.sha256 !== sha256 || !Array.isArray(manifest.files)) {
    throw new OpenclawPackageRefusal("tree_changed", "the manifest of the applied package is missing");
  }
  const changed = [];
  for (const [rel, size, mtimeMs, fileSha] of manifest.files) {
    const filePath = path.join(packageDir, rel);
    let stat;
    try {
      stat = fsModule.lstatSync(filePath);
    } catch {
      changed.push(`${rel} (missing)`);
      continue;
    }
    if (!stat.isFile()) {
      changed.push(`${rel} (not a file)`);
      continue;
    }
    if (stat.size === size && Math.trunc(stat.mtimeMs) === mtimeMs) continue;
    if (stat.size !== size || hashFile(filePath, fsModule) !== fileSha) changed.push(`${rel} (modified)`);
  }
  if (changed.length) {
    const refusal = new OpenclawPackageRefusal("tree_changed", `${changed.length} file(s), first ${changed[0]}`);
    refusal.files = changed.slice(0, kEditedFilesKept);
    refusal.fileCount = changed.length;
    throw refusal;
  }
  return manifest.files.length;
};

const runOpenclawPluginsCommand = ({ args, installDir, openclawDir, env = process.env, timeoutMs = kPluginInstallTimeoutMs }) => {
  const bin = path.join(packagePaths(installDir).packageDir, "openclaw.mjs");
  const result = spawnSync(process.execPath, [bin, "plugins", ...args], {
    cwd: openclawDir,
    env: {
      PATH: `${path.dirname(process.execPath)}:${kSystemPath}`,
      HOME: env.HOME || os.homedir(),
      TMPDIR: env.TMPDIR || os.tmpdir(),
      OPENCLAW_STATE_DIR: openclawDir,
      OPENCLAW_CONFIG_PATH: resolveOpenclawChildConfigPath(openclawDir, { fsModule: fs }),
      OPENCLAW_NO_AUTO_UPDATE: "1",
    },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status === 0) return { ok: true, stdout: result.stdout || "" };
  return { ok: false, detail: describeChildFailure(result) };
};

const defaultRunPluginInstall = ({ archivePath, installDir, openclawDir, env }) =>
  runOpenclawPluginsCommand({ args: ["install", archivePath, "--force", "--accept-capabilities"], installDir, openclawDir, env });

// The Codex plugin OpenClaw has installed now, wherever it lives (a .tgz
// install goes to extensions/codex, an npm install under npm/projects):
// { ok, version } with version null when there is none.
const defaultReadInstalledCodex = ({ installDir, openclawDir, env }) => {
  const result = runOpenclawPluginsCommand({ args: ["list", "--json"], installDir, openclawDir, env });
  if (!result.ok) return { ok: false, detail: result.detail || null };
  const starts = [0, ...[...result.stdout.matchAll(/\n\{/g)].map((match) => match.index + 1)];
  let listed = null;
  for (const start of starts) {
    try {
      listed = JSON.parse(result.stdout.slice(start));
      break;
    } catch {}
  }
  if (!listed) return { ok: false, detail: "plugins list --json printed no JSON" };
  const codex = (Array.isArray(listed?.plugins) ? listed.plugins : []).find((plugin) => plugin?.id === kCodexPluginDirName);
  return { ok: true, version: typeof codex?.version === "string" ? codex.version : null };
};

// Doctor still has to migrate OpenClaw's data for this version: the boot
// migration runs it when openclaw.json exists and the last Doctor that
// completed was for another version (openclaw-boot-migration.js).
const defaultCodexWaitsForDoctor = ({ managedDir, openclawDir, version, fsModule = fs }) =>
  fsModule.existsSync(path.join(openclawDir, "openclaw.json")) &&
  require("./openclaw-boot-migration").readCompletedForVersion({ managedDir, fsModule }) !== version;

// spec null: there was no Codex plugin before the pinned one, so it goes.
const defaultRunPluginRestore = ({ spec, installDir, openclawDir, env }) =>
  runOpenclawPluginsCommand({
    args: spec ? ["install", spec, "--force", "--accept-capabilities"] : ["uninstall", kCodexPluginDirName, "--force"],
    installDir,
    openclawDir,
    env,
    timeoutMs: kCodexRollbackTimeoutMs,
  });

// The pinned @openclaw/codex: every file it ships must be byte-identical in
// <state dir>/extensions/codex (the state dir survives a redeploy, so this
// normally only verifies). Otherwise OpenClaw's own installer puts it there
// and it is verified again. A manifest of those files backs the launch check.
// Its node_modules are not among them: OpenClaw's installer installs the
// plugin's dependencies itself, and 2026.11.10 replaces a bundled one (the
// Codex package's acorn) with the registry's copy of the same version.
// An install that fails over data Doctor has not migrated for this version
// yet waits instead of refusing: OpenClaw 2026.11.10 refuses a plugin install
// over 2026.11.4 state ("Client credentials require backed-up migration
// custody"), and the start applies the package before Doctor runs. The
// verdict then carries pending: "doctor" (and no version, since nothing was
// installed), the launch check refuses codex_after_doctor, and the launch
// (after Doctor) applies the package again, which installs the plugin.
const applyCodexPlugin = ({ entry, openclawDir, managedDir, installDir, env, fsModule, tar, runPluginInstall, readInstalledCodex, waitForDoctor = false, assertNoGateway = () => {}, logger }) => {
  const pluginDir = path.join(openclawDir, "extensions", kCodexPluginDirName);
  const { data } = readVerifiedPackage({ entry, openclawDir, fsModule });
  const scratch = fsModule.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-codex-package-"));
  try {
    const archivePath = path.join(scratch, path.basename(entry.file));
    const unpackDir = path.join(scratch, "package");
    fsModule.writeFileSync(archivePath, data, { mode: 0o600 });
    validateArchive({ archivePath, tar });
    fsModule.mkdirSync(unpackDir);
    try {
      extractArchive({ archivePath, cwd: unpackDir, tar });
    } catch (error) {
      throw new OpenclawPackageRefusal("unpack_failed", String(error?.message || error).slice(0, 200));
    }
    const pkg = readJson(path.join(unpackDir, "package.json"), fsModule) || {};
    if (pkg.name !== kCodexPackageName || pkg.version !== entry.version) {
      throw new OpenclawPackageRefusal("plugin_mismatch", `${pkg.name || "?"}@${pkg.version || "?"}`);
    }
    assertPluginBuilt(pkg, (rel) => fsModule.existsSync(path.join(unpackDir, rel)) && fsModule.statSync(path.join(unpackDir, rel)).isFile());
    const shipped = listFiles(unpackDir, fsModule).map((rel) => [rel, hashFile(path.join(unpackDir, rel), fsModule)]);
    const expected = shipped.filter(([rel]) => !rel.startsWith("node_modules/"));
    const differs = (files) =>
      files.filter(([rel, fileSha]) => {
        try {
          return hashFile(path.join(pluginDir, rel), fsModule) !== fileSha;
        } catch {
          return true;
        }
      });
    const firstDifference = () => differs(expected)[0];
    let installed = false;
    let bundledReplaced = [];
    if (firstDifference()) {
      assertNoGateway();
      const beforePath = path.join(managedDir, kCodexBeforeName);
      if (!fsModule.existsSync(beforePath)) {
        const current = readInstalledCodex({ installDir, openclawDir, env });
        if (current.ok) writeJsonAtomic(beforePath, { version: current.version }, fsModule);
        else logger.warn(`[alphaclaw] openclaw package: could not read the installed Codex plugin (${current.detail || "failed"}); removing the setting will leave the pinned one`);
      }
      const result = runPluginInstall({ archivePath, installDir, openclawDir, env });
      if (!result.ok && waitForDoctor) {
        logger.log(`[alphaclaw] openclaw package: ${path.basename(entry.file)} (${shortSha(entry.sha256)}) verifies but OpenClaw would not install it before Doctor has migrated its data for ${entry.version} (${result.detail || "failed"}); the gateway launch installs it after Doctor`);
        return { name: kCodexPackageName, file: path.basename(entry.file), sha256: entry.sha256, dir: pluginDir, installed: false, pending: "doctor" };
      }
      if (!result.ok) throw new OpenclawPackageRefusal("plugin_install_failed", result.detail || null);
      const still = firstDifference();
      if (still) throw new OpenclawPackageRefusal("plugin_install_failed", `extensions/codex/${still[0]} differs after the install`);
      installed = true;
      bundledReplaced = [...new Set(differs(shipped.filter(([rel]) => rel.startsWith("node_modules/"))).map(([rel]) => rel.split("/").slice(1, rel.split("/")[1].startsWith("@") ? 3 : 2).join("/")))].sort();
      if (bundledReplaced.length) {
        logger.warn(`[alphaclaw] openclaw package: OpenClaw's installer replaced the copy of ${bundledReplaced.join(", ")} that ${path.basename(entry.file)} bundles, so a change carried in that bundled copy does not run`);
      }
    }
    const files = expected.map(([rel, fileSha]) => {
      const stat = fsModule.statSync(path.join(pluginDir, rel));
      return [rel, stat.size, Math.trunc(stat.mtimeMs), fileSha];
    });
    writeJsonAtomic(manifestPath(managedDir, entry.sha256), { sha256: entry.sha256, version: entry.version, files }, fsModule);
    logger.log(`[alphaclaw] openclaw package: ${path.basename(entry.file)} (${shortSha(entry.sha256)}) ${installed ? "installed as" : "verified in"} extensions/codex, ${files.length} files`);
    return { name: kCodexPackageName, version: entry.version, file: path.basename(entry.file), sha256: entry.sha256, dir: pluginDir, installed, files: files.length, ...(bundledReplaced.length ? { bundledReplaced } : {}) };
  } finally {
    removeTree(scratch, fsModule);
  }
};

// The pinned @openclaw/codex replaced what extensions/codex held before
// (codex-before.json: that version, or null when there was none). With no
// Codex entry any more it goes back: OpenClaw reinstalls that version from npm
// or uninstalls the plugin. A failure keeps the record (with failedAt), so a
// start at least 30 minutes later retries; it never keeps the gateway down.
const rollbackCodexPlugin = ({ managedDir, installDir, openclawDir, env, fsModule, runPluginRestore, nowFn = Date.now, logger }) => {
  const beforePath = path.join(managedDir, kCodexBeforeName);
  const before = readJson(beforePath, fsModule);
  if (!before) return null;
  if (before.version != null && !kCodexVersionPattern.test(String(before.version))) {
    return { ok: false, spec: null, detail: `${kCodexBeforeName} names no valid version` };
  }
  const spec = before.version ? `${kCodexPackageName}@${before.version}` : null;
  const failedAt = Date.parse(before.failedAt || "");
  if (nowFn() - failedAt < kCodexRollbackRetryMs) {
    return { ok: false, spec, detail: `the last attempt failed at ${before.failedAt}; the next start after 30 minutes tries again` };
  }
  const action = spec ? `reinstall ${spec}` : "uninstall the pinned @openclaw/codex";
  const result = runPluginRestore({ spec, installDir, openclawDir, env });
  if (!result.ok) {
    logger.error(`[alphaclaw] openclaw package: could not ${action}; a start after 30 minutes tries again (${result.detail || "failed"})`);
    writeJsonAtomic(beforePath, { ...before, failedAt: new Date(nowFn()).toISOString() }, fsModule);
    return { ok: false, spec, detail: result.detail || null };
  }
  removeTree(beforePath, fsModule);
  logger.log(`[alphaclaw] openclaw package: the Codex entry is gone, so AlphaClaw ran ${action}`);
  return { ok: true, spec };
};

// The owner notices a start's verdict calls for: [{ message, id }]. Applied
// files something edited, which the start put back; then the setting removed
// (with a failed Codex rollback, if any), or only the Codex rollback failed.
const describeOpenclawPackageNotices = (verdict) => {
  const edited = [];
  if (verdict?.status === "applied" && Array.isArray(verdict.editedFiles)) {
    const atMs = Date.parse(verdict.at || "");
    edited.push(describeEditedPackageNotice({ files: verdict.editedFiles, fileCount: verdict.editedCount, file: verdict.file, sha256: verdict.sha256, atMs: Number.isFinite(atMs) ? atMs : Date.now() }));
  }
  return [...edited, ...describeSettingNotices(verdict)];
};

// The setting removed, or only the Codex rollback failed.
const describeSettingNotices = (verdict) => {
  const removedSha = verdict?.status === "stock" ? String(verdict.previous?.sha256 || "").slice(0, 12) : "";
  const failed = verdict?.codexRollback && !verdict.codexRollback.ok ? verdict.codexRollback : null;
  const codexLine = failed
    ? `the pinned @openclaw/codex is still installed: putting back ${failed.spec || "the state without it"} failed (${failed.detail || "no detail"}). AlphaClaw tries again at a later start.`
    : null;
  if (removedSha) {
    const lines = [
      "🐺 *AlphaClaw*",
      `Running the stock OpenClaw: ALPHACLAW_OPENCLAW_PACKAGES was removed, so the pinned package ${verdict.previous.file || ""} (${removedSha}…) is no longer used.`,
    ];
    if (codexLine) lines.push(`The ${codexLine.slice(4)}`);
    return [{ message: lines.join("\n"), id: `openclaw-package-removed-${removedSha}` }];
  }
  if (!failed) return [];
  return [
    {
      message: ["🐺 *AlphaClaw*", `The Codex entry was removed from ALPHACLAW_OPENCLAW_PACKAGES, but ${codexLine}`].join("\n"),
      id: `openclaw-package-codex-rollback-${failed.spec || "none"}`,
    },
  ];
};

// Bin phase: make node_modules/openclaw the pinned package (and verify or
// install a pinned @openclaw/codex next to it), or record why not. Never
// throws; returns the verdict it wrote.
const applyOpenclawPackageAtBoot = ({
  installDir,
  managedDir,
  openclawDir,
  env = process.env,
  nodeVersion = process.versions.node,
  fsModule = fs,
  tar = require("tar"),
  runPostinstall = defaultRunPostinstall,
  runPluginInstall = defaultRunPluginInstall,
  runPluginRestore = defaultRunPluginRestore,
  readInstalledCodex = defaultReadInstalledCodex,
  codexWaitsForDoctor = defaultCodexWaitsForDoctor,
  gatewayRunning = isGatewayRunningFrom,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  const at = new Date(nowFn()).toISOString();
  const setting = parseOpenclawPackagesSetting(env[kOpenclawPackagesEnvKey]);
  const { nodeModulesDir, packageDir, journalPath } = packagePaths(installDir);
  const record = (fields) => {
    const verdict = { at, ...fields };
    try {
      writeJsonAtomic(verdictPath(managedDir), verdict, fsModule);
    } catch (error) {
      logger.warn(`[alphaclaw] openclaw package: could not write the verdict: ${error.message}`);
    }
    return verdict;
  };
  // A refusal leaves the stock build in node_modules/openclaw, so commands
  // outside the gateway run stock. A deferral changes nothing: a gateway runs
  // from the tree (another AlphaClaw on this root, say), so the verdict keeps
  // the applied one as inPlace for that gateway's own launch checks.
  const refused = (error, fields = {}) => {
    const reason = error instanceof OpenclawPackageRefusal ? error.reason : "unpack_failed";
    const detail = error instanceof OpenclawPackageRefusal ? error.detail : String(error?.message || error).slice(0, 300);
    logger.error(`[alphaclaw] openclaw package refused (${reason}): ${kRefusalCopy[reason] || reason}${detail ? ` (${detail})` : ""}`);
    const extra = {};
    if (reason === "deferred") {
      const prior = readVerdict({ managedDir, fsModule });
      const inPlace = prior?.status === "refused" && prior.reason === "deferred" ? prior.inPlace : prior;
      if (inPlace?.status === "applied") extra.inPlace = inPlace;
    } else if (reason !== "restore_failed" && readTreeState({ installDir, fsModule }).applied && !gatewayRunning({ packageDir, fsModule })) {
      try {
        restoreStock({ installDir, fsModule, logger });
      } catch (restoreError) {
        logger.error(`[alphaclaw] openclaw package: could not put the stock build back after the refusal: ${restoreError.message}`);
      }
    }
    return record({ status: "refused", reason, detail, message: kRefusalCopy[reason] || reason, ...fields, ...extra });
  };
  // Neither installs nor rolls back the Codex plugin under a running gateway.
  const assertNoGateway = () => {
    if (gatewayRunning({ packageDir, fsModule })) throw new OpenclawPackageRefusal("deferred", "a gateway is running, so the Codex plugin was left as it is");
  };
  // The verdict before this start; a deferral's is the one it left in place.
  const lastVerdict = readVerdict({ managedDir, fsModule });
  const prior = lastVerdict?.status === "refused" && lastVerdict.reason === "deferred" ? lastVerdict.inPlace || null : lastVerdict;
  const codexBeforePath = path.join(managedDir, kCodexBeforeName);
  const codexRollbackDue = () => fsModule.existsSync(codexBeforePath) || Boolean(prior?.codex?.version && !prior.codex.pending);
  const codexRollback = () => {
    if (!codexRollbackDue()) return null;
    assertNoGateway();
    // A start that kept no record (v0.10.307) pinned it: put back npm's
    // release of that version.
    if (!fsModule.existsSync(codexBeforePath)) writeJsonAtomic(codexBeforePath, { version: prior.codex.version }, fsModule);
    return rollbackCodexPlugin({ managedDir, installDir, openclawDir, env, fsModule, runPluginRestore, nowFn, logger });
  };
  try {
    recoverTornSwap({ installDir, fsModule, logger });
  } catch (error) {
    logger.warn(`[alphaclaw] openclaw package: torn-swap recovery failed: ${error.message}`);
  }
  const current = readTreeState({ installDir, fsModule });
  if (current.staleMarker) {
    removeTree(path.join(packageDir, kPackageMarkerName), fsModule);
    logger.warn(`[alphaclaw] openclaw package: node_modules/openclaw is OpenClaw ${current.version || "unknown"} but kept an older package's marker (an update copied over it); treating it as the stock build`);
  }
  if (!setting.set) {
    const previous = readVerdict({ managedDir, fsModule });
    if ((readTreeState({ installDir, fsModule }).applied || codexRollbackDue()) && gatewayRunning({ packageDir, fsModule })) {
      return refused(new OpenclawPackageRefusal("deferred"));
    }
    try {
      const restored = restoreStock({ installDir, fsModule, logger });
      const codex = codexRollback();
      if (previous?.status === "stock" && !restored && !codex) return previous;
      return record({
        status: "stock",
        restored,
        ...(codex ? { codexRollback: codex } : {}),
        previous: prior && prior.status !== "stock" ? { status: prior.status, file: prior.file ?? null, sha256: prior.sha256 ?? null } : null,
      });
    } catch (error) {
      return refused(error);
    }
  }
  if (setting.errors.length) return refused(new OpenclawPackageRefusal("invalid_setting", setting.errors[0]));
  const tree = readTreeState({ installDir, fsModule });
  if (!tree.stockVersion || !tree.stockPackage) return refused(new OpenclawPackageRefusal("stock_unreadable"));
  const entry = setting.entries.find((candidate) => candidate.name === kPackageName && candidate.version === tree.stockVersion);
  const codexEntry = setting.entries.find((candidate) => candidate.name === kCodexPackageName && candidate.version === tree.stockVersion);
  const others = setting.entries
    .filter((candidate) => candidate !== entry && candidate !== codexEntry)
    .map(({ name, version, file, sha256 }) => ({ ...(name === kPackageName ? {} : { name }), version, file: path.basename(file), sha256 }));
  if (!entry) {
    return refused(
      new OpenclawPackageRefusal(
        "no_entry_for_pin",
        `runs ${tree.stockVersion}; entries for ${setting.entries.filter((e) => e.name === kPackageName).map((e) => e.version).join(", ") || "none"}`,
      ),
      { stockVersion: tree.stockVersion, others },
    );
  }
  const base = { version: entry.version, file: path.basename(entry.file), sha256: entry.sha256, stockVersion: tree.stockVersion, others };
  const applied = (fields) => {
    if (!codexEntry) {
      try {
        const codex = codexRollback();
        return record(codex ? { ...fields, codexRollback: codex } : fields);
      } catch (error) {
        return refused(error, base);
      }
    }
    try {
      const waitForDoctor = codexWaitsForDoctor({ managedDir, openclawDir, version: codexEntry.version, fsModule });
      return record({ ...fields, codex: applyCodexPlugin({ entry: codexEntry, openclawDir, managedDir, installDir, env, fsModule, tar, runPluginInstall, readInstalledCodex, waitForDoctor, assertNoGateway, logger }) });
    } catch (error) {
      return refused(error, { ...base, plugin: kCodexPackageName, pluginFile: path.basename(codexEntry.file), pluginSha256: codexEntry.sha256 });
    }
  };
  let edited = null;
  if (tree.applied && tree.marker.sha256 === entry.sha256) {
    let intact = true;
    try {
      readVerifiedPackage({ entry, openclawDir, fsModule });
      checkManifest({ managedDir, sha256: entry.sha256, packageDir, fsModule });
    } catch (error) {
      if (!(error instanceof OpenclawPackageRefusal && error.reason === "tree_changed")) return refused(error, base);
      intact = false;
      edited = { files: error.files || [], count: error.fileCount || 0 };
      logger.warn(`[alphaclaw] openclaw package: the applied files changed (${error.detail || "tree_changed"}); applying ${base.file} again`);
    }
    if (intact) {
      logger.log(`[alphaclaw] openclaw package: ${base.file} (${shortSha(entry.sha256)}) already in place for OpenClaw ${entry.version}`);
      return applied({ status: "applied", ...base, bundledExtras: tree.marker.bundledExtras || [], reused: true });
    }
  }
  if (gatewayRunning({ packageDir, fsModule })) return refused(new OpenclawPackageRefusal("deferred"), base);
  if (tree.applied) {
    try {
      restoreStock({ installDir, fsModule, logger });
    } catch (error) {
      return refused(error, base);
    }
  }
  const stagingDir = path.join(nodeModulesDir, kStagingPrefix + shortSha(entry.sha256));
  const archivePath = path.join(nodeModulesDir, `${kStagingPrefix}${shortSha(entry.sha256)}.tgz`);
  const stockAsideDir = path.join(nodeModulesDir, kStockAsidePrefix + tree.stockVersion);
  const startedAt = nowFn();
  let journaled = false;
  try {
    const { data } = readVerifiedPackage({ entry, openclawDir, fsModule });
    removeTree(stockAsideDir, fsModule);
    fsModule.writeFileSync(archivePath, data, { mode: 0o600 });
    validateArchive({ archivePath, tar });
    fsModule.mkdirSync(stagingDir, { recursive: true, mode: 0o755 });
    try {
      extractArchive({ archivePath, cwd: stagingDir, tar });
    } catch (error) {
      throw new OpenclawPackageRefusal("unpack_failed", String(error?.message || error).slice(0, 200));
    }
    removeTree(archivePath, fsModule);
    const candidate = pickPackageFacts(readJson(path.join(stagingDir, "package.json"), fsModule));
    const { bundledExtras } = comparePackageFacts({ entry, candidate, stock: tree.stockPackage, packageDir: stagingDir, nodeVersion, fsModule });
    const planned = planNestedDependencies({ stockDir: packageDir, stagingDir, fsModule });
    writeJsonAtomic(journalPath, { kind: "apply", stagingDir, stockAsideDir, movedNested: planned, sha256: entry.sha256 }, fsModule);
    journaled = true;
    const moved = carryNestedDependencies({ stockDir: packageDir, stagingDir, planned, fsModule });
    const post = runPostinstall({ packageDir: stagingDir, env });
    if (!post.ok) throw new OpenclawPackageRefusal("postinstall_failed", post.detail || null);
    if (fsModule.existsSync(path.join(stagingDir, kLifecyclePendingRelativePath))) throw new OpenclawPackageRefusal("lifecycle_pending");
    const manifest = buildManifest(stagingDir, fsModule);
    writeJsonAtomic(manifestPath(managedDir, entry.sha256), { sha256: entry.sha256, version: entry.version, files: manifest }, fsModule);
    writeJsonAtomic(path.join(stagingDir, kPackageMarkerName), {
      sha256: entry.sha256,
      version: entry.version,
      file: path.basename(entry.file),
      stockVersion: tree.stockVersion,
      stockPackage: tree.stockPackage,
      movedNested: moved,
      bundledExtras,
      appliedAt: at,
    }, fsModule);
    try {
      moveDir(packageDir, stockAsideDir, fsModule);
      moveDir(stagingDir, packageDir, fsModule);
    } catch (error) {
      throw new OpenclawPackageRefusal("swap_failed", String(error?.message || error).slice(0, 200));
    }
    try {
      fsModule.unlinkSync(journalPath);
    } catch {}
    const tookMs = nowFn() - startedAt;
    logger.log(`[alphaclaw] openclaw package: applied ${base.file} (${shortSha(entry.sha256)}) for OpenClaw ${entry.version} in ${tookMs}ms, ${manifest.length} files`);
    return applied({ status: "applied", ...base, bundledExtras, files: manifest.length, tookMs, ...(edited ? { editedFiles: edited.files, editedCount: edited.count } : {}) });
  } catch (error) {
    if (journaled) {
      try {
        recoverTornSwap({ installDir, fsModule, logger });
      } catch (recoveryError) {
        logger.error(`[alphaclaw] openclaw package: undoing the failed apply failed (${recoveryError?.message || recoveryError}); the next start retries it`);
      }
    } else {
      removeTree(stagingDir, fsModule);
    }
    removeTree(archivePath, fsModule);
    return refused(error, base);
  }
};

// Before every gateway launch. Read-only. With the setting unset, returns null
// once node_modules/openclaw is no longer a pinned package (else the start
// could not restore stock); with it set, returns the applied verdict. A
// deferral is judged by the verdict it left in place. Throws
// OpenclawPackageRefusal.
const checkOpenclawPackageBeforeLaunch = ({ installDir, managedDir, env = process.env, fsModule = fs } = {}) => {
  const setting = parseOpenclawPackagesSetting(env[kOpenclawPackagesEnvKey]);
  if (!setting.set) {
    if (!readTreeState({ installDir, fsModule }).applied) return null;
    const last = readVerdict({ managedDir, fsModule });
    const reason = last?.status === "refused" && ["deferred", "restore_failed"].includes(last.reason) ? last.reason : "restore_failed";
    throw new OpenclawPackageRefusal(reason, last?.status === "refused" ? last.detail || null : "node_modules/openclaw is still the pinned package");
  }
  const recorded = readVerdict({ managedDir, fsModule });
  const verdict = recorded?.status === "refused" && recorded.reason === "deferred" && recorded.inPlace?.status === "applied" ? recorded.inPlace : recorded;
  if (!verdict || verdict.status === "stock") throw new OpenclawPackageRefusal("not_applied");
  if (verdict.status !== "applied") {
    throw new OpenclawPackageRefusal(kRefusalCopy[verdict.reason] ? verdict.reason : "not_applied", verdict.detail || null);
  }
  if (!setting.entries.some((candidate) => candidate.sha256 === verdict.sha256)) {
    throw new OpenclawPackageRefusal("not_applied", "the setting changed since this start");
  }
  const { packageDir } = packagePaths(installDir);
  const tree = readTreeState({ installDir, fsModule });
  if (!tree.applied || tree.marker.sha256 !== verdict.sha256) {
    throw new OpenclawPackageRefusal("tree_changed", "node_modules/openclaw is not the applied package");
  }
  checkManifest({ managedDir, sha256: verdict.sha256, packageDir, fsModule });
  const codexEntry = setting.entries.find((candidate) => candidate.name === kCodexPackageName && candidate.version === verdict.version);
  if (codexEntry && codexEntry.sha256 !== verdict.codex?.sha256) throw new OpenclawPackageRefusal("not_applied", "the setting changed since this start");
  if (verdict.codex?.pending === "doctor") throw new OpenclawPackageRefusal("codex_after_doctor", verdict.codex.file || null);
  if (verdict.codex) {
    try {
      checkManifest({ managedDir, sha256: verdict.codex.sha256, packageDir: verdict.codex.dir, fsModule });
    } catch (error) {
      if (error instanceof OpenclawPackageRefusal && error.reason === "tree_changed") {
        const refusal = new OpenclawPackageRefusal("tree_changed", `extensions/codex: ${error.detail}`);
        refusal.files = (error.files || []).map((rel) => `extensions/codex/${rel}`);
        refusal.fileCount = error.fileCount || 0;
        throw refusal;
      }
      throw error;
    }
  }
  return verdict;
};

// The files behind the applied verdict (OpenClaw's and a pinned
// @openclaw/codex) still verify at their paths: a restart asks this before it
// stops the serving gateway, so a missing or wrong file refuses with that
// gateway still up instead of after the stop. Throws OpenclawPackageRefusal.
const verifyOpenclawPackageFiles = ({ managedDir, openclawDir, env = process.env, fsModule = fs } = {}) => {
  const setting = parseOpenclawPackagesSetting(env[kOpenclawPackagesEnvKey]);
  const recorded = readVerdict({ managedDir, fsModule });
  const verdict = recorded?.status === "refused" && recorded.reason === "deferred" && recorded.inPlace?.status === "applied" ? recorded.inPlace : recorded;
  for (const sha256 of [verdict?.sha256, verdict?.codex?.sha256].filter(Boolean)) {
    const entry = setting.entries.find((candidate) => candidate.sha256 === sha256);
    if (!entry) throw new OpenclawPackageRefusal("not_applied", "the setting changed since this start");
    readVerifiedPackage({ entry, openclawDir, fsModule });
  }
};

// Runs a start's apply (applyOpenclawPackageAtBoot) in a child process, so
// the unpack, the postinstall and a Codex install never block the server's
// event loop. Its log lines go to AlphaClaw's own output; the verdict file
// carries the result. It runs in its own process group, so a timeout kills
// its postinstall or plugin install too; a child killed partway is undone by
// the next apply's torn-swap recovery, like a killed start.
const defaultRunReapply = ({ installDir, managedDir, openclawDir, env = process.env, timeoutMs = kReapplyTimeoutMs }) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [kReapplyChildPath, installDir, managedDir, openclawDir], {
        env,
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
      });
    } catch (error) {
      resolve({ ok: false, detail: String(error?.message || error).slice(0, 200) });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: String(error?.message || error).slice(0, 200) });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, detail: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `exit ${code ?? signal}` });
    });
  });

// One re-apply at a time per install: a second launch while one runs (a
// lifecycle hold that lapsed, say) waits for that one instead of starting an
// apply whose torn-swap recovery would undo the first one's swap.
const reapplyInFlight = new Map();

// A launch whose check refused tree_changed (something edited the applied
// files): with no gateway running from the tree, apply the package again
// from the verified file, then check again. Resolves { verdict, files,
// fileCount }; rejects with the original refusal while a gateway runs from
// the tree, and with the re-apply's own refusal (missing file, wrong sha,
// unpack or postinstall failure, ...) when it fails, which leaves the stock
// build in place the way a refused start does.
const reapplyOpenclawPackageForLaunch = async ({
  installDir,
  managedDir,
  openclawDir,
  refusal,
  env = process.env,
  runReapply = defaultRunReapply,
  gatewayRunning = isGatewayRunningFrom,
  fsModule = fs,
  logger = console,
} = {}) => {
  const { packageDir } = packagePaths(installDir);
  let pending = reapplyInFlight.get(packageDir);
  if (!pending) {
    if (gatewayRunning({ packageDir, fsModule })) throw refusal;
    if (refusal?.reason === "codex_after_doctor") logger.log("[alphaclaw] openclaw package: applying the package again before the launch, to install the pinned @openclaw/codex now that Doctor has run");
    else logger.warn(`[alphaclaw] openclaw package: the applied files changed (${refusal?.detail || "tree_changed"}); applying the package again before the launch`);
    pending = Promise.resolve()
      .then(() => runReapply({ installDir, managedDir, openclawDir, env }))
      .finally(() => reapplyInFlight.delete(packageDir));
    reapplyInFlight.set(packageDir, pending);
  }
  const run = await pending;
  if (!run?.ok) throw new OpenclawPackageRefusal("reapply_failed", run?.detail || null);
  const verdict = readVerdict({ managedDir, fsModule });
  if (verdict?.status !== "applied") {
    const reason = verdict?.status === "refused" && kRefusalCopy[verdict.reason] ? verdict.reason : "reapply_failed";
    throw new OpenclawPackageRefusal(reason, verdict?.detail || null);
  }
  return {
    verdict: checkOpenclawPackageBeforeLaunch({ installDir, managedDir, env, fsModule }),
    files: refusal?.files || [],
    fileCount: refusal?.fileCount || 0,
  };
};

// The owner notice for an applied package something edited: which files, and
// that AlphaClaw put the verified package back. One a day per package: the
// id carries the UTC day, so a start and a launch on the same day share it.
const describeEditedPackageNotice = ({ files = [], fileCount = 0, file = null, sha256 = null, atMs = Date.now() } = {}) => {
  const sha = shortSha(sha256);
  const shown = files.slice(0, 5);
  const more = Math.max(fileCount, files.length) - shown.length;
  return {
    message: [
      "🐺 *AlphaClaw*",
      "🟡 Something edited the pinned OpenClaw files, so AlphaClaw put the verified package back",
      `Changed: ${shown.join(", ") || "unknown"}${more > 0 ? `, and ${more} more` : ""}`,
      ...(file ? [`Package: ${file}${sha ? ` (${sha}…)` : ""}`] : []),
      "The gateway runs the verified package. Find what edits node_modules/openclaw (a cron job, a startup script, a hand patch) and stop it: AlphaClaw puts the package back before each gateway launch, which makes every launch slower.",
    ].join("\n"),
    id: `openclaw-package-edited-${sha || "none"}-${new Date(atMs).toISOString().slice(0, 10)}`,
  };
};

// After a file refusal, the file at the entry's path is re-checked every
// interval; once it verifies, onRestorable runs once (the server restarts
// AlphaClaw so the next start applies it). Returns a stop function.
const watchForPackageRestore = ({
  managedDir,
  openclawDir,
  env = process.env,
  intervalMs = 60 * 1000,
  onRestorable,
  fsModule = fs,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
} = {}) => {
  const verdict = readVerdict({ managedDir, fsModule });
  if (verdict?.status !== "refused" || !kFileRefusals.has(verdict.reason)) return () => {};
  const setting = parseOpenclawPackagesSetting(env[kOpenclawPackagesEnvKey]);
  const entry = setting.entries.find((candidate) => candidate.sha256 === (verdict.pluginSha256 || verdict.sha256));
  if (!entry) return () => {};
  let lastStat = null;
  let fired = false;
  const timer = setIntervalFn(() => {
    if (fired) return;
    let stat = null;
    try {
      stat = fsModule.statSync(entry.file);
    } catch {}
    const key = stat ? `${stat.size}:${stat.mtimeMs}:${stat.mode}:${stat.ino}` : "none";
    if (key === lastStat || !stat) {
      lastStat = key;
      return;
    }
    lastStat = key;
    try {
      readVerifiedPackage({ entry, openclawDir, fsModule });
    } catch {
      return;
    }
    fired = true;
    clearIntervalFn(timer);
    logger.log(`[alphaclaw] openclaw package: ${path.basename(entry.file)} verifies again; restarting AlphaClaw to apply it`);
    try {
      onRestorable?.({ version: entry.version, file: path.basename(entry.file), sha256: entry.sha256 });
    } catch {}
  }, intervalMs);
  timer?.unref?.();
  return () => clearIntervalFn(timer);
};

// For status and diagnose: the entries (file names only), the verdict and
// what the tree holds now.
const describeOpenclawPackage = ({ installDir, managedDir, env = process.env, fsModule = fs } = {}) => {
  const setting = parseOpenclawPackagesSetting(env[kOpenclawPackagesEnvKey]);
  const tree = installDir ? readTreeState({ installDir, fsModule }) : null;
  return {
    envKey: kOpenclawPackagesEnvKey,
    set: setting.set,
    entries: setting.entries.map(({ name, version, file, sha256 }) => ({ name, version, file: path.basename(file), sha256 })),
    invalidEntries: setting.errors.length,
    verdict: managedDir ? readVerdict({ managedDir, fsModule }) : null,
    build: tree?.applied ? "pinned_package" : "stock",
    packageSha256: tree?.applied ? tree.marker.sha256 : null,
    packageFile: tree?.applied ? tree.marker.file || null : null,
    stockVersion: tree?.stockVersion ?? null,
  };
};

// alphaclaw openclaw-package check [--pin <version>]: read-only. Verifies the
// entry for the stock version (or <version>) without touching the tree. A
// version that is not installed yet has no stock build to compare
// dependencies and schemas with: those checks are named as not run.
const checkOpenclawPackageSetting = ({ installDir, openclawDir, env = process.env, pin = null, nodeVersion = process.versions.node, fsModule = fs, tar = require("tar") } = {}) => {
  const setting = parseOpenclawPackagesSetting(env[kOpenclawPackagesEnvKey]);
  if (!setting.set) return { ok: true, set: false, message: `${kOpenclawPackagesEnvKey} is not set: AlphaClaw runs the stock OpenClaw.` };
  if (pin && !kExactVersion.test(pin)) return { ok: false, usage: true, reason: "usage", message: "--pin needs an exact version such as 2026.11.5" };
  if (setting.errors.length) return { ok: false, reason: "invalid_setting", message: kRefusalCopy.invalid_setting, detail: setting.errors[0] };
  const tree = readTreeState({ installDir, fsModule });
  const target = pin || tree.stockVersion;
  const entry = setting.entries.find((candidate) => candidate.name === kPackageName && candidate.version === target);
  const codexEntry = setting.entries.find((candidate) => candidate.name === kCodexPackageName && candidate.version === target);
  if (!entry) {
    return {
      ok: false,
      reason: "no_entry_for_pin",
      message: kRefusalCopy.no_entry_for_pin,
      detail: `version ${target}; entries for ${setting.entries.filter((e) => e.name === kPackageName).map((e) => e.version).join(", ") || "none"}`,
    };
  }
  let scratch = null;
  try {
    const { data } = readVerifiedPackage({ entry, openclawDir, fsModule });
    scratch = fsModule.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-openclaw-package-"));
    const archivePath = path.join(scratch, "package.tgz");
    const unpackDir = path.join(scratch, "package");
    fsModule.writeFileSync(archivePath, data, { mode: 0o600 });
    validateArchive({ archivePath, tar });
    fsModule.mkdirSync(unpackDir);
    extractArchive({
      archivePath,
      cwd: unpackDir,
      tar,
      filter: (entryPath) => entryPath === "package/package.json" || /^package\/node_modules\/(@[^/]+\/)?[^/]+\/package\.json$/.test(entryPath),
    });
    const candidate = pickPackageFacts(readJson(path.join(unpackDir, "package.json"), fsModule));
    const notChecked = [];
    if (target === tree.stockVersion && tree.stockPackage) {
      comparePackageFacts({ entry, candidate, stock: tree.stockPackage, packageDir: unpackDir, nodeVersion, fsModule });
    } else {
      if (candidate.version !== entry.version) throw new OpenclawPackageRefusal("version_mismatch", `entry ${entry.version}, package ${candidate.version}`);
      const range = candidate.engines?.node;
      if (typeof range === "string" && range.trim() && !satisfiesEngines(range, nodeVersion)) {
        throw new OpenclawPackageRefusal("node_unsupported", `Node ${nodeVersion}, package needs ${range}`);
      }
      notChecked.push("dependencies", "schemas");
    }
    let plugin = null;
    if (codexEntry) {
      const { data: pluginData } = readVerifiedPackage({ entry: codexEntry, openclawDir, fsModule });
      const pluginArchive = path.join(scratch, "plugin.tgz");
      const pluginDir = path.join(scratch, "plugin");
      fsModule.writeFileSync(pluginArchive, pluginData, { mode: 0o600 });
      validateArchive({ archivePath: pluginArchive, tar });
      fsModule.mkdirSync(pluginDir);
      const shipped = new Set();
      extractArchive({
        archivePath: pluginArchive,
        cwd: pluginDir,
        tar,
        filter: (entryPath) => {
          shipped.add(path.posix.normalize(entryPath).replace(/^package\//, ""));
          return entryPath === "package/package.json";
        },
      });
      const pluginPkg = readJson(path.join(pluginDir, "package.json"), fsModule) || {};
      if (pluginPkg.name !== kCodexPackageName || pluginPkg.version !== codexEntry.version) {
        throw new OpenclawPackageRefusal("plugin_mismatch", `${pluginPkg.name || "?"}@${pluginPkg.version || "?"}`);
      }
      assertPluginBuilt(pluginPkg, (rel) => shipped.has(rel));
      plugin = { name: kCodexPackageName, file: path.basename(codexEntry.file), sha256: codexEntry.sha256 };
    }
    return {
      ok: true,
      set: true,
      version: entry.version,
      file: path.basename(entry.file),
      sha256: entry.sha256,
      notChecked,
      plugin,
      message: notChecked.length
        ? `${path.basename(entry.file)} verifies for OpenClaw ${entry.version}. Its dependencies and database schemas are compared with the stock build when that version is installed.`
        : `${path.basename(entry.file)} verifies for OpenClaw ${entry.version}${plugin ? `, and ${plugin.file} for @openclaw/codex` : ""}.`,
    };
  } catch (error) {
    if (!(error instanceof OpenclawPackageRefusal)) {
      return { ok: false, reason: "unpack_failed", message: kRefusalCopy.unpack_failed, detail: String(error?.message || error).slice(0, 200) };
    }
    return { ok: false, reason: error.reason, message: kRefusalCopy[error.reason], detail: error.detail };
  } finally {
    if (scratch) removeTree(scratch, fsModule);
  }
};

module.exports = {
  kOpenclawPackagesEnvKey,
  kPackageMarkerName,
  kRefusalCopy,
  kFileRefusals,
  OpenclawPackageRefusal,
  kCodexPackageName,
  parseOpenclawPackagesSetting,
  readTreeState,
  pickPackageFacts,
  comparePackageFacts,
  readVerifiedPackage,
  validateArchive,
  carryNestedDependencies,
  recoverTornSwap,
  applyOpenclawPackageAtBoot,
  checkManifest,
  checkOpenclawPackageBeforeLaunch,
  verifyOpenclawPackageFiles,
  reapplyOpenclawPackageForLaunch,
  describeEditedPackageNotice,
  watchForPackageRestore,
  describeOpenclawPackage,
  checkOpenclawPackageSetting,
  readVerdict,
  describeOpenclawPackageNotices,
  isGatewayRunningFrom,
  shortSha,
};
