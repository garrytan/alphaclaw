#!/usr/bin/env node
// Relay client for a Capy liaison machine: talks to an AlphaClaw box's Agent
// Relay over its OAuth-protected MCP endpoint, authenticated with the machine's
// Capy OIDC token instead of a browser consent. Standalone on purpose: Node 24
// built-ins only, never AlphaClaw or OpenClaw code, fetched by commit sha and
// run as `node relay-client.mjs <command> [flags]`.
//
// Contract (relay trust v2, GST-2090):
//   POST <box>/relay/oauth/token (RFC 7523 jwt-bearer, resource <box>/relay/mcp)
//     -> { access_token, token_type, expires_in }, capped at the JWT's exp.
//   POST <box>/relay/mcp, stateless JSON-RPC tools/call with the bearer token;
//     JSON or SSE body; a 401 re-exchanges once and retries once.
//   The OIDC token is read only from CAPY_OIDC_TOKEN_FILE (or --token-file).
//   The capability lives only in the 0600 capability file, the access token
//   only in the 0600 cache beside it, a handoff code only in --code-file.
//   None of them is ever printed: result fields named capability,
//   handoff_code or access_token print as "[stored]", and any known secret
//   inside other output prints as "[redacted]".
//   Exit 0 on success, 1 on an error ({error, message} on stderr, the server's
//   code unchanged), 2 on a usage error.
//   Liaison key (GST-2323 PR4): keygen writes an Ed25519 key to a 0600 file
//   and prints only its public key; with --key-file, send, history, result
//   and renew are signed requests to POST <box>/relay/key/call, with no OIDC
//   token, capability or access token, and a key file anyone else can read
//   is refused.
//   Tailnet route (GST-2368): --via <url> (or RELAY_CLIENT_VIA) sends every
//   request to the box's tailnet address instead of --box, which still names
//   the box (the key and capability files are bound to it). Plain http is
//   accepted there only for a tailnet address (100.64.0.0/10,
//   fd7a:115c:a1e0::/48 or a *.ts.net name): WireGuard already encrypts and
//   authenticates that hop. --proxy <url> (or RELAY_CLIENT_PROXY) sends those
//   requests through a userspace tailscaled's loopback HTTP proxy
//   (tailscaled --outbound-http-proxy-listen).

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const kJwtBearerGrant = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const kFreshnessMarginMs = 30_000;
const kRequestTimeoutMs = 120_000;
const kLoopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const kSecretKeys = new Set(["capability", "handoff_code", "access_token"]);
const kCommands = ["bind", "renew", "unbind", "send", "reply", "inbox", "history", "result", "handoff", "claim", "keygen"];
// The commands the liaison-key path serves (--key-file), and its wire
// contract with the box (lib/server/relay/key-auth.js): change both together.
const kKeyCommands = new Set(["send", "history", "result", "renew"]);
const kKeyPath = "/relay/key/call";
const kKeyContentType = "application/vnd.alphaclaw.relay-key+json";
const keySigningInput = ({ method, path: urlPath, agent, timestamp, nonce, bodyHash }) =>
  ["alphaclaw-relay-key-v1", method, urlPath, agent, timestamp, nonce, bodyHash].join("\n");
const kUsage =
  "usage: node relay-client.mjs <" +
  kCommands.join("|") +
  "> --box <https url> [--via <tailnet url>] [--proxy <loopback http url>] [--capability-file <path>] [--token-file <path>] [--key-file <path>] [command flags]";

const secrets = new Set();

class ClientError extends Error {
  constructor(code, message, { exitCode = 1, fix } = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.fix = fix;
  }
}

const fail = (code, message, options) => {
  throw new ClientError(code, message, options);
};

const usage = (message) => fail("usage", `${message}\n${kUsage}`, { exitCode: 2 });
const kSummaryUsage =
  'send and reply take --summary "<one line, at most 120 characters>": what you are asking the box to do, shown to its owner. ' +
  'For example: --summary "re-import yesterday\'s meeting notes into gbrain".';

const redactText = (text) => {
  let out = String(text);
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
};

const redactValue = (value) => {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, kSecretKeys.has(key) ? "[stored]" : redactValue(entry)]),
    );
  }
  return typeof value === "string" ? redactText(value) : value;
};

const isTailnetHost = (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127 && v4.slice(3).every((part) => Number(part) <= 255);
  if (host.includes(":")) return /^fd7a:115c:a1e0:(?::|[0-9a-f]{0,4}(?::|$))/.test(host);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host);
};

// A plain http request through a loopback HTTP proxy (absolute-form request
// line), answered as a fetch Response. Only for http targets on the tailnet.
const fetchThroughProxy = (proxy, target, { method = "GET", headers = {}, body, signal } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : Buffer.from(String(body));
    const req = http.request(
      {
        host: proxy.hostname.replace(/^\[|\]$/g, ""),
        port: Number(proxy.port) || 80,
        method,
        path: target,
        headers: {
          ...headers,
          Host: new URL(target).host,
          ...(payload ? { "Content-Length": String(payload.length) } : {}),
          ...(body instanceof URLSearchParams ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        signal,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const pairs = [];
          for (const [name, value] of Object.entries(res.headers)) {
            for (const entry of Array.isArray(value) ? value : [value]) pairs.push([name, String(entry)]);
          }
          const status = res.statusCode || 502;
          const noBody = status === 204 || status === 304;
          resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, headers: pairs }));
        });
      },
    );
    req.on("error", reject);
    req.end(payload ?? undefined);
  });

const writePrivateFile = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
};

const main = async () => {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        box: { type: "string" },
        "capability-file": { type: "string" },
        "token-file": { type: "string" },
        "thread-id": { type: "string" },
        "webhook-url": { type: "string" },
        until: { type: "string" },
        to: { type: "string" },
        text: { type: "string" },
        "text-file": { type: "string" },
        "approval-file": { type: "string" },
        "confirmation-ref": { type: "string" },
        "message-id": { type: "string" },
        lane: { type: "string" },
        summary: { type: "string" },
        with: { type: "string" },
        limit: { type: "string" },
        "result-ref": { type: "string" },
        part: { type: "string" },
        "successor-thread": { type: "string" },
        "code-file": { type: "string" },
        agent: { type: "string" },
        "key-file": { type: "string" },
        via: { type: "string" },
        proxy: { type: "string" },
      },
    });
  } catch (err) {
    usage(/--summary/.test(err.message) ? `--summary needs a value. ${kSummaryUsage}` : err.message);
  }
  const { values, positionals } = parsed;
  const [command, ...extra] = positionals;
  if (!kCommands.includes(command)) usage(command ? `Unknown command ${command}.` : "A command is required.");
  if (extra.length) usage(`Unexpected arguments: ${extra.join(" ")}.`);

  const required = (name) => values[name] ?? usage(`--${name} is required for ${command}.`);
  const integer = (name) => {
    const number = Number(values[name]);
    return Number.isInteger(number) && number >= 0 ? number : usage(`--${name} must be a whole number.`);
  };

  const boxFlag = values.box ?? process.env.RELAY_CLIENT_BOX;
  if (!boxFlag) usage("--box (or RELAY_CLIENT_BOX) is required.");
  let boxUrl;
  try {
    boxUrl = new URL(boxFlag);
  } catch {
    usage(`--box is not a URL: ${boxFlag}`);
  }
  const loopbackHttp = boxUrl.protocol === "http:" && kLoopbackHosts.has(boxUrl.hostname);
  if (boxUrl.protocol !== "https:" && !loopbackHttp) {
    fail(
      "insecure_box",
      `Refusing ${boxUrl.protocol}//${boxUrl.host}: the box must be https (plain http only on 127.0.0.1, localhost or ::1).`,
      { exitCode: 2 },
    );
  }
  if (boxUrl.username || boxUrl.password) usage("--box must not carry credentials.");
  const box = boxUrl.origin + boxUrl.pathname.replace(/\/+$/, "");

  const viaFlag = values.via ?? process.env.RELAY_CLIENT_VIA;
  let via = null;
  if (viaFlag) {
    let viaUrl;
    try {
      viaUrl = new URL(viaFlag);
    } catch {
      usage(`--via is not a URL: ${viaFlag}`);
    }
    if (viaUrl.username || viaUrl.password || viaUrl.search || viaUrl.hash || viaUrl.pathname !== "/") usage("--via is an origin only, like http://100.101.102.103.");
    const plainOk = viaUrl.protocol === "http:" && (isTailnetHost(viaUrl.hostname) || kLoopbackHosts.has(viaUrl.hostname));
    if (viaUrl.protocol !== "https:" && !plainOk) {
      fail(
        "insecure_box",
        `Refusing ${viaUrl.protocol}//${viaUrl.host}: --via must be https, or plain http to a tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48, *.ts.net).`,
        { exitCode: 2 },
      );
    }
    via = viaUrl.origin;
  }
  const proxyFlag = values.proxy ?? process.env.RELAY_CLIENT_PROXY;
  let proxy = null;
  if (proxyFlag) {
    let proxyUrl;
    try {
      proxyUrl = new URL(proxyFlag);
    } catch {
      usage(`--proxy is not a URL: ${proxyFlag}`);
    }
    if (proxyUrl.protocol !== "http:" || !kLoopbackHosts.has(proxyUrl.hostname) || proxyUrl.username || proxyUrl.password) {
      usage("--proxy is a loopback http proxy, like http://127.0.0.1:1055 (tailscaled --outbound-http-proxy-listen).");
    }
    if (!via || !via.startsWith("http:")) usage("--proxy needs --via with a plain http tailnet address.");
    proxy = proxyUrl;
  }
  // Every request to the box: to --via when set, through --proxy when set.
  const boxFetch = (pathname, init) => {
    const target = (via ?? box) + pathname;
    return proxy ? fetchThroughProxy(proxy, target, init) : fetch(target, init);
  };

  const capabilityFile = path.resolve(
    values["capability-file"] ??
      process.env.RELAY_CLIENT_CAPABILITY_FILE ??
      path.join(os.homedir(), ".relay-client", "capability.json"),
  );
  const tokenCacheFile = `${capabilityFile}.token.json`;

  const readBinding = () => {
    let binding;
    try {
      binding = JSON.parse(fs.readFileSync(capabilityFile, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") fail("not_bound", `No capability file at ${capabilityFile}: run bind or claim first.`);
      fail("capability_file_invalid", `Cannot read the capability file ${capabilityFile}.`);
    }
    if (typeof binding?.capability !== "string" || typeof binding.agent !== "string") {
      fail("capability_file_invalid", `The capability file ${capabilityFile} has no agent or capability.`);
    }
    secrets.add(binding.capability);
    if (binding.box !== box) {
      fail("box_mismatch", `The capability file ${capabilityFile} belongs to ${binding.box}, not ${box}.`);
    }
    return binding;
  };

  const readText = () => {
    if (values.text !== undefined && values["text-file"] !== undefined) usage("Pass --text or --text-file, not both.");
    if (values.text !== undefined) return values.text;
    const file = values["text-file"] ?? usage(`--text or --text-file is required for ${command}.`);
    return fs.readFileSync(file === "-" ? 0 : file, "utf8");
  };

  const messageOptions = () => {
    let approval;
    if (values["approval-file"] !== undefined) {
      try {
        approval = JSON.parse(fs.readFileSync(values["approval-file"], "utf8"));
      } catch {
        usage(`--approval-file ${values["approval-file"]} is not a readable JSON file.`);
      }
    }
    if (values.summary !== undefined && !values.summary.trim()) usage(`--summary is empty. ${kSummaryUsage}`);
    return {
      ...(values.lane !== undefined ? { lane: values.lane } : {}),
      ...(values.summary !== undefined ? { summary: values.summary } : {}),
      ...(approval !== undefined ? { approval } : {}),
      ...(values["confirmation-ref"] !== undefined ? { confirmation_ref: values["confirmation-ref"] } : {}),
    };
  };

  // The liaison key (GST-2323 PR4): an Ed25519 private key that lives only
  // in a 0600 file on this machine. keygen makes it and prints only the
  // public key; with --key-file, send, history and result are signed with
  // it, and no capability or token is read or sent.
  const keyFileFlag = values["key-file"] ?? process.env.RELAY_CLIENT_KEY_FILE;
  if (command === "keygen") {
    const keyFile = path.resolve(keyFileFlag ?? path.join(os.homedir(), ".capy", "work", "relay", "liaison-key.json"));
    const agent = required("agent");
    if (!/^capy-[a-z0-9-]{1,43}$/.test(agent)) usage("--agent must be the binding's capy-... agent name.");
    if (fs.existsSync(keyFile)) fail("key_exists", `${keyFile} already holds a key: remove it first to make a new one.`);
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const privateDer = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
    secrets.add(privateDer);
    const publicRaw = publicKey.export({ format: "jwk" }).x;
    writePrivateFile(keyFile, JSON.stringify({ box, agent, private_key: privateDer, public_key: publicRaw }, null, 2));
    process.stdout.write(
      JSON.stringify({ agent, box, key_file: keyFile, public_key: publicRaw, env_entry: `${agent}:${publicRaw}` }, null, 2) + "\n",
    );
    return;
  }
  if (keyFileFlag !== undefined) {
    if (!kKeyCommands.has(command)) usage(`--key-file serves ${[...kKeyCommands].join(", ")} only.`);
    const keyFile = path.resolve(keyFileFlag);
    let stat;
    try {
      stat = fs.statSync(keyFile);
    } catch {
      fail("key_file_missing", `No liaison key file at ${keyFile}: run keygen first.`);
    }
    if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      fail("key_file_mode", `Refusing ${keyFile}: it must be owned by you and readable by you only (chmod 600).`, { exitCode: 2 });
    }
    let key;
    try {
      key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    } catch {
      fail("key_file_invalid", `Cannot read the liaison key file ${keyFile}.`);
    }
    if (typeof key?.private_key !== "string" || typeof key.agent !== "string") fail("key_file_invalid", `The liaison key file ${keyFile} has no agent or key.`);
    secrets.add(key.private_key);
    if (key.box !== box) fail("box_mismatch", `The liaison key file ${keyFile} belongs to ${key.box}, not ${box}.`);
    const [keyTool, keyArgs] = {
      send: () => ["relay_send", { to: required("to"), text: readText(), ...messageOptions() }],
      history: () => [
        "relay_history",
        {
          with: required("with"),
          ...(values.limit !== undefined ? { limit: integer("limit") } : {}),
          ...(values.lane !== undefined ? { lane: values.lane } : {}),
        },
      ],
      result: () => ["relay_result", { result_ref: required("result-ref"), ...(values.part !== undefined ? { part: integer("part") } : {}) }],
      renew: () => [
        "relay_renew",
        { ...(values["webhook-url"] !== undefined ? { webhook_url: values["webhook-url"] } : {}), ...(values.until !== undefined ? { until: values.until } : {}) },
      ],
    }[command]();
    const body = JSON.stringify({ tool: keyTool, args: keyArgs });
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(18).toString("base64url");
    const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(key.private_key, "base64url"), format: "der", type: "pkcs8" });
    const signature = crypto
      .sign(null, Buffer.from(keySigningInput({ method: "POST", path: kKeyPath, agent: key.agent, timestamp, nonce, bodyHash }), "utf8"), privateKey)
      .toString("base64url");
    const response = await boxFetch(kKeyPath, {
      method: "POST",
      headers: {
        "Content-Type": kKeyContentType,
        Accept: "application/json",
        "x-relay-agent": key.agent,
        "x-relay-timestamp": timestamp,
        "x-relay-nonce": nonce,
        "x-relay-signature": signature,
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(kRequestTimeoutMs),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || typeof result !== "object") {
      fail(
        typeof result?.error === "string" ? result.error : "key_call_failed",
        typeof result?.message === "string" ? result.message : `The box answered ${keyTool} with HTTP ${response.status}.`,
        { fix: typeof result?.fix === "string" ? result.fix : undefined },
      );
    }
    process.stdout.write(redactText(JSON.stringify(redactValue(result), null, 2)) + "\n");
    return;
  }

  let tool;
  let args;
  let binding;
  let codeFile;
  if (command === "bind") {
    if (fs.existsSync(capabilityFile)) {
      fail("already_bound", `${capabilityFile} already holds a binding: use renew, or unbind first.`);
    }
    tool = "relay_bind";
    args = {
      ...(values["thread-id"] !== undefined ? { thread_id: values["thread-id"] } : {}),
      webhook_url: required("webhook-url"),
      ...(values.until !== undefined ? { until: values.until } : {}),
    };
  } else if (command === "renew") {
    binding = readBinding();
    tool = "relay_bind";
    args = {
      thread_id: binding.thread_id,
      webhook_url: values["webhook-url"] ?? binding.webhook_url,
      capability: binding.capability,
      ...(values.until !== undefined ? { until: values.until } : {}),
    };
  } else if (command === "claim") {
    // A handoff from an attested holder needs no code: the box checks this
    // machine's own Capy token against the thread the handoff named.
    let code;
    if (values["code-file"] !== undefined) {
      codeFile = path.resolve(values["code-file"]);
      try {
        code = fs.readFileSync(codeFile, "utf8").trim();
      } catch {
        fail("handoff_code_unreadable", `Cannot read the handoff code file ${codeFile}.`);
      }
      if (!code) fail("handoff_code_unreadable", `The handoff code file ${codeFile} is empty.`);
      secrets.add(code);
    }
    tool = "relay_claim";
    args = {
      as: required("agent"),
      ...(code ? { handoff_code: code } : {}),
      ...(values["thread-id"] !== undefined ? { thread_id: values["thread-id"] } : {}),
      ...(values["webhook-url"] !== undefined ? { webhook_url: values["webhook-url"] } : {}),
    };
  } else {
    const toolArgs = {
      unbind: () => ["relay_unbind", {}],
      send: () => ["relay_send", { to: required("to"), text: readText(), ...messageOptions() }],
      reply: () => ["relay_reply", { message_id: required("message-id"), text: readText(), ...messageOptions() }],
      inbox: () => ["relay_inbox", {}],
      history: () => [
        "relay_history",
        {
          with: required("with"),
          ...(values.limit !== undefined ? { limit: integer("limit") } : {}),
          ...(values.lane !== undefined ? { lane: values.lane } : {}),
        },
      ],
      result: () => [
        "relay_result",
        { result_ref: required("result-ref"), ...(values.part !== undefined ? { part: integer("part") } : {}) },
      ],
      handoff: () => {
        if (values["code-file"] !== undefined) codeFile = path.resolve(values["code-file"]);
        return [
          "relay_handoff",
          {
            successor_thread: required("successor-thread"),
            ...(values["webhook-url"] !== undefined ? { webhook_url: values["webhook-url"] } : {}),
          },
        ];
      },
    }[command]();
    binding = readBinding();
    tool = toolArgs[0];
    args = { as: binding.agent, capability: binding.capability, ...toolArgs[1] };
  }

  const tokenFile = values["token-file"] ?? process.env.CAPY_OIDC_TOKEN_FILE;
  if (!tokenFile) {
    fail("attestation_stale", "CAPY_OIDC_TOKEN_FILE is not set: this machine has no Capy OIDC token to present.");
  }
  let jwt;
  try {
    jwt = fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    fail(
      "attestation_stale",
      `Cannot read the Capy OIDC token file ${tokenFile}. Capy refreshes it while the machine is awake; try again shortly.`,
    );
  }
  secrets.add(jwt);
  let claims;
  try {
    claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  } catch {
    fail("attestation_stale", `The Capy OIDC token file ${tokenFile} does not hold a JWT.`);
  }
  if (typeof claims?.exp !== "number" || claims.exp * 1000 - Date.now() < kFreshnessMarginMs) {
    fail(
      "attestation_stale",
      `The Capy OIDC token in ${tokenFile} has expired or expires within 30 s. Capy refreshes it while the machine is awake; try again shortly.`,
    );
  }
  const jti =
    typeof claims.jti === "string" && claims.jti ? claims.jti : crypto.createHash("sha256").update(jwt).digest("hex");

  const getAccessToken = async ({ force }) => {
    if (!force) {
      let cached = null;
      try {
        cached = JSON.parse(fs.readFileSync(tokenCacheFile, "utf8"));
      } catch {}
      if (
        typeof cached?.access_token === "string" &&
        cached.box === box &&
        cached.jti === jti &&
        cached.expires_at - Date.now() > kFreshnessMarginMs
      ) {
        secrets.add(cached.access_token);
        return cached.access_token;
      }
    }
    const response = await boxFetch("/relay/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: kJwtBearerGrant, assertion: jwt, resource: `${box}/relay/mcp` }),
      redirect: "error",
      signal: AbortSignal.timeout(kRequestTimeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (typeof body?.access_token === "string") secrets.add(body.access_token);
    if (!response.ok || typeof body?.access_token !== "string") {
      fail(
        typeof body?.error === "string" ? body.error : "token_exchange_failed",
        typeof body?.error_description === "string"
          ? body.error_description
          : `The box answered the token exchange with HTTP ${response.status}.`,
      );
    }
    const expiresAt = Math.min(Date.now() + (Number(body.expires_in) || 0) * 1000, claims.exp * 1000);
    writePrivateFile(tokenCacheFile, JSON.stringify({ access_token: body.access_token, expires_at: expiresAt, jti, box }));
    return body.access_token;
  };

  const requestId = 1;
  const postToolCall = (accessToken) =>
    boxFetch("/relay/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name: tool, arguments: args } }),
      redirect: "error",
      signal: AbortSignal.timeout(kRequestTimeoutMs),
    });

  let response = await postToolCall(await getAccessToken({ force: false }));
  if (response.status === 401) {
    response = await postToolCall(await getAccessToken({ force: true }));
    if (response.status === 401) {
      fail(
        "unauthorized",
        "The box refused a freshly exchanged access token twice: this machine's identity is not accepted for the relay.",
      );
    }
  }
  const raw = await response.text();
  let message;
  if ((response.headers.get("content-type") || "").includes("text/event-stream")) {
    for (const event of raw.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      try {
        const candidate = JSON.parse(data);
        if (candidate?.id === requestId) message = candidate;
      } catch {}
    }
  } else {
    try {
      message = JSON.parse(raw);
    } catch {}
  }
  if (!message || typeof message !== "object") {
    fail("bad_response", `The box answered ${tool} with HTTP ${response.status} and no JSON-RPC response.`);
  }
  if (message.error) {
    fail("rpc_error", `The box rejected ${tool}: ${message.error.message || `JSON-RPC error ${message.error.code}`}`);
  }
  const text = (message.result?.content || []).find((part) => part?.type === "text")?.text ?? "";
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { text };
  }
  for (const key of kSecretKeys) {
    if (typeof result?.[key] === "string") secrets.add(result[key]);
  }
  if (message.result?.isError) {
    fail(
      typeof result?.error === "string" ? result.error : "tool_error",
      typeof result?.message === "string" ? result.message : text,
      { fix: typeof result?.fix === "string" ? result.fix : undefined },
    );
  }

  if (command === "bind" || command === "renew" || command === "claim") {
    const capability = result.capability ?? binding?.capability;
    const agent = result.agent ?? binding?.agent ?? args.as;
    if (typeof capability !== "string" || typeof agent !== "string") {
      fail("bad_response", `The box answered ${tool} without an agent and capability.`);
    }
    writePrivateFile(
      capabilityFile,
      JSON.stringify(
        {
          box,
          agent,
          capability,
          thread_id: args.thread_id ?? result.thread_id ?? null,
          webhook_url: args.webhook_url ?? result.webhook_url ?? null,
        },
        null,
        2,
      ),
    );
    if (command === "claim" && codeFile) fs.rmSync(codeFile, { force: true });
  } else if (command === "unbind") {
    fs.rmSync(capabilityFile, { force: true });
  } else if (command === "handoff" && typeof result.handoff_code === "string") {
    // An attested holder gets no code; any other holder's code goes only to
    // --code-file, and a handoff made without one is redone with it.
    if (!codeFile) fail("usage", "This box answered with a handoff code: run handoff again with --code-file.", { exitCode: 2 });
    writePrivateFile(codeFile, `${result.handoff_code}\n`);
  }
  process.stdout.write(redactText(JSON.stringify(redactValue(result), null, 2)) + "\n");
};

try {
  await main();
} catch (err) {
  const error =
    err instanceof ClientError
      ? { error: err.code, message: err.message, ...(err.fix ? { fix: err.fix } : {}) }
      : { error: "client_error", message: `${err?.message || err}${err?.cause?.message ? `: ${err.cause.message}` : ""}` };
  process.stderr.write(redactText(JSON.stringify(error)) + "\n");
  process.exitCode = err instanceof ClientError ? err.exitCode : 1;
}
