const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { readDirectoryNamesBounded } = require("./utils/bounded-directory");

const kCandidateName = /^candidate-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const kCommitSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const refuse = (code) => { throw Object.assign(new Error(code), { code }); };
const within = (file, root) => file.startsWith(`${root}${path.sep}`);

const normalizeDevCheckoutPath = (value) => {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > 4096 || !path.isAbsolute(value) || /[\0\r\n]/.test(value) || value.split(path.sep).includes("..")) refuse("dev_checkout_invalid");
  return path.resolve(value);
};

const candidateRoot = (checkoutDir) => `${normalizeDevCheckoutPath(path.resolve(checkoutDir))}-candidates`;

const resolveDevCheckout = ({ checkoutDir, recordedCheckoutDir, fsModule = fs }) => {
  const legacy = path.resolve(checkoutDir);
  if (recordedCheckoutDir == null) return legacy;
  const selected = normalizeDevCheckoutPath(recordedCheckoutDir);
  if (selected === legacy) return legacy;
  const root = candidateRoot(legacy);
  const rootStat = fsModule.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) refuse("dev_candidate_alias");
  const canonicalRoot = fsModule.realpathSync(root);
  if (path.dirname(selected) !== canonicalRoot || !kCandidateName.test(path.basename(selected))) refuse("dev_candidate_outside_managed_root");
  const stat = fsModule.lstatSync(selected);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fsModule.realpathSync(selected) !== selected) refuse("dev_candidate_alias");
  return selected;
};

const resolveDevCheckoutForBin = ({ checkoutDir, targetBin, fsModule = fs }) => {
  if (typeof targetBin !== "string" || !path.isAbsolute(targetBin)) return null;
  const target = path.resolve(targetBin);
  const legacy = path.resolve(checkoutDir);
  try {
    if (within(target, legacy) && within(fsModule.realpathSync(target), fsModule.realpathSync(legacy))) return legacy;
    const root = fsModule.realpathSync(candidateRoot(legacy));
    const relative = path.relative(root, target).split(path.sep);
    if (relative.length < 2 || !kCandidateName.test(relative[0])) return null;
    const selected = resolveDevCheckout({ checkoutDir: legacy, recordedCheckoutDir: path.join(root, relative[0]), fsModule });
    return within(fsModule.realpathSync(target), selected) ? selected : null;
  } catch { return null; }
};

const createDevCandidate = ({ checkoutDir, fsModule = fs }) => {
  const root = candidateRoot(checkoutDir);
  fsModule.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fsModule.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.mode & 0o077) refuse("dev_candidate_root_unsafe");
  const canonicalRoot = fsModule.realpathSync(root);
  const selected = path.join(canonicalRoot, `candidate-${randomUUID()}`);
  fsModule.mkdirSync(selected, { mode: 0o700 });
  const identity = fsModule.lstatSync(selected);
  return {
    checkoutDir: selected,
    remove: async () => {
      let stat;
      try { stat = fsModule.lstatSync(selected); } catch (error) { if (error.code === "ENOENT") return; throw error; }
      if (stat.dev !== identity.dev || stat.ino !== identity.ino || !stat.isDirectory() || stat.isSymbolicLink() || fsModule.realpathSync(root) !== canonicalRoot) refuse("dev_candidate_changed");
      await (fsModule.promises || fs.promises).rm(selected, { recursive: true, force: true });
    },
  };
};

const activateDevCandidate = ({ checkoutDir, candidateDir, sha, store, fsModule = fs }) => {
  try {
    if (!kCommitSha.test(sha || "")) refuse("dev_candidate_sha_invalid");
    const selected = resolveDevCheckout({ checkoutDir, recordedCheckoutDir: candidateDir, fsModule });
    const { readCheckoutBuildId } = require("./openclaw-build");
    if (readCheckoutBuildId(selected, { fsModule }) !== sha) refuse("dev_candidate_sha_mismatch");
    const bin = store.resolvePackageBin(selected);
    if (!bin || !fsModule.statSync(bin).isFile() || !within(fsModule.realpathSync(bin), fsModule.realpathSync(selected))) refuse("dev_candidate_bin_invalid");
    const result = store.writeBinShim({ targetBin: bin, label: `dev ${sha.slice(0, 7)}` });
    return result.ok ? { ok: true, bin, checkoutDir: selected } : result;
  } catch (error) {
    return { ok: false, code: error.code || "dev_candidate_unavailable", error: error.message };
  }
};

const pruneDevCandidates = async ({ checkoutDir, keepPaths = [], keepRecent = 3, fsModule = fs }) => {
  if (!Array.isArray(keepPaths) || keepPaths.length > 4096 || !Number.isSafeInteger(keepRecent) || keepRecent < 0 || keepRecent > 4096) refuse("dev_candidate_prune_invalid");
  const protectedPaths = new Set(keepPaths.map((file) => {
    const normalized = normalizeDevCheckoutPath(file);
    if (!normalized) refuse("dev_candidate_prune_invalid");
    return normalized;
  }));
  const root = candidateRoot(checkoutDir);
  let rootStat;
  try { rootStat = fsModule.lstatSync(root); } catch (error) {
    if (error.code === "ENOENT") return { removed: [], kept: [] };
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.mode & 0o077) refuse("dev_candidate_root_unsafe");
  const canonicalRoot = fsModule.realpathSync(root);
  const assertRoot = () => {
    const named = fsModule.lstatSync(root);
    const canonical = fsModule.lstatSync(canonicalRoot);
    if (!named.isDirectory() || named.isSymbolicLink() || named.mode & 0o077 || named.dev !== rootStat.dev || named.ino !== rootStat.ino ||
        !canonical.isDirectory() || canonical.isSymbolicLink() || canonical.dev !== rootStat.dev || canonical.ino !== rootStat.ino ||
        fsModule.realpathSync(root) !== canonicalRoot) refuse("dev_candidate_root_changed");
  };
  assertRoot();
  for (const file of [...protectedPaths]) {
    if (file === root || within(file, root)) protectedPaths.add(path.join(canonicalRoot, path.relative(root, file)));
    try { protectedPaths.add(fsModule.realpathSync(file)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const names = readDirectoryNamesBounded(root, { fsModule, maxEntries: 4096 });
  assertRoot();
  const kept = [];
  const candidates = [];
  const isProtected = (file) => [...protectedPaths].some((protectedPath) => file === protectedPath || within(protectedPath, file) || within(file, protectedPath));
  for (const name of names) {
    const file = path.join(canonicalRoot, name);
    if (!kCandidateName.test(name) || isProtected(file)) { kept.push(file); continue; }
    const stat = fsModule.lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink()) { kept.push(file); continue; }
    if (fsModule.realpathSync(file) !== file || !Number.isFinite(stat.mtimeMs)) refuse("dev_candidate_alias");
    candidates.push({ file, stat });
  }
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.file.localeCompare(b.file));
  kept.push(...candidates.slice(0, keepRecent).map(({ file }) => file));
  const removed = [];
  for (const candidate of candidates.slice(keepRecent)) {
    assertRoot();
    const stat = fsModule.lstatSync(candidate.file);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fsModule.realpathSync(candidate.file) !== candidate.file ||
        ["dev", "ino", "mtimeMs", "ctimeMs"].some((key) => stat[key] !== candidate.stat[key])) refuse("dev_candidate_changed");
    await (fsModule.promises || fs.promises).rm(candidate.file, { recursive: true, force: true });
    removed.push(candidate.file);
  }
  return { removed, kept };
};

module.exports = { createDevCandidate, resolveDevCheckout, resolveDevCheckoutForBin, activateDevCandidate, normalizeDevCheckoutPath, pruneDevCandidates };
