const { evaluateUpgradeDiskCheck, kCoveredStateBytes } = require("../../lib/server/upgrade-disk-check");

const kGb = 1e9;

describe("upgrade disk check (ALPH-23)", () => {
  it("passes the measured 16 GB VM: 117 GB free", () => {
    expect(evaluateUpgradeDiskCheck({ stateBytes: 16 * kGb, freeBytes: 117 * kGb })).toMatchObject({
      verdict: "ok",
      sentences: [],
      neededBytes: 32 * kGb,
      expectedMinutes: 13,
    });
  });

  it("warns below 2x the state: OpenClaw will likely skip its recovery copy", () => {
    const check = evaluateUpgradeDiskCheck({ stateBytes: 30 * kGb, freeBytes: 45 * kGb });
    expect(check.verdict).toBe("warn");
    expect(check.sentences).toEqual([
      "Only 45.0 GB is free for 30.0 GB of OpenClaw state. The data upgrade needs about 60.0 GB, so OpenClaw will likely skip its recovery copy and the upgrade will have no rollback snapshot.",
    ]);
  });

  it("refuses below 1.1x the state, with the space to free", () => {
    const check = evaluateUpgradeDiskCheck({ stateBytes: 30 * kGb, freeBytes: 32 * kGb });
    expect(check.verdict).toBe("refuse");
    expect(check.sentences[0]).toContain("this volume has 32.0 GB free for 30.0 GB of OpenClaw state");
    expect(check.sentences[0]).toContain("Make at least 60.0 GB free, then use Retry upgrade.");
    expect(evaluateUpgradeDiskCheck({ stateBytes: 30 * kGb, freeBytes: 33.1 * kGb }).verdict).toBe("warn");
  });

  it("warns when the state is larger than the Doctor limit is sized for", () => {
    const check = evaluateUpgradeDiskCheck({ stateBytes: kCoveredStateBytes + kGb, freeBytes: 10_000 * kGb });
    expect(check.verdict).toBe("warn");
    expect(check.sentences[0]).toMatch(/more than AlphaClaw's 6-hour Doctor limit is sized for \(about 154\.6 GB\)/);
  });

  it("never refuses on an unmeasured free space or an empty state", () => {
    expect(evaluateUpgradeDiskCheck({ stateBytes: 30 * kGb, freeBytes: null }).verdict).toBe("ok");
    expect(evaluateUpgradeDiskCheck({ stateBytes: 0, freeBytes: 0 }).verdict).toBe("ok");
  });
});
