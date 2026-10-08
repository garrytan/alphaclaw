// Shared /readyz transport + classifier. One owner for "is the gateway ready",
// used by the watchdog's health loop and by the restart pipeline's ready wait
// (gateway.js). The classifier is pure; the transport bounds the body and
// never throws.
//
// Readiness classification vocabulary (#87). OpenClaw's /readyz contract
// (docs.openclaw.ai/gateway/health): `ready` is the native readiness result,
// `status` names a transitional phase, `failing[]` lists the components that
// keep it not ready, and the `eventLoop` diagnostic "does not change the
// readiness result by itself" — so it is telemetry here, never a degradation.
const kReadinessStatuses = Object.freeze(["started", "starting", "draining"]);
// What the transport layer observed: "ok" is a consumed body (2xx or 503);
// every other kind reads readiness "unknown" (silent for unconfigured /
// unsupported, one deduped readiness_probe_error row for the transport kinds).
const kReadinessProbeKinds = Object.freeze([
  "ok",
  "unconfigured",
  "unsupported",
  "unavailable",
  "timeout",
  "malformed",
]);
// Why a consumed observation is not ready: a transitional phase (starting /
// draining — never an incident), failing components, or a bare ready:false.
const kUnreadyReasons = Object.freeze(["starting", "draining", "components", "explicit"]);
const kReadinessTransitionalReasons = new Set(["starting", "draining"]);
const kReadinessTransportErrorKinds = new Set(["unavailable", "timeout", "malformed"]);
const kUnsupportedReadyzHttpStatuses = new Set([404, 405, 501]);
const kEventLoopReasons = new Set(["event_loop_delay", "event_loop_utilization", "cpu"]);
// Gateway-controlled /readyz content is bounded before it reaches state,
// event rows or notices: each failing[]/suppressed[] entry, each list, and
// the raw body itself (a larger body is `malformed`, never parsed).
const kReadyzListMaxEntries = 20;
const kReadyzEntryMaxChars = 100;
const kReadyzBodyMaxChars = 64 * 1024;
const kReadyzProbeTimeoutMs = 5 * 1000;

const readyzStringList = (value) => {
  if (!Array.isArray(value)) return [];
  const entries = [];
  for (const entry of value) {
    if (entries.length >= kReadyzListMaxEntries) break;
    const text = String(entry || "").slice(0, kReadyzEntryMaxChars);
    if (text) entries.push(text);
  }
  return entries;
};

// Pure classification of a /readyz answer (#87 A1). Transport outcomes
// (connection error, timeout) are the wrapper's business; this sees only
// what came back (`rawBodyChars`, when given, is the size of the body the
// wrapper read — past kReadyzBodyMaxChars it is `malformed` unparsed).
// Precedence: unsupported statuses → other non-2xx/503 → oversize or
// non-object body → explicit `ready: true` (native readiness is
// authoritative, #87 F5: the observation is `ready` whatever the HTTP status
// or failing[] say; a `status` of starting / draining beside it is telemetry
// only — still reported as `status`, never a phase) → status ∈ {starting,
// draining} (transitional, always not_ready) → ready:false (components if
// failing[] non-empty, else explicit) → ready absent with failing[] (compat)
// → 503 → explicit → ready. eventLoop.degraded is captured and never affects
// `kind`.
const classifyReadinessResponse = ({ httpStatus, body, rawBodyChars = null } = {}) => {
  const status = Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null;
  if (status != null && kUnsupportedReadyzHttpStatuses.has(status)) {
    return {
      ok: false,
      kind: "unsupported",
      httpStatus: status,
      reason: `gateway readyz returned HTTP ${status}`,
    };
  }
  const is2xx = status != null && status >= 200 && status < 300;
  if (!is2xx && status !== 503) {
    return {
      ok: false,
      kind: "unavailable",
      httpStatus: status,
      reason: `gateway readyz returned HTTP ${status ?? "?"}`,
    };
  }
  if (Number.isFinite(rawBodyChars) && rawBodyChars > kReadyzBodyMaxChars) {
    return {
      ok: false,
      kind: "malformed",
      httpStatus: status,
      reason: `gateway readyz returned HTTP ${status} with a body over ${kReadyzBodyMaxChars} chars`,
    };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      kind: "malformed",
      httpStatus: status,
      reason: `gateway readyz returned HTTP ${status} with a non-object body`,
    };
  }
  const readinessStatus = kReadinessStatuses.includes(body.status) ? body.status : null;
  const failing = readyzStringList(body.failing);
  const suppressed = readyzStringList(body.suppressed);
  const eventLoopBlock =
    body.eventLoop && typeof body.eventLoop === "object" && !Array.isArray(body.eventLoop)
      ? body.eventLoop
      : null;
  const eventLoop = eventLoopBlock
    ? {
        reasons: Array.isArray(eventLoopBlock.reasons)
          ? eventLoopBlock.reasons.filter((reason) => kEventLoopReasons.has(reason))
          : [],
        delayP99Ms: Number.isFinite(eventLoopBlock.delayP99Ms)
          ? eventLoopBlock.delayP99Ms
          : null,
      }
    : null;
  let unreadyReason = null;
  if (body.ready === true) {
    // Explicit native ready wins (#87 F5): `status` and failing[] are telemetry.
    unreadyReason = null;
  } else if (kReadinessTransitionalReasons.has(readinessStatus)) {
    unreadyReason = readinessStatus;
  } else if (body.ready === false) {
    unreadyReason = failing.length > 0 ? "components" : "explicit";
  } else if (failing.length > 0) {
    unreadyReason = "components";
  } else if (status === 503) {
    unreadyReason = "explicit";
  }
  const kind = unreadyReason ? "not_ready" : "ready";
  return {
    ok: true,
    kind,
    httpStatus: status,
    status: readinessStatus,
    ready: kind === "ready",
    failing,
    suppressed,
    eventLoopDegraded: Boolean(eventLoopBlock && eventLoopBlock.degraded),
    eventLoop,
    unreadyReason,
  };
};

// Streams a /readyz body up to kReadyzBodyMaxChars bytes (#87 RT6). Past
// the cap the reader is cancelled and the request aborted — the caller
// sees `bytes` over the cap and never parses `text`. Without a reader
// (test stubs, older fetch shapes) the body is read whole and `bytes` is
// its length, so the size check is unchanged for them.
const readReadyzBody = async (response, controller) => {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = String((await response.text()) ?? "");
    return { text, bytes: text.length };
  }
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const isText = typeof value === "string";
    bytes += isText ? value.length : (value?.byteLength ?? 0);
    if (bytes > kReadyzBodyMaxChars) {
      try {
        await reader.cancel();
      } catch {}
      controller.abort();
      return { text, bytes };
    }
    text += isText ? value : decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, bytes };
};

// Transport wrapper over classifyReadinessResponse (#87 A1). Returns the
// discriminated observation:
//   ok:true  → { kind:"ready"|"not_ready", httpStatus, status, ready, failing[],
//                suppressed[], eventLoopDegraded, eventLoop, unreadyReason }
//   ok:false → { kind:"unconfigured"|"unsupported"|"unavailable"|"timeout"|
//                "malformed", httpStatus|null, reason }
// A 503 with an object body is CONSUMED (starting/draining/components), a
// 404/405/501 is an older gateway without the endpoint (silent), and a
// connection error / abort / body-stream error / non-object body is a
// transport kind that reads readiness "unknown". Never throws.
const probeGatewayReadiness = async ({
  url,
  timeoutMs = kReadyzProbeTimeoutMs,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const readyzUrl = String(url || "").trim();
  if (!readyzUrl) {
    return {
      ok: false,
      kind: "unconfigured",
      httpStatus: null,
      reason: "gateway readyz URL unavailable",
    };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(readyzUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const httpStatus = response.status;
    // Oversize bodies are never buffered, let alone parsed (#87 RT6): a
    // declared Content-Length over the cap is `malformed` without a read;
    // otherwise the body streams through the cap and the request aborts
    // past it. The classifier reads either from the size alone.
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > kReadyzBodyMaxChars) {
      controller.abort();
      return classifyReadinessResponse({
        httpStatus,
        body: null,
        rawBodyChars: declaredLength,
      });
    }
    const { text: rawBody, bytes } = await readReadyzBody(response, controller);
    let parsedBody = null;
    if (bytes <= kReadyzBodyMaxChars) {
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : null;
      } catch {}
    }
    return classifyReadinessResponse({
      httpStatus,
      body: parsedBody,
      rawBodyChars: Math.max(bytes, rawBody.length),
    });
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return {
      ok: false,
      kind: timedOut ? "timeout" : "unavailable",
      httpStatus: null,
      reason: timedOut
        ? `gateway readyz timed out after ${timeoutMs}ms`
        : error?.message || "gateway readyz request failed",
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

// Ready wait for the restart pipeline: polls /readyz until it reports
// `ready`, the budget runs out, or `shouldAbort()` says stop. A transport
// error (connection refused while the process boots), a `starting` /
// `draining` phase and failing components all keep waiting — the gateway is
// still coming up; only the budget or the caller ends the wait. An
// `unsupported` endpoint (an older build without /readyz) is accepted as
// ready once the port answers at all, so the pin can move backwards without
// stranding every restart. `onObservation` sees every poll (the UI streams
// the phase).
const waitForGatewayReadiness = async ({
  url,
  budgetMs,
  pollMs = 500,
  timeoutMs = kReadyzProbeTimeoutMs,
  shouldAbort = null,
  onObservation = null,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) => {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < budgetMs) {
    if (shouldAbort?.()) return { ready: false, aborted: true, last };
    last = await probeGatewayReadiness({ url, timeoutMs, fetchImpl });
    try {
      onObservation?.(last);
    } catch {}
    if ((last.ok && last.ready) || last.kind === "unsupported") {
      return { ready: true, aborted: false, last, elapsedMs: Date.now() - startedAt };
    }
    await sleep(pollMs);
  }
  return { ready: false, aborted: false, last, elapsedMs: Date.now() - startedAt };
};

module.exports = {
  kReadinessStatuses,
  kReadinessProbeKinds,
  kUnreadyReasons,
  kReadinessTransitionalReasons,
  kReadinessTransportErrorKinds,
  kReadyzListMaxEntries,
  kReadyzEntryMaxChars,
  kReadyzBodyMaxChars,
  kReadyzProbeTimeoutMs,
  classifyReadinessResponse,
  readyzStringList,
  probeGatewayReadiness,
  waitForGatewayReadiness,
};
