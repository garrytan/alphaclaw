import { useEffect, useState } from "preact/hooks";
import { loadChart } from "../lib/load-chart.js";

// Returns the Chart.js constructor once the lazy chunk has loaded (null until
// then). Chart effects keep their `if (!Chart) return` guard and simply add
// Chart to their dependency list — they re-run when the library lands.
export const useChartJs = () => {
  const [Chart, setChart] = useState(null);
  useEffect(() => {
    let mounted = true;
    loadChart()
      .then((chartConstructor) => {
        if (mounted) setChart(() => chartConstructor);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);
  return Chart;
};
