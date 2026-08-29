const load = () =>
  import(
    "../../lib/public/js/components/onboarding/use-welcome-storage.js"
  );

// MW1: credential-shaped onboarding fields must never be persisted to
// localStorage; only UI/progress state should survive a reload.
describe("frontend/use-welcome-storage stripSecretVals (MW1)", () => {
  it("drops credential-shaped keys", async () => {
    const { stripSecretVals } = await load();
    const stripped = stripSecretVals({
      ANTHROPIC_API_KEY: "sk-secret",
      TELEGRAM_BOT_TOKEN: "123:secret",
      OPENCLAW_GATEWAY_TOKEN: "gw-secret",
      GITHUB_TOKEN: "ghp_secret",
      SOME_PASSWORD: "pw",
      SOME_SECRET: "s",
      GITHUB_WORKSPACE_REPO: "owner/repo",
      _step: 2,
    });
    expect(stripped).toEqual({
      GITHUB_WORKSPACE_REPO: "owner/repo",
      _step: 2,
    });
  });

  it("keeps non-secret UI/config fields", async () => {
    const { stripSecretVals } = await load();
    expect(stripSecretVals({ MODEL_KEY: "openai/gpt-5.1", _pairingChannel: "telegram" })).toEqual({
      MODEL_KEY: "openai/gpt-5.1",
      _pairingChannel: "telegram",
    });
  });
});
