const loadEnvarsPaste = async () =>
  import("../../lib/public/js/components/envars-paste.js");

describe("frontend/envars paste", () => {
  it("parses KEY=VALUE pasted into the key field", async () => {
    const { classifyEnvVarPaste } = await loadEnvarsPaste();

    expect(classifyEnvVarPaste("OPENAI_API_KEY=secret", "key")).toEqual({
      mode: "pair",
      pairs: [{ key: "OPENAI_API_KEY", value: "secret" }],
    });
  });

  it("extracts VALUE without replacing the key when pasted into the value field", async () => {
    const { classifyEnvVarPaste } = await loadEnvarsPaste();

    expect(classifyEnvVarPaste("OPENAI_API_KEY=secret", "val")).toEqual({
      mode: "value",
      pairs: [{ key: "OPENAI_API_KEY", value: "secret" }],
    });
  });

  it("imports multiple assignments from either field", async () => {
    const { classifyEnvVarPaste } = await loadEnvarsPaste();
    const pasted = "OPENAI_API_KEY=one\nGEMINI_API_KEY='two'";
    const expected = {
      mode: "bulk",
      pairs: [
        { key: "OPENAI_API_KEY", value: "one" },
        { key: "GEMINI_API_KEY", value: "two" },
      ],
    };

    expect(classifyEnvVarPaste(pasted, "key")).toEqual(expected);
    expect(classifyEnvVarPaste(pasted, "val")).toEqual(expected);
  });

  it.each([
    ["a base64 secret with padding", "c2VjcmV0LXRva2Vu=="],
    ["a URL with a query string", "https://example.com/hook?token=abc"],
    ["a connection string", "postgres://u:p@host/db?sslmode=require"],
  ])("leaves %s pasted into the value field to the native paste", async (_label, pasted) => {
    const { classifyEnvVarPaste } = await loadEnvarsPaste();

    expect(classifyEnvVarPaste(pasted, "val")).toEqual({ mode: "native", pairs: [] });
  });

  it("keeps everything after the first = in the value and accepts export prefixes", async () => {
    const { parseEnvVarPaste } = await loadEnvarsPaste();

    expect(
      parseEnvVarPaste('export API_TOKEN="abc=="\n# comment\nWEBHOOK_URL=https://x.test/?a=b'),
    ).toEqual([
      { key: "API_TOKEN", value: "abc==" },
      { key: "WEBHOOK_URL", value: "https://x.test/?a=b" },
    ]);
  });
});
