const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Shared plumbing for the CONTAINER e2e tier (tests/container/**). This tier
// builds a real image from the local checkout (npm pack → docker build),
// boots the pinned OpenClaw in fresh and restarted containers, exercises
// deterministic pidfile recovery, and boots real gateways across an
// immutable AlphaClaw self-upgrade. It needs a running docker daemon and
// outbound network, so it is excluded from `npm test` via vitest.config.js
// and runs through `npm run test:container`.
const enabled = process.env.OPENCLAW_CONTAINER_E2E === "1";

// `describe` comes from vitest's globals (vitest.config.js `globals: true`),
// resolved lazily off globalThis so this module also loads under plain node
// (the docker wrappers double as smoke-scriptable helpers). Outside vitest
// describeContainer is null — don't use it there.
const kDescribe = globalThis.describe || null;
const describeContainer = kDescribe ? (enabled ? kDescribe : kDescribe.skip) : null;

const execFileAsync = promisify(execFile);
const kMaxBuffer = 64 * 1024 * 1024;

const repoRoot = path.resolve(__dirname, "../..");
const artifactsDir = path.join(__dirname, "artifacts");

// Build contexts and historical checkouts are swept by Vitest afterAll;
// process exit is a fallback for standalone helper invocations.
const kCreatedTempDirs = [];
const sweepTempDirs = () => {
  for (const dir of kCreatedTempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
};
process.once("exit", sweepTempDirs);
if (typeof globalThis.afterAll === "function") globalThis.afterAll(sweepTempDirs, 5 * 60_000);

const mkTemp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  kCreatedTempDirs.push(dir);
  return dir;
};

const docker = async (args, { timeoutMs = 120000 } = {}) => {
  const { stdout, stderr } = await execFileAsync("docker", args, {
    maxBuffer: kMaxBuffer,
    timeout: timeoutMs,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

const dockerAvailable = async () => {
  try {
    const { stdout } = await docker(["info", "--format", "{{.ServerVersion}}"]);
    return { ok: true, message: `docker daemon ${stdout.trim()}` };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
};

// Called from beforeAll when the tier is enabled: a missing daemon is a
// broken invocation (the operator asked for the container tier), not a skip.
const assertDockerAvailable = async () => {
  const probe = await dockerAvailable();
  if (!probe.ok) {
    throw new Error(
      "OPENCLAW_CONTAINER_E2E=1 requires a running docker daemon " +
        `(docker info failed: ${probe.message}). Start dockerd or unset the flag.`,
    );
  }
  return probe;
};

// npm pack the local checkout (runs prepack → build:ui, exactly what a
// publish would ship), stage the tarball + Dockerfile in a temp build
// context, and docker build. Returns the tag.
const buildImage = async ({ tag, sourceRoot = repoRoot }) => {
  const context = mkTemp("alphaclaw-container-e2e-build-");
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--pack-destination", context],
    { cwd: sourceRoot, maxBuffer: kMaxBuffer, timeout: 10 * 60 * 1000 },
  );
  const lines = String(stdout).trim().split("\n").filter(Boolean);
  const tarballName = lines[lines.length - 1].trim();
  const tarballPath = path.join(context, tarballName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`npm pack reported ${tarballName} but it is not in ${context}`);
  }
  const fingerprint = {
    tag,
    version: JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")).version,
    packedAt: new Date().toISOString(),
    tarballSha256: createHash("sha256").update(fs.readFileSync(tarballPath)).digest("hex"),
    dockerfileSha256: createHash("sha256").update(fs.readFileSync(path.join(sourceRoot, "Dockerfile"))).digest("hex"),
  };
  const unpacked = path.join(context, "fingerprint");
  fs.mkdirSync(unpacked);
  await execFileAsync("tar", ["-xzf", tarballPath, "-C", unpacked]);
  const packedFiles = {};
  const hashPackedFiles = (relative = "") => {
    for (const entry of fs.readdirSync(path.join(unpacked, "package", relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) hashPackedFiles(file);
      else if (entry.isFile()) packedFiles[file] = createHash("sha256").update(fs.readFileSync(path.join(unpacked, "package", file))).digest("hex");
    }
  };
  hashPackedFiles();
  fingerprint.packedFiles = packedFiles;
  fingerprint.packedFilesSha256 = createHash("sha256").update(JSON.stringify(packedFiles)).digest("hex");
  fs.rmSync(unpacked, { recursive: true, force: true });
  const fingerprintPath = path.join(ensureArtifactsDir(), `${tag.replace(/[^a-zA-Z0-9_.-]/g, "-")}-build.json`);
  fs.writeFileSync(fingerprintPath, `${JSON.stringify(fingerprint, null, 2)}\n`);
  const { packedFiles: omittedPackedFiles, ...summary } = fingerprint;
  console.log(`[container-build] ${JSON.stringify({ ...summary, packedFileCount: Object.keys(omittedPackedFiles).length })}`);
  fs.renameSync(tarballPath, path.join(context, "alphaclaw.tgz"));
  fs.copyFileSync(path.join(sourceRoot, "Dockerfile"), path.join(context, "Dockerfile"));
  await docker(["build", "-t", tag, context], { timeoutMs: 15 * 60 * 1000 });
  fingerprint.imageId = (await docker(["image", "inspect", "--format", "{{.Id}}", tag])).stdout.trim();
  fs.writeFileSync(fingerprintPath, `${JSON.stringify(fingerprint, null, 2)}\n`);
  return { tag };
};

// An immutable historical image without switching or editing the workspace.
// Only build tooling is shared: npm pack includes neither this symlink nor
// dependencies, and the image installs the historical manifest itself.
const sourceAtCommit = async (commit) => {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Historical source requires a full immutable commit");
  const root = mkTemp("alphaclaw-container-e2e-source-");
  const archive = path.join(root, "source.tar");
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot);
  await execFileAsync("git", ["archive", "--format=tar", `--output=${archive}`, commit], { cwd: repoRoot, maxBuffer: kMaxBuffer });
  await execFileAsync("tar", ["-xf", archive, "-C", sourceRoot]);
  fs.rmSync(archive);
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(sourceRoot, "node_modules"), "dir");
  return sourceRoot;
};

const removeImage = async (tag) => {
  try { await docker(["image", "rm", "-f", tag]); } catch {}
};

const createVolume = async (name) => {
  await docker(["volume", "create", name]);
  return name;
};

// Seed files into a named volume before (or between) container runs. `files`
// maps absolute in-volume paths (e.g. "/data/onboarded.json") to string
// contents. The payload travels base64-encoded through argv, so no content
// ever meets a shell.
const seedVolume = async (volume, files) => {
  const payload = Buffer.from(JSON.stringify(files)).toString("base64");
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const files = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));",
    "for (const [file, content] of Object.entries(files)) {",
    "  fs.mkdirSync(path.dirname(file), { recursive: true });",
    "  fs.writeFileSync(file, content);",
    "}",
  ].join("\n");
  await docker(
    ["run", "--rm", "-v", `${volume}:/data`, "node:24-slim", "node", "-e", script, payload],
    { timeoutMs: 5 * 60 * 1000 },
  );
};

// docker run with the production shape: --restart=always (restartProcess()
// exits inside a container and relies on this policy), a dynamic loopback
// port mapping, and the /data volume. Returns the mapped host port.
const runContainer = async ({ name, image, volume, env = {}, memory = null }) => {
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--restart=always",
    "-p",
    "127.0.0.1::3000",
    "-v",
    `${volume}:/data`,
  ];
  if (memory) args.push("--memory", memory, "--memory-swap", memory);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue;
    args.push("-e", `${key}=${value}`);
  }
  args.push(image);
  await docker(args, { timeoutMs: 5 * 60 * 1000 });
  const port = await getMappedPort(name);
  return { name, port };
};

// Dynamically published host ports are NOT stable across container restarts
// (docker may re-allocate) — re-resolve after every restart/rm+run.
const getMappedPort = async (name) => {
  const { stdout } = await docker(["port", name, "3000/tcp"]);
  const line = stdout
    .trim()
    .split("\n")
    .find((l) => l.startsWith("127.0.0.1:"));
  if (!line) throw new Error(`docker port ${name} 3000/tcp returned: ${stdout.trim()}`);
  return Number(line.split(":").pop());
};

const execInContainer = async (name, cmd, { timeoutMs = 120000 } = {}) =>
  docker(["exec", name, ...cmd], { timeoutMs });

const containerLogs = async (name, { tail = 400 } = {}) => {
  const { stdout, stderr } = await docker(["logs", "--tail", String(tail), name]);
  return `${stdout}${stderr}`;
};

// Teardown helpers: force, never throw — afterAll must always finish.
const removeContainer = async (name) => {
  try {
    await docker(["rm", "-f", name]);
  } catch {}
};

const removeVolume = async (name) => {
  try {
    await docker(["volume", "rm", "-f", name]);
  } catch {}
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll `fn` until it returns a truthy value. Throws with the label and the
// last error/value on timeout so failures say WHAT never became true.
const waitFor = async (fn, { timeoutMs, intervalMs = 1000, label = "condition" }) => {
  const startedAt = Date.now();
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
      lastError = null;
    } catch (err) {
      if (err?.terminal === true) throw err;
      lastError = err;
    }
    if (Date.now() - startedAt > timeoutMs) {
      const detail = lastError ? ` (last error: ${String(lastError?.message || lastError)})` : "";
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}${detail}`);
    }
    await sleep(intervalMs);
  }
};

// Login against the real server with the shared setup password and return a
// Cookie header value for subsequent authenticated fetches.
const loginForCookie = async (baseUrl, password) => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok !== true) {
    throw new Error(`login failed (${res.status}): ${JSON.stringify(body)}`);
  }
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean);
  if (setCookies.length === 0) throw new Error("login succeeded but no session cookie was set");
  return setCookies.map((c) => c.split(";")[0]).join("; ");
};

const fetchJsonWithCookie = async (url, cookie) => {
  const res = await fetch(url, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
};

const ensureArtifactsDir = () => {
  fs.mkdirSync(artifactsDir, { recursive: true });
  return artifactsDir;
};

module.exports = {
  enabled,
  describeContainer,
  repoRoot,
  artifactsDir,
  ensureArtifactsDir,
  docker,
  dockerAvailable,
  assertDockerAvailable,
  buildImage,
  sourceAtCommit,
  removeImage,
  createVolume,
  seedVolume,
  runContainer,
  getMappedPort,
  execInContainer,
  containerLogs,
  removeContainer,
  removeVolume,
  sleep,
  waitFor,
  loginForCookie,
  fetchJsonWithCookie,
};
