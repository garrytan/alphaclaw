import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLimitedDiagnostics, loadDiagnosticsForCopy } from "../../lib/public/js/components/watchdog-tab/console/diagnostics.js";

afterEach(() => vi.useRealTimers());
const extras = {
  logs: "Bearer unrecognized-secret-and-credentials",
  status: { health: "healthy", gatewayPid: 123, repairAttempts: 2, lastExit: { stderr: "secret" }, token: "secret", lifecycle: "sk-arbitrarykey" },
  incidents: [{ summary: { trigger: "private raw content" } }],
};

describe("watchdog diagnostic export", () => {
  it("reads a fresh existing server export for every click, including partial sections", async () => {
    const text = "# AlphaClaw diagnostics\nGateway: unavailable\nChannel: disk\nSecret: ***";
    const fetcher = vi.fn(async () => ({ ok: true, text: async () => text }));
    for (let index = 0; index < 2; index++) expect(await loadDiagnosticsForCopy({ fetcher })).toEqual({ text, limited: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith("/api/diagnose?format=text", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  });

  it("falls back to explicitly limited last-known facts without free text, logs, or secrets", async () => {
    const result = await loadDiagnosticsForCopy({ copyExtras: extras, fetcher: async () => ({ ok: false }) });
    expect(result.limited).toBe(true);
    expect(result.text).toContain("LIMITED BROWSER SNAPSHOT");
    expect(result.text).toContain("freshness is unknown");
    expect(result.text).toContain('"gatewayPid": 123');
    expect(result.text).not.toMatch(/unrecognized-secret|sk-arbitrarykey|private raw content|"token"|"stderr"/);
    expect(buildLimitedDiagnostics({ status: { health: "Bearer SECRET" } })).not.toContain("Bearer SECRET");
  });

  it("bounds a hung request, aborting it and preserving copyable fallback text", async () => {
    vi.useFakeTimers();
    let signal;
    const promise = loadDiagnosticsForCopy({ copyExtras: extras, timeoutMs: 50, fetcher: (_, options) => { signal = options.signal; return new Promise(() => {}); } });
    await vi.advanceTimersByTimeAsync(51);
    expect(signal.aborted).toBe(true);
    expect(await promise).toMatchObject({ limited: true, text: expect.stringContaining("LIMITED BROWSER SNAPSHOT") });
  });

  it("a sign-in HTML page cannot masquerade as a diagnostic report", async () => {
    const result = await loadDiagnosticsForCopy({ fetcher: async () => ({ ok: true, text: async () => "<html>sign in</html>" }) });
    expect(result.limited).toBe(true);
    expect(result.text).not.toContain("<html>");
  });
});
