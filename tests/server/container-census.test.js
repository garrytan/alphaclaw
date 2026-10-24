const { readLargestContainerProcess } = require("../../lib/server/gateway-memory/container-census");

// ALPH-25: a bounded census of every process in the container's memory
// cgroup, returning only the largest by RSS (pid, start ticks, RSS).
const kMb = 1024 * 1024;
const status = (rssKb) => `Name:\tx\nPPid:\t1\nVmRSS:\t   ${rssKb} kB\n`;
const stat = (pid, ticks) => `${pid} (x) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 0 0`;

const fakeFs = ({ files = {}, dirs = {} }) => ({
  readFileSync: (filePath) => {
    if (Object.prototype.hasOwnProperty.call(files, filePath)) return files[filePath];
    throw Object.assign(new Error(`ENOENT ${filePath}`), { code: "ENOENT" });
  },
  readdirSync: (dir, options) => {
    if (!Object.prototype.hasOwnProperty.call(dirs, dir)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return options?.withFileTypes ? dirs[dir].map((name) => ({ name, isDirectory: () => true })) : dirs[dir];
  },
  openSync: (filePath) => filePath,
  readSync: (fd, buffer) => {
    const text = files[fd];
    if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return buffer.write(text);
  },
  closeSync: () => {},
});

describe("container census (ALPH-25)", () => {
  it("walks cgroup.procs of the container root and its children and returns the largest process", () => {
    const fsModule = fakeFs({
      dirs: { "/sys/fs/cgroup": ["tools"], "/sys/fs/cgroup/tools": [] },
      files: {
        "/sys/fs/cgroup/cgroup.procs": "1\n20\n0\n",
        "/sys/fs/cgroup/tools/cgroup.procs": "300\n",
        "/proc/1/status": status(50 * 1024), "/proc/20/status": status(4000 * 1024), "/proc/300/status": status(60_000 * 1024),
        "/proc/300/stat": stat(300, 777),
      },
    });
    expect(readLargestContainerProcess({ fsModule })).toEqual({
      status: "fresh", source: "cgroup", scanned: 3, largest: { pid: 300, startTicks: "777", rssBytes: 60_000 * kMb },
    });
  });

  it("falls back to /proc when cgroup.procs is unreadable, skipping kernel threads without VmRSS", () => {
    const fsModule = fakeFs({
      dirs: { "/proc": ["1", "2", "self", "55"] },
      files: { "/proc/1/status": status(10), "/proc/2/status": "Name:\tkthreadd\nPPid:\t0\n",
        "/proc/55/status": status(2048), "/proc/55/stat": stat(55, 9) },
    });
    expect(readLargestContainerProcess({ fsModule })).toMatchObject({ status: "fresh", source: "proc",
      largest: { pid: 55, startTicks: "9", rssBytes: 2048 * 1024 } });
  });

  it("is partial when the time budget runs out, and unavailable when nothing can be listed", () => {
    let now = 0;
    const fsModule = fakeFs({ dirs: { "/proc": ["1", "2", "3"] },
      files: { "/proc/1/status": status(10), "/proc/2/status": status(20), "/proc/2/stat": stat(2, 2), "/proc/3/status": status(30) } });
    const partial = readLargestContainerProcess({ fsModule, scanBudgetMs: 90, monotonicNowFn: () => { now += 20; return now; } });
    expect(partial).toMatchObject({ status: "partial", scanned: 2, largest: { pid: 2 } });
    expect(readLargestContainerProcess({ fsModule: fakeFs({}) })).toEqual({ status: "unavailable", source: null, scanned: 0, largest: null });
  });
});
