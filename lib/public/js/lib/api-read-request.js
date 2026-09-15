import { getReadTimeoutMs } from "./api-cache.js";

// Bound the complete JSON read, including a server that sends headers and
// then stalls its body. Racing cancellation also fences fetch implementations
// that ignore AbortSignal. Streams/downloads use authFetch's rawResponse path.
export const fetchReadResponse = async (url, options = {}, onResponse = () => {}) => {
  const { signal, readTimeoutMs = getReadTimeoutMs(url), ...fetchOptions } = options;
  const controller = new AbortController();
  let rejectCancelled;
  const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
  const cancel = (reason) => {
    const error = reason instanceof Error ? reason : new Error("The request was cancelled.");
    controller.abort(error);
    rejectCancelled(error);
  };
  const onAbort = () => cancel(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => cancel(Object.assign(
    new Error("The request timed out. Try again."),
    { code: "read_timeout", retryable: true },
  )), readTimeoutMs);
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => fetch(url, { ...fetchOptions, signal: controller.signal })),
      cancelled,
    ]);
    onResponse(response);
    const text = await Promise.race([response.text(), cancelled]);
    return new Response([204, 205, 304].includes(response.status) ? null : text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
};
