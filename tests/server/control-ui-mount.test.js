const kModulePath = require.resolve("../../lib/server/control-ui-mount");

// Fresh copy per call: kControlUiMount is resolved at module load, so the
// mode tests set the env and re-require.
const loadFresh = (env = {}) => {
  const saved = process.env.ALPHACLAW_CONTROL_UI_MOUNT;
  if (env.ALPHACLAW_CONTROL_UI_MOUNT === undefined) {
    delete process.env.ALPHACLAW_CONTROL_UI_MOUNT;
  } else {
    process.env.ALPHACLAW_CONTROL_UI_MOUNT = env.ALPHACLAW_CONTROL_UI_MOUNT;
  }
  delete require.cache[kModulePath];
  try {
    return require(kModulePath);
  } finally {
    if (saved === undefined) delete process.env.ALPHACLAW_CONTROL_UI_MOUNT;
    else process.env.ALPHACLAW_CONTROL_UI_MOUNT = saved;
    delete require.cache[kModulePath];
  }
};

const mount = require("../../lib/server/control-ui-mount");
const {
  kControlUiBasePath,
  normalizeControlUiBasePath,
  resolveControlUiMount,
  applyControlUiBasePath,
  controlUiMountSatisfied,
  isUnsafeGatewayProxyPath,
  isControlUiResourcePath,
  classifyControlUiAuthResponse,
} = mount;

describe("control-ui-mount: normalizeControlUiBasePath (port of upstream)", () => {
  it.each([
    [undefined, ""],
    [null, ""],
    [123, ""],
    ["", ""],
    ["   ", ""],
    ["/", ""],
    ["/openclaw", "/openclaw"],
    ["/openclaw/", "/openclaw"],
    ["openclaw", "/openclaw"],
    ["openclaw/", "/openclaw"],
    ["  /openclaw  ", "/openclaw"],
    ["/OpenClaw", "/OpenClaw"],
    ["/a/b/", "/a/b"],
  ])("normalize(%j) → %j", (input, expected) => {
    expect(normalizeControlUiBasePath(input)).toBe(expected);
  });
});

describe("control-ui-mount: resolveControlUiMount", () => {
  it("defaults to basepath when the env key is unset or blank", () => {
    const warn = vi.fn();
    expect(resolveControlUiMount({}, { warn })).toBe("basepath");
    expect(resolveControlUiMount({ ALPHACLAW_CONTROL_UI_MOUNT: "  " }, { warn })).toBe("basepath");
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts legacy and basepath case-insensitively", () => {
    const warn = vi.fn();
    expect(resolveControlUiMount({ ALPHACLAW_CONTROL_UI_MOUNT: "legacy" }, { warn })).toBe("legacy");
    expect(resolveControlUiMount({ ALPHACLAW_CONTROL_UI_MOUNT: " LEGACY " }, { warn })).toBe("legacy");
    expect(resolveControlUiMount({ ALPHACLAW_CONTROL_UI_MOUNT: "BasePath" }, { warn })).toBe("basepath");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to basepath with one warning on an unknown value", () => {
    const warn = vi.fn();
    expect(resolveControlUiMount({ ALPHACLAW_CONTROL_UI_MOUNT: "bogus" }, { warn })).toBe("basepath");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("ALPHACLAW_CONTROL_UI_MOUNT");
    expect(warn.mock.calls[0][0]).toContain("basepath|legacy");
  });

  it("resolves kControlUiMount once at module load from the process env", () => {
    expect(loadFresh({}).kControlUiMount).toBe("basepath");
    expect(loadFresh({ ALPHACLAW_CONTROL_UI_MOUNT: "legacy" }).kControlUiMount).toBe("legacy");
    expect(loadFresh({ ALPHACLAW_CONTROL_UI_MOUNT: "nonsense" }).kControlUiMount).toBe("basepath");
  });

  it("is a deployment-only env key (never honored from the agent-writable .env)", () => {
    const { kDeploymentOnlyEnvKeys } = require("../../lib/server/deployment-only-env");
    expect(kDeploymentOnlyEnvKeys).toContain("ALPHACLAW_CONTROL_UI_MOUNT");
  });
});

describe("control-ui-mount: applyControlUiBasePath (basepath mode)", () => {
  const apply = (cfg) => {
    const log = vi.fn();
    const result = applyControlUiBasePath(cfg, { mount: "basepath", log });
    return { ...result, log, cfg };
  };

  it("sets the canonical value when controlUi is absent", () => {
    const { changed, previous, log, cfg } = apply({ gateway: {} });
    expect(changed).toBe(true);
    expect(previous).toBeUndefined();
    expect(cfg.gateway.controlUi.basePath).toBe("/openclaw");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/Set gateway\.controlUi\.basePath=\/openclaw/);
  });

  it("creates gateway when the config has none", () => {
    const { changed, cfg } = apply({});
    expect(changed).toBe(true);
    expect(cfg.gateway.controlUi.basePath).toBe("/openclaw");
  });

  it("is idempotent on the canonical value (no log, no change)", () => {
    const { changed, previous, log } = apply({
      gateway: { controlUi: { basePath: "/openclaw", allowedOrigins: ["https://x"] } },
    });
    expect(changed).toBe(false);
    expect(previous).toBe("/openclaw");
    expect(log).not.toHaveBeenCalled();
  });

  it.each([["openclaw/"], ["/openclaw/"], ["/dash"], [123], [""]])(
    "canonicalizes a stored %j (equivalent or not) to the exact string",
    (stored) => {
      const { changed, previous, log, cfg } = apply({
        gateway: { controlUi: { basePath: stored, allowedOrigins: ["https://x"] } },
      });
      expect(changed).toBe(true);
      expect(previous).toBe(stored);
      expect(cfg.gateway.controlUi.basePath).toBe("/openclaw");
      // Sibling keys survive.
      expect(cfg.gateway.controlUi.allowedOrigins).toEqual(["https://x"]);
      expect(log.mock.calls[0][0]).toMatch(/Replaced gateway\.controlUi\.basePath=/);
    },
  );

  it("replaces a non-object controlUi and logs it", () => {
    const { changed, log, cfg } = apply({ gateway: { controlUi: "bogus" } });
    expect(changed).toBe(true);
    expect(cfg.gateway.controlUi).toEqual({ basePath: "/openclaw" });
    expect(log.mock.calls[0][0]).toMatch(/gateway\.controlUi was "?bogus"? \(not an object\)/);
  });

  it("bounds the logged previous value to 200 chars", () => {
    const huge = `/${"x".repeat(1000)}`;
    const { log } = apply({ gateway: { controlUi: { basePath: huge } } });
    const line = log.mock.calls[0][0];
    expect(line).not.toContain("x".repeat(300));
    expect(line).toContain("…");
  });

  it("throws on a non-object cfg", () => {
    expect(() => applyControlUiBasePath(null, { mount: "basepath", log: vi.fn() })).toThrow(
      TypeError,
    );
  });
});

describe("control-ui-mount: applyControlUiBasePath (legacy mode)", () => {
  const apply = (cfg) => {
    const log = vi.fn();
    const result = applyControlUiBasePath(cfg, { mount: "legacy", log });
    return { ...result, log, cfg };
  };

  it.each([["/openclaw"], ["/openclaw/"], ["openclaw/"], [" /openclaw "]])(
    "removes AlphaClaw's own basePath %j (normalized equality)",
    (stored) => {
      const { changed, previous, log, cfg } = apply({
        gateway: { controlUi: { basePath: stored, allowedOrigins: ["https://x"] } },
      });
      expect(changed).toBe(true);
      expect(previous).toBe(stored);
      expect(cfg.gateway.controlUi).toEqual({ allowedOrigins: ["https://x"] });
      expect(log.mock.calls[0][0]).toMatch(/control_ui_mount=legacy — removed/);
    },
  );

  it("leaves a hand-set different path alone", () => {
    const { changed, log, cfg } = apply({ gateway: { controlUi: { basePath: "/dash" } } });
    expect(changed).toBe(false);
    expect(cfg.gateway.controlUi.basePath).toBe("/dash");
    expect(log).not.toHaveBeenCalled();
  });

  it("does not invent a controlUi object when none exists", () => {
    const { changed, cfg } = apply({ gateway: {} });
    expect(changed).toBe(false);
    expect(cfg.gateway.controlUi).toBeUndefined();
  });

  it("still repairs a non-object controlUi", () => {
    const { changed, cfg } = apply({ gateway: { controlUi: 42 } });
    expect(changed).toBe(true);
    expect(cfg.gateway.controlUi).toEqual({});
  });
});

describe("control-ui-mount: controlUiMountSatisfied", () => {
  it("basepath mode wants the exact canonical string", () => {
    expect(controlUiMountSatisfied({ gateway: { controlUi: { basePath: "/openclaw" } } }, "basepath")).toBe(true);
    expect(controlUiMountSatisfied({ gateway: { controlUi: { basePath: "/openclaw/" } } }, "basepath")).toBe(false);
    expect(controlUiMountSatisfied({ gateway: {} }, "basepath")).toBe(false);
    expect(controlUiMountSatisfied(null, "basepath")).toBe(false);
  });

  it("legacy mode wants our path gone (a different one may stay)", () => {
    expect(controlUiMountSatisfied({ gateway: {} }, "legacy")).toBe(true);
    expect(controlUiMountSatisfied({ gateway: { controlUi: { basePath: "/dash" } } }, "legacy")).toBe(true);
    expect(controlUiMountSatisfied({ gateway: { controlUi: { basePath: "/openclaw/" } } }, "legacy")).toBe(false);
    expect(controlUiMountSatisfied({ gateway: { controlUi: { basePath: "/openclaw" } } }, "legacy")).toBe(false);
  });
});

describe("control-ui-mount: isUnsafeGatewayProxyPath", () => {
  it.each([
    ["/openclaw"],
    ["/openclaw/"],
    ["/openclaw/dashboards"],
    ["/openclaw/assets/index-abc.css"],
    ["/openclaw/fonts/jetbrains-mono.css?v=b1"],
    ["/openclaw/assets/a.css?v=.."],
    ["/openclaw/a.b/c.d"],
    ["/openclaw/x?redirect=..%2f..%2fetc"],
    ["/assets/app.js"],
    ["/openclaw/caf%C3%A9.css"],
  ])("allows %j", (rawUrl) => {
    expect(isUnsafeGatewayProxyPath(rawUrl)).toBe(false);
  });

  it.each([
    ["/openclaw/../v1/models"],
    ["/openclaw/..\\v1/models"],
    ["/openclaw/%2e%2e/v1/models"],
    ["/openclaw/%2E%2E/v1/models"],
    ["/openclaw/%5c..%5cv1/models"],
    ["/openclaw/%5C..%5Cv1/models"],
    ["/openclaw/./x"],
    ["/openclaw/a/.."],
    ["/openclaw/.."],
    ["/openclaw/%zz"],
    ["/assets/../v1/models"],
    ["/assets/..%5cv1"],
    // Backslash right after the prefix and absolute-form request-targets: the
    // forms a prefix-gated guard would miss, and WHATWG URL would normalize.
    ["/openclaw\\../ws-echo"],
    ["http://host/openclaw/../x"],
  ])("rejects %j", (rawUrl) => {
    expect(isUnsafeGatewayProxyPath(rawUrl)).toBe(true);
  });
});

describe("control-ui-mount: auth response classifier", () => {
  const classify = (method, path, headers = {}) =>
    classifyControlUiAuthResponse({ method, path, headers });

  it("recognizes asset-shaped Control UI paths", () => {
    for (const path of [
      "/openclaw/assets/index-abc.js",
      "/openclaw/fonts/instrument-sans.css?v=b1",
      "/openclaw/themes/dash.css",
      "/openclaw/sw.js",
      "/openclaw/manifest.webmanifest",
      "/openclaw/favicon.svg",
      "/openclaw/favicon-32.png",
      "/openclaw/apple-touch-icon.png",
      "/openclaw/__openclaw/control-ui-config.json",
      "/openclaw/__openclaw__/catalog-icon/x",
      "/openclaw/avatar/main",
      "/openclaw/share/card.png",
      "/assets/anything.css",
    ]) {
      expect({ path, resource: isControlUiResourcePath(path) }).toEqual({ path, resource: true });
    }
    for (const path of ["/openclaw", "/openclaw/", "/openclaw/dashboards", "/openclaw/settings/secrets", "/login.html", "/api/x"]) {
      expect({ path, resource: isControlUiResourcePath(path) }).toEqual({ path, resource: false });
    }
  });

  it.each([
    // HEAD always redirects — the UI's stale-chunk probe must reach login.
    ["HEAD", "/openclaw/", { "sec-fetch-dest": "empty" }, "redirect"],
    ["HEAD", "/openclaw/fonts/x.css", {}, "redirect"],
    // Non-GET keeps the pre-existing behavior.
    ["POST", "/openclaw/dashboards", { "sec-fetch-dest": "empty" }, "redirect"],
    // Asset-shaped → 401 regardless of headers (curl, missing metadata, even a
    // bogus document dest).
    ["GET", "/openclaw/fonts/x.css", {}, "unauthorized"],
    ["GET", "/openclaw/fonts/x.css", { accept: "*/*" }, "unauthorized"],
    ["GET", "/openclaw/assets/chunk.js", { "sec-fetch-dest": "document" }, "unauthorized"],
    ["GET", "/assets/app.js", {}, "unauthorized"],
    // Document-shaped → fetch metadata decides.
    ["GET", "/openclaw/dashboards", { "sec-fetch-dest": "document" }, "redirect"],
    ["GET", "/openclaw/", { "sec-fetch-dest": "iframe" }, "redirect"],
    ["GET", "/openclaw/dashboards", { "sec-fetch-dest": "empty" }, "unauthorized"],
    ["GET", "/openclaw/dashboards", { "sec-fetch-dest": "style" }, "unauthorized"],
    // No metadata → Accept sniff, defaulting to the redirect.
    ["GET", "/openclaw/dashboards", {}, "redirect"],
    ["GET", "/openclaw/dashboards", { accept: "*/*" }, "redirect"],
    ["GET", "/openclaw/dashboards", { accept: "text/html,application/xhtml+xml,*/*;q=0.8" }, "redirect"],
    ["GET", "/openclaw/dashboards", { accept: "text/css,*/*;q=0.1" }, "unauthorized"],
    ["GET", "/openclaw/dashboards", { accept: "application/json" }, "unauthorized"],
    ["GET", "/openclaw/dashboards", { accept: "font/woff2" }, "unauthorized"],
    ["GET", "/openclaw/dashboards", { accept: "image/avif,image/webp" }, "unauthorized"],
    // Absolute-form request-targets (Node accepts them; Express routes by
    // pathname) classify by their pathname, never by the raw scheme+host.
    ["GET", "http://host/openclaw/fonts/x.css", { "sec-fetch-dest": "style" }, "unauthorized"],
    ["GET", "http://host/openclaw/dashboards", { "sec-fetch-dest": "document" }, "redirect"],
    // Dot segments normalize OUT of the scope → the existing redirect (the
    // traversal guard, not the classifier, owns forwarding decisions).
    ["GET", "/openclaw/../v1/models", {}, "redirect"],
    // Outside the Control UI namespaces → existing redirect, whatever the headers.
    ["GET", "/setup/protected", { "sec-fetch-dest": "style" }, "redirect"],
    ["GET", "/gateway/launch?to=dashboards", {}, "redirect"],
    ["GET", "/openclawx/fonts/a.css", { "sec-fetch-dest": "style" }, "redirect"],
  ])("%s %s %j → %s", (method, path, headers, expected) => {
    expect(classify(method, path, headers)).toBe(expected);
  });

  it("exposes the canonical mount path", () => {
    expect(kControlUiBasePath).toBe("/openclaw");
  });

  it("requestTargetPathname reduces origin-form, absolute-form and garbage to a pathname", () => {
    const { requestTargetPathname } = mount;
    expect(requestTargetPathname("/openclaw/fonts/x.css?v=1#frag")).toBe("/openclaw/fonts/x.css");
    expect(requestTargetPathname("http://host:1234/openclaw/sw.js?x")).toBe("/openclaw/sw.js");
    expect(requestTargetPathname("/openclaw/../v1/models")).toBe("/v1/models");
    expect(requestTargetPathname("")).toBe("/");
    expect(requestTargetPathname(undefined)).toBe("/");
  });
});
