// Direct completion client for AlphaClaw's own advisory/repair AI calls
// (gateway startup medic). Raw fetch instead of provider SDKs on purpose:
// this code runs exactly when the OpenClaw gateway is DOWN (so no proxying
// through it), it must cover several providers with one tiny surface, and
// AlphaClaw ships without provider SDK dependencies (the overseer's `claude`
// CLI subprocess is the only other LLM path and requires a binary the
// container may not have).
//
// "Smartest frontier model it has keys for": candidates are ranked most
// capable first and the first one whose provider key is configured is tried;
// on failure the chain falls through. Rankings follow the same ordering the
// Setup UI's featured-model list encodes (Anthropic first, then OpenAI, then
// Google).

const kDefaultMaxTokens = 4096;
const kDefaultCandidateTimeoutMs = 120_000;
const kDefaultOverallDeadlineMs = 5 * 60_000;

// Most capable first. claude-fable-5 requires a 30-day-retention org and can
// decline via stop_reason "refusal" — both fall through to claude-opus-5 on
// the same key (and Fable requests also carry the server-side fallback
// parameter, which reroutes safety declines inside one API call).
const kFrontierModelRanking = [
  { provider: "anthropic", model: "claude-fable-5", envVar: "ANTHROPIC_API_KEY" },
  { provider: "anthropic", model: "claude-opus-5", envVar: "ANTHROPIC_API_KEY" },
  { provider: "openai", model: "gpt-5.6-sol", envVar: "OPENAI_API_KEY" },
  { provider: "google", model: "gemini-3.1-pro-preview", envVar: "GEMINI_API_KEY" },
];

const buildAnthropicRequest = ({ model, apiKey, system, prompt, maxTokens }) => {
  const isFable = model.startsWith("claude-fable");
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...(isFable
        ? { "anthropic-beta": "server-side-fallback-2026-07-01" }
        : {}),
    },
    body: {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
      ...(isFable ? { fallbacks: "default" } : {}),
    },
  };
};

const parseAnthropicResponse = (json) => {
  if (json?.stop_reason === "refusal") {
    return { error: "model declined the request (safety refusal)" };
  }
  const text = (Array.isArray(json?.content) ? json.content : [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text || ""))
    .join("\n")
    .trim();
  return text ? { text } : { error: "empty completion" };
};

const buildOpenAiRequest = ({ model, apiKey, system, prompt, maxTokens }) => ({
  url: "https://api.openai.com/v1/chat/completions",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  },
  body: {
    model,
    max_completion_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  },
});

const parseOpenAiResponse = (json) => {
  const text = String(json?.choices?.[0]?.message?.content || "").trim();
  return text ? { text } : { error: "empty completion" };
};

const buildGoogleRequest = ({ model, apiKey, system, prompt, maxTokens }) => ({
  // Key goes in a header, not the query string, so it can never land in
  // request logs or thrown error messages that include the URL.
  url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  headers: {
    "content-type": "application/json",
    "x-goog-api-key": apiKey,
  },
  body: {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  },
});

const parseGoogleResponse = (json) => {
  const parts = json?.candidates?.[0]?.content?.parts;
  const text = (Array.isArray(parts) ? parts : [])
    .map((part) => String(part?.text || ""))
    .join("")
    .trim();
  return text ? { text } : { error: "empty completion" };
};

const kProviderAdapters = {
  anthropic: { build: buildAnthropicRequest, parse: parseAnthropicResponse },
  openai: { build: buildOpenAiRequest, parse: parseOpenAiResponse },
  google: { build: buildGoogleRequest, parse: parseGoogleResponse },
};

const createFrontierLlmClient = ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  ranking = kFrontierModelRanking,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  const log = (message) => logger.log?.(`[llm-client] ${message}`);

  const resolveKey = (candidate) => {
    const value = String(env[candidate.envVar] || "").trim();
    return value || null;
  };

  const listCandidates = () =>
    ranking.map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      hasKey: !!resolveKey(candidate),
    }));

  const getAvailability = () => {
    const first = listCandidates().find((candidate) => candidate.hasKey);
    if (!first) {
      return {
        available: false,
        reason: "no_api_key",
        message:
          "No frontier-model API key configured (Anthropic, OpenAI, or Gemini).",
      };
    }
    return { available: true, provider: first.provider, model: first.model };
  };

  const completeWithCandidate = async (
    candidate,
    { system, prompt, maxTokens, timeoutMs },
  ) => {
    const apiKey = resolveKey(candidate);
    const adapter = kProviderAdapters[candidate.provider];
    if (!apiKey || !adapter) return { error: "no key" };
    const request = adapter.build({
      model: candidate.model,
      apiKey,
      system,
      prompt,
      maxTokens,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response;
    let json = null;
    try {
      response = await fetchImpl(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
      // The body read stays under the SAME abort timer: headers can arrive
      // and the body then stall forever (proxy outage, trickling upstream) —
      // clearing the timer after headers would make this await unbounded.
      try {
        json = await response.json();
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        // Non-abort parse failures fall through with json = null; the
        // status check below still reports them usefully.
      }
    } catch (error) {
      return {
        error:
          error?.name === "AbortError"
            ? `timed out after ${timeoutMs}ms`
            : `request failed: ${error.message}`,
      };
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // Provider error payloads are short and secret-free; keep enough of
      // them that "model not available to this org" is distinguishable from
      // "bad key" in the medic's event log.
      const detail = JSON.stringify(json?.error || json || {}).slice(0, 300);
      return { error: `HTTP ${response.status}: ${detail}`, status: response.status };
    }
    return adapter.parse(json);
  };

  // Try candidates most-capable-first until one returns text or the overall
  // deadline runs out. A 401 marks the provider's key bad and skips its
  // remaining models; a 403 may be model-scoped (permission_error on a model
  // allowlist or beta gate), so remaining models on the same key still run.
  const complete = async ({
    system = "",
    prompt,
    maxTokens = kDefaultMaxTokens,
    timeoutMs = kDefaultCandidateTimeoutMs,
    deadlineMs = kDefaultOverallDeadlineMs,
  } = {}) => {
    const startedAt = nowFn();
    const attempts = [];
    const badKeyProviders = new Set();
    for (const candidate of ranking) {
      if (badKeyProviders.has(candidate.provider)) continue;
      if (!resolveKey(candidate)) continue;
      const remaining = deadlineMs - (nowFn() - startedAt);
      if (remaining <= 0) {
        attempts.push({ provider: null, model: null, error: "deadline exhausted" });
        break;
      }
      const result = await completeWithCandidate(candidate, {
        system,
        prompt,
        maxTokens,
        timeoutMs: Math.min(timeoutMs, remaining),
      });
      if (result.text) {
        return {
          ok: true,
          provider: candidate.provider,
          model: candidate.model,
          text: result.text,
          attempts,
        };
      }
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: result.error,
      });
      log(`${candidate.provider}/${candidate.model} failed: ${result.error}`);
      if (result.status === 401) {
        badKeyProviders.add(candidate.provider);
      }
    }
    return {
      ok: false,
      error: attempts.length
        ? attempts.map((a) => `${a.provider}/${a.model}: ${a.error}`).join("; ")
        : "no frontier-model API key configured",
      attempts,
    };
  };

  return { listCandidates, getAvailability, complete };
};

module.exports = {
  createFrontierLlmClient,
  kFrontierModelRanking,
};
