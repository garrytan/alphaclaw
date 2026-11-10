const crypto = require("crypto");

// Verifies the OIDC JWT Capy signs for a machine ($CAPY_OIDC_TOKEN_FILE on a
// Capy machine): RS256 only, keys from Capy's public JWKS, issuer
// https://api.capy.ai/oidc/orgs/<org>, sub org/<org>/project/<p>/thread/<t>.
// The signature is checked before any claim is read as true, and every
// refusal is a CapyOidcError whose message never quotes the token.
//
// The JWKS is fetched on first use and cached. An unknown kid or a cache
// older than maxCacheAgeMs refetches it, but never more than once per
// refetchIntervalMs after the last attempt, so a caller spraying random kids
// costs Capy at most one fetch a minute. A failed refresh keeps the keys
// already cached.
const kCapyJwksUrl = "https://api.capy.ai/oidc/jwks.json";
const kCapyIssuerBase = "https://api.capy.ai/oidc/orgs/";
const kMaxJwtChars = 8192;
const kMaxJwksBytes = 64 * 1024;
const kJwksTimeoutMs = 5000;
const kMaxLifetimeMs = 2 * 60 * 60 * 1000;
const kMinModulusBits = 2048;
const kMaxClaimChars = 128;
const kClaimPattern = /^[A-Za-z0-9_.:@-]+$/;
const kBase64UrlPattern = /^[A-Za-z0-9_-]*$/;

const kMessages = Object.freeze({
  not_configured: "Capy attestation is not configured (org and audience are required)",
  jwks_fetch: "Capy's signing keys could not be loaded",
  expired: "The Capy token has expired",
  format: "The Capy token is not a well-formed JWT",
  alg: "The Capy token must be signed with RS256",
  kid: "The Capy token names a signing key Capy does not publish",
  key: "Capy's signing key for this token is not an acceptable RSA key",
  signature: "The Capy token's signature does not verify",
  iss: "The Capy token was issued for a different organization",
  aud: "The Capy token was issued for a different audience",
  org: "The Capy token's org claim does not match",
  sub: "The Capy token's subject does not match its project and thread",
  claims: "The Capy token is missing a required claim or has a malformed one",
  not_yet_valid: "The Capy token is not valid yet",
  lifetime: "The Capy token's lifetime is longer than Capy issues",
});

const kCodeByReason = Object.freeze({
  not_configured: "attestation_unavailable",
  jwks_fetch: "attestation_unavailable",
  expired: "attestation_stale",
});

class CapyOidcError extends Error {
  constructor(reason) {
    super(kMessages[reason]);
    this.name = "CapyOidcError";
    this.code = kCodeByReason[reason] || "attestation_invalid";
    this.reason = reason;
  }
}

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isClaimString = (value) => typeof value === "string" && value.length > 0 && value.length <= kMaxClaimChars && kClaimPattern.test(value);
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

const decodeJsonPart = (part) => {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
};

// A JWK becomes a usable key only when it is RSA, at least 2048 bits, and
// does not declare another algorithm or an encryption use. Only n and e are
// imported, so a published private part is never turned into a key.
const importJwk = (jwk) => {
  if (jwk.kty !== "RSA") return null;
  if (jwk.alg !== undefined && jwk.alg !== "RS256") return null;
  if (jwk.use !== undefined && jwk.use !== "sig") return null;
  if (typeof jwk.n !== "string" || typeof jwk.e !== "string") return null;
  try {
    const key = crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
    if (key.asymmetricKeyType !== "rsa") return null;
    if (!(key.asymmetricKeyDetails?.modulusLength >= kMinModulusBits)) return null;
    return key;
  } catch {
    return null;
  }
};

const tooLarge = () => new Error("JWKS response is larger than " + kMaxJwksBytes + " bytes");

const readCappedBody = async (res) => {
  if (!res.body || typeof res.body.getReader !== "function") {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > kMaxJwksBytes) throw tooLarge();
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > kMaxJwksBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const createCapyOidcVerifier = ({
  org,
  audience,
  jwksUrl = kCapyJwksUrl,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  logger = console,
  skewMs = 60_000,
  refetchIntervalMs = 60_000,
  maxCacheAgeMs = 3_600_000,
} = {}) => {
  const configured = typeof org === "string" && org.length > 0 && typeof audience === "string" && audience.length > 0;
  const issuer = configured ? kCapyIssuerBase + org : null;
  let keys = null;
  let loadedAt = 0;
  let lastAttemptAt = null;
  let inflight = null;

  const fetchKeys = async () => {
    const res = await fetchImpl(jwksUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(kJwksTimeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error("JWKS request returned HTTP " + res.status);
    if (Number(res.headers?.get?.("content-length")) > kMaxJwksBytes) throw tooLarge();
    const body = JSON.parse(await readCappedBody(res));
    if (!isPlainObject(body) || !Array.isArray(body.keys)) throw new Error("JWKS response has no keys array");
    const next = new Map();
    for (const jwk of body.keys) {
      if (!isPlainObject(jwk) || typeof jwk.kid !== "string" || !jwk.kid || next.has(jwk.kid)) continue;
      next.set(jwk.kid, importJwk(jwk));
    }
    return next;
  };

  // Concurrent callers share one fetch; a failure is logged and leaves the
  // cached keys (if any) in place.
  const refresh = () => {
    if (inflight) return inflight;
    lastAttemptAt = now();
    inflight = fetchKeys()
      .then((next) => {
        keys = next;
        loadedAt = now();
      })
      .catch((err) => {
        logger.warn?.("[alphaclaw] capy oidc: JWKS fetch failed" + (keys ? ", keeping cached keys" : "") + ": " + (err?.message || String(err)));
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const resolveKey = async (kid) => {
    const wanted = !keys || !keys.has(kid) || now() - loadedAt > maxCacheAgeMs;
    const allowed = lastAttemptAt === null || now() - lastAttemptAt >= refetchIntervalMs;
    if (inflight || (wanted && allowed)) await refresh();
    if (!keys) throw new CapyOidcError("jwks_fetch");
    if (!keys.has(kid)) throw new CapyOidcError("kid");
    const key = keys.get(kid);
    if (!key) throw new CapyOidcError("key");
    return key;
  };

  const verify = async (jwt) => {
    if (!configured) throw new CapyOidcError("not_configured");
    if (typeof jwt !== "string" || jwt.length > kMaxJwtChars) throw new CapyOidcError("format");
    const parts = jwt.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts.every((part) => kBase64UrlPattern.test(part))) {
      throw new CapyOidcError("format");
    }
    const header = decodeJsonPart(parts[0]);
    const payload = decodeJsonPart(parts[1]);
    if (!header || !payload) throw new CapyOidcError("format");
    if (header.alg !== "RS256") throw new CapyOidcError("alg");
    const kid = header.kid;
    if (typeof kid !== "string" || !kid || kid.length > kMaxClaimChars) throw new CapyOidcError("kid");
    const key = await resolveKey(kid);
    const signature = Buffer.from(parts[2], "base64url");
    let signed = false;
    try {
      signed = signature.length > 0 && crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1], "ascii"), key, signature);
    } catch {
      signed = false;
    }
    if (!signed) throw new CapyOidcError("signature");

    const { iss, aud, sub, project, thread, user, jti, machine, iat, nbf, exp } = payload;
    if (![project, thread, user, jti].every(isClaimString)) throw new CapyOidcError("claims");
    if (machine !== undefined && !isClaimString(machine)) throw new CapyOidcError("claims");
    if (!isFiniteNumber(exp)) throw new CapyOidcError("claims");
    if ((iat !== undefined && !isFiniteNumber(iat)) || (nbf !== undefined && !isFiniteNumber(nbf))) throw new CapyOidcError("claims");
    if (iss !== issuer) throw new CapyOidcError("iss");
    if (payload.org !== org) throw new CapyOidcError("org");
    if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) throw new CapyOidcError("aud");
    if (sub !== "org/" + org + "/project/" + project + "/thread/" + thread) throw new CapyOidcError("sub");

    const nowMs = now();
    const expMs = exp * 1000;
    if (nowMs > expMs + skewMs) throw new CapyOidcError("expired");
    if (nbf !== undefined && nbf * 1000 > nowMs + skewMs) throw new CapyOidcError("not_yet_valid");
    if (expMs - nowMs > kMaxLifetimeMs + skewMs) throw new CapyOidcError("lifetime");

    return {
      jti,
      exp: expMs,
      kid,
      claims: { sub, org, project, thread, machine: machine ?? null, user, iat: iat ?? null, nbf: nbf ?? null, exp },
    };
  };

  return { verify, configured };
};

module.exports = { createCapyOidcVerifier, CapyOidcError, kCapyJwksUrl, kCapyIssuerBase };
