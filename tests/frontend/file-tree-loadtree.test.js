const fs = require("fs");
const path = require("path");

// H15: loadTree must have a STABLE identity (deps []) and read expandedPaths
// from a ref, so a folder toggle doesn't change loadTree's identity — which
// re-ran the mount effect (spinner flash, lost focus/scroll) and fired a second
// concurrent full-tree load. A loadSeqRef drops stale out-of-order resolves.
// This is a source-level guard: the component pulls in preact/htm and isn't
// unit-mountable in the node test env.
const fileTreeSource = fs.readFileSync(
  path.join(__dirname, "../../lib/public/js/components/file-tree.js"),
  "utf8",
);

describe("frontend/file-tree loadTree stability (H15)", () => {
  it("keeps expandedPaths in a ref synced by an effect", () => {
    expect(fileTreeSource).toContain("const expandedPathsRef = useRef(expandedPaths)");
    expect(fileTreeSource).toContain("expandedPathsRef.current = expandedPaths");
    expect(fileTreeSource).toContain("expandedPathsRef.current instanceof Set");
  });

  it("defines loadTree with stable identity (empty deps)", () => {
    // The loadTree useCallback must NOT depend on expandedPaths.
    const loadTreeBlock = fileTreeSource.slice(
      fileTreeSource.indexOf("const loadTree = useCallback"),
    );
    // The first useCallback dependency array after loadTree is `[]`.
    expect(loadTreeBlock).toMatch(/\}\s*,\s*\[\]\s*\)/);
    expect(loadTreeBlock.slice(0, 2000)).not.toContain("}, [expandedPaths])");
  });

  it("guards setTreeRoot with a monotonic load sequence", () => {
    expect(fileTreeSource).toContain("const loadSeqRef = useRef(0)");
    expect(fileTreeSource).toContain("loadSeqRef.current += 1");
    expect(fileTreeSource).toContain("if (loadSeq !== loadSeqRef.current) return");
  });
});
