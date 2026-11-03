import { describe, expect, it } from "vitest";
import {
  buildMeasuredContextModel,
  MeasuredContextCard,
} from "../../lib/public/js/components/doctor/context-measured.js";

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object" && node.props) collectText(node.props.children, out);
  return out;
};

const kMeasured = {
  available: true,
  agentId: "main",
  sessionKind: "main",
  provider: "anthropic",
  model: "claude-opus-5-5",
  generatedAt: 1_000_000,
  systemPrompt: { chars: 40000, projectContextChars: 30000, nonProjectContextChars: 10000 },
  files: [
    { path: "AGENTS.md", rawChars: 4000, injectedChars: 4000, truncated: false, verified: true, managed: false },
    {
      path: "hooks/bootstrap/AGENTS.md",
      rawChars: 8000,
      injectedChars: 8000,
      truncated: false,
      verified: true,
      managed: true,
    },
    { path: "MEMORY.md", rawChars: 30000, injectedChars: 18000, truncated: true, verified: true, managed: false },
    { path: "SOUL.md", rawChars: 900, injectedChars: null, truncated: null, verified: false, managed: false },
    { path: "USER.md", rawChars: 0, injectedChars: 0, missing: true, verified: true, managed: false },
  ],
  filesTotal: { injectedChars: 30000, managedInjectedChars: 8000, truncatedFiles: 1, unverifiedFiles: 1 },
  skills: { promptChars: 1200, count: 3, top: [] },
  tools: { schemaChars: 8000, count: 12, top: [] },
};

describe("frontend/doctor measured context", () => {
  it("sorts rows by injected size, badges AlphaClaw's files and shows each file's share", () => {
    const model = buildMeasuredContextModel(kMeasured, { nowMs: 1_000_000 + 5 * 60_000 });
    expect(model.rows.map((row) => row.path)).toEqual([
      "MEMORY.md",
      "hooks/bootstrap/AGENTS.md",
      "AGENTS.md",
      "SOUL.md",
    ]);
    expect(model.rows.find((row) => row.path === "hooks/bootstrap/AGENTS.md")).toMatchObject({
      managed: true,
      share: 27,
      state: "ok",
    });
    expect(model.rows[0]).toMatchObject({ state: "truncated", share: 60 });
    expect(model.rows[0].detail).toBe("18,000 chars (~4,500 tok) of 30,000");
    expect(model.rows.find((row) => row.path === "SOUL.md")).toMatchObject({
      state: "unverified",
      share: null,
      detail: "900 chars on disk",
    });
    expect(model.summary).toBe("40,000 chars (~10,000 tok) system prompt");
    expect(model.meta).toBe("main session · anthropic/claude-opus-5-5 · 5 minutes ago");
    expect(model.lines.map((line) => line.label)).toEqual([
      "Workspace files (Project Context)",
      "AlphaClaw's own files",
      "Skills list (3 skills)",
      "Tool schemas (12 tools)",
    ]);
  });

  it("opens files from main's report only, since the file browser serves main's workspace", () => {
    expect(buildMeasuredContextModel(kMeasured).rows.every((row) => row.openable)).toBe(true);
    const ops = buildMeasuredContextModel({ ...kMeasured, agentId: "ops" });
    expect(ops.rows.some((row) => row.openable)).toBe(false);
  });

  it("explains each unavailable reason in plain words", () => {
    expect(buildMeasuredContextModel({ available: false, reason: "no_run" }).message).toMatch(/No run recorded yet/);
    expect(buildMeasuredContextModel({ available: false, reason: "unsupported" }).message).toMatch(/does not report/);
    expect(buildMeasuredContextModel({ available: false, reason: "gateway" }).message).toMatch(/gateway did not answer/);
    expect(buildMeasuredContextModel(null)).toBeNull();
  });

  it("renders the card with the OpenClaw Usage link and the unverified note", () => {
    const text = collectText(MeasuredContextCard({ measured: kMeasured, nowMs: 1_000_000 })).join(" ");
    expect(text).toContain("Measured context (last run)");
    expect(text).toContain("OpenClaw Usage");
    expect(text).toContain("native harness");
    expect(text).toContain("hooks/bootstrap/AGENTS.md");
  });
});
