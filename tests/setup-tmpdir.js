// Vitest globalSetup: one private TMPDIR per suite run, removed at teardown.
//
// WHY: hundreds of hermetic tests call `fs.mkdtempSync(path.join(os.tmpdir(),
// "<prefix>-"))` and many never remove the directory (a throw before the
// cleanup, an `afterAll` that a SIGTERMed fork never reaches, or simply no
// cleanup at all). Measured on a dev box after ~45 full runs: 139 770 entries
// and 7 GB under /tmp. Fixing every call site is a losing race — new tests
// keep arriving — so the run owns its temp root instead: this hook runs in
// the main vitest process BEFORE any worker fork is spawned, so the workers
// inherit TMPDIR and `os.tmpdir()` (which re-reads the env on every call on
// POSIX) resolves inside the per-run directory. Teardown removes the whole
// tree in one call. The path is guarded so a mis-set env can never point the
// recursive delete at anything but the directory this hook created.
//
// Opt out with ALPHACLAW_KEEP_TEST_TMPDIR=1 (the path is printed) when a
// failing test's scratch files are worth inspecting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const kRunTmpPrefix = "alphaclaw-vitest-run-";
const kKeepEnv = "ALPHACLAW_KEEP_TEST_TMPDIR";

export default async function setupRunTmpdir() {
  const root = fs.realpathSync(os.tmpdir());
  const runDir = fs.mkdtempSync(path.join(root, kRunTmpPrefix));
  // TMP/TEMP are read by nothing on POSIX but cost nothing and keep the
  // three conventional names consistent for any child process the tests spawn.
  for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = runDir;
  return () => {
    if (process.env[kKeepEnv] === "1") {
      process.stderr.write(`[setup-tmpdir] kept ${runDir} (${kKeepEnv}=1)\n`);
      return;
    }
    const resolved = path.resolve(runDir);
    // Fail closed: only ever delete the directory this very hook created.
    if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith(kRunTmpPrefix)) {
      process.stderr.write(`[setup-tmpdir] refusing to remove unexpected path ${resolved}\n`);
      return;
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
  };
}
