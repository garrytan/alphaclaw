const {
  diffConfigKeyPaths,
} = require("../../lib/server/utils/config-key-diff");

describe("server/utils/config-key-diff", () => {
  it("reports added, removed and changed top-level keys", () => {
    expect(
      diffConfigKeyPaths(
        { keep: 1, gone: 2, edited: "before" },
        { keep: 1, fresh: 3, edited: "after" },
      ),
    ).toEqual({
      added: ["fresh"],
      removed: ["gone"],
      changed: ["edited"],
    });
  });

  it("returns three empty arrays for identical trees", () => {
    const tree = { gateway: { port: 18789, auth: { mode: "token" } }, list: [1] };
    expect(diffConfigKeyPaths(tree, structuredClone(tree))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it("recurses into nested objects and reports dotted paths", () => {
    expect(
      diffConfigKeyPaths(
        { mcp: { servers: { a: { cmd: "x" }, b: { cmd: "y" } } }, meta: { v: 1 } },
        { mcp: { servers: { a: { cmd: "x2" }, c: { cmd: "z" } } }, meta: { v: 1 } },
      ),
    ).toEqual({
      added: ["mcp.servers.c"],
      removed: ["mcp.servers.b"],
      changed: ["mcp.servers.a.cmd"],
    });
  });

  it("reports a subtree that appears or disappears once, at its root", () => {
    expect(
      diffConfigKeyPaths({ plugins: { telegram: { enabled: true } } }, {}),
    ).toEqual({ added: [], removed: ["plugins"], changed: [] });
    expect(
      diffConfigKeyPaths({}, { plugins: { telegram: { enabled: true } } }),
    ).toEqual({ added: ["plugins"], removed: [], changed: [] });
  });

  it("treats an object <-> scalar type change as one changed leaf", () => {
    expect(diffConfigKeyPaths({ a: { b: 1 } }, { a: 1 })).toEqual({
      added: [],
      removed: [],
      changed: ["a"],
    });
    expect(diffConfigKeyPaths({ a: null }, { a: { b: 1 } })).toEqual({
      added: [],
      removed: [],
      changed: ["a"],
    });
  });

  it("compares arrays as leaves by JSON equality — never indexes into them", () => {
    // Appended element: the parent path, not `list.2`.
    expect(
      diffConfigKeyPaths({ agents: { list: [1, 2] } }, { agents: { list: [1, 2, 3] } }),
    ).toEqual({ added: [], removed: [], changed: ["agents.list"] });
    // Reordered: still a change (no ordering tolerance).
    expect(diffConfigKeyPaths({ list: ["a", "b"] }, { list: ["b", "a"] })).toEqual({
      added: [],
      removed: [],
      changed: ["list"],
    });
    // Structurally equal arrays of objects: no diff.
    expect(
      diffConfigKeyPaths(
        { entries: [{ id: "x", tags: [1] }] },
        { entries: [{ id: "x", tags: [1] }] },
      ),
    ).toEqual({ added: [], removed: [], changed: [] });
    // Array <-> object at the same path: a changed leaf, not a recursion.
    expect(diffConfigKeyPaths({ a: [1] }, { a: { 0: 1 } })).toEqual({
      added: [],
      removed: [],
      changed: ["a"],
    });
  });

  it("diffs non-object inputs as empty trees", () => {
    const empty = { added: [], removed: [], changed: [] };
    expect(diffConfigKeyPaths(null, null)).toEqual(empty);
    expect(diffConfigKeyPaths(undefined, undefined)).toEqual(empty);
    expect(diffConfigKeyPaths("a", "b")).toEqual(empty);
    expect(diffConfigKeyPaths([1, 2], [3])).toEqual(empty);
    expect(diffConfigKeyPaths(42, {})).toEqual(empty);
    // One real side: its keys are reported against the empty tree — an
    // unparseable counterpart must never masquerade as "identical".
    expect(diffConfigKeyPaths({ a: 1, b: { c: 2 } }, null)).toEqual({
      added: [],
      removed: ["a", "b"],
      changed: [],
    });
    expect(diffConfigKeyPaths(undefined, { a: 1 })).toEqual({
      added: ["a"],
      removed: [],
      changed: [],
    });
  });

  it("never includes values in the result (secret-safe by construction)", () => {
    const secret = "sk-live-THIS-MUST-NOT-LEAK-0123456789";
    const rotated = "sk-live-ROTATED-MUST-NOT-LEAK-9876543210";
    const result = diffConfigKeyPaths(
      { gateway: { auth: { token: secret } }, env: { OLD_KEY: secret } },
      { gateway: { auth: { token: rotated } }, env: { NEW_KEY: rotated } },
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(rotated);
    expect(Object.keys(result).sort()).toEqual(["added", "changed", "removed"]);
    expect(result).toEqual({
      added: ["env.NEW_KEY"],
      removed: ["env.OLD_KEY"],
      changed: ["gateway.auth.token"],
    });
    for (const list of Object.values(result)) {
      for (const entry of list) expect(typeof entry).toBe("string");
    }
  });

  it("sorts every list so output is independent of key insertion order", () => {
    const left = { z: 1, m: { b: 1, a: 1 }, a: 1 };
    const right = { m: { a: 2, b: 2, c: 2 }, q: 1 };
    const rightReordered = { q: 1, m: { c: 2, b: 2, a: 2 } };
    const expected = {
      added: ["m.c", "q"],
      removed: ["a", "z"],
      changed: ["m.a", "m.b"],
    };
    expect(diffConfigKeyPaths(left, right)).toEqual(expected);
    expect(diffConfigKeyPaths(left, rightReordered)).toEqual(expected);
    // Byte-identical when persisted: the config gate writes this to disk.
    expect(JSON.stringify(diffConfigKeyPaths(left, right))).toBe(
      JSON.stringify(diffConfigKeyPaths(left, rightReordered)),
    );
  });

  it("does not throw on cyclic or over-deep trees", () => {
    const cyclicLeft = { name: "l" };
    cyclicLeft.self = cyclicLeft;
    const cyclicRight = { name: "r" };
    cyclicRight.self = cyclicRight;
    let result;
    expect(() => {
      result = diffConfigKeyPaths(cyclicLeft, cyclicRight);
    }).not.toThrow();
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toContain("name");
    // Same cyclic object on both sides: identity short-circuits to equal.
    expect(diffConfigKeyPaths(cyclicLeft, cyclicLeft)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });

    const deep = (leaf) => {
      let node = leaf;
      for (let i = 0; i < 64; i += 1) node = { n: node };
      return node;
    };
    expect(diffConfigKeyPaths(deep(1), deep(1))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    const deepDiff = diffConfigKeyPaths(deep(1), deep(2));
    expect(deepDiff.changed).toHaveLength(1);
    expect(deepDiff.changed[0].startsWith("n.n.n")).toBe(true);
  });
});
