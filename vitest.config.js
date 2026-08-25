import { configDefaults, defineConfig } from "vitest/config";

// tests/live/** hit the real npm registry, the real GitHub API, and (in the
// dev tier) run a real from-source OpenClaw build. They are opt-in:
//   OPENCLAW_LIVE_E2E=1          → catalog + package-apply tiers (network, ~5 min)
//   OPENCLAW_LIVE_E2E_DEV=1 too  → full dev source build (10-30 min, ~5 GB)
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
    // Tests that touch the openclaw plugin-sdk pay a >5s dynamic-import cost
    // on first load per worker, which flakes under parallel machine load.
    testTimeout: 30000,
  },
});
