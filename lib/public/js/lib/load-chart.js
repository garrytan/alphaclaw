// Chart.js is ~250KB and only three chart panels need it — load it on demand
// so it stays out of the main bundle (same pattern as loadXtermModules).
let chartModulePromise = null;

export const loadChart = () => {
  if (!chartModulePromise) {
    chartModulePromise = import("chart.js/auto").then((chartModule) => {
      const Chart = chartModule?.default || chartModule?.Chart || null;
      if (typeof Chart !== "function") {
        throw new Error("Chart.js export not found");
      }
      return Chart;
    });
  }
  return chartModulePromise;
};
