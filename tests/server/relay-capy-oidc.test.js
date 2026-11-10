const crypto = require("crypto");
const { createCapyOidcVerifier, CapyOidcError, kCapyJwksUrl, kCapyIssuerBase } = require("../../lib/server/relay/capy-oidc");
const { createCapyIssuer } = require("./helpers/capy-oidc-fixture");

// Key generation is slow: the stranger key (same kid, different key) and the
// weak 1024-bit key are made once for the file.
const kStrangerPair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const kWeakPair = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
const kEcPair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });

const kStart = 1_800_000_000_000;
let clock = kStart;
const now = () => clock;
const tokensSeen = [];

const makeIssuer = (options = {}) => createCapyIssuer({ now, ...options });

// Every refusal is checked for the expected code and reason, and its message
// for any 20-character slice of the token it refused.
const expectRefused = async (verifier, jwt, code, reason) => {
  if (typeof jwt === "string") tokensSeen.push(jwt);
  const err = await verifier.verify(jwt).then(
    () => null,
    (error) => error,
  );
  expect(err, "expected a refusal with reason " + reason).toBeInstanceOf(CapyOidcError);
  expect({ code: err.code, reason: err.reason }).toEqual({ code, reason });
  if (typeof jwt === "string") {
    for (let i = 0; i + 20 <= jwt.length; i += 1) expect(err.message.includes(jwt.slice(i, i + 20))).toBe(false);
  }
  return err;
};

const swapPayload = (jwt, mutate) => {
  const [header, payload, signature] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  mutate(claims);
  return header + "." + Buffer.from(JSON.stringify(claims)).toString("base64url") + "." + signature;
};

beforeEach(() => {
  clock = kStart;
});

describe("relay/capy-oidc", () => {
  it("exports Capy's JWKS URL and issuer base", () => {
    expect(kCapyJwksUrl).toBe("https://api.capy.ai/oidc/jwks.json");
    expect(kCapyIssuerBase).toBe("https://api.capy.ai/oidc/orgs/");
  });

  it("accepts a good token and returns its claims, machine included", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    expect(verifier.configured).toBe(true);
    const jwt = issuer.sign({ jti: "jti_1" });
    const nowSec = Math.floor(kStart / 1000);
    await expect(verifier.verify(jwt)).resolves.toEqual({
      jti: "jti_1",
      exp: (nowSec + 3600) * 1000,
      kid: "k1",
      claims: {
        sub: "org/org_test/project/proj_1/thread/ALPH-85",
        org: "org_test",
        project: "proj_1",
        thread: "ALPH-85",
        machine: "machine_1",
        user: "user_1",
        iat: nowSec,
        nbf: nowSec - 60,
        exp: nowSec + 3600,
      },
    });
    expect(issuer.fetches).toBe(1);
    expect(issuer.lastFetchInit.redirect).toBe("error");
    expect(issuer.lastFetchInit.signal).toBeInstanceOf(AbortSignal);
  });

  it("records a missing machine as null", async () => {
    const issuer = makeIssuer();
    const result = await issuer.verifier().verify(issuer.sign({ machine: undefined }));
    expect(result.claims.machine).toBeNull();
  });

  it("refuses the wrong issuer, org claim and subject", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    await expectRefused(verifier, issuer.sign({ iss: kCapyIssuerBase + "org_other" }), "attestation_invalid", "iss");
    await expectRefused(verifier, issuer.sign({ iss: kCapyIssuerBase + "org_test/" }), "attestation_invalid", "iss");
    await expectRefused(verifier, issuer.sign({ org: "org_other", sub: "org/org_test/project/proj_1/thread/ALPH-85" }), "attestation_invalid", "org");
    await expectRefused(verifier, issuer.sign({ sub: "org/org_test/project/proj_1/thread/ALPH-86" }), "attestation_invalid", "sub");
    await expectRefused(verifier, issuer.sign({ sub: undefined }), "attestation_invalid", "sub");
  });

  it("checks the audience as a string or an array", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    await expectRefused(verifier, issuer.sign({ aud: "https://other.example.test/relay" }), "attestation_invalid", "aud");
    await expectRefused(verifier, issuer.sign({ aud: ["https://other.example.test/relay"] }), "attestation_invalid", "aud");
    await expectRefused(verifier, issuer.sign({ aud: undefined }), "attestation_invalid", "aud");
    await expect(verifier.verify(issuer.sign({ aud: ["https://other.example.test/relay", issuer.audience] }))).resolves.toMatchObject({ kid: "k1" });
  });

  it("refuses missing or malformed identity claims", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    for (const name of ["jti", "thread", "user", "project"]) {
      await expectRefused(verifier, issuer.sign({ [name]: undefined }), "attestation_invalid", "claims");
      await expectRefused(verifier, issuer.sign({ [name]: "" }), "attestation_invalid", "claims");
    }
    await expectRefused(verifier, issuer.sign({ thread: "ALPH 85" }), "attestation_invalid", "claims");
    await expectRefused(verifier, issuer.sign({ user: "user/1" }), "attestation_invalid", "claims");
    await expectRefused(verifier, issuer.sign({ machine: "machine\n1" }), "attestation_invalid", "claims");
    await expectRefused(verifier, issuer.sign({ machine: 7 }), "attestation_invalid", "claims");
    await expectRefused(verifier, issuer.sign({ jti: "j".repeat(129) }), "attestation_invalid", "claims");
    await expectRefused(verifier, issuer.sign({ exp: "9999999999" }), "attestation_invalid", "claims");
    await expectRefused(verifier, issuer.sign({ exp: undefined }), "attestation_invalid", "claims");
  });

  it("refuses alg none, HS256 keyed with the public key, and RS512", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    await expectRefused(verifier, issuer.sign({}, { header: { alg: "none" } }), "attestation_invalid", "alg");
    const jwk = issuer.publicJwk("k1");
    const pem = crypto.createPublicKey({ key: jwk, format: "jwk" }).export({ type: "spki", format: "pem" });
    await expectRefused(verifier, issuer.sign({}, { header: { alg: "HS256" }, key: pem }), "attestation_invalid", "alg");
    await expectRefused(verifier, issuer.sign({}, { header: { alg: "HS256" }, key: Buffer.from(JSON.stringify(jwk)) }), "attestation_invalid", "alg");
    await expectRefused(verifier, issuer.sign({}, { header: { alg: "RS512" } }), "attestation_invalid", "alg");
    await expectRefused(verifier, issuer.sign({}, { header: { alg: "rs256" } }), "attestation_invalid", "alg");
    await expectRefused(verifier, issuer.sign({}, { header: { alg: undefined } }), "attestation_invalid", "alg");
    expect(issuer.fetches).toBe(0);
  });

  it("refuses a tampered payload, a foreign key's signature and an empty signature", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    const jwt = issuer.sign();
    await expectRefused(verifier, swapPayload(jwt, (claims) => (claims.thread = "ALPH-1")), "attestation_invalid", "signature");
    await expectRefused(verifier, issuer.sign({}, { key: kStrangerPair.privateKey }), "attestation_invalid", "signature");
    await expectRefused(verifier, jwt.slice(0, jwt.lastIndexOf(".") + 1), "attestation_invalid", "signature");
    await expect(verifier.verify(jwt)).resolves.toMatchObject({ kid: "k1" });
  });

  it("checks the signature before trusting any claim", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    const forged = swapPayload(issuer.sign(), (claims) => {
      claims.iss = "https://evil.example.test";
      claims.exp = 1;
    });
    await expectRefused(verifier, forged, "attestation_invalid", "signature");
  });

  it("refuses malformed and oversize tokens without fetching keys", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    const jwt = issuer.sign();
    await expectRefused(verifier, "not-a-jwt", "attestation_invalid", "format");
    await expectRefused(verifier, jwt + ".extra", "attestation_invalid", "format");
    await expectRefused(verifier, "." + jwt.split(".")[1] + "." + jwt.split(".")[2], "attestation_invalid", "format");
    await expectRefused(verifier, jwt.replace(".", ".+"), "attestation_invalid", "format");
    await expectRefused(verifier, Buffer.from("{not json").toString("base64url") + "." + jwt.split(".")[1] + ".sig", "attestation_invalid", "format");
    await expectRefused(verifier, jwt.split(".")[0] + "." + Buffer.from("[1]").toString("base64url") + ".sig", "attestation_invalid", "format");
    await expectRefused(verifier, issuer.sign({ pad: "x".repeat(8192) }), "attestation_invalid", "format");
    await expectRefused(verifier, null, "attestation_invalid", "format");
    expect(issuer.fetches).toBe(0);
  });

  it("refuses a token with no kid", async () => {
    const issuer = makeIssuer();
    await expectRefused(issuer.verifier(), issuer.sign({}, { header: { kid: undefined } }), "attestation_invalid", "kid");
  });

  it("refetches once for an unknown kid, then rate-limits further unknown kids", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    await verifier.verify(issuer.sign());
    expect(issuer.fetches).toBe(1);
    clock += 61_000;
    await expectRefused(verifier, issuer.sign({}, { header: { kid: "nope-1" } }), "attestation_invalid", "kid");
    expect(issuer.fetches).toBe(2);
    clock += 30_000;
    await expectRefused(verifier, issuer.sign({}, { header: { kid: "nope-2" } }), "attestation_invalid", "kid");
    expect(issuer.fetches).toBe(2);
    for (let i = 0; i < 20; i += 1) {
      await expectRefused(verifier, issuer.sign({}, { header: { kid: "spray-" + i } }), "attestation_invalid", "kid");
    }
    expect(issuer.fetches).toBe(2);
    await expect(verifier.verify(issuer.sign())).resolves.toMatchObject({ kid: "k1" });
    expect(issuer.fetches).toBe(2);
  });

  it("accepts a rotated key after one refetch, and keeps accepting the old key while published", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    const oldToken = issuer.sign();
    await verifier.verify(oldToken);
    clock += 61_000;
    issuer.rotate("k2");
    await expect(verifier.verify(issuer.sign())).resolves.toMatchObject({ kid: "k2" });
    expect(issuer.fetches).toBe(2);
    await expect(verifier.verify(oldToken)).resolves.toMatchObject({ kid: "k1" });
    expect(issuer.fetches).toBe(2);
  });

  it("refuses a weak, non-RSA or wrongly declared key", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    issuer.rotate("weak", { keyPair: kWeakPair });
    await expectRefused(verifier, issuer.sign(), "attestation_invalid", "key");
    clock += 61_000;
    issuer.rotate("ec", { keyPair: kEcPair });
    await expectRefused(verifier, issuer.sign({}, { key: kEcPair.privateKey }), "attestation_invalid", "key");
    clock += 61_000;
    issuer.rotate("enc", { jwk: { use: "enc" } });
    await expectRefused(verifier, issuer.sign(), "attestation_invalid", "key");
    clock += 61_000;
    issuer.rotate("ps", { jwk: { alg: "PS256" } });
    await expectRefused(verifier, issuer.sign(), "attestation_invalid", "key");
  });

  it("treats expiry inside the skew as valid and beyond it as stale", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    const jwt = issuer.sign();
    const expMs = (Math.floor(kStart / 1000) + 3600) * 1000;
    clock = expMs + 30_000;
    await expect(verifier.verify(jwt)).resolves.toMatchObject({ exp: expMs });
    clock = expMs + 61_000;
    await expectRefused(verifier, jwt, "attestation_stale", "expired");
  });

  it("refuses a token not valid yet or with too long a lifetime", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    const nowSec = Math.floor(kStart / 1000);
    await expect(verifier.verify(issuer.sign({ nbf: nowSec + 50 }))).resolves.toBeTruthy();
    await expectRefused(verifier, issuer.sign({ nbf: nowSec + 120 }), "attestation_invalid", "not_yet_valid");
    await expect(verifier.verify(issuer.sign({ exp: nowSec + 2 * 3600 }))).resolves.toBeTruthy();
    await expectRefused(verifier, issuer.sign({ exp: nowSec + 2 * 3600 + 120 }), "attestation_invalid", "lifetime");
    await expectRefused(verifier, issuer.sign({ nbf: "soon" }), "attestation_invalid", "claims");
  });

  it("reports an unreachable JWKS as unavailable and recovers on a later fetch", async () => {
    const issuer = makeIssuer();
    let down = true;
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      if (down) throw new Error("connect ECONNREFUSED");
      return issuer.fetchImpl(url, init);
    };
    const verifier = issuer.verifier({ fetchImpl });
    await expectRefused(verifier, issuer.sign(), "attestation_unavailable", "jwks_fetch");
    expect(calls).toBe(1);
    await expectRefused(verifier, issuer.sign(), "attestation_unavailable", "jwks_fetch");
    expect(calls).toBe(1);
    expect(issuer.logs.join("\n")).toContain("JWKS fetch failed");
    down = false;
    clock += 61_000;
    await expect(verifier.verify(issuer.sign())).resolves.toMatchObject({ kid: "k1" });
    expect(calls).toBe(2);
  });

  it("refuses an HTTP error, a non-JWKS body and an oversize JWKS", async () => {
    const issuer = makeIssuer();
    const responses = [
      () => new Response("oops", { status: 500 }),
      () => new Response("{\"nokeys\":true}", { status: 200 }),
      () => new Response(JSON.stringify({ keys: [], pad: "x".repeat(70 * 1024) }), { status: 200 }),
      () => new Response(JSON.stringify({ keys: [] }), { status: 200, headers: { "content-length": String(65 * 1024) } }),
    ];
    for (const make of responses) {
      const verifier = issuer.verifier({ fetchImpl: async () => make() });
      await expectRefused(verifier, issuer.sign(), "attestation_unavailable", "jwks_fetch");
    }
  });

  it("keeps cached keys when a refresh fails", async () => {
    const issuer = makeIssuer();
    let down = false;
    const verifier = issuer.verifier({ fetchImpl: async (url, init) => (down ? new Response("down", { status: 503 }) : issuer.fetchImpl(url, init)) });
    await verifier.verify(issuer.sign());
    down = true;
    clock += 3_600_000 + 1000;
    await expect(verifier.verify(issuer.sign())).resolves.toMatchObject({ kid: "k1" });
    expect(issuer.logs.join("\n")).toContain("keeping cached keys");
    clock += 61_000;
    await expectRefused(verifier, issuer.sign({}, { header: { kid: "k9" } }), "attestation_invalid", "kid");
  });

  it("refreshes a cache older than maxCacheAgeMs and drops unpublished keys", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    await verifier.verify(issuer.sign());
    issuer.rotate("k2").unpublish("k1");
    clock += 3_600_000 + 1000;
    await expect(verifier.verify(issuer.sign())).resolves.toMatchObject({ kid: "k2" });
    expect(issuer.fetches).toBe(2);
    clock += 61_000;
    await expectRefused(verifier, issuer.sign({}, { header: { kid: "k1" } }), "attestation_invalid", "kid");
  });

  it("shares one JWKS fetch between concurrent verifies", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier();
    const results = await Promise.all(Array.from({ length: 8 }, () => verifier.verify(issuer.sign())));
    expect(results).toHaveLength(8);
    expect(issuer.fetches).toBe(1);
  });

  it("is unavailable when org or audience is not configured, without fetching", async () => {
    const issuer = makeIssuer();
    for (const options of [{ org: "" }, { audience: "" }, { org: undefined }]) {
      const verifier = issuer.verifier(options);
      expect(verifier.configured).toBe(false);
      await expectRefused(verifier, issuer.sign(), "attestation_unavailable", "not_configured");
    }
    expect(createCapyOidcVerifier().configured).toBe(false);
    expect(issuer.fetches).toBe(0);
  });

  it("never logs a token", async () => {
    const issuer = makeIssuer();
    const verifier = issuer.verifier({ fetchImpl: async () => new Response("down", { status: 503 }) });
    const jwt = issuer.sign();
    await expectRefused(verifier, jwt, "attestation_unavailable", "jwks_fetch");
    const logged = issuer.logs.join("\n");
    expect(logged).not.toBe("");
    for (const seen of tokensSeen.concat(jwt)) {
      for (let i = 0; i + 20 <= seen.length; i += 20) expect(logged.includes(seen.slice(i, i + 20))).toBe(false);
    }
  });
});
