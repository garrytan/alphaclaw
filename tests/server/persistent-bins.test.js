// lib/cli/persistent-bins.js: the boot relink of tools kept on the persistent
// disk. Hermetic: every source, link and PATH dir is a temp dir, never
// /usr/local/bin.
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kNeverLinkNames,
  relinkPersistentBins,
  formatPersistentBinsLog,
} = require("../../lib/cli/persistent-bins");

describe("lib/cli/persistent-bins", () => {
  let root;
  let stateBin;
  let localBin;
  let linkDir;
  let systemBin;

  const tool = (dir, name, mode = 0o755) => {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, "#!/bin/sh\necho " + name + "\n", { mode });
    fs.chmodSync(filePath, mode);
    return filePath;
  };
  const relink = (options = {}) =>
    relinkPersistentBins({
      sourceDirs: [stateBin, localBin],
      linkDir,
      pathDirs: [linkDir, systemBin],
      ...options,
    });
  const linkTarget = (name) => fs.readlinkSync(path.join(linkDir, name));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-bins-"));
    stateBin = path.join(root, "data", ".openclaw", "bin");
    localBin = path.join(root, "data", ".local", "bin");
    linkDir = path.join(root, "usr-local-bin");
    systemBin = path.join(root, "usr-bin");
    fs.mkdirSync(linkDir);
    fs.mkdirSync(systemBin);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("links a new tool from each source dir", () => {
    tool(stateBin, "yt-dlp");
    tool(localBin, "uv");

    expect(relink()).toEqual({ linked: ["yt-dlp", "uv"], kept: [], skipped: [] });
    expect(linkTarget("yt-dlp")).toBe(path.join(stateBin, "yt-dlp"));
    expect(linkTarget("uv")).toBe(path.join(localBin, "uv"));
    expect(fs.realpathSync(path.join(linkDir, "uv"))).toBe(fs.realpathSync(path.join(localBin, "uv")));
  });

  it("is idempotent: a second run keeps the links it made", () => {
    tool(stateBin, "yt-dlp");
    relink();

    expect(relink()).toEqual({ linked: [], kept: ["yt-dlp"], skipped: [] });
    expect(linkTarget("yt-dlp")).toBe(path.join(stateBin, "yt-dlp"));
  });

  it("repairs a dangling link and a link into another source dir", () => {
    tool(stateBin, "yt-dlp");
    tool(stateBin, "ffmpeg-static");
    tool(localBin, "ffmpeg-static");
    fs.symlinkSync(path.join(root, "gone", "yt-dlp"), path.join(linkDir, "yt-dlp"));
    fs.symlinkSync(path.join(localBin, "ffmpeg-static"), path.join(linkDir, "ffmpeg-static"));

    expect(relink()).toEqual({ linked: ["ffmpeg-static", "yt-dlp"], kept: [], skipped: [] });
    expect(linkTarget("yt-dlp")).toBe(path.join(stateBin, "yt-dlp"));
    expect(linkTarget("ffmpeg-static")).toBe(path.join(stateBin, "ffmpeg-static"));
  });

  it("never replaces a regular file or a symlink it did not make", () => {
    tool(stateBin, "rg");
    tool(stateBin, "jq");
    fs.writeFileSync(path.join(linkDir, "rg"), "image copy\n", { mode: 0o755 });
    const elsewhere = tool(path.join(root, "opt"), "jq");
    fs.symlinkSync(elsewhere, path.join(linkDir, "jq"));

    expect(relink()).toEqual({
      linked: [],
      kept: [],
      skipped: [
        { name: "jq", reason: "foreign_symlink" },
        { name: "rg", reason: "regular_file" },
      ],
    });
    expect(fs.readFileSync(path.join(linkDir, "rg"), "utf8")).toBe("image copy\n");
    expect(linkTarget("jq")).toBe(elsewhere);
  });

  it("skips a name another PATH dir already provides, unless the owner allows it", () => {
    tool(stateBin, "ffmpeg");
    const imageCopy = tool(systemBin, "ffmpeg");

    expect(relink()).toEqual({
      linked: [],
      kept: [],
      skipped: [{ name: "ffmpeg", reason: "shadows=" + imageCopy }],
    });
    expect(fs.existsSync(path.join(linkDir, "ffmpeg"))).toBe(false);

    expect(relink({ allowShadow: ["ffmpeg"] })).toEqual({ linked: ["ffmpeg"], kept: [], skipped: [] });
    expect(linkTarget("ffmpeg")).toBe(path.join(stateBin, "ffmpeg"));
  });

  it("does not count a non-executable on PATH, the link dir or a source dir on PATH as a shadow", () => {
    tool(stateBin, "yt-dlp");
    tool(systemBin, "yt-dlp", 0o644);

    expect(relink({ pathDirs: [linkDir, stateBin, localBin, systemBin, ""] }).linked).toEqual(["yt-dlp"]);
  });

  it("skips reserved names and ignores unsafe names, directories, non-executables and subdirectories", () => {
    tool(stateBin, "git");
    tool(stateBin, "bash");
    tool(stateBin, "-rf");
    tool(stateBin, ".hidden");
    tool(stateBin, "two words");
    tool(stateBin, "x".repeat(65));
    tool(stateBin, "notes.txt", 0o644);
    tool(path.join(stateBin, "nested"), "deep-tool");
    fs.symlinkSync(path.join(stateBin, "nested"), path.join(stateBin, "dirlink"));
    const real = tool(path.join(root, "data", "opt"), "real-tool");
    fs.symlinkSync(real, path.join(stateBin, "linked-tool"));

    expect(relink()).toEqual({
      linked: ["linked-tool"],
      kept: [],
      skipped: [
        { name: "bash", reason: "reserved" },
        { name: "git", reason: "reserved" },
      ],
    });
    expect(fs.readdirSync(linkDir)).toEqual(["linked-tool"]);
    expect(kNeverLinkNames).toEqual(expect.arrayContaining(["git", "node", "openclaw", "sh", "sudo", "python3"]));
  });

  it("lets the first source dir win a name clash, silently", () => {
    tool(stateBin, "uv");
    tool(localBin, "uv");

    expect(relink()).toEqual({ linked: ["uv"], kept: [], skipped: [] });
    expect(linkTarget("uv")).toBe(path.join(stateBin, "uv"));
  });

  it("records link_failed with the errno when the link cannot be made", () => {
    tool(stateBin, "yt-dlp");

    expect(relink({ linkDir: path.join(root, "missing") })).toEqual({
      linked: [],
      kept: [],
      skipped: [{ name: "yt-dlp", reason: "link_failed=ENOENT" }],
    });
  });

  it("treats missing source dirs as a silent no-op", () => {
    const result = relink();

    expect(result).toEqual({ linked: [], kept: [], skipped: [] });
    expect(formatPersistentBinsLog({ result, sourceDirs: [stateBin, localBin], linkDir })).toEqual([]);
  });

  it("logs one summary line and one line per skipped name with its fix", () => {
    const result = {
      linked: ["yt-dlp"],
      kept: ["uv"],
      skipped: [
        { name: "ffmpeg", reason: "shadows=/usr/bin/ffmpeg" },
        { name: "git", reason: "reserved" },
        { name: "rg", reason: "regular_file" },
        { name: "jq", reason: "foreign_symlink" },
        { name: "fd", reason: "link_failed=EACCES" },
      ],
    };

    expect(formatPersistentBinsLog({ result, sourceDirs: ["/data/.openclaw/bin", "/data/.local/bin"], linkDir: "/usr/local/bin" })).toEqual([
      "[alphaclaw] persistent tools: linked=1 kept=1 skipped=5 (/data/.openclaw/bin, /data/.local/bin)",
      "[alphaclaw] persistent tools: skipped ffmpeg (shadows=/usr/bin/ffmpeg): the image already provides it; add \"ffmpeg\" to tools.allowShadow in alphaclaw.json to use the persistent copy instead, or call it by its full path",
      "[alphaclaw] persistent tools: skipped git (reserved): AlphaClaw never links this name; call the tool by its full path",
      "[alphaclaw] persistent tools: skipped rg (regular_file): /usr/local/bin/rg is a file AlphaClaw did not create; remove it to use the persistent copy",
      "[alphaclaw] persistent tools: skipped jq (foreign_symlink): /usr/local/bin/jq links somewhere else; remove it to use the persistent copy",
      "[alphaclaw] persistent tools: skipped fd (link_failed=EACCES): check that /usr/local/bin is writable",
    ]);
  });
});
