const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const gitModule = require("../../lib/server/routes/browse/git");

const realRunGitCommand = gitModule.runGitCommand;
const realRunGitCommandWithExitCode = gitModule.runGitCommandWithExitCode;

let runGitCommandImpl = realRunGitCommand;
let runGitCommandWithExitCodeImpl = realRunGitCommandWithExitCode;

// The browse route module destructures these functions at require time, so
// swap in delegating wrappers before it loads. The wrappers fall back to the
// real implementations outside of the tests in this file.
gitModule.runGitCommand = (...args) => runGitCommandImpl(...args);
gitModule.runGitCommandWithExitCode = (...args) =>
  runGitCommandWithExitCodeImpl(...args);

const { registerBrowseRoutes } = require("../../lib/server/routes/browse");

const createTestRoot = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-browse-gitmock-"));

const createApp = (kRootDir) => {
  const app = express();
  app.use(express.json());
  registerBrowseRoutes({ app, fs, kRootDir });
  return app;
};

afterEach(() => {
  runGitCommandImpl = realRunGitCommand;
  runGitCommandWithExitCodeImpl = realRunGitCommandWithExitCode;
});

afterAll(() => {
  gitModule.runGitCommand = realRunGitCommand;
  gitModule.runGitCommandWithExitCode = realRunGitCommandWithExitCode;
});

describe("server/routes/browse with failing git layer", () => {
  it("returns 500 when git-summary throws unexpectedly", async () => {
    const app = createApp(createTestRoot());
    runGitCommandImpl = async () => {
      throw new Error("summary exploded");
    };

    const res = await request(app).get("/api/browse/git-summary");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: "summary exploded" });
  });

  it("returns 500 when git-diff throws unexpectedly", async () => {
    const rootDir = createTestRoot();
    fs.writeFileSync(path.join(rootDir, "file.txt"), "hi\n", "utf8");
    const app = createApp(rootDir);
    runGitCommandWithExitCodeImpl = async () => {
      throw new Error("diff exploded");
    };

    const res = await request(app)
      .get("/api/browse/git-diff")
      .query({ path: "file.txt" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: "diff exploded" });
  });
});
