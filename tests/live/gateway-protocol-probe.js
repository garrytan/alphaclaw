const crypto = require("crypto");
const WebSocket = require("ws");

// A minimal OpenClaw gateway protocol client for live tests: answers the
// connect challenge with a signed device identity (payload v3, as
// packages/gateway-client/src/device-auth.ts builds it) and runs a few
// methods after hello-ok.

const newDevice = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    id: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKey: raw.toString("base64url"),
    privateKey,
  };
};

const signConnect = ({ device, clientId, clientMode, role, scopes, token, nonce, platform }) => {
  const signedAt = Date.now();
  const payload = ["v3", device.id, clientId, clientMode, role, scopes.join(","), String(signedAt), token || "", nonce, platform.toLowerCase(), ""].join("|");
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), device.privateKey).toString("base64url");
  return { id: device.id, publicKey: device.publicKey, signature, signedAt, nonce };
};

const connectGateway = ({
  url,
  origin = null,
  headers = {},
  localAddress = undefined,
  clientId = "cli",
  clientMode = "cli",
  role = "operator",
  scopes = [],
  auth = {},
  device = null,
  platform = "linux",
  calls = [],
  timeoutMs = 15_000,
}) =>
  new Promise((resolve) => {
    const result = { upgradeStatus: null, connect: null, deviceToken: null, calls: [] };
    const ws = new WebSocket(url, { headers: { ...(origin ? { Origin: origin } : {}), ...headers }, ...(localAddress ? { localAddress } : {}) });
    const finish = () => {
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => {
      result.error = "timeout";
      finish();
    }, timeoutMs);
    const pending = new Map();
    let seq = 0;
    const request = (method, params) =>
      new Promise((done) => {
        const id = `r${(seq += 1)}`;
        pending.set(id, done);
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      });
    ws.on("unexpected-response", (_req, res) => {
      result.upgradeStatus = res.statusCode;
      finish();
    });
    ws.on("error", (err) => {
      result.error = String(err?.message || err);
      finish();
    });
    ws.on("close", finish);
    ws.on("open", () => {
      result.upgradeStatus = 101;
    });
    ws.on("message", async (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type === "res" && pending.has(frame.id)) {
        const done = pending.get(frame.id);
        pending.delete(frame.id);
        done(frame);
        return;
      }
      if (frame.type !== "event" || frame.event !== "connect.challenge") return;
      const nonce = frame.payload?.nonce;
      const token = auth.token ?? auth.deviceToken ?? auth.bootstrapToken ?? null;
      const res = await request("connect", {
        minProtocol: 4,
        maxProtocol: 4,
        client: { id: clientId, version: "live-test", platform, mode: clientMode },
        role,
        scopes,
        caps: [],
        commands: [],
        permissions: {},
        auth,
        locale: "en-US",
        userAgent: "alphaclaw-live-probe/1",
        ...(device ? { device: signConnect({ device, clientId, clientMode, role, scopes, token, nonce, platform }) } : {}),
      });
      result.connect = res.ok
        ? { ok: true, role: res.payload?.auth?.role, scopes: res.payload?.auth?.scopes || [] }
        : { ok: false, code: res.error?.code, detailCode: res.error?.details?.code, reason: res.error?.details?.authReason, message: res.error?.message };
      result.deviceToken = res.payload?.auth?.deviceToken || null;
      if (res.ok) {
        for (const call of calls) {
          const out = await request(call.method, call.params || {});
          result.calls.push({ method: call.method, ok: out.ok, error: out.ok ? null : `${out.error?.code}: ${out.error?.message}` });
        }
      }
      finish();
    });
  });

module.exports = { connectGateway, newDevice };
