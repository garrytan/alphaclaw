// Which models a box can be asked to run, and how AlphaClaw would reach each
// one's provider. Pure reads over openclaw.json: every ref named as a primary,
// a fallback, an allowlist entry (modelPolicy.allow or the models map) or an
// alias target, for the defaults and each agents.list entry. A ref is a
// "provider/model" string; wildcards ("provider/*") select nothing to check.
const { isNonArrayObject } = require("../utils/object");

const kProbeableApis = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
const kDefaultApi = "openai-completions";

const splitRef = (ref) => {
  const value = String(ref || "").trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  const modelId = value.slice(slash + 1);
  if (modelId === "*" || /\s/.test(value)) return null;
  return { ref: value, provider: value.slice(0, slash), modelId };
};

const collectModelTargets = (config) => {
  const byRef = new Map();
  const add = (rawRef, role, scope) => {
    const parsed = splitRef(rawRef);
    if (!parsed) return null;
    const entry = byRef.get(parsed.ref) || { ...parsed, roles: [], aliases: [] };
    const tag = scope === "defaults" ? role : `${role} (${scope})`;
    if (!entry.roles.includes(tag)) entry.roles.push(tag);
    byRef.set(parsed.ref, entry);
    return entry;
  };
  const addScope = (scope, node) => {
    if (!isNonArrayObject(node)) return;
    const model = node.model;
    if (typeof model === "string") add(model, "primary", scope);
    else if (isNonArrayObject(model)) {
      add(model.primary, "primary", scope);
      for (const fallback of Array.isArray(model.fallbacks) ? model.fallbacks : []) add(fallback, "fallback", scope);
    }
    if (isNonArrayObject(node.models)) {
      for (const [ref, settings] of Object.entries(node.models)) {
        const entry = add(ref, "allowed", scope);
        const alias = typeof settings?.alias === "string" ? settings.alias.trim() : "";
        if (entry && alias && !entry.aliases.includes(alias)) entry.aliases.push(alias);
      }
    }
    for (const ref of Array.isArray(node.modelPolicy?.allow) ? node.modelPolicy.allow : []) add(ref, "allowed", scope);
  };
  addScope("defaults", config?.agents?.defaults);
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  agents.forEach((agent, index) => {
    const id = String(agent?.id || "").trim();
    addScope(`agent ${/^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : `#${index}`}`, agent);
  });
  return [...byRef.values()];
};

// A secret-bearing value: "${VAR}" substitution, a bare env var name that is
// set, or an env SecretRef. File, exec and store refs are OpenClaw's to read.
const kBareEnvName = /^[A-Z][A-Z0-9_]{2,}$/;
const kEnvReference = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const resolveSecretValue = (value, env = {}) => {
  if (value === undefined || value === null || value === "") return { present: false };
  if (isNonArrayObject(value)) {
    if (value.source !== "env" || typeof value.id !== "string") return { present: true, unreadable: true };
    const resolved = String(env[value.id] || "").trim();
    return resolved ? { present: true, value: resolved, envVar: value.id } : { present: false, envVar: value.id };
  }
  const text = String(value).trim();
  if (kBareEnvName.test(text) && Object.hasOwn(env, text)) {
    const resolved = String(env[text] || "").trim();
    return resolved ? { present: true, value: resolved, envVar: text } : { present: false, envVar: text };
  }
  const names = [...text.matchAll(kEnvReference)].map((match) => match[1]);
  const missing = names.find((name) => !String(env[name] || "").trim());
  if (missing) return { present: false, envVar: missing };
  const substituted = text.replace(kEnvReference, (_, name) => String(env[name]).trim());
  return { present: true, value: substituted, ...(names.length ? { envVar: names[0] } : {}) };
};

const resolveHeaders = (headers, env) => {
  const out = {};
  if (!isNonArrayObject(headers)) return out;
  for (const [name, raw] of Object.entries(headers)) {
    const resolved = resolveSecretValue(raw, env);
    if (resolved.present && !resolved.unreadable) out[name] = resolved.value;
  }
  return out;
};

const kLoopbackUrl = /^https?:\/\/(127\.|localhost[:/]|\[::1\])/i;

// How AlphaClaw would call this provider for a probe, or why it will not.
// Only custom providers (a models.providers entry with a baseUrl) on an API
// AlphaClaw speaks are probed; plugin-managed providers are OpenClaw's to
// resolve and are reported from its own listing instead.
const resolveProviderConnection = ({ config, provider, env = {}, profiles = [] }) => {
  const entry = config?.models?.providers?.[provider];
  if (!isNonArrayObject(entry)) return { custom: false };
  const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
  const api = typeof entry.api === "string" && entry.api.trim() ? entry.api.trim() : kDefaultApi;
  const declaredModels = (Array.isArray(entry.models) ? entry.models : [])
    .map((model) => String(model?.id || "").trim())
    .filter(Boolean);
  const base = { custom: true, api, baseUrl: baseUrl || null, declaredModels };
  if (!baseUrl) return { ...base, probe: false, skip: "no_base_url" };
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ...base, probe: false, skip: "bad_base_url" };
  } catch {
    return { ...base, probe: false, skip: "bad_base_url" };
  }
  if (!kProbeableApis.has(api)) return { ...base, probe: false, skip: "unsupported_api" };
  const headers = { ...resolveHeaders(entry.headers, env), ...resolveHeaders(entry.request?.headers, env) };
  const requestAuth = isNonArrayObject(entry.request?.auth) ? entry.request.auth : null;
  const fromRequestAuth = (raw, apply) => {
    const value = resolveSecretValue(raw, env);
    if (value.unreadable) return { ...base, probe: false, skip: "credential_unreadable" };
    if (!value.present) return { ...base, probe: false, skip: "no_credential", envVar: value.envVar || null };
    apply(value.value);
    return { ...base, probe: true, headers, credentialSource: "request.auth" };
  };
  if (requestAuth?.mode === "header" && typeof requestAuth.headerName === "string") {
    return fromRequestAuth(requestAuth.value, (value) => {
      headers[requestAuth.headerName] = `${typeof requestAuth.prefix === "string" ? requestAuth.prefix : ""}${value}`;
    });
  }
  if (requestAuth?.mode === "authorization-bearer") {
    return fromRequestAuth(requestAuth.token, (value) => {
      headers.Authorization = `Bearer ${value}`;
    });
  }
  let credential = resolveSecretValue(entry.apiKey, env);
  let credentialSource = credential.envVar ? `env ${credential.envVar}` : "apiKey";
  if (!credential.present && !credential.envVar) {
    const profile = profiles.find(
      (item) => item?.provider === provider && (item.type === "api_key" || item.type === "token") && (item.key || item.token),
    );
    if (profile) {
      credential = { present: true, value: String(profile.key || profile.token).trim() };
      credentialSource = `auth profile ${profile.id}`;
    }
  }
  if (credential.unreadable) return { ...base, probe: false, skip: "credential_unreadable" };
  if (!credential.present) {
    if (credential.envVar || (!Object.keys(headers).length && !kLoopbackUrl.test(baseUrl))) {
      return { ...base, probe: false, skip: "no_credential", envVar: credential.envVar || null };
    }
    return { ...base, probe: true, headers, credentialSource: "none" };
  }
  if (api === "anthropic-messages" && entry.authHeader !== true) headers["x-api-key"] = credential.value;
  else headers.Authorization = `Bearer ${credential.value}`;
  return { ...base, probe: true, headers, credentialSource };
};

module.exports = {
  collectModelTargets,
  resolveProviderConnection,
  resolveSecretValue,
  splitRef,
  kProbeableApis,
};
