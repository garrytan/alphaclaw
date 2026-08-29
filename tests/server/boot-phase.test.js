const { setBootPhase, getBootPhase } = require("../../lib/server/boot-phase");

describe("server/boot-phase", () => {
  // Module-level singleton: leave every test on a settled boot so ordering
  // within this file (and any co-resident module consumer) never matters.
  afterEach(() => {
    setBootPhase("ready");
  });

  it("round-trips all three boot phases through set/get", () => {
    setBootPhase("starting_gateway");
    expect(getBootPhase()).toEqual({ phase: "starting_gateway", error: null });

    setBootPhase("failed", { error: "channel sync exploded" });
    expect(getBootPhase()).toEqual({
      phase: "failed",
      error: "channel sync exploded",
    });

    setBootPhase("ready");
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
  });

  it("ignores invalid phases without touching the recorded state", () => {
    setBootPhase("failed", { error: new Error("boom") });

    setBootPhase("exploded");
    setBootPhase("");
    setBootPhase(null);
    setBootPhase(undefined, { error: "should not stick" });

    // The failed phase AND its error string both survive the bad inputs.
    expect(getBootPhase()).toEqual({ phase: "failed", error: "boom" });
  });

  it("stringifies failure errors and clears them on non-failed phases", () => {
    // Error objects flatten to their message.
    setBootPhase("failed", { error: new Error("gateway launch failed") });
    expect(getBootPhase().error).toBe("gateway launch failed");

    // Bare strings pass through.
    setBootPhase("failed", { error: "plain string failure" });
    expect(getBootPhase().error).toBe("plain string failure");

    // Absent error still records a string (empty), never null/undefined.
    setBootPhase("failed");
    expect(getBootPhase()).toEqual({ phase: "failed", error: "" });

    // Errors only ride on the failed phase; other phases null them out.
    setBootPhase("ready", { error: new Error("ignored") });
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
  });
});
