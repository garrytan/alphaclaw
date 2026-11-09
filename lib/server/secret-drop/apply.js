// Saving one secret drop: the same value goes to AlphaClaw's .env (the
// PATCH /api/env write path) and to OpenClaw's secret store (`openclaw
// secrets store set`, value on stdin, never in argv). Both stores are checked
// before either is written, the gateway lifecycle lock is held across the
// writes and the reload, and a failure says which store holds the value. The
// value lives only in this call; nothing here logs, returns or keeps it.
const { classifySecretDropKey } = require("../utils/env-keys");
const { findUnwritableEnvValue } = require("../utils/env-file-format");
const { classifyEnvKeyReach } = require("../env-key-reach");

const kStoreCliTimeoutMs = 20_000;
const kStoreValueMaxBytes = 65_536;

// One trailing line break (a paste artifact) is dropped, once, and a pasted
// CRLF becomes LF, so both stores get the same bytes.
const normalizeSecretValue = (raw) => {
  const value = String(raw ?? "").replace(/\r\n/g, "\n");
  return value.endsWith("\n") || value.endsWith("\r") ? value.slice(0, -1) : value;
};

// A store SecretRef ({ source: "store", id: NAME }) anywhere in openclaw.json:
// only then does the running gateway need `openclaw secrets reload`.
const configReferencesStoreId = (config, name) => {
  const stack = [config];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (node.source === "store" && node.id === name) return true;
    for (const child of Object.values(node)) if (child && typeof child === "object") stack.push(child);
  }
  return false;
};

const createSecretDropApplier = ({
  execFileCmd,
  gatewayEnv,
  readEnvFile,
  setEnvKey,
  readOpenclawConfig = () => ({}),
  gatewayLifecycleLock = null,
  resolveEnvKeyReach = (name) => classifyEnvKeyReach(name),
}) => {
  const openclaw = (args, { input = null } = {}) =>
    execFileCmd("openclaw", args, { env: gatewayEnv(), processGroup: true, timeoutMs: kStoreCliTimeoutMs, ...(input != null ? { input } : {}) });

  // name → kind. env-kind rows carry a valuePreview; only name and kind are
  // read, and the output is never logged.
  const readStoreKinds = async () => {
    const out = await openclaw(["secrets", "store", "list", "--json"]);
    const rows = JSON.parse(out.slice(out.indexOf("[")));
    if (!Array.isArray(rows)) throw new Error("unexpected store list");
    return new Map(rows.filter((row) => row && typeof row.name === "string").map((row) => [row.name, String(row.kind || "")]));
  };

  const exitOf = (error) => (error?.timedOut ? "timed out" : `exit ${error?.code ?? "?"}`);

  const apply = async ({ req, name, rawValue }) => {
    const verdict = classifySecretDropKey(name);
    if (!verdict.ok) return { status: "refused", code: verdict.reason, error: verdict.error };
    const value = normalizeSecretValue(rawValue);
    if (!value) return { status: "refused", code: "empty", error: "Paste a value, then press Save." };
    if (Buffer.byteLength(value, "utf8") > kStoreValueMaxBytes) {
      return { status: "refused", code: "too_large", error: "The value is over 64 KiB, which OpenClaw's secret store cannot hold." };
    }
    const multiLine = /[\r\n]/.test(value);
    const envVars = readEnvFile();
    let envNotice = null;
    if (multiLine) {
      envNotice = "A value with line breaks cannot go in .env, so it was saved to OpenClaw's secret store only.";
    } else {
      if (value !== value.trimEnd()) {
        return { status: "refused", code: "trailing_space", error: "The value ends with a space or tab, which .env drops. Remove it, then press Save." };
      }
      const unwritable = findUnwritableEnvValue([{ key: name, value }], envVars);
      if (unwritable) envNotice = `${unwritable.error.split(". ")[0]}. It was saved to OpenClaw's secret store only.`;
    }
    const envTarget = !envNotice;
    const staleEnvNotice =
      !envTarget && (envVars || []).some((entry) => entry?.key === name)
        ? `.env still holds an older ${name}. AlphaClaw and programs that read .env keep using that one until you change or remove it in Envars.`
        : null;

    let kinds;
    try {
      kinds = await readStoreKinds();
    } catch (error) {
      return { status: "refused", code: "store_unreadable", error: `OpenClaw's secret store could not be read (${exitOf(error)}). Nothing was saved.` };
    }
    const existingKind = kinds.get(name) || null;
    const setArgs = ["secrets", "store", "set", name, ...(existingKind ? [] : ["--kind", "secret"])];
    try {
      await openclaw([...setArgs, "--dry-run"], { input: value });
    } catch (error) {
      return { status: "refused", code: "store_refused", error: `OpenClaw's secret store refused the value (${exitOf(error)}). Nothing was saved.` };
    }

    const stores = { env: false, store: false };
    const problems = [];
    let reloaded = null;
    let release = null;
    try {
      if (gatewayLifecycleLock) release = await gatewayLifecycleLock.acquire("secret_drop");
      if (envTarget) {
        try {
          await setEnvKey(req, name, value);
          stores.env = true;
        } catch (error) {
          problems.push(`.env was not written: ${String(error?.message || "write failed").split("\n")[0].slice(0, 200)}`);
        }
      }
      try {
        await openclaw(setArgs, { input: value });
        stores.store = true;
      } catch (error) {
        problems.push(`OpenClaw's secret store was not written (${exitOf(error)}).`);
      }
      if (stores.store && configReferencesStoreId(readOpenclawConfig(), name)) {
        try {
          await openclaw(["secrets", "reload", "--json"]);
          reloaded = true;
        } catch (error) {
          reloaded = false;
          problems.push(`OpenClaw did not reload its secrets (${exitOf(error)}); the gateway uses the new value after its next restart.`);
        }
      }
    } finally {
      release?.();
    }
    const complete = stores.store && (stores.env || !envTarget);
    const status = complete ? "stored" : stores.env || stores.store ? "partial" : "failed";
    return {
      status,
      stores,
      reach: {
        env: stores.env ? resolveEnvKeyReach(name) : null,
        storeKind: stores.store ? existingKind || "secret" : null,
        ...(reloaded !== null ? { reloaded } : {}),
      },
      notices: [envNotice, staleEnvNotice, ...problems].filter(Boolean),
      keptKind: existingKind,
    };
  };

  return { apply, readStoreKinds };
};

module.exports = {
  createSecretDropApplier,
  normalizeSecretValue,
  configReferencesStoreId,
  kStoreCliTimeoutMs,
};
