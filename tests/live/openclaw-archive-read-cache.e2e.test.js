const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const { kLiveEnabled, mkTemp, scrubTestRunnerEnv } = require("./live-helpers");
const { relocateOpenclawArchiveReadCache } = require("../../lib/server/openclaw-archive-read-cache");

// LIVE tier: the pinned OpenClaw's session-archive read cache follows the
// symlink AlphaClaw puts at /tmp/openclaw/session-archive-read-cache, so the
// decompressed copies of .zst session archives land on the data volume
// instead of Render's 2 GB /tmp (Nov 9 outage). Drives the pin's own
// materializeSessionArchiveForRead, found by its cache-dir string, in a child
// process with a scrubbed env. Screams if the pin moves the cache, stops
// accepting the link, replaces it with a real directory, or stops reusing a
// copy. On a pin with no read cache (2026.11.10 streams archives) it checks
// instead that a large archive reads in full with nothing written to disk.
// Run with:
//   OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/openclaw-archive-read-cache.e2e.test.js
const describeLive = kLiveEnabled ? describe : describe.skip;

const kTmpRoot = "/tmp/openclaw";
const kLink = path.join(kTmpRoot, "session-archive-read-cache");
const kDistDir = path.resolve(__dirname, "../../node_modules/openclaw/dist");

const findMaterializer = () => {
  for (const name of fs.readdirSync(kDistDir)) {
    if (!name.endsWith(".mjs")) continue;
    const file = path.join(kDistDir, name);
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes('"session-archive-read-cache"')) continue;
    const alias = /materializeSessionArchiveForRead as (\w+)/.exec(text)?.[1];
    if (alias) return { file, alias };
  }
  return null;
};

const materialize = (archivePath, scratch) => {
  const { file, alias } = findMaterializer();
  const script = `import(${JSON.stringify(file)}).then(async (m) => { process.stdout.write(JSON.stringify({ path: await m[${JSON.stringify(alias)}](${JSON.stringify(archivePath)}) })); });`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...scrubTestRunnerEnv(), TMPDIR: path.join(scratch, "proc-tmp") },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`materialize failed (exit ${result.status}): ${result.stderr}`);
  return JSON.parse(result.stdout).path;
};

const findStreamReader = () => {
  for (const name of fs.readdirSync(kDistDir)) {
    if (!name.endsWith(".mjs")) continue;
    const file = path.join(kDistDir, name);
    const alias = /readSessionArchiveText as (\w+)/.exec(fs.readFileSync(file, "utf8"))?.[1];
    if (alias) return { file, alias };
  }
  return null;
};

const readStreamed = (archivePath, scratch) => {
  const { file, alias } = findStreamReader();
  const script = `import(${JSON.stringify(file)}).then(async (m) => { const text = await m[${JSON.stringify(alias)}](${JSON.stringify(archivePath)}); const { createHash } = await import("node:crypto"); process.stdout.write(JSON.stringify({ length: text.length, sha256: createHash("sha256").update(text).digest("hex") })); });`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...scrubTestRunnerEnv(), TMPDIR: path.join(scratch, "proc-tmp") },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`archive read failed (exit ${result.status}): ${result.stderr}`);
  return JSON.parse(result.stdout);
};

describeLive("live: OpenClaw's archive read cache through AlphaClaw's data-volume link", () => {
  let scratch;
  let saved = null;

  beforeAll(() => {
    scratch = mkTemp("alphaclaw-live-archive-cache-");
    fs.mkdirSync(path.join(scratch, "proc-tmp"), { recursive: true });
    try {
      fs.lstatSync(kLink);
      saved = path.join(scratch, "saved-cache");
      fs.renameSync(kLink, saved);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  });

  afterAll(() => {
    try { if (fs.lstatSync(kLink).isSymbolicLink()) fs.unlinkSync(kLink); } catch {}
    if (saved) fs.renameSync(saved, kLink);
  });

  // 2026.11.10 reads archives as a stream (openclaw/openclaw#192743, #193548)
  // and has no read cache; the link then only matters after a rollback.
  it.runIf(findMaterializer() !== null)("writes decompressed copies through the link, keeps the link, and reuses a copy", () => {
    expect(findMaterializer()).not.toBeNull();
    const targetDir = path.join(scratch, "data", "tmp", "openclaw-archive-read-cache");
    const relocated = relocateOpenclawArchiveReadCache({ tmpRoot: kTmpRoot, targetDir, logger: { log() {}, warn() {} } });
    expect(relocated.status).toBe("linked");

    const sessions = path.join(scratch, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const line = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(900) }] } });
    // About 0.9 MB: 2026.11.6 reads a .zst archive only up to its compressed
    // size plus 1 MiB (readSessionArchiveContentSync's expansion budget), and
    // this text compresses to almost nothing.
    const plain = Array.from({ length: 1000 }, () => line).join("\n") + "\n";
    const archive = path.join(sessions, "0d5a1f3c-9a1b-4c2d-8e3f-1234567890ab.jsonl.reset.2026-11-09T08-50-00.000Z.zst");
    fs.writeFileSync(archive, zlib.zstdCompressSync(Buffer.from(plain)));

    const first = materialize(archive, scratch);
    expect(path.dirname(first)).toBe(kLink);
    expect(fs.realpathSync(first).startsWith(fs.realpathSync(targetDir) + path.sep)).toBe(true);
    expect(fs.readFileSync(first, "utf8")).toBe(plain);
    expect(fs.lstatSync(kLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(kLink)).toBe(targetDir);
    expect(fs.readdirSync(targetDir)).toEqual([path.basename(first)]);

    const second = materialize(archive, scratch);
    expect(second).toBe(first);
    expect(fs.readdirSync(targetDir)).toEqual([path.basename(first)]);
  }, 120_000);

  it.runIf(findMaterializer() === null)("reads a large .zst archive in full with no copy on disk when the pin has no read cache", () => {
    expect(findStreamReader(), "the pin has neither a read cache nor a streaming archive reader").not.toBeNull();
    const sessions = path.join(scratch, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const line = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(900) }] } });
    // About 24 MB that compresses to well under 1 MB: 2026.11.6 refused any
    // archive expanding past its compressed size plus 1 MiB.
    const plain = Array.from({ length: 26_000 }, () => line).join("\n") + "\n";
    const archive = path.join(sessions, "0d5a1f3c-9a1b-4c2d-8e3f-1234567890ab.jsonl.reset.2026-11-09T08-50-00.000Z.zst");
    fs.writeFileSync(archive, zlib.zstdCompressSync(Buffer.from(plain)));
    expect(fs.statSync(archive).size + 1024 * 1024).toBeLessThan(plain.length);

    const result = readStreamed(archive, scratch);
    expect(result.length).toBe(plain.length);
    expect(result.sha256).toBe(require("crypto").createHash("sha256").update(plain).digest("hex"));
    expect(fs.readdirSync(path.join(scratch, "proc-tmp"))).toEqual([]);
    expect(fs.existsSync(kLink)).toBe(false);
  }, 120_000);
});
