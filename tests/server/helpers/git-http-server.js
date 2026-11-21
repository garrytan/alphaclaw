const { spawn, execFileSync } = require("child_process");
const http = require("http");

// A local smart-HTTP git server (git http-backend behind Basic auth) that
// records every request, so a test can see exactly what git sent. Tokens map
// to an access level: "write" serves both services, "read" gets 403 on
// git-receive-pack (GitHub's answer for a read-only token), anything else gets
// 404 "Repository not found" (GitHub's answer for a token that cannot see the
// repository), and no credential gets 401 so git asks its helpers, unless
// anonymousRead makes the repositories public for git-upload-pack.
const startGitHttpServer = async ({ projectRoot, tokens, anonymousRead = false }) => {
  const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const header = String(req.headers.authorization || "");
    const decoded = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString("utf8") : "";
    const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : "";
    const access = password ? tokens[password] || "none" : anonymousRead && url.searchParams.get("service") !== "git-receive-pack" && !url.pathname.endsWith("/git-receive-pack") ? "read" : "";
    const service = url.searchParams.get("service") || (url.pathname.endsWith("/git-receive-pack") ? "git-receive-pack" : url.pathname.endsWith("/git-upload-pack") ? "git-upload-pack" : "");
    const entry = { method: req.method, path: url.pathname, service, access, bodyBytes: 0 };
    requests.push(entry);
    if (!access) {
      req.resume();
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
      res.end();
      return;
    }
    if (access === "none" || (access === "read" && service === "git-receive-pack")) {
      req.resume();
      res.writeHead(access === "none" ? 404 : 403, { "Content-Type": "text/plain" });
      res.end(access === "none" ? "Repository not found." : "Permission denied.");
      return;
    }
    const child = spawn(execPath + "/git-http-backend", [], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        REQUEST_METHOD: req.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] || "",
        REMOTE_USER: "tester",
        REMOTE_ADDR: "127.0.0.1",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] || "",
        GIT_HTTP_RECEIVE_PACK: "1",
      },
    });
    req.on("data", (chunk) => {
      entry.bodyBytes += chunk.length;
    });
    req.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on("data", (chunk) => {
      if (headersDone) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      headersDone = true;
      let status = 200;
      const headers = {};
      for (const line of head.slice(0, end).toString("utf8").split("\r\n")) {
        const index = line.indexOf(":");
        if (index < 0) continue;
        const name = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      res.write(head.slice(end + 4));
    });
    child.stdout.on("end", () => res.end());
    child.stderr.resume();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: "http://127.0.0.1:" + port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

module.exports = { startGitHttpServer };
