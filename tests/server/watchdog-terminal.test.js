const { EventEmitter } = require("events");
const {
  createWatchdogTerminalService,
} = require("../../lib/server/watchdog-terminal");

// A minimal fake child process: EventEmitter with stdout/stderr readable-ish
// streams and a controllable stdin. Lets us drive spawn 'error' and stdin
// EPIPE deterministically without a real shell (H12).
const createFakeProc = ({ stdinWritable = true, stdinThrows = false } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdout.setEncoding = () => {};
  proc.stderr = new EventEmitter();
  proc.stderr.setEncoding = () => {};
  proc.stdin = new EventEmitter();
  proc.stdin.writable = stdinWritable;
  proc.stdin.write = (data) => {
    if (stdinThrows) {
      const err = new Error("write EPIPE");
      err.code = "EPIPE";
      throw err;
    }
    proc.stdin.lastWrite = data;
    return true;
  };
  proc.kill = () => {};
  return proc;
};

describe("server/watchdog-terminal crash guards (H12)", () => {
  it("does not throw when the child emits 'error' (spawn ENOENT)", () => {
    const proc = createFakeProc();
    const service = createWatchdogTerminalService({
      createProcess: () => proc,
    });
    const started = service.createOrReuseSession();
    const events = [];
    service.subscribe({ sessionId: started.id, onEvent: (e) => events.push(e) });

    // With the H12 listener attached this is handled; without it Node would
    // throw on an EventEmitter 'error' with no listener.
    expect(() => {
      const err = new Error("spawn nonexistent-shell ENOENT");
      err.code = "ENOENT";
      proc.emit("error", err);
    }).not.toThrow();

    // A terminal exit is delivered to subscribers instead of crashing.
    expect(events.some((e) => e.type === "exit")).toBe(true);
    const readback = service.readOutput({ sessionId: started.id });
    expect(readback.ended).toBe(true);
    expect(readback.output).toContain("terminal error");
  });

  it("attaches a stdin 'error' listener so an EPIPE emit does not crash", () => {
    const proc = createFakeProc();
    const service = createWatchdogTerminalService({
      createProcess: () => proc,
    });
    service.createOrReuseSession();

    expect(() => {
      const err = new Error("write EPIPE");
      err.code = "EPIPE";
      proc.stdin.emit("error", err);
    }).not.toThrow();
  });

  it("returns ok:false (no throw) when a stdin write throws EPIPE", () => {
    const proc = createFakeProc({ stdinThrows: true });
    const service = createWatchdogTerminalService({
      createProcess: () => proc,
    });
    const started = service.createOrReuseSession();

    const result = service.writeInput({ sessionId: started.id, input: "ls\n" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("EPIPE");
  });

  it("writes input to a healthy session (allow-legit)", () => {
    const proc = createFakeProc();
    const service = createWatchdogTerminalService({
      createProcess: () => proc,
    });
    const started = service.createOrReuseSession();

    const result = service.writeInput({ sessionId: started.id, input: "echo hi\n" });
    expect(result.ok).toBe(true);
    expect(proc.stdin.lastWrite).toBe("echo hi\n");
  });

  it("emits a terminal exit event on a normal close (allow-legit)", () => {
    const proc = createFakeProc();
    const service = createWatchdogTerminalService({
      createProcess: () => proc,
    });
    const started = service.createOrReuseSession();
    const events = [];
    service.subscribe({ sessionId: started.id, onEvent: (e) => events.push(e) });

    proc.emit("close", 0, null);

    const exit = events.find((e) => e.type === "exit");
    expect(exit).toMatchObject({ code: 0 });
    expect(service.readOutput({ sessionId: started.id }).ended).toBe(true);
  });
});
