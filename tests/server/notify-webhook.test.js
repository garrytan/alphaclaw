const { postNotifyWebhookDirect } = require("../../lib/server/notify-webhook");

// The webhook is the delivery path of last resort (boot process, all chat
// channels broken) — its contract is: best-effort, swallow every error,
// answer with a boolean, never throw.
describe("server/notify-webhook", () => {
  it("POSTs {text: message} JSON to ALPHACLAW_NOTIFY_WEBHOOK_URL and reports success", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const ok = await postNotifyWebhookDirect("🔴 boot gate reverted to pin", {
      fetchImpl,
      env: { ALPHACLAW_NOTIFY_WEBHOOK_URL: "https://hooks.example/notify" },
    });

    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://hooks.example/notify");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      text: "🔴 boot gate reverted to pin",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns false without calling fetch when the env URL is unset or blank", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    expect(await postNotifyWebhookDirect("msg", { fetchImpl, env: {} })).toBe(
      false,
    );
    expect(
      await postNotifyWebhookDirect("msg", {
        fetchImpl,
        env: { ALPHACLAW_NOTIFY_WEBHOOK_URL: "   " },
      }),
    ).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("swallows fetch rejections and returns false", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      postNotifyWebhookDirect("msg", {
        fetchImpl,
        env: { ALPHACLAW_NOTIFY_WEBHOOK_URL: "https://hooks.example/x" },
      }),
    ).resolves.toBe(false);
  });

  it("treats a non-2xx response as failure", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }));
    expect(
      await postNotifyWebhookDirect("msg", {
        fetchImpl,
        env: { ALPHACLAW_NOTIFY_WEBHOOK_URL: "https://hooks.example/x" },
      }),
    ).toBe(false);
  });

  it("a synchronously-throwing fetch implementation is swallowed too", async () => {
    const fetchImpl = () => {
      throw new Error("not a function");
    };
    expect(
      await postNotifyWebhookDirect("msg", {
        fetchImpl,
        env: { ALPHACLAW_NOTIFY_WEBHOOK_URL: "https://hooks.example/x" },
      }),
    ).toBe(false);
  });

  it("aborts a hung endpoint at timeoutMs and returns false", async () => {
    // A fetch that never resolves on its own but honors the AbortSignal —
    // the shape of a hung webhook endpoint.
    const fetchImpl = vi.fn(
      (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new Error("This operation was aborted")),
          );
        }),
    );
    const ok = await postNotifyWebhookDirect("msg", {
      fetchImpl,
      env: { ALPHACLAW_NOTIFY_WEBHOOK_URL: "https://hooks.example/x" },
      timeoutMs: 10,
    });
    expect(ok).toBe(false);
  });

  it("stringifies a non-string message defensively", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    await postNotifyWebhookDirect(undefined, {
      fetchImpl,
      env: { ALPHACLAW_NOTIFY_WEBHOOK_URL: "https://hooks.example/x" },
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ text: "" });
  });
});
