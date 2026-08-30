const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Shared plumbing for the CONTAINER e2e tier (tests/container/**). This tier
// builds a real image from the local checkout (npm pack → docker build),
// boots a real stable OpenClaw gateway inside it, and drives the real browser
// UI through a stable→beta upgrade. It needs a running docker daemon and
// outbound network, so it is excluded from `npm test` via vitest.config.js
// and runs through `npm run test:container`.
const enabled = process.env.OPENCLAW_CONTAINER_E2E === "1";

// STRICT mode (CI pull_request runs): registry sanity problems (no beta
// dist-tag, beta not newer than the pin) FAIL the suite instead of skipping
// it, so a PR cannot go green on a silently skipped journey.
const strict = process.env.OPENCLAW_CONTAINER_E2E_STRICT === "1";

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

// Every temp dir is swept at process exit (build contexts hold a full
// npm-pack tarball each).
const kCreatedTempDirs = [];
process.once("exit", () => {
  for (const dir of kCreatedTempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

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
const buildImage = async ({ tag }) => {
  const context = mkTemp("alphaclaw-container-e2e-build-");
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--pack-destination", context],
    { cwd: repoRoot, maxBuffer: kMaxBuffer, timeout: 10 * 60 * 1000 },
  );
  const lines = String(stdout).trim().split("\n").filter(Boolean);
  const tarballName = lines[lines.length - 1].trim();
  const tarballPath = path.join(context, tarballName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`npm pack reported ${tarballName} but it is not in ${context}`);
  }
  fs.renameSync(tarballPath, path.join(context, "alphaclaw.tgz"));
  fs.copyFileSync(path.join(repoRoot, "Dockerfile"), path.join(context, "Dockerfile"));
  await docker(["build", "-t", tag, context], { timeoutMs: 15 * 60 * 1000 });
  return { tag };
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
    ["run", "--rm", "-v", `${volume}:/data`, "node:22-slim", "node", "-e", script, payload],
    { timeoutMs: 5 * 60 * 1000 },
  );
};

// docker run with the production shape: --restart=always (restartProcess()
// exits inside a container and relies on this policy), a dynamic loopback
// port mapping, and the /data volume. Returns the mapped host port.
const runContainer = async ({ name, image, volume, env = {} }) => {
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

// Detached exec: the process dies with the container (execs are not part of
// the restart policy) — callers that need to survive a restart must re-arm.
const execDetachedInContainer = async (name, cmd) =>
  docker(["exec", "-d", name, ...cmd]);

const containerLogs = async (name, { tail = 400 } = {}) => {
  const { stdout, stderr } = await docker(["logs", "--tail", String(tail), name]);
  return `${stdout}${stderr}`;
};

const restartCount = async (name) => {
  const { stdout } = await docker(["inspect", "--format", "{{.RestartCount}}", name]);
  return Number(stdout.trim());
};

const containerStartedAt = async (name) => {
  const { stdout } = await docker(["inspect", "--format", "{{.State.StartedAt}}", name]);
  return stdout.trim();
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
      lastError = err;
    }
    if (Date.now() - startedAt > timeoutMs) {
      const detail = lastError ? ` (last error: ${String(lastError?.message || lastError)})` : "";
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}${detail}`);
    }
    await sleep(intervalMs);
  }
};

// Loose semver-ish comparison (split on [.-], numeric fields compare
// numerically): enough to decide "beta is newer than the stable pin" for
// shapes like 2026.7.1-2 vs 2026.8.1-beta.3. NOT a full semver — prerelease
// precedence subtleties don't matter for the cross-minor sanity check here.
const compareLooseVersions = (a, b) => {
  const split = (v) => String(v).split(/[.-]/);
  const fa = split(a);
  const fb = split(b);
  const len = Math.max(fa.length, fb.length);
  for (let i = 0; i < len; i++) {
    const sa = fa[i];
    const sb = fb[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    const na = Number(sa);
    const nb = Number(sb);
    const bothNumeric = Number.isFinite(na) && Number.isFinite(nb) && /^\d+$/.test(sa) && /^\d+$/.test(sb);
    if (bothNumeric) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
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
  strict,
  describeContainer,
  repoRoot,
  artifactsDir,
  ensureArtifactsDir,
  docker,
  dockerAvailable,
  assertDockerAvailable,
  buildImage,
  createVolume,
  seedVolume,
  runContainer,
  getMappedPort,
  execInContainer,
  execDetachedInContainer,
  containerLogs,
  restartCount,
  containerStartedAt,
  removeContainer,
  removeVolume,
  sleep,
  waitFor,
  compareLooseVersions,
  loginForCookie,
  fetchJsonWithCookie,
};
