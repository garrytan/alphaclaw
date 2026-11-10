const dns = require("dns");
const https = require("https");
const net = require("net");
const { RelayError } = require("./errors");

// Wakes a bound Capy thread when a relay message reaches its capy-* agent:
// POST {status, code, from, to, message_id, thread_id, lane, generation,
// untrusted: true, text}
// to the thread's own Capy webhook URL. The text is another agent's words,
// so the payload says it is untrusted data.
//
// The URL is attacker-shaped input (a remote caller supplies it), so every
// delivery is guarded: https on port 443 only, no credentials, the host on
// the allowlist (Capy's api.capy.ai by default), every resolved address
// public (no loopback, private, link-local or CGNAT), the connection pinned
// to the address that was checked, and redirects never followed. A 404 or
// 410 marks the binding dead (its Capy watch ended); other failures,
// including a DNS outage, retry with backoff (10 s up to 1 h, then give up,
// about 1 h 45 min in all). A binding past its until date, or whose client
// was revoked, is never woken; that is checked again after the DNS lookup,
// right before the POST. At most one wake per binding waits at a time, and
// a binding is woken at most once a minute: a message that arrives while
// a wake is pending is read with relay_inbox, and one that arrives within
// a minute of the last delivered wake is held until that minute is up, so
// another agent cannot flood a thread with paid wakes.
const kWakeTextChars = 2000;
const kWakeMinIntervalMs = 60_000;
const kPumpRetryMs = 5_000;
const kWakeTimeoutMs = 10000;
const kWakeBackoffMs = Object.freeze([10_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000]);

const kBlockedV4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const v4ToInt = (address) => address.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
const isPublicAddress = (address) => {
  if (net.isIPv4(address)) {
    const value = v4ToInt(address);
    return !kBlockedV4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (v4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return false;
    if (lower.startsWith("::ffff:")) return isPublicAddress(lower.slice(7));
    if (/^f[cd]/.test(lower)) return false;
    if (/^fe[89ab]/.test(lower)) return false;
    if (lower.startsWith("ff")) return false;
    if (lower.startsWith("64:ff9b:")) return false;
    return true;
  }
  return false;
};

const validateWakeUrl = (raw, { allowedHosts }) => {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    throw new RelayError("wake_url_refused", "webhook_url is not a URL.");
  }
  if (url.protocol !== "https:") throw new RelayError("wake_url_refused", "webhook_url must be https.");
  if (url.port && url.port !== "443") throw new RelayError("wake_url_refused", "webhook_url must use port 443.");
  if (url.username || url.password) throw new RelayError("wake_url_refused", "webhook_url must not carry credentials.");
  if (url.hash) throw new RelayError("wake_url_refused", "webhook_url must not have a fragment.");
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) throw new RelayError("wake_url_refused", "webhook_url host " + host + " is not allowed.");
  if (String(raw).length > 2048) throw new RelayError("wake_url_refused", "webhook_url is too long.");
  return url;
};

// A policy refusal (a non-public address) carries refused: true; a lookup
// that failed is retried like any other delivery failure.
const resolvePublicAddress = async (host, lookup = dns.promises.lookup) => {
  const refuse = (message) => Object.assign(new Error(message), { refused: true });
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw refuse("address " + host + " is not public");
    return { address: host, family: net.isIPv4(host) ? 4 : 6 };
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("no address for " + host);
  const blocked = addresses.filter((entry) => !isPublicAddress(entry.address));
  if (blocked.length) throw refuse(host + " resolves to a non-public address");
  return addresses[0];
};

// timeoutMs bounds the whole request, response body included, so a
// webhook that trickles bytes cannot hold the serial wake queue.
const postPinned = ({ url, body, pinned, timeoutMs = kWakeTimeoutMs, requestImpl = https.request, setTimer = setTimeout, clearTimer = clearTimeout }) =>
  new Promise((resolveOuter) => {
    let settled = false;
    let deadline = null;
    const resolve = (result) => {
      if (settled) return;
      settled = true;
      clearTimer(deadline);
      resolveOuter(result);
    };
    const req = requestImpl(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "user-agent": "alphaclaw-relay-wake" },
        lookup: (_hostname, options, callback) =>
          options && options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode || 0 }));
        res.on("error", () => resolve({ status: res.statusCode || 0 }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out after " + timeoutMs + "ms")));
    req.on("error", (error) => resolve({ status: 0, error: String(error?.message || error) }));
    deadline = setTimer(() => {
      resolve({ status: 0, error: "timed out after " + timeoutMs + "ms" });
      req.destroy();
    }, timeoutMs);
    deadline?.unref?.();
    req.end(body);
  });

const buildWakePayload = ({ message, recipient }) => {
  const metadata = message?.metadata || {};
  const text = String(message?.text || "");
  return {
    source: "alphaclaw-relay",
    status: metadata.relay_status || "message",
    code: metadata.relay_code || null,
    from: message?.agent_name || null,
    to: recipient,
    message_id: String(message?.id || ""),
    thread_id: message?.thread_id || metadata.thread_id || null,
    lane: typeof metadata.relay_lane === "string" ? metadata.relay_lane : null,
    ...(metadata.relay_result_ref ? { result_ref: metadata.relay_result_ref, result_parts: metadata.relay_result_parts || null } : {}),
    ...(metadata.relay_provenance ? { owner_provenance: "signed; relay_history shows it and whether it verifies" } : {}),
    untrusted: true,
    text: text.length > kWakeTextChars ? text.slice(0, kWakeTextChars) + "…" : text,
    truncated: text.length > kWakeTextChars,
    read_with: "relay_inbox or relay_history (as " + recipient + ")",
  };
};

const createWakeDelivery = ({
  store,
  getConfig,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  lookup = dns.promises.lookup,
  requestImpl = https.request,
  logger = console,
}) => {
  const state = { timer: null, running: false, stopped: true };
  const log = (line) => logger.log("[relay] wake " + line);

  const dropReasonFor = (agent) => {
    const binding = store.bindings.get(agent);
    const client = binding ? store.clients.get(binding.clientId) : null;
    const reason = !binding
      ? "binding removed"
      : binding.deadAt
        ? "binding dead"
        : binding.until < now()
          ? "binding expired"
          : !client || client.revokedAt
            ? "client revoked"
            : null;
    return { binding, reason };
  };

  const deliverOne = async (wake) => {
    const { binding, reason: dropReason } = dropReasonFor(wake.agent);
    if (dropReason) {
      store.wakes.settle(wake.id, "dropped", dropReason);
      return;
    }
    let url;
    let pinned = null;
    let result;
    try {
      url = validateWakeUrl(binding.webhookUrl, { allowedHosts: getConfig().wakeHosts });
      pinned = await resolvePublicAddress(url.hostname, lookup);
    } catch (error) {
      if (error instanceof RelayError || error?.refused) {
        store.wakes.settle(wake.id, "refused", String(error?.message || error));
        store.bindings.noteWake(wake.agent, "refused");
        log("agent=" + wake.agent + " message=" + wake.messageId + " refused: " + String(error?.message || error));
        return;
      }
      result = { status: 0, error: "lookup failed: " + String(error?.code || error?.message || error) };
    }
    if (pinned) {
      const late = dropReasonFor(wake.agent);
      if (late.reason) {
        store.wakes.settle(wake.id, "dropped", late.reason);
        return;
      }
      // A handoff claimed during the lookup moved the wakes to the
      // successor's webhook: this address is the old one, so the wake waits
      // for the next pass instead of going to the previous holder.
      if (late.binding.generation !== binding.generation || late.binding.webhookUrl !== binding.webhookUrl) {
        store.wakes.retry(wake.id, now(), "generation_stale");
        return;
      }
      result = await postPinned({ url, body: JSON.stringify({ ...wake.payload, generation: binding.generation }), pinned, requestImpl });
      // A claim that landed while the POST was in flight: the answer came
      // from the previous holder's webhook, so it neither settles the wake
      // nor marks the successor's binding dead; the wake goes to the
      // successor on the next pass.
      const after = store.bindings.get(wake.agent);
      if (after && (after.generation !== binding.generation || after.webhookUrl !== binding.webhookUrl)) {
        store.wakes.retry(wake.id, now(), "generation_stale");
        return;
      }
    }
    if (result.status >= 200 && result.status < 300) {
      store.wakes.settle(wake.id, "delivered");
      store.bindings.noteWake(wake.agent, "delivered");
      log("agent=" + wake.agent + " message=" + wake.messageId + " delivered status=" + result.status);
      return;
    }
    if (result.status === 404 || result.status === 410) {
      store.wakes.settle(wake.id, "dead", "status " + result.status);
      store.bindings.markDead(wake.agent, "dead_" + result.status);
      store.audit("binding_dead", { agent: wake.agent, detail: { status: result.status } });
      log("agent=" + wake.agent + " webhook answered " + result.status + "; binding marked dead");
      return;
    }
    const reason = result.error || "status " + result.status;
    const attempt = wake.attempts + 1;
    if (attempt > kWakeBackoffMs.length) {
      store.wakes.settle(wake.id, "failed", reason);
      store.bindings.noteWake(wake.agent, "failed");
      log("agent=" + wake.agent + " message=" + wake.messageId + " gave up after " + attempt + " attempts: " + reason);
      return;
    }
    store.wakes.retry(wake.id, now() + kWakeBackoffMs[attempt - 1], reason);
    store.bindings.noteWake(wake.agent, "retrying");
  };

  const schedule = (minDelayMs = 0) => {
    if (state.stopped) return;
    if (state.timer) clearTimer(state.timer);
    state.timer = null;
    let nextAt;
    try {
      nextAt = store.wakes.nextDueAt();
    } catch (error) {
      log("schedule failed: " + String(error?.message || error));
      nextAt = now() + kPumpRetryMs;
    }
    if (nextAt === null || nextAt === undefined) return;
    state.timer = setTimer(pump, Math.max(minDelayMs, nextAt - now()));
    state.timer?.unref?.();
  };

  const pump = async () => {
    state.timer = null;
    if (state.running || state.stopped) return;
    state.running = true;
    let failed = false;
    try {
      for (;;) {
        const due = store.wakes.due(10);
        if (!due.length) break;
        for (const wake of due) await deliverOne(wake);
      }
    } catch (error) {
      failed = true;
      log("pump failed: " + String(error?.message || error));
    } finally {
      state.running = false;
      schedule(failed ? kPumpRetryMs : 0);
    }
  };

  const enqueue = ({ agent, message }) => {
    const binding = store.bindings.get(agent);
    if (!binding || binding.deadAt || binding.until < now()) return false;
    if (store.wakes.pendingFor(agent) > 0) {
      log("agent=" + agent + " message=" + String(message?.id || "") + " coalesced into the wake already pending");
      return false;
    }
    const lastDelivered = binding.lastWakeStatus === "delivered" && Number(binding.lastWakeAt) ? Number(binding.lastWakeAt) : null;
    const nextAt = lastDelivered && now() - lastDelivered < kWakeMinIntervalMs ? lastDelivered + kWakeMinIntervalMs : now();
    const queued = store.wakes.enqueue({ agent, messageId: message?.id, payload: buildWakePayload({ message, recipient: agent }), nextAt });
    if (queued && nextAt > now()) {
      log("agent=" + agent + " message=" + String(message?.id || "") + " held until " + new Date(nextAt).toISOString() + " (one wake a minute)");
      schedule();
    } else if (queued) {
      setImmediate(() => pump());
    }
    return queued;
  };

  return {
    enqueue,
    start: () => {
      state.stopped = false;
      schedule();
      setImmediate(() => pump());
    },
    stop: () => {
      state.stopped = true;
      if (state.timer) clearTimer(state.timer);
      state.timer = null;
    },
    _internal: { pump, deliverOne },
  };
};

module.exports = {
  createWakeDelivery,
  validateWakeUrl,
  isPublicAddress,
  resolvePublicAddress,
  postPinned,
  buildWakePayload,
  kWakeBackoffMs,
  kWakeMinIntervalMs,
  kWakeTextChars,
};
