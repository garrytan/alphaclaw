import { describe, expect, it } from "vitest";
import { ChannelAccountStatusBadge } from "../../lib/public/js/components/channel-account-status-badge.js";
import { TooltipBadge } from "../../lib/public/js/components/tooltip-badge.js";

describe("frontend/channel account status badge", () => {
  it.each(["pending", "configured", ""])(
    "non-paired status %j renders the self-standing warning badge",
    (status) => {
      const vnode = ChannelAccountStatusBadge({ status });
      expect(vnode.type).toBe(TooltipBadge);
      expect(vnode.props.tone).toBe("warning");
      expect(vnode.props.label).toBe("Pairing incomplete");
      expect(vnode.props.text).toContain("pairing");
    },
  );
});
