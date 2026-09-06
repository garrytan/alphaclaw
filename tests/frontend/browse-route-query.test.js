import { describe, expect, it } from "vitest";
import {
  buildBrowseRoute,
  parseBrowseRoute,
} from "../../lib/public/js/lib/browse-route.js";

// Fix wave F138: the hash router keeps the query out of `location`; the
// browse parser receives it separately so `?view=diff` / `?line=` deep links
// work again.
describe("frontend/lib browse-route query handling", () => {
  it("reads view/line/lineEnd from the router-supplied query when the location carries none", () => {
    const parsed = parseBrowseRoute({
      location: "/browse/skills/notes.md",
      query: "view=diff&line=12&lineEnd=20",
    });
    expect(parsed).toMatchObject({
      isBrowseRoute: true,
      selectedBrowsePath: "skills/notes.md",
      activeBrowsePath: "skills/notes.md",
      browseViewerMode: "diff",
      browseLineTarget: 12,
      browseLineEndTarget: 20,
    });
    // A leading "?" is tolerated.
    expect(parseBrowseRoute({ location: "/browse/a.md", query: "?view=diff" }).browseViewerMode).toBe("diff");
  });

  it("a query embedded in the location wins over the router query", () => {
    const parsed = parseBrowseRoute({
      location: "/browse/a.md?line=3",
      query: "view=diff&line=99",
    });
    expect(parsed.browseViewerMode).toBe("edit");
    expect(parsed.browseLineTarget).toBe(3);
  });

  it("ignores the query off the browse route and while a preview path is pinned", () => {
    const off = parseBrowseRoute({ location: "/doctor", query: "view=diff&line=4" });
    expect(off).toMatchObject({
      isBrowseRoute: false,
      selectedBrowsePath: "",
      browseViewerMode: "edit",
      browseLineTarget: 0,
    });
    const preview = parseBrowseRoute({
      location: "/browse/a.md",
      browsePreviewPath: "other/b.md",
      query: "view=diff",
    });
    expect(preview.activeBrowsePath).toBe("other/b.md");
    expect(preview.browseViewerMode).toBe("edit");
  });

  it("round-trips buildBrowseRoute output through the split path/query the router produces", () => {
    const route = buildBrowseRoute("skills/my notes.md", { view: "diff", line: 7 });
    expect(route).toBe("/browse/skills/my%20notes.md?view=diff&line=7");
    const [path, query] = route.split("?");
    const parsed = parseBrowseRoute({ location: path, query });
    expect(parsed.selectedBrowsePath).toBe("skills/my notes.md");
    expect(parsed.browseViewerMode).toBe("diff");
    expect(parsed.browseLineTarget).toBe(7);
  });
});
