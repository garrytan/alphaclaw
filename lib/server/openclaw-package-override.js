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
// Before every gateway launch (gateway.js prepareGatewayLaunch): read-only.
// The tree must still be the applied build: every manifest file present and
// unchanged. Files OpenClaw adds at runtime (plugin stages and runtime
// dependencies under dist/extensions) are not in the manifest and never
// refuse a launch.
//
// It is never version selection: a build for any other version is ignored,
// and one that declares other databases or dependencies is refused. Any
// problem refuses the gateway (fail closed); removing the setting runs the
// image's stock build on purpose.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
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
const kPluginInstallTimeoutMs = 300 * 1000;
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
  lifecycle_pending: "the package's postinstall did not finish its lifecycle",
  swap_failed: "the unpacked package could not be moved into place",
  deferred: "a gateway was running from the OpenClaw tree at start, so the package was not applied",
  restore_failed: "the stock build could not be restored after the setting was removed",
  stock_unreadable: "the stock OpenClaw package in the image could not be read",
  not_applied: "AlphaClaw did not apply the package at this start",
  tree_changed: "the OpenClaw files on disk are no longer the verified package",
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
  if (marker && typeof marker.sha256 === "string") {
    return {
      applied: true,
      marker,
      version,
      stockVersion: marker.stockVersion ?? null,
      stockPackage: marker.stockPackage ?? null,
      stockAsideDir: marker.stockVersion ? path.join(nodeModulesDir, kStockAsidePrefix + marker.stockVersion) : null,
    };
  }
  return { applied: false, marker: null, version, stockVersion: version, stockPackage: pkg ? pickPackageFacts(pkg) : null, stockAsideDir: null };
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
      const cmdline = fsModule.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
      if (!kGatewayServingCmdlinePattern.test(cmdline)) return false;
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
  if (!stockAside || !fsModule.existsSync(stockAside)) throw new OpenclawPackageRefusal("restore_failed", "the stock tree is gone");
  const retired = path.join(nodeModulesDir, `${kStagingPrefix}retired-${shortSha(tree.marker.sha256)}`);
  const { journalPath } = packagePaths(installDir);
  const journal = { kind: "restore", phase: "out", stockAsideDir: stockAside, retiredDir: retired, movedNested: tree.marker.movedNested || [] };
  writeJsonAtomic(journalPath, journal, fsModule);
  putNestedDependenciesBack({ packageDir, stockDir: stockAside, moved: journal.movedNested, fsModule });
  moveDir(packageDir, retired, fsModule);
  writeJsonAtomic(journalPath, { ...journal, phase: "in" }, fsModule);
  moveDir(stockAside, packageDir, fsModule);
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
  const tail = `${result.stderr || ""}${result.stdout || ""}`.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
  return { ok: false, detail: result.error ? String(result.error.message) : `exit ${result.status ?? result.signal}${tail ? `: ${tail}` : ""}` };
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
  if (changed.length) throw new OpenclawPackageRefusal("tree_changed", `${changed.length} file(s), first ${changed[0]}`);
  return manifest.files.length;
};

const defaultRunPluginInstall = ({ archivePath, installDir, openclawDir, env = process.env }) => {
  const bin = path.join(packagePaths(installDir).packageDir, "openclaw.mjs");
  const result = spawnSync(process.execPath, [bin, "plugins", "install", archivePath, "--force", "--accept-capabilities"], {
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
    timeout: kPluginInstallTimeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status === 0) return { ok: true };
  const tail = `${result.stderr || ""}${result.stdout || ""}`.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
  return { ok: false, detail: result.error ? String(result.error.message) : `exit ${result.status ?? result.signal}${tail ? `: ${tail}` : ""}` };
};

// The pinned @openclaw/codex: every file it ships must be byte-identical in
// <state dir>/extensions/codex (the state dir survives a redeploy, so this
// normally only verifies). Otherwise OpenClaw's own installer puts it there
// and it is verified again. A manifest of those files backs the launch check.
const applyCodexPlugin = ({ entry, openclawDir, managedDir, installDir, env, fsModule, tar, runPluginInstall, logger }) => {
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
    const expected = listFiles(unpackDir, fsModule).map((rel) => [rel, hashFile(path.join(unpackDir, rel), fsModule)]);
    const firstDifference = () =>
      expected.find(([rel, fileSha]) => {
        try {
          return hashFile(path.join(pluginDir, rel), fsModule) !== fileSha;
        } catch {
          return true;
        }
      });
    let installed = false;
    if (firstDifference()) {
      const result = runPluginInstall({ archivePath, installDir, openclawDir, env });
      if (!result.ok) throw new OpenclawPackageRefusal("plugin_install_failed", result.detail || null);
      const still = firstDifference();
      if (still) throw new OpenclawPackageRefusal("plugin_install_failed", `extensions/codex/${still[0]} differs after the install`);
      installed = true;
    }
    const files = expected.map(([rel, fileSha]) => {
      const stat = fsModule.statSync(path.join(pluginDir, rel));
      return [rel, stat.size, Math.trunc(stat.mtimeMs), fileSha];
    });
    writeJsonAtomic(manifestPath(managedDir, entry.sha256), { sha256: entry.sha256, version: entry.version, files }, fsModule);
    logger.log(`[alphaclaw] openclaw package: ${path.basename(entry.file)} (${shortSha(entry.sha256)}) ${installed ? "installed as" : "verified in"} extensions/codex, ${files.length} files`);
    return { name: kCodexPackageName, version: entry.version, file: path.basename(entry.file), sha256: entry.sha256, dir: pluginDir, installed, files: files.length };
  } finally {
    removeTree(scratch, fsModule);
  }
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
  const refused = (error, fields = {}) => {
    const reason = error instanceof OpenclawPackageRefusal ? error.reason : "unpack_failed";
    const detail = error instanceof OpenclawPackageRefusal ? error.detail : String(error?.message || error).slice(0, 300);
    logger.error(`[alphaclaw] openclaw package refused (${reason}): ${kRefusalCopy[reason] || reason}${detail ? ` (${detail})` : ""}`);
    return record({ status: "refused", reason, detail, message: kRefusalCopy[reason] || reason, ...fields });
  };
  try {
    recoverTornSwap({ installDir, fsModule, logger });
  } catch (error) {
    logger.warn(`[alphaclaw] openclaw package: torn-swap recovery failed: ${error.message}`);
  }
  if (!setting.set) {
    const previous = readVerdict({ managedDir, fsModule });
    try {
      const restored = restoreStock({ installDir, fsModule, logger });
      if (previous?.status === "stock" && !restored) return previous;
      return record({
        status: "stock",
        restored,
        previous: previous && previous.status !== "stock" ? { status: previous.status, file: previous.file ?? null, sha256: previous.sha256 ?? null } : null,
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
    if (!codexEntry) return record(fields);
    try {
      return record({ ...fields, codex: applyCodexPlugin({ entry: codexEntry, openclawDir, managedDir, installDir, env, fsModule, tar, runPluginInstall, logger }) });
    } catch (error) {
      return refused(error, { ...base, plugin: kCodexPackageName, pluginFile: path.basename(codexEntry.file), pluginSha256: codexEntry.sha256 });
    }
  };
  if (tree.applied && tree.marker.sha256 === entry.sha256) {
    try {
      readVerifiedPackage({ entry, openclawDir, fsModule });
      checkManifest({ managedDir, sha256: entry.sha256, packageDir, fsModule });
    } catch (error) {
      return refused(error, base);
    }
    logger.log(`[alphaclaw] openclaw package: ${base.file} (${shortSha(entry.sha256)}) already in place for OpenClaw ${entry.version}`);
    return applied({ status: "applied", ...base, bundledExtras: tree.marker.bundledExtras || [], reused: true });
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
  let moved = [];
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
    moved = carryNestedDependencies({ stockDir: packageDir, stagingDir, planned, fsModule });
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
      if (fsModule.existsSync(stockAsideDir)) {
        removeTree(packageDir, fsModule);
        moveDir(stockAsideDir, packageDir, fsModule);
      }
      throw new OpenclawPackageRefusal("swap_failed", String(error?.message || error).slice(0, 200));
    }
    try {
      fsModule.unlinkSync(journalPath);
    } catch {}
    const tookMs = nowFn() - startedAt;
    logger.log(`[alphaclaw] openclaw package: applied ${base.file} (${shortSha(entry.sha256)}) for OpenClaw ${entry.version} in ${tookMs}ms, ${manifest.length} files`);
    return applied({ status: "applied", ...base, bundledExtras, files: manifest.length, tookMs });
  } catch (error) {
    if (fsModule.existsSync(stagingDir)) {
      putNestedDependenciesBack({ packageDir: stagingDir, stockDir: packageDir, moved, fsModule });
      removeTree(stagingDir, fsModule);
    }
    removeTree(archivePath, fsModule);
    try {
      fsModule.unlinkSync(journalPath);
    } catch {}
    return refused(error, base);
  }
};

// Before every gateway launch. Read-only. Returns null with the setting unset,
// else the applied verdict; throws OpenclawPackageRefusal.
const checkOpenclawPackageBeforeLaunch = ({ installDir, managedDir, env = process.env, fsModule = fs } = {}) => {
  const setting = parseOpenclawPackagesSetting(env[kOpenclawPackagesEnvKey]);
  if (!setting.set) return null;
  const verdict = readVerdict({ managedDir, fsModule });
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
  if (verdict.codex) {
    try {
      checkManifest({ managedDir, sha256: verdict.codex.sha256, packageDir: verdict.codex.dir, fsModule });
    } catch (error) {
      if (error instanceof OpenclawPackageRefusal && error.reason === "tree_changed") {
        throw new OpenclawPackageRefusal("tree_changed", `extensions/codex: ${error.detail}`);
      }
      throw error;
    }
  }
  return verdict;
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
      extractArchive({ archivePath: pluginArchive, cwd: pluginDir, tar, filter: (entryPath) => entryPath === "package/package.json" });
      const pluginPkg = readJson(path.join(pluginDir, "package.json"), fsModule) || {};
      if (pluginPkg.name !== kCodexPackageName || pluginPkg.version !== codexEntry.version) {
        throw new OpenclawPackageRefusal("plugin_mismatch", `${pluginPkg.name || "?"}@${pluginPkg.version || "?"}`);
      }
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
  watchForPackageRestore,
  describeOpenclawPackage,
  checkOpenclawPackageSetting,
  readVerdict,
  shortSha,
};
