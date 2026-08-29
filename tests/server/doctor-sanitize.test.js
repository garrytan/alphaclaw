const {
  createDoctorTextSanitizer,
} = require("../../lib/server/doctor/sanitize");

describe("server/doctor/sanitize", () => {
  it("redacts secret-shaped env values from card text", () => {
    const { sanitize } = createDoctorTextSanitizer({
      env: {
        MY_API_TOKEN: "supersecretvalue",
        // Non-secret-shaped key: its value must NOT be scrubbed.
        HOSTNAME: "plainhostvalue",
      },
    });
    expect(sanitize("leaked supersecretvalue in a skill description")).toBe(
      "leaked [redacted] in a skill description",
    );
    expect(sanitize("mentions plainhostvalue")).toBe("mentions plainhostvalue");
  });

  it("redacts injected extra secret values", () => {
    const { sanitize } = createDoctorTextSanitizer({
      env: {},
      extraValues: ["extra-secret-value"],
    });
    expect(sanitize("before extra-secret-value after")).toBe(
      "before [redacted] after",
    );
  });

  it("strips control characters to spaces and trims, keeping tabs/newlines", () => {
    const { sanitize } = createDoctorTextSanitizer({ env: {} });
    expect(sanitize("  a\u0000b\u0007c\u001bd  ")).toBe("a b c d");
    // \t and \n are outside the stripped ranges by design.
    expect(sanitize("a\tb\nc")).toBe("a\tb\nc");
    expect(sanitize(null)).toBe("");
    expect(sanitize(undefined)).toBe("");
  });

  it("caps length with an ellipsis inside the budget", () => {
    const { sanitize } = createDoctorTextSanitizer({ env: {} });
    const capped = sanitize("abcdefgh", { maxChars: 4 });
    expect(capped).toBe("abc…");
    expect(capped.length).toBe(4);
    // Under the cap: untouched.
    expect(sanitize("abc", { maxChars: 4 })).toBe("abc");
    // maxChars 0 (default) means no cap.
    expect(sanitize("abcdefgh")).toBe("abcdefgh");
  });

  it("escapes Telegram-markdown metacharacters for notification lines only", () => {
    const { escapeMarkdown } = createDoctorTextSanitizer({ env: {} });
    expect(escapeMarkdown("a_b*c[d]e`f")).toBe("a\\_b\\*c\\[d\\]e\\`f");
    expect(escapeMarkdown(null)).toBe("");
  });

  it("singleLine collapses newlines/tabs/CRs into one space", () => {
    const { sanitize } = createDoctorTextSanitizer({ env: {} });
    // A run of line-breaking characters collapses to a SINGLE space, so an
    // injected title cannot forge extra lines inside a notification frame.
    expect(sanitize("forged title\n- fake finding\ttail", { singleLine: true })).toBe(
      "forged title - fake finding tail",
    );
    expect(sanitize("a\r\n\tb", { singleLine: true })).toBe("a b");
    expect(sanitize("x\n\n\ny", { singleLine: true })).toBe("x y");
    // Default behavior is unchanged: tab/newline pass through.
    expect(sanitize("a\tb\nc")).toBe("a\tb\nc");
  });

  it("strips C1 controls (including NEL) in every mode", () => {
    const { sanitize } = createDoctorTextSanitizer({ env: {} });
    // U+0080, U+0085 (NEL), U+009C: C1 controls render as line breaks or
    // hidden characters in some clients - stripped to spaces like C0.
    expect(sanitize("a\u0080b\u0085c\u009Cd")).toBe("a b c d");
    expect(sanitize("a\u0085b", { singleLine: true })).toBe("a b");
  });

  it("singleLine collapses Unicode line separators (U+2028/U+2029/NEL)", () => {
    const { sanitize } = createDoctorTextSanitizer({ env: {} });
    // Telegram renders U+2028 as a newline: a forged title must not smuggle
    // extra lines into a notification through the Unicode separators.
    expect(
      sanitize("forged\u2028- fake finding\u2029tail", { singleLine: true }),
    ).toBe("forged - fake finding tail");
    // Mixed runs (ASCII + Unicode separators) collapse to a SINGLE space.
    expect(sanitize("x\n\u2028\u0085\u2029y", { singleLine: true })).toBe("x y");
  });

  it("singleLine collapses before the cap so the budget counts the final text", () => {
    const { sanitize } = createDoctorTextSanitizer({ env: {} });
    const capped = sanitize("line1\nline2", { maxChars: 8, singleLine: true });
    expect(capped).toBe("line1 l…");
    expect(capped).not.toContain("\n");
  });

  it("never splits a surrogate pair at the cap", () => {
    const { sanitize } = createDoctorTextSanitizer({ env: {} });
    // "ab😀x" is 5 UTF-16 units (a, b, high, low, x); maxChars 4 keeps 3
    // units, landing exactly on the high surrogate — it must be dropped, not
    // emitted as a lone surrogate before the ellipsis.
    const capped = sanitize("ab\u{1F600}x", { maxChars: 4 });
    expect(capped).toBe("ab…");
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(capped)).toBe(false);
    // A pair that fits entirely inside the cap is kept intact.
    expect(sanitize("ab\u{1F600}xyz", { maxChars: 6 })).toBe("ab\u{1F600}x…");
    // Under the cap: untouched, pair intact.
    expect(sanitize("ab\u{1F600}", { maxChars: 4 })).toBe("ab\u{1F600}");
  });

  it("redacts before capping so a truncated secret cannot leak its prefix", () => {
    const { sanitize } = createDoctorTextSanitizer({
      env: { LEAKY_SECRET: "supersecretvalue" },
    });
    const capped = sanitize("supersecretvalue trailing", { maxChars: 12 });
    expect(capped).not.toContain("supersecret");
    expect(capped.startsWith("[redacted]")).toBe(true);
  });
});
