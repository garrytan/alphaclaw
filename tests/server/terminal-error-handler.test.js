const express = require("express");
const request = require("supertest");

const { createTerminalErrorHandler } = require("../../lib/server/terminal-error-handler");
const { createPublicDiskFullNotice, isDiskFullError, kPublicDiskFullMessage } = require("../../lib/server/disk-full");

const kSilentLogger = { error() {} };
const kMb = 1024 * 1024;

const buildApp = (diskFullNotice) => {
  const app = express();
  app.get("/api/sqlite-full", () => {
    throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
  });
  app.post("/api/auth/login", () => {
    throw new Error("ENOSPC: no space left on device, write '/data/.alphaclaw/login-throttle.json'");
  });
  app.get("/setup", () => {
    throw Object.assign(new Error("ENOSPC: no space left on device, open '/data/x'"), { code: "ENOSPC" });
  });
  app.get("/api/boom", () => {
    throw new Error("db exploded: /data/secret/path");
  });
  app.use(createTerminalErrorHandler({ diskFullNotice, logger: kSilentLogger }));
  return app;
};

describe("terminal error handler: a full disk", () => {
  it("answers an API request 503 disk_full with the public sentence only, and remembers it for the login page", async () => {
    const notice = createPublicDiskFullNotice({ measure: () => ({ dir: "/data", freeBytes: 10 * 1024 * kMb }) });
    const app = buildApp(notice);
    expect(notice.read()).toBeNull();

    const login = await request(app).post("/api/auth/login").send({ password: "x" });
    expect(login.status).toBe(503);
    expect(login.body).toEqual({ ok: false, code: "disk_full", error: kPublicDiskFullMessage });
    expect(JSON.stringify(login.body)).not.toMatch(/\/data|MB|ENOSPC/);
    expect(notice.read()).toEqual({ code: "disk_full", message: kPublicDiskFullMessage });

    const sqlite = await request(app).get("/api/sqlite-full");
    expect(sqlite.body.code).toBe("disk_full");
  });

  it("sends a page navigation to the login page, and keeps other 500s generic", async () => {
    const app = buildApp(createPublicDiskFullNotice({ measure: () => null }));
    const page = await request(app).get("/setup").set("Accept", "text/html");
    expect(page.status).toBe(303);
    expect(page.headers.location).toBe("/login.html");
    const boom = await request(app).get("/api/boom");
    expect(boom.status).toBe(500);
    expect(boom.body).toEqual({ ok: false, error: "Internal server error" });
  });
});

describe("public disk-full notice", () => {
  it("shows while a refusal is recent or the disk measures nearly empty, and clears after", () => {
    let now = 1_000_000;
    let freeBytes = 10 * 1024 * kMb;
    const notice = createPublicDiskFullNotice({ measure: () => ({ dir: "/data", freeBytes }), nowFn: () => now });
    expect(notice.read()).toBeNull();
    notice.noteError();
    expect(notice.read()).toMatchObject({ code: "disk_full" });
    now += 10 * 60 * 1000;
    expect(notice.read()).toBeNull();
    freeBytes = 2 * kMb;
    expect(notice.read()).toMatchObject({ code: "disk_full" });
  });

  it("recognises ENOSPC, EDQUOT and SQLite's full-database error, and nothing else", () => {
    expect(isDiskFullError(Object.assign(new Error("x"), { code: "ENOSPC" }))).toBe(true);
    expect(isDiskFullError(Object.assign(new Error("x"), { code: "EDQUOT" }))).toBe(true);
    expect(isDiskFullError(new Error("database or disk is full"))).toBe(true);
    expect(isDiskFullError(new Error("SQLITE_BUSY: database is locked"))).toBe(false);
    expect(isDiskFullError(null)).toBe(false);
  });
});
