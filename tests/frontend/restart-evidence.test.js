import { describeStopEvidenceLines } from "../../lib/public/js/components/watchdog-tab/restart-evidence.js";

describe("frontend/restart-evidence", () => {
  it("an expedited ask reads as cut short by Restart now, never as an OpenClaw refusal (ALPH-17 PR 5)", () => {
    const lines = describeStopEvidenceLines({ stopEvidence: { how: "sigterm", askExit: "expedited", askRefusedLine: null } });
    const graceful = lines.find(([label]) => label === "Graceful stop");
    expect(graceful[1]).toMatch(/^cut short: someone chose Restart now/);
    expect(lines.some(([, text]) => /refused/.test(text))).toBe(false);
  });

  it("a non-zero ask exit without a graceful stop still reads as refused", () => {
    const lines = describeStopEvidenceLines({ stopEvidence: { how: "sigterm", askExit: 1, askRefusedLine: "nope" } });
    expect(lines.find(([label]) => label === "Graceful stop")[1]).toBe("OpenClaw refused: nope");
  });
});
