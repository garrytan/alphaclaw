const express = require("express");
const request = require("supertest");
const { readRelayConfig, kRelayEnvKeys } = require("../../lib/server/relay/config");
const { kRelayErrors, RelayError, sendRelayProblem, toMcpError, describeRelayError } = require("../../lib/server/relay/errors");
const { kDeploymentOnlyEnvKeys } = require("../../lib/server/deployment-only-env");
const fs = require("fs");
const path = require("path");

describe("relay config", () => {
  it("is on by default with the planned limits", () => {
    expect(readRelayConfig({ env: {} })).toMatchObject({
      enabled: true,
      retentionDays: 90,
      maxConcurrent: 2,
      hourlyCap: 30,
      port: 18787,
      agentName: "openclaw",
      agentNameFromEnv: false,
    });
  });

  it("ALPHACLAW_RELAY=off (and its spellings) is the kill switch", () => {
    for (const value of ["off", "OFF", "0", "false", "no", "disabled"]) {
      expect(readRelayConfig({ env: { ALPHACLAW_RELAY: value } }).enabled).toBe(false);
    }
    expect(readRelayConfig({ env: { ALPHACLAW_RELAY: "on" } }).enabled).toBe(true);
  });

  it("clamps the numeric settings and ignores garbage", () => {
    const config = readRelayConfig({
      env: { ALPHACLAW_RELAY_MAX_CONCURRENT: "9", ALPHACLAW_RELAY_HOURLY_CAP: "abc", ALPHACLAW_RELAY_RETENTION_DAYS: "0", ALPHACLAW_RELAY_PORT: "80" },
    });
    expect(config).toMatchObject({ maxConcurrent: 4, hourlyCap: 30, retentionDays: 0, port: 1024 });
  });

  it("names the box agent from the env, else the default agent's label, else openclaw", () => {
    expect(readRelayConfig({ env: {}, defaultAgentLabel: "Wintermute" }).agentName).toBe("wintermute");
    expect(readRelayConfig({ env: { ALPHACLAW_RELAY_AGENT_NAME: "Box-1" }, defaultAgentLabel: "Wintermute" }).agentName).toBe("box-1");
    const rejected = readRelayConfig({ env: { ALPHACLAW_RELAY_AGENT_NAME: "__proto__" } });
    expect(rejected).toMatchObject({ agentName: "openclaw", agentNameRejected: true });
  });

  it("remote access is on by default; its allowlists keep Capy's entries and add only well-formed values", () => {
    expect(readRelayConfig({ env: {} })).toMatchObject({
      remoteEnabled: true,
      oauthRedirectUris: ["https://capy.ai/web/callbacks/mcp"],
      wakeHosts: ["api.capy.ai"],
    });
    const config = readRelayConfig({
      env: {
        ALPHACLAW_RELAY_REMOTE: "off",
        ALPHACLAW_RELAY_OAUTH_REDIRECT_URIS: "https://partner.test/cb, http://plain.test/cb, https://u:p@x.test/cb, not a url",
        ALPHACLAW_RELAY_WAKE_HOSTS: "Hooks.Example.com, bad host, -x.test",
      },
    });
    expect(config.remoteEnabled).toBe(false);
    expect(config.oauthRedirectUris).toEqual(["https://capy.ai/web/callbacks/mcp", "https://partner.test/cb"]);
    expect(config.wakeHosts).toEqual(["api.capy.ai", "hooks.example.com"]);
  });

  it("every relay env key is deployment-environment only", () => {
    for (const key of Object.values(kRelayEnvKeys)) expect(kDeploymentOnlyEnvKeys).toContain(key);
  });
});

describe("relay error table", () => {
  const app = express();
  app.get("/problem/:code", (req, res) => sendRelayProblem(res, new RelayError(req.params.code, "detail for " + req.params.code)));

  it.each(Object.keys(kRelayErrors))("%s answers an RFC 9457 body and an MCP isError result, and is documented", async (code) => {
    const entry = kRelayErrors[code];
    const res = await request(app).get("/problem/" + code);
    expect(res.status).toBe(entry.status);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body).toEqual({
      type: "https://github.com/garrytan/alphaclaw/blob/main/lib/setup/skills/alphaclaw-admin/relay.md#" + code,
      title: entry.title,
      status: entry.status,
      detail: "detail for " + code,
      code,
      fix: entry.fix,
      retry: entry.retry,
    });
    const mcp = toMcpError(new RelayError(code, "x"));
    expect(mcp.isError).toBe(true);
    expect(JSON.parse(mcp.content[0].text)).toMatchObject({ error: code, fix: entry.fix, retry: entry.retry });
    const doc = fs.readFileSync(path.join(__dirname, "../../lib/setup/skills/alphaclaw-admin/relay.md"), "utf8");
    expect(doc).toContain("### " + code + "\n");
    expect(doc).toContain(entry.fix);
  });

  it("an unknown code or a plain error becomes engine_error", () => {
    expect(new RelayError("nope").code).toBe("engine_error");
    expect(describeRelayError("nope").code).toBe("engine_error");
    expect(JSON.parse(toMcpError(new Error("boom")).content[0].text)).toMatchObject({ error: "engine_error", detail: "boom" });
  });
});
