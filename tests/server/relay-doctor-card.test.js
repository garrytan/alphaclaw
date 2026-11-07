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

describe("relay brain archive doctor cards (ALPH-68 PR3)", () => {
  it("no card when the archive is off, has no gbrain or no relay source, or only retries", () => {
    expect(buildRelayCards({ enabled: true, phase: "ready", archive: { enabled: false, phase: "off" } })).toEqual([]);
    expect(buildRelayCards({ enabled: true, phase: "ready", archive: { enabled: true, phase: "unavailable", code: "gbrain_missing", parked: [] } })).toEqual([]);
    expect(buildRelayCards({ enabled: true, phase: "ready", archive: { enabled: true, phase: "unavailable", code: "source_missing", parked: [] } })).toEqual([]);
    expect(buildRelayCards({ enabled: true, phase: "ready", archive: { enabled: true, phase: "ready", lastError: { code: "gbrain_busy" }, parked: [] } })).toEqual([]);
  });

  it("one card per parked code, and one for a federated relay source", () => {
    const cards = buildRelayCards({
      enabled: true,
      phase: "ready",
      archive: { enabled: true, phase: "ready", parked: [{ code: "gbrain_stopped", count: 2 }, { code: "masked_refused", count: 1 }] },
    });
    expect(cards.map((card) => card.sourceKey)).toEqual(["det:relay-archive-gbrain_stopped", "det:relay-archive-masked_refused"]);
    expect(cards[0].summary).toContain("2 relay conversations are not saved");
    expect(cards[0].fixPrompt).toContain("never press Retry for the owner");
    const federated = buildRelayCards({ enabled: true, phase: "ready", archive: { enabled: true, phase: "unavailable", code: "source_federated", parked: [] } });
    expect(federated.map((card) => card.sourceKey)).toEqual(["det:relay-archive-source_federated"]);
  });

  it("a peer past its total archive budget gets a card that says what lifts it", () => {
    const [card] = buildRelayCards({ enabled: true, phase: "ready", archive: { enabled: true, phase: "ready", parked: [{ code: "peer_budget_total", count: 3 }] } });
    expect(card.sourceKey).toBe("det:relay-archive-peer_budget_total");
    expect(card.summary).toContain("3 relay conversations are not saved to the brain until the peer's archive budget is raised");
    expect(card.recommendation).toContain("ALPHACLAW_RELAY_BRAIN_PEER_TOTAL_MB");
  });

  it("a failed relay keeps its own card first and the archive's after it", () => {
    const cards = buildRelayCards({
      enabled: true,
      phase: "failed",
      error: describeRelayError("engine_unavailable", "down"),
      archive: { enabled: true, phase: "ready", parked: [{ code: "revision_conflict", count: 1 }] },
    });
    expect(cards.map((card) => card.sourceKey)).toEqual(["det:relay-engine_unavailable", "det:relay-archive-revision_conflict"]);
  });
});
