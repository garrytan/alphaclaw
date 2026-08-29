const fs = require("fs");
const path = require("path");
const manifest = require("../../lib/server/admin-manifest");

describe("admin-manifest engine", () => {
  it("loads all domains and assigns a stable manifestVersion", () => {
    const version = manifest.getManifestVersion();
    expect(version).toMatch(/^[0-9a-f]{12}$/);
    expect(manifest.getManifestVersion()).toBe(version); // cached, stable
    expect(manifest.listOps().length).toBeGreaterThan(100);
  });

  it("assigns every op a valid tier and unique id", () => {
    const seen = new Set();
    for (const op of manifest.listOps()) {
      expect(manifest.kTiers).toContain(op.tier);
      expect(seen.has(op.id)).toBe(false);
      seen.add(op.id);
    }
  });

  it("matches on baseUrl+path style full paths, not trimmed paths", () => {
    // Regression for the Express mount-trim bug (A19): matching must use the
    // FULL path. A bare "/env" (what req.path is under app.use('/api')) must
    // NOT match; "/api/env" must.
    expect(manifest.findOp("PUT", "/env")).toBeNull();
    expect(manifest.findOp("PUT", "/api/env")?.id).toBe("env.update");
  });

  it("resolves body-aware tiers via tierResolver (env clear = dangerous)", () => {
    const op = manifest.findOp("PUT", "/api/env");
    // No secret being cleared → base restart tier.
    expect(
      manifest.resolveTier(op, { body: { vars: [{ key: "FOO", value: "bar" }] } }),
    ).toBe("restart");
  });

  it("has EXACTLY one matching op per concrete (method, path) — no pattern collisions", () => {
    // Literal-vs-:param collisions are the failure this guards (A24). For each
    // op, its own concrete path must resolve to exactly one op.
    for (const op of manifest.listOps()) {
      const concrete = op.path.replace(/:[A-Za-z][A-Za-z0-9]*/g, "x");
      const matches = manifest.findAllOps(op.method, concrete);
      expect(
        matches.length,
        `${op.method} ${op.path} (concrete ${concrete}) matched ${matches
          .map((m) => m.id)
          .join(", ")}`,
      ).toBe(1);
    }
  });

  it("serializes ops without functions or regexes (JSON-safe)", () => {
    const { ops } = manifest.getManifest();
    const json = JSON.stringify(ops);
    expect(json).not.toContain("function");
    for (const op of ops) {
      expect(op.pathPattern).toBeUndefined();
      expect(op.tierResolver).toBeUndefined();
    }
  });
});

describe("admin-manifest route coverage", () => {
  // Every /api route registered in a setup route module must be either
  // classified in the manifest or explicitly listed in kUnmanifestedRoutes
  // (with a why-comment at the source). Static scan over the route files — a
  // new unclassified route fails CI.
  const routesDir = path.join(__dirname, "..", "..", "lib", "server", "routes");

  const collectRouteFiles = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectRouteFiles(full));
      else if (entry.name.endsWith(".js")) out.push(full);
    }
    return out;
  };

  const extractApiRoutes = (source) => {
    const routes = [];
    const re =
      /app\.(get|post|put|delete|patch|all)\(\s*(["'`])(\/api\/[^"'`]*)\2/g;
    let match;
    while ((match = re.exec(source)) !== null) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[3],
      });
    }
    return routes;
  };

  const isUnmanifested = (method, routePath) => {
    if (manifest.kUnmanifestedRoutes.has(`${method} ${routePath}`)) return true;
    // Namespace wildcards, e.g. "ALL /api/onboard/*".
    for (const entry of manifest.kUnmanifestedRoutes) {
      const [em, ep] = entry.split(" ");
      if (ep?.endsWith("/*")) {
        const prefix = ep.slice(0, -1); // keep trailing slash
        if (
          (em === "ALL" || em === method) &&
          (routePath === ep.slice(0, -2) || routePath.startsWith(prefix))
        ) {
          return true;
        }
      }
    }
    return false;
  };

  // Express :param vs manifest pattern: convert a registered express path to a
  // concrete probe path so findOp can match it.
  const concreteProbe = (routePath) =>
    routePath.replace(/:[A-Za-z][A-Za-z0-9]*/g, "x").replace(/\*/g, "x");

  it("classifies every /api route in the route modules", () => {
    const unclassified = [];
    for (const file of collectRouteFiles(routesDir)) {
      // admin.js + proxy.js register the meta/catch-all surface, not tiered ops.
      if (file.endsWith("routes/proxy.js")) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const { method, path: routePath } of extractApiRoutes(source)) {
        if (isUnmanifested(method, routePath)) continue;
        if (routePath.startsWith("/api/admin/")) continue; // meta namespace
        const op = manifest.findOp(method, concreteProbe(routePath));
        if (!op) {
          unclassified.push(
            `${method} ${routePath}  (${path.basename(file)})`,
          );
        }
      }
    }
    expect(
      unclassified,
      `Unclassified /api routes — add a manifest descriptor or list in kUnmanifestedRoutes with a why-comment:\n${unclassified.join(
        "\n",
      )}`,
    ).toEqual([]);
  });
});
