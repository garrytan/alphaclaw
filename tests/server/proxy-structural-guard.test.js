const fs = require("fs");
const path = require("path");

const { createIsProxiedPath } = require("../../lib/server/routes/proxy");
const { SETUP_API_PREFIXES } = require("../../lib/server/constants");

// Structural guard for the parser-skip predicate. A proxied path's body is
// piped verbatim to the gateway, so the JSON parser SKIPS every path
// createIsProxiedPath(SETUP_API_PREFIXES) marks as proxied. If someone
// registers a new local /api namespace without adding it to the union of
// SETUP_API_PREFIXES (lib/server/constants.js) and kLocalOnlyApiPrefixes
// (lib/server/routes/proxy.js), its handlers see an unparsed req.body and
// break subtly. This test source-scans the route registrations and fails on
// any locally-registered namespace the predicate would treat as proxied.

const kRepoRoot = path.resolve(__dirname, "..", "..");

// Namespaces that ARE registered locally by string literal yet are
// INTENTIONALLY proxied (parser skipped). Additions must be by explicit name
// here — never silently. Currently there are none.
const kIntentionallyProxiedNamespaces = [];

const collectJsFilesRecursively = (dirPath, found = []) => {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectJsFilesRecursively(entryPath, found);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      found.push(entryPath);
    }
  }
  return found;
};

const kScannedFiles = [
  ...collectJsFilesRecursively(path.join(kRepoRoot, "lib", "server", "routes")),
  path.join(kRepoRoot, "lib", "server.js"),
  path.join(kRepoRoot, "lib", "server", "init", "register-server-routes.js"),
];

// Route registrations passing an /api/... string literal to an Express-style
// verb: app.get/post/put/delete/patch/all/use("/api/...").
const kRouteRegistrationPattern =
  /\.(?:get|post|put|delete|patch|all|use)\(\s*["'`](\/api\/[^"'`]+)["'`]/g;

const collectLocallyRegisteredApiNamespaces = () => {
  const namespaces = new Set();
  for (const filePath of kScannedFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(kRouteRegistrationPattern)) {
      const segments = match[1].split("/");
      // "/api/agents/:id" → ["", "api", "agents", ":id"] → "/api/agents"
      namespaces.add(`/${segments[1]}/${segments[2]}`);
    }
  }
  return namespaces;
};

describe("server/routes/proxy structural guard (parser-skip predicate)", () => {
  const isProxiedPath = createIsProxiedPath(SETUP_API_PREFIXES);

  it("treats every locally-registered /api namespace as local (parser runs)", () => {
    const namespaces = collectLocallyRegisteredApiNamespaces();

    // Scanner health: if the regex or file list rots, this fails loudly
    // instead of vacuously passing on an empty set.
    expect(namespaces.size).toBeGreaterThan(20);

    const offenders = [...namespaces]
      .filter((namespace) => !kIntentionallyProxiedNamespaces.includes(namespace))
      .filter((namespace) => isProxiedPath({ path: namespace }))
      .sort();

    // A namespace listed here is registered locally but the parser-skip
    // predicate would proxy it (body parsers skipped → handlers get an
    // unparsed body). Fix: add it to kLocalOnlyApiPrefixes in
    // lib/server/routes/proxy.js (or SETUP_API_PREFIXES in
    // lib/server/constants.js if the catch-all should skip it too) — or, if
    // it is genuinely proxied, name it in kIntentionallyProxiedNamespaces
    // above.
    expect(offenders).toEqual([]);
  });

  it("would flag a local namespace missing from the union (guard sensitivity)", () => {
    // Proof the guard can fail: a namespace nobody added to the union is
    // proxied, i.e. exactly the state the previous test flags.
    expect(isProxiedPath({ path: "/api/nonexistent-namespace" })).toBe(true);
    expect(isProxiedPath({ path: "/api/nonexistent-namespace/sub" })).toBe(true);
  });

  it("scans real files (fixture sanity)", () => {
    for (const filePath of kScannedFiles) {
      expect(fs.existsSync(filePath)).toBe(true);
    }
    expect(kScannedFiles.length).toBeGreaterThan(5);
  });
});
