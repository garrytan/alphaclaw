import { describe, expect, it, vi } from "vitest";
import { prepareBackupRiskApply } from "../../lib/public/js/components/upgrade-tab/backup-risk-consent.js";

const operationId = "failed-operation";
const token = "a".repeat(43);
const fullSha = "abcdef01".repeat(5);
const offer = (target = { channel: "beta", version: "2026.9.2-beta.1" }) => ({ operationId, target, label: "Reviewed target" });
const issued = (target, overrides = {}) => ({ operationId, target, confirmNoBackupToken: token, ...overrides });

describe("backup-risk apply preparation", () => {
  it("uses the reviewed run and sends only its exact package target and ephemeral consent", async () => {
    const reviewed = offer();
    const request = vi.fn(async () => issued(reviewed.target));
    expect(await prepareBackupRiskApply(reviewed, request)).toEqual({
      payload: reviewed.target, label: reviewed.label, confirmNoBackup: true, confirmNoBackupToken: token,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(operationId);
    expect(JSON.stringify(reviewed)).not.toContain(token);
  });

  it("expands a matching short dev commit to the full commit the server bound", async () => {
    const reviewed = offer({ channel: "dev", sha: fullSha.slice(0, 8), devHead: false });
    const apply = await prepareBackupRiskApply(reviewed, async () => issued({ channel: "dev", sha: fullSha }));
    expect(apply.payload).toEqual({ channel: "dev", sha: fullSha });
    expect(reviewed.target.sha).toHaveLength(8);
  });

  it.each([
    [offer(), issued({ channel: "stable", version: "2026.9.2-beta.1" })],
    [offer(), issued({ channel: "beta", version: "2026.9.2-beta.2" })],
    [offer(), issued(offer().target, { operationId: "other-run" })],
    [offer(), issued(offer().target, { confirmNoBackupToken: "short" })],
    [offer({ channel: "dev", sha: fullSha, devHead: true }), issued({ channel: "dev", sha: fullSha })],
    [offer({ channel: "dev", sha: fullSha }), issued({ channel: "dev", sha: "1".repeat(40) })],
    [offer({ channel: "dev", sha: fullSha.slice(0, 6) }), issued({ channel: "dev", sha: fullSha })],
    [offer({ channel: "stable" }), issued({ channel: "stable" })],
    [offer({ channel: "other", version: "1.0.0" }), issued({ channel: "other", version: "1.0.0" })],
  ])("refuses changed or unverified target/run/token facts (%#)", async (reviewed, response) => {
    await expect(prepareBackupRiskApply(reviewed, async () => response)).rejects.toThrow();
  });

  it("captures review identity before issuance and refuses a response following mutated UI state", async () => {
    const reviewed = offer();
    let resolve;
    const result = prepareBackupRiskApply(reviewed, () => new Promise((done) => { resolve = done; }));
    reviewed.target.version = "2026.9.2-beta.2";
    reviewed.operationId = "other-run";
    resolve(issued(reviewed.target, { operationId: reviewed.operationId }));
    await expect(result).rejects.toThrow(/changed/);
  });
});
