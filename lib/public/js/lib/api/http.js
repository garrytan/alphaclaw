import { clearApiCache, denyCachedKey } from "../api-cache.js";
import { fetchReadResponse } from "../api-read-request.js";
// Memoized in format.js at module load, so the header zone always matches the
// zone the display formatters render in (never diverges mid-session).
import { getBrowserTimeZone } from "../format.js";

const kClientTimeZoneHeader = "x-client-timezone";

export const authFetch = async (url, opts = {}) => {
  const { rawResponse = false, ...nextOptions } = opts;
  const headers = new Headers(opts?.headers || {});
  if (!headers.has(kClientTimeZoneHeader)) {
    const browserTimeZone = getBrowserTimeZone();
    if (browserTimeZone) {
      headers.set(kClientTimeZoneHeader, browserTimeZone);
    }
  }
  nextOptions.headers = headers;
  const isRead = String(nextOptions.method || "GET").toUpperCase() === "GET";
  const checkAuthorization = (res) => {
    if (res.status === 401) {
      const error = Object.assign(new Error("Unauthorized"), { status: 401, code: "unauthorized" });
      clearApiCache(error);
      try {
        window.localStorage?.clear?.();
      } catch {}
      window.location.href = "/setup";
      throw error;
    }
    if (isRead && res.status === 403) {
      const error = Object.assign(new Error("You no longer have access to this data."), {
        status: 403, code: "forbidden",
      });
      denyCachedKey(String(url), error);
    }
  };
  if (isRead && !rawResponse) return fetchReadResponse(url, nextOptions, checkAuthorization);
  const res = await fetch(url, nextOptions);
  checkAuthorization(res);
  return res;
};
