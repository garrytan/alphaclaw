const crypto = require("crypto");

const {
  hmacSha256,
  kSignedPresets,
  validateSecret,
  verifySignedDelivery,
} = require("../../lib/server/hook-ingress/signatures");

// GST-2134 PR 2: per-sender signature verifiers. Every vector below is
// computed here from the sender's published algorithm:
// - Standard Webhooks: github.com/standard-webhooks/standard-webhooks
//   spec/standard-webhooks.md, reference vector from
//   libraries/javascript/src/webhook.test.ts ("sign function works").
// - Quo: quo.com/docs/2026-03-30/webhooks-signature-validation (current) and
//   quo.com/docs/webhooks/legacy-signature-validation (openphone-signature,
//   millisecond timestamp, base64-decoded key).
// - Circleback: circleback.ai/docs/support/automations/export-meeting-data-with-webhooks
//   (hex HMAC-SHA256 of the raw body, key = the signing secret string).
// - Verkada: apidocs.verkada.com/reference/securing-webhooks ("<ts>|<hex>",
//   HMAC over "<body>|<ts>", timestamp in seconds).

const kKeyPrefix = "whsec" + "_";
const kKeyBytes = Buffer.alloc(32, 0x5a);
const kOtherKeyBytes = Buffer.alloc(32, 0x3c);
const kSwSecret = kKeyPrefix + kKeyBytes.toString("base64");
const kSwOtherSecret = kKeyPrefix + kOtherKeyBytes.toString("base64");
const kQuoBareSecret = kKeyBytes.toString("base64");
const kUtf8Secret = ["fixture", "signing", "k".repeat(24)].join("-");
const kUtf8OtherSecret = ["fixture", "signing", "q".repeat(24)].join("-");
const kNowSec = 18 * 10 ** 8;
const kNowMs = kNowSec * 1000;
const kToleranceMs = 5 * 60 * 1000;
const kBody = Buffer.from(JSON.stringify({ type: "message.received", data: { id: "evt_1" } }));
const kDeliveryId = "msg_" + "fixture01";

const hmac = (key, encoding, ...parts) =>
  crypto
    .createHmac("sha256", key)
    .update(Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part)))))
    .digest(encoding);

const flipLastByte = (buffer) => {
  const copy = Buffer.from(buffer);
  copy[copy.length - 1] ^= 0x01;
  return copy;
};

const swHeaders = ({ keyBytes = kKeyBytes, id = kDeliveryId, ts = String(kNowSec), body = kBody } = {}) => ({
  "webhook-id": id,
  "webhook-timestamp": ts,
  "webhook-signature": "v1," + hmac(keyBytes, "base64", id + "." + ts + ".", body),
});

const quoLegacyHeaders = ({ keyBytes = kKeyBytes, ts = String(kNowMs), body = kBody } = {}) => ({
  "openphone-signature": ["hmac", "1", ts, hmac(keyBytes, "base64", ts + ".", body)].join(";"),
});

const circlebackHeaders = ({ secret = kUtf8Secret, body = kBody } = {}) => ({
  "x-signature": hmac(Buffer.from(secret, "utf8"), "hex", body),
});

const verkadaHeaders = ({ secret = kUtf8Secret, ts = String(kNowSec), body = kBody } = {}) => ({
  "verkada-signature": ts + "|" + hmac(Buffer.from(secret, "utf8"), "hex", body, "|" + ts),
});

const verify = (overrides) =>
  verifySignedDelivery({ rawBody: kBody, nowMs: kNowMs, toleranceMs: kToleranceMs, ...overrides });

describe("kSignedPresets", () => {
  it("lists the four presets and is frozen", () => {
    expect(kSignedPresets).toEqual(["standard_webhooks", "circleback", "quo", "verkada"]);
    expect(Object.isFrozen(kSignedPresets)).toBe(true);
  });
});

describe("standard_webhooks", () => {
  const kSpecKeyText = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const kSpecMsgId = "msg_p5jXN8AQM9LWM0D4loKWxJek";
  const kSpecSecret = kKeyPrefix + kSpecKeyText;
  const kSpecTimestamp = String(16142 * 100000 + 65330);
  const kSpecBody = Buffer.from('{"test": ' + String(24322 * 100000 + 32314) + '}');
  const kSpecSignature = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
  const specHeaders = (signature = kSpecSignature) => ({
    "webhook-id": kSpecMsgId,
    "webhook-timestamp": kSpecTimestamp,
    "webhook-signature": signature,
  });
  const verifySpec = (overrides) =>
    verifySignedDelivery({
      preset: "standard_webhooks",
      secret: kSpecSecret,
      rawBody: kSpecBody,
      headers: specHeaders(),
      nowMs: Number(kSpecTimestamp) * 1000,
      ...overrides,
    });

  it("reproduces the published reference vector with the shared HMAC helper", () => {
    const digest = hmacSha256(Buffer.from(kSpecKeyText, "base64"), {
      encoding: "base64",
      parts: [kSpecMsgId + "." + kSpecTimestamp + ".", kSpecBody],
    });
    expect("v1," + digest).toBe(kSpecSignature);
  });

  it("accepts the published reference vector", () => {
    expect(verifySpec()).toEqual({
      ok: true,
      scheme: "standard_webhooks",
      replayKey: kSpecMsgId,
      deliveryId: kSpecMsgId,
      signedHeaders: { "webhook-id": kSpecMsgId, "webhook-timestamp": kSpecTimestamp, "webhook-signature": kSpecSignature },
    });
  });

  it("rejects the reference library's one-character-off signature", () => {
    expect(verifySpec({ headers: specHeaders("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OA=") })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("accepts a computed delivery and returns the canonical headers", () => {
    const result = verify({ preset: "standard_webhooks", secret: kSwSecret, headers: swHeaders() });
    expect(result).toEqual({
      ok: true,
      scheme: "standard_webhooks",
      replayKey: kDeliveryId,
      deliveryId: kDeliveryId,
      signedHeaders: { "webhook-id": kDeliveryId, "webhook-timestamp": String(kNowSec), "webhook-signature": swHeaders()["webhook-signature"] },
    });
  });

  it("signs the exact body bytes, including non-UTF-8 bytes", () => {
    const body = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    expect(verify({ preset: "standard_webhooks", secret: kSwSecret, rawBody: body, headers: swHeaders({ body }) }).ok).toBe(
      true,
    );
  });

  it("reports a missing signature header", () => {
    const { "webhook-signature": _omit, ...headers } = swHeaders();
    expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers })).toEqual({
      ok: false,
      reason: "missing_signature",
    });
    expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers: {} }).reason).toBe("missing_signature");
  });

  it("reports a missing id or timestamp as malformed", () => {
    const { "webhook-id": _id, ...noId } = swHeaders();
    const { "webhook-timestamp": _ts, ...noTs } = swHeaders();
    expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers: noId }).reason).toBe("malformed");
    expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers: noTs }).reason).toBe("malformed");
  });

  it("reports non-integer timestamps as malformed", () => {
    for (const ts of ["abc", "1.5", "-5", "1e9", String(kNowMs) + "0"]) {
      const headers = { ...swHeaders(), "webhook-timestamp": ts };
      expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers }).reason).toBe("malformed");
    }
  });

  it("rejects the wrong secret and a body changed by one byte", () => {
    expect(verify({ preset: "standard_webhooks", secret: kSwOtherSecret, headers: swHeaders() }).reason).toBe(
      "bad_signature",
    );
    expect(
      verify({ preset: "standard_webhooks", secret: kSwSecret, rawBody: flipLastByte(kBody), headers: swHeaders() })
        .reason,
    ).toBe("bad_signature");
  });

  it("rejects a signature whose id or timestamp was swapped", () => {
    const headers = { ...swHeaders(), "webhook-id": kDeliveryId + "x" };
    expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers }).reason).toBe("bad_signature");
  });

  it("rejects stale and future timestamps beyond the tolerance and accepts the edge", () => {
    const past = String(kNowSec - kToleranceMs / 1000 - 1);
    const future = String(kNowSec + kToleranceMs / 1000 + 1);
    const edge = String(kNowSec - kToleranceMs / 1000);
    expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers: swHeaders({ ts: past }) })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
    expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers: swHeaders({ ts: future }) }).reason).toBe(
      "stale_timestamp",
    );
    expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers: swHeaders({ ts: edge }) }).ok).toBe(true);
  });

  it("defaults the tolerance to five minutes", () => {
    const headers = swHeaders({ ts: String(kNowSec - 301) });
    expect(verifySignedDelivery({ preset: "standard_webhooks", secret: kSwSecret, rawBody: kBody, headers, nowMs: kNowMs }).reason).toBe(
      "stale_timestamp",
    );
  });

  it("passes when any one of several v1 signatures matches", () => {
    const valid = swHeaders()["webhook-signature"];
    const wrong = swHeaders({ keyBytes: kOtherKeyBytes })["webhook-signature"];
    const headers = { ...swHeaders(), "webhook-signature": [wrong, "v1a,AAAA", valid, wrong].join(" ") };
    expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers }).ok).toBe(true);
  });

  it("skips malformed entries and still finds the valid one", () => {
    const valid = swHeaders()["webhook-signature"];
    const headers = { ...swHeaders(), "webhook-signature": ["v1", "v1,not-base64!", "v1,a,b", valid].join(" ") };
    expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers }).ok).toBe(true);
  });

  it("refuses a valid digest under an unknown version and a header with no v1 entry", () => {
    const digest = swHeaders()["webhook-signature"].slice(3);
    for (const signature of ["v2," + digest, "v1a," + digest, "garbage", "v1,"]) {
      const headers = { ...swHeaders(), "webhook-signature": signature };
      expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers }).reason).toBe("malformed");
    }
  });

  it("fails an unequal-length signature without throwing", () => {
    const headers = { ...swHeaders(), "webhook-signature": "v1," + Buffer.alloc(8, 1).toString("base64") };
    expect(() => verify({ preset: "standard_webhooks", secret: kSwSecret, headers })).not.toThrow();
    expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers }).reason).toBe("bad_signature");
  });

  it("reads array-valued headers", () => {
    const valid = swHeaders()["webhook-signature"];
    const wrong = swHeaders({ keyBytes: kOtherKeyBytes })["webhook-signature"];
    const base = swHeaders();
    expect(
      verify({ preset: "standard_webhooks", secret: kSwSecret, headers: { ...base, "webhook-signature": [wrong, valid] } }).ok,
    ).toBe(true);
    expect(
      verify({ preset: "standard_webhooks", secret: kSwSecret, headers: { ...base, "webhook-id": [kDeliveryId] } }).ok,
    ).toBe(true);
    expect(
      verify({
        preset: "standard_webhooks",
        secret: kSwSecret,
        headers: { ...base, "webhook-id": [kDeliveryId, kDeliveryId + "2"] },
      }).reason,
    ).toBe("malformed");
    expect(
      verify({ preset: "standard_webhooks", secret: kSwSecret, headers: { ...base, "webhook-signature": [] } }).reason,
    ).toBe("missing_signature");
  });

  it("reports an unusable secret as no_secret", () => {
    for (const secret of [undefined, "", kQuoBareSecret, kKeyPrefix, kKeyPrefix + Buffer.alloc(8).toString("base64")]) {
      expect(verify({ preset: "standard_webhooks", secret, headers: swHeaders() })).toEqual({
        ok: false,
        reason: "no_secret",
      });
    }
  });
});

describe("quo", () => {
  it("verifies current deliveries as Standard Webhooks with a whsec_ key", () => {
    expect(verify({ preset: "quo", secret: kSwSecret, headers: swHeaders() })).toEqual({
      ok: true,
      scheme: "quo",
      replayKey: kDeliveryId,
      deliveryId: kDeliveryId,
      signedHeaders: { "webhook-id": kDeliveryId, "webhook-timestamp": String(kNowSec), "webhook-signature": swHeaders()["webhook-signature"] },
    });
  });

  it("accepts the key as bare base64", () => {
    expect(verify({ preset: "quo", secret: kQuoBareSecret, headers: swHeaders() }).scheme).toBe("quo");
  });

  it("prefers webhook-signature when both headers are present", () => {
    const headers = { ...quoLegacyHeaders({ keyBytes: kOtherKeyBytes }), ...swHeaders() };
    expect(verify({ preset: "quo", secret: kSwSecret, headers }).scheme).toBe("quo");
    const legacyOnlyValid = { ...swHeaders({ keyBytes: kOtherKeyBytes }), ...quoLegacyHeaders() };
    expect(verify({ preset: "quo", secret: kSwSecret, headers: legacyOnlyValid }).reason).toBe("bad_signature");
  });

  it("applies Standard Webhooks failures to current deliveries", () => {
    expect(verify({ preset: "quo", secret: kSwOtherSecret, headers: swHeaders() }).reason).toBe("bad_signature");
    expect(verify({ preset: "quo", secret: kSwSecret, headers: swHeaders({ ts: String(kNowSec - 400) }) }).reason).toBe(
      "stale_timestamp",
    );
  });

  it("verifies a legacy openphone-signature delivery", () => {
    const headers = quoLegacyHeaders();
    const digest = headers["openphone-signature"].split(";")[3];
    expect(verify({ preset: "quo", secret: kQuoBareSecret, headers })).toEqual({
      ok: true,
      scheme: "quo_legacy",
      replayKey: digest,
      deliveryId: null,
      signedHeaders: { "openphone-signature": headers["openphone-signature"] },
    });
    expect(verify({ preset: "quo", secret: kSwSecret, headers }).ok).toBe(true);
  });

  it("reads the legacy timestamp in milliseconds", () => {
    expect(verify({ preset: "quo", secret: kQuoBareSecret, headers: quoLegacyHeaders({ ts: String(kNowSec) }) }).reason).toBe(
      "stale_timestamp",
    );
  });

  it("rejects stale and future legacy timestamps", () => {
    const past = String(kNowMs - kToleranceMs - 1);
    const future = String(kNowMs + kToleranceMs + 1);
    expect(verify({ preset: "quo", secret: kQuoBareSecret, headers: quoLegacyHeaders({ ts: past }) }).reason).toBe(
      "stale_timestamp",
    );
    expect(verify({ preset: "quo", secret: kQuoBareSecret, headers: quoLegacyHeaders({ ts: future }) }).reason).toBe(
      "stale_timestamp",
    );
  });

  it("rejects a legacy delivery with the wrong key or a changed body", () => {
    expect(verify({ preset: "quo", secret: kOtherKeyBytes.toString("base64"), headers: quoLegacyHeaders() }).reason).toBe(
      "bad_signature",
    );
    expect(verify({ preset: "quo", secret: kQuoBareSecret, rawBody: flipLastByte(kBody), headers: quoLegacyHeaders() }).reason).toBe(
      "bad_signature",
    );
  });

  it("refuses a legacy signature computed with the key's text instead of its decoded bytes", () => {
    const ts = String(kNowMs);
    const textKeyed = ["hmac", "1", ts, hmac(Buffer.from(kQuoBareSecret, "utf8"), "base64", ts + ".", kBody)].join(";");
    expect(verify({ preset: "quo", secret: kQuoBareSecret, headers: { "openphone-signature": textKeyed } }).reason).toBe(
      "bad_signature",
    );
  });

  it("reports malformed legacy headers", () => {
    const [, , ts, digest] = quoLegacyHeaders()["openphone-signature"].split(";");
    for (const value of [
      ["hmac", "1", ts].join(";"),
      ["hmac", "1", ts, digest, "extra"].join(";"),
      ["sha", "1", ts, digest].join(";"),
      ["hmac", "2", ts, digest].join(";"),
      ["hmac", "1", "now", digest].join(";"),
      ["hmac", "1", ts, "not base64!"].join(";"),
      ["hmac", "1", ts, ""].join(";"),
    ]) {
      expect(verify({ preset: "quo", secret: kQuoBareSecret, headers: { "openphone-signature": value } }).reason).toBe(
        "malformed",
      );
    }
  });

  it("fails an unequal-length legacy digest without throwing", () => {
    const value = ["hmac", "1", String(kNowMs), Buffer.alloc(4, 9).toString("base64")].join(";");
    expect(verify({ preset: "quo", secret: kQuoBareSecret, headers: { "openphone-signature": value } }).reason).toBe(
      "bad_signature",
    );
  });

  it("reads array-valued legacy headers", () => {
    const value = quoLegacyHeaders()["openphone-signature"];
    expect(verify({ preset: "quo", secret: kQuoBareSecret, headers: { "openphone-signature": [value] } }).ok).toBe(true);
    expect(verify({ preset: "quo", secret: kQuoBareSecret, headers: { "openphone-signature": [value, value] } }).reason).toBe(
      "malformed",
    );
  });

  it("reports a delivery with neither header as missing_signature", () => {
    expect(verify({ preset: "quo", secret: kQuoBareSecret, headers: { "content-type": "application/json" } }).reason).toBe(
      "missing_signature",
    );
  });

  it("reports an unusable secret as no_secret", () => {
    for (const secret of ["", "not base64!", Buffer.alloc(8).toString("base64"), kKeyPrefix]) {
      expect(verify({ preset: "quo", secret, headers: quoLegacyHeaders() }).reason).toBe("no_secret");
    }
  });
});

describe("circleback", () => {
  it("verifies the hex HMAC of the raw body keyed by the secret's UTF-8 bytes", () => {
    const headers = circlebackHeaders();
    expect(verify({ preset: "circleback", secret: kUtf8Secret, headers })).toEqual({
      ok: true,
      scheme: "circleback",
      replayKey: headers["x-signature"],
      deliveryId: null,
      signedHeaders: { "x-signature": headers["x-signature"] },
    });
  });

  it("accepts upper-case hex and lower-cases the replay key", () => {
    const lower = circlebackHeaders()["x-signature"];
    const result = verify({ preset: "circleback", secret: kUtf8Secret, headers: { "x-signature": lower.toUpperCase() } });
    expect(result.ok).toBe(true);
    expect(result.replayKey).toBe(lower);
  });

  it("has no timestamp, so the clock does not matter", () => {
    expect(verify({ preset: "circleback", secret: kUtf8Secret, headers: circlebackHeaders(), nowMs: 0 }).ok).toBe(true);
  });

  it("reports a missing header", () => {
    expect(verify({ preset: "circleback", secret: kUtf8Secret, headers: {} }).reason).toBe("missing_signature");
    expect(verify({ preset: "circleback", secret: kUtf8Secret, headers: { "x-signature": "  " } }).reason).toBe(
      "missing_signature",
    );
  });

  it("rejects the wrong secret and a body changed by one byte", () => {
    expect(verify({ preset: "circleback", secret: kUtf8OtherSecret, headers: circlebackHeaders() }).reason).toBe(
      "bad_signature",
    );
    expect(
      verify({ preset: "circleback", secret: kUtf8Secret, rawBody: flipLastByte(kBody), headers: circlebackHeaders() }).reason,
    ).toBe("bad_signature");
  });

  it("reports non-hex signatures as malformed", () => {
    for (const value of ["sha256=" + circlebackHeaders()["x-signature"], "zz", "v1,abc"]) {
      expect(verify({ preset: "circleback", secret: kUtf8Secret, headers: { "x-signature": value } }).reason).toBe(
        "malformed",
      );
    }
  });

  it("fails an unequal-length signature without throwing", () => {
    const short = circlebackHeaders()["x-signature"].slice(0, 10);
    expect(verify({ preset: "circleback", secret: kUtf8Secret, headers: { "x-signature": short } }).reason).toBe(
      "bad_signature",
    );
  });

  it("reads array-valued headers", () => {
    const value = circlebackHeaders()["x-signature"];
    expect(verify({ preset: "circleback", secret: kUtf8Secret, headers: { "x-signature": [value] } }).ok).toBe(true);
    expect(verify({ preset: "circleback", secret: kUtf8Secret, headers: { "x-signature": [value, value] } }).reason).toBe(
      "malformed",
    );
  });

  it("reports an unusable secret as no_secret", () => {
    for (const secret of [undefined, "", "has space", "x".repeat(513)]) {
      expect(verify({ preset: "circleback", secret, headers: circlebackHeaders() }).reason).toBe("no_secret");
    }
  });
});

describe("verkada", () => {
  it("verifies '<ts>|<hex>' over '<body>|<ts>' with the shared secret", () => {
    const headers = verkadaHeaders();
    const hex = headers["verkada-signature"].split("|")[1];
    expect(verify({ preset: "verkada", secret: kUtf8Secret, headers })).toEqual({
      ok: true,
      scheme: "verkada",
      replayKey: hex,
      deliveryId: null,
      signedHeaders: { "webhook-timestamp": String(kNowSec), "verkada-signature": headers["verkada-signature"] },
    });
  });

  it("refuses a signature computed over '<ts>|<body>'", () => {
    const ts = String(kNowSec);
    const reversed = ts + "|" + hmac(Buffer.from(kUtf8Secret, "utf8"), "hex", ts + "|", kBody);
    expect(verify({ preset: "verkada", secret: kUtf8Secret, headers: { "verkada-signature": reversed } }).reason).toBe(
      "bad_signature",
    );
  });

  it("lower-cases the replay key", () => {
    const [ts, hex] = verkadaHeaders()["verkada-signature"].split("|");
    const result = verify({ preset: "verkada", secret: kUtf8Secret, headers: { "verkada-signature": ts + "|" + hex.toUpperCase() } });
    expect(result.ok).toBe(true);
    expect(result.replayKey).toBe(hex);
  });

  it("reports a missing header", () => {
    expect(verify({ preset: "verkada", secret: kUtf8Secret, headers: {} }).reason).toBe("missing_signature");
  });

  it("rejects the wrong secret and a body changed by one byte", () => {
    expect(verify({ preset: "verkada", secret: kUtf8OtherSecret, headers: verkadaHeaders() }).reason).toBe("bad_signature");
    expect(verify({ preset: "verkada", secret: kUtf8Secret, rawBody: flipLastByte(kBody), headers: verkadaHeaders() }).reason).toBe(
      "bad_signature",
    );
  });

  it("rejects stale and future timestamps", () => {
    const past = String(kNowSec - kToleranceMs / 1000 - 1);
    const future = String(kNowSec + kToleranceMs / 1000 + 1);
    expect(verify({ preset: "verkada", secret: kUtf8Secret, headers: verkadaHeaders({ ts: past }) }).reason).toBe(
      "stale_timestamp",
    );
    expect(verify({ preset: "verkada", secret: kUtf8Secret, headers: verkadaHeaders({ ts: future }) }).reason).toBe(
      "stale_timestamp",
    );
  });

  it("reports malformed headers, including a millisecond timestamp", () => {
    const [ts, hex] = verkadaHeaders()["verkada-signature"].split("|");
    for (const value of [hex, ts + "|" + hex + "|" + hex, "now|" + hex, ts + "|", ts + "|xyz", String(kNowMs) + "|" + hex]) {
      expect(verify({ preset: "verkada", secret: kUtf8Secret, headers: { "verkada-signature": value } }).reason).toBe(
        "malformed",
      );
    }
  });

  it("fails an unequal-length signature without throwing", () => {
    const [ts, hex] = verkadaHeaders()["verkada-signature"].split("|");
    expect(verify({ preset: "verkada", secret: kUtf8Secret, headers: { "verkada-signature": ts + "|" + hex + "00" } }).reason).toBe(
      "bad_signature",
    );
  });

  it("reads array-valued headers", () => {
    const value = verkadaHeaders()["verkada-signature"];
    expect(verify({ preset: "verkada", secret: kUtf8Secret, headers: { "verkada-signature": [value] } }).ok).toBe(true);
    expect(verify({ preset: "verkada", secret: kUtf8Secret, headers: { "verkada-signature": [value, value] } }).reason).toBe(
      "malformed",
    );
  });

  it("reports an unusable secret as no_secret", () => {
    expect(verify({ preset: "verkada", secret: "", headers: verkadaHeaders() }).reason).toBe("no_secret");
  });
});

describe("validateSecret", () => {
  it("accepts well-formed secrets per preset", () => {
    expect(validateSecret("standard_webhooks", kSwSecret)).toEqual({ ok: true });
    expect(validateSecret("quo", kSwSecret)).toEqual({ ok: true });
    expect(validateSecret("quo", kQuoBareSecret)).toEqual({ ok: true });
    expect(validateSecret("circleback", kUtf8Secret)).toEqual({ ok: true });
    expect(validateSecret("verkada", kUtf8Secret)).toEqual({ ok: true });
    expect(validateSecret("standard_webhooks", kKeyPrefix + Buffer.alloc(16, 1).toString("base64"))).toEqual({ ok: true });
  });

  it("names why a secret is refused", () => {
    const cases = [
      ["standard_webhooks", kQuoBareSecret, "missing_prefix"],
      ["standard_webhooks", kKeyPrefix + "not base64!", "whitespace"],
      ["standard_webhooks", kKeyPrefix + "%%%%", "not_base64"],
      ["standard_webhooks", kKeyPrefix + "QUJD", "too_short"],
      ["standard_webhooks", kKeyPrefix + Buffer.alloc(15, 1).toString("base64"), "too_short"],
      ["standard_webhooks", kKeyPrefix + "QUJD=", "not_base64"],
      ["quo", "QUJDRA=x", "not_base64"],
      ["quo", "", "missing"],
      ["circleback", undefined, "missing"],
      ["circleback", "a b", "whitespace"],
      ["verkada", "x".repeat(513), "too_long"],
      ["verkada", "tab" + String.fromCharCode(9), "whitespace"],
      ["github", kUtf8Secret, "unknown_preset"],
    ];
    for (const [preset, secret, reason] of cases) {
      expect([preset, validateSecret(preset, secret)]).toEqual([preset, { ok: false, reason }]);
    }
    expect(validateSecret("verkada", "x".repeat(512))).toEqual({ ok: true });
  });
});

describe("hostile input", () => {
  it("never throws and answers malformed for bad call shapes", () => {
    expect(verifySignedDelivery()).toEqual({ ok: false, reason: "malformed" });
    expect(verify({ preset: "github", secret: kUtf8Secret, headers: {} }).reason).toBe("malformed");
    expect(verify({ preset: "__proto__", secret: kUtf8Secret, headers: {} }).reason).toBe("malformed");
    expect(verify({ preset: "circleback", secret: kUtf8Secret, rawBody: kBody.toString(), headers: circlebackHeaders() }).reason).toBe(
      "malformed",
    );
    expect(verify({ preset: "circleback", secret: kUtf8Secret, nowMs: Number.NaN, headers: circlebackHeaders() }).reason).toBe(
      "malformed",
    );
    expect(verify({ preset: "circleback", secret: kUtf8Secret, toleranceMs: -1, headers: circlebackHeaders() }).reason).toBe(
      "malformed",
    );
  });

  it("treats odd header containers and values as missing", () => {
    for (const preset of kSignedPresets) {
      const secret = preset === "standard_webhooks" || preset === "quo" ? kSwSecret : kUtf8Secret;
      for (const headers of [undefined, null, "x-signature", 7, [], Object.create(null)]) {
        expect(() => verify({ preset, secret, headers })).not.toThrow();
        expect(verify({ preset, secret, headers }).reason).toBe("missing_signature");
      }
      const weird = {
        "webhook-signature": { toString: () => "v1,x" },
        "x-signature": 42,
        "verkada-signature": [7, null],
        "openphone-signature": () => "hmac",
      };
      expect(verify({ preset, secret, headers: weird }).reason).toBe("missing_signature");
    }
  });

  it("ignores inherited properties on the headers object", () => {
    const headers = Object.create(circlebackHeaders());
    expect(verify({ preset: "circleback", secret: kUtf8Secret, headers }).reason).toBe("missing_signature");
  });

  it("survives very long and binary-laden header values", () => {
    const long = "v1," + "A".repeat(20000);
    const headers = { ...swHeaders(), "webhook-signature": long + " " + String.fromCharCode(0) };
    expect(() => verify({ preset: "standard_webhooks", secret: kSwSecret, headers })).not.toThrow();
    expect(verify({ preset: "standard_webhooks", secret: kSwSecret, headers }).reason).toBe("bad_signature");
  });
});
