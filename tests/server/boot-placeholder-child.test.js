const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const kChildPath = path.join(__dirname, "..", "..", "lib", "boot-placeholder-child.js");

const httpGet = (port, options = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: options.path || "/health", headers: options.headers || {} },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });

const waitForServer = async (port, attempts = 50) => {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await httpGet(port);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("placeholder child never started listening");
};

describe("bin boot placeholder child process", () => {
  let child = null;

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.on("exit", resolve));
    }
    child = null;
  });

  it("serves updating health and 503s, then exits promptly on SIGTERM", async () => {
    const port = 19000 + Math.floor(Math.random() * 500);
    child = spawn(process.execPath, [kChildPath], {
      env: { ...process.env, ALPHACLAW_PLACEHOLDER_PORT: String(port) },
      stdio: "ignore",
    });

    const health = await waitForServer(port);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: "updating", gateway: "starting" });

    const browser = await httpGet(port, { path: "/", headers: { accept: "text/html" } });
    expect(browser.status).toBe(503);
    expect(browser.headers["retry-after"]).toBe("5");
    expect(browser.body).toContain("AlphaClaw is updating");

    const api = await httpGet(port, { path: "/api/status" });
    expect(api.status).toBe(503);
    expect(JSON.parse(api.body).status).toBe("updating");

    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000)),
    ]);
    expect(code).not.toBe("timeout");
  });
});
