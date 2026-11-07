import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const css = fs.readFileSync(path.join(root, "lib/public/css/theme.css"), "utf8");
const tailwindConfig = require(path.join(root, "tailwind.config.cjs"));

const readBlocks = (selector) => {
  const vars = {};
  const pattern = new RegExp(`^${selector.replace(/[[\]"=]/g, "\\$&")} \\{([^}]*)\\}`, "gm");
  for (const match of css.matchAll(pattern)) {
    for (const decl of match[1].matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) vars[decl[1]] = decl[2].trim();
  }
  return vars;
};
const kDark = readBlocks(":root");
const kLight = { ...kDark, ...readBlocks('[data-theme="light"]') };

const resolve = (vars, value) => {
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  return ref ? resolve(vars, vars[ref[1]]) : value;
};
const parseColor = (value) => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1].split(",").map((part) => part.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  throw new Error(`unparsed colour ${value}`);
};
const over = (top, bottom) => top.slice(0, 3).map((c, i) => c * top[3] + bottom[i] * (1 - top[3])).concat(1);
const luminance = (rgb) => {
  const [r, g, b] = rgb.slice(0, 3).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const color = (vars, name) => parseColor(resolve(vars, vars[name]));
const surfaces = (vars) => {
  const content = color(vars, "--bg-content");
  return {
    bg: color(vars, "--bg"),
    sidebar: color(vars, "--bg-sidebar"),
    content,
    card: over(color(vars, "--panel-bg-contrast"), content),
  };
};
const kTones = ["ok", "warn", "bad", "accent", "neutral"];

describe("frontend/design tokens", () => {
  it("defines every tone, type, spacing, radius and layout token in the dark theme", () => {
    for (const tone of kTones) {
      for (const suffix of ["", "-bg", "-border"]) expect(kDark[`--tone-${tone}${suffix}`]).toBeTruthy();
    }
    for (const name of ["caption", "small", "copy", "heading", "stat", "title"]) {
      expect(kDark[`--font-size-${name}`]).toMatch(/^\d+px$/);
    }
    expect(["1", "2", "3", "4", "6", "8"].map((n) => kDark[`--space-${n}`])).toEqual([
      "4px", "8px", "12px", "16px", "24px", "32px",
    ]);
    expect([kDark["--radius-control"], kDark["--radius-card"]]).toEqual(["6px", "10px"]);
    expect(kDark["--layout-sidebar"]).toBe("248px");
    expect(kDark["--layout-content-max"]).toBe("1120px");
    expect(kDark["--layout-gutter"]).toBe("40px");
  });

  it("defines a focus ring at 3:1 or better on every surface in both themes", () => {
    for (const vars of [kDark, kLight]) {
      const ring = color(vars, "--focus-ring");
      for (const [name, surface] of Object.entries(surfaces(vars))) {
        expect(ratio(ring, surface), name).toBeGreaterThanOrEqual(3);
      }
    }
    expect(readBlocks('[data-theme="light"]')["--focus-ring"]).toBeTruthy();
  });

  it("draws the focus ring on buttons, links, tabs and inputs via :focus-visible", () => {
    const rule = /:is\(([^)]*)\):focus-visible[^{]*\{\s*outline: 2px solid var\(--focus-ring\);/.exec(css);
    expect(rule).toBeTruthy();
    for (const selector of ["a[href]", "button", '[role="tab"]', "input", "select", "textarea"]) {
      expect(rule[1]).toContain(selector);
    }
  });

  it("gives the light theme its own tone colours", () => {
    for (const tone of ["ok", "warn", "bad", "accent"]) {
      expect(readBlocks('[data-theme="light"]')[`--tone-${tone}`]).toBeTruthy();
    }
  });

  it("exposes accent and the tones to Tailwind so bg-accent is not a no-op", () => {
    const { colors, fontSize, borderRadius, maxWidth } = tailwindConfig.theme.extend;
    expect(colors.accent.DEFAULT).toBe("var(--accent)");
    for (const tone of kTones) {
      expect(colors.tone[tone]).toBe(`var(--tone-${tone})`);
      expect(colors.tone[`${tone}-bg`]).toBe(`var(--tone-${tone}-bg)`);
    }
    expect(Object.keys(fontSize)).toEqual(["caption", "small", "copy", "heading", "stat", "title"]);
    expect(borderRadius.card).toBe("var(--radius-card)");
    expect(maxWidth.content).toBe("var(--layout-content-max)");
  });

  for (const [theme, vars] of [["dark", kDark], ["light", kLight]]) {
    it(`keeps muted and dim text at 4.5:1 or more on every surface (${theme})`, () => {
      for (const token of ["--text", "--text-muted", "--text-dim"]) {
        for (const [surface, bg] of Object.entries(surfaces(vars))) {
          expect(ratio(color(vars, token), bg), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`keeps each tone foreground at 4.5:1 or more on its tint over a card (${theme})`, () => {
      const { card } = surfaces(vars);
      for (const tone of kTones) {
        const tint = over(color(vars, `--tone-${tone}-bg`), card);
        expect(ratio(color(vars, `--tone-${tone}`), tint), tone).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`keeps the accent at 4.5:1 or more on the page and on a card (${theme})`, () => {
      const { bg, card } = surfaces(vars);
      expect(ratio(color(vars, "--accent"), bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(color(vars, "--accent"), card)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("keeps the light theme's status foregrounds at 4.5:1 or more on a card and on their own tint", () => {
    const { card } = surfaces(kLight);
    for (const status of ["error", "warning", "success", "info"]) {
      const tint = over(color(kLight, `--status-${status}-bg`), card);
      for (const token of [`--status-${status}`, `--status-${status}-muted`]) {
        expect(ratio(color(kLight, token), card), `${token} on card`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(color(kLight, token), tint), `${token} on its tint`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("styles every ActionButton tone class in theme.css", () => {
    for (const cls of ["ac-btn-cyan", "ac-btn-secondary", "ac-btn-green", "ac-btn-danger", "ac-btn-ghost", "ac-btn-neutral", "ac-btn-warning"]) {
      expect(css).toMatch(new RegExp(`^\\.${cls} \\{`, "m"));
    }
  });
});
