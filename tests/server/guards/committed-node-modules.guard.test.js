// Guard (g): no node_modules in the tree. #200 shipped a committed
// `node_modules` symlink: a worktree that links node_modules to a shared
// install had it as an untracked file, because `.gitignore` then said
// `node_modules/`, which matches only a directory, and `git add -A` swept it
// into the commit. The pattern is now `node_modules`, which matches a
// directory, a file and a symlink; this guard catches anything that still gets
// in (a force-add, a nested package folder, a link into an install). It reads
// the index (`git ls-files -s`), so a staged entry fails locally before it is
// ever committed.
const { execFileSync } = require("child_process");
const { kRepoRoot } = require("./guard-utils");

// Keyed by tracked path (`<path> -> <target>` for a symlink into
// node_modules). Add one only with a why-comment; vendored code belongs
// outside a node_modules folder.
const kKnownOffenders = {};

const kSymlinkMode = "120000";
const kNodeModulesSegmentRe = /(^|\/)node_modules(\/|$)/;

const scanTrackedEntries = (entries) => {
  const hits = [];
  for (const { mode, file, target } of entries) {
    if (kNodeModulesSegmentRe.test(file)) {
      hits.push({ key: file, file, kind: mode === kSymlinkMode ? "symlink" : "path" });
    } else if (mode === kSymlinkMode && kNodeModulesSegmentRe.test(target)) {
      hits.push({ key: `${file} -> ${target}`, file, kind: "symlink into node_modules" });
    }
  }
  return hits;
};

const git = (args) =>
  execFileSync("git", args, { cwd: kRepoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const readTrackedEntries = () =>
  git(["ls-files", "-s", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const [meta, file] = record.split("\t");
      const [mode, object] = meta.split(" ");
      const target = mode === kSymlinkMode ? git(["cat-file", "blob", object]) : "";
      return { mode, file, target };
    });

describe("guard: no node_modules is committed", () => {
  it("flags node_modules paths, node_modules symlinks and links into an install (self-test)", () => {
    const entries = [
      { mode: kSymlinkMode, file: "node_modules", target: "/home/user/.capy/work/wt-q187/node_modules" },
      { mode: "100644", file: "node_modules/express/index.js", target: "" },
      { mode: "100644", file: "tests/fixtures/pkg/node_modules/dep/package.json", target: "" },
      { mode: kSymlinkMode, file: "lib/vendor/preact.js", target: "../../node_modules/preact/dist/preact.js" },
    ];
    expect(scanTrackedEntries(entries).map((hit) => [hit.key, hit.kind])).toEqual([
      ["node_modules", "symlink"],
      ["node_modules/express/index.js", "path"],
      ["tests/fixtures/pkg/node_modules/dep/package.json", "path"],
      ["lib/vendor/preact.js -> ../../node_modules/preact/dist/preact.js", "symlink into node_modules"],
    ]);
  });

  it("ignores names that only contain node_modules and ordinary symlinks (self-test)", () => {
    const entries = [
      { mode: "100644", file: "docs/node_modules-layout.md", target: "" },
      { mode: "100644", file: "lib/server/my_node_modules.js", target: "" },
      { mode: "100644", file: ".gitignore", target: "" },
      { mode: kSymlinkMode, file: "lib/current", target: "./releases/0.10.79" },
    ];
    expect(scanTrackedEntries(entries)).toEqual([]);
  });

  it("has no tracked node_modules outside the allowlist, and no stale allowlist entries", () => {
    const found = new Map(scanTrackedEntries(readTrackedEntries()).map((hit) => [hit.key, hit]));
    const allowed = new Set(Object.keys(kKnownOffenders));
    const unexpected = [...found.values()].filter((hit) => !allowed.has(hit.key));
    const stale = [...allowed].filter((key) => !found.has(key));
    expect(
      unexpected.map((hit) => `${hit.key} (${hit.kind})`),
      "node_modules is in the tree. Remove it with `git rm --cached -r <path>` (a worktree's node_modules symlink is local, never committed):",
    ).toEqual([]);
    expect(
      stale,
      `Allowlist entries no longer match — the offender was removed, drop them:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });
});
