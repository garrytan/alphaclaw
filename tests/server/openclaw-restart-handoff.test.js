const {
  consumeRestartHandoff,
} = require("../../lib/server/openclaw-restart-handoff");

const ok = (stdout) => ({ ok: true, stdout, stderr: "" });
const fail = (stdout, code = 1) => ({ ok: false, stdout, stderr: "", code });

describe("server/openclaw-restart-handoff", () => {
  it("accepts an explicitly consumed handoff for the matching pid", async () => {
    const clawCmd = vi.fn(async () => ok(JSON.stringify({ consumed: true })));
    const r = await consumeRestartHandoff({ clawCmd, pid: 4242 });
    expect(r.accepted).toBe(true);
    expect(clawCmd).toHaveBeenCalledWith(
      "gateway restart-handoff consume --expected-pid 4242 --json",
      expect.objectContaining({ quiet: true }),
    );
  });

  it("rejects an exit-0 non-restart result (no handoff present)", async () => {
    const clawCmd = async () => ok(JSON.stringify({ result: "none" }));
    const r = await consumeRestartHandoff({ clawCmd, pid: 4242 });
    expect(r.accepted).toBe(false);
  });

  it("treats a pid mismatch / store failure (nonzero exit) as not accepted", async () => {
    const clawCmd = async () => fail(JSON.stringify({ reason: "invalid-expected-pid" }), 2);
    const r = await consumeRestartHandoff({ clawCmd, pid: 4242 });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("invalid-expected-pid");
  });

  it("treats unparseable output as not accepted", async () => {
    const clawCmd = async () => ok("not json at all");
    const r = await consumeRestartHandoff({ clawCmd, pid: 4242 });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("unparseable");
  });

  it("fails closed when the CLI throws (crash, not intentional restart)", async () => {
    const clawCmd = async () => {
      throw new Error("spawn ETIMEDOUT");
    };
    const r = await consumeRestartHandoff({
      clawCmd,
      pid: 4242,
      logger: { warn: () => {} },
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("error");
  });

  it("rejects an invalid pid without shelling out", async () => {
    const clawCmd = vi.fn();
    const r = await consumeRestartHandoff({ clawCmd, pid: 0 });
    expect(r.accepted).toBe(false);
    expect(clawCmd).not.toHaveBeenCalled();
  });
});
