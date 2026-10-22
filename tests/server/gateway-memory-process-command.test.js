const { readProcessCommand } = require("../../lib/server/gateway-memory/process-command");

const enoent = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
const fakeFs = ({ exe = {}, comm = {} } = {}) => ({
  readlinkSync: (filePath) => (filePath in exe ? exe[filePath] : enoent()),
  readFileSync: (filePath) => (filePath in comm ? comm[filePath] : enoent()),
});

describe("readProcessCommand", () => {
  it("names the child by its executable's basename, never its path or argv", () => {
    expect(readProcessCommand(4242, fakeFs({ exe: { "/proc/4242/exe": "/usr/local/bin/python3.12" },
      comm: { "/proc/4242/comm": "MainThread\n" } }))).toBe("python3.12");
  });

  it("falls back to the kernel's short name when the executable is unreadable or not a plain name", () => {
    expect(readProcessCommand(4242, fakeFs({ comm: { "/proc/4242/comm": "bun\n" } }))).toBe("bun");
    expect(readProcessCommand(4242, fakeFs({ exe: { "/proc/4242/exe": "/opt/node (deleted)" },
      comm: { "/proc/4242/comm": "node\n" } }))).toBe("node");
  });

  it("withholds a name outside the plain token charset instead of escaping it", () => {
    for (const raw of ["sh -c curl\n", "*bold*\n", "`tick`\n", "a/b\n", "-flag\n", "\n", "x".repeat(33)])
      expect(readProcessCommand(4242, fakeFs({ comm: { "/proc/4242/comm": raw } }))).toBeNull();
  });

  it("returns null for an exited process or an invalid pid without reading", () => {
    expect(readProcessCommand(4242, fakeFs())).toBeNull();
    const fsModule = { readlinkSync: vi.fn(), readFileSync: vi.fn() };
    for (const pid of [0, -1, 1.5, "4242", null]) expect(readProcessCommand(pid, fsModule)).toBeNull();
    expect(fsModule.readlinkSync).not.toHaveBeenCalled();
    expect(fsModule.readFileSync).not.toHaveBeenCalled();
  });
});
