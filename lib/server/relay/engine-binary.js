const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const {
  kRelayEngineVersion,
  kRelayEngineSha256,
  kRelayEngineReleaseBase,
} = require("./constants");
const { RelayError } = require("./errors");

// Fetches the pinned relay engine binary once into <root>/relay/bin and
// verifies it before it can run: the download streams into a .part file while
// it is hashed, and only a file whose sha256 equals the pin is renamed into
// place (mode 0755). An existing binary is re-hashed at every boot, so a file
// replaced on disk is never started.
const kDownloadTimeoutMs = 5 * 60 * 1000;

const detectMusl = () => {
  try {
    const header = process.report?.getReport?.()?.header;
    return Boolean(header) && !header.glibcVersionRuntime;
  } catch {
    return false;
  }
};

const resolveEnginePlatform = ({
  platform = process.platform,
  arch = process.arch,
  isMusl = detectMusl,
} = {}) => {
  if (!["x64", "arm64"].includes(arch)) return null;
  if (platform === "darwin") return "darwin-" + arch;
  if (platform !== "linux") return null;
  return (isMusl() ? "linux-musl-" : "linux-") + arch;
};

const engineFileName = (target) => "relaycast-engine-" + kRelayEngineVersion + "-" + target;

const sha256File = async (filePath, fsModule = fs) => {
  const hash = crypto.createHash("sha256");
  await pipeline(fsModule.createReadStream(filePath), hash);
  return hash.digest("hex");
};

const ensureEngineBinary = async ({
  binDir,
  fetchImpl = globalThis.fetch,
  fsModule = fs,
  target = resolveEnginePlatform(),
  pins = kRelayEngineSha256,
  releaseBase = kRelayEngineReleaseBase,
  timeoutMs = kDownloadTimeoutMs,
  logger = console,
} = {}) => {
  if (!target || !pins[target]) throw new RelayError("platform_unsupported", "No relay engine build for " + (target || process.platform + "-" + process.arch) + ".");
  const expected = pins[target];
  const finalPath = path.join(binDir, engineFileName(target));
  fsModule.mkdirSync(binDir, { recursive: true, mode: 0o700 });

  if (fsModule.existsSync(finalPath)) {
    const actual = await sha256File(finalPath, fsModule);
    if (actual === expected) return { path: finalPath, target, downloaded: false };
    logger.warn("[relay] engine binary on disk does not match its pinned sha256; downloading it again");
    fsModule.rmSync(finalPath, { force: true });
  }

  const url = releaseBase + "/v" + kRelayEngineVersion + "/" + engineFileName(target);
  const partPath = finalPath + "." + process.pid + ".part";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let response;
    try {
      response = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
    } catch (error) {
      throw new RelayError("engine_download_failed", "Download of " + url + " failed: " + (error?.message || error));
    }
    if (!response?.ok || !response.body) {
      throw new RelayError("engine_download_failed", "Download of " + url + " answered HTTP " + (response?.status ?? "?") + ".");
    }
    const hash = crypto.createHash("sha256");
    const body = typeof response.body.getReader === "function" ? Readable.fromWeb(response.body) : response.body;
    body.on("data", (chunk) => hash.update(chunk));
    try {
      await pipeline(body, fsModule.createWriteStream(partPath, { mode: 0o700 }));
    } catch (error) {
      throw new RelayError("engine_download_failed", "Download of " + url + " was cut off: " + (error?.message || error));
    }
    const actual = hash.digest("hex");
    if (actual !== expected) {
      throw new RelayError("engine_hash_mismatch", "Expected sha256 " + expected + ", got " + actual + ".");
    }
    fsModule.chmodSync(partPath, 0o755);
    fsModule.renameSync(partPath, finalPath);
    logger.log("[relay] engine " + kRelayEngineVersion + " (" + target + ") downloaded and verified");
    return { path: finalPath, target, downloaded: true };
  } finally {
    clearTimeout(timer);
    try {
      fsModule.rmSync(partPath, { force: true });
    } catch {}
  }
};

module.exports = { resolveEnginePlatform, engineFileName, ensureEngineBinary, sha256File };
