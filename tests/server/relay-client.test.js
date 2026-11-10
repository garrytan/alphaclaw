const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const kScriptPath = path.resolve(__dirname, "../../scripts/relay-client.mjs");
const kJwtBearerGrant = "urn:ietf:params:oauth:grant-type:jwt-bearer";

const makeJwt = ({ exp = Math.floor(Date.now() / 1000) + 600, jti = crypto.randomUUID() } = {}) => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({ iss: "https://capy.test", sub: "machine_test", exp, jti }),
    "jwtSIGsecret" + crypto.randomBytes(12).toString("hex"),
  ].join(".");
};

const createFakeBox = async () => {
  const state = {
    exchanges: 0,
    requests: 0,
    calls: [],
    jwts: new Set(),
    tokens: new Set(),
    capabilities: new Set(),
    handoffCodes: new Set(),
    bindings: new Map(),
    handoffs: new Map(),
    force401: 0,
    sse: false,
    errors: {},
    exchangeError: null,
  };
  const reply = (res, status, body, type = "application/json") => {
    res.writeHead(status, { "Content-Type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const newCapability = () => {
    const capability = "capSECRET" + crypto.randomBytes(12).toString("hex");
    state.capabilities.add(capability);
    return capability;
  };
  const runTool = (name, args, context) => {
    if (state.errors[name]) return { isError: true, payload: state.errors[name](args, context) };
    if (name === "relay_bind") {
      if (args.capability) {
        const binding = [...state.bindings.entries()].find(([, entry]) => entry.capability === args.capability);
        if (!binding) return { isError: true, payload: { error: "capability_invalid", message: "Unknown capability." } };
        binding[1].webhook_url = args.webhook_url;
        return { payload: { agent: binding[0], renewed: true, until: args.until || null, webhook_url: args.webhook_url } };
      }
      const agent = "capy-" + crypto.randomBytes(6).toString("hex");
      const capability = newCapability();
      state.bindings.set(agent, { capability, thread_id: args.thread_id, webhook_url: args.webhook_url });
      return { payload: { agent, capability, thread_id: args.thread_id, until: args.until || null } };
    }
    if (name === "relay_claim") {
      const agent = state.handoffs.get(args.handoff_code);
      if (agent !== args.as) return { isError: true, payload: { error: "handoff_invalid", message: "Unknown handoff code." } };
      state.handoffs.delete(args.handoff_code);
      const capability = newCapability();
      state.bindings.set(agent, { capability, thread_id: args.thread_id, webhook_url: args.webhook_url });
      return { payload: { agent, capability, thread_id: args.thread_id, generation: 2 } };
    }
    if (state.bindings.get(args.as)?.capability !== args.capability) {
      return { isError: true, payload: { error: "capability_invalid", message: "Wrong capability for " + args.as + "." } };
    }
    if (name === "relay_send") {
      return { payload: { message_id: "msg-1", trust: "standard", reason: "default tier", approval: null, lane: args.lane || null } };
    }
    if (name === "relay_reply") return { payload: { message_id: "msg-2", in_reply_to: args.message_id, lane: args.lane || null } };
    if (name === "relay_inbox") return { payload: { messages: [{ from: "wintermute", text: "hi" }], capability: args.capability } };
    if (name === "relay_history") return { payload: { with: args.with, lane: args.lane || null, limit: args.limit ?? null, messages: [] } };
    if (name === "relay_result") return { payload: { result_ref: args.result_ref, part: args.part ?? null, text: "part text" } };
    if (name === "relay_handoff") {
      const handoffCode = "hocSECRET" + crypto.randomBytes(12).toString("hex");
      state.handoffCodes.add(handoffCode);
      state.handoffs.set(handoffCode, args.as);
      return { payload: { handoff_code: handoffCode, successor_thread: args.successor_thread, expires_in: 3600 } };
    }
    if (name === "relay_unbind") {
      state.bindings.delete(args.as);
      return { payload: { unbound: true, agent: args.as } };
    }
    return { isError: true, payload: { error: "unknown_tool", message: name } };
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      state.requests += 1;
      if (req.method === "POST" && req.url === "/relay/oauth/token") {
        state.exchanges += 1;
        const form = new URLSearchParams(body);
        const assertion = form.get("assertion");
        state.jwts.add(assertion);
        if (state.exchangeError) return reply(res, 401, state.exchangeError(assertion));
        if (form.get("grant_type") !== kJwtBearerGrant || form.get("resource") !== state.url + "/relay/mcp" || !assertion) {
          return reply(res, 400, { error: "invalid_request", error_description: "Bad exchange." });
        }
        const token = "atkSECRET" + state.exchanges + crypto.randomBytes(12).toString("hex");
        state.tokens.add(token);
        return reply(res, 200, { access_token: token, token_type: "bearer", expires_in: 600 });
      }
      if (req.method === "POST" && req.url === "/relay/mcp") {
        const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
        if (state.force401 > 0 || !state.tokens.has(token)) {
          state.force401 = Math.max(0, state.force401 - 1);
          return reply(res, 401, { error: "invalid_token" });
        }
        const rpc = JSON.parse(body);
        state.calls.push({ name: rpc.params.name, arguments: rpc.params.arguments, accept: req.headers.accept });
        const { isError, payload } = runTool(rpc.params.name, rpc.params.arguments, { token });
        const message = {
          jsonrpc: "2.0",
          id: rpc.id,
          result: { content: [{ type: "text", text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) },
        };
        if (!state.sse) return reply(res, 200, message);
        const notice = { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } };
        return reply(res, 200, "event: message\ndata: " + JSON.stringify(notice) + "\n\nevent: message\ndata: " + JSON.stringify(message) + "\n\n", "text/event-stream");
      }
      reply(res, 404, { error: "not_found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = "http://127.0.0.1:" + server.address().port;
  state.close = () => new Promise((resolve) => server.close(resolve));
  return state;
};

describe("scripts/relay-client.mjs", () => {
  let box;
  let dir;
  let capabilityFile;
  let tokenFile;
  let outputs;

  const childEnv = (overrides = {}) => {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("VITEST") || key.startsWith("RELAY_CLIENT_") || key === "CAPY_OIDC_TOKEN_FILE") continue;
      env[key] = value;
    }
    return { ...env, HOME: dir, CAPY_OIDC_TOKEN_FILE: tokenFile, ...overrides };
  };

  const run = (args, { env, input } = {}) =>
    new Promise((resolve) => {
      const child = childProcess.execFile(
        process.execPath,
        [kScriptPath, ...args],
        { env: childEnv(env), encoding: "utf8" },
        (error, stdout, stderr) => {
          outputs.push(stdout, stderr);
          resolve({ code: error ? error.code : 0, stdout, stderr, json: stdout ? JSON.parse(stdout) : null });
        },
      );
      child.stdin.end(input || "");
    });

  const client = (command, args = [], options) =>
    run([command, "--box", box.url, "--capability-file", capabilityFile, ...args], options);

  const bind = () => client("bind", ["--thread-id", "thread-a", "--webhook-url", "https://wake.example/a"]);
  const stored = () => JSON.parse(fs.readFileSync(capabilityFile, "utf8"));
  const mode = (file) => fs.statSync(file).mode & 0o777;
  const lastCall = () => box.calls[box.calls.length - 1];

  beforeEach(async () => {
    box = await createFakeBox();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-client-"));
    capabilityFile = path.join(dir, "state", "capability.json");
    tokenFile = path.join(dir, "oidc-token");
    fs.writeFileSync(tokenFile, makeJwt());
    outputs = [];
  });

  afterEach(async () => {
    await box.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("bind writes a 0600 capability file and prints no capability", async () => {
    const result = await bind();
    expect(result.code).toBe(0);
    const binding = stored();
    expect(binding).toEqual({
      box: box.url,
      agent: result.json.agent,
      capability: [...box.capabilities][0],
      thread_id: "thread-a",
      webhook_url: "https://wake.example/a",
    });
    expect(mode(capabilityFile)).toBe(0o600);
    expect(mode(path.dirname(capabilityFile))).toBe(0o700);
    expect(mode(capabilityFile + ".token.json")).toBe(0o600);
    expect(result.json.capability).toBe("[stored]");
    expect(result.stdout).not.toContain(binding.capability);
    expect(box.calls[0]).toMatchObject({ name: "relay_bind", arguments: { thread_id: "thread-a", webhook_url: "https://wake.example/a" } });
    expect(box.calls[0].accept).toBe("application/json, text/event-stream");
    expect((await bind()).code).toBe(1);
  });

  it("calls each tool as the stored agent with its capability and passes lanes through", async () => {
    await bind();
    const { agent, capability } = stored();
    const approvalFile = path.join(dir, "approval.json");
    fs.writeFileSync(approvalFile, JSON.stringify({ words: "yes send it", action: "send", targets: ["bob"] }));

    const send = await client("send", ["--to", "wintermute", "--text", "hello", "--lane", "research", "--approval-file", approvalFile, "--confirmation-ref", "cf_1"]);
    expect(send.code).toBe(0);
    expect(send.json).toMatchObject({ message_id: "msg-1", trust: "standard", lane: "research" });
    expect(lastCall()).toEqual({
      name: "relay_send",
      accept: "application/json, text/event-stream",
      arguments: { as: agent, capability, to: "wintermute", text: "hello", lane: "research", approval: { words: "yes send it", action: "send", targets: ["bob"] }, confirmation_ref: "cf_1" },
    });

    const reply = await client("reply", ["--message-id", "msg-9", "--text-file", "-", "--lane", "ops"], { input: "from stdin" });
    expect(reply.code).toBe(0);
    expect(lastCall()).toMatchObject({ name: "relay_reply", arguments: { as: agent, capability, message_id: "msg-9", text: "from stdin", lane: "ops" } });

    const inbox = await client("inbox");
    expect(inbox.code).toBe(0);
    expect(inbox.json.capability).toBe("[stored]");
    expect(lastCall()).toMatchObject({ name: "relay_inbox", arguments: { as: agent, capability } });

    const history = await client("history", ["--with", "wintermute", "--limit", "5", "--lane", "ops"]);
    expect(history.json).toMatchObject({ with: "wintermute", lane: "ops", limit: 5 });
    expect(lastCall().arguments).toEqual({ as: agent, capability, with: "wintermute", limit: 5, lane: "ops" });

    const result = await client("result", ["--result-ref", "ref-1", "--part", "2"]);
    expect(result.json).toMatchObject({ result_ref: "ref-1", part: 2 });
    expect(lastCall().arguments).toEqual({ as: agent, capability, result_ref: "ref-1", part: 2 });

    box.sse = true;
    const sse = await client("send", ["--to", "wintermute", "--text", "over sse"]);
    expect(sse.code).toBe(0);
    expect(sse.json.message_id).toBe("msg-1");
    box.sse = false;

    const unbind = await client("unbind");
    expect(unbind.code).toBe(0);
    expect(lastCall()).toMatchObject({ name: "relay_unbind", arguments: { as: agent, capability } });
    expect(fs.existsSync(capabilityFile)).toBe(false);
    expect(box.exchanges).toBe(1);

    const unbound = await client("inbox");
    expect(unbound.code).toBe(1);
    expect(JSON.parse(unbound.stderr).error).toBe("not_bound");
  });

  it("renew re-binds with the stored capability, thread and webhook", async () => {
    await bind();
    const before = stored();
    const renew = await client("renew", ["--until", "2026-12-01T00:00:00Z"]);
    expect(renew.code).toBe(0);
    expect(lastCall()).toMatchObject({
      name: "relay_bind",
      arguments: { thread_id: "thread-a", webhook_url: "https://wake.example/a", capability: before.capability, until: "2026-12-01T00:00:00Z" },
    });
    const moved = await client("renew", ["--webhook-url", "https://wake.example/b"]);
    expect(moved.code).toBe(0);
    expect(stored()).toEqual({ ...before, webhook_url: "https://wake.example/b" });
    expect(mode(capabilityFile)).toBe(0o600);
  });

  it("reuses the cached access token until the JWT's jti changes", async () => {
    await bind();
    for (let i = 0; i < 3; i += 1) expect((await client("send", ["--to", "wintermute", "--text", "n" + i])).code).toBe(0);
    expect(box.exchanges).toBe(1);

    fs.writeFileSync(tokenFile, makeJwt());
    expect((await client("send", ["--to", "wintermute", "--text", "new jti"])).code).toBe(0);
    expect(box.exchanges).toBe(2);
    const cache = JSON.parse(fs.readFileSync(capabilityFile + ".token.json", "utf8"));
    expect(cache.box).toBe(box.url);
    expect(box.tokens.has(cache.access_token)).toBe(true);
  });

  it("keeps the cache valid under concurrent runs", async () => {
    await bind();
    fs.writeFileSync(tokenFile, makeJwt());
    const results = await Promise.all([
      client("send", ["--to", "wintermute", "--text", "one"]),
      client("send", ["--to", "wintermute", "--text", "two"]),
    ]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    const cache = JSON.parse(fs.readFileSync(capabilityFile + ".token.json", "utf8"));
    expect(box.tokens.has(cache.access_token)).toBe(true);
    expect(fs.readdirSync(path.dirname(capabilityFile)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("re-exchanges once and retries once on a 401, then fails cleanly", async () => {
    await bind();
    box.force401 = 1;
    const retried = await client("inbox");
    expect(retried.code).toBe(0);
    expect(box.exchanges).toBe(2);

    box.force401 = 2;
    const refused = await client("inbox");
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stderr).error).toBe("unauthorized");
    expect(box.exchanges).toBe(3);
  });

  it("refuses an expired, nearly expired or missing JWT with attestation_stale and no request", async () => {
    await bind();
    const requests = box.requests;
    fs.writeFileSync(tokenFile, makeJwt({ exp: Math.floor(Date.now() / 1000) + 10 }));
    const expiring = await client("send", ["--to", "wintermute", "--text", "hi"]);
    fs.writeFileSync(tokenFile, makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }));
    const expired = await client("inbox");
    fs.rmSync(tokenFile);
    const missing = await client("inbox");
    const unset = await client("inbox", [], { env: { CAPY_OIDC_TOKEN_FILE: "" } });
    for (const result of [expiring, expired, missing, unset]) {
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr).error).toBe("attestation_stale");
    }
    expect(box.requests).toBe(requests);
  });

  it("handoff writes the code to a 0600 file without printing it, and claim takes the binding", async () => {
    await bind();
    const { agent, capability: oldCapability } = stored();
    const codeFile = path.join(dir, "handoff", "code");
    const handoff = await client("handoff", ["--successor-thread", "thread-b", "--code-file", codeFile]);
    expect(handoff.code).toBe(0);
    const code = [...box.handoffCodes][0];
    expect(fs.readFileSync(codeFile, "utf8").trim()).toBe(code);
    expect(mode(codeFile)).toBe(0o600);
    expect(handoff.json.handoff_code).toBe("[stored]");
    expect(handoff.stdout + handoff.stderr).not.toContain(code);
    expect(lastCall().arguments).toEqual({ as: agent, capability: oldCapability, successor_thread: "thread-b" });

    const successorFile = path.join(dir, "successor", "capability.json");
    const claim = await run(["claim", "--box", box.url, "--capability-file", successorFile, "--agent", agent, "--code-file", codeFile, "--thread-id", "thread-b", "--webhook-url", "https://wake.example/b"]);
    expect(claim.code).toBe(0);
    expect(lastCall().arguments).toEqual({ as: agent, handoff_code: code, thread_id: "thread-b", webhook_url: "https://wake.example/b" });
    const successor = JSON.parse(fs.readFileSync(successorFile, "utf8"));
    expect(successor).toMatchObject({ box: box.url, agent, thread_id: "thread-b", webhook_url: "https://wake.example/b" });
    expect(successor.capability).not.toBe(oldCapability);
    expect(box.capabilities.has(successor.capability)).toBe(true);
    expect(mode(successorFile)).toBe(0o600);
    expect(fs.existsSync(codeFile)).toBe(false);
  });

  it("passes server error codes through and exits 1", async () => {
    await bind();
    box.errors.relay_send = () => ({ error: "route_required", message: "This agent's grant requires the tailnet route.", fix: "Use the tailnet URL." });
    const result = await client("send", ["--to", "wintermute", "--text", "hi"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ error: "route_required", message: "This agent's grant requires the tailnet route.", fix: "Use the tailnet URL." });
  });

  it("passes --summary through on send and reply, and a --summary with no value is a usage error with an example", async () => {
    await bind();
    const { agent, capability } = stored();
    const send = await client("send", ["--to", "wintermute", "--text", "hello", "--summary", "re-import the notes"]);
    expect(send.code).toBe(0);
    expect(lastCall().arguments).toEqual({ as: agent, capability, to: "wintermute", text: "hello", summary: "re-import the notes" });
    const reply = await client("reply", ["--message-id", "msg-9", "--text", "done", "--summary", "notes imported"]);
    expect(reply.code).toBe(0);
    expect(lastCall().arguments).toMatchObject({ message_id: "msg-9", summary: "notes imported" });
    const calls = box.calls.length;
    for (const args of [["--to", "wintermute", "--text", "hi", "--summary"], ["--to", "wintermute", "--text", "hi", "--summary", "  "]]) {
      const result = await client("send", args);
      expect(result.code).toBe(2);
      const error = JSON.parse(result.stderr);
      expect(error.error).toBe("usage");
      expect(error.message).toContain("--summary");
      expect(error.message).toContain('For example: --summary "re-import yesterday\'s meeting notes into gbrain"');
    }
    expect(box.calls).toHaveLength(calls);
  });

  it("refuses plain http to a non-loopback box and usage errors exit 2", async () => {
    const insecure = await run(["inbox", "--box", "http://box.example.com", "--capability-file", capabilityFile]);
    expect(insecure.code).toBe(2);
    expect(JSON.parse(insecure.stderr).error).toBe("insecure_box");
    expect((await run(["inbox", "--capability-file", capabilityFile])).code).toBe(2);
    expect((await client("teleport")).code).toBe(2);
    expect((await client("send", ["--to", "wintermute"])).code).toBe(2);
    expect((await client("inbox", ["--capability", "capSECRETfromargv"])).code).toBe(2);
    expect(box.requests).toBe(0);
  });

  it("never prints the JWT, an access token, a capability or a handoff code", async () => {
    const echo = (args, { token }) => ({
      error: "echo_error",
      message: "saw " + [...box.jwts].join(",") + " " + token + " " + (args.capability || "") + " " + (args.handoff_code || ""),
    });
    const codeFile = path.join(dir, "code");
    const successorFile = path.join(dir, "successor.json");
    await bind();
    const { agent: firstAgent } = stored();
    const successes = [
      await client("renew"),
      await client("send", ["--to", "wintermute", "--text", "hi", "--lane", "ops"]),
      await client("reply", ["--message-id", "msg-1", "--text", "hi"]),
      await client("inbox"),
      await client("history", ["--with", "wintermute"]),
      await client("result", ["--result-ref", "ref-1"]),
      await client("handoff", ["--successor-thread", "thread-b", "--code-file", codeFile]),
      await run(["claim", "--box", box.url, "--capability-file", successorFile, "--agent", firstAgent, "--code-file", codeFile, "--thread-id", "thread-b"]),
      await run(["unbind", "--box", box.url, "--capability-file", successorFile]),
    ];
    expect(successes.map((result) => result.code)).toEqual(successes.map(() => 0));
    fs.rmSync(capabilityFile);

    await bind();
    const { agent } = stored();
    await client("handoff", ["--successor-thread", "thread-b", "--code-file", codeFile]);
    for (const name of ["relay_bind", "relay_send", "relay_reply", "relay_inbox", "relay_history", "relay_result", "relay_handoff", "relay_claim", "relay_unbind"]) {
      box.errors[name] = echo;
    }
    const failures = [
      await client("renew"),
      await client("send", ["--to", "wintermute", "--text", "hi"]),
      await client("reply", ["--message-id", "msg-1", "--text", "hi"]),
      await client("inbox"),
      await client("history", ["--with", "wintermute"]),
      await client("result", ["--result-ref", "ref-1"]),
      await client("handoff", ["--successor-thread", "thread-b", "--code-file", path.join(dir, "code2")]),
      await run(["claim", "--box", box.url, "--capability-file", successorFile, "--agent", agent, "--code-file", codeFile, "--thread-id", "thread-b"]),
      await client("unbind"),
    ];
    for (const failure of failures) {
      expect(failure.code).toBe(1);
      expect(JSON.parse(failure.stderr).error).toBe("echo_error");
      expect(failure.stderr).toContain("[redacted]");
    }
    fs.writeFileSync(tokenFile, makeJwt());
    box.exchangeError = (assertion) => ({ error: "invalid_grant", error_description: "rejected " + assertion });
    const exchange = await client("inbox");
    expect(exchange.code).toBe(1);
    expect(JSON.parse(exchange.stderr)).toEqual({ error: "invalid_grant", message: "rejected [redacted]" });

    const combined = outputs.join("\n");
    const secrets = [...box.jwts, ...box.tokens, ...box.capabilities, ...box.handoffCodes];
    expect(box.jwts.size).toBe(2);
    expect(box.handoffCodes.size).toBe(2);
    expect(secrets.length).toBeGreaterThan(6);
    for (const secret of secrets) {
      expect(combined).not.toContain(secret);
      expect(combined).not.toContain(secret.split(".").pop());
    }
    expect(combined).not.toMatch(/capSECRET|atkSECRET|hocSECRET|jwtSIGsecret/);
  });
});
