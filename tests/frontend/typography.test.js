import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { SummaryStatCard } from "../../lib/public/js/components/summary-stat-card.js";

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const theme = read("lib/public/css/theme.css");
const shell = read("lib/public/css/shell.css");
const explorer = ["sidebar", "file-tree", "file-viewer"].map((file) => read("lib/public/css/" + file + ".css")).join("\n");
const tailwindConfig = require(path.join(root, "tailwind.config.cjs"));

const ruleBody = (css, selector) => {
  const match = new RegExp("^" + selector.replace(/[.[\]"=]/g, "\\$&") + " \\{([^}]*)\\}", "m").exec(css);
  expect(match, selector).not.toBeNull();
  return match[1];
};

const listJsFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });

describe("frontend/typography (ALPH-69 phase 1b)", () => {
  it("defines a sans and a mono family token", () => {
    expect(theme).toMatch(/--font-sans:\s*ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue",\s*"Noto Sans", Arial, sans-serif;/);
    expect(theme).toMatch(/--font-mono:\s*"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,\s*"Liberation Mono", monospace;/);
  });

  it("self-hosts the upright JetBrains Mono with no third-party font request", () => {
    for (const page of ["lib/public/setup.html", "lib/public/login.html"]) {
      const html = read(page);
      expect(html, page).not.toMatch(/fonts\.(googleapis|gstatic)\.com|rel="preconnect"/);
      expect(html.indexOf("./css/theme.css"), page).toBeGreaterThan(-1);
    }
    const faces = [...theme.matchAll(/@font-face \{([^}]*)\}/g)].map((m) => m[1]);
    expect(faces).toHaveLength(2);
    for (const face of faces) {
      expect(face).toContain('font-family: "JetBrains Mono";');
      expect(face).toContain("font-style: normal;");
      expect(face).toContain("font-display: swap;");
      expect(face).toMatch(/unicode-range:/);
    }
    expect(faces[0]).toContain('src: url("fonts/jetbrains-mono-latin-ext.woff2") format("woff2");');
    expect(faces[0]).toMatch(/unicode-range:\s*U\+0100-02BA/);
    expect(faces[1]).toContain('src: url("fonts/jetbrains-mono-latin.woff2") format("woff2");');
    expect(faces[1]).toMatch(/unicode-range:\s*U\+0000-00FF/);
    for (const [file, maxKb] of [["jetbrains-mono-latin.woff2", 40], ["jetbrains-mono-latin-ext.woff2", 16]]) {
      const bytes = fs.readFileSync(path.join(root, "lib/public/css/fonts", file));
      expect(bytes.subarray(0, 4).toString("latin1"), file).toBe("wOF2");
      expect(bytes.length / 1024, file).toBeLessThan(maxKb);
    }
    expect(read("lib/public/css/fonts/jetbrains-mono-OFL.txt")).toMatch(/SIL Open Font License, Version 1\.1/);
  });

  it("sets interface text in sans at the 13 px scale step", () => {
    const body = ruleBody(theme, "body");
    expect(body).toContain("font-family: var(--font-sans);");
    expect(body).toContain("font-size: var(--font-size-small);");
    expect(body).not.toMatch(/monospace/);
  });

  it("exposes font-sans and font-mono to Tailwind through the tokens", () => {
    const { fontFamily } = tailwindConfig.theme.extend;
    expect(fontFamily.sans).toEqual(["var(--font-sans)"]);
    expect(fontFamily.mono).toEqual(["var(--font-mono)"]);
  });

  it("names the mono face only in the token, so every data surface follows it", () => {
    for (const file of ["theme", "shell", "sidebar", "file-tree", "file-viewer", "cron", "agents"]) {
      const css = read("lib/public/css/" + file + ".css")
        .replace(/--font-mono:[^;]*;/, "")
        .replace(/@font-face \{[^}]*\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css, file).not.toMatch(/JetBrains Mono/);
    }
  });

  it("uses only type scale tokens for font sizes in theme.css and shell.css", () => {
    for (const [name, css] of [["theme", theme], ["shell", shell]]) {
      const sizes = [...css.matchAll(/(?<!-)font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
      expect(sizes.length, name).toBeGreaterThan(0);
      for (const size of sizes) {
        expect(size, name).toMatch(/^(var\(--font-size-(caption|small|copy|heading|stat|title)\)|max\(var\(--font-size-caption\), 0\.93em\)|inherit)$/);
      }
    }
  });

  it("sets inline data one scale step down, never under the caption size, and leaves code blocks alone", () => {
    expect(theme).toMatch(/^body code,\nbody kbd,\nbody samp \{\n  font-size: max\(var\(--font-size-caption\), 0\.93em\);\n\}/m);
    expect(ruleBody(theme, "body pre code")).toContain("font-size: inherit;");
  });

  it("sets the wordmark in mono and the sidebar group labels in sentence case", () => {
    expect(ruleBody(theme, ".ac-wordmark")).toContain("font-family: var(--font-mono);");
    const label = ruleBody(shell, ".sidebar-label");
    expect(label).toContain("font-size: var(--font-size-caption);");
    expect(label).toContain("font-weight: 600;");
    expect(label).toContain("color: var(--text-muted);");
    expect(label).not.toMatch(/uppercase|letter-spacing/);
    expect(read("lib/public/js/components/sidebar.js")).toContain('<span class="ac-wordmark"><span style="color: var(--accent)">alpha</span>claw</span>');
  });

  it("keeps the sidebar foot's version line inside the sidebar, in mono", () => {
    const version = ruleBody(shell, ".sidebar-version");
    expect(version).toContain("min-width: 0;");
    expect(version).toContain("overflow: hidden;");
    expect(version).toContain("font-family: var(--font-mono);");
    expect(version).toContain("font-size: var(--font-size-caption);");
  });

  it("keeps the file tree, the editor and git hashes and paths in mono", () => {
    for (const selector of [".file-tree", ".file-viewer-editor", ".file-viewer-editor-highlight", ".frontmatter-key", ".sidebar-git-change-path", ".sidebar-git-hash"]) {
      expect(ruleBody(explorer, selector), selector).toContain("font-family: var(--font-mono);");
    }
  });

  it("leaves no off-scale arbitrary font sizes in Setup UI components outside chat and relay", () => {
    const offenders = listJsFiles(path.join(root, "lib/public/js"))
      .filter((file) => !/components[\\/](chat|relay-tab)[\\/]/.test(file))
      .flatMap((file) =>
        [...fs.readFileSync(file, "utf8").matchAll(/\btext-(\[\d+px\]|lg|2xl)(?![\w-])/g)].map(
          (m) => path.relative(root, file) + ": " + m[0],
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("sets a raw model ref in mono and a friendly model name in sans", () => {
    for (const file of ["lib/public/js/components/models-tab/index.js", "lib/public/js/components/agents-tab/agent-overview/model-card.js"]) {
      expect(read(file), file).toMatch(/label === entry\.key \? " font-mono" : ""/);
    }
  });

  it("renders SummaryStatCard values on the stat step and in mono when asked", () => {
    const valueClass = (props) => SummaryStatCard(props).props.children[1].props.class;
    expect(valueClass({ value: "3" })).toContain("text-stat");
    expect(valueClass({ value: "3" })).toContain("tabular-nums");
    expect(valueClass({ value: "0 */6 * * *", monospace: true })).toContain("font-mono");
    expect(valueClass({ value: "3" })).not.toContain("font-mono");
  });
});
