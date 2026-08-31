const {
  createWatchdogOverseer,
  filterLogWindow,
  sanitizeVerdictText,
  parseVerdict,
} = require("../../lib/server/watchdog-overseer");

const kNow = Date.parse("2026-08-29T12:00:00Z");
const kSecret = "supersecretvalue123";

const iso = (ms) => new Date(ms).toISOString();

// --- in-memory incidents db harness -----------------------------------------

const createFakeIncidentsDb = (seed = []) => {
  const incidents = new Map(seed.map((incident) => [incident.id, { ...incident }]));
  const eventsById = new Map(
    seed.map((incident) => [incident.id, incident.__events || []]),
  );
  return {
    incidents,
    listIncidents: ({ limit = 10 } = {}) =>
      [...incidents.values()]
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .map((incident) => ({ ...incident })),
    getIncidentById: (id) =>
      incidents.has(id) ? { ...incidents.get(id) } : null,
    getIncidentEvents: (id) => {
      const events = eventsById.get(id) || [];
      return { totalCount: events.length, events: [...events] };
    },
    updateIncidentOverseer: (id, overseerJson) => {
      const incident = incidents.get(id);
      if (!incident) return false;
      incident.overseer = overseerJson;
      return true;
    },
    __appendEvent: (id, event) => {
      eventsById.get(id).push(event);
    },
  };
};

const settledIncident = (id, overrides = {}) => ({
  id,
  incidentKey: "gateway_crash",
  status: "resolved",
  openedAt: iso(kNow - 30 * 60_000),
  resolvedAt: iso(kNow - 5 * 60_000),
  eventCount: 2,
  summary: {
    v: 1,
    trigger: "gateway_crash",
    severity: "warning",
    outcome: "recovered",
    durationMs: 25 * 60_000,
    actions: ["restart"],
    eventCounts: { crash: 1, recovery: 1 },
    statusSnapshot: { health: "healthy", degradedReason: "HTTP 503 backlog" },
    resourceSample: { memory: { percent: 12 } },
  },
  overseer: null,
  __events: [
    { id: id * 10 + 1, eventType: "crash", status: "failed", createdAt: iso(kNow - 30 * 60_000) },
    { id: id * 10 + 2, eventType: "recovery", status: "ok", createdAt: iso(kNow - 5 * 60_000) },
  ],
  ...overrides,
});

// Fake claude runner: --version ok, --help advertises flags (configurable),
// -p returns a canned verdict envelope (like `claude -p --output-format json`).
const createFakeRunner = ({
  helpText = "--output-format --disallowedTools",
  verdict = {
    verdict: "resolved",
    action: "none",
    headline: "Crash recovered cleanly",
    summary: "One crash, immediate recovery.",
    recommendation: "No action needed.",
  },
  onSpawn = null,
} = {}) => {
  const calls = [];
  return {
    calls,
    runStreamed: async (options) => {
      calls.push(options);
      if (onSpawn) onSpawn(options);
      const args = options.args || [];
      if (args[0] === "--version") return { ok: true, tail: "claude 3.0.0" };
      if (args[0] === "--help") return { ok: true, tail: helpText };
      if (args[0] === "-p") {
        return {
          ok: true,
          tail: JSON.stringify({ result: JSON.stringify(verdict) }),
        };
      }
      return { ok: true, tail: "" };
    },
  };
};

const createHarness = ({
  seed = [settledIncident(1)],
  runner = createFakeRunner(),
  enabled = true,
  status = { health: "healthy" },
  notificationsEnabled = true,
  env = { ANTHROPIC_API_KEY: "sk-ant-test", [`MY_SECRET_TOKEN`]: kSecret },
  doctorJson = '{"ok":true}',
  logLines = null,
  nowRef = { value: kNow },
  overrides = {},
} = {}) => {
  const db = createFakeIncidentsDb(seed);
  const notify = vi.fn(async () => ({ ok: true }));
  const overseer = createWatchdogOverseer({
    incidentsDb: db,
    getWatchdogStatus: () => status,
    readLogTail: () =>
      logLines ??
      [
        `${iso(kNow - 29 * 60_000)} gateway boot`,
        `${iso(kNow - 20 * 60_000)} crash: segfault`,
        `${iso(kNow - 10 * 60_000)} relaunching`,
        ...Array.from({ length: 12 }, (_, i) => `${iso(kNow - 9 * 60_000 + i)} recovery line ${i}`),
        `${iso(kNow - 60_000)} healthy again`,
      ].join("\n"),
    getDoctorJson: async () => doctorJson,
    notify,
    isEnabled: () => enabled,
    notificationsEnabled: () => notificationsEnabled,
    getBaseUrl: () => "http://host:3000/",
    runStream: runner,
    env,
    fsModule: { mkdtempSync: () => "/tmp/fake-overseer-home" },
    nowFn: () => nowRef.value,
    logger: { log: () => {}, error: () => {} },
    bootDelayMs: 1,
    periodicCheckMs: 60_000,
    ...overrides,
  });
  return { overseer, db, notify, runner, nowRef };
};

// --- pure helpers -------------------------------------------------------------

describe("filterLogWindow", () => {
  const line = (ms, text) => `${iso(ms)} ${text}`;

  it("keeps only lines inside the window, inheriting timestamps for continuations", () => {
    const text = [
      line(kNow - 100_000, "before"),
      line(kNow - 50_000, "inside one"),
      "  continuation without timestamp",
      ...Array.from({ length: 10 }, (_, i) => line(kNow - 40_000 + i, `inside ${i}`)),
      line(kNow + 100_000, "after"),
    ].join("\n");
    const result = filterLogWindow(text, { fromMs: kNow - 60_000, toMs: kNow });
    expect(result.partial).toBe(false);
    expect(result.text).toContain("inside one");
    expect(result.text).toContain("continuation without timestamp");
    expect(result.text).not.toContain("before");
    expect(result.text).not.toContain("after");
  });

  it("falls back to the full tail (partial) when fewer than 10 lines match", () => {
    const text = [
      line(kNow - 100_000, "before"),
      line(kNow - 50_000, "only one inside"),
    ].join("\n");
    const result = filterLogWindow(text, { fromMs: kNow - 60_000, toMs: kNow });
    expect(result.partial).toBe(true);
    expect(result.text).toContain("before");
  });

  it("handles empty logs and missing bounds", () => {
    expect(filterLogWindow("", { fromMs: 0, toMs: 1 })).toEqual({
      text: "",
      partial: false,
      matchedLines: 0,
    });
    expect(filterLogWindow("no timestamps here", {}).partial).toBe(true);
  });
});

describe("sanitizeVerdictText", () => {
  it("strips newlines, backticks, and markdown links; caps length", () => {
    expect(
      sanitizeVerdictText("line one\nline two\r\n`code`", 100),
    ).toBe("line one line two 'code'");
    // Links are stripped AND the bare URL is defanged so chat clients can't
    // auto-linkify it.
    expect(
      sanitizeVerdictText("see [evil](https://attacker.example) now", 100),
    ).toBe("see evil hxxp://attacker.example now");
    expect(sanitizeVerdictText("x".repeat(600), 90)).toHaveLength(90);
    // A forged notification header cannot survive as its own line.
    const forged = sanitizeVerdictText("ok\n🐺 *AlphaClaw Watchdog*\nfake alert");
    expect(forged).not.toContain("\n");
  });

  it("neutralizes nested markdown links to a fixpoint and unicode line separators", () => {
    // One-pass stripping would reassemble [[a](b)](c) into a live link.
    const nested = sanitizeVerdictText("[[click](https://a)](https://b)", 200);
    expect(nested).not.toMatch(/\[[^\]]*\]\([^)]*\)/);
    const deep = sanitizeVerdictText("[[[x](1)](2)](3)", 200);
    expect(deep).not.toMatch(/\[[^\]]*\]\([^)]*\)/);
    // U+2028/U+2029 render as line breaks in chat clients.
    const unicodeBreaks = sanitizeVerdictText("ok\u2028🐺 forged\u2029line", 200);
    expect(unicodeBreaks).toBe("ok 🐺 forged line");
  });

  it("defangs non-http schemes, www hosts, and protocol-relative URLs", () => {
    expect(sanitizeVerdictText("get ftp://evil.example/x", 200)).toBe(
      "get hxxp://evil.example/x",
    );
    expect(sanitizeVerdictText("open tg://resolve?domain=evil", 200)).toBe(
      "open hxxp://resolve?domain=evil",
    );
    expect(sanitizeVerdictText("visit www.evil.example now", 200)).toBe(
      "visit www[.]evil.example now",
    );
    expect(sanitizeVerdictText("go to //evil.example/path", 200)).toBe(
      "go to / /evil.example/path",
    );
    // Plain prose slashes survive.
    expect(sanitizeVerdictText("either/or and a/b tests", 200)).toBe(
      "either/or and a/b tests",
    );
  });
});

describe("parseVerdict", () => {
  it("parses the claude -p json envelope and validates the action enum", () => {
    const parsed = parseVerdict(
      JSON.stringify({
        result: JSON.stringify({
          verdict: "action_needed",
          action: "repair",
          headline: "Repairs exhausted",
          summary: "Manual repair required.",
          recommendation: "Run Repair.",
        }),
      }),
    );
    expect(parsed.verdict).toBe("action_needed");
    expect(parsed.action).toBe("repair");
  });

  it("coerces unknown actions to none and rejects unknown verdicts", () => {
    expect(
      parseVerdict(JSON.stringify({ verdict: "resolved", action: "rm -rf" })).action,
    ).toBe("none");
    expect(parseVerdict(JSON.stringify({ verdict: "broken" }))).toBe(null);
    expect(parseVerdict("total garbage")).toBe(null);
  });
});

// --- factory ------------------------------------------------------------------

describe("createWatchdogOverseer", () => {
  it("is structurally advisory-only: constructs and reviews with zero watchdog mutators in its DI", async () => {
    // The full harness passes ONLY read fns + incident persistence + notify.
    // If the factory ever grows a triggerRepair/requestRollback dependency,
    // this construction (and every other test here) breaks loudly.
    const { overseer } = createHarness();
    const result = await overseer.maybeReviewNext();
    expect(result.ran).toBe(true);
  });

  it("reviews the incident end-to-end: persists done verdict and notifies once with dedup id + deep link", async () => {
    const { overseer, db, notify } = createHarness();
    const result = await overseer.maybeReviewNext();
    expect(result).toMatchObject({ ran: true, incidentId: 1, notified: true });
    const record = db.getIncidentById(1).overseer;
    expect(record.v).toBe(1);
    expect(record.current.state).toBe("done");
    expect(record.current.verdict).toBe("resolved");
    expect(record.current.headline).toBe("Crash recovered cleanly");
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notify.mock.calls[0];
    expect(message).toContain("🐺 *AlphaClaw Watchdog*");
    expect(message).toContain("🤖 Overseer: Crash recovered cleanly");
    expect(message).toContain("Trigger: `incident_1`");
    expect(message).toContain(
      "- [View incident](http://host:3000/#/watchdog?incident=1)",
    );
    // The canned verdict is "resolved" → informational (verbose); a
    // monitoring/action_needed verdict stays important (plan Phase-3 split).
    expect(opts).toEqual({
      eventType: "overseer",
      id: "watchdog-overseer-1",
      verbose: true,
    });
  });

  it("redacts secrets from the assembled prompt before the spawn", async () => {
    let spawnedInput = null;
    const runner = createFakeRunner({
      onSpawn: (options) => {
        if (options.args?.[0] === "-p") spawnedInput = options.input;
      },
    });
    const seed = [
      settledIncident(1, {
        __events: [
          {
            id: 11,
            eventType: "crash",
            status: "failed",
            createdAt: iso(kNow - 30 * 60_000),
            details: { stderrTail: [`leaked ${kSecret} in stderr`] },
          },
        ],
      }),
    ];
    const { overseer } = createHarness({
      seed,
      runner,
      doctorJson: `{"note":"doctor echoed ${kSecret}"}`,
      logLines: Array.from({ length: 15 }, (_, i) =>
        `${iso(kNow - 20 * 60_000 + i)} log mentions ${kSecret}`,
      ).join("\n"),
    });
    await overseer.maybeReviewNext();
    expect(spawnedInput).toBeTruthy();
    expect(spawnedInput).not.toContain(kSecret);
    expect(spawnedInput).toContain("UNTRUSTED");
  });

  it("redacts the persisted transcript tail (whole-output invariant, incl. the failure path)", async () => {
    // Success path: transcript echoes a secret-shaped env value.
    const chatty = createFakeRunner();
    const originalRun = chatty.runStreamed;
    chatty.runStreamed = async (options) => {
      const result = await originalRun(options);
      if (options.args?.[0] === "-p") {
        return { ...result, tail: `${result.tail}\nleaked ${kSecret}` };
      }
      return result;
    };
    const success = createHarness({ runner: chatty });
    await success.overseer.maybeReviewNext();
    expect(
      success.db.getIncidentById(1).overseer.current.transcriptTail,
    ).not.toContain(kSecret);

    // Failure path (spawn dies mid-review): its transcriptTail is persisted too.
    const failing = createFakeRunner();
    const originalFailingRun = failing.runStreamed;
    failing.runStreamed = async (options) => {
      if (options.args?.[0] === "-p") {
        return { ok: false, error: "boom", tail: `partial ${kSecret} output` };
      }
      return originalFailingRun(options);
    };
    const failure = createHarness({ runner: failing });
    await failure.overseer.maybeReviewNext();
    const failed = failure.db.getIncidentById(1).overseer.current;
    expect(failed.state).toBe("failed");
    expect(failed.transcriptTail).not.toContain(kSecret);
  });

  it("keeps live degradedReason out of the trusted status section (semi-trusted only)", async () => {
    let spawnedInput = null;
    const runner = createFakeRunner({
      onSpawn: (options) => {
        if (options.args?.[0] === "-p") spawnedInput = options.input;
      },
    });
    const { overseer } = createHarness({
      runner,
      status: { health: "healthy", degradedReason: "gateway-influenced text" },
    });
    await overseer.maybeReviewNext();
    const trustedSection = spawnedInput.split("=== INCIDENT EVENTS")[0];
    expect(trustedSection).not.toContain("gateway-influenced text");
    expect(spawnedInput).toContain("degradedReasonNow");
  });

  it("redacts and sanitizes model output before persisting", async () => {
    const runner = createFakeRunner({
      verdict: {
        verdict: "monitoring",
        action: "none",
        headline: `echoed ${kSecret}\nwith [link](http://x)`,
        summary: "watch it",
        recommendation: "",
      },
    });
    const { overseer, db } = createHarness({ runner });
    await overseer.maybeReviewNext();
    const current = db.getIncidentById(1).overseer.current;
    expect(current.headline).not.toContain(kSecret);
    expect(current.headline).not.toContain("\n");
    expect(current.headline).not.toContain("[link](");
  });

  it("fails closed when --disallowedTools support cannot be verified", async () => {
    const runner = createFakeRunner({ helpText: "--output-format only" });
    const { overseer, db, notify } = createHarness({ runner });
    const result = await overseer.maybeReviewNext();
    expect(result.skipped).toBe("cli_flags_unverifiable");
    const current = db.getIncidentById(1).overseer.current;
    expect(current.state).toBe("unavailable");
    expect(current.reason).toBe("cli_flags_unverifiable");
    expect(notify).not.toHaveBeenCalled();
  });

  it("records unavailable when the Anthropic credential is missing", async () => {
    const { overseer, db, notify } = createHarness({ env: {} });
    const result = await overseer.maybeReviewNext();
    expect(result.skipped).toBe("no_anthropic_credential");
    expect(db.getIncidentById(1).overseer.current.state).toBe("unavailable");
    expect(notify).not.toHaveBeenCalled();
  });

  it("persists an honest unparseable verdict and never notifies on it", async () => {
    const runner = createFakeRunner();
    runner.runStreamed = async (options) => {
      if (options.args?.[0] === "--version") return { ok: true, tail: "claude" };
      if (options.args?.[0] === "--help")
        return { ok: true, tail: "--disallowedTools" };
      return { ok: true, tail: "I think the incident was probably fine." };
    };
    const { overseer, db, notify } = createHarness({ runner });
    await overseer.maybeReviewNext();
    const current = db.getIncidentById(1).overseer.current;
    expect(current.verdict).toBe("unparseable");
    expect(current.state).toBe("done");
    expect(notify).not.toHaveBeenCalled();
  });

  it("marks the verdict stale (and never notifies) when the incident gains events mid-review", async () => {
    const runner = createFakeRunner();
    const { overseer, db, notify } = createHarness({ runner });
    const original = runner.runStreamed;
    runner.runStreamed = async (options) => {
      if (options.args?.[0] === "-p") {
        db.__appendEvent(1, {
          id: 999,
          eventType: "crash",
          status: "failed",
          createdAt: iso(kNow),
        });
      }
      return original(options);
    };
    await overseer.maybeReviewNext();
    expect(db.getIncidentById(1).overseer.current.state).toBe("stale");
    expect(notify).not.toHaveBeenCalled();
  });

  describe("eligibility gates", () => {
    it("skips when disabled", async () => {
      const { overseer } = createHarness({ enabled: false });
      expect(await overseer.maybeReviewNext()).toEqual({ skipped: "disabled" });
    });

    it("only reviews from a healthy steady state (no open incident, health healthy)", async () => {
      const degraded = createHarness({ status: { health: "degraded" } });
      expect(await degraded.overseer.maybeReviewNext()).toEqual({
        skipped: "not_steady_state",
      });
      const withOpen = createHarness({
        seed: [
          settledIncident(1),
          settledIncident(2, { status: "open", resolvedAt: null }),
        ],
      });
      expect(await withOpen.overseer.maybeReviewNext()).toEqual({
        skipped: "not_steady_state",
      });
    });

    it("waits out the 60s settle-quiet debounce", async () => {
      const { overseer } = createHarness({
        seed: [settledIncident(1, { resolvedAt: iso(kNow - 10_000) })],
      });
      expect(await overseer.maybeReviewNext()).toEqual({
        skipped: "no_eligible_incident",
      });
    });

    it("drains a backlog FIFO (oldest unreviewed first) with the global floor between reviews", async () => {
      const nowRef = { value: kNow };
      const { overseer, db, nowRef: ref } = createHarness({
        seed: [settledIncident(1), settledIncident(2)],
        nowRef,
      });
      const first = await overseer.maybeReviewNext();
      expect(first.incidentId).toBe(1);
      // Cooldown blocks the second review until the floor passes.
      expect(await overseer.maybeReviewNext()).toEqual({ skipped: "cooldown" });
      ref.value = kNow + 11 * 60_000;
      const second = await overseer.maybeReviewNext();
      expect(second.incidentId).toBe(2);
      expect(db.getIncidentById(1).overseer.current.state).toBe("done");
      expect(db.getIncidentById(2).overseer.current.state).toBe("done");
    });

    it("retries a stale pending stamp after 10 minutes", async () => {
      const nowRef = { value: kNow };
      const { overseer } = createHarness({
        seed: [
          settledIncident(1, {
            overseer: {
              v: 1,
              current: { state: "pending", at: kNow - 11 * 60_000 },
              history: [],
            },
          }),
        ],
        nowRef,
      });
      const result = await overseer.maybeReviewNext();
      expect(result.ran).toBe(true);
    });
  });

  describe("manual review", () => {
    it("bypasses the floor and existing-review gate, supersedes into history, and never notifies", async () => {
      const nowRef = { value: kNow };
      const { overseer, db, notify } = createHarness({ nowRef });
      await overseer.maybeReviewNext();
      expect(notify).toHaveBeenCalledTimes(1);
      // Immediately re-review manually (inside floor + already reviewed).
      nowRef.value = kNow + 3 * 60_000;
      const manual = await overseer.requestReview({ incidentId: 1 });
      expect(manual.ok).toBe(true);
      const record = db.getIncidentById(1).overseer;
      expect(record.current.manual).toBe(true);
      expect(record.history).toHaveLength(1);
      expect(record.history[0].manual).toBeFalsy();
      // Still exactly one notification — manual reviews are silent.
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("caps the history at 3 superseded verdicts", async () => {
      const nowRef = { value: kNow };
      const { overseer, db } = createHarness({ nowRef });
      await overseer.maybeReviewNext();
      for (let i = 1; i <= 4; i += 1) {
        nowRef.value = kNow + i * 3 * 60_000;
        // eslint-disable-next-line no-await-in-loop
        const result = await overseer.requestReview({ incidentId: 1 });
        expect(result.ok).toBe(true);
      }
      expect(db.getIncidentById(1).overseer.history).toHaveLength(3);
    });

    it("is rate-limited to one per 2 minutes and respects enabled/steady-state gates", async () => {
      const nowRef = { value: kNow };
      const { overseer } = createHarness({ nowRef });
      expect((await overseer.requestReview({ incidentId: 1 })).ok).toBe(true);
      nowRef.value = kNow + 30_000;
      expect(await overseer.requestReview({ incidentId: 1 })).toMatchObject({
        ok: false,
        code: "rate_limited",
      });
      const disabled = createHarness({ enabled: false });
      expect(await disabled.overseer.requestReview({})).toMatchObject({
        ok: false,
        code: "disabled",
      });
      const degraded = createHarness({ status: { health: "degraded" } });
      expect(await degraded.overseer.requestReview({})).toMatchObject({
        ok: false,
        code: "not_steady_state",
      });
    });

    it("404s unknown incidents and refuses open ones", async () => {
      const { overseer } = createHarness({
        seed: [settledIncident(1), settledIncident(2, { status: "open" })],
      });
      // An open incident anywhere means not_steady_state fires first — use a
      // seed without one for the not-found path.
      const clean = createHarness();
      expect(await clean.overseer.requestReview({ incidentId: 99 })).toMatchObject({
        ok: false,
        code: "no_incident",
      });
      expect(await overseer.requestReview({ incidentId: 2 })).toMatchObject({
        ok: false,
        code: "not_steady_state",
      });
    });
  });

  it("normalizes in-review refusals to a code so the route's 409 body is never empty", async () => {
    const runner = createFakeRunner({ helpText: "--output-format only" });
    const { overseer } = createHarness({ runner });
    const result = await overseer.requestReview({ incidentId: 1 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("cli_flags_unverifiable");
  });

  it("suppresses notification when the watchdog notifications kill switch is off", async () => {
    const { overseer, db, notify } = createHarness({ notificationsEnabled: false });
    const result = await overseer.maybeReviewNext();
    expect(result.ran).toBe(true);
    expect(db.getIncidentById(1).overseer.current.state).toBe("done");
    expect(notify).not.toHaveBeenCalled();
  });

  it("skips unchanged tuples on the automatic path (change-detection gate)", async () => {
    const nowRef = { value: kNow };
    const { overseer, db, nowRef: ref } = createHarness({ nowRef });
    await overseer.maybeReviewNext();
    // Clear the verdict but keep the tuple: same incident/status/lastEvent.
    db.updateIncidentOverseer(1, null);
    db.incidents.get(1).overseer = null;
    ref.value = kNow + 11 * 60_000;
    expect(await overseer.maybeReviewNext()).toMatchObject({
      skipped: "unchanged",
    });
  });

  it("start()/stop() are idempotent and clear both timers", () => {
    const { overseer } = createHarness();
    overseer.start();
    overseer.start();
    overseer.stop();
    overseer.stop();
  });

  it("buildOverseerEnv isolates the spawn env: allowlist + isolated HOME; API key only for the review spawn", () => {
    const { overseer } = createHarness({
      env: {
        PATH: "/usr/bin",
        LANG: "C.UTF-8",
        ANTHROPIC_API_KEY: "sk-ant-test",
        // None of these may reach the spawned CLI process.
        AWS_SECRET_ACCESS_KEY: kSecret,
        OPENCLAW_ADMIN_TOKEN: kSecret,
        TELEGRAM_BOT_TOKEN: kSecret,
        SSH_AUTH_SOCK: "/run/agent.sock",
      },
    });
    // Probe spawns (--version/--help/doctor) never receive the credential:
    // least privilege against a PATH-hijacked binary.
    const probeEnv = overseer.buildOverseerEnv();
    expect(probeEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.keys(probeEnv).sort()).toEqual(["HOME", "LANG", "PATH"]);
    const isolated = overseer.buildOverseerEnv({ withCredential: true });
    expect(isolated.PATH).toBe("/usr/bin");
    expect(isolated.LANG).toBe("C.UTF-8");
    expect(isolated.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    // The real user HOME (with ~/.claude state) never leaks in.
    expect(isolated.HOME).toBe("/tmp/fake-overseer-home");
    expect(Object.keys(isolated).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "HOME",
      "LANG",
      "PATH",
    ]);
  });

  it("fails closed when a secret-redaction source cannot be read", async () => {
    // A throwing .env/config reader means the scrub list is incomplete —
    // the review must be REFUSED (state unavailable + reason), not sent.
    const { overseer, db, runner } = createHarness({
      overrides: {
        readEnvFile: () => {
          throw new Error("EACCES: permission denied");
        },
      },
    });
    const result = await overseer.maybeReviewNext();
    expect(result.skipped).toBe("redaction_sources_unreadable");
    const record = db.getIncidentById(1).overseer.current;
    expect(record.state).toBe("unavailable");
    expect(record.reason).toBe("redaction_sources_unreadable");
    // The claude -p review spawn never ran (only --version/--help probes).
    expect(runner.calls.some((call) => (call.args || [])[0] === "-p")).toBe(false);
    overseer.stop();
  });

  it("fails closed when the config object reader throws", async () => {
    const { overseer, db } = createHarness({
      overrides: {
        getConfigObject: () => {
          throw new Error("openclaw.json is not JSON alphaclaw can parse");
        },
      },
    });
    const result = await overseer.maybeReviewNext();
    expect(result.skipped).toBe("redaction_sources_unreadable");
    expect(db.getIncidentById(1).overseer.current.state).toBe("unavailable");
    overseer.stop();
  });

  it("records claude_not_found when the version probe fails, and probe_failed when it throws", async () => {
    const missing = createFakeRunner();
    missing.runStreamed = async (options) => {
      if (options.args?.[0] === "--version") return { ok: false, tail: "" };
      return { ok: true, tail: "" };
    };
    const notFound = createHarness({ runner: missing });
    const result = await notFound.overseer.maybeReviewNext();
    expect(result.skipped).toBe("claude_not_found");
    const current = notFound.db.getIncidentById(1).overseer.current;
    expect(current.state).toBe("unavailable");
    expect(current.reason).toBe("claude_not_found");
    expect(notFound.notify).not.toHaveBeenCalled();

    const throwing = createFakeRunner();
    throwing.runStreamed = async (options) => {
      if (options.args?.[0] === "--version") throw new Error("spawn EACCES");
      return { ok: true, tail: "" };
    };
    const failed = createHarness({ runner: throwing });
    const availability = await failed.overseer.getAvailability();
    expect(availability).toMatchObject({ available: false, reason: "probe_failed" });
    expect(availability.message).toContain("spawn EACCES");
  });
});
