const { parseSidecarRegistry, readSidecarRegistry, kMaxSidecars } = require("../../lib/server/sidecars/registry");

const parse = (value) => parseSidecarRegistry(JSON.stringify(value));

describe("sidecar registry", () => {
  it("is off when ALPHACLAW_SIDECARS is unset or blank", () => {
    expect(readSidecarRegistry({ env: {} })).toEqual({ configured: false, entries: [], errors: [] });
    expect(parseSidecarRegistry("   ")).toEqual({ configured: false, entries: [], errors: [] });
  });

  it("normalizes the three operator shapes: a guard script, a tmux-hosted server, a daemon", () => {
    const { entries, errors } = parse([
      { name: "memory-guard", command: ["bash", "/srv/ops/guard.sh"] },
      {
        name: "cli-server",
        type: "forking",
        command: ["tmux", "-L", "cli", "new-session", "-d", "-s", "cli", "cli serve"],
        check: ["tmux", "-L", "cli", "has-session", "-t", "cli"],
        stop: ["tmux", "-L", "cli", "kill-server"],
        env: { HOME: "/srv" },
        envUnset: ["ANTHROPIC_*", "OPENAI_API_KEY"],
      },
      { name: "kb-daemon", command: ["bun", "run", "serve"], cwd: "/srv/kb", envFile: "/srv/kb/.env", user: "kb", restart: "on-failure" },
    ]);
    expect(errors).toEqual([]);
    expect(entries.map((entry) => [entry.name, entry.type, entry.restart, entry.startAfter])).toEqual([
      ["memory-guard", "simple", "always", "gateway"],
      ["cli-server", "forking", "always", "gateway"],
      ["kb-daemon", "simple", "on-failure", "gateway"],
    ]);
    expect(entries[1].envUnset).toEqual(["ANTHROPIC_*", "OPENAI_API_KEY"]);
    expect(entries[2]).toMatchObject({ user: "kb", cwd: "/srv/kb", envFile: "/srv/kb/.env", stopTimeoutSeconds: 5 });
  });

  it("defaults a oneshot to restart never", () => {
    const { entries } = parse([{ name: "post-boot", type: "oneshot", command: ["/srv/ops/after-boot.sh"] }]);
    expect(entries[0].restart).toBe("never");
  });

  it("reports a bad entry with its index and keeps the valid ones", () => {
    const { entries, errors } = parse([
      { name: "ok", command: ["true"] },
      { name: "Bad Name", command: "bash /srv/x.sh" },
      { name: "fork", type: "forking", command: ["tmux"] },
      { name: "ok", command: ["true"] },
      { name: "extra", command: ["true"], shell: true, stopTimeoutSeconds: 60, cwd: "relative" },
    ]);
    expect(entries.map((entry) => entry.name)).toEqual(["ok"]);
    expect(errors).toEqual([
      expect.objectContaining({ index: 1, errors: expect.arrayContaining([expect.stringMatching(/^name must be/), expect.stringMatching(/^command must be a non-empty array/)]) }),
      expect.objectContaining({ index: 2, errors: [expect.stringMatching(/needs a check command/)] }),
      { index: 3, name: "ok", errors: ["duplicate name"] },
      expect.objectContaining({
        index: 4,
        errors: expect.arrayContaining(["unknown field: shell", "cwd must be an absolute path", "stopTimeoutSeconds must be an integer from 1 to 8"]),
      }),
    ]);
  });

  it("rejects check/stop on a non-forking entry and bad envUnset names", () => {
    const { errors } = parse([{ name: "a", command: ["x"], check: ["y"], envUnset: ["BAD-NAME"] }]);
    expect(errors[0].errors).toEqual(
      expect.arrayContaining(["check applies only to type forking", expect.stringMatching(/^envUnset must be/)]),
    );
  });

  it("reports invalid JSON and a non-array value instead of throwing", () => {
    expect(parseSidecarRegistry("{nope").errors[0].errors[0]).toMatch(/not valid JSON/);
    expect(parse({ name: "a" }).errors[0].errors[0]).toMatch(/must be a JSON array/);
  });

  it("caps the registry size", () => {
    const many = Array.from({ length: kMaxSidecars + 1 }, (_, i) => ({ name: `s${i}`, command: ["true"] }));
    const { entries, errors } = parse(many);
    expect(entries).toHaveLength(kMaxSidecars);
    expect(errors[0].errors[0]).toMatch(/at most/);
  });
});
