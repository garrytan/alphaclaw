// Test inventory metadata (scripts/ci/test-inventory.mjs).
//
// Records, per test, how many assertions ran and how many retries it took
// (`retry: 1` in vitest.config.js). Vitest's JSON reporter writes task.meta
// into every assertion result, so one report carries the whole inventory and
// nothing has to survive the per-run TMPDIR teardown. Read-only: it never
// changes a test's outcome.
afterEach((context) => {
  context.task.meta.assertions = expect.getState().assertionCalls;
  context.task.meta.retries = context.task.result?.retryCount ?? 0;
});
