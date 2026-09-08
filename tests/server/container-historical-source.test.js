const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { sourceAtCommit, repoRoot } = require("../container/container-helpers");

test("historical image sources come from the immutable commit without switching the workspace", async () => {
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const current = fs.readFileSync(path.join(repoRoot, "package.json"));
  const source = await sourceAtCommit("01d3b66bf1caf00488b38d468590359de04b98fd");
  expect(JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version).toBe("0.9.76");
  expect(fs.realpathSync(path.join(source, "node_modules"))).toBe(fs.realpathSync(path.join(repoRoot, "node_modules")));
  expect(fs.readFileSync(path.join(repoRoot, "package.json"))).toEqual(current);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" })).toBe(before);
});

test("historical image preparation refuses movable refs", async () => {
  await expect(sourceAtCommit("main")).rejects.toThrow("full immutable commit");
  await expect(sourceAtCommit("01d3b66")).rejects.toThrow("full immutable commit");
});
