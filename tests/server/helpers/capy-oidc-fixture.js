const crypto = require("crypto");
const { createCapyOidcVerifier, kCapyJwksUrl, kCapyIssuerBase } = require("../../../lib/server/relay/capy-oidc");

// A stand-in for Capy's OIDC issuer: RSA key pairs published as a JWKS at
// kCapyJwksUrl through fetchImpl, and sign() minting tokens shaped like the
// ones Capy puts in $CAPY_OIDC_TOKEN_FILE. Key generation is slow, so the
// k-th key of every issuer in a test file is the same shared 2048-bit pair.
const kKeyPool = [];
const pooledKeyPair = (index) => {
  while (kKeyPool.length <= index) kKeyPool.push(crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }));
  return kKeyPool[index];
};

const kHashByAlg = Object.freeze({ RS256: "RSA-SHA256", RS384: "RSA-SHA384", RS512: "RSA-SHA512" });
const encodePart = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const createCapyIssuer = ({ org = "org_test", audience = "https://box.example.test/relay", kid = "k1", now = () => Date.now() } = {}) => {
  const keys = new Map();
  const published = new Set();
  let signingKid = null;
  const logs = [];

  const issuer = {
    org,
    audience,
    now,
    fetches: 0,
    lastFetchInit: null,
    logs,

    // keyPair overrides the pooled 2048-bit pair (a weak or non-RSA key);
    // jwk merges extra members into the published JWK (alg, use).
    rotate(newKid, { keyPair, jwk = {} } = {}) {
      keys.set(newKid, { pair: keyPair || pooledKeyPair(keys.size), jwk });
      published.add(newKid);
      signingKid = newKid;
      return issuer;
    },

    unpublish(oldKid) {
      published.delete(oldKid);
      return issuer;
    },

    publicJwk(forKid = signingKid) {
      const entry = keys.get(forKid);
      return { ...entry.pair.publicKey.export({ format: "jwk" }), kid: forKid, alg: "RS256", use: "sig", ...entry.jwk };
    },

    jwks() {
      return { keys: [...published].map((publishedKid) => issuer.publicJwk(publishedKid)) };
    },

    async fetchImpl(url, init) {
      issuer.fetches += 1;
      issuer.lastFetchInit = init;
      if (url !== kCapyJwksUrl) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(issuer.jwks()), { status: 200, headers: { "content-type": "application/json" } });
    },

    // RS256 by default. header.alg RS384/RS512 signs with that hash, "none"
    // leaves the signature empty, and HS256 needs key to be the HMAC secret.
    sign(claimsOverride = {}, { header = {}, key } = {}) {
      const nowSec = Math.floor(now() / 1000);
      const claims = {
        iss: kCapyIssuerBase + org,
        aud: audience,
        org,
        project: "proj_1",
        thread: "ALPH-85",
        user: "user_1",
        machine: "machine_1",
        jti: crypto.randomUUID(),
        iat: nowSec,
        nbf: nowSec - 60,
        exp: nowSec + 3600,
        ...claimsOverride,
      };
      if (!("sub" in claimsOverride)) claims.sub = "org/" + claims.org + "/project/" + claims.project + "/thread/" + claims.thread;
      for (const name of Object.keys(claims)) if (claims[name] === undefined) delete claims[name];
      const fullHeader = { alg: "RS256", typ: "JWT", kid: signingKid, ...header };
      for (const name of Object.keys(fullHeader)) if (fullHeader[name] === undefined) delete fullHeader[name];
      const data = encodePart(fullHeader) + "." + encodePart(claims);
      if (fullHeader.alg === "none") return data + ".";
      if (String(fullHeader.alg).startsWith("HS")) {
        return data + "." + crypto.createHmac("sha" + fullHeader.alg.slice(2), key).update(data).digest("base64url");
      }
      const signer = key || keys.get(signingKid).pair.privateKey;
      return data + "." + crypto.sign(kHashByAlg[fullHeader.alg] || "RSA-SHA256", Buffer.from(data), signer).toString("base64url");
    },

    verifier(options = {}) {
      return createCapyOidcVerifier({
        org,
        audience,
        fetchImpl: issuer.fetchImpl,
        now,
        logger: { warn: (line) => logs.push(line), info: (line) => logs.push(line), error: (line) => logs.push(line) },
        ...options,
      });
    },
  };

  issuer.rotate(kid);
  return issuer;
};

module.exports = { createCapyIssuer };
