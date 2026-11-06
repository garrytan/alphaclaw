const dns = require("dns");
const https = require("https");
const net = require("net");
const { RelayError } = require("./errors");

// Wakes a bound Capy thread when a relay message reaches its capy-* agent:
// POST {status, code, from, to, message_id, thread_id, untrusted: true, text}
// to the thread's own Capy webhook URL. The text is another agent's words,
// so the payload says it is untrusted data.
//
// The URL is attacker-shaped input (a remote caller supplies it), so every
// delivery is guarded: https on port 443 only, no credentials, the host on
// the allowlist (Capy's api.capy.ai by default), every resolved address
// public (no loopback, private, link-local or CGNAT), the connection pinned
// to the address that was checked, and redirects never followed. A 404 or
// 410 marks the binding dead (its Capy watch ended); other failures retry
// with backoff.
const kWakeTextChars = 2000;
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

const resolvePublicAddress = async (host, lookup = dns.promises.lookup) => {
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new Error("address " + host + " is not public");
    return { address: host, family: net.isIPv4(host) ? 4 : 6 };
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("no address for " + host);
  const blocked = addresses.filter((entry) => !isPublicAddress(entry.address));
  if (blocked.length) throw new Error(host + " resolves to a non-public address");
  return addresses[0];
};

const postPinned = ({ url, body, pinned, timeoutMs = kWakeTimeoutMs, requestImpl = https.request }) =>
  new Promise((resolve) => {
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

  const deliverOne = async (wake) => {
    const binding = store.bindings.get(wake.agent);
    if (!binding || binding.deadAt) {
      store.wakes.settle(wake.id, "dropped", binding ? "binding dead" : "binding removed");
      return;
    }
    let url;
    let pinned;
    try {
      url = validateWakeUrl(binding.webhookUrl, { allowedHosts: getConfig().wakeHosts });
      pinned = await resolvePublicAddress(url.hostname, lookup);
    } catch (error) {
      store.wakes.settle(wake.id, "refused", String(error?.message || error));
      store.bindings.noteWake(wake.agent, "refused");
      log("agent=" + wake.agent + " message=" + wake.messageId + " refused: " + String(error?.message || error));
      return;
    }
    const result = await postPinned({ url, body: JSON.stringify(wake.payload), pinned, requestImpl });
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
    if (attempt >= kWakeBackoffMs.length) {
      store.wakes.settle(wake.id, "failed", reason);
      store.bindings.noteWake(wake.agent, "failed");
      log("agent=" + wake.agent + " message=" + wake.messageId + " gave up after " + attempt + " attempts: " + reason);
      return;
    }
    store.wakes.retry(wake.id, now() + kWakeBackoffMs[attempt - 1], reason);
    store.bindings.noteWake(wake.agent, "retrying");
  };

  const schedule = () => {
    if (state.stopped) return;
    if (state.timer) clearTimer(state.timer);
    state.timer = null;
    const nextAt = store.wakes.nextDueAt();
    if (nextAt === null || nextAt === undefined) return;
    state.timer = setTimer(pump, Math.max(0, nextAt - now()));
    state.timer?.unref?.();
  };

  const pump = async () => {
    state.timer = null;
    if (state.running || state.stopped) return;
    state.running = true;
    try {
      for (;;) {
        const due = store.wakes.due(10);
        if (!due.length) break;
        for (const wake of due) await deliverOne(wake);
      }
    } catch (error) {
      log("pump failed: " + String(error?.message || error));
    } finally {
      state.running = false;
      schedule();
    }
  };

  const enqueue = ({ agent, message }) => {
    const binding = store.bindings.get(agent);
    if (!binding || binding.deadAt || binding.until < now()) return false;
    const queued = store.wakes.enqueue({ agent, messageId: message?.id, payload: buildWakePayload({ message, recipient: agent }) });
    if (queued) setImmediate(() => pump());
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
  kWakeTextChars,
};
