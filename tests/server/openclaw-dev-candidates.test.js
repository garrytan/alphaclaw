const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDevCandidate, resolveDevCheckout, activateDevCandidate, normalizeDevCheckoutPath, pruneDevCandidates } = require("../../lib/server/openclaw-dev-candidates");
const { createOpenclawReleaseChannelStore, normalizeState } = require("../../lib/server/openclaw-release-channel");
const { describeExecutingBuild } = require("../../lib/server/openclaw-build");

describe("immutable managed dev candidates", () => {
  let root;
  let checkoutDir;
  let store;
  const firstSha = "a".repeat(40);
  const secondSha = "b".repeat(40);
  const writeBuild = (directory, sha, payload = sha) => {
    fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
    fs.mkdirSync(path.join(directory, "dist"), { recursive: true });
    fs.writeFileSync(path.join(directory, ".git", "HEAD"), sha);
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.5-dev", bin: "openclaw.mjs" }));
    fs.writeFileSync(path.join(directory, "openclaw.mjs"), `console.log(${JSON.stringify(payload)});`);
    fs.writeFileSync(path.join(directory, "dist", "entry.mjs"), payload);
    return path.join(directory, "openclaw.mjs");
  };
  const executing = () => describeExecutingBuild({ installDir: root, checkoutDir, store });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_GIT_DIR", "");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-dev-candidates-"));
    checkoutDir = path.join(root, "openclaw");
    store = createOpenclawReleaseChannelStore({ rootDir: root, openclawDir: path.join(root, ".openclaw"), logger: { log() {}, warn() {} } });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("prepares a unique private sibling without mutating the running checkout or shim", () => {
    const bin = writeBuild(checkoutDir, firstSha);
    expect(store.writeBinShim({ targetBin: bin }).ok).toBe(true);
    const before = fs.readFileSync(store.shimPath);
    const candidate = createDevCandidate({ checkoutDir });
    writeBuild(candidate.checkoutDir, secondSha);
    expect(path.dirname(candidate.checkoutDir)).toBe(`${checkoutDir}-candidates`);
    expect(fs.statSync(candidate.checkoutDir).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(store.shimPath)).toEqual(before);
    expect(executing()).toMatchObject({ source: "dev", buildId: firstSha, packageDir: checkoutDir });
    expect(fs.readFileSync(path.join(checkoutDir, "dist", "entry.mjs"), "utf8")).toBe(firstSha);
    expect(createDevCandidate({ checkoutDir }).checkoutDir).not.toBe(candidate.checkoutDir);
  });

  it("activates a candidate by shim only and retains the previous candidate for exact rollback", () => {
    const first = createDevCandidate({ checkoutDir });
    const second = createDevCandidate({ checkoutDir });
    writeBuild(first.checkoutDir, firstSha);
    writeBuild(second.checkoutDir, secondSha);
    expect(activateDevCandidate({ checkoutDir, candidateDir: first.checkoutDir, sha: firstSha, store }).ok).toBe(true);
    store.writeState({ applied: { channel: "dev", sha: secondSha, checkoutDir: second.checkoutDir },
      previousDev: { sha: firstSha, checkoutDir: first.checkoutDir },
      lastKnownGood: { dev: firstSha, devCheckoutDir: first.checkoutDir } });
    expect(executing()).toMatchObject({ buildId: firstSha, packageDir: first.checkoutDir });
    expect(activateDevCandidate({ checkoutDir, candidateDir: second.checkoutDir, sha: secondSha, store }).ok).toBe(true);
    expect(store.validateBinShim()).toMatchObject({ valid: true, removed: false });
    expect(executing()).toMatchObject({ buildId: secondSha, packageDir: second.checkoutDir });
    const previous = store.readState().previousDev;
    expect(previous).toEqual({ sha: firstSha, checkoutDir: first.checkoutDir });
    expect(activateDevCandidate({ checkoutDir, candidateDir: previous.checkoutDir, sha: previous.sha, store }).ok).toBe(true);
    expect(executing()).toMatchObject({ buildId: firstSha, packageDir: first.checkoutDir });
    expect(fs.existsSync(second.checkoutDir)).toBe(true);
    expect(store.readState().lastKnownGood).toMatchObject({ dev: firstSha, devCheckoutDir: first.checkoutDir });
  });

  it("retains legacy state and legacy checkout rollback without requiring a recorded candidate path", () => {
    const bin = writeBuild(checkoutDir, firstSha);
    store.writeState({ applied: { channel: "dev", sha: firstSha }, lastKnownGood: { dev: firstSha } });
    expect(store.readState().applied).not.toHaveProperty("checkoutDir");
    expect(resolveDevCheckout({ checkoutDir })).toBe(checkoutDir);
    expect(activateDevCandidate({ checkoutDir, sha: firstSha, store })).toMatchObject({ ok: true, bin, checkoutDir });
    expect(store.validateBinShim().valid).toBe(true);
    expect(executing()).toMatchObject({ buildId: firstSha, packageDir: checkoutDir });
  });

  it("preserves custom OPENCLAW_GIT_DIR for both legacy and candidate builds", () => {
    checkoutDir = path.join(root, "custom", "source");
    vi.stubEnv("OPENCLAW_GIT_DIR", checkoutDir);
    writeBuild(checkoutDir, firstSha);
    expect(activateDevCandidate({ checkoutDir, sha: firstSha, store }).ok).toBe(true);
    expect(store.validateBinShim().valid).toBe(true);
    const candidate = createDevCandidate({ checkoutDir });
    writeBuild(candidate.checkoutDir, secondSha);
    expect(activateDevCandidate({ checkoutDir, candidateDir: candidate.checkoutDir, sha: secondSha, store }).ok).toBe(true);
    expect(store.validateBinShim().valid).toBe(true);
    expect(executing()).toMatchObject({ packageDir: candidate.checkoutDir, buildId: secondSha });
    expect(fs.readFileSync(path.join(checkoutDir, ".git", "HEAD"), "utf8")).toBe(firstSha);
  });

  it("keeps the old shim when the candidate SHA no longer matches its approval", () => {
    const bin = writeBuild(checkoutDir, firstSha);
    store.writeBinShim({ targetBin: bin });
    const candidate = createDevCandidate({ checkoutDir });
    writeBuild(candidate.checkoutDir, secondSha);
    expect(activateDevCandidate({ checkoutDir, candidateDir: candidate.checkoutDir, sha: firstSha, store })).toMatchObject({ ok: false, code: "dev_candidate_sha_mismatch" });
    expect(store.readBinShimTarget()).toBe(bin);
    expect(activateDevCandidate({ checkoutDir, candidateDir: candidate.checkoutDir, sha: secondSha.slice(0, 7), store })).toMatchObject({ ok: false, code: "dev_candidate_sha_invalid" });
  });

  it("rejects recorded outside paths, candidate directory aliases, and escaped executable paths", () => {
    const candidate = createDevCandidate({ checkoutDir });
    const outside = path.join(root, "outside");
    writeBuild(outside, firstSha);
    expect(() => resolveDevCheckout({ checkoutDir, recordedCheckoutDir: outside })).toThrow("dev_candidate_outside_managed_root");
    fs.rmdirSync(candidate.checkoutDir);
    fs.symlinkSync(outside, candidate.checkoutDir, "dir");
    expect(activateDevCandidate({ checkoutDir, candidateDir: candidate.checkoutDir, sha: firstSha, store })).toMatchObject({ ok: false, code: "dev_candidate_alias" });
    const other = createDevCandidate({ checkoutDir });
    const bin = writeBuild(other.checkoutDir, firstSha);
    fs.unlinkSync(bin);
    fs.symlinkSync(path.join(outside, "openclaw.mjs"), bin);
    expect(activateDevCandidate({ checkoutDir, candidateDir: other.checkoutDir, sha: firstSha, store })).toMatchObject({ ok: false, code: "dev_candidate_bin_invalid" });
    store.writeBinShim({ targetBin: bin });
    expect(store.validateBinShim()).toMatchObject({ valid: false, removed: true });
  });

  it("rejects a candidate root symlink without creating files in its target", () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, `${checkoutDir}-candidates`, "dir");
    expect(() => createDevCandidate({ checkoutDir })).toThrow("dev_candidate_root_unsafe");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("removes only its own failed candidate and refuses an inode replacement", async () => {
    const first = createDevCandidate({ checkoutDir });
    const second = createDevCandidate({ checkoutDir });
    writeBuild(first.checkoutDir, firstSha);
    writeBuild(second.checkoutDir, secondSha);
    await first.remove();
    await first.remove();
    expect(fs.existsSync(second.checkoutDir)).toBe(true);
    fs.renameSync(second.checkoutDir, `${second.checkoutDir}-saved`);
    fs.mkdirSync(second.checkoutDir);
    await expect(second.remove()).rejects.toMatchObject({ code: "dev_candidate_changed" });
    expect(fs.existsSync(second.checkoutDir)).toBe(true);
    expect(fs.existsSync(`${second.checkoutDir}-saved`)).toBe(true);
  });

  it("fails closed rather than falling back to the legacy checkout for malformed recorded paths", () => {
    for (const value of ["relative", "", 42, {}, "/tmp/../outside", "/tmp/x\0y"]) {
      expect(() => normalizeDevCheckoutPath(value)).toThrow("dev_checkout_invalid");
      expect(() => normalizeState({ applied: { channel: "dev", checkoutDir: value } })).toThrow("dev_checkout_invalid");
    }
    expect(normalizeDevCheckoutPath(null)).toBeNull();
  });

  const datedCandidates = (count) => Array.from({ length: count }, (_, index) => {
    const candidate = createDevCandidate({ checkoutDir }).checkoutDir;
    fs.mkdirSync(path.join(candidate, "nested"));
    fs.writeFileSync(path.join(candidate, "nested", "retained.txt"), String(index));
    fs.utimesSync(candidate, 1000 + index, 1000 + index);
    return candidate;
  });

  it("keeps protected older candidates plus three other newest candidates and never touches the legacy checkout", async () => {
    writeBuild(checkoutDir, firstSha);
    const candidates = datedCandidates(7);
    const result = await pruneDevCandidates({ checkoutDir, keepPaths: [checkoutDir, candidates[0], path.join(candidates[2], "nested", "retained.txt")] });
    expect(result.removed.sort()).toEqual([candidates[1], candidates[3]].sort());
    expect(result.kept.sort()).toEqual([candidates[0], candidates[2], ...candidates.slice(4)].sort());
    for (const file of result.removed) expect(fs.existsSync(file)).toBe(false);
    for (const file of result.kept) expect(fs.existsSync(path.join(file, "nested", "retained.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(checkoutDir, ".git", "HEAD"), "utf8")).toBe(firstSha);
  });

  it("preserves symlinks, unknown names and non-directories without traversing their contents", async () => {
    const candidates = datedCandidates(4);
    const managed = path.dirname(candidates[0]);
    const outside = path.join(root, "outside");
    writeBuild(outside, firstSha);
    const link = path.join(managed, "candidate-11111111-1111-1111-1111-111111111111");
    const regular = path.join(managed, "candidate-22222222-2222-2222-2222-222222222222");
    const unknown = path.join(managed, "operator-notes");
    fs.symlinkSync(outside, link, "dir");
    fs.writeFileSync(regular, "not a candidate directory");
    fs.mkdirSync(unknown);
    const opendirSync = vi.fn((directory) => fs.opendirSync(directory));
    const result = await pruneDevCandidates({ checkoutDir, keepPaths: [], fsModule: { ...fs, opendirSync } });
    expect(opendirSync.mock.calls.map(([directory]) => directory)).toEqual([managed]);
    expect(result.removed).toEqual([candidates[0]]);
    expect(result.kept).toEqual(expect.arrayContaining([link, regular, unknown]));
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, ".git", "HEAD"), "utf8")).toBe(firstSha);
    expect(fs.existsSync(unknown)).toBe(true);
    expect(fs.readFileSync(regular, "utf8")).toBe("not a candidate directory");
  });

  it("completes bounded root enumeration before any deletion and refuses overflow", async () => {
    const candidates = datedCandidates(5);
    const names = [...candidates.map((file) => path.basename(file)), ...Array.from({ length: 4092 }, (_, index) => `unknown-${index}`)];
    let index = 0;
    const readSync = vi.fn(() => index < names.length ? { name: names[index++] } : null);
    const closeSync = vi.fn();
    const rm = vi.fn();
    await expect(pruneDevCandidates({ checkoutDir, keepPaths: [], fsModule: {
      ...fs, opendirSync: () => ({ readSync, closeSync }), promises: { ...fs.promises, rm },
    } })).rejects.toMatchObject({ code: "DIRECTORY_ENTRY_LIMIT" });
    expect(readSync).toHaveBeenCalledTimes(4097);
    expect(closeSync).toHaveBeenCalledOnce();
    expect(rm).not.toHaveBeenCalled();
    expect(candidates.every((file) => fs.existsSync(file))).toBe(true);
  });

  it("does not delete anything when enumeration discovers a root alias race", async () => {
    const candidates = datedCandidates(4);
    const managed = path.dirname(candidates[0]);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    const rm = vi.fn();
    const opendirSync = (directory) => {
      const handle = fs.opendirSync(directory);
      return { readSync: () => handle.readSync(), closeSync: () => {
        handle.closeSync();
        fs.renameSync(managed, `${managed}-saved`);
        fs.symlinkSync(outside, managed, "dir");
      } };
    };
    await expect(pruneDevCandidates({ checkoutDir, keepPaths: [], fsModule: { ...fs, opendirSync, promises: { ...fs.promises, rm } } }))
      .rejects.toMatchObject({ code: "dev_candidate_root_changed" });
    expect(rm).not.toHaveBeenCalled();
    expect(fs.readdirSync(`${managed}-saved`)).toHaveLength(4);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("rechecks root ownership after each asynchronous removal instead of following a replacement root", async () => {
    const candidates = datedCandidates(3);
    const managed = path.dirname(candidates[0]);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    for (const file of candidates) fs.mkdirSync(path.join(outside, path.basename(file)));
    const rm = vi.fn(async (file, options) => {
      await fs.promises.rm(file, options);
      fs.renameSync(managed, `${managed}-saved`);
      fs.symlinkSync(outside, managed, "dir");
    });
    await expect(pruneDevCandidates({ checkoutDir, keepPaths: [], keepRecent: 0, fsModule: { ...fs, promises: { ...fs.promises, rm } } }))
      .rejects.toMatchObject({ code: "dev_candidate_root_changed" });
    expect(rm).toHaveBeenCalledOnce();
    expect(fs.readdirSync(outside)).toHaveLength(3);
    expect(fs.readdirSync(`${managed}-saved`)).toHaveLength(2);
  });

  it("preserves a candidate whose inode changes after discovery", async () => {
    const candidates = datedCandidates(3);
    const replaced = candidates[1];
    const rm = vi.fn(async (file, options) => {
      await fs.promises.rm(file, options);
      fs.renameSync(replaced, `${replaced}-saved`);
      fs.mkdirSync(replaced);
      fs.writeFileSync(path.join(replaced, "new-owner"), "must survive");
    });
    await expect(pruneDevCandidates({ checkoutDir, keepPaths: [], keepRecent: 0, fsModule: { ...fs, promises: { ...fs.promises, rm } } }))
      .rejects.toMatchObject({ code: "dev_candidate_changed" });
    expect(rm).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(replaced, "new-owner"), "utf8")).toBe("must survive");
  });

  it("fails closed on unsafe roots and invalid keep options, while a missing root is empty", async () => {
    expect(await pruneDevCandidates({ checkoutDir, keepPaths: [] })).toEqual({ removed: [], kept: [] });
    const candidates = datedCandidates(4);
    await expect(pruneDevCandidates({ checkoutDir, keepPaths: [null] })).rejects.toMatchObject({ code: "dev_candidate_prune_invalid" });
    await expect(pruneDevCandidates({ checkoutDir, keepPaths: [], keepRecent: -1 })).rejects.toMatchObject({ code: "dev_candidate_prune_invalid" });
    fs.chmodSync(path.dirname(candidates[0]), 0o777);
    await expect(pruneDevCandidates({ checkoutDir, keepPaths: [] })).rejects.toMatchObject({ code: "dev_candidate_root_unsafe" });
    expect(candidates.every((file) => fs.existsSync(file))).toBe(true);
  });
});
