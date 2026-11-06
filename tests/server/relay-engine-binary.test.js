const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveEnginePlatform, engineFileName, ensureEngineBinary } = require("../../lib/server/relay/engine-binary");
const { kRelayEngineSha256, kRelayEngineVersion } = require("../../lib/server/relay/constants");

const quiet = { log: () => {}, warn: () => {} };
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const fakeFetch = (body, { status = 200 } = {}) => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return new Response(status === 200 ? body : "nope", { status });
  };
  impl.calls = calls;
  return impl;
};

describe("relay engine binary", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bin-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("pins a sha256 for every supported target", () => {
    expect(Object.keys(kRelayEngineSha256).sort()).toEqual(
      ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-musl-arm64", "linux-musl-x64", "linux-x64"].sort(),
    );
    for (const hash of Object.values(kRelayEngineSha256)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps platforms to release targets and refuses the rest", () => {
    expect(resolveEnginePlatform({ platform: "linux", arch: "x64", isMusl: () => false })).toBe("linux-x64");
    expect(resolveEnginePlatform({ platform: "linux", arch: "arm64", isMusl: () => true })).toBe("linux-musl-arm64");
    expect(resolveEnginePlatform({ platform: "darwin", arch: "arm64" })).toBe("darwin-arm64");
    expect(resolveEnginePlatform({ platform: "win32", arch: "x64" })).toBeNull();
    expect(resolveEnginePlatform({ platform: "linux", arch: "ia32" })).toBeNull();
  });

  it("downloads from the pinned release, verifies, installs 0755 and leaves no partial file", async () => {
    const body = Buffer.from("engine-bytes");
    const fetchImpl = fakeFetch(body);
    const result = await ensureEngineBinary({ binDir: dir, fetchImpl, target: "linux-x64", pins: { "linux-x64": sha(body) }, logger: quiet });
    expect(result).toEqual({ path: path.join(dir, engineFileName("linux-x64")), target: "linux-x64", downloaded: true });
    expect(fetchImpl.calls[0]).toBe("https://github.com/AgentWorkforce/relaycast/releases/download/v" + kRelayEngineVersion + "/relaycast-engine-" + kRelayEngineVersion + "-linux-x64");
    expect(fs.statSync(result.path).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(dir)).toEqual([engineFileName("linux-x64")]);
  });

  it("re-hashes an installed binary instead of downloading again, and replaces one changed on disk", async () => {
    const body = Buffer.from("engine-bytes");
    const pins = { "linux-x64": sha(body) };
    const fetchImpl = fakeFetch(body);
    await ensureEngineBinary({ binDir: dir, fetchImpl, target: "linux-x64", pins, logger: quiet });
    expect((await ensureEngineBinary({ binDir: dir, fetchImpl, target: "linux-x64", pins, logger: quiet })).downloaded).toBe(false);
    fs.appendFileSync(path.join(dir, engineFileName("linux-x64")), "tampered");
    expect((await ensureEngineBinary({ binDir: dir, fetchImpl, target: "linux-x64", pins, logger: quiet })).downloaded).toBe(true);
    expect(fs.readFileSync(path.join(dir, engineFileName("linux-x64")))).toEqual(body);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it("a hash mismatch is engine_hash_mismatch and installs nothing", async () => {
    await expect(
      ensureEngineBinary({ binDir: dir, fetchImpl: fakeFetch(Buffer.from("evil")), target: "linux-x64", pins: { "linux-x64": "0".repeat(64) }, logger: quiet }),
    ).rejects.toMatchObject({ code: "engine_hash_mismatch" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("an HTTP error or a network failure is engine_download_failed", async () => {
    await expect(
      ensureEngineBinary({ binDir: dir, fetchImpl: fakeFetch(null, { status: 404 }), target: "linux-x64", pins: { "linux-x64": "0".repeat(64) }, logger: quiet }),
    ).rejects.toMatchObject({ code: "engine_download_failed" });
    await expect(
      ensureEngineBinary({ binDir: dir, fetchImpl: async () => { throw new Error("ENOTFOUND github.com"); }, target: "linux-x64", pins: { "linux-x64": "0".repeat(64) }, logger: quiet }),
    ).rejects.toMatchObject({ code: "engine_download_failed" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("an unsupported platform is platform_unsupported", async () => {
    await expect(ensureEngineBinary({ binDir: dir, target: null, logger: quiet })).rejects.toMatchObject({ code: "platform_unsupported" });
  });
});
