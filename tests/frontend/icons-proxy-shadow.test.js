import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DiscordIcon,
  GoogleIcon,
  SlackIcon,
  TelegramIcon,
  WhatsAppIcon,
} from "../../lib/public/js/components/icons.js";

// ISSUE-004: the gateway proxy forwards ALL /assets/* requests to the
// OpenClaw gateway (lib/server/routes/proxy.js kAssetsPathPattern), so
// AlphaClaw's own lib/public/assets/ files are unreachable from the UI — any
// "/assets/..." reference 404s in every gateway state. Reusable SVG icons
// must be shared components in components/icons.js instead (AGENTS.md).

const kPublicJsRoot = path.resolve(__dirname, "../../lib/public/js");

const listJsFiles = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listJsFiles(entryPath, out);
    } else if (entry.name.endsWith(".js")) {
      out.push(entryPath);
    }
  }
  return out;
};

describe("frontend/icons proxy-shadowed assets (ISSUE-004)", () => {
  it("exports the brand icons as components that render inline SVG", () => {
    const icons = [
      DiscordIcon,
      GoogleIcon,
      SlackIcon,
      TelegramIcon,
      WhatsAppIcon,
    ];
    for (const icon of icons) {
      expect(typeof icon).toBe("function");
      const vnode = icon({ className: "w-4 h-4" });
      expect(vnode.type).toBe("svg");
      expect(vnode.props.class).toBe("w-4 h-4");
    }
  });

  it("no frontend source references a proxy-shadowed /assets/ URL", () => {
    const offenders = [];
    for (const file of listJsFiles(kPublicJsRoot)) {
      const source = readFileSync(file, "utf8");
      if (/["'`]\/assets\//.test(source)) {
        offenders.push(path.relative(kPublicJsRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
