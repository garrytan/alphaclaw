import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

// scripts/build-ui.mjs builds the secret drop page's bundle as its own entry;
// the route's shell (routes/secret-drop.js) loads it by name.
const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

describe("frontend/secret drop bundle", () => {
  it("is an entry of the UI build, under the name the page loads", () => {
    const script = read("scripts/build-ui.mjs");
    expect(script).toMatch(/path\.join\(publicRoot, "js", "secret-drop\.js"\)/);
    expect(script).toContain('entryNames: "[name].bundle"');
    expect(read("lib/server/routes/secret-drop.js")).toContain('src="/dist/secret-drop.bundle.js"');
  });

  it("bundles on its own and talks only to its link's routes", async () => {
    const result = await build({
      entryPoints: [path.join(root, "lib/public/js/secret-drop.js")],
      bundle: true,
      format: "esm",
      target: ["es2022"],
      write: false,
      logLevel: "silent",
    });
    expect(result.errors).toEqual([]);
    const code = result.outputFiles[0].text;
    expect(code).toContain("/status");
    expect(code).toContain('method: "POST"');
    expect(code).not.toMatch(/console\.(log|info|debug)\(/);
  });
});
