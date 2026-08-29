import { useCallback, useEffect, useState } from "preact/hooks";
import {
  createAgent,
  deleteAgent,
  fetchAgents,
  setDefaultAgent,
  updateAgent,
} from "../../lib/api.js";

export const useAgents = () => {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const payload = await fetchAgents();
      setAgents(Array.isArray(payload?.agents) ? payload.agents : []);
    } catch (error) {
      // Keep last-known-good agents; AgentsTab renders a retryable error
      // region instead of a confident empty state.
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const create = useCallback(async (input) => {
    setSaving(true);
    try {
      const payload = await createAgent(input);
      setAgents((previous) => [...previous, payload.agent]);
      return payload.agent;
    } finally {
      setSaving(false);
    }
  }, []);

  const update = useCallback(async (agentId, patch) => {
    setSaving(true);
    try {
      const payload = await updateAgent(agentId, patch);
      setAgents((previous) =>
        previous.map((entry) => (entry.id === agentId ? payload.agent : entry)),
      );
      return payload.agent;
    } finally {
      setSaving(false);
    }
  }, []);

  const setDefault = useCallback(async (agentId) => {
    setSaving(true);
    try {
      await setDefaultAgent(agentId);
      setAgents((previous) =>
        previous.map((entry) => ({ ...entry, default: entry.id === agentId })),
      );
    } finally {
      setSaving(false);
    }
  }, []);

  const remove = useCallback(async (agentId, options = {}) => {
    setSaving(true);
    try {
      await deleteAgent(agentId, options);
      setAgents((previous) => previous.filter((entry) => entry.id !== agentId));
    } finally {
      setSaving(false);
    }
  }, []);

  return {
    state: {
      agents,
      loading,
      loadError,
      saving,
    },
    actions: {
      create,
      loadAgents,
      // Rides on actions: route plumbing forwards agentsActions wholesale, so
      // AgentsTab can surface load failures without new app-level props.
      loadError,
      remove,
      setDefault,
      update,
    },
  };
};
