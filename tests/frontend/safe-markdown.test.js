const load = () => import("../../lib/public/js/lib/safe-markdown.js");

describe("frontend/safe-markdown (XSS guard for external release notes)", () => {
  it("renders plain markdown structure", async () => {
    const { renderMarkdownSafe } = await load();
    const html = renderMarkdownSafe("## Heading\n\n- item **bold**\n");
    expect(html).toContain("<h2");
    expect(html).toContain("<li>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("escapes raw HTML blocks and inline HTML (script tags, event handlers)", async () => {
    const { renderMarkdownSafe } = await load();
    const html = renderMarkdownSafe(
      '<script>alert(1)</script>\n\ntext <img src=x onerror="alert(2)"> more',
    );
    // No live tags survive — everything is escaped text.
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).not.toContain('onerror="alert');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("drops javascript: and data: links, keeps https links", async () => {
    const { renderMarkdownSafe } = await load();
    const html = renderMarkdownSafe(
      "[bad](javascript:alert(1)) [data](data:text/html,x) [good](https://example.com)",
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noreferrer"');
    // Unsafe link text still renders as plain text.
    expect(html).toContain("bad");
  });

  it("drops unsafe image sources, keeps https images with escaped alt", async () => {
    const { renderMarkdownSafe } = await load();
    const html = renderMarkdownSafe(
      '![x](javascript:alert(1)) ![ok "quote"](https://example.com/a.png)',
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain("&quot;quote&quot;");
  });

  it("tolerates null/empty input", async () => {
    const { renderMarkdownSafe } = await load();
    expect(renderMarkdownSafe(null)).toBe("");
    expect(renderMarkdownSafe("")).toBe("");
  });
});
