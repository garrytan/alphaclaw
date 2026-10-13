const {
  classifyLocalStateOwnerFailure,
} = require("../../lib/server/utils/local-state-owner");

const {
  kOwnerUnavailable,
  kOwnerRefused,
  kOutcomeUnknown,
  kJsonEnvelope,
} = require("./helpers/local-state-owner-fixtures");

describe("server/utils/local-state-owner", () => {
  it("recovers OWNER_UNAVAILABLE from stderr and from the --json envelope", () => {
    expect(
      classifyLocalStateOwnerFailure({ ok: false, stdout: "", stderr: kOwnerUnavailable }),
    ).toBe("OWNER_UNAVAILABLE");
    expect(
      classifyLocalStateOwnerFailure({
        ok: false,
        stdout: kJsonEnvelope(kOwnerUnavailable),
        stderr: "",
      }),
    ).toBe("OWNER_UNAVAILABLE");
    expect(
      classifyLocalStateOwnerFailure({
        ok: false,
        stderr: "Selected state root changed; rerun the command.",
      }),
    ).toBe("OWNER_UNAVAILABLE");
  });

  it("separates OWNER_REFUSED from OUTCOME_UNKNOWN on the shared prefix", () => {
    expect(classifyLocalStateOwnerFailure({ ok: false, stderr: kOwnerRefused })).toBe(
      "OWNER_REFUSED",
    );
    expect(classifyLocalStateOwnerFailure({ ok: false, stderr: kOutcomeUnknown })).toBe(
      "OUTCOME_UNKNOWN",
    );
  });

  it("leaves ordinary CLI failures unclassified", () => {
    expect(
      classifyLocalStateOwnerFailure({
        ok: false,
        stderr:
          'No pending pairing request found for code "ABCD1234". Run openclaw pairing list --channel telegram to list pending requests.',
      }),
    ).toBeNull();
    expect(classifyLocalStateOwnerFailure({ ok: false, stderr: "store exploded" })).toBeNull();
    expect(classifyLocalStateOwnerFailure(null)).toBeNull();
  });
});
