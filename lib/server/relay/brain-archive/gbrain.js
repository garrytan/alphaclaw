const fs = require("fs");
const { spawn } = require("child_process");

// The one way AlphaClaw talks to gbrain: the box's gbrain wrapper, as argv
// (never a shell), with the page on stdin. No other door: never
// \`bun run src/cli.ts\`, a hand-set HOME, put_pages over MCP, or git in the
// brain. gbrain 0.60.593's exit contract (docs/guides/exit-codes.md):
//   0 committed · 1 failed (read .code, .retryable) · 2 usage · 3 stop
//   (confirmation_required, nothing ran) · 10 accepted, still pending
//   (poll write-request, never resubmit) · 75 lock held (retry later) ·
//   124 its own deadline elapsed.
const kDefaultWrapperPath = "/usr/local/bin/gbrain";
const kDefaultTimeoutMs = 120 * 1000;
const kMaxOutputBytes = 4 * 1024 * 1024;
const kKillGraceMs = 5000;
const kAbandonAfterKillMs = 2000;

// gbrain gets an allowlisted environment, never AlphaClaw's whole one (its
// provider keys, setup password and channel tokens): the basics a CLI needs,
// proxy and CA settings, and gbrain's own GBRAIN_* settings. gbrain reads
// its database and provider keys from its own config.
const kGbrainEnvKeys = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TERM",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "BUN_INSTALL", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
]);
const gbrainEnv = (env = process.env) =>
  Object.fromEntries(Object.entries(env || {}).filter(([key, value]) => typeof value === "string" && (kGbrainEnvKeys.has(key) || key.startsWith("LC_") || key.startsWith("GBRAIN_"))));

const resolveGbrainBin = ({ configured = "", fsModule = fs, wrapperPath = kDefaultWrapperPath } = {}) => {
  if (configured) return configured;
  try {
    fsModule.accessSync(wrapperPath, fs.constants.X_OK);
    return wrapperPath;
  } catch {
    return "";
  }
};

const parseJsonOutput = (stdout) => {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

const createGbrainRunner = ({ bin, env = process.env, cwd = undefined, spawnImpl = spawn, timeoutMs = kDefaultTimeoutMs }) => {
  const run = (args, { input = null } = {}) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let child;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, json: parseJsonOutput(stdout), timedOut, ...result });
      };
      try {
        child = spawnImpl(bin, args, { env: gbrainEnv(env), cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
      } catch (error) {
        resolve({ exitCode: null, spawnError: error?.code || "spawn_failed", stdout: "", stderr: "", json: null, timedOut: false });
        return;
      }
      // The wrapper runs gbrain as its own child, so a timeout signals the
      // whole process group; a process that still holds the pipes after
      // SIGKILL is abandoned rather than awaited.
      const signalGroup = (signal) => {
        try {
          process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {}
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        signalGroup("SIGTERM");
        setTimeout(() => {
          signalGroup("SIGKILL");
          setTimeout(() => {
            child.stdout?.destroy?.();
            child.stderr?.destroy?.();
            finish({ exitCode: null, signal: "SIGKILL" });
          }, kAbandonAfterKillMs).unref?.();
        }, kKillGraceMs).unref?.();
      }, timeoutMs);
      timer.unref?.();
      child.stdout.on("data", (chunk) => {
        if (stdout.length < kMaxOutputBytes) stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < kMaxOutputBytes) stderr += chunk;
      });
      child.on("error", (error) => finish({ exitCode: null, spawnError: error?.code || "spawn_failed" }));
      child.on("close", (exitCode, signal) => finish({ exitCode, signal: signal || null }));
      child.stdin.on("error", () => {});
      if (input !== null) child.stdin.end(input);
      else child.stdin.end();
    });

  return {
    bin,
    run,
    listSources: () => run(["sources", "list", "--json"]),
    getPage: (slug) => run(["get", "--source", "relay", "--json", "--", slug]),
    putPage: ({ slug, markdown, requestId, expectedRevision = null }) =>
      run(
        [
          "put",
          slug,
          "--source",
          "relay",
          ...(expectedRevision ? ["--expected-revision", expectedRevision] : []),
          "--request-id",
          requestId,
          "--json",
        ],
        { input: markdown },
      ),
    readWriteRequest: (requestId) => run(["write-request", "--json", "--", requestId]),
    commitPush: ({ checkout, message, paths }) => run(["git", "commit-push", "--path", checkout, "-m", message, "--json", "--", ...paths]),
  };
};

module.exports = { createGbrainRunner, resolveGbrainBin, parseJsonOutput, gbrainEnv, kDefaultWrapperPath };
