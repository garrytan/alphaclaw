const {
  jsStringLiteral,
  htmlText,
} = require("../../lib/server/routes/oauth-callback-html");

describe("routes/oauth-callback-html", () => {
  describe("jsStringLiteral", () => {
    it("returns a quoted JS string literal", () => {
      expect(jsStringLiteral("hello")).toBe('"hello"');
    });

    it("neutralizes a </script> breakout", () => {
      const out = jsStringLiteral("</script><img src=x onerror=alert(1)>");
      expect(out).not.toContain("</script>");
      expect(out).toContain("\\u003c");
      expect(out).toContain("\\u003e");
    });

    it("escapes the U+2028/U+2029 line separators", () => {
      const out = jsStringLiteral("a b c");
      expect(out).toContain("\\u2028");
      expect(out).toContain("\\u2029");
    });

    it("handles null/undefined as an empty string literal", () => {
      expect(jsStringLiteral(undefined)).toBe('""');
      expect(jsStringLiteral(null)).toBe('""');
    });
  });

  describe("htmlText", () => {
    it("escapes angle brackets, ampersands, and quotes", () => {
      expect(htmlText('<img src="x" onerror=\'y\'>&')).toBe(
        "&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;",
      );
    });
  });
});
