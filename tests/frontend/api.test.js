const loadApiModule = async () => import("../../lib/public/js/lib/api.js");

const mockJsonResponse = (status, payload) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(payload),
  json: async () => payload,
});

describe("frontend/api", () => {
  const expectLastFetchHeaders = (expectedContentType = "") => {
    const callArgs = global.fetch.mock.calls[global.fetch.mock.calls.length - 1] || [];
    const options = callArgs[1] || {};
    const headers = options.headers;
    expect(headers).toBeInstanceOf(Headers);
    if (expectedContentType) {
      expect(headers.get("Content-Type")).toBe(expectedContentType);
    }
    return { callArgs, options, headers };
  };

  beforeEach(() => {
    global.fetch = vi.fn();
    global.window = { location: { href: "http://localhost/" } };
  });

  it("fetchStatus returns parsed JSON on success", async () => {
    const payload = { gateway: "running" };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await loadApiModule();

    const result = await api.fetchStatus();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/status",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual(payload);
    expect(window.location.href).toBe("http://localhost/");
  });

  it("preserves typed partial-transition facts on failures without copying tokens or arbitrary fields", async () => {
    const payload = { ok: false, error: "Gateway not verified", code: "lease_expired", hint: "Retry the operation",
      disabled: true, enabled: false, configSaved: true, configRestored: true, gatewayRestored: false,
      restartDeferred: true, gatewayConfigDeferred: true, memberSaved: true, ownerCreated: false,
      changed: "true", restored: 1, gatewayApplied: null, confirmNoBackupToken: "private-consent-token",
      sessionToken: "private-session-token", unknownField: true };
    global.fetch.mockResolvedValue(mockJsonResponse(409, payload));
    const api = await loadApiModule();
    const error = await api.disableTeam().catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "lease_expired", hint: "Retry the operation", disabled: true, enabled: false,
      configSaved: true, configRestored: true, gatewayRestored: false, restartDeferred: true,
      gatewayConfigDeferred: true, memberSaved: true, ownerCreated: false });
    for (const field of ["changed", "restored", "gatewayApplied", "confirmNoBackupToken", "sessionToken", "unknownField"]) {
      expect(error).not.toHaveProperty(field);
    }
  });

  it("redirects to /setup and throws on 401", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(401, { error: "Unauthorized" }));
    const api = await loadApiModule();

    await expect(api.fetchStatus()).rejects.toThrow("Unauthorized");
    expect(window.location.href).toBe("/setup");
  });

  it("fetchStatus rejects on a 500 {error} envelope — a failed poll, never a status frame", async () => {
    // The /api/status error path answers 500 {error}; consuming it as data
    // kept connectivity "online" (truthy poll data) and rendered the legacy
    // version-skew card ({error} has no .state) against a broken new server.
    global.fetch.mockResolvedValue(
      mockJsonResponse(500, { error: "status unavailable" }),
    );
    const api = await loadApiModule();

    await expect(api.fetchStatus()).rejects.toThrow("status unavailable");
  });

  it("runOnboard sends vars and modelKey payload", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true }));
    const api = await loadApiModule();
    const vars = [{ key: "OPENAI_API_KEY", value: "sk-123" }];
    const modelKey = "openai/gpt-5.1-codex";

    const result = await api.runOnboard(vars, modelKey);

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/onboard",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ vars, modelKey, importMode: false }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true });
  });

  it("fetchOnboardProgress returns the current onboarding milestone", async () => {
    const payload = {
      active: true,
      stage: "running_openclaw_onboard",
      message: "Running openclaw onboard...",
    };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await loadApiModule();

    const result = await api.fetchOnboardProgress();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/onboard/progress",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual(payload);
  });

  it("verifyGithubOnboardingRepo posts repo, token, and mode", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, repoExists: true }));
    const api = await loadApiModule();

    const result = await api.verifyGithubOnboardingRepo(
      "my-org/source-repo",
      "ghp_123",
      "existing",
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/onboard/github/verify",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          repo: "my-org/source-repo",
          token: "ghp_123",
          mode: "existing",
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, repoExists: true });
  });

  it("scanImportRepo posts the temp dir payload", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, hasOpenclawSetup: true }));
    const api = await loadApiModule();

    const result = await api.scanImportRepo("/tmp/alphaclaw-import-1234");

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/onboard/import/scan",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ tempDir: "/tmp/alphaclaw-import-1234" }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, hasOpenclawSetup: true });
  });

  it("applyImport posts import approval payload", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(200, {
        ok: true,
        envVarsImported: 2,
        placeholderReview: {
          found: true,
          count: 1,
          vars: [{ key: "SLACK_BOT_TOKEN", status: "missing" }],
        },
      }),
    );
    const api = await loadApiModule();

    const result = await api.applyImport({
      tempDir: "/tmp/alphaclaw-import-1234",
      approvedSecrets: [{ suggestedEnvVar: "OPENAI_API_KEY", value: "sk-123" }],
      skipSecretExtraction: false,
      githubRepo: "owner/target-repo",
      githubToken: "ghp_123",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/onboard/import/apply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          tempDir: "/tmp/alphaclaw-import-1234",
          approvedSecrets: [{ suggestedEnvVar: "OPENAI_API_KEY", value: "sk-123" }],
          skipSecretExtraction: false,
          githubRepo: "owner/target-repo",
          githubToken: "ghp_123",
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({
      ok: true,
      envVarsImported: 2,
      placeholderReview: {
        found: true,
        count: 1,
        vars: [{ key: "SLACK_BOT_TOKEN", status: "missing" }],
      },
    });
  });

  it("saveEnvVars uses PUT with expected request body", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, changed: true }));
    const api = await loadApiModule();
    const vars = [{ key: "GITHUB_TOKEN", value: "ghp_123" }];

    const result = await api.saveEnvVars(vars);

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/env",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ vars }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, changed: true });
  });

  it("saveEnvVars throws server error on non-OK response", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(400, { error: "Reserved env var" }));
    const api = await loadApiModule();

    await expect(api.saveEnvVars([{ key: "PORT", value: "3000" }])).rejects.toThrow(
      "Reserved env var",
    );
  });

  it("fetchOnboardStatus rejects on a JSON-bodied 5xx instead of resolving it as data (F141)", async () => {
    // A proxy 502 / the server's JSON error middleware used to resolve as
    // `{ error }`, which the shell read as `onboarded: false` — dropping an
    // onboarded operator into the Welcome wizard.
    global.fetch.mockResolvedValue(mockJsonResponse(502, { error: "upstream unavailable" }));
    const api = await loadApiModule();
    await expect(api.fetchOnboardStatus()).rejects.toThrow("upstream unavailable");

    global.fetch.mockResolvedValue(mockJsonResponse(500, {}));
    await expect(api.fetchOnboardStatus()).rejects.toThrow(
      "Could not load onboarding status (HTTP 500)",
    );

    global.fetch.mockResolvedValue(mockJsonResponse(200, { onboarded: true }));
    await expect(api.fetchOnboardStatus()).resolves.toEqual({ onboarded: true });
  });

  it("approveDevice encodes ids and throws API errors", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(403, { ok: false, error: "missing scope" }));
    const api = await loadApiModule();

    await expect(api.approveDevice("req/admin 1")).rejects.toThrow("missing scope");

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/devices/req%2Fadmin%201/approve",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
  });

  it("fetchAutotune calls the autotune ledger endpoint", async () => {
    const payload = { ok: true, ledger: { enabled: true, rows: [] } };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await loadApiModule();

    const result = await api.fetchAutotune();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/autotune",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual(payload);
  });

  it("updateAutotuneSettings PUTs the settings body and surfaces server errors", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(200, { ok: true, changed: true }),
    );
    const api = await loadApiModule();
    const body = { enabled: true, overrides: { gatewayHeapMb: 4096 } };

    await api.updateAutotuneSettings(body);

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/autotune/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify(body),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");

    global.fetch.mockResolvedValue(
      mockJsonResponse(400, { ok: false, error: "gatewayHeapMb out of range" }),
    );
    await expect(api.updateAutotuneSettings(body)).rejects.toThrow(
      "gatewayHeapMb out of range",
    );
  });

  it("reapplyAutotune posts to the reapply endpoint", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(200, { ok: true, ledger: { rows: [] } }),
    );
    const api = await loadApiModule();

    await api.reapplyAutotune();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/autotune/reapply",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("acknowledgeAutotuneResize PUTs the resize-ack endpoint", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(200, { ok: true, acknowledged: true }),
    );
    const api = await loadApiModule();

    await api.acknowledgeAutotuneResize();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/autotune/resize-ack",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("fetchUsageSummary calls usage summary endpoint", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, summary: { daily: [] } }));
    const api = await loadApiModule();

    const result = await api.fetchUsageSummary(90);

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/usage/summary?days=90",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, summary: { daily: [] } });
  });

  it("fetchUsageSessions calls usage sessions endpoint", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, sessions: [] }));
    const api = await loadApiModule();

    const result = await api.fetchUsageSessions(100);

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/usage/sessions?limit=100",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, sessions: [] });
  });

  it("fetchDoctorStatus calls Doctor status endpoint", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, status: { stale: true } }));
    const api = await loadApiModule();

    const result = await api.fetchDoctorStatus();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/doctor/status",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, status: { stale: true } });
  });

  it("fetchDoctorCards calls aggregated Doctor cards endpoint", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, cards: [] }));
    const api = await loadApiModule();

    const result = await api.fetchDoctorCards({ runId: "all" });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/doctor/cards?runId=all",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, cards: [] });
  });

  it("startDoctorRun posts to the Doctor run endpoint", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(202, { ok: true, runId: 42 }));
    const api = await loadApiModule();

    const result = await api.startDoctorRun();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/doctor/run",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, runId: 42 });
  });

  it("startDoctorRun surfaces gateway unavailability from a 503", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(503, {
        ok: false,
        gatewayUnavailable: true,
        reason: "gateway is restarting",
        error: "Gateway not ready",
      }),
    );
    const api = await loadApiModule();

    await expect(api.startDoctorRun()).rejects.toMatchObject({
      message: "Gateway not ready",
      gatewayUnavailable: true,
      reason: "gateway is restarting",
    });
  });

  it("fetchDoctorSettings calls the Doctor settings endpoint", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(200, { ok: true, settings: { autoRunEnabled: true } }),
    );
    const api = await loadApiModule();

    const result = await api.fetchDoctorSettings();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/doctor/settings",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, settings: { autoRunEnabled: true } });
  });

  it("updateDoctorSettings puts the autoRun flag", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(200, { ok: true, settings: { autoRunEnabled: false } }),
    );
    const api = await loadApiModule();

    const result = await api.updateDoctorSettings({ autoRunEnabled: false });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/doctor/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ autoRunEnabled: false }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, settings: { autoRunEnabled: false } });
  });

  it("updateDoctorSettings narrows the PUT body to the fields provided", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, settings: {} }));
    const api = await loadApiModule();

    // Scan-only body: autoRunEnabled must NOT ride along (a stale local copy
    // of a sibling field must never be written back).
    await api.updateDoctorSettings({ scan: { maxFiles: 300000 } });
    expect(global.fetch).toHaveBeenLastCalledWith(
      "/api/doctor/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ scan: { maxFiles: 300000 } }),
      }),
    );

    // Toggle-only body: scan must not ride along.
    await api.updateDoctorSettings({ autoRunEnabled: true });
    expect(global.fetch).toHaveBeenLastCalledWith(
      "/api/doctor/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ autoRunEnabled: true }),
      }),
    );
  });

  it("does not expose an importDoctorResult client (server route only)", async () => {
    const api = await loadApiModule();
    expect(api.importDoctorResult).toBeUndefined();
  });

  it("fetchUsageSessionDetail encodes session id in path", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, detail: { sessionId: "x" } }));
    const api = await loadApiModule();

    const result = await api.fetchUsageSessionDetail("agent:main:telegram:group:-1:topic:2");

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/usage/sessions/agent%3Amain%3Atelegram%3Agroup%3A-1%3Atopic%3A2",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, detail: { sessionId: "x" } });
  });

  it("sendDoctorCardFix posts delivery fields", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, stdout: "sent" }));
    const api = await loadApiModule();

    const result = await api.sendDoctorCardFix({
      cardId: 7,
      sessionKey: "agent:main:telegram:direct:1050",
      replyChannel: "telegram",
      replyTo: "1050",
      prompt: "Use a more focused fix request",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/doctor/findings/7/fix",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sessionKey: "agent:main:telegram:direct:1050",
          replyChannel: "telegram",
          replyTo: "1050",
          prompt: "Use a more focused fix request",
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, stdout: "sent" });
  });

  it("createWebhook posts optional destination fields", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(201, { ok: true, webhook: { name: "gmail" } }));
    const api = await loadApiModule();

    const result = await api.createWebhook("gmail-alerts", {
      destination: {
        channel: "telegram",
        to: "-1003709908795:4011",
      },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/webhooks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "gmail-alerts",
          destination: {
            channel: "telegram",
            to: "-1003709908795:4011",
          },
          oauthCallback: false,
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, webhook: { name: "gmail" } });
  });

  it("updateWebhookDestination puts destination fields", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, webhook: { name: "gmail-alerts" } }));
    const api = await loadApiModule();

    const result = await api.updateWebhookDestination("gmail-alerts", {
      destination: {
        channel: "telegram",
        to: "1050",
        agentId: "main",
      },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/webhooks/gmail-alerts/destination",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          destination: {
            channel: "telegram",
            to: "1050",
            agentId: "main",
          },
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, webhook: { name: "gmail-alerts" } });
  });

  it("startGmailWatch posts optional destination fields", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, accountId: "acct-1" }));
    const api = await loadApiModule();

    const result = await api.startGmailWatch("acct-1", {
      destination: {
        channel: "telegram",
        to: "1050",
      },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/gmail/watch/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          accountId: "acct-1",
          destination: {
            channel: "telegram",
            to: "1050",
          },
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, accountId: "acct-1" });
  });

  it("syncBrowseChanges posts commit message", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, committed: true }));
    const api = await loadApiModule();

    const result = await api.syncBrowseChanges("sync changes");

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/browse/git-sync",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "sync changes" }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, committed: true });
  });

  it("fetchBrowseTree defaults to a bounded tree depth", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, tree: [] }));
    const api = await loadApiModule();

    const result = await api.fetchBrowseTree();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/browse/tree?depth=3",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, tree: [] });
  });

  it("fetchBrowseTree requests a folder subtree by path", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, root: {} }));
    const api = await loadApiModule();

    const result = await api.fetchBrowseTree({
      path: "workspace/hooks/bootstrap",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/browse/tree?depth=3&path=workspace%2Fhooks%2Fbootstrap",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, root: {} });
  });

  it("fetchBrowseTree preserves numeric depth calls", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, root: {} }));
    const api = await loadApiModule();

    const result = await api.fetchBrowseTree(2);

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/browse/tree?depth=2",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, root: {} });
  });

  it("fetchBrowseFileDiff calls git diff endpoint with encoded path", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, content: "diff --git" }));
    const api = await loadApiModule();

    const result = await api.fetchBrowseFileDiff("workspace/hooks/bootstrap/AGENTS.md");

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/browse/git-diff?path=workspace%2Fhooks%2Fbootstrap%2FAGENTS.md",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, content: "diff --git" });
  });

  it("downloadBrowseFile calls download endpoint and triggers browser download", async () => {
    const fileBlob = new Blob(["test"], { type: "text/plain" });
    const createObjectURL = vi.fn(() => "blob:test-url");
    const revokeObjectURL = vi.fn();
    global.window.URL = { createObjectURL, revokeObjectURL };
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    global.document = {
      createElement: vi.fn((tagName) =>
        tagName === "a"
          ? {
              href: "",
              download: "",
              click,
              remove,
            }
          : {},
      ),
      body: { appendChild },
    };
    global.fetch.mockResolvedValue({
      status: 200,
      ok: true,
      blob: async () => fileBlob,
      text: async () => "",
    });
    const api = await loadApiModule();

    const result = await api.downloadBrowseFile("workspace/file.txt");

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/browse/download?path=workspace%2Ffile.txt",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(createObjectURL).toHaveBeenCalledWith(fileBlob);
    expect(appendChild).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-url");
    expect(result).toEqual({ ok: true });
  });

  it("createChannelAccount posts provider, token, and agent binding fields", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(201, {
        ok: true,
        channel: "telegram",
        account: { id: "alerts", envKey: "TELEGRAM_BOT_TOKEN_ALERTS" },
      }),
    );
    const api = await loadApiModule();

    const result = await api.createChannelAccount({
      provider: "telegram",
      name: "Alerts",
      accountId: "alerts",
      token: "123:abc",
      agentId: "ops",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/channels/accounts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          provider: "telegram",
          name: "Alerts",
          accountId: "alerts",
          token: "123:abc",
          agentId: "ops",
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({
      ok: true,
      channel: "telegram",
      account: { id: "alerts", envKey: "TELEGRAM_BOT_TOKEN_ALERTS" },
    });
  });

  it("updateChannelAccount posts editable channel fields", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(200, {
        ok: true,
        channel: "telegram",
        account: { id: "alerts", name: "Alerts Bot", boundAgentId: "main" },
      }),
    );
    const api = await loadApiModule();

    const result = await api.updateChannelAccount({
      provider: "telegram",
      accountId: "alerts",
      name: "Alerts Bot",
      agentId: "main",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/channels/accounts",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          provider: "telegram",
          accountId: "alerts",
          name: "Alerts Bot",
          agentId: "main",
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({
      ok: true,
      channel: "telegram",
      account: { id: "alerts", name: "Alerts Bot", boundAgentId: "main" },
    });
  });

  it("deleteChannelAccount sends provider and account id", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true }));
    const api = await loadApiModule();

    const result = await api.deleteChannelAccount({
      provider: "telegram",
      accountId: "alerts",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/channels/accounts",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({
          provider: "telegram",
          accountId: "alerts",
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true });
  });

  it("resumeWatchdogChannels posts to the resume endpoint and returns the result", async () => {
    const payload = {
      ok: true,
      result: { ok: true, results: [{ channel: "telegram", ok: true }] },
    };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await loadApiModule();

    const result = await api.resumeWatchdogChannels();

    const [url, options] = global.fetch.mock.calls.at(-1);
    expect(url).toBe("/api/watchdog/resume-channels");
    expect(options.method).toBe("POST");
    expect(result).toEqual(payload);
  });

  it("fetchWatchdogOverseerSituation returns the situation payload and rejects on the not_wired 503", async () => {
    const payload = { ok: true, current: null, lastVerdict: null, nextManualAt: 0, inFlight: false };
    global.fetch.mockResolvedValueOnce(mockJsonResponse(200, payload));
    const api = await loadApiModule();
    await expect(api.fetchWatchdogOverseerSituation()).resolves.toEqual(payload);
    expect(global.fetch.mock.calls[0][0]).toBe("/api/watchdog/overseer/situation");

    global.fetch.mockResolvedValueOnce(
      mockJsonResponse(503, { ok: false, error: "not_wired" }),
    );
    await expect(api.fetchWatchdogOverseerSituation()).rejects.toThrow("not_wired");
  });

  it("requestWatchdogOverseerReview prefers the human message on a refusal envelope", async () => {
    global.fetch.mockResolvedValueOnce(
      mockJsonResponse(429, {
        ok: false,
        error: "rate_limited",
        message: "Manual reviews are limited to one every 2 minutes — try again in about 1m.",
      }),
    );
    const api = await loadApiModule();
    await expect(api.requestWatchdogOverseerReview()).rejects.toThrow(
      "Manual reviews are limited to one every 2 minutes — try again in about 1m.",
    );
  });

  it("resumeWatchdogChannels surfaces server error messages", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(409, { ok: false, error: "no_suppressed_channels" }),
    );
    const api = await loadApiModule();

    await expect(api.resumeWatchdogChannels()).rejects.toThrow(
      "no_suppressed_channels",
    );
  });

  it("restartGatewayAsync resolves the 202 {operationId} envelope from the async endpoint", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(202, { ok: true, operationId: "op-1", events: true }),
    );
    const api = await loadApiModule();

    const result = await api.restartGatewayAsync();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/gateway/restart?async=1",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual({ ok: true, operationId: "op-1", events: true });
  });

  it("sends an empty restart body by default and preserves skipped/refusal recovery", async () => {
    const api = await loadApiModule();
    global.fetch.mockResolvedValue(mockJsonResponse(202, { ok: true, operationId: "restart-1" }));
    await api.restartGatewayAsync();
    expect(JSON.parse(global.fetch.mock.calls.at(-1)[1].body)).toEqual({});
    const recovery = { disposition: "inspect", resolution: "diagnose" };
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: false, skipped: true, code: "restart_refused", recovery }));
    await expect(api.restartGatewayAsync()).rejects.toMatchObject({ notStarted: true, code: "restart_refused", recovery });
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, skipped: true, reason: "busy", recovery }));
    await expect(api.triggerWatchdogRepair()).rejects.toMatchObject({ notStarted: false, responseReceived: true, recovery });
  });

  it("does not infer that Doctor never ran from a repair 409 or a skipped result", async () => {
    const api = await loadApiModule();
    for (const status of [200, 409]) {
      global.fetch.mockResolvedValue(mockJsonResponse(status, { ok: false, code: "relaunch_refused", message: "Doctor completed, but the relaunch was refused", result: { skipped: true, reason: "relaunch_refused" } }));
      await expect(api.triggerWatchdogRepair()).rejects.toMatchObject({ notStarted: false, responseReceived: true, message: "Doctor completed, but the relaunch was refused" });
    }
    global.fetch.mockResolvedValue(mockJsonResponse(409, { ok: false, notStarted: true, error: "Admission refused before Doctor" }));
    await expect(api.triggerWatchdogRepair()).rejects.toMatchObject({ notStarted: true });
  });

  it("does not turn an unusable successful restart response into success or safe refusal", async () => {
    const api = await loadApiModule();
    global.fetch.mockResolvedValue(mockJsonResponse(200, {}));
    const error = await api.restartGatewayAsync().catch((error) => error);
    expect(error.message).toContain("result unknown");
    expect(error.notStarted).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("restartGatewayAsync rejects 409 operation_in_progress with code+status, and unparseable bodies with the fallback message", async () => {
    // 409 envelope: the controller branches on err.code, so the code and
    // HTTP status must ride on the rejection.
    global.fetch.mockResolvedValue(
      mockJsonResponse(409, {
        ok: false,
        error: "Another gateway operation is in progress",
        code: "operation_in_progress",
      }),
    );
    const api = await loadApiModule();
    await expect(api.restartGatewayAsync()).rejects.toMatchObject({
      message: "Another gateway operation is in progress",
      code: "operation_in_progress",
      status: 409,
    });

    // Unparseable body on a failed response: fallback message, status kept,
    // no code invented.
    global.fetch.mockResolvedValue({
      status: 500,
      ok: false,
      json: async () => {
        throw new Error("bad json");
      },
    });
    const rejection = await api.restartGatewayAsync().catch((err) => err);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toBe("Could not restart gateway");
    expect(rejection.status).toBe(500);
    expect(rejection.code).toBeUndefined();
  });
});

const mockTextResponse = (status, text) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => text,
});

class FakeEventSource {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.listeners = new Map();
    this.closed = false;
    this.onopen = undefined;
    this.onerror = undefined;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    const handlers = (this.listeners.get(type) || []).filter(
      (entry) => entry !== handler,
    );
    this.listeners.set(type, handlers);
  }

  close() {
    this.closed = true;
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
}

describe("frontend/api endpoint wrapper coverage", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue(mockJsonResponse(200, { ok: true }));
    global.window = { location: { href: "http://localhost/" } };
  });

  afterEach(() => {
    delete global.fetch;
    delete global.window;
  });

  const kWrapperCases = [
    ["fetchPairings", [], "/api/pairings", undefined],
    ["approvePairing", ["p1", "telegram", "acct"], "/api/pairings/p1/approve", "POST"],
    ["rejectPairing", ["p1", "telegram"], "/api/pairings/p1/reject", "POST"],
    ["fetchGoogleAccounts", [], "/api/google/accounts", undefined],
    ["fetchGoogleCredentials", [], "/api/google/credentials", undefined],
    [
      "fetchGoogleCredentials",
      [{ accountId: "a", client: "gmail" }],
      "/api/google/credentials?accountId=a&client=gmail",
      undefined,
    ],
    ["checkGoogleApis", ["a"], "/api/google/check?accountId=a", undefined],
    [
      "saveGoogleCredentials",
      [{ clientId: "id", clientSecret: "sec", email: "e@x.com" }],
      "/api/google/credentials",
      "POST",
    ],
    ["saveGoogleAccount", [{ email: "e@x.com" }], "/api/google/accounts", "POST"],
    ["disconnectGoogle", ["a"], "/api/google/disconnect", "POST"],
    ["fetchGmailConfig", [], "/api/gmail/config", undefined],
    ["saveGmailConfig", [], "/api/gmail/config", "POST"],
    ["startGmailWatch", ["acct"], "/api/gmail/watch/start", "POST"],
    ["stopGmailWatch", ["acct"], "/api/gmail/watch/stop", "POST"],
    ["renewGmailWatch", [], "/api/gmail/watch/renew", "POST"],
    ["fetchAgentSessions", [], "/api/agent/sessions", undefined],
    ["fetchDoctorRuns", [5], "/api/doctor/runs?limit=5", undefined],
    ["fetchDoctorCards", [{ runId: "" }], "/api/doctor/cards", undefined],
    [
      "updateDoctorCardStatus",
      [{ cardId: "c1", status: "resolved" }],
      "/api/doctor/cards/c1/status",
      "POST",
    ],
    ["sendAgentMessage", [{ message: "hi", sessionKey: "k" }], "/api/agent/message", "POST"],
    ["sendAgentMessage", [], "/api/agent/message", "POST"],
    ["sendDoctorCardFix", [], "/api/doctor/findings//fix", "POST"],
    ["fetchRestartStatus", [], "/api/restart-status", undefined],
    ["dismissRestartStatus", [], "/api/restart-status/dismiss", "POST"],
    ["fetchWatchdogStatus", [], "/api/watchdog/status", undefined],
    ["fetchUsageSummary", [], "/api/usage/summary?days=30", undefined],
    ["fetchUsageSessions", [], "/api/usage/sessions?limit=50", undefined],
    ["fetchWatchdogEvents", [], "/api/watchdog/events?limit=20", undefined],
    ["closeWatchdogTerminalSession", ["s1"], "/api/watchdog/terminal/close", "POST"],
    ["triggerWatchdogRepair", [], "/api/watchdog/repair", "POST"],
    ["fetchWatchdogResources", [], "/api/watchdog/resources", undefined],
    ["fetchWatchdogOverseer", [], "/api/watchdog/overseer", undefined],
    ["updateWatchdogOverseer", [true], "/api/watchdog/overseer", "PUT"],
    ["requestWatchdogOverseerReview", [], "/api/watchdog/overseer/review", "POST"],
    [
      "requestWatchdogOverseerReview",
      [{ incidentId: 12 }],
      "/api/watchdog/overseer/review",
      "POST",
    ],
    ["fetchWatchdogOverseerSituation", [], "/api/watchdog/overseer/situation", undefined],
    ["fetchWatchdogSettings", [], "/api/watchdog/settings", undefined],
    ["updateWatchdogSettings", [{ enabled: true }], "/api/watchdog/settings", "PUT"],
    ["updateWatchdogSettings", [null], "/api/watchdog/settings", "PUT"],
    ["fetchWatchdogMemorySettings", [], "/api/watchdog/memory", undefined],
    [
      "updateWatchdogMemorySettings",
      [{ enabled: true }],
      "/api/watchdog/memory",
      "PUT",
    ],
    [
      "updateWatchdogMemorySettings",
      [{ autoRestart: false }],
      "/api/watchdog/memory",
      "PUT",
    ],
    ["fetchAlphaclawVersion", [], "/api/alphaclaw/version", undefined],
    ["fetchAlphaclawVersion", [true], "/api/alphaclaw/version?refresh=1", undefined],
    ["updateAlphaclaw", [], "/api/alphaclaw/update", "POST"],
    ["updateSyncCron", [{ schedule: "0 0 * * *" }], "/api/sync-cron", "PUT"],
    [
      "updateOpenAiCompatApiFeature",
      [true],
      "/api/alphaclaw/config/features/openai-compat-api",
      "PUT",
    ],
    ["fetchCronJobs", [], "/api/cron/jobs?sortBy=nextRunAtMs&sortDir=asc", undefined],
    ["fetchCronJobs", [{ sortBy: "", sortDir: "" }], "/api/cron/jobs", undefined],
    ["fetchCronStatus", [], "/api/cron/status", undefined],
    [
      "fetchCronJobRuns",
      ["j1"],
      "/api/cron/jobs/j1/runs?limit=20&offset=0&status=all&deliveryStatus=all&sortDir=desc",
      undefined,
    ],
    [
      "fetchCronJobRuns",
      ["j1", { query: " find me " }],
      "/api/cron/jobs/j1/runs?limit=20&offset=0&status=all&deliveryStatus=all&sortDir=desc&query=find+me",
      undefined,
    ],
    ["fetchCronJobUsage", ["j1"], "/api/cron/jobs/j1/usage?days=30", undefined],
    ["fetchCronJobTrends", ["j1"], "/api/cron/jobs/j1/trends?range=7d", undefined],
    ["fetchCronBulkUsage", [], "/api/cron/usage/bulk?days=30", undefined],
    [
      "fetchCronBulkRuns",
      [],
      "/api/cron/runs/bulk?sinceMs=0&limitPerJob=20&status=all&deliveryStatus=all&sortDir=desc",
      undefined,
    ],
    ["triggerCronJobRun", ["j1"], "/api/cron/jobs/j1/run", "POST"],
    ["setCronJobEnabled", ["j1", true], "/api/cron/jobs/j1/enable", "POST"],
    ["setCronJobEnabled", ["j1", false], "/api/cron/jobs/j1/disable", "POST"],
    ["updateCronJobPrompt", ["j1", "new prompt"], "/api/cron/jobs/j1/prompt", "PUT"],
    ["updateCronJobRouting", ["j1"], "/api/cron/jobs/j1/routing", "PUT"],
    ["fetchDevicePairings", [], "/api/devices", undefined],
    ["rejectDevice", ["d1"], "/api/devices/d1/reject", "POST"],
    ["fetchNodesStatus", [], "/api/nodes", undefined],
    ["removeNode", ["n1"], "/api/nodes/n1", "DELETE"],
    ["routeExecToNode", ["n1"], "/api/nodes/n1/route", "POST"],
    ["fetchNodeConnectInfo", [], "/api/nodes/connect-info", undefined],
    [
      "fetchNodeBrowserStatusForNode",
      ["n1"],
      "/api/nodes/n1/browser-status?profile=user",
      undefined,
    ],
    ["fetchNodeExecConfig", [], "/api/nodes/exec-config", undefined],
    ["saveNodeExecConfig", [{ security: "allowlist" }], "/api/nodes/exec-config", "POST"],
    ["fetchNodeExecApprovals", [], "/api/nodes/exec-approvals", undefined],
    [
      "addNodeExecAllowlistPattern",
      ["npm run *"],
      "/api/nodes/exec-approvals/allowlist",
      "POST",
    ],
    [
      "removeNodeExecAllowlistPattern",
      ["e1"],
      "/api/nodes/exec-approvals/allowlist/e1",
      "DELETE",
    ],
    ["fetchAuthStatus", [], "/api/auth/status", undefined],
    ["logout", [], "/api/auth/logout", "POST"],
    ["fetchOnboardStatus", [], "/api/onboard/status", undefined],
    ["fetchModels", [], "/api/models", undefined],
    ["fetchModelStatus", [], "/api/models/status", undefined],
    [
      "fetchThinkingOptions",
      ["anthropic/claude"],
      "/api/models/thinking-options?modelKey=anthropic%2Fclaude",
      undefined,
    ],
    ["setPrimaryModel", ["k1"], "/api/models/set", "POST"],
    ["fetchModelsConfig", [], "/api/models/config", undefined],
    ["fetchModelsConfig", [{ agentId: "a1" }], "/api/models/config?agentId=a1", undefined],
    ["saveModelsConfig", [], "/api/models/config", "PUT"],
    [
      "saveModelsConfig",
      [{ agentId: "a1", primary: "k" }],
      "/api/models/config?agentId=a1",
      "PUT",
    ],
    ["fetchAgents", [], "/api/agents", undefined],
    ["getTelegramTopics", [], "/api/telegram/topics", undefined],
    [
      "restoreTelegramTopic",
      ["-100123", "42"],
      "/api/telegram/groups/-100123/topics/42/restore",
      "POST",
    ],
    [
      "verifyTelegramTopic",
      ["-100123", "42"],
      "/api/telegram/groups/-100123/topics/42/verify",
      "POST",
    ],
    ["sweepTopicDiscovery", [], "/api/telegram/discovery/sweep", "POST"],
    ["fetchChannelAccounts", [], "/api/channels/accounts", undefined],
    [
      "fetchChannelAccountToken",
      [{ provider: "telegram" }],
      "/api/channels/accounts/token?provider=telegram&accountId=default",
      undefined,
    ],
    [
      "fetchChannelAccountToken",
      [],
      "/api/channels/accounts/token?provider=&accountId=default",
      undefined,
    ],
    ["createChannelAccountJob", [{ provider: "telegram" }], "/api/channels/accounts/jobs", "POST"],
    ["runChannelAccountLogin", [{ provider: "whatsapp" }], "/api/channels/accounts/login", "POST"],
    [
      "fetchChannelAccountLoginStatus",
      [{ provider: "whatsapp" }],
      "/api/channels/accounts/login-status?provider=whatsapp&accountId=default",
      undefined,
    ],
    [
      "fetchChannelAccountLoginStatus",
      [],
      "/api/channels/accounts/login-status?provider=&accountId=default",
      undefined,
    ],
    ["fetchAgentWorkspaceSize", ["a1"], "/api/agents/a1/workspace-size", undefined],
    ["fetchAgentBindings", ["a1"], "/api/agents/a1/bindings", undefined],
    ["createAgent", [{ name: "Ops" }], "/api/agents", "POST"],
    ["updateAgent", ["a1", { name: "Ops" }], "/api/agents/a1", "PUT"],
    ["deleteAgent", ["a1"], "/api/agents/a1?keepWorkspace=true", "DELETE"],
    [
      "deleteAgent",
      ["a1", { keepWorkspace: false }],
      "/api/agents/a1?keepWorkspace=false",
      "DELETE",
    ],
    ["setDefaultAgent", ["a1"], "/api/agents/a1/default", "POST"],
    ["fetchCodexStatus", [], "/api/codex/status", undefined],
    ["disconnectCodex", [], "/api/codex/disconnect", "POST"],
    ["exchangeCodexOAuth", ["code-1"], "/api/codex/exchange", "POST"],
    ["fetchEnvVars", [], "/api/env", undefined],
    ["saveEnvVars", [[{ key: "A", value: "1" }]], "/api/env", "PUT"],
    ["fetchWebhooks", [], "/api/webhooks", undefined],
    ["fetchWebhookDetail", ["hook"], "/api/webhooks/hook", undefined],
    ["createWebhook", ["hook"], "/api/webhooks", "POST"],
    ["deleteWebhook", ["hook"], "/api/webhooks/hook", "DELETE"],
    ["updateWebhookDestination", ["hook"], "/api/webhooks/hook/destination", "PUT"],
    ["rotateWebhookOauthCallback", ["hook"], "/api/webhooks/hook/oauth-callback/rotate", "POST"],
    [
      "fetchWebhookRequests",
      ["hook"],
      "/api/webhooks/hook/requests?limit=50&offset=0&status=all",
      undefined,
    ],
    ["fetchWebhookRequest", ["hook", 3], "/api/webhooks/hook/requests/3", undefined],
    ["fetchFileContent", ["notes/a.txt"], "/api/browse/read?path=notes%2Fa.txt", undefined],
    ["saveFileContent", ["notes/a.txt", "hello"], "/api/browse/write", "PUT"],
    ["saveFileContent", ["notes/a.txt", null], "/api/browse/write", "PUT"],
    ["createBrowseFile", ["notes/new.txt"], "/api/browse/create-file", "POST"],
    ["createBrowseFolder", ["notes/dir"], "/api/browse/create-folder", "POST"],
    ["moveBrowsePath", ["a.txt", "b.txt"], "/api/browse/move", "POST"],
    ["deleteBrowseFile", ["a.txt"], "/api/browse/delete", "DELETE"],
    ["restoreBrowseFile", ["a.txt"], "/api/browse/restore", "POST"],
    ["fetchBrowseGitSummary", [], "/api/browse/git-summary", undefined],
    [
      "fetchBrowseSqliteTable",
      [{ filePath: "db.sqlite", table: "runs" }],
      "/api/browse/sqlite-table?path=db.sqlite&table=runs&limit=50&offset=0",
      undefined,
    ],
  ];

  it.each(kWrapperCases)(
    "%s requests %s",
    async (name, args, expectedUrl, method) => {
      const api = await loadApiModule();

      const result = await api[name](...args);

      const [calledUrl, options = {}] = global.fetch.mock.calls[0];
      expect(calledUrl).toBe(expectedUrl);
      expect(options.method).toBe(method);
      expect(options.headers).toBeInstanceOf(Headers);
      expect(result).toEqual({ ok: true });
    },
  );
});

describe("frontend/api behaviors", () => {
  const kRealIntl = global.Intl;

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue(mockJsonResponse(200, { ok: true }));
    global.window = { location: { href: "http://localhost/" } };
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    global.Intl = kRealIntl;
    delete global.fetch;
    delete global.window;
    delete global.document;
  });

  it("authFetch attaches the browser timezone header", async () => {
    const api = await loadApiModule();

    const res = await api.authFetch("/api/ping");

    expect(res.status).toBe(200);
    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers.get("x-client-timezone")).toBe(
      new Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it("authFetch keeps a caller-provided timezone header", async () => {
    const api = await loadApiModule();

    await api.authFetch("/api/ping", {
      headers: { "x-client-timezone": "UTC" },
    });

    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers.get("x-client-timezone")).toBe("UTC");
  });

  it("authFetch keeps the module-load timezone even if Intl breaks later (memoized)", async () => {
    // getBrowserTimeZone is memoized in format.js at module load so the header
    // always matches the zone the display formatters captured — a runtime Intl
    // failure (or OS tz change) must NOT change the header mid-session.
    const api = await loadApiModule();
    const expected = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    global.Intl = {
      DateTimeFormat: () => {
        throw new Error("boom");
      },
    };

    await api.authFetch("/api/ping");

    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers.get("x-client-timezone")).toBe(expected);
  });

  it("authFetch omits the timezone header when the browser zone is unknown", async () => {
    vi.resetModules();
    vi.doMock("../../lib/public/js/lib/format.js", () => ({
      getBrowserTimeZone: () => "",
    }));
    try {
      const api = await import("../../lib/public/js/lib/api.js");

      await api.authFetch("/api/ping");

      const headers = global.fetch.mock.calls[0][1].headers;
      expect(headers.get("x-client-timezone")).toBe(null);
    } finally {
      vi.doUnmock("../../lib/public/js/lib/format.js");
      vi.resetModules();
    }
  });

  it("still redirects on 401 when localStorage.clear throws", async () => {
    global.window.localStorage = {
      clear: () => {
        throw new Error("denied");
      },
    };
    global.fetch.mockResolvedValue(mockJsonResponse(401, {}));
    const api = await loadApiModule();

    await expect(api.fetchStatus()).rejects.toThrow("Unauthorized");
    expect(window.location.href).toBe("/setup");
  });

  it("subscribeStatusEvents throws when EventSource is unavailable", async () => {
    const api = await loadApiModule();

    expect(() => api.subscribeStatusEvents()).toThrow(
      "Server events are not supported in this browser",
    );
  });

  it("subscribeStatusEvents wires status events and unsubscribes", async () => {
    global.window.EventSource = FakeEventSource;
    const api = await loadApiModule();
    const events = [];
    const onOpen = vi.fn();
    const onError = vi.fn();

    const unsubscribe = api.subscribeStatusEvents({
      onMessage: (payload) => events.push(payload),
      onOpen,
      onError,
    });

    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/events/status");
    expect(source.options).toEqual({ withCredentials: true });

    source.emit("status", { data: JSON.stringify({ gateway: "running" }) });
    source.emit("status", { data: "not json" });
    source.emit("status", { data: "null" });
    source.emit("status", {});
    source.onopen();
    source.onerror("err");

    expect(events).toEqual([{ gateway: "running" }, {}, {}, {}]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("err");

    unsubscribe();
    expect(source.closed).toBe(true);
    expect(source.onopen).toBe(null);
    expect(source.onerror).toBe(null);
    source.emit("status", { data: "{}" });
    expect(events).toHaveLength(4);
  });

  it("subscribeStatusEvents defaults its callbacks to no-ops", async () => {
    global.window.EventSource = FakeEventSource;
    const api = await loadApiModule();

    const unsubscribe = api.subscribeStatusEvents({});

    const source = FakeEventSource.instances[0];
    expect(() => {
      source.emit("status", { data: "{}" });
      source.onopen();
      source.onerror("err");
    }).not.toThrow();
    unsubscribe();
  });

  it("subscribeOperationEvents subscribes to the operation SSE stream", async () => {
    global.window.EventSource = FakeEventSource;
    const api = await loadApiModule();
    const messages = [];

    const unsubscribe = api.subscribeOperationEvents({
      operationId: "op 1",
      onMessage: (message) => messages.push(message),
    });

    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/operations/op%201/events");
    source.emit("phase", { data: JSON.stringify({ phase: "start" }) });
    expect(messages).toEqual([{ event: "phase", data: { phase: "start" } }]);
    unsubscribe();
    expect(source.closed).toBe(true);
  });

  it("getTelegramTopics returns degraded payloads with their code instead of throwing", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(503, {
        ok: false,
        error: "registry file is corrupt",
        code: "TOPIC_REGISTRY_UNREADABLE",
      }),
    );
    const api = await loadApiModule();

    const result = await api.getTelegramTopics();

    expect(result).toEqual({
      ok: false,
      error: "registry file is corrupt",
      code: "TOPIC_REGISTRY_UNREADABLE",
    });
  });

  it("verifyTelegramTopic returns the verify status payload", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(200, { ok: true, status: "stale" }),
    );
    const api = await loadApiModule();

    const result = await api.verifyTelegramTopic("-100123", 42);

    expect(global.fetch.mock.calls[0][0]).toBe(
      "/api/telegram/groups/-100123/topics/42/verify",
    );
    expect(result).toEqual({ ok: true, status: "stale" });
  });

  it("verifyTelegramTopic passes a named account through as ?accountId (F166) and omits the default", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, status: "ok" }));
    const api = await loadApiModule();
    await api.verifyTelegramTopic("-100123", 42, { accountId: "work" });
    expect(global.fetch.mock.calls[0][0]).toBe(
      "/api/telegram/groups/-100123/topics/42/verify?accountId=work",
    );
    await api.verifyTelegramTopic("-100123", 42, { accountId: "default" });
    expect(global.fetch.mock.calls[1][0]).toBe("/api/telegram/groups/-100123/topics/42/verify");
  });

  it("parseJsonOrThrow rejects when the payload marks ok false", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: false, error: "nope" }));
    const api = await loadApiModule();

    await expect(api.rejectPairing("p1", "telegram")).rejects.toThrow("nope");
  });

  it("parseJsonOrThrow resolves an empty body to an empty object", async () => {
    global.fetch.mockResolvedValue(mockTextResponse(200, ""));
    const api = await loadApiModule();

    await expect(api.rejectPairing("p1", "telegram")).resolves.toEqual({});
  });

  it("parseJsonOrThrow rejects with raw text for invalid JSON", async () => {
    global.fetch.mockResolvedValue(mockTextResponse(200, "garbage"));
    const api = await loadApiModule();

    await expect(api.rejectPairing("p1", "telegram")).rejects.toThrow("garbage");
  });

  it("parseJsonOrThrow falls back to HTTP status errors", async () => {
    global.fetch.mockResolvedValue(mockTextResponse(500, ""));
    const api = await loadApiModule();

    await expect(api.rejectPairing("p1", "telegram")).rejects.toThrow("HTTP 500");
  });

  it("fetchWatchdogLogs returns raw text", async () => {
    global.fetch.mockResolvedValue(mockTextResponse(200, "log text"));
    const api = await loadApiModule();

    await expect(api.fetchWatchdogLogs(1024)).resolves.toBe("log text");
    expect(global.fetch.mock.calls[0][0]).toBe("/api/watchdog/logs?tail=1024");
  });

  it("fetchWatchdogLogs throws on non-OK responses", async () => {
    global.fetch.mockResolvedValue(mockTextResponse(500, "boom"));
    const api = await loadApiModule();

    await expect(api.fetchWatchdogLogs()).rejects.toThrow(
      "Could not load watchdog logs",
    );
  });

  it("fetchWatchdogLogsDelta polls with the since=<gen>:<offset> cursor", async () => {
    const payload = { ok: true, gen: 3, offset: 2048, data: "new line\n", reset: false };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await loadApiModule();

    const result = await api.fetchWatchdogLogsDelta({ gen: 3, offset: 1024 });

    expect(global.fetch.mock.calls[0][0]).toBe(
      "/api/watchdog/logs?since=3%3A1024",
    );
    expect(result).toEqual(payload);
  });

  it("fetchWatchdogLogsDelta sends an invalid cursor when none is known", async () => {
    const payload = { ok: true, gen: 1, offset: 512, data: "fresh tail", reset: true };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await loadApiModule();

    const result = await api.fetchWatchdogLogsDelta();

    // -1:-1 is never a valid cursor, so the server bootstraps the client
    // with reset:true plus the fresh tail and the current cursor.
    expect(global.fetch.mock.calls[0][0]).toBe(
      "/api/watchdog/logs?since=-1%3A-1",
    );
    expect(result).toEqual(payload);
  });

  it("fetchWatchdogLogsDelta normalizes non-numeric cursor parts to -1", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(200, { ok: true, gen: 1, offset: 0, data: "", reset: true }),
    );
    const api = await loadApiModule();

    await api.fetchWatchdogLogsDelta({ gen: "junk", offset: null });

    expect(global.fetch.mock.calls[0][0]).toBe(
      "/api/watchdog/logs?since=-1%3A-1",
    );
  });

  it("fetchWatchdogLogsDelta throws on error responses", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(500, { ok: false, error: "log reader unavailable" }),
    );
    const api = await loadApiModule();

    await expect(api.fetchWatchdogLogsDelta({ gen: 1, offset: 0 })).rejects.toThrow(
      "log reader unavailable",
    );
  });

  it("routeExecToNode maps AbortError to a timeout message", async () => {
    global.fetch.mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    const api = await loadApiModule();

    await expect(api.routeExecToNode("n1")).rejects.toThrow(
      "Routing timed out. Gateway may be restarting or unavailable.",
    );
  });

  it("routeExecToNode rethrows other errors", async () => {
    global.fetch.mockRejectedValue(new Error("network down"));
    const api = await loadApiModule();

    await expect(api.routeExecToNode("n1")).rejects.toThrow("network down");
  });

  it("downloadBrowseFile throws with server error text", async () => {
    global.fetch.mockResolvedValue(mockTextResponse(404, "missing file"));
    const api = await loadApiModule();

    await expect(api.downloadBrowseFile("a.txt")).rejects.toThrow("missing file");
  });

  it("downloadBrowseFile throws when object URLs are unsupported", async () => {
    global.window.URL = { createObjectURL: null };
    global.fetch.mockResolvedValue({
      status: 200,
      ok: true,
      blob: async () => new Blob(["x"]),
      text: async () => "",
    });
    const api = await loadApiModule();

    await expect(api.downloadBrowseFile("a.txt")).rejects.toThrow(
      "Download is not supported in this browser",
    );
  });

  it("fetchAlphaclawReleaseNotes returns server release notes with a tag query", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, tag: "v1" }));
    const api = await loadApiModule();

    const result = await api.fetchAlphaclawReleaseNotes("v1");

    expect(global.fetch.mock.calls[0][0]).toBe("/api/alphaclaw/release-notes?tag=v1");
    expect(result).toEqual({ ok: true, tag: "v1" });
  });

  it("fetchAlphaclawReleaseNotes falls back to the GitHub tag endpoint", async () => {
    global.fetch
      .mockResolvedValueOnce(mockTextResponse(500, JSON.stringify({ error: "nope" })))
      .mockResolvedValueOnce(
        mockTextResponse(
          200,
          JSON.stringify({
            tag_name: "v2",
            name: "Release 2",
            body: "Notes",
            html_url: "https://example.com/v2",
            published_at: "2026-01-01T00:00:00Z",
          }),
        ),
      );
    const api = await loadApiModule();

    const result = await api.fetchAlphaclawReleaseNotes("v2");

    expect(global.fetch.mock.calls[1][0]).toBe(
      "https://api.github.com/repos/chrysb/alphaclaw/releases/tags/v2",
    );
    expect(result).toEqual({
      ok: true,
      tag: "v2",
      name: "Release 2",
      body: "Notes",
      htmlUrl: "https://example.com/v2",
      publishedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("fetchAlphaclawReleaseNotes falls back to the latest release endpoint", async () => {
    global.fetch
      .mockResolvedValueOnce(mockTextResponse(500, "boom"))
      .mockResolvedValueOnce(mockTextResponse(200, ""));
    const api = await loadApiModule();

    const result = await api.fetchAlphaclawReleaseNotes();

    expect(global.fetch.mock.calls[1][0]).toBe(
      "https://api.github.com/repos/chrysb/alphaclaw/releases/latest",
    );
    expect(result).toEqual({
      ok: true,
      tag: "",
      name: "",
      body: "",
      htmlUrl: "",
      publishedAt: "",
    });
  });

  it("fetchAlphaclawReleaseNotes surfaces raw fallback text errors", async () => {
    global.fetch
      .mockResolvedValueOnce(mockTextResponse(500, "boom"))
      .mockResolvedValueOnce(mockTextResponse(500, "oops"));
    const api = await loadApiModule();

    await expect(api.fetchAlphaclawReleaseNotes()).rejects.toThrow("oops");
  });

  it("fetchAlphaclawReleaseNotes surfaces GitHub error messages", async () => {
    global.fetch
      .mockResolvedValueOnce(mockTextResponse(500, "boom"))
      .mockResolvedValueOnce(
        mockTextResponse(403, JSON.stringify({ message: "rate limited" })),
      );
    const api = await loadApiModule();

    await expect(api.fetchAlphaclawReleaseNotes()).rejects.toThrow("rate limited");
  });


  it("updateSyncCron throws on invalid JSON and API errors", async () => {
    const api = await loadApiModule();

    global.fetch.mockResolvedValue(mockTextResponse(200, "garbage"));
    await expect(api.updateSyncCron({})).rejects.toThrow("garbage");

    global.fetch.mockResolvedValue(mockTextResponse(400, JSON.stringify({ error: "bad" })));
    await expect(api.updateSyncCron({})).rejects.toThrow("bad");
  });

  it("updateOpenAiCompatApiFeature throws on invalid JSON and API errors", async () => {
    const api = await loadApiModule();

    global.fetch.mockResolvedValue(mockTextResponse(200, "garbage"));
    await expect(api.updateOpenAiCompatApiFeature(true)).rejects.toThrow("garbage");

    global.fetch.mockResolvedValue(mockTextResponse(400, JSON.stringify({ error: "bad" })));
    await expect(api.updateOpenAiCompatApiFeature(false)).rejects.toThrow("bad");
  });

  it("saveEnvVars throws raw text for invalid JSON responses", async () => {
    global.fetch.mockResolvedValue(mockTextResponse(200, "garbage"));
    const api = await loadApiModule();

    await expect(api.saveEnvVars([])).rejects.toThrow("garbage");
  });
});

describe("frontend/api openclaw endpoints", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    global.window = { location: { href: "http://localhost/" } };
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    delete global.fetch;
    delete global.window;
  });

  it("triggerWatchdogTestNotification preserves the 502 body — per-channel failures ride the rejection", async () => {
    const result = {
      ok: false,
      sent: 0,
      failed: 1,
      channels: { telegram: { sent: 0, failed: 1, skipped: false, targets: 1 } },
      failures: [
        {
          channel: "telegram",
          target: "12345",
          reason: "Bad Request: can't parse entities",
          errorCode: 400,
          deterministic: true,
        },
      ],
    };
    global.fetch.mockResolvedValue(
      mockJsonResponse(502, {
        ok: false,
        error: "Test notification failed on every channel — telegram: Bad Request: can't parse entities (400)",
        result,
      }),
    );
    const api = await loadApiModule();

    await expect(api.triggerWatchdogTestNotification()).rejects.toMatchObject({
      message:
        "Test notification failed on every channel — telegram: Bad Request: can't parse entities (400)",
      status: 502,
      result,
    });

    // Success keeps resolving the body unchanged.
    global.fetch.mockResolvedValue(
      mockJsonResponse(200, { ok: true, result: { ok: true, sent: 1, failed: 0 } }),
    );
    await expect(api.triggerWatchdogTestNotification()).resolves.toEqual({
      ok: true,
      result: { ok: true, sent: 1, failed: 0 },
    });

    // Unparseable failure body: fallback message, no invented result.
    global.fetch.mockResolvedValue({
      status: 503,
      ok: false,
      json: async () => {
        throw new Error("bad json");
      },
    });
    const rejection = await api.triggerWatchdogTestNotification().catch((err) => err);
    expect(rejection.message).toBe("Could not send test notification");
    expect(rejection.status).toBe(503);
    expect(rejection.result).toBeUndefined();
  });

  it("fetchOpenclawFeatures gets the fail-closed feature map", async () => {
    const payload = {
      ok: true,
      version: "2026.8.1-beta.3",
      features: { multiUser: true, sqliteBackup: true },
    };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await loadApiModule();

    const result = await api.fetchOpenclawFeatures();

    expect(global.fetch.mock.calls[0][0]).toBe("/api/openclaw/features");
    expect(result).toEqual(payload);
  });

  it("createOpenclawBackup POSTs /api/openclaw/backup with no body and keeps the 409 code", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(202, { ok: true, started: true }));
    const api = await loadApiModule();

    await expect(api.createOpenclawBackup()).resolves.toEqual({ ok: true, started: true });
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("/api/openclaw/backup");
    expect(options.method).toBe("POST");
    expect(options.body).toBeUndefined();

    global.fetch.mockResolvedValue(
      mockJsonResponse(409, { ok: false, code: "backup_in_progress", error: "A backup is already running" }),
    );
    await expect(api.createOpenclawBackup()).rejects.toMatchObject({
      status: 409,
      code: "backup_in_progress",
      message: "A backup is already running",
    });
  });

  it("fetchOpenclawBackupStatus GETs the running flag and last result", async () => {
    const payload = {
      ok: true,
      running: false,
      last: { ok: true, startedAt: 1, finishedAt: 2, archivePath: "/backups/a.tar.gz", bytes: 10, error: null },
    };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await loadApiModule();

    await expect(api.fetchOpenclawBackupStatus()).resolves.toEqual(payload);
    expect(global.fetch.mock.calls[0][0]).toBe("/api/openclaw/backup");
    expect(global.fetch.mock.calls[0][1]?.method).toBeUndefined();
  });

  it("fetchOpenclawNotifications gets the routing preferences", async () => {
    const payload = {
      ok: true,
      notifications: { preferredChannel: "telegram", adminTargets: [] },
    };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await loadApiModule();

    const result = await api.fetchOpenclawNotifications();

    expect(global.fetch.mock.calls[0][0]).toBe("/api/openclaw/notifications");
    expect(result).toEqual(payload);
  });

  it("updateOpenclawNotifications puts the preferences and keeps envelope errors", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(200, {
        ok: true,
        notifications: {
          preferredChannel: "slack",
          adminTargets: [
            { channel: "slack", target: "U123", accountId: "work" },
          ],
        },
      }),
    );
    const api = await loadApiModule();

    const result = await api.updateOpenclawNotifications({
      preferredChannel: "slack",
      adminTargets: [{ channel: "slack", target: "U123", accountId: "work" }],
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/openclaw/notifications",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          preferredChannel: "slack",
          adminTargets: [
            { channel: "slack", target: "U123", accountId: "work" },
          ],
        }),
        headers: expect.any(Headers),
      }),
    );
    expect(result.notifications.preferredChannel).toBe("slack");

    global.fetch.mockResolvedValue(
      mockJsonResponse(503, {
        ok: false,
        code: "notifications_unavailable",
        message: "Store not available",
      }),
    );
    const error = await api
      .updateOpenclawNotifications({ preferredChannel: null })
      .catch((err) => err);
    expect(error.message).toBe("Store not available");
    expect(error.code).toBe("notifications_unavailable");
  });

  it("subscribeGatewayRestartEvents streams step/output/done and routes drops to onError", async () => {
    global.window.EventSource = FakeEventSource;
    const api = await loadApiModule();
    const messages = [];
    const errors = [];

    const unsubscribe = api.subscribeGatewayRestartEvents({
      operationId: "op 1",
      onMessage: (message) => messages.push(message),
      onError: (event) => errors.push(event),
    });

    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/operations/op%201/events");
    expect(source.options).toEqual({ withCredentials: true });

    source.emit("step", {
      data: JSON.stringify({ name: "preflight", status: "running", at: 1 }),
    });
    source.emit("output", { data: JSON.stringify({ chunk: "npm install\n" }) });
    // A connection drop is an "error"-typed event with no data payload.
    source.emit("error", {});
    source.emit("error", { data: JSON.stringify({ error: "build failed" }) });
    source.emit("done", { data: JSON.stringify({ ok: true }) });

    expect(messages).toEqual([
      { event: "step", data: { name: "preflight", status: "running", at: 1 } },
      { event: "output", data: { chunk: "npm install\n" } },
      { event: "error", data: { error: "build failed" } },
      { event: "done", data: { ok: true } },
    ]);
    expect(errors).toHaveLength(1);

    unsubscribe();
    expect(source.closed).toBe(true);
    source.emit("step", { data: "{}" });
    expect(messages).toHaveLength(4);
  });

  it("subscribeGatewayRestartEvents throws when EventSource is unavailable", async () => {
    const api = await loadApiModule();

    expect(() => api.subscribeGatewayRestartEvents({ operationId: "op" })).toThrow(
      "Server events are not supported in this browser",
    );
  });
});

describe("frontend/api claude-code helpers", () => {
  const mockJsonResponse = (status, payload) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  });

  beforeEach(() => {
    global.fetch = vi.fn();
    global.window = { location: { href: "http://localhost/" } };
  });

  it("fetchClaudeCodeStatus returns the availability envelope", async () => {
    const payload = { ok: true, availability: { available: true } };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await import("../../lib/public/js/lib/api.js");
    expect(await api.fetchClaudeCodeStatus()).toEqual(payload);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/claude-code/status",
      expect.any(Object),
    );
  });

  it("createClaudeCodeSession POSTs the confirmed flag and returns the session", async () => {
    const payload = {
      ok: true,
      sessionId: "session_01A",
      sessionUrl: "https://claude.ai/code/session_01A",
    };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await import("../../lib/public/js/lib/api.js");
    const result = await api.createClaudeCodeSession({ confirmed: true });
    expect(result).toEqual(payload);
    const [, options] = global.fetch.mock.calls.at(-1);
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ confirmed: true });
  });

  it("keeps the machine code on the thrown error (the hook branches on it)", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(409, {
        ok: false,
        error: "confirm_required",
        message: "Confirmation required before the first fire.",
      }),
    );
    const api = await import("../../lib/public/js/lib/api.js");
    await expect(api.createClaudeCodeSession()).rejects.toMatchObject({
      code: "confirm_required",
      message: "Confirmation required before the first fire.",
    });
  });

  it("prefers a dedicated code field over error prose (middleware envelopes)", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(403, { error: "Admin access required", code: "admin_required" }),
    );
    const api = await import("../../lib/public/js/lib/api.js");
    await expect(api.createClaudeCodeSession()).rejects.toMatchObject({
      code: "admin_required",
    });
  });

  it("throws a generic error on an unparseable body", async () => {
    global.fetch.mockResolvedValue({
      status: 502,
      ok: false,
      text: async () => "<html>bad gateway</html>",
    });
    const api = await import("../../lib/public/js/lib/api.js");
    await expect(api.createClaudeCodeSession()).rejects.toThrow(
      "<html>bad gateway</html>",
    );
  });
});

describe("frontend/api claude-code local helpers", () => {
  const mockJsonResponse = (status, payload) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  });

  beforeEach(() => {
    global.fetch = vi.fn();
    global.window = { location: { href: "http://localhost/" } };
  });

  it("fetchClaudeCodeStatusDirect hits the same status endpoint (poller path)", async () => {
    const payload = {
      ok: true,
      availability: { available: true },
      local: { enabled: true, state: "ready" },
    };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await import("../../lib/public/js/lib/api.js");
    expect(await api.fetchClaudeCodeStatusDirect()).toEqual(payload);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/claude-code/status",
      expect.any(Object),
    );
  });

  it("createClaudeCodeLocalSession POSTs the confirmed flag + permissionMode and returns the envelope", async () => {
    const payload = {
      ok: true,
      status: "running",
      sessionId: "rescue_01A",
      sessionUrl: "https://box.example/rescue/feedfacefeedface",
    };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await import("../../lib/public/js/lib/api.js");
    const result = await api.createClaudeCodeLocalSession({
      confirmed: true,
      permissionMode: "bypassPermissions",
    });
    expect(result).toEqual(payload);
    const [url, options] = global.fetch.mock.calls.at(-1);
    expect(url).toBe("/api/claude-code/local/session");
    expect(options.method).toBe("POST");
    // permissionMode rides along so the server can refuse a stale consent
    // snapshot (TOCTOU guard: mismatch answers 409 confirm_required).
    expect(JSON.parse(options.body)).toEqual({
      confirmed: true,
      permissionMode: "bypassPermissions",
    });
  });

  it("createClaudeCodeLocalSession defaults confirmed:false and permissionMode:null (strict server check)", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(202, { ok: true, status: "starting" }));
    const api = await import("../../lib/public/js/lib/api.js");
    const result = await api.createClaudeCodeLocalSession();
    expect(result).toEqual({ ok: true, status: "starting" });
    const [, options] = global.fetch.mock.calls.at(-1);
    expect(JSON.parse(options.body)).toEqual({
      confirmed: false,
      permissionMode: null,
    });
  });

  it("keeps the machine code on thrown local refusals (the launcher branches on it)", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(409, {
        ok: false,
        error: "needs_login",
        message: "Log in to Claude on the Watchdog page first (one-time).",
      }),
    );
    const api = await import("../../lib/public/js/lib/api.js");
    await expect(api.createClaudeCodeLocalSession()).rejects.toMatchObject({
      code: "needs_login",
      message: "Log in to Claude on the Watchdog page first (one-time).",
    });
  });

  it("threads the server's live permissionMode + cwd onto a confirm_required error (authoritative modal source)", async () => {
    // The 409 body carries the server's live config so the confirm modal names
    // the mode the server is ACTUALLY set to, not a stale cached snapshot.
    global.fetch.mockResolvedValue(
      mockJsonResponse(409, {
        ok: false,
        error: "confirm_required",
        message: "Confirm the rescue session before it starts.",
        permissionMode: "bypassPermissions",
        cwd: "/data/claude-code-local/workspace",
      }),
    );
    const api = await import("../../lib/public/js/lib/api.js");
    await expect(api.createClaudeCodeLocalSession()).rejects.toMatchObject({
      code: "confirm_required",
      permissionMode: "bypassPermissions",
      cwd: "/data/claude-code-local/workspace",
    });
  });

  it("omits permissionMode/cwd on the error when an older server does not send them", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(409, {
        ok: false,
        error: "confirm_required",
        message: "Confirm the rescue session before it starts.",
      }),
    );
    const api = await import("../../lib/public/js/lib/api.js");
    const error = await api.createClaudeCodeLocalSession().catch((err) => err);
    expect(error.code).toBe("confirm_required");
    expect(error).not.toHaveProperty("permissionMode");
    expect(error).not.toHaveProperty("cwd");
  });

  it("stop/login/cancel/logout POST their endpoints", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true }));
    const api = await import("../../lib/public/js/lib/api.js");
    const calls = [
      [api.stopClaudeCodeLocalSession, "/api/claude-code/local/session/stop"],
      [api.startClaudeCodeLocalLogin, "/api/claude-code/local/login"],
      [api.cancelClaudeCodeLocalLogin, "/api/claude-code/local/login/cancel"],
      [api.logoutClaudeCodeLocal, "/api/claude-code/local/logout"],
    ];
    for (const [fn, endpoint] of calls) {
      await fn();
      const [url, options] = global.fetch.mock.calls.at(-1);
      expect(url).toBe(endpoint);
      expect(options.method).toBe("POST");
    }
  });

  it("submitClaudeCodeLocalLoginCode POSTs the code body", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, status: "verifying" }));
    const api = await import("../../lib/public/js/lib/api.js");
    const result = await api.submitClaudeCodeLocalLoginCode({ code: "ABC-123" });
    expect(result).toEqual({ ok: true, status: "verifying" });
    const [url, options] = global.fetch.mock.calls.at(-1);
    expect(url).toBe("/api/claude-code/local/login/code");
    expect(JSON.parse(options.body)).toEqual({ code: "ABC-123" });
  });

  it("fetchClaudeCodeLocalTail encodes the source query", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(200, { ok: true, source: "login", tail: "output" }),
    );
    const api = await import("../../lib/public/js/lib/api.js");
    const result = await api.fetchClaudeCodeLocalTail({ source: "login" });
    expect(result.tail).toBe("output");
    const [url] = global.fetch.mock.calls.at(-1);
    expect(url).toBe("/api/claude-code/local/tail?source=login");
  });

  it("fetchClaudeCodeLocalTail surfaces the 404 no_buffer code", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(404, { ok: false, error: "no_buffer", message: "No output yet." }),
    );
    const api = await import("../../lib/public/js/lib/api.js");
    await expect(api.fetchClaudeCodeLocalTail()).rejects.toMatchObject({
      code: "no_buffer",
    });
  });
});
