const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { registerBrowseRoutes } = require("../../lib/server/routes/browse");

// Symlink containment regressions: lexical `..` checks pass a symlink inside
// the root straight through, so every escape below succeeded before
// resolveSafePath became realpath-aware. Each attack test has an allow-side
// twin proving legit nested paths still work.

const createTestRoot = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-browse-symlink-"));

const createOutsideDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-browse-outside-"));

const createApp = (kRootDir) => {
  const app = express();
  app.use(express.json());
  registerBrowseRoutes({ app, fs, kRootDir });
  return app;
};

describe("server/routes/browse symlink containment", () => {
  it("rejects reading through a symlinked directory that escapes the root", async () => {
    const rootDir = createTestRoot();
    const outsideDir = createOutsideDir();
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top secret", "utf8");
    fs.symlinkSync(outsideDir, path.join(rootDir, "esc"));
    const app = createApp(rootDir);

    const res = await request(app)
      .get("/api/browse/read")
      .query({ path: "esc/secret.txt" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Path must stay within");
  });

  it("rejects reading a symlinked file that escapes the root", async () => {
    const rootDir = createTestRoot();
    const outsideDir = createOutsideDir();
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top secret", "utf8");
    fs.symlinkSync(
      path.join(outsideDir, "secret.txt"),
      path.join(rootDir, "innocent.txt"),
    );
    const app = createApp(rootDir);

    const res = await request(app)
      .get("/api/browse/read")
      .query({ path: "innocent.txt" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Path must stay within");
  });

  it("rejects writing through a symlink that escapes the root", async () => {
    const rootDir = createTestRoot();
    const outsideDir = createOutsideDir();
    const outsideFile = path.join(outsideDir, "target.txt");
    fs.writeFileSync(outsideFile, "original", "utf8");
    fs.symlinkSync(outsideFile, path.join(rootDir, "innocent.txt"));
    const app = createApp(rootDir);

    const res = await request(app)
      .put("/api/browse/write")
      .send({ path: "innocent.txt", content: "pwned" });

    expect(res.status).toBe(400);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("original");
  });

  it("fails closed on a dangling symlink write target instead of creating the target outside the root", async () => {