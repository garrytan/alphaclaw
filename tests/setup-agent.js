const http = require("http");
const https = require("https");

// Kill HTTP keep-alive for every test.
//
// Node >=19 enables keepAlive on the global agent. Supertest suites spin up
// thousands of throwaway servers on ephemeral ports; a kept-alive socket to
// port P outlives its server's close (close only refuses NEW connections),
// the kernel hands P to the next test's server, and superagent's pool reuses
// the stale socket — so the request is ANSWERED BY THE PREVIOUS TEST'S APP.
// That is the long-standing "1-3 rotating supertest failures" class: 401s
// from apps with no auth, 404s for routes that exist, {} bodies from the
// wrong router. Fresh connections per request make it structurally
// impossible; the per-request cost in tests is noise.
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });

// Keep the suite hermetic against the machine it runs on.
//
// Resource autotune is default-ON and derives gateway env/limits from the
// REAL container's cgroup files — on a big CI box, gatewayEnv() would grow a
// machine-dependent --max-old-space-size and every env assertion would vary
// by host. The kill-switch pins the legacy (pre-autotune) behavior globally;
// autotune's own suites re-enable it per call via explicit `env: {}` options
// and mocked cgroup files.
process.env.ALPHACLAW_AUTOTUNE_DISABLED = "1";
// The stale-lock sweep deletes matching entries in the REAL os.tmpdir() —
// on a dev machine running an actual openclaw gateway, a cold-start test
// could reap a live installation's lock. Off for every tier; the sweep's own
// suite re-enables it per test, and one container-tier case exercises the
// real thing inside Docker.
process.env.ALPHACLAW_STATE_LOCK_SWEEP_DISABLED = "1";

// Guarantee git exit-code fidelity for every test.
//
// Some sandboxed hosts interpose a `git` wrapper on PATH that swallows exit
// codes for network subcommands (observed: Conductor's /conductor/bin/git —
// `status=$?` placed after `if cmd; then …; fi` captures the if-statement's
// status, which is 0 when the condition fails, so a FAILED push/fetch/clone
// exits 0 with the error only printed). Tests and the code under test rely
// on git's exit codes ("push failed" handling), so probe once per worker
// with a subcommand the wrapper intercepts; if PATH git lies, prepend a
// shim dir resolving to a truthful binary. No-op on healthy machines.
try {
  const { spawnSync } = require("child_process");
  const kBrokenProbe = ["ls-remote", "file:///nonexistent-git-fidelity-probe"];
  const gitLies = (bin) => {
    const probe = spawnSync(bin, kBrokenProbe, { stdio: "ignore", timeout: 5000 });
    return probe.status === 0;
  };
  if (gitLies("git")) {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const candidates = [
      process.env.CONDUCTOR_REAL_GIT_PATH,
      "/usr/bin/git",
      "/bin/git",
    ].filter(Boolean);
    const truthful = candidates.find((bin) => {
      try {
        return fs.existsSync(bin) && !gitLies(bin);
      } catch {
        return false;
      }
    });
    if (truthful) {
      const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "real-git-"));
      fs.symlinkSync(truthful, path.join(shimDir, "git"));
      process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH || ""}`;
    }
  }
} catch {
  // Probe failures must never break the suite — worst case tests run with
  // whatever git PATH provides, as before.
}
