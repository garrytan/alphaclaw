const {
  renderTelegramHtml,
  renderHouseLinks,
  escapeTelegramHtml,
  validateTelegramHtml,
} = require("../../lib/server/utils/telegram-html");

// The house format (AGENTS.md "Telegram Notice Format") rendered to Telegram
// HTML at the transport. Every literal is escaped, so no runtime value can
// break the markup — the #54 failure mode under parse_mode=Markdown.
describe("utils/telegram-html", () => {
  describe("escapeTelegramHtml", () => {
    it("escapes exactly & < > and leaves everything else (quotes, emoji, unicode) alone", () => {
      expect(escapeTelegramHtml('a & b < c > d "q" \'s\' 🐺 é')).toBe(
        'a &amp; b &lt; c &gt; d "q" \'s\' 🐺 é',
      );
      expect(escapeTelegramHtml("")).toBe("");
      expect(escapeTelegramHtml(null)).toBe("");
      expect(escapeTelegramHtml(undefined)).toBe("");
      expect(escapeTelegramHtml(42)).toBe("42");
    });
  });

  describe("renderTelegramHtml", () => {
    it("returns the untouched input as plain alongside the html", () => {
      const text = "🐺 *AlphaClaw Watchdog*\nTrigger: `crash_loop`";
      expect(renderTelegramHtml(text).plain).toBe(text);
      expect(renderTelegramHtml("").plain).toBe("");
      expect(renderTelegramHtml(null)).toEqual({ html: "", plain: "" });
    });

    it("renders the canonical watchdog notice — bold header, link, code value", () => {
      const text =
        "🐺 *AlphaClaw Watchdog*\n🔴 Crash loop detected - [View logs](https://claw.example.com/#/watchdog)\nTrigger: `crash_loop`\nAttempt count: 3";
      expect(renderTelegramHtml(text).html).toBe(
        '🐺 <b>AlphaClaw Watchdog</b>\n🔴 Crash loop detected - <a href="https://claw.example.com/#/watchdog">View logs</a>\nTrigger: <code>crash_loop</code>\nAttempt count: 3',
      );
    });

    it("escapes & < > in every literal run — plain text, bold content, code content, link labels", () => {
      expect(renderTelegramHtml("a & b <c>").html).toBe("a &amp; b &lt;c&gt;");
      expect(renderTelegramHtml("*a & b <c>*").html).toBe("<b>a &amp; b &lt;c&gt;</b>");
      expect(renderTelegramHtml("`a & b <c>`").html).toBe("<code>a &amp; b &lt;c&gt;</code>");
      expect(renderTelegramHtml("[a & b <c>](https://x.y)").html).toBe(
        '<a href="https://x.y">a &amp; b &lt;c&gt;</a>',
      );
    });

    it("a runtime value containing markup is escaped, never interpreted (<script>, stray tags)", () => {
      const html = renderTelegramHtml(
        'Error: <script>alert("x")</script> and <b>not bold</b> & <a href="https://evil">no</a>',
      ).html;
      expect(html).toBe(
        'Error: &lt;script&gt;alert("x")&lt;/script&gt; and &lt;b&gt;not bold&lt;/b&gt; &amp; &lt;a href="https://evil"&gt;no&lt;/a&gt;',
      );
      expect(html).not.toContain("<script");
      expect(validateTelegramHtml(html)).toBe(true);
    });

    it("the #54 message (underscores, slashes, dots in a value) renders without a parse hazard", () => {
      const text =
        "🔴 Backup failed - `SQLite transaction lock wait failed` → lease migration.legacy-audit/filesystem-sqlite-boundary was lost (attempt_1 of 2_000)";
      expect(renderTelegramHtml(text).html).toBe(
        "🔴 Backup failed - <code>SQLite transaction lock wait failed</code> → lease migration.legacy-audit/filesystem-sqlite-boundary was lost (attempt_1 of 2_000)",
      );
    });

    describe("bold", () => {
      it("*…* becomes <b>…</b>, non-greedy, several per line", () => {
        expect(renderTelegramHtml("*a* and *b*").html).toBe("<b>a</b> and <b>b</b>");
      });

      it("an unpaired * stays literal", () => {
        expect(renderTelegramHtml("5 * 3 = 15").html).toBe("5 * 3 = 15");
        expect(renderTelegramHtml("*unterminated").html).toBe("*unterminated");
        expect(renderTelegramHtml("*a*b*").html).toBe("<b>a</b>b*");
      });

      it("bold is single-line: a * pair spanning a newline stays literal", () => {
        expect(renderTelegramHtml("*line one\nline two*").html).toBe("*line one\nline two*");
      });

      it("empty ** is literal", () => {
        expect(renderTelegramHtml("a ** b").html).toBe("a ** b");
      });

      it("a link nests inside bold", () => {
        expect(renderTelegramHtml("*see [logs](https://x.y/#/w) now*").html).toBe(
          '<b>see <a href="https://x.y/#/w">logs</a> now</b>',
        );
      });

      // Adversarial review P3 (11): the #54 headline `*Backup failed - `SQLite
      // lock` (attempt 1)*` used to degrade to literal asterisks because the
      // bold pass ran per text segment. Telegram allows <b> to contain <code>.
      describe("bold spanning a code span", () => {
        it("pairs * markers across a code span — <b>…<code>…</code>…</b>", () => {
          const { html } = renderTelegramHtml("*Backup failed - `SQLite lock` (attempt 1)*");
          expect(html).toBe("<b>Backup failed - <code>SQLite lock</code> (attempt 1)</b>");
          expect(validateTelegramHtml(html)).toBe(true);
        });

        it("several code spans and a link inside one bold span", () => {
          expect(
            renderTelegramHtml("*`a` and `b` - [logs](https://x.y)*").html,
          ).toBe('<b><code>a</code> and <code>b</code> - <a href="https://x.y">logs</a></b>');
        });

        it("a * inside the code span stays a literal code character, never a marker", () => {
          expect(renderTelegramHtml("*a `b*c` d*").html).toBe("<b>a <code>b*c</code> d</b>");
          expect(renderTelegramHtml("x `5 * 3` y").html).toBe("x <code>5 * 3</code> y");
          // The only * outside the code span is unpaired → literal.
          expect(renderTelegramHtml("*a `b*c` d").html).toBe("*a <code>b*c</code> d");
        });

        it("an unbalanced * next to a code span stays literal and the code still renders", () => {
          expect(renderTelegramHtml("*Backup failed - `lock`").html).toBe(
            "*Backup failed - <code>lock</code>",
          );
          expect(renderTelegramHtml("Backup failed - `lock`*").html).toBe(
            "Backup failed - <code>lock</code>*",
          );
          expect(renderTelegramHtml("**`x`*").html).toBe("*<b><code>x</code></b>");
        });

        it("a bold pair never spans a newline even with a code span between", () => {
          expect(renderTelegramHtml("*a `b`\nc*").html).toBe("*a <code>b</code>\nc*");
        });

        it("code points (emoji) inside bold are never split", () => {
          expect(renderTelegramHtml("*🐺 AlphaClaw `x` 🔴*").html).toBe(
            "<b>🐺 AlphaClaw <code>x</code> 🔴</b>",
          );
        });
      });
    });

    describe("code spans", () => {
      it("`…` becomes <code>…</code> with the contents protected from bold and link parsing", () => {
        expect(renderTelegramHtml("Trigger: `crash_loop`").html).toBe(
          "Trigger: <code>crash_loop</code>",
        );
        expect(renderTelegramHtml("`*not bold* [not](https://a.link)`").html).toBe(
          "<code>*not bold* [not](https://a.link)</code>",
        );
      });

      it("a * inside a code span is opaque to the bold pass (the outer pair still renders)", () => {
        // Pin moved by P3 (11): bold now pairs ACROSS the code span; the
        // protected `*` inside it stays literal either way.
        expect(renderTelegramHtml("*a `b*c` d*").html).toBe(
          "<b>a <code>b*c</code> d</b>",
        );
        expect(renderTelegramHtml("`a*` b `*c`").html).toBe(
          "<code>a*</code> b <code>*c</code>",
        );
      });

      it("an unpaired or empty backtick stays literal; code spans do not cross lines", () => {
        expect(renderTelegramHtml("a ` b").html).toBe("a ` b");
        expect(renderTelegramHtml("a `` b").html).toBe("a `` b");
        expect(renderTelegramHtml("`multi\nline`").html).toBe("`multi\nline`");
      });
    });

    describe("links", () => {
      it("[label](url) becomes <a href> for http and https URLs only", () => {
        expect(renderTelegramHtml("[View logs](https://claw.example/#/watchdog)").html).toBe(
          '<a href="https://claw.example/#/watchdog">View logs</a>',
        );
        expect(renderTelegramHtml("[local](http://localhost:3000/#/watchdog)").html).toBe(
          '<a href="http://localhost:3000/#/watchdog">local</a>',
        );
        expect(renderTelegramHtml("[X](HTTPS://UPPER.CASE)").html).toBe(
          '<a href="HTTPS://UPPER.CASE">X</a>',
        );
      });

      it.each([
        "javascript:alert(1)",
        "ftp://files.example/x",
        "tg://resolve?domain=x",
        "//protocol-relative.example",
        "mailto:a@b.c",
        "relative/path",
      ])("a non-http(s) target (%s) is emitted as 'label (url)' text, never a link", (url) => {
        const html = renderTelegramHtml(`[label](${url})`).html;
        expect(html).toBe(escapeTelegramHtml(`label (${url})`));
        expect(html).not.toContain("<a");
      });

      it("escapes & < > and quotes inside the href", () => {
        expect(
          renderTelegramHtml('[q](https://x.y/?a=1&b=<2>&c="q")').html,
        ).toBe('<a href="https://x.y/?a=1&amp;b=&lt;2&gt;&amp;c=&quot;q&quot;">q</a>');
      });

      it("a malformed link (missing paren, whitespace in url, newline in label) stays literal text", () => {
        expect(renderTelegramHtml("[label](https://x.y").html).toBe("[label](https://x.y");
        expect(renderTelegramHtml("[label](https://x.y/a b)").html).toBe(
          "[label](https://x.y/a b)",
        );
        expect(renderTelegramHtml("[la\nbel](https://x.y)").html).toBe("[la\nbel](https://x.y)");
        expect(renderTelegramHtml("[](https://x.y)").html).toBe("[](https://x.y)");
      });

      // Adversarial review P3 (10): the url used to end at the FIRST `)`.
      describe("parentheses in the url", () => {
        it("balanced parentheses inside the url are part of the link", () => {
          expect(
            renderTelegramHtml("[X](https://a.b/c_(paren)_d)").html,
          ).toBe('<a href="https://a.b/c_(paren)_d">X</a>');
          expect(
            renderTelegramHtml("[q](https://a.b/?f=(1)&g=(2))").html,
          ).toBe('<a href="https://a.b/?f=(1)&amp;g=(2)">q</a>');
        });

        it("a `)` after the link stays text — the link closes at its own paren", () => {
          expect(renderTelegramHtml("(see [X](https://a.b/c))").html).toBe(
            '(see <a href="https://a.b/c">X</a>)',
          );
          expect(renderTelegramHtml("(see [X](https://a.b/c_(p)))").html).toBe(
            '(see <a href="https://a.b/c_(p)">X</a>)',
          );
        });

        it("an unbalanced `(` inside the url is not a link", () => {
          expect(renderTelegramHtml("[X](https://a.b/c_(p)").html).toBe("[X](https://a.b/c_(p)");
        });
      });
    });

    // The link grammar is exported for the Slack renderer (watchdog-notify's
    // formatSlackMessage) so both transports parse the same house link.
    describe("renderHouseLinks (shared link parser)", () => {
      const collect = (text) => {
        const runs = [];
        const links = [];
        renderHouseLinks(text, {
          text: (run) => {
            runs.push(run);
            return "";
          },
          link: (link) => {
            links.push(link);
            return "";
          },
        });
        return { runs, links };
      };

      it("hands every literal run and every link (with http verdict and raw source) to the callbacks", () => {
        const { runs, links } = collect(
          "a [X](https://a.b/c_(p)) b [Y](ftp://z) c",
        );
        expect(runs).toEqual(["a ", " b ", " c"]);
        expect(links).toEqual([
          { label: "X", url: "https://a.b/c_(p)", http: true, raw: "[X](https://a.b/c_(p))" },
          { label: "Y", url: "ftp://z", http: false, raw: "[Y](ftp://z)" },
        ]);
      });

      it("concatenates the callback results in source order", () => {
        expect(
          renderHouseLinks("a [X](https://x.y) b", {
            text: (run) => run.toUpperCase(),
            link: ({ label, url }) => `{${label}→${url}}`,
          }),
        ).toBe("A {X→https://x.y} B");
        expect(renderHouseLinks(null, { text: (run) => run, link: () => "L" })).toBe("");
      });
    });

    describe("validator fallback", () => {
      it("every rendered construct passes the validator", () => {
        const text =
          "🐺 *AlphaClaw Watchdog*\n🔴 X - [View logs](https://a.b/#/w)\nTrigger: `a_b`\n*bold [link](https://c.d) inside* & <raw>";
        const { html } = renderTelegramHtml(text);
        expect(html).not.toBeNull();
        expect(validateTelegramHtml(html)).toBe(true);
      });

      it("a render the validator rejects comes back as { html:null, plain:text } — plain text is sent instead", () => {
        const text = "*bold* and `code`";
        const validate = vi.fn(() => false);
        expect(renderTelegramHtml(text, { validate })).toEqual({ html: null, plain: text });
        expect(validate).toHaveBeenCalledWith("<b>bold</b> and <code>code</code>");
      });
    });
  });

  describe("validateTelegramHtml (stack-based well-formedness)", () => {
    it("accepts properly nested b/code/a and plain escaped text", () => {
      expect(validateTelegramHtml("")).toBe(true);
      expect(validateTelegramHtml("plain &amp; escaped &lt;x&gt;")).toBe(true);
      expect(validateTelegramHtml("<b>x</b><code>y</code>")).toBe(true);
      expect(validateTelegramHtml('<b>a <a href="https://x.y">b</a> c</b>')).toBe(true);
      expect(validateTelegramHtml('<a href="https://x.y"><b>b</b></a>')).toBe(true);
    });

    it("accepts <code> nested inside <b> (what the bold-over-code render emits)", () => {
      expect(validateTelegramHtml("<b>a <code>b</code> c</b>")).toBe(true);
      expect(validateTelegramHtml("<b><code>a</code> <code>b</code></b>")).toBe(true);
    });

    it("rejects overlapping / mis-nested tags", () => {
      expect(validateTelegramHtml("<b><code>x</b></code>")).toBe(false);
      expect(validateTelegramHtml("<code><b>x</code></b>")).toBe(false);
      expect(validateTelegramHtml('<a href="https://x"><b>y</a></b>')).toBe(false);
    });

    it("rejects unclosed and unopened tags", () => {
      expect(validateTelegramHtml("<b>x")).toBe(false);
      expect(validateTelegramHtml("x</b>")).toBe(false);
      expect(validateTelegramHtml("<b><b>x</b>")).toBe(false);
    });

    it("rejects tags outside the b/code/a allowlist and malformed attributes", () => {
      expect(validateTelegramHtml("<i>x</i>")).toBe(false);
      expect(validateTelegramHtml("<script>x</script>")).toBe(false);
      expect(validateTelegramHtml("<a>x</a>")).toBe(false);
      expect(validateTelegramHtml('<a onclick="x" href="https://y">x</a>')).toBe(false);
      expect(validateTelegramHtml('<b class="x">x</b>')).toBe(false);
      expect(validateTelegramHtml('<b>x</b href="y">')).toBe(false);
    });

    it("rejects a stray angle bracket outside a tag (an unescaped literal)", () => {
      expect(validateTelegramHtml("a < b")).toBe(false);
      expect(validateTelegramHtml("a > b")).toBe(false);
      expect(validateTelegramHtml("<b>a < b</b>")).toBe(false);
      expect(validateTelegramHtml("<b>a</b> > c")).toBe(false);
    });

    it("rejects non-string input", () => {
      expect(validateTelegramHtml(null)).toBe(false);
      expect(validateTelegramHtml(undefined)).toBe(false);
      expect(validateTelegramHtml(42)).toBe(false);
    });
  });
});
