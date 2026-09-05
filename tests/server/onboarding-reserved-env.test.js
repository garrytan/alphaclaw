const { partitionReservedEnvVars } = require("../../lib/server/onboarding/reserved-env");
const { kSystemVars } = require("../../lib/server/constants");
const { kDeploymentOnlyEnvKeys } = require("../../lib/server/deployment-only-env");

// Fix wave F105: an imported repo's .env may not write deployment-controlled or
// deployment-only keys into the live .env.
describe("onboarding/reserved-env partitionReservedEnvVars", () => {
  it("drops system and deployment-only keys and reports them", () => {
    const { accepted, skippedReservedKeys } = partitionReservedEnvVars(
      [
        { key: "OPENAI_API_KEY", value: "sk" },
        { key: "SETUP_PASSWORD", value: "pwn" },
        { key: "OPENCLAW_GATEWAY_TOKEN", value: "t" },
        { key: "WATCHDOG_AUTO_REPAIR", value: "0" },
        { key: kDeploymentOnlyEnvKeys[0], value: "1" },
        { key: "", value: "ignored" },
        { key: "BRIGHTDATA_API_KEY", value: "b" },
      ],
      kSystemVars,
    );
    expect(accepted.map((v) => v.key)).toEqual(["OPENAI_API_KEY", "BRIGHTDATA_API_KEY"]);
    expect(skippedReservedKeys).toEqual([
      "SETUP_PASSWORD",
      "OPENCLAW_GATEWAY_TOKEN",
      "WATCHDOG_AUTO_REPAIR",
      kDeploymentOnlyEnvKeys[0],
    ]);
  });

  it("tolerates a missing system-var set and non-array input", () => {
    expect(partitionReservedEnvVars(undefined, undefined)).toEqual({ accepted: [], skippedReservedKeys: [] });
    const { accepted } = partitionReservedEnvVars([{ key: "GATEWAY_RESTART_READY_TIMEOUT", value: "5" }], null);
    expect(accepted).toEqual([]);
  });
});
