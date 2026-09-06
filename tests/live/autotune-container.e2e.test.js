const { execFileSync, spawnSync } = require("child_process");

// Constrained-container smoke for resource autotune (opt-in live tier).
// Validates against REAL cgroups + REAL V8 what the hermetic suite can only
// mock:
//   1. Inside `docker run --memory=<N>`, the cgroup files report the limit and
//      the derived --max-old-space-size actually lands as V8's heap ceiling.
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

const kImage = "node:22-slim";
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
      "cgroup limit is visible in-container and the derived heap flag sets V8's ceiling",
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
        for (const { memory, memMb } of [
          { memory: "512m", memMb: 512 },
          { memory: "2g", memMb: 2048 },
        ]) {
          // The REAL shipped derivation — never a re-implemented copy that
          // could silently drift from production.
          const derivedHeapMb = deriveTunings(liveProfile(memMb), {}).values
            .gatewayHeapMb;
          const result = runInContainer({
            memory,
            nodeArgs: [`--max-old-space-size=${derivedHeapMb}`],
            script: `
              const fs = require("fs");
              const v8 = require("v8");
              const read = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; } };
              console.log(JSON.stringify({
                cgroupV2: read("/sys/fs/cgroup/memory.max"),
                cgroupV1: read("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
                heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576),
              }));
            `,
          });
          expect(result.status, result.stderr).toBe(0);
          const report = JSON.parse(String(result.stdout).trim().split("\n").pop());
          // The container sees ITS limit, not the host's.
          const limitBytes = Number.parseInt(report.cgroupV2 ?? report.cgroupV1, 10);
          expect(limitBytes).toBe(memMb * kMb);
          // V8 grants the flag some bookkeeping headroom; ±64MB tolerance.
          expect(Math.abs(report.heapLimitMb - derivedHeapMb)).toBeLessThanOrEqual(64);
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
