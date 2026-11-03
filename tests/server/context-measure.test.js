const fixture = require("../fixtures/context-weight/sessions-usage-2026.10.9.json");
const {
  normalizeContextWeight,
  classifySessionKind,
  toWorkspaceRelative,
  kMaxFiles,
} = require("../../lib/server/context-measure/normalize");
const { createMeasuredContextReader, pickCandidates } = require("../../lib/server/context-measure");

const realReport = () => JSON.parse(JSON.stringify(fixture.sessions[0].contextWeight));

const parseCall = (cmd) => {
  const match = /^gateway call '([^']+)' --params '(.*)' --json$/.exec(cmd);
  if (!match) throw new Error(`unexpected command: ${cmd}`);
  return { method: match[1], params: JSON.parse(match[2]) };
};

const okJson = (body) => ({ ok: true, stdout: JSON.stringify(body), stderr: "" });

const mainRow = { key: "agent:main:main", agentId: "main", kind: "direct", classification: "main", isMain: true, updatedAt: 100 };

const createFakeClaw = ({ rows = [mainRow], usageFor = () => okJson(fixture) } = {}) => {
  const calls = [];
  const clawCmd = vi.fn(async (cmd) => {
    const call = parseCall(cmd);
    calls.push(call);
    if (call.method === "sessions.list") return okJson({ sessions: rows });
    if (call.method === "sessions.usage") return usageFor(call.params);
    throw new Error(`unexpected method ${call.method}`);
  });
  return { clawCmd, calls };
};

describe("normalizeContextWeight (OpenClaw 2026.10.9 run report)", () => {
  it("reports the real fixture's files workspace-relative, badges AlphaClaw's files and drops host paths", () => {
    const measured = normalizeContextWeight(realReport(), { sessionKind: "main" });
    expect(measured.files.map((file) => file.path)).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "BOOTSTRAP.md",
      "hooks/bootstrap/AGENTS.md",
      "hooks/bootstrap/reference/AGENTS.md",
    ]);
    expect(measured.files.filter((file) => file.managed).map((file) => file.path)).toEqual([
      "hooks/bootstrap/AGENTS.md",
      "hooks/bootstrap/reference/AGENTS.md",
    ]);
    expect(measured.systemPrompt).toEqual({ chars: 34702, projectContextChars: 29440, nonProjectContextChars: 5262 });
    expect(measured.filesTotal.injectedChars).toBe(6449 + 1526 + 1453 + 1136 + 7475 + 8084 + 202);
    expect(measured.filesTotal.managedInjectedChars).toBe(8084 + 202);
    expect(measured.sessionKind).toBe("main");
    expect(measured.model).toBe("echo");
    const serialized = JSON.stringify(measured);
    expect(serialized).not.toContain("/data/.openclaw");
    expect(serialized).not.toContain("agent:main:main");
    expect(serialized).not.toContain(realReport().sessionId);
  });

  it("returns null for an estimate or a missing report", () => {
    expect(normalizeContextWeight({ ...realReport(), source: "estimate" })).toBeNull();
    expect(normalizeContextWeight(null)).toBeNull();
  });

  it("marks native_unverified files unverified and leaves them out of totals", () => {
    const report = realReport();
    report.injectedWorkspaceFiles.push({
      name: "MEMORY.md",
      path: "/data/.openclaw/workspace/MEMORY.md",
      missing: false,
      rawChars: 5000,
      injectionStatus: "native_unverified",
      injectedChars: null,
      truncated: null,
    });
    const measured = normalizeContextWeight(report);
    const memory = measured.files.find((file) => file.path === "MEMORY.md");
    expect(memory).toMatchObject({ verified: false, injectedChars: null, truncated: null, rawChars: 5000 });
    expect(measured.filesTotal.unverifiedFiles).toBe(1);
    expect(measured.filesTotal.injectedChars).toBe(normalizeContextWeight(realReport()).filesTotal.injectedChars);
  });

  it("bounds and sanitizes workspace-controlled names, files and top lists", () => {
    const report = realReport();
    report.injectedWorkspaceFiles = Array.from({ length: kMaxFiles + 10 }, (_, i) => ({
      name: `F${i}\u0007\nX.md`,
      path: `/data/.openclaw/workspace/f${i}.md`,
      missing: false,
      rawChars: 10,
      injectedChars: 10,
      truncated: false,
    }));
    report.skills = {
      promptChars: 900,
      entries: Array.from({ length: 15 }, (_, i) => ({ name: `skill-${i}${"x".repeat(300)}`, blockChars: i })),
    };
    report.tools = { schemaChars: 50, entries: [{ name: "exec", schemaChars: 50 }] };
    const measured = normalizeContextWeight(report);
    expect(measured.files).toHaveLength(kMaxFiles);
    expect(measured.files[0].name).toBe("F0 X.md");
    expect(measured.skills.count).toBe(15);
    expect(measured.skills.top).toHaveLength(10);
    expect(measured.skills.top[0].chars).toBe(14);
    expect(measured.skills.top[0].name.length).toBeLessThanOrEqual(120);
    expect(measured.tools).toEqual({ schemaChars: 50, count: 1, top: [{ name: "exec", chars: 50 }] });
  });

  it("never reports a path outside the workspace as anything but its basename", () => {
    expect(toWorkspaceRelative("/etc/secret/AGENTS.md", "/data/.openclaw/workspace", "AGENTS.md")).toBe("AGENTS.md");
    expect(toWorkspaceRelative("/data/.openclaw/workspace/hooks/bootstrap/AGENTS.md", "/data/.openclaw/workspace")).toBe(
      "hooks/bootstrap/AGENTS.md",
    );
  });

  it("classifies session kinds from the list row", () => {
    expect(classifySessionKind(mainRow)).toBe("main");
    expect(classifySessionKind({ key: "agent:main:cron:abc", kind: "direct" })).toBe("cron");
    expect(classifySessionKind({ key: "agent:main:subagent:x", kind: "direct" })).toBe("subagent");
    expect(classifySessionKind({ key: "agent:main:telegram:group:-100", kind: "group" })).toBe("group");
    expect(classifySessionKind({ key: "agent:main:telegram:direct:42", kind: "direct" })).toBe("direct");
  });
});

describe("createMeasuredContextReader", () => {
  it("lists the agent's sessions, then reads ONE key-scoped 7-day usage report", async () => {
    const { clawCmd, calls } = createFakeClaw();
    const reader = createMeasuredContextReader({ clawCmd });
    const measured = await reader.read("main");
    expect(measured).toMatchObject({ available: true, agentId: "main", sessionKind: "main" });
    expect(calls).toEqual([
      {
        method: "sessions.list",
        params: { agentId: "main", limit: 20, rowMode: "compact", sortBy: "updatedAt", excludeSystem: true },
      },
      {
        method: "sessions.usage",
        params: { agentId: "main", key: "agent:main:main", range: "7d", includeContextWeight: true },
      },
    ]);
  });

  it("prefers main and direct sessions over a newer cron run, and names the kind it fell back to", () => {
    const rows = [
      { key: "agent:main:cron:nightly", agentId: "main", kind: "direct", updatedAt: 900 },
      { key: "agent:main:telegram:direct:1", agentId: "main", kind: "direct", updatedAt: 500 },
      mainRow,
      { key: "agent:other:main", agentId: "other", isMain: true, updatedAt: 999 },
    ];
    expect(pickCandidates(rows, "main").map((c) => c.row.key)).toEqual([
      "agent:main:telegram:direct:1",
      "agent:main:main",
      "agent:main:cron:nightly",
    ]);
  });

  it("falls through to the next candidate when a session has no run report yet", async () => {
    const rows = [
      { key: "agent:main:telegram:direct:1", agentId: "main", kind: "direct", updatedAt: 500 },
      mainRow,
    ];
    const { clawCmd, calls } = createFakeClaw({
      rows,
      usageFor: (params) =>
        params.key === "agent:main:main"
          ? okJson({ sessions: [{ ...fixture.sessions[0], key: "agent:main:main" }] })
          : okJson({ sessions: [{ key: params.key, hasContextWeight: false, contextWeight: null }] }),
    });
    const measured = await createMeasuredContextReader({ clawCmd }).read("main");
    expect(measured).toMatchObject({ available: true, sessionKind: "main" });
    expect(calls.filter((call) => call.method === "sessions.usage")).toHaveLength(2);
  });

  it("reports no_run, gateway and unsupported distinctly", async () => {
    const noRows = createFakeClaw({ rows: [] });
    expect(await createMeasuredContextReader({ clawCmd: noRows.clawCmd }).read("main")).toEqual({
      available: false,
      reason: "no_run",
    });
    const down = vi.fn(async () => ({ ok: false, stdout: "", stderr: "gateway closed" }));
    expect(await createMeasuredContextReader({ clawCmd: down }).read("main")).toEqual({
      available: false,
      reason: "gateway",
    });
    const oldPin = createFakeClaw({
      usageFor: () => ({
        ok: false,
        stdout: JSON.stringify({ ok: false, error: { message: "invalid sessions.usage params: unexpected property 'includeContextWeight'" } }),
        stderr: "",
      }),
    });
    expect(await createMeasuredContextReader({ clawCmd: oldPin.clawCmd }).read("main")).toEqual({
      available: false,
      reason: "unsupported",
    });
    const noField = createFakeClaw({ usageFor: () => okJson({ sessions: [{ key: "agent:main:main" }] }) });
    expect(await createMeasuredContextReader({ clawCmd: noField.clawCmd }).read("main")).toEqual({
      available: false,
      reason: "unsupported",
    });
  });

  it("shares one in-flight read per agent and caches success 60 s, failure at most 5 s", async () => {
    let nowMs = 1_000;
    const { clawCmd } = createFakeClaw();
    const reader = createMeasuredContextReader({ clawCmd, now: () => nowMs });
    const [a, b] = await Promise.all([reader.read("main"), reader.read("main")]);
    expect(a).toBe(b);
    expect(clawCmd).toHaveBeenCalledTimes(2);
    nowMs += 59_000;
    await reader.read("main");
    expect(clawCmd).toHaveBeenCalledTimes(2);
    nowMs += 2_000;
    await reader.read("main");
    expect(clawCmd).toHaveBeenCalledTimes(4);

    const down = vi.fn(async () => ({ ok: false, stdout: "", stderr: "" }));
    const failing = createMeasuredContextReader({ clawCmd: down, now: () => nowMs });
    await failing.read("main");
    await failing.read("main");
    expect(down).toHaveBeenCalledTimes(1);
    nowMs += 5_001;
    await failing.read("main");
    expect(down).toHaveBeenCalledTimes(2);
  });

  it("runs one read at a time across distinct agents", async () => {
    let active = 0;
    let maxActive = 0;
    const clawCmd = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return okJson({ sessions: [] });
    });
    const reader = createMeasuredContextReader({ clawCmd });
    const results = await Promise.all(["a1", "a2", "a3", "a4"].map((id) => reader.read(id)));
    expect(results.every((result) => result.reason === "no_run")).toBe(true);
    expect(clawCmd).toHaveBeenCalledTimes(4);
    expect(maxActive).toBe(1);
  });

  it("keeps reading after a queued read throws", async () => {
    const clawCmd = vi
      .fn()
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValue(okJson({ sessions: [] }));
    const reader = createMeasuredContextReader({ clawCmd });
    const [first, second] = await Promise.all([reader.read("a1"), reader.read("a2")]);
    expect(first.reason).toBe("gateway");
    expect(second.reason).toBe("no_run");
  });

  it("drops expired cache entries when it writes a new one", async () => {
    let nowMs = 1_000;
    const { clawCmd } = createFakeClaw({ rows: [] });
    const reader = createMeasuredContextReader({ clawCmd, now: () => nowMs });
    await reader.read("a1");
    await reader.read("a2");
    expect(reader.cacheSize()).toBe(2);
    nowMs += 5_001;
    await reader.read("a3");
    expect(reader.cacheSize()).toBe(1);
  });

  it("answers gateway instead of throwing when the CLI wrapper throws", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("spawn failed");
    });
    expect(await createMeasuredContextReader({ clawCmd: throwing }).read("main")).toEqual({
      available: false,
      reason: "gateway",
    });
  });
});
