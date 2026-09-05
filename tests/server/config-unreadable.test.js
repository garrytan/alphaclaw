const {
  kConfigUnreadableCodes,
  kConfigUnreadableHint,
  isConfigUnreadableError,
  configUnreadableEnvelope,
  sendIfConfigUnreadable,
  noteConfigUnreadable,
  resetConfigUnreadableNotesForTests,
} = require("../../lib/server/utils/config-unreadable");

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

describe("utils/config-unreadable (fail-closed refusal vocabulary, PR 7)", () => {
  beforeEach(() => {
    resetConfigUnreadableNotesForTests();
  });

  it("recognizes every *_UNREADABLE code and nothing else", () => {
    for (const code of kConfigUnreadableCodes) {
      expect(isConfigUnreadableError(Object.assign(new Error("x"), { code }))).toBe(true);
    }
    expect(isConfigUnreadableError(new Error("plain"))).toBe(false);
    expect(isConfigUnreadableError({ code: "ENOENT" })).toBe(false);
    expect(isConfigUnreadableError(null)).toBe(false);
  });

  it("builds the established 'will not rewrite <file>' envelope with the JSON5 reason for openclaw.json", () => {
    const err = Object.assign(new Error("boom"), {
      code: "OPENCLAW_CONFIG_UNREADABLE",
      configPath: "/data/.openclaw/openclaw.json",
    });
    const body = configUnreadableEnvelope(err);
    expect(body).toMatchObject({
      ok: false,
      code: "config_unreadable",
      file: "openclaw.json",
      sourceCode: "OPENCLAW_CONFIG_UNREADABLE",
      hint: kConfigUnreadableHint,
    });
    expect(body.error).toMatch(/will not rewrite openclaw\.json because it cannot parse it \(OpenClaw allows JSON5/);
    // The raw message (absolute paths, parser internals) never rides along.
    expect(JSON.stringify(body)).not.toMatch(/boom|\/data\//);
  });

  it("names the file from filePath, or a per-code default when the error carries none", () => {
    expect(
      configUnreadableEnvelope(
        Object.assign(new Error("x"), { code: "GOOGLE_STATE_UNREADABLE", filePath: "/x/gogcli/state.json" }),
      ).file,
    ).toBe("state.json");
    expect(configUnreadableEnvelope({ code: "EXEC_APPROVALS_UNREADABLE" }).file).toBe(
      "exec-approvals.json",
    );
    expect(configUnreadableEnvelope({ code: "EXEC_APPROVALS_UNREADABLE" }).error).toMatch(
      /torn write or a hand edit/,
    );
  });

  it("sendIfConfigUnreadable answers 503 by default, honors a caller status, and ignores other errors", () => {
    const err = Object.assign(new Error("x"), { code: "TOPIC_REGISTRY_UNREADABLE" });
    const res = makeRes();
    expect(sendIfConfigUnreadable(res, err)).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe("config_unreadable");

    const res409 = makeRes();
    expect(sendIfConfigUnreadable(res409, err, { status: 409 })).toBe(true);
    expect(res409.statusCode).toBe(409);

    const other = makeRes();
    expect(sendIfConfigUnreadable(other, new Error("nope"))).toBe(false);
    expect(other.statusCode).toBeNull();
  });

  it("noteConfigUnreadable records ONE watchdog event per file per process and warns once", () => {
    const insertWatchdogEvent = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = Object.assign(new Error("torn"), {
      code: "GOOGLE_STATE_UNREADABLE",
      filePath: "/tmp/x/state.json",
    });
    expect(noteConfigUnreadable({ error: err, source: "test", insertWatchdogEvent })).toBe(true);
    expect(noteConfigUnreadable({ error: err, source: "test", insertWatchdogEvent })).toBe(false);
    expect(insertWatchdogEvent).toHaveBeenCalledTimes(1);
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config_unreadable",
        source: "test",
        status: "warning",
        details: expect.objectContaining({ file: "/tmp/x/state.json", code: "GOOGLE_STATE_UNREADABLE" }),
      }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    // A different file is a different note.
    const other = Object.assign(new Error("torn"), {
      code: "GOOGLE_STATE_UNREADABLE",
      filePath: "/tmp/y/state.json",
    });
    expect(noteConfigUnreadable({ error: other, source: "test", insertWatchdogEvent })).toBe(true);
    expect(noteConfigUnreadable({ error: new Error("not a refusal") })).toBe(false);
    warn.mockRestore();
  });

  it("a throwing watchdog insert never propagates", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = Object.assign(new Error("x"), { code: "EXEC_APPROVALS_UNREADABLE", filePath: "/tmp/z" });
    expect(() =>
      noteConfigUnreadable({
        error: err,
        insertWatchdogEvent: () => {
          throw new Error("db closed");
        },
      }),
    ).not.toThrow();
    warn.mockRestore();
  });
});
