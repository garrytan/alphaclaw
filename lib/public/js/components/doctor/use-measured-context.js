import { useState } from "preact/hooks";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { fetchMeasuredContext } from "../../lib/api/doctor.js";
import { fetchAgents } from "../../lib/api/agents.js";

export const useMeasuredContext = () => {
  const [agentId, setAgentId] = useState("main");
  const measuredState = useCachedFetch(
    `/api/doctor/context/measured?agentId=${encodeURIComponent(agentId)}`,
    () => fetchMeasuredContext(agentId),
    { maxAgeMs: 30000 },
  );
  const agentsState = useCachedFetch("/api/agents", fetchAgents, { maxAgeMs: 30000 });
  const agents = (Array.isArray(agentsState.data?.agents) ? agentsState.data.agents : [])
    .map((agent) => ({
      id: String(agent?.id || "").trim(),
      name: String(agent?.name || "").trim(),
    }))
    .filter((agent) => agent.id);
  return {
    agentId,
    setAgentId,
    agents,
    measured: measuredState.data?.measured || null,
    loading: measuredState.loading,
    error: measuredState.error,
    refresh: () => measuredState.refresh({ force: true }),
  };
};
