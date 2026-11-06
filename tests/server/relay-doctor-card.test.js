const { buildRelayCards } = require("../../lib/server/relay/doctor-card");
const { describeRelayError } = require("../../lib/server/relay/errors");

describe("relay doctor card", () => {
  it("no card while off, starting, ready, or exposed on a non-loopback address", () => {
    expect(buildRelayCards(null)).toEqual([]);
    expect(buildRelayCards({ enabled: false, phase: "off" })).toEqual([]);
    expect(buildRelayCards({ enabled: true, phase: "provisioning" })).toEqual([]);
    expect(buildRelayCards({ enabled: true, phase: "ready", engine: { exposure: { exposedOn: ["10.0.0.2"] } } })).toEqual([]);
  });

  it("one coded card while the relay is on but failed", () => {
    const [card, ...rest] = buildRelayCards({ enabled: true, phase: "failed", error: describeRelayError("secrets_missing", "db without keys"), retryAt: null });
    expect(rest).toEqual([]);
    expect(card).toMatchObject({ sourceKey: "det:relay-secrets_missing", priority: "P1" });
    expect(card.recommendation).toContain("Restore relay/secrets.json");
    expect(card.fixPrompt).toContain("never print their contents");
  });
});
