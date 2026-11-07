import { describe, expect, it } from "vitest";
import {
  formatWarningsAttentionText,
  getWarningsAttentionTone,
} from "../../lib/public/js/components/cron-tab/cron-overview.js";

describe("frontend/cron-overview attention line", () => {
  it("uses body text, not the warning tone, when nothing needs attention", () => {
    expect(formatWarningsAttentionText([])).toBe("No warnings currently need your attention");
    expect(getWarningsAttentionTone([])).toBe("text-body");
    expect(getWarningsAttentionTone([{ tone: "info" }])).toBe("text-body");
  });

  it("uses the warning tone when a warning or error is present", () => {
    expect(getWarningsAttentionTone([{ tone: "warning" }])).toBe("text-status-warning");
    expect(getWarningsAttentionTone([{ tone: "error" }])).toBe("text-status-warning");
    expect(formatWarningsAttentionText([{ tone: "error" }, { tone: "warning" }])).toBe(
      "1 error and 1 warning may need your attention",
    );
  });
});
