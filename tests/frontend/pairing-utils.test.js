import {
  getPreferredPairingChannel,
  isChannelPaired,
} from "../../lib/public/js/components/onboarding/pairing-utils.js";

describe("frontend/onboarding/pairing-utils", () => {
  it("prefers telegram when both channel tokens are present", () => {
    const channel = getPreferredPairingChannel({
      TELEGRAM_BOT_TOKEN: "tg-token",
      DISCORD_BOT_TOKEN: "dc-token",
    });

    expect(channel).toBe("telegram");
  });

  it("falls back to discord when telegram is missing", () => {
    const channel = getPreferredPairingChannel({
      DISCORD_BOT_TOKEN: "dc-token",
    });

    expect(channel).toBe("discord");
  });

  it("returns empty string when no channel tokens are present", () => {
    expect(getPreferredPairingChannel({})).toBe("");
  });

  it("never preselects ClickClack from its manual onboarding token (5.1)", () => {
    // Fresh onboarding saves CLICKCLACK_BOT_TOKEN but writes no server-side
    // ClickClack config, so it must not become the pairing target — onboarding
    // should fall through to web chat (empty) instead of a hung Pairing step.
    expect(getPreferredPairingChannel({ CLICKCLACK_BOT_TOKEN: "ccb_x" })).toBe(
      "",
    );
    // A real pairing-capable channel still wins even alongside ClickClack.
    expect(
      getPreferredPairingChannel({
        CLICKCLACK_BOT_TOKEN: "ccb_x",
        TELEGRAM_BOT_TOKEN: "tg-token",
      }),
    ).toBe("telegram");
  });

  it("treats channel as paired only when status is paired and count > 0", () => {
    const channels = {
      telegram: { status: "paired", paired: 1 },
      discord: { status: "configured", paired: 0 },
    };

    expect(isChannelPaired(channels, "telegram")).toBe(true);
    expect(isChannelPaired(channels, "discord")).toBe(false);
    expect(isChannelPaired(channels, "unknown")).toBe(false);
  });
});
