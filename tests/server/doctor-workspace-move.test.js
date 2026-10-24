// OpenClaw 2026.10.x's workspace-alias check (core/doctor/workspace-alias)
// stops doctor --fix --yes when the workspace folder's real path changed
// after OpenClaw saved its setup records. AlphaClaw classifies it as its own
// reason and takes both paths from Doctor's output, whichever form it came in.
const fs = require("fs");
const path = require("path");
const { createDoctorOutputFacts, parseWorkspaceMove, summarizeDoctorResult } = require("../../lib/server/doctor-outcome");
const { describeDoctorFailure } = require("../../lib/server/doctor-plain-language");

const kFixtureDir = path.join(__dirname, "..", "fixtures", "doctor-workspace-alias");
// Real output of openclaw 2026.10.7 doctor --fix --yes on a state dir moved
// behind a symlink (OPENCLAW_HOME=/data, records saved before the move).
const kStdout = fs.readFileSync(path.join(kFixtureDir, "2026.10.7-stdout.txt"), "utf8");
const kStderr = fs.readFileSync(path.join(kFixtureDir, "2026.10.7-stderr.txt"), "utf8");
const kEnv = { OPENCLAW_HOME: "/data", HOME: "/data" };
const kExpected = { aliasPath: "/data/.openclaw/workspace", from: "/data/.openclaw/workspace", to: "/data/bigrepo/sub/workspace" };

const runFacts = (chunks, env = kEnv) => {
  const facts = createDoctorOutputFacts({ env });
  for (const [text, stream] of chunks) facts.onOutput(text, stream);
  return facts.snapshot();
};

describe("doctor-outcome: OpenClaw's workspace-alias stop", () => {
  it("classifies the real 2026.10.7 output as workspace_moved with both paths, home-expanded", () => {
    const facts = runFacts([[kStdout, "stdout"], [kStderr, "stderr"]]);
    expect(facts.workspaceMove).toEqual(kExpected);
    const summary = summarizeDoctorResult({ ok: false, code: 1, facts });
    expect(summary).toMatchObject({ status: "failed", class: "deterministic", reason: "workspace_moved", workspaceMove: kExpected });
    expect(summary.detail).toMatch(/^Failing check workspace-state \(step-threw\): Workspace path/);
    expect(describeDoctorFailure(summary)).toBe(
      "The workspace folder's real location changed, and OpenClaw needs a confirmation before it rebinds its saved records.",
    );
  });

  it("reads the boxed notes alone (wrapped over several lines)", () => {
    expect(runFacts([[kStdout, "stdout"]]).workspaceMove).toEqual(kExpected);
  });

  it("reads the truncated 'Failing check' line alone", () => {
    const failing = kStderr.split("\n").find((line) => line.startsWith("Failing check workspace-state"));
    expect(runFacts([[`${failing}\n`, "stderr"]]).workspaceMove).toEqual(kExpected);
  });

  it("survives a line split across output chunks, and keeps the paths when stdout and stderr interleave", () => {
    const warning = kStderr.split("\n")[1];
    const cut = warning.indexOf("bigrepo");
    const facts = runFacts([
      ["Doctor warnings\n", "stdout"],
      [warning.slice(0, cut), "stderr"],
      ["│  unrelated boxed line │\n", "stdout"],
      [`${warning.slice(cut)}\n`, "stderr"],
    ]);
    expect(facts.workspaceMove).toEqual(kExpected);
  });

  it("reads the runtime error's wording and leaves literal paths alone", () => {
    const line =
      "WorkspaceAliasRepointedError: workspace path alias points to a different current target: /srv/claw/ws now resolves to /mnt/big/claw/ws, but its stored workspace state belongs to /srv/old/ws. Run `openclaw doctor --fix` and confirm the move, or use `openclaw doctor --fix --force`.";
    expect(parseWorkspaceMove(line)).toEqual({ aliasPath: "/srv/claw/ws", from: "/srv/old/ws", to: "/mnt/big/claw/ws" });
  });

  it("expands ~ and keeps paths with spaces whole", () => {
    const line = "Workspace path ~/My Claw/workspace now resolves to /Volumes/Big Disk/claw/workspace, but its saved setup records belong to ~/My Claw/workspace. Incoming messages cannot use this workspace until it is repaired.";
    expect(parseWorkspaceMove(line, { env: { HOME: "/Users/op" } })).toEqual({
      aliasPath: "/Users/op/My Claw/workspace",
      from: "/Users/op/My Claw/workspace",
      to: "/Volumes/Big Disk/claw/workspace",
    });
  });

  it("records OpenClaw's refusal when the move can't be rebound even with a confirmation", () => {
    const facts = runFacts([
      [
        "│  Workspace path /data/.openclaw/workspace now resolves to /data/repo/ws, but its saved setup records │\n│  belong to /data/.openclaw/workspace. The original workspace still exists. This repair only moves │\n│  records after the original folder has moved; restore the link if the move was not intended. │\n",
        "stdout",
      ],
      ["Failing check workspace-state (step-threw): Workspace path /data/.openclaw/workspace now resolves to /data/repo/ws, but its saved setup records belong to /data/.openclaw/workspace.\n", "stderr"],
    ]);
    const summary = summarizeDoctorResult({ ok: false, code: 1, facts });
    expect(summary.reason).toBe("workspace_moved");
    expect(summary.workspaceMove.blocked).toBe("The original workspace still exists.");
  });

  it("a rebound run that completed is ok, and unrelated failures keep their own reason", () => {
    const rebound = "│  Rebound workspace state for $OPENCLAW_HOME/.openclaw/workspace to     │\n│  $OPENCLAW_HOME/repo/sub/workspace. Workspace files were not changed.  │\n";
    expect(summarizeDoctorResult({ ok: true, code: 0, facts: runFacts([[rebound, "stdout"]]) }).status).toBe("ok");
    expect(runFacts([[rebound, "stdout"]]).workspaceMove).toBeNull();
    const other = summarizeDoctorResult({ ok: false, code: 1, stdout: "Failing check plugins: broken\n" });
    expect(other.reason).toBe("failing_check");
    expect(other.workspaceMove).toBeUndefined();
  });
});
