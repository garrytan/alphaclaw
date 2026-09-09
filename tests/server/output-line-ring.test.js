const { createOutputLineRing } = require("../../lib/server/output-line-ring");

// v0.9.81 (cross-model D19): the bounded, redacted, chunk-safe ring of a
// child's last complete output lines.
describe("server/output-line-ring", () => {
  it("keeps the last N complete lines, oldest first, and drops blank ones", () => {
    const ring = createOutputLineRing({ maxLines: 3 });
    ring.push("a\n\n  \nb\nc\nd\n");
    expect(ring.lines()).toEqual(["b", "c", "d"]);
    expect(ring.last()).toBe("d");
    expect(ring.size()).toBe(3);
  });

  it("commits a line only at its newline: a chunk split mid-line is one line, flush() commits the tail", () => {
    const ring = createOutputLineRing();
    ring.push("waiting for coord");
    expect(ring.lines()).toEqual([]);
    expect(ring.last()).toBe(null);
    ring.push("inator lock\npartial");
    expect(ring.lines()).toEqual(["waiting for coordinator lock"]);
    ring.flush();
    expect(ring.lines()).toEqual(["waiting for coordinator lock", "partial"]);
    ring.flush(); // idempotent
    expect(ring.lines()).toEqual(["waiting for coordinator lock", "partial"]);
  });

  it("redacts BEFORE storing — including a secret split across two chunks — and clamps after redaction", () => {
    const redact = (text) => text.split("hunter2-secret").join("***");
    const ring = createOutputLineRing({ redact, clampChars: 20 });
    ring.push("token=hunter2");
    ring.push("-secret ok\n");
    expect(ring.lines()).toEqual(["token=*** ok"]);
    ring.push(`${"x".repeat(50)}hunter2-secret\n`);
    const [, long] = ring.lines();
    expect(long).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toContain("hunter2");
  });

  it("strips \\r redraws, WHOLE ANSI escape sequences and control characters, accepts Buffers, ignores empty pushes", () => {
    const ring = createOutputLineRing();
    ring.push(Buffer.from("10%\r20%\r\x1b[2K30% done\x1b[0m\n"));
    ring.push("\x1b]0;title\x07plain \x1b(Bline\n");
    ring.push("");
    ring.push(null);
    expect(ring.lines()).toEqual(["10%20%30% done", "plain line"]);
  });

  it("a child that never prints a newline cannot grow the carry without bound", () => {
    const ring = createOutputLineRing({ clampChars: 10 });
    ring.push("y".repeat(41)); // > clamp × 4
    expect(ring.lines()).toHaveLength(1);
    expect(ring.lines()[0]).toHaveLength(10);
  });

  it("falls back to the defaults on junk options", () => {
    const ring = createOutputLineRing({ maxLines: 0, clampChars: -1 });
    for (let i = 0; i < 5; i += 1) ring.push(`line ${i}\n`);
    expect(ring.lines()).toEqual(["line 2", "line 3", "line 4"]);
  });
});
