import { useEffect, useState } from "preact/hooks";
import { fetchOpenclawFeatures } from "../lib/api.js";

// Version-gated OpenClaw feature map (GET /api/openclaw/features), shared by
// every gated affordance (sidebar Dashboards link, SQLite backup button,
// secret-egress callout). Fail-closed on any error: consumers see an empty
// feature map and gated UI simply stays hidden.
//
// Module-level cache: the map only changes across an OpenClaw version switch
// (which restarts the server and reloads the page), so one fetch per page
// load is enough no matter how many components use the hook.
let cachedFeatures = null;
let inflightPromise = null;

// Test-only: clears the module-level cache so each test starts cold.
export const __resetForTests = () => {
  cachedFeatures = null;
  inflightPromise = null;
};

const loadFeatures = () => {
  if (cachedFeatures) return Promise.resolve(cachedFeatures);
  if (!inflightPromise) {
    inflightPromise = fetchOpenclawFeatures()
      .then((data) => {
        cachedFeatures = {
          version: data?.version || null,
          features: data?.features || {},
        };
        return cachedFeatures;
      })
      .catch(() => {
        inflightPromise = null;
        return { version: null, features: {} };
      });
  }
  return inflightPromise;
};

export const useOpenclawFeatures = ({ enabled = true } = {}) => {
  const [state, setState] = useState(
    () => cachedFeatures || { version: null, features: {} },
  );
  const [loading, setLoading] = useState(() => !cachedFeatures);

  useEffect(() => {
    if (!enabled || cachedFeatures) return undefined;
    let cancelled = false;
    loadFeatures().then((result) => {
      if (cancelled) return;
      setState(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { features: state.features, version: state.version, loading };
};
