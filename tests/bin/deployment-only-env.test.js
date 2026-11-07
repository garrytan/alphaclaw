const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { kDeploymentOnlyEnvKeys } = require("../../lib/server/deployment-only-env");

const kAuthorityKeys = [
  "ALPHACLAW_ALLOW_LEGACY_LOGIN",
  "ALPHACLAW_SETUP_URL",
  "ALPHACLAW_BASE_URL",
  "RENDER_EXTERNAL_URL",
  "URL",
  "RAILWAY_PUBLIC_DOMAIN",
  "RAILWAY_STATIC_URL",
];
const binPath = path.resolve(__dirname, "../../bin/alphaclaw.js");
const envPath = require.resolve("../../lib/server/env");
const originPath = require.resolve("../../lib/server/public-origin");

describe("deployment-only authority through CLI boot and runtime reload", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-env-authority-"));
    fs.mkdirSync(path.join(root, "home"));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const run = (deployment = {}, { keySuffix = "", reloadContent = null, fileKeys = kAuthorityKeys } = {}) => {
    const capture = path.join(root, "capture.json");
    const preload = path.join(root, "capture.cjs");
    fs.writeFileSync(
      path.join(root, ".env"),
      fileKeys.map((key) => `${key}${keySuffix} =${key === "ALPHACLAW_ALLOW_LEGACY_LOGIN" ? "1" : "https://file-only.invalid/private-value"}`).join("\n"),
    );
    fs.writeFileSync(preload, `
      const fs = require("fs");
      const keys = ${JSON.stringify(fileKeys)};
      const warnings = [];
      const warn = console.warn;
      console.warn = (...args) => { warnings.push(String(args[0])); warn(...args); };
      const snapshot = () => Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
      process.on("exit", () => {
        const boot = snapshot();
        const bootNotices = warnings.filter(line => line.includes("deployment-only"));
        const { reloadEnv } = require(${JSON.stringify(envPath)});
        const { resolvePublicOrigin } = require(${JSON.stringify(originPath)});
        const req = { headers: { host: "request.example" } };
        const bootOrigin = resolvePublicOrigin(req);
        const reloadContent = ${JSON.stringify(reloadContent)};
        if (reloadContent !== null) fs.writeFileSync(${JSON.stringify(path.join(root, ".env"))}, reloadContent);
        fs.appendFileSync(${JSON.stringify(path.join(root, ".env"))}, "\\nCUSTOM_SETTING=editable");
        const changed = reloadEnv();
        const secondChanged = reloadEnv();
        fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
          boot, bootNotices, reloaded: snapshot(), bootOrigin, reloadOrigin: resolvePublicOrigin(req),
          changed, secondChanged, custom: process.env.CUSTOM_SETTING
        }));
      });
    `);
    const result = spawnSync(process.execPath, ["--require", preload, binPath, "git-sync"], {
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        ALPHACLAW_ROOT_DIR: root,
        ...deployment,
      },
      encoding: "utf8",
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing --message for git-sync");
    return { result, captured: JSON.parse(fs.readFileSync(capture, "utf8")) };
  };

  it("ignores file-only authority at boot and reload, warns once per key without values, and keeps normal edits", () => {
    const { result, captured } = run();
    const unset = Object.fromEntries(kAuthorityKeys.map((key) => [key, null]));
    expect(captured.boot).toEqual(unset);
    expect(captured.reloaded).toEqual(unset);
    expect(captured.bootOrigin).toBe("http://request.example");
    expect(captured.reloadOrigin).toBe("http://request.example");
    expect(captured.changed).toBe(true);
    expect(captured.secondChanged).toBe(false);
    expect(captured.custom).toBe("editable");
    const notices = result.stderr.split("\n").filter((line) => line.includes("deployment-only"));
    for (const key of kAuthorityKeys) {
      expect(notices.filter((line) => line.includes(`setting ${key} in .env`))).toHaveLength(1);
      expect(captured.bootNotices.filter((line) => line.includes(`setting ${key} in .env`))).toHaveLength(1);
    }
    expect(notices.join("\n")).toContain("deployment environment");
    expect(`${result.stdout}${result.stderr}`).not.toContain("file-only.invalid");
    expect(`${result.stdout}${result.stderr}`).not.toContain("private-value");
  });

  it.each(kAuthorityKeys)("preserves genuine %s while ignoring higher-priority aliases in the file", (key) => {
    const value = key === "ALPHACLAW_ALLOW_LEGACY_LOGIN" ? "0"
      : key === "RAILWAY_PUBLIC_DOMAIN" ? "deployment.example" : "https://deployment.example";
    const { result, captured } = run({ [key]: value });
    const expected = Object.fromEntries(kAuthorityKeys.map((name) => [name, name === key ? value : null]));
    expect(captured.boot).toEqual(expected);
    expect(captured.reloaded).toEqual(expected);
    const origin = key === "ALPHACLAW_ALLOW_LEGACY_LOGIN" ? "http://request.example" : "https://deployment.example";
    expect(captured.bootOrigin).toBe(origin);
    expect(captured.reloadOrigin).toBe(origin);
    expect(result.stderr.split("\n").filter((line) => line.includes(`deployment-only setting ${key} in .env`))).toEqual([]);
  });

  it("does not promote a file-only value over an empty deployment setting", () => {
    const key = "ALPHACLAW_SETUP_URL";
    const { result, captured } = run({ [key]: "" });
    expect(captured.boot[key]).toBe("");
    expect(captured.reloaded[key]).toBe("");
    expect(captured.reloadOrigin).toBe("http://request.example");
    expect(result.stderr.split("\n").filter((line) => line.includes(`deployment-only setting ${key} in .env`))).toHaveLength(1);
  });

  it.each([null, ...kAuthorityKeys])("does not alias raw NUL-suffixed keys at boot or reload (deployment key: %s)", (deploymentKey) => {
    const deploymentValue = deploymentKey === "ALPHACLAW_ALLOW_LEGACY_LOGIN" ? "0"
      : deploymentKey === "RAILWAY_PUBLIC_DOMAIN" ? "deployment.example" : "https://deployment.example";
    const expected = Object.fromEntries(kAuthorityKeys.map((key) => [key, key === deploymentKey ? deploymentValue : null]));
    const { result, captured } = run(deploymentKey ? { [deploymentKey]: deploymentValue } : {}, {
      keySuffix: "\0ignored",
      reloadContent: kAuthorityKeys.map((key) => `${key}\0ignored=${key === "ALPHACLAW_ALLOW_LEGACY_LOGIN" ? "1" : "https://reload-only.invalid/private-value"}`).join("\n"),
    });
    expect(captured.boot).toEqual(expected);
    expect(captured.reloaded).toEqual(expected);
    const origin = !deploymentKey || deploymentKey === "ALPHACLAW_ALLOW_LEGACY_LOGIN" ? "http://request.example" : "https://deployment.example";
    expect(captured.bootOrigin).toBe(origin);
    expect(captured.reloadOrigin).toBe(origin);
    expect(captured.custom).toBe("editable");
    expect(captured.changed).toBe(true);
    expect(captured.secondChanged).toBe(false);
    expect(`${result.stdout}${result.stderr}`).not.toContain("private-value");
    expect(`${result.stdout}${result.stderr}`).not.toContain("\0");
  });

  it("does not delete deployment values through empty NUL-suffixed file settings", () => {
    const deployment = Object.fromEntries(kAuthorityKeys.map((key) => [key,
      key === "ALPHACLAW_ALLOW_LEGACY_LOGIN" ? "0" : key === "RAILWAY_PUBLIC_DOMAIN" ? "deployment.example" : "https://deployment.example",
    ]));
    const { result, captured } = run(deployment, {
      keySuffix: "\0ignored",
      reloadContent: kAuthorityKeys.map((key) => `${key}\0ignored=`).join("\n"),
    });
    expect(captured.boot).toEqual(deployment);
    expect(captured.reloaded).toEqual(deployment);
    expect(captured.reloadOrigin).toBe("https://deployment.example");
    expect(`${result.stdout}${result.stderr}`).not.toContain("private-value");
    expect(`${result.stdout}${result.stderr}`).not.toContain("\0");
  });

  it.each([false, true])("rejects NUL aliases across every deployment-only family (deployment settings present: %s)", (configured) => {
    const deployment = configured ? Object.fromEntries(kDeploymentOnlyEnvKeys.map((key) => [key,
      key === "RAILWAY_PUBLIC_DOMAIN" ? "deployment.example"
        : kAuthorityKeys.includes(key) && key !== "ALPHACLAW_ALLOW_LEGACY_LOGIN" ? "https://deployment.example" : "0",
    ])) : {};
    const expected = Object.fromEntries(kDeploymentOnlyEnvKeys.map((key) => [key, deployment[key] ?? null]));
    const { result, captured } = run(deployment, {
      fileKeys: kDeploymentOnlyEnvKeys,
      keySuffix: "\0ignored",
      reloadContent: kDeploymentOnlyEnvKeys.map((key) => `${key}\0ignored=https://reload-only.invalid/private-value`).join("\n"),
    });
    expect(captured.boot).toEqual(expected);
    expect(captured.reloaded).toEqual(expected);
    expect(captured.custom).toBe("editable");
    expect(`${result.stdout}${result.stderr}`).not.toContain("private-value");
    expect(`${result.stdout}${result.stderr}`).not.toContain("\0");
  });
});

describe("deployment secrets through CLI boot and runtime reload (ALPH-73)", () => {
  const kWinsKeys = ["SETUP_PASSWORD", "GOG_KEYRING_PASSWORD"];
  const kOnlyKeys = ["ALPHACLAW_MANAGED_UPDATE_TOKEN", "RAILWAY_TOKEN", "RAILWAY_API_TOKEN", "VERCEL_TOKEN", "NPM_TOKEN"];
  const kAllKeys = [...kWinsKeys, ...kOnlyKeys];
  const word = (side, key) => `${side}-side-${key.toLowerCase().replace(/_/g, "-")}`;
  const lines = (keys, side) => keys.map((key) => `${key}=${side ? word(side, key) : ""}`).join("\n");
  const values = (keys, side) => Object.fromEntries(keys.map((key) => [key, word(side, key)]));
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-env-secrets-"));
    fs.mkdirSync(path.join(root, "home"));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const boot = ({ deployment = {}, fileText, reloadText = null }) => {
    const capture = path.join(root, "capture.json");
    const preload = path.join(root, "capture.cjs");
    fs.writeFileSync(path.join(root, ".env"), fileText);
    fs.writeFileSync(preload, `
      const fs = require("fs");
      const keys = ${JSON.stringify(kAllKeys)};
      const snapshot = () => Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
      process.on("exit", () => {
        const boot = snapshot();
        const { reloadEnv } = require(${JSON.stringify(envPath)});
        const reloadText = ${JSON.stringify(reloadText)};
        if (reloadText !== null) fs.writeFileSync(${JSON.stringify(path.join(root, ".env"))}, reloadText);
        reloadEnv();
        fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ boot, reloaded: snapshot() }));
      });
    `);
    const result = spawnSync(process.execPath, ["--require", preload, binPath, "git-sync"], {
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        ALPHACLAW_ROOT_DIR: root,
        ALPHACLAW_GIT_SHIM_PATH: path.join(root, "shims", "git"),
        ALPHACLAW_OPENCLAW_WRAPPER_PATH: path.join(root, "shims", "openclaw"),
        ALPHACLAW_PROFILE_SNIPPET_PATH: path.join(root, "shims", "profile.sh"),
        ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL: "true",
        ...deployment,
      },
      encoding: "utf8",
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain("Missing --message for git-sync");
    return { output: `${result.stdout}${result.stderr}`, captured: JSON.parse(fs.readFileSync(capture, "utf8")) };
  };

  it("keeps the deployment SETUP_PASSWORD and GOG_KEYRING_PASSWORD at boot over different .env values, naming the keys only", () => {
    const deployment = values(kWinsKeys, "deployment");
    const { output, captured } = boot({ deployment, fileText: lines(kWinsKeys, "file") });
    expect(captured.boot).toMatchObject(deployment);
    for (const key of kWinsKeys) {
      expect(output.split("\n").filter((line) => line.includes(`Ignoring ${key} in .env`))).toHaveLength(1);
    }
    expect(output).not.toContain("file-side");
    expect(output).not.toContain("deployment-side");
  });

  it("keeps the deployment SETUP_PASSWORD on reload when .env is changed to another value", () => {
    const deployment = values(kWinsKeys, "deployment");
    const { output, captured } = boot({ deployment, fileText: lines(kWinsKeys, ""), reloadText: lines(kWinsKeys, "reload") });
    expect(captured.boot).toMatchObject(deployment);
    expect(captured.reloaded).toMatchObject(deployment);
    expect(output).not.toContain("reload-side");
  });

  it("still takes SETUP_PASSWORD and GOG_KEYRING_PASSWORD from .env when the deployment does not set them (host installs)", () => {
    const fromFile = values(kWinsKeys, "file");
    const { output, captured } = boot({ fileText: lines(kWinsKeys, "file") });
    expect(captured.boot).toMatchObject(fromFile);
    expect(captured.reloaded).toMatchObject(fromFile);
    expect(output).not.toContain("Ignoring SETUP_PASSWORD");
  });

  it("never applies the managed update token or the platform tokens from .env, at boot or on reload, naming the keys only", () => {
    const { output, captured } = boot({ fileText: lines(kOnlyKeys, "file"), reloadText: lines(kOnlyKeys, "reload") });
    const unset = Object.fromEntries(kOnlyKeys.map((key) => [key, null]));
    expect(captured.boot).toMatchObject(unset);
    expect(captured.reloaded).toMatchObject(unset);
    for (const key of kOnlyKeys) {
      expect(output.split("\n").filter((line) => line.includes(`deployment-only setting ${key} in .env`))).toHaveLength(1);
    }
    expect(output).not.toContain("file-side");
    expect(output).not.toContain("reload-side");
  });

  it("keeps the deployment values of the managed update token and the platform tokens over .env", () => {
    const deployment = values(kOnlyKeys, "deployment");
    const { captured } = boot({ deployment, fileText: lines(kOnlyKeys, "file"), reloadText: lines(kOnlyKeys, "reload") });
    expect(captured.boot).toMatchObject(deployment);
    expect(captured.reloaded).toMatchObject(deployment);
  });

  it("the shipped env.template says the deployment SETUP_PASSWORD wins over its line", () => {
    const template = fs.readFileSync(path.resolve(__dirname, "../../lib/setup/env.template"), "utf8");
    expect(template).toMatch(/# Set SETUP_PASSWORD in the deployment environment[^]*When the deployment sets it, this\n# line is ignored/);
  });
});
