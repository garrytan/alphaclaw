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
    const rootDir = createTestRoot();
    const outsideDir = createOutsideDir();
    const outsideTarget = path.join(outsideDir, "planted.txt");
    // Symlink points outside the root at a path that does not exist yet.
    fs.symlinkSync(outsideTarget, path.join(rootDir, "innocent.txt"));
    const app = createApp(rootDir);

    const res = await request(app)
      .put("/api/browse/write")
      .send({ path: "innocent.txt", content: "pwned" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Path must stay within");
    expect(fs.existsSync(outsideTarget)).toBe(false);
  });

  it("allows reading a legitimate nested file (no over-blocking)", async () => {
    const rootDir = createTestRoot();
    fs.mkdirSync(path.join(rootDir, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "a", "b", "note.txt"), "ok", "utf8");
    const app = createApp(rootDir);

    const res = await request(app)
      .get("/api/browse/read")
      .query({ path: "a/b/note.txt" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.content).toBe("ok");
  });

  it("allows writing through a symlink that stays inside the root", async () => {
    const rootDir = createTestRoot();
    fs.mkdirSync(path.join(rootDir, "real"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "real", "f.txt"), "orig", "utf8");
    // Symlink stays within the root, so writes through it are legitimate.
    fs.symlinkSync(path.join(rootDir, "real"), path.join(rootDir, "link"));
    const app = createApp(rootDir);

    const res = await request(app)
      .put("/api/browse/write")
      .send({ path: "link/f.txt", content: "updated" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fs.readFileSync(path.join(rootDir, "real", "f.txt"), "utf8")).toBe(
      "updated",
    );
  });

  // CX3: after realpath, the locked-path policy must run on the CANONICAL
  // relative path — a symlink can resolve inside the root but into a locked
  // subtree while the request path looks benign.
  it("rejects writing into a locked subtree reached via a symlink inside root", async () => {
    const rootDir = createTestRoot();
    fs.mkdirSync(path.join(rootDir, ".alphaclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, ".alphaclaw", "hourly-git-sync.sh"),
      "#!/bin/bash\n",
      "utf8",
    );
    fs.symlinkSync(
      path.join(rootDir, ".alphaclaw"),
      path.join(rootDir, "sneaky"),
    );
    const app = createApp(rootDir);

    const res = await request(app)
      .put("/api/browse/write")
      .send({ path: "sneaky/hourly-git-sync.sh", content: "pwned" });

    expect(res.status).toBe(403);
    expect(
      fs.readFileSync(
        path.join(rootDir, ".alphaclaw", "hourly-git-sync.sh"),
        "utf8",
      ),
    ).toBe("#!/bin/bash\n");
  });
});