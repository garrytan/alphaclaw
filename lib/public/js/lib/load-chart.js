// Chart.js is ~250KB and only three chart panels need it — load it on demand
// so it stays out of the main bundle (same pattern as loadXtermModules).
let chartModulePromise = null;

export const loadChart = () => {
  if (!chartModulePromise) {
    chartModulePromise = import("chart.js/auto")
      .then((chartModule) => {
        const Chart = chartModule?.default || chartModule?.Chart || null;
        if (typeof Chart !== "function") {
          throw new Error("Chart.js export not found");
        }
        return Chart;
      })
      .catch((err) => {
        // A transient chunk-load failure must not disable charts for the
        // whole session — clear the memo so the next call retries.
        chartModulePromise = null;
        throw err;
      });
  }
  return chartModulePromise;
};
