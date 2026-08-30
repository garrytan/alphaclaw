import { describe, expect, it } from "vitest";
import { CronRunHistoryPanel } from "../../lib/public/js/components/cron-tab/cron-run-history-panel.js";

// Expected values are computed through the same Intl presets production uses
// (format.js dateStyle medium / timeStyle presets), so assertions stay locale-
// and timezone-agnostic in CI.
const kDateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const kDateTimeWithSeconds = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    if (typeof node.type === "function") {
      try {
        collectText(node.type(node.props || {}), out);
      } catch {}
    }
    collectText(node.props?.children, out);
  }
  return out;
};

const renderText = (props) => collectText(CronRunHistoryPanel(props)).join(" ");

// Fixed past instants (never "today" again), so the today-branch of
// formatLocaleDateTimeWithTodayTime can't make the assertions flaky.
const kRunTs = Date.UTC(2026, 0, 5, 10, 30, 42);
const kRangeStartTs = Date.UTC(2026, 0, 5, 10, 0, 0);
const kRangeEndTs = Date.UTC(2026, 0, 5, 11, 15, 0);

describe("frontend/cron-run-history-panel timestamps", () => {
  it("renders detail run rows with seconds (sub-minute runs must not render identically)", () => {
    const text = renderText({
      rows: [
        {
          type: "entry",
          entry: { jobId: "job-a", ts: kRunTs, status: "ok", durationMs: 1200 },
        },
      ],
      variant: "detail",
    });
    expect(text).toContain(kDateTimeWithSeconds.format(new Date(kRunTs)));
  });

  it("renders overview rows (titled and untitled) with the seconds-bearing stamp", () => {
    const text = renderText({
      rows: [
        {
          type: "entry",
          entry: { jobId: "job-a", jobName: "Nightly report", ts: kRunTs, status: "ok" },
        },
        {
          type: "entry",
          entry: { jobId: "job-b", ts: kRunTs, status: "error" },
        },
      ],
      variant: "overview",
    });
    const stamp = kDateTimeWithSeconds.format(new Date(kRunTs));
    expect(text).toContain("Nightly report");
    expect(text).toContain("job-b");
    // Both row shapes ride the same formatter.
    expect(text.split(stamp).length - 1).toBe(2);
  });

  it("labels collapsed groups with the elided locale range, not two raw stamps", () => {
    const text = renderText({
      rows: [
        {
          type: "collapsed-group",
          jobId: "job-a",
          jobName: "Nightly report",
          count: 3,
          oldestTs: kRangeStartTs,
          newestTs: kRangeEndTs,
          entries: [],
        },
      ],
    });
    expect(text).toContain(
      kDateTime.formatRange(new Date(kRangeStartTs), new Date(kRangeEndTs)),
    );
  });

  it("falls back to em-dash stamps for entries without a timestamp and shows emptyText for no rows", () => {
    const text = renderText({
      rows: [{ type: "entry", entry: { jobId: "job-a", status: "ok" } }],
      variant: "detail",
    });
    expect(text).toContain("—");
    expect(renderText({ rows: [], emptyText: "No runs found." })).toContain(
      "No runs found.",
    );
  });
});
