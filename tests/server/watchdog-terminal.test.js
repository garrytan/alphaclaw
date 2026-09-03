const { EventEmitter } = require("events");
const {
  createWatchdogTerminalService,
  buildPtyWrapperCommand,
  clampTerminalSize,
  resolveSafeShell,
} = require("../../lib/server/watchdog-terminal");
const {
  parseRequestedTerminalSize,
} = require("../../lib/server/watchdog-terminal-ws");

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

describe("server/watchdog-terminal PTY sizing (#76)", () => {
  it("clamps browser-supplied dimensions to bounded integers", () => {
    expect(clampTerminalSize({ cols: 132, rows: 40 })).toEqual({
      cols: 132,
      rows: 40,
    });
    expect(clampTerminalSize({ cols: "99999", rows: "-4" })).toEqual({
      cols: 500,
      rows: 5,
    });
    expect(clampTerminalSize({ cols: "1", rows: "1" })).toEqual({
      cols: 20,
      rows: 5,
    });
    // Anything non-numeric — including shell metacharacters — collapses to
    // the defaults; harmless marker payloads on purpose, never rm-shaped.
    expect(
      clampTerminalSize({ cols: "; touch /tmp/marker", rows: "$(id)" }),
    ).toEqual({ cols: 120, rows: 30 });
    expect(clampTerminalSize({})).toEqual({ cols: 120, rows: 30 });
  });

  it("builds a wrapper carrying only clamped integers and a safe shell", () => {
    const hostile = buildPtyWrapperCommand({
      shell: "/bin/sh; touch /tmp/marker",
      cols: "20; touch /tmp/marker",
      rows: "`touch /tmp/marker`",
    });
    expect(hostile).toBe("stty rows 30 cols 120 2>/dev/null; exec /bin/bash -i");
    expect(hostile).not.toContain("touch");

    const legit = buildPtyWrapperCommand({
      shell: "/usr/bin/zsh",
      cols: 132,
      rows: 24,
    });
    expect(legit).toBe("stty rows 24 cols 132 2>/dev/null; exec /usr/bin/zsh -i");
  });

  it("falls back to bash for non-absolute or metacharacter shells", () => {
    expect(resolveSafeShell("/bin/bash")).toBe("/bin/bash");
    expect(resolveSafeShell("/usr/local/bin/fish")).toBe("/usr/local/bin/fish");
    expect(resolveSafeShell("bash")).toBe("/bin/bash");
    expect(resolveSafeShell("/bin/sh -c 'x'")).toBe("/bin/bash");
    expect(resolveSafeShell("")).toBe("/bin/bash");
  });

  it("forwards only PRESENT query params from the upgrade URL", () => {
    expect(
      parseRequestedTerminalSize({
        url: "/api/watchdog/terminal/ws?cols=132&rows=40",
        headers: { host: "localhost" },
      }),
    ).toEqual({ cols: "132", rows: "40" });
    // Absent params must not overwrite the recorded size with min-clamped 0s.
    expect(
      parseRequestedTerminalSize({
        url: "/api/watchdog/terminal/ws",
        headers: { host: "localhost" },
      }),
    ).toEqual({});
    expect(parseRequestedTerminalSize(null)).toEqual({});
  });

  it("every respawn uses the LATEST connection's size, not the first (#76)", () => {
    const spawnCalls = [];
    let proc = createFakeProc();
    const service = createWatchdogTerminalService({
      createProcess: (options) => {
        spawnCalls.push({ cols: options.cols, rows: options.rows });
        return proc;
      },
    });

    const first = service.createOrReuseSession({ cols: 80, rows: 24 });
    expect(spawnCalls).toEqual([{ cols: 80, rows: 24 }]);

    // A wider browser reconnects: live session is REUSED (no resize)...
    const reused = service.createOrReuseSession({ cols: 132, rows: 40 });
    expect(reused.id).toBe(first.id);
    expect(spawnCalls.length).toBe(1);

    // ...but once the process dies (or Restart session kills it), the next
    // spawn picks up the latest recorded size — first-connection-wins would
    // half-reintroduce the bug after a window resize.
    proc.emit("close", 0, null);
    proc = createFakeProc();
    const respawned = service.createOrReuseSession();
    expect(respawned.id).not.toBe(first.id);
    expect(spawnCalls).toEqual([
      { cols: 80, rows: 24 },
      { cols: 132, rows: 40 },
    ]);
    expect(respawned.size).toEqual({ cols: 132, rows: 40 });
  });

  it("hostile sizes on the connection collapse to defaults at spawn", () => {
    const spawnCalls = [];
    const service = createWatchdogTerminalService({
      createProcess: (options) => {
        spawnCalls.push({ cols: options.cols, rows: options.rows });
        return createFakeProc();
      },
    });
    service.createOrReuseSession({ cols: "; touch /tmp/marker", rows: "NaN" });
    expect(spawnCalls).toEqual([{ cols: 120, rows: 30 }]);
  });
});
