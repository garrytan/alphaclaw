const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { populateImmutableCache } = require("../live/install-cache");

const helperPath = require.resolve("../live/install-cache");
const roots = [];
const children = new Set();
const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-cache-test-"));
  roots.push(root);
  return root;
};
const startPublisher = (root, { stall = false } = {}) => {
  const source = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { populateImmutableCache } = require(${JSON.stringify(helperPath)});
    populateImmutableCache({
      cacheRoot: ${JSON.stringify(root)}, key: '2026.9.2', pollMs: 10, timeoutMs: 3000,
      validate: (dir) => { try { return fs.readFileSync(path.join(dir, 'ready'), 'utf8') === 'verified'; } catch { return false; } },
      populate: async (dir) => {
        fs.appendFileSync(${JSON.stringify(path.join(root, "populations"))}, process.pid + '\\n');
        fs.writeFileSync(path.join(dir, 'partial'), 'not ready');
        process.stdout.write('populating\\n');
        await new Promise((resolve) => setTimeout(resolve, ${stall ? 30_000 : 200}));
        fs.writeFileSync(path.join(dir, 'ready'), 'verified');
      },
    }).then((result) => process.stdout.write(JSON.stringify(result) + '\\n')).catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => {
    children.delete(child);
    resolve({ code, signal, stdout, stderr });
  }));
  return { child, exited, output: () => stdout };
};
const waitFor = async (predicate) => {
  const until = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("publisher did not enter staging");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("two real processes populate once and only observe the verified published tree", async () => {
  const root = makeRoot();
  const first = startPublisher(root);
  await waitFor(() => first.output().includes("populating"));
  expect(fs.existsSync(path.join(root, "2026.9.2"))).toBe(false);
  const second = startPublisher(root);
  const results = await Promise.all([first.exited, second.exited]);
  for (const result of results) expect(result.code, result.stderr).toBe(0);
  expect(fs.readFileSync(path.join(root, "populations"), "utf8").trim().split("\n")).toHaveLength(1);
  expect(fs.readFileSync(path.join(root, "2026.9.2", "ready"), "utf8")).toBe("verified");
  expect(results.map((result) => JSON.parse(result.stdout.trim().split("\n").at(-1)).fromCache).sort()).toEqual([false, true]);
});

test("an interrupted owner leaves no consumable entry and the next process safely repopulates", async () => {
  const root = makeRoot();
  const first = startPublisher(root, { stall: true });
  await waitFor(() => first.output().includes("populating"));
  first.child.kill("SIGKILL");
  await first.exited;
  const second = startPublisher(root);
  const result = await second.exited;
  expect(result.code, result.stderr).toBe(0);
  expect(fs.readFileSync(path.join(root, "2026.9.2", "ready"), "utf8")).toBe("verified");
  expect(fs.readdirSync(root).filter((name) => name.includes("-staging-"))).toEqual([]);
  // Persistent lock inode is intentional: deleting it could split owners.
  expect(fs.readdirSync(path.join(root, ".locks"))).toEqual(["2026.9.2.sqlite"]);
});

test("a live owner cannot be displaced by a contender's timeout", async () => {
  const root = makeRoot();
  const first = startPublisher(root, { stall: true });
  await waitFor(() => first.output().includes("populating"));
  let populated = false;
  await expect(populateImmutableCache({
    cacheRoot: root, key: "2026.9.2", timeoutMs: 30, pollMs: 5,
    validate: () => false, populate: () => { populated = true; },
  })).rejects.toThrow("Timed out waiting");
  expect(populated).toBe(false);
  expect(first.child.exitCode).toBeNull();
  expect(first.output()).toContain("populating");
  first.child.kill("SIGKILL");
  await first.exited;
});

test("verification failure never replaces an existing entry and removes only owned staging", async () => {
  const root = makeRoot();
  const entry = path.join(root, "2026.9.2");
  fs.mkdirSync(entry);
  fs.writeFileSync(path.join(entry, "old"), "keep until replacement verified");
  await expect(populateImmutableCache({
    cacheRoot: root, key: "2026.9.2", validate: () => false,
    populate: (dir) => fs.writeFileSync(path.join(dir, "partial"), "broken"),
  })).rejects.toThrow("failed verification");
  expect(fs.readFileSync(path.join(entry, "old"), "utf8")).toBe("keep until replacement verified");
  expect(fs.readdirSync(root).filter((name) => name.includes("-staging-"))).toEqual([]);
});
