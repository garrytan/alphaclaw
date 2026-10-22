const { sleep } = require("../../lib/server/utils/sleep");

describe("utils/sleep", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves after the delay through the setTimeout in effect at call time", async () => {
    vi.useFakeTimers();
    let resolved = false;
    const pending = sleep(1000).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });
});
