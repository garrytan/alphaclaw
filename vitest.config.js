import os from "node:os";
import { configDefaults, defineConfig } from "vitest/config";

// tests/live/** hit the real npm registry, the real GitHub API, and (in the
// dev tier) run a real from-source OpenClaw build. They are opt-in:
//   OPENCLAW_LIVE_E2E=1          → catalog + package-apply tiers (network, ~5 min)
//   OPENCLAW_LIVE_E2E_DEV=1 too  → full dev source build (20-35 min, ~5 GB)
// `npm test` stays hermetic and offline; use `npm run test:live[:dev]`.
const kLiveE2eEnabled = process.env.OPENCLAW_LIVE_E2E === "1";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.js"],
    exclude: kLiveE2eEnabled
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, "tests/live/**"],
    restoreMocks: true,
    clearMocks: true,
    // Disables HTTP keep-alive: with it on (Node >=19 default), a pooled
    // socket can outlive its supertest server and answer a later test's
    // request bound to a reused ephemeral port — see tests/setup-agent.js.
    setupFiles: ["tests/setup-agent.js"],
    // Tests that touch the openclaw plugin-sdk pay a >5s dynamic-import cost
    // on first load per worker, which flakes under parallel machine load.
    testTimeout: 30000,
    // One fork per core oversubscribes the machine: fork spawn + transform +
    // import overhead dominates, and the induced load makes time-dependent
    // tests flake (supertest socket hangs, mockResolvedValueOnce queue
    // misalignment — the long-standing "1-3 rotating failures" class).
    // Measured on a 16-core M-series: capped at 6 the suite is 5x faster
    // (30s → 6s) and repeatedly green; at 8 the rotating flakes return; at 16
    // (the default) they hit every other run.
    maxWorkers: Math.max(2, Math.min(6, Math.floor(os.availableParallelism() / 2))),
    // Residual safety net for pure CPU-contention blips (a mock resolving one
    // tick late, a throttle-window test under a stalled event loop). A real
    // regression fails both attempts and stays red; a retried pass is marked
    // "retried" in the output, so flakes remain visible, never hidden.
    retry: 1,
  },
});
