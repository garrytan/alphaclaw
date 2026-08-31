import { describe, expect, it } from "vitest";
import {
  GeneralHardeningCard,
  buildHardeningCardModel,
} from "../../lib/public/js/components/general/hardening-card.js";

const status = (state, { reason = "", files = [], channel = "stable" } = {}) => ({
  releaseChannel: channel,
  bootstrapContext: {
    hardening: { state, reason, files },
  },
});

const hardeningFile = (overrides = {}) => ({
  path: "hooks/bootstrap/AGENTS.md",
  exists: true,
  injectable: true,
  skipped: false,
  truncated: false,
  reason: "",
  ...overrides,
});

describe("frontend/general hardening card", () => {
  it("renders nothing for healthy, unknown, dev-channel, and old payloads", () => {
    expect(buildHardeningCardModel(null)).toBe(null);
    expect(buildHardeningCardModel({})).toBe(null);
    expect(buildHardeningCardModel({ bootstrapContext: {} })).toBe(null);
    expect(buildHardeningCardModel(status("injected"))).toBe(null);
    expect(buildHardeningCardModel(status("unknown"))).toBe(null);
    // Dev-channel builds are owned by the badge's "unverified" copy.
    expect(
      buildHardeningCardModel(status("blocked", { channel: "dev" })),
    ).toBe(null);
    expect(GeneralHardeningCard({ doctorStatus: null })).toBe(null);
  });

  it("names the file, cause, and managed fix for a missing hardening file", () => {
    const model = buildHardeningCardModel(
      status("blocked", {
        reason: "missing_file",
        files: [hardeningFile({ exists: false })],
      }),
    );
    expect(model.tone).toBe("danger");
    expect(model.badgeLabel).toBe("BLOCKED");
    expect(model.anchor).toBe("Safety rules are not reaching the agent.");
    expect(model.detail).toContain("hooks/bootstrap/AGENTS.md");
    expect(model.signals).toHaveLength(1);
    expect(model.signals[0].cause).toContain("missing from disk");
    expect(model.signals[0].fix).toContain("Restart AlphaClaw");
    expect(model.needsRestartFootnote).toBe(true);
  });

  it("gives symlink copy for escapes_workspace — never the restart-rewrites fix", () => {
    const model = buildHardeningCardModel(
      status("blocked", {
        reason: "escapes_workspace",
        files: [hardeningFile({ exists: false, reason: "escapes_workspace" })],
      }),
    );
    expect(model.signals[0].cause).toContain("escaping symlink");
    expect(model.signals[0].fix).toContain("Delete the symlink");
    expect(model.signals[0].fix).not.toContain("boot resync rewrites it");
  });

  it("gives read-cap copy for file_too_large without budget advice", () => {
    const model = buildHardeningCardModel(
      status("blocked", {
        reason: "file_too_large",
        files: [hardeningFile({ exists: false, reason: "file_too_large" })],
      }),
    );
    expect(model.signals[0].cause).toContain("2 MiB read cap");
    expect(model.signals[0].fix).not.toContain("bootstrapMaxChars");
  });

  it("keys mixed causes per file — never one homogenized cause", () => {
    const model = buildHardeningCardModel(
      status("blocked", {
        reason: "escapes_workspace",
        files: [
          hardeningFile({ exists: false, reason: "escapes_workspace" }),
          hardeningFile({ path: "hooks/bootstrap/MEMORY.md", exists: false }),
        ],
      }),
    );
    expect(model.signals).toHaveLength(2);
    expect(model.signals[0].cause).toContain("escaping symlink");
    // The plain-missing file keys missing_file, not the top-level reason.
    expect(model.signals[1].cause).toContain("missing from disk");
  });

  it("derives severity from impact within starved", () => {
    // Fully dropped file (skipped) → danger, badged DROPPED.
    const dropped = buildHardeningCardModel(
      status("starved", {
        files: [hardeningFile({ skipped: true, truncated: true, reason: "starved" })],
      }),
    );
    expect(dropped.tone).toBe("danger");
    expect(dropped.badgeLabel).toBe("DROPPED");
    expect(dropped.detail).toContain("dropped by the context budget");
    // Merely truncated → warning, badged PARTIAL.
    const partial = buildHardeningCardModel(
      status("starved", {
        files: [hardeningFile({ truncated: true, reason: "file_limit" })],
      }),
    );
    expect(partial.tone).toBe("warning");
    expect(partial.badgeLabel).toBe("PARTIAL");
    expect(partial.anchor).toBe("Some safety rules are cut before reaching the agent.");
  });

  it("gives opposite budget advice for per-file cap vs total budget", () => {
    const capHit = buildHardeningCardModel(
      status("starved", {
        files: [hardeningFile({ truncated: true, reason: "file_limit" })],
      }),
    );
    const totalHit = buildHardeningCardModel(
      status("starved", {
        files: [hardeningFile({ truncated: true, reason: "total_limit" })],
      }),
    );
    expect(capHit.signals[0].fix).toContain("bootstrapMaxChars");
    expect(totalHit.signals[0].fix).toContain("bootstrapTotalMaxChars");
    expect(capHit.signals[0].fix).not.toBe(totalHit.signals[0].fix);
  });

  it("fails safe to danger with a generic signal on empty or non-matching files", () => {
    // Old servers ship files: [] — blocked still means zero delivery.
    const legacy = buildHardeningCardModel(status("blocked", { files: [] }));
    expect(legacy.tone).toBe("danger");
    expect(legacy.signals).toHaveLength(1);
    expect(legacy.signals[0].cause.length).toBeGreaterThan(0);
    // A bad state whose files all look healthy still renders one signal.
    const nonMatching = buildHardeningCardModel(
      status("blocked", { files: [hardeningFile()] }),
    );
    expect(nonMatching.signals).toHaveLength(1);
    // Malformed files payload never throws.
    expect(
      buildHardeningCardModel(status("blocked", { files: "nope" })).tone,
    ).toBe("danger");
  });

  it("shows 3 signals and collapses the rest", () => {
    const files = Array.from({ length: 5 }, (_, index) =>
      hardeningFile({
        path: `hooks/bootstrap/F${index}.md`,
        exists: false,
      }),
    );
    const model = buildHardeningCardModel(
      status("blocked", { reason: "missing_file", files }),
    );
    expect(model.signals).toHaveLength(3);
    expect(model.collapsedSignals).toHaveLength(2);
  });

  it("renders a vnode carrying the Open Drift Doctor CTA", () => {
    const onOpenDoctor = () => {};
    const vnode = GeneralHardeningCard({
      doctorStatus: status("blocked", {
        reason: "missing_file",
        files: [hardeningFile({ exists: false })],
      }),
      onOpenDoctor,
    });
    expect(vnode).not.toBe(null);
    // Walk the vnode tree for the ActionButton props; navigation itself is
    // wired at the call site (general/index.js → "doctor?focus=context").
    const findCta = (node) => {
      if (!node || typeof node !== "object") return null;
      if (node.props?.idleLabel === "Open Drift Doctor") return node;
      const children = node.props?.children;
      for (const child of Array.isArray(children) ? children : [children]) {
        const found = findCta(child);
        if (found) return found;
      }
      return null;
    };
    const cta = findCta(vnode);
    expect(cta).not.toBe(null);
    expect(cta.props.onClick).toBe(onOpenDoctor);
    expect(cta.props.tone).toBe("danger");
  });
});
