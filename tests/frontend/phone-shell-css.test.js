import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.resolve(__dirname, "../../lib/public/css/shell.css"), "utf8");

const ruleBody = (selectorPattern) => {
  const match = css.match(new RegExp(selectorPattern + "\\s*\\{([^}]*)\\}"));
  return match ? match[1] : null;
};

describe("frontend/phone shell CSS", () => {
  it("gives every control in the app shell a 40 px floor on phones", () => {
    const body = ruleBody(
      String.raw`\.app-shell\s*:is\(button, select, summary, \[role="button"\], \[role="tab"\], input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)\)`,
    );
    expect(body).toContain("min-height: 40px");
    expect(ruleBody(String.raw`\.app-shell :is\(button, \[role="button"\], \[role="tab"\]\)`)).toContain("min-width: 40px");
    expect(ruleBody(String.raw`\.app-shell label:has\(> input\[type="checkbox"\]\)`)).toContain("min-height: 40px");
  });

  it("hides the closed phone drawer from the tab order and the top bar keeps the only status chip", () => {
    expect(ruleBody(String.raw`\.app-sidebar:not\(\.mobile-open\)`)).toContain("visibility: hidden");
    expect(ruleBody(String.raw`\.app-sidebar \.sidebar-status`)).toContain("display: none");
  });
});
