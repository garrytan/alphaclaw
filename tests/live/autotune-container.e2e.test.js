const { execFileSync, spawnSync } = require("child_process");

// Constrained-container smoke for resource autotune (opt-in live tier).
// Validates against REAL cgroups + REAL V8 what the hermetic suite can only
// mock:
//   1. Inside `docker run --memory=<N>`, the cgroup files report the limit and
//      the derived --max-old-space-size lands alongside a known young-space
//      allowance in V8's total heap ceiling.
//   2. A process driven past a small heap cap aborts with the exact stderr
//      shape the watchdog's OOM classifier matches.
//
// Requires: OPENCLAW_LIVE_E2E=1 AND a working docker daemon. Deliberately
// does NOT assert exact RSS values (flaky) and does not exercise the full app
// in-container (the hermetic suites cover the wiring; this pins the
// runtime/kernel assumptions the formulas rest on).

const kLiveE2eEnabled = process.env.OPENCLAW_LIVE_E2E === "1";
const dockerAvailable = (() => {
  if (!kLiveE2eEnabled) return false;
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15000 });
    return true;
  } catch {
    return false;
  }
})();

const kImage = "node:24-slim";
const kMb = 1024 * 1024;

const runInContainer = ({ memory, nodeArgs = [], script, timeoutMs = 120000 }) =>
  spawnSync(
    "docker",
    [
      "run",
      "--rm",
      `--memory=${memory}`,
      "--memory-swap",
      memory, // no swap: the limit is the limit
      kImage,
      "node",
      ...nodeArgs,
      "-e",
      script,
    ],
    { encoding: "utf8", timeout: timeoutMs },
  );

describe.skipIf(!dockerAvailable)(
  "live: autotune constrained-container smoke",
  () => {
    it(
      "cgroup limit is visible and V8's ceiling includes the derived old-space cap plus young space",
      { timeout: 300000 },
      () => {
        const { deriveTunings } = require("../../lib/server/autotune");
        const liveProfile = (memMb) => ({
          memory: { limitBytes: memMb * kMb, source: "cgroup-v2" },
          cpu: { cores: 1 },
          disk: { totalBytes: 40 * 1024 * kMb, path: "/" },
          tier: memMb <= 640 ? "micro" : "small",
          environment: "container",
        });
        for (const { memory, memMb, overrides = {} } of [
          { memory: "512m", memMb: 512 },
          { memory: "2g", memMb: 2048 },
          // Default V8 old-space happens to match both derivations above.
          // A distinct operator cap makes ignoring the flag fail this test.
          { memory: "2g", memMb: 2048, overrides: { gatewayHeapMb: 768 } },
        ]) {
          // The REAL shipped derivation — never a re-implemented copy that
          // could silently drift from production.
          const derivedHeapMb = deriveTunings(liveProfile(memMb), { overrides }).values
            .gatewayHeapMb;
          // The flag caps OLD space; heap_size_limit includes young space.
          // Node 24.20 reports 1120 MiB for --max-old-space-size=1024 in
          // a 2 GiB container, so a fixed ±64 MiB tolerance is incorrect.
          // Fix the fixture's semi-space size to make the documented 3×
          // young-generation allowance explicit and assert exact bytes.
          // https://nodejs.org/api/cli.html#--max-semi-space-sizesize-in-mib
          const semiSpaceMb = 8;
          const result = runInContainer({
            memory,
            nodeArgs: [
              `--max-old-space-size=${derivedHeapMb}`,
              `--max-semi-space-size=${semiSpaceMb}`,
            ],
            script: `
              const fs = require("fs");
              const v8 = require("v8");
              const read = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; } };
              console.log(JSON.stringify({
                cgroupV2: read("/sys/fs/cgroup/memory.max"),
                cgroupV1: read("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
                heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
              }));
            `,
          });
          expect(result.status, result.stderr).toBe(0);
          const report = JSON.parse(String(result.stdout).trim());
          // The container sees ITS limit, not the host's.
          const limitBytes = Number.parseInt(report.cgroupV2 ?? report.cgroupV1, 10);
          expect(limitBytes).toBe(memMb * kMb);
          expect(report.heapLimitBytes).toBe(
            (derivedHeapMb + 3 * semiSpaceMb) * kMb,
          );
        }
      },
    );

    it(
      "forced heap exhaustion emits the exact stderr the OOM classifier matches — a V8 abort, never a cgroup kill",
      { timeout: 300000 },
      () => {
        // Fix wave F220/F223: the retained strings must be HEAP-resident.
        // Node externalizes Buffer#toString results larger than EXTERN_APEX
        // (0xFBEE9 ≈ 1 MB, src/string_bytes.cc) — the old 1 MiB-buffer
        // fixture produced 1.4 MB base64 strings that lived OUTSIDE the V8
        // heap, so --max-old-space-size never tripped: the container was
        // cgroup-killed (exit 137, empty stderr) and the test passed for the
        // wrong reason or flaked. 256 KiB buffers → ~350 KB strings: on-heap,
        // counted against the cap, so V8 itself aborts with its signature.
        const result = runInContainer({
          memory: "512m",
          nodeArgs: ["--max-old-space-size=128"],
          script: `
            const hog = [];
            for (;;) hog.push(Buffer.alloc(256 * 1024).toString("base64"));
          `,
        });
        expect(result.status).not.toBe(0);
        // Positive proof of a V8 abort: the classifier's pattern on stderr AND
        // an exit that is not the cgroup OOM-killer's (137 / SIGKILL). A kernel
        // kill can never masquerade as a pass again.
        expect(String(result.stderr)).toMatch(
          /JavaScript heap out of memory|Reached heap limit/i,
        );
        expect(result.status).not.toBe(137);
        expect(result.signal).not.toBe("SIGKILL");
      },
    );
  },
);
