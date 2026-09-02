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

  it("escalates agent notification-toggle writes to dangerous (audit-gate survival)", () => {
    const op = manifest.findOp("PUT", "/api/watchdog/settings");
    expect(op?.id).toBe("watchdog.settings.update");
    // autoRepair alone stays a routine write…
    expect(manifest.resolveTier(op, { body: { autoRepair: true } })).toBe(
      "write",
    );
    // …but touching either notification toggle requires a dangerous-tier
    // confirm: the agent must not silence the operator's alert channel
    // without an operator-approved code (the confirm delivery is
    // audit-class, so the gate survives the very setting under attack).
    expect(
      manifest.resolveTier(op, { body: { notificationsEnabled: false } }),
    ).toBe("dangerous");
    expect(
      manifest.resolveTier(op, {
        body: { autoRepair: true, notificationsVerbose: false },
      }),
    ).toBe("dangerous");
  });

  // WI-4.5: backup-reuse consent is humans-only — the agent is DENIED (not
  // merely escalated) for any body carrying the field, valid or not.
  it("denies the agent's updates.apply whenever the body carries allowBackupReuse", () => {
    const op = manifest.findOp("POST", "/api/openclaw/apply");
    expect(op?.id).toBe("updates.apply");
    expect(manifest.resolveTier(op, { body: { channel: "beta", version: "1.0.0" } })).toBe(
      "dangerous",
    );
    for (const allowBackupReuse of [{ sha256: "a".repeat(64) }, true, "true", null, {}]) {
      expect(
        manifest.resolveTier(op, { body: { channel: "beta", version: "1.0.0", allowBackupReuse } }),
      ).toBe("denied");
    }
    // Primitive/array bodies never throw and stay at the base tier.
    for (const body of [true, 1, "x", null, undefined, ["allowBackupReuse"]]) {
      expect(manifest.resolveTier(op, { body })).toBe("dangerous");
    }
  });

  it("classifies the backup inventory as a safe read", () => {
    const op = manifest.findOp("GET", "/api/openclaw/backups");
    expect(op?.id).toBe("updates.backups");
    expect(op.tier).toBe("safe");
  });

  it("tier resolver survives primitive JSON bodies instead of throwing", () => {
    const op = manifest.findOp("PUT", "/api/watchdog/settings");
    for (const body of [true, 1, "x", null, undefined, ["a"]]) {
      expect(manifest.resolveTier(op, { body })).toBe("write");
    }
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

// The env.update resolver (A1) is the headline security surface: only CLEARING
// an existing agent-editable secret escalates PUT /api/env to dangerous. Its
// classification calls readEnvFile() from lib/server/env, which reads
// ENV_FILE_PATH via the shared fs module — so we drive it by spying on
// fs.readFileSync (vitest's module mocker does not intercept CJS require).
describe("admin-manifest env.update body-aware tierResolver (A1)", () => {
  const { ENV_FILE_PATH } = require("../../lib/server/constants");

  // Point readEnvFile at a synthetic .env by intercepting the ONE fs.readFileSync
  // call it makes for ENV_FILE_PATH; every other read passes through untouched.
  const mockEnvFile = (entries) => {
    const content = entries.map(({ key, value }) => `${key}=${value}`).join("\n");
    const realReadFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((target, ...rest) => {
      if (target === ENV_FILE_PATH) return content;
      return realReadFileSync(target, ...rest);
    });
  };

  const resolveEnvUpdate = (body) => {
    const op = manifest.findOp("PUT", "/api/env");
    return manifest.resolveTier(op, { body });
  };

  it("escalates to dangerous when the payload OMITS an existing agent-editable secret", () => {
    mockEnvFile([{ key: "ANTHROPIC_API_KEY", value: "x" }]);
    expect(resolveEnvUpdate({ vars: [] })).toBe("dangerous");
  });

  it("escalates to dangerous when the payload BLANKS an existing agent-editable secret", () => {
    mockEnvFile([{ key: "ANTHROPIC_API_KEY", value: "x" }]);
    expect(
      resolveEnvUpdate({ vars: [{ key: "ANTHROPIC_API_KEY", value: "" }] }),
    ).toBe("dangerous");
  });

  it("stays restart when the payload KEEPS/rotates the secret (one-shot write, no confirm)", () => {
    mockEnvFile([{ key: "ANTHROPIC_API_KEY", value: "x" }]);
    expect(
      resolveEnvUpdate({ vars: [{ key: "ANTHROPIC_API_KEY", value: "y" }] }),
    ).toBe("restart");
  });

  // B3 regression: managed/reserved/hidden keys are preserved (or rejected)
  // server-side regardless of the payload, so omitting one is NOT an agent
  // clear and must NOT escalate — otherwise any deployment holding a channel
  // token in .env would push every agent env write to dangerous.
  it("does NOT escalate when a MANAGED channel token is omitted (B3)", () => {
    mockEnvFile([{ key: "TELEGRAM_BOT_TOKEN", value: "t" }]);
    expect(resolveEnvUpdate({ vars: [] })).toBe("restart");
  });

  it("does NOT escalate when a RESERVED system key is omitted (B3)", () => {
    mockEnvFile([{ key: "SETUP_PASSWORD", value: "p" }]);
    expect(resolveEnvUpdate({ vars: [] })).toBe("restart");
  });

  it("does NOT escalate when a HIDDEN known var is omitted (B3)", () => {
    // kHiddenKnownVarKeys is non-empty (ANTHROPIC_TOKEN, visibleInEnvars:false).
    const { kHiddenKnownVarKeys } = require("../../lib/server/utils/env-keys");
    expect(kHiddenKnownVarKeys.has("ANTHROPIC_TOKEN")).toBe(true);
    mockEnvFile([{ key: "ANTHROPIC_TOKEN", value: "tok" }]);
    expect(resolveEnvUpdate({ vars: [] })).toBe("restart");
  });

  it("escalates to dangerous when an agent SETS a new Claude Code launcher key", () => {
    // The launcher config is human-editable but agent-protected: repointing it
    // would let a compromised agent hijack the operator's one-click launcher,
    // so an agent write requires an operator confirm even though it is a set,
    // not a clear.
    mockEnvFile([{ key: "ANTHROPIC_API_KEY", value: "x" }]);
    expect(
      resolveEnvUpdate({
        vars: [
          { key: "ANTHROPIC_API_KEY", value: "x" },
          { key: "CLAUDE_CODE_ROUTINE_TOKEN", value: "sk-ant-oat01-evil" },
        ],
      }),
    ).toBe("dangerous");
  });

  it("escalates to dangerous when an agent ROTATES the launcher URL", () => {
    mockEnvFile([{ key: "CLAUDE_CODE_ROUTINE_URL", value: "trig_original" }]);
    expect(
      resolveEnvUpdate({
        vars: [{ key: "CLAUDE_CODE_ROUTINE_URL", value: "trig_attacker" }],
      }),
    ).toBe("dangerous");
  });

  it("escalates to dangerous when an agent CLEARS the launcher URL by omission (non-sensitive key)", () => {
    // The URL is not secret-class, so the generic sensitive-clear rule would
    // miss it — the agent-protected rule catches the omit-as-delete.
    mockEnvFile([{ key: "CLAUDE_CODE_ROUTINE_URL", value: "trig_original" }]);
    expect(resolveEnvUpdate({ vars: [] })).toBe("dangerous");
  });

  // PR #30 bypass regression: the resolver classified the RAW submitted key
  // while the write path canonicalizes (stripLineBreaks + trim), so a padded
  // or linebroken protected key slipped through at base tier yet persisted as
  // the protected key — repointing the launcher with no operator confirm.
  it("escalates to dangerous when a protected key is set with TRAILING WHITESPACE (bypass regression)", () => {
    mockEnvFile([]);
    expect(
      resolveEnvUpdate({
        vars: [{ key: "CLAUDE_CODE_ROUTINE_URL ", value: "trig_attacker" }],
      }),
    ).toBe("dangerous");
  });

  it("escalates to dangerous when a protected key is set with an embedded LINEBREAK (bypass regression)", () => {
    mockEnvFile([]);
    expect(
      resolveEnvUpdate({
        vars: [{ key: "CLAUDE_CODE_ROUTINE_TOKEN\n", value: "sk-ant-oat01-evil" }],
      }),
    ).toBe("dangerous");
  });

  it("does NOT escalate for a PADDED non-protected key (normalization is exact, not substring)", () => {
    mockEnvFile([]);
    expect(
      resolveEnvUpdate({ vars: [{ key: "  FEATURE_FLAG  ", value: "1" }] }),
    ).toBe("restart");
  });

  it("escalates to dangerous when a protected key is smuggled as a NON-STRING (array coercion)", () => {
    // String(["CLAUDE_CODE_ROUTINE_URL"]) === "CLAUDE_CODE_ROUTINE_URL": the
    // write path coerces, so the resolver must classify the coerced key, not
    // filter non-strings out into the base tier.
    mockEnvFile([]);
    expect(
      resolveEnvUpdate({
        vars: [{ key: ["CLAUDE_CODE_ROUTINE_URL"], value: "http://evil/routine" }],
      }),
    ).toBe("dangerous");
  });

  it("escalates to dangerous for an array-coerced autonomous-spawn key", () => {
    mockEnvFile([]);
    expect(
      resolveEnvUpdate({
        vars: [{ key: ["CLAUDE_CODE_LOCAL_SPAWN_ON_INCIDENT"], value: "1" }],
      }),
    ).toBe("dangerous");
  });

  it("isAgentProtectedEnvKey normalizes its argument (unit)", () => {
    const { isAgentProtectedEnvKey } = require("../../lib/server/utils/env-keys");
    expect(isAgentProtectedEnvKey("CLAUDE_CODE_ROUTINE_URL ")).toBe(true);
    expect(isAgentProtectedEnvKey("CLAUDE_CODE_ROUTINE_TOKEN\n")).toBe(true);
    expect(isAgentProtectedEnvKey("CLAUDE_CODE_ROUTINE_URL")).toBe(true);
    expect(isAgentProtectedEnvKey("FEATURE_FLAG")).toBe(false);
  });

  it("stays restart when the launcher keys are unchanged (kept verbatim)", () => {
    mockEnvFile([
      { key: "CLAUDE_CODE_ROUTINE_URL", value: "trig_x" },
      { key: "CLAUDE_CODE_ROUTINE_TOKEN", value: "sk-ant-oat01-keep" },
    ]);
    expect(
      resolveEnvUpdate({
        vars: [
          { key: "CLAUDE_CODE_ROUTINE_URL", value: "trig_x" },
          { key: "CLAUDE_CODE_ROUTINE_TOKEN", value: "sk-ant-oat01-keep" },
        ],
      }),
    ).toBe("restart");
  });

  it("stays restart when the env file cannot be read (readEnvFile swallows → [])", () => {
    // readEnvFile catches read failures and returns [], so an unreadable .env
    // yields no known secrets to clear: tier stays at the base restart, never
    // hard-blocking an agent write on an I/O blip.
    const realReadFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((target, ...rest) => {
      if (target === ENV_FILE_PATH) throw new Error("unreadable env file");
      return realReadFileSync(target, ...rest);
    });
    expect(resolveEnvUpdate({ vars: [] })).toBe("restart");
  });
});

// A21 read-leak guard: browse content reads return raw bytes, so secret-bearing
// paths resolve to denied for the agent actor. Exercised through the shared
// browse read tierResolver.
describe("admin-manifest browse read tierResolver (A21 secret-path guard)", () => {
  const resolveBrowseRead = (queryPath) => {
    const op = manifest.findOp("GET", "/api/browse/read");
    return manifest.resolveTier(op, { query: { path: queryPath } });
  };

  it("allows ordinary workspace files", () => {
    expect(resolveBrowseRead("notes.md")).toBe("safe");
    expect(resolveBrowseRead("docs/readme.md")).toBe("safe");
  });

  it("denies the agent-admin token file", () => {
    expect(resolveBrowseRead(".alphaclaw/agent-admin-token")).toBe("denied");
  });

  it("denies OAuth credential stores", () => {
    expect(resolveBrowseRead("gogcli/credentials/x.json")).toBe("denied");
  });

  it("denies agent auth-profile stores", () => {
    expect(resolveBrowseRead("agents/main/agent/auth-profiles.json")).toBe(
      "denied",
    );
  });

  // B1: the browse handler runs path.resolve() and confines to root, so ".."
  // traversal reaches the real secret file. The resolver must collapse segments
  // BEFORE matching — a raw prefix check on the query string would leak.
  it("collapses .. traversal into a secret path and denies it (B1)", () => {
    expect(resolveBrowseRead("skills/../.alphaclaw/agent-admin-token")).toBe(
      "denied",
    );
    expect(resolveBrowseRead("x/../gogcli/credentials/y")).toBe("denied");
  });

  it("normalizes leading ./ and duplicate slashes before matching (B1)", () => {
    expect(resolveBrowseRead(".//.alphaclaw/agent-admin-token")).toBe("denied");
  });
});
