import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  fetchUsageSessionDetail,
  fetchUsageSessions,
  fetchUsageSummary,
} from "../../lib/api.js";
import {
  formatChartBucketLabel,
  formatInteger,
  formatUsd,
} from "../../lib/format.js";
import { readUiSettings, writeUiSettings } from "../../lib/ui-settings.js";
import {
  kDefaultUsageBreakdown,
  kDefaultUsageDays,
  kDefaultUsageMetric,
  kUsageBreakdownUiSettingKey,
  kUsageDaysUiSettingKey,
  kUsageMetricUiSettingKey,
} from "./constants.js";
import { renderBreakdownLabel, toChartColor } from "./formatters.js";
import { buildPeriodSummary } from "./strip-model.js";
import { useChartJs } from "../../hooks/use-chart-js.js";

export const useUsageTab = ({ sessionId = "" }) => {
  const [days, setDays] = useState(() => {
    const settings = readUiSettings();
    const parsedDays = Number.parseInt(
      String(settings[kUsageDaysUiSettingKey] ?? ""),
      10,
    );
    return [7, 30, 90].includes(parsedDays) ? parsedDays : kDefaultUsageDays;
  });
  const [metric, setMetric] = useState(() => {
    const settings = readUiSettings();
    return settings[kUsageMetricUiSettingKey] === "cost"
      ? "cost"
      : kDefaultUsageMetric;
  });
  const [breakdown, setBreakdown] = useState(() => {
    const settings = readUiSettings();
    const configured = String(settings[kUsageBreakdownUiSettingKey] || "").trim();
    return configured === "source" || configured === "agent"
      ? configured
      : kDefaultUsageBreakdown;
  });
  const [summary, setSummary] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [sessionDetailById, setSessionDetailById] = useState({});
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingDetailById, setLoadingDetailById] = useState({});
  const [expandedSessionIds, setExpandedSessionIds] = useState(() =>
    sessionId ? [String(sessionId)] : [],
  );
  const [error, setError] = useState("");
  // Section-scoped failures: the summary sections show their own error in
  // place of the previous numbers; the sessions table keeps its own.
  const [summaryError, setSummaryError] = useState(null);
  const [sessionsError, setSessionsError] = useState(null);
  const Chart = useChartJs();
  const overviewCanvasRef = useRef(null);
  const overviewChartRef = useRef(null);
  // Latest-request-wins: a slow response for the previous range must not
  // overwrite the summary of the range the user switched to.
  const summaryRequestIdRef = useRef(0);

  const loadSummary = useCallback(async () => {
    const requestId = ++summaryRequestIdRef.current;
    setLoadingSummary(true);
    setError("");
    setSummaryError(null);
    try {
      const data = await fetchUsageSummary(days);
      if (summaryRequestIdRef.current !== requestId) return;
      setSummary(data.summary || null);
    } catch (err) {
      if (summaryRequestIdRef.current !== requestId) return;
      setSummaryError(err);
      setError(err.message || "Could not load usage summary");
    } finally {
      if (summaryRequestIdRef.current === requestId) {
        setLoadingSummary(false);
      }
    }
  }, [days]);

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    setSessionsError(null);
    try {
      const data = await fetchUsageSessions(100);
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch (err) {
      setSessionsError(err);
      setError(err.message || "Could not load sessions");
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  const loadSessionDetail = useCallback(async (selectedSessionId) => {
    const safeSessionId = String(selectedSessionId || "").trim();
    if (!safeSessionId) return;
    setLoadingDetailById((currentValue) => ({
      ...currentValue,
      [safeSessionId]: true,
    }));
    try {
      const detailPayload = await fetchUsageSessionDetail(safeSessionId);
      setSessionDetailById((currentValue) => ({
        ...currentValue,
        [safeSessionId]: detailPayload.detail || null,
      }));
    } catch (err) {
      // Terminal-outcome sentinel: the deep-link guard below must be able to
      // tell "failed" from "never attempted", or it refires every render.
      setSessionDetailById((currentValue) => ({
        ...currentValue,
        [safeSessionId]: {
          status: "error",
          message: err.message || "Could not load session detail",
        },
      }));
      setError(err.message || "Could not load session detail");
    } finally {
      setLoadingDetailById((currentValue) => ({
        ...currentValue,
        [safeSessionId]: false,
      }));
    }
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    const settings = readUiSettings();
    settings[kUsageDaysUiSettingKey] = days;
    settings[kUsageMetricUiSettingKey] = metric;
    settings[kUsageBreakdownUiSettingKey] = breakdown;
    writeUiSettings(settings);
  }, [days, metric, breakdown]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    const safeSessionId = String(sessionId || "").trim();
    if (!safeSessionId) return;
    setExpandedSessionIds((currentValue) =>
      currentValue.includes(safeSessionId)
        ? currentValue
        : [...currentValue, safeSessionId],
    );
    // undefined = never attempted; null / {status:"error"} are terminal
    // outcomes that must not re-trigger the deep-link fetch.
    if (
      sessionDetailById[safeSessionId] === undefined &&
      !loadingDetailById[safeSessionId]
    ) {
      loadSessionDetail(safeSessionId);
    }
  }, [sessionId, sessionDetailById, loadingDetailById, loadSessionDetail]);

  const periodSummary = useMemo(() => buildPeriodSummary(summary?.daily), [summary]);

  const overviewDatasets = useMemo(() => {
    const rows = Array.isArray(summary?.daily) ? summary.daily : [];
    const allBreakdownKeys = new Set();
    const totalsByBreakdownKey = new Map();
    const breakdownRowKey =
      breakdown === "source" ? "sources" : breakdown === "agent" ? "agents" : "models";
    const breakdownValueKey =
      breakdown === "source" ? "source" : breakdown === "agent" ? "agent" : "model";
    for (const dayRow of rows) {
      for (const breakdownRow of dayRow[breakdownRowKey] || []) {
        const bucketKey = String(breakdownRow[breakdownValueKey] || "unknown");
        allBreakdownKeys.add(bucketKey);
        totalsByBreakdownKey.set(
          bucketKey,
          Number(totalsByBreakdownKey.get(bucketKey) || 0) +
            Number(
              metric === "cost"
                ? breakdownRow.totalCost || 0
                : breakdownRow.totalTokens || 0,
            ),
        );
      }
    }
    const labels = rows.map((row) =>
      formatChartBucketLabel(String(row.date || ""), {
        range: days <= 7 ? "7d" : "30d",
        valueType: "day-key",
      }));
    const orderedBreakdownKeys = Array.from(allBreakdownKeys).sort(
      (leftValue, rightValue) => {
        const leftTotal = Number(totalsByBreakdownKey.get(leftValue) || 0);
        const rightTotal = Number(totalsByBreakdownKey.get(rightValue) || 0);
        if (rightTotal !== leftTotal) return rightTotal - leftTotal;
        return leftValue.localeCompare(rightValue);
      },
    );
    const datasets = orderedBreakdownKeys.map((bucketKey) => ({
      label: bucketKey,
      data: rows.map((row) => {
        const found = (row[breakdownRowKey] || []).find(
          (breakdownRow) =>
            String(breakdownRow[breakdownValueKey] || "") === bucketKey,
        );
        if (!found) return 0;
        return metric === "cost"
          ? Number(found.totalCost || 0)
          : Number(found.totalTokens || 0);
      }),
      backgroundColor: toChartColor(`${breakdown}:${bucketKey}`),
    }));
    return { labels, datasets };
  }, [summary, metric, breakdown, days]);

  useEffect(() => {
    const canvas = overviewCanvasRef.current;
    if (!canvas || !Chart) return;
    if (overviewChartRef.current) {
      overviewChartRef.current.destroy();
      overviewChartRef.current = null;
    }
    // The chart follows the type scale and the theme's text tones.
    const rootStyle = getComputedStyle(document.documentElement);
    const token = (name, fallback) => rootStyle.getPropertyValue(name).trim() || fallback;
    const font = { family: token("--font-sans", "system-ui"), size: 12 };
    const mutedText = token("--text-muted", "rgba(156,163,175,1)");
    const bodyText = token("--text", "rgba(209,213,219,1)");
    const gridColor = token("--border", "rgba(255,255,255,0.08)");
    overviewChartRef.current = new Chart(canvas, {
      type: "bar",
      data: overviewDatasets,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { stacked: true, ticks: { color: mutedText, font }, grid: { color: gridColor } },
          y: {
            stacked: true,
            grid: { color: gridColor },
            ticks: {
              color: mutedText,
              font,
              callback: (v) =>
                metric === "cost"
                  ? `$${Number(v).toFixed(2)}`
                  : formatInteger(v),
            },
          },
        },
        plugins: {
          legend: {
            labels: {
              color: bodyText,
              font,
              boxWidth: 10,
              boxHeight: 10,
            },
          },
          tooltip: {
            titleFont: font,
            bodyFont: font,
            callbacks: {
              label: (context) => {
                const value = Number(context.parsed.y || 0);
                const label = renderBreakdownLabel(context.dataset.label, breakdown);
                return metric === "cost"
                  ? `${label}: ${formatUsd(value)}`
                  : `${label}: ${formatInteger(value)} tokens`;
              },
            },
          },
        },
      },
    });
    return () => {
      if (overviewChartRef.current) {
        overviewChartRef.current.destroy();
        overviewChartRef.current = null;
      }
    };
  }, [Chart, overviewDatasets, metric, breakdown]);

  return {
    state: {
      days,
      metric,
      breakdown,
      summary,
      sessions,
      sessionDetailById,
      loadingSummary,
      loadingSessions,
      loadingDetailById,
      expandedSessionIds,
      error,
      summaryError,
      sessionsError,
      periodSummary,
      overviewCanvasRef,
    },
    actions: {
      setDays,
      setMetric,
      setBreakdown,
      loadSummary,
      loadSessions,
      loadSessionDetail,
      setExpandedSessionIds,
    },
  };
};
