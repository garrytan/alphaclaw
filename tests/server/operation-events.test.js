const { createOperationEventsService } = require("../../lib/server/operation-events");

const createReqMock = () => {
  const handlers = new Map();
  return {
    on: vi.fn((event, handler) => {
      handlers.set(String(event || ""), handler);
    }),
    emitClose: () => {
      const closeHandler = handlers.get("close");
      if (typeof closeHandler === "function") {
        closeHandler();
      }
    },
  };
};

describe("server/operation-events", () => {
  it("stores and replays published events to subscribers", () => {
    const service = createOperationEventsService();
    const { operationId } = service.createOperation({
      type: "channel-account-create",
    });
    service.publish(operationId, {
      event: "phase",
      data: { label: "Starting" },
    });

    const req = createReqMock();
    const res = {
      status: vi.fn(() => res),
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
    };
    const subscribed = service.subscribe({ operationId, req, res });

    expect(subscribed).toBe(true);
    expect(res.write).toHaveBeenNthCalledWith(1, ": connected\n\n");
    expect(res.write).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("event: phase"),
    );
    expect(res.write).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('"label":"Starting"'),
    );
  });

  it("caps buffered events to max per operation", () => {
    const service = createOperationEventsService();
    const { operationId } = service.createOperation();
    for (let idx = 1; idx <= 205; idx += 1) {
      service.publish(operationId, {
        event: "phase",
        data: { idx },
      });
    }

    const operation = service.getOperation(operationId);
    expect(operation.events).toHaveLength(200);
    expect(operation.events[0].id).toBe("6");
    expect(operation.events[199].id).toBe("205");
  });

  it("removes expired operations after subscriber disconnect", () => {
    vi.useFakeTimers();
    try {
      const service = createOperationEventsService({ ttlMs: 100 });
      const { operationId } = service.createOperation();
      service.complete(operationId, { ok: true });

      const req = createReqMock();
      const res = {
        status: vi.fn(() => res),
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
      };
      expect(service.subscribe({ operationId, req, res })).toBe(true);
      vi.advanceTimersByTime(101);
      req.emitClose();

      expect(service.getOperation(operationId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns false when subscribing to unknown operation", () => {
    const service = createOperationEventsService();
    const req = createReqMock();
    const res = {
      status: vi.fn(() => res),
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
    };
    expect(
      service.subscribe({
        operationId: "missing-operation",
        req,
        res,
      }),
    ).toBe(false);
  });

  it("returns null/false for blank or unknown operation ids", () => {
    const service = createOperationEventsService();
    expect(service.getOperation("")).toBeNull();
    expect(service.getOperation(null)).toBeNull();
    expect(service.getOperation("nope")).toBeNull();
    expect(service.publish("nope", { event: "phase", data: {} })).toBe(false);
    expect(service.complete("nope")).toBe(false);
    expect(service.fail("nope", new Error("x"))).toBe(false);
  });

  it("marks operations failed and publishes an error event", () => {
    const service = createOperationEventsService();
    const { operationId } = service.createOperation({ type: "" });

    expect(service.fail(operationId, new Error("boom"))).toBe(true);
    let operation = service.getOperation(operationId);
    expect(operation.type).toBe("operation");
    expect(operation.status).toBe("failed");
    expect(operation.events[0].event).toBe("error");
    expect(operation.events[0].data).toEqual({ error: "boom" });

    // Non-Error and empty failures fall back to string/default messages.
    service.fail(operationId, "plain failure");
    service.fail(operationId, undefined);
    operation = service.getOperation(operationId);
    expect(operation.events[1].data).toEqual({ error: "plain failure" });
    expect(operation.events[2].data).toEqual({ error: "Operation failed" });
  });

  it("swallows subscriber write failures during publish", () => {
    const service = createOperationEventsService();
    const { operationId } = service.createOperation();
    const req = createReqMock();
    let writeCalls = 0;
    const res = {
      status: vi.fn(() => res),
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(() => {
        writeCalls += 1;
        if (writeCalls > 1) throw new Error("socket closed");
      }),
    };
    expect(service.subscribe({ operationId, req, res })).toBe(true);

    expect(
      service.publish(operationId, { event: "phase", data: { n: 1 } }),
    ).toBe(true);
    // The event is still buffered even though the subscriber write threw.
    expect(service.getOperation(operationId).events).toHaveLength(1);
  });

  it("sweeps expired operations without subscribers on the shared timer", () => {
    vi.useFakeTimers();
    try {
      const service = createOperationEventsService({ ttlMs: 50 });
      const { operationId: expiredId } = service.createOperation();
      // Pending operations get a long grace window past TTL (a quiet build
      // must not lose its terminal event), so only a TERMINAL op sweeps at TTL.
      service.complete(expiredId, {});
      // A second createOperation exercises the sweeper early-return guard.
      const { operationId: subscribedId } = service.createOperation();

      const req = createReqMock();
      const res = {
        status: vi.fn(() => res),
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
      };
      expect(service.subscribe({ operationId: subscribedId, req, res })).toBe(true);

      vi.advanceTimersByTime(30_000);

      expect(service.getOperation(expiredId)).toBeNull();
      // Expired but still-subscribed operations survive the sweep.
      expect(service.getOperation(subscribedId)).toBeTruthy();

      // A pending (never-terminal) operation survives TTL expiry within its
      // grace window, then is reaped once the grace window lapses too.
      const graceService = createOperationEventsService({ ttlMs: 50 });
      const { operationId: pendingId } = graceService.createOperation();
      vi.advanceTimersByTime(30_000);
      expect(graceService.getOperation(pendingId)).toBeTruthy();
      vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 30_000);
      expect(graceService.getOperation(pendingId)).toBeNull();

      // Closing before expiry leaves the operation for the sweeper.
      const fresh = createOperationEventsService({ ttlMs: 120_000 });
      const { operationId: activeId } = fresh.createOperation();
      const activeReq = createReqMock();
      expect(fresh.subscribe({ operationId: activeId, req: activeReq, res })).toBe(true);
      activeReq.emitClose();
      expect(fresh.getOperation(activeId)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a pending operation alive across TTL windows while publishing, then sweeps after the grace", () => {
    vi.useFakeTimers();
    try {
      const service = createOperationEventsService({ ttlMs: 50 });
      const { operationId } = service.createOperation({ type: "channel-apply" });

      // Publish every 30ms across several 50ms TTL windows: every publish
      // re-arms the expiry, so a long chatty operation is never swept mid-run.
      for (let idx = 0; idx < 10; idx += 1) {
        vi.advanceTimersByTime(30);
        expect(
          service.publish(operationId, { event: "phase", data: { idx } }),
        ).toBe(true);
      }
      expect(service.getOperation(operationId)).toBeTruthy();

      // A sweep tick right after the last publish: still inside the grace.
      vi.advanceTimersByTime(30_000);
      expect(service.getOperation(operationId)).toBeTruthy();

      // Publishing stops: the pending op is reaped once TTL + the 2h pending
      // grace window lapse.
      vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 30_000);
      expect(service.getOperation(operationId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries code/hint/docsUrl from the failure error into the error event", () => {
    const service = createOperationEventsService();
    const { operationId } = service.createOperation();

    const failed = service.fail(
      operationId,
      Object.assign(new Error("boom"), { code: "x", hint: "h", docsUrl: "d" }),
    );

    expect(failed).toBe(true);
    const operation = service.getOperation(operationId);
    expect(operation.status).toBe("failed");
    expect(operation.events[0].event).toBe("error");
    expect(operation.events[0].data).toEqual({
      error: "boom",
      code: "x",
      hint: "h",
      docsUrl: "d",
    });
  });

  it("forwards a digest-bearing reusableBackup offer into the error event, and nothing else shaped like one", () => {
    const sha256 = "a".repeat(64);
    const offer = { file: "/data/backups/openclaw/x.tar.gz", at: 1, ageMs: 5, sha256, producer: "openclaw" };
    const service = createOperationEventsService();
    const { operationId } = service.createOperation();
    service.fail(
      operationId,
      Object.assign(new Error("backup failed"), { code: "backup_failed", reusableBackup: offer }),
    );
    expect(service.getOperation(operationId).events[0].data).toEqual({
      error: "backup failed",
      code: "backup_failed",
      reusableBackup: offer,
    });

    for (const bad of [true, "sha", { sha256: "not-hex" }, [sha256], { file: "/x" }]) {
      const { operationId: other } = service.createOperation();
      service.fail(other, Object.assign(new Error("nope"), { reusableBackup: bad }));
      expect(service.getOperation(other).events[0].data).toEqual({ error: "nope" });
    }
  });

  it("marks operations completed with a done event payload", () => {
    const service = createOperationEventsService();
    const { operationId } = service.createOperation({ type: "  spaced  " });

    expect(service.complete(operationId, { result: 42 })).toBe(true);
    const operation = service.getOperation(operationId);
    expect(operation.type).toBe("spaced");
    expect(operation.status).toBe("completed");
    expect(operation.events[0].event).toBe("done");
    expect(operation.events[0].data).toEqual({ result: 42 });
  });

  it("falls back to a random UUID for blank or non-string preset operation ids", () => {
    const service = createOperationEventsService();
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    // Two blank presets must yield DISTINCT operations — a shared fallback id
    // would silently merge unrelated operations' event streams.
    const first = service.createOperation({ operationId: "" });
    const second = service.createOperation({ operationId: "" });
    expect(first.operationId).toMatch(uuidPattern);
    expect(second.operationId).toMatch(uuidPattern);
    expect(first.operationId).not.toBe(second.operationId);
    expect(service.getOperation(first.operationId)).toBeTruthy();
    expect(service.getOperation(second.operationId)).toBeTruthy();

    // Whitespace-only and non-string presets fall back the same way.
    const blank = service.createOperation({ operationId: "   " });
    const numeric = service.createOperation({ operationId: 42 });
    expect(blank.operationId).toMatch(uuidPattern);
    expect(numeric.operationId).toMatch(uuidPattern);
  });
});
