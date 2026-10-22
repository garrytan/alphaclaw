const loadStep = async () =>
  (await import("../../lib/public/js/components/onboarding/welcome-pairing-step.js")).WelcomePairingStep;

const collectText = (node) => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  return collectText(node.props?.children);
};

describe("frontend/welcome-pairing-step", () => {
  it.each([
    ["telegram", "Telegram"],
    ["whatsapp", "WhatsApp"],
    ["clickclack", "ClickClack"],
    ["somethingnew", "Somethingnew"],
  ])("labels %s from the channel registry (%s)", async (channel, label) => {
    const Step = await loadStep();
    const text = collectText(Step({ channel, canFinish: true, pairings: [] }));
    expect(text).toContain(`Your ${label} channel is connected`);
  });
});
