import { useState, useEffect, useRef } from "preact/hooks";
import { showToast } from "../toast.js";
import * as api from "../../lib/telegram-api.js";
import {
  fetchAgents,
  getTelegramTopics,
  restoreTelegramTopic,
  verifyTelegramTopic,
  sweepTopicDiscovery,
} from "../../lib/api.js";
import {
  buildRegistryErrorBanner,
  createTopicRenameState,
  topicRenameStateWithValue,
  topicRenameStateSaving,
  topicRenameStateFailed,
  applyVerifyResult,
  applyRestoreResult,
} from "./helpers.js";

export const useTelegramTopics = ({ accountId, groupId, initialTopics }) => {
  const [topics, setTopics] = useState(initialTopics || {});
  const [newTopicName, setNewTopicName] = useState("");
  const [newTopicInstructions, setNewTopicInstructions] = useState("");
  const [newTopicAgentId, setNewTopicAgentId] = useState("");
  const [showCreateTopic, setShowCreateTopic] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [editingTopicId, setEditingTopicId] = useState("");
  const [editingTopicName, setEditingTopicName] = useState("");
  const [editingTopicInstructions, setEditingTopicInstructions] = useState("");
  const [editingTopicAgentId, setEditingTopicAgentId] = useState("");
  const [renamingTopicId, setRenamingTopicId] = useState("");
  const [error, setError] = useState(null);
  const [agents, setAgents] = useState([]);
  const [registryRows, setRegistryRows] = useState([]);
  const [registryDiscovery, setRegistryDiscovery] = useState(null);
  const [registryError, setRegistryError] = useState(null);
  const [renameDrafts, setRenameDrafts] = useState({});
  const [verifyingTopicId, setVerifyingTopicId] = useState("");
  const [restoringTopicId, setRestoringTopicId] = useState("");
  const [sweeping, setSweeping] = useState(false);
  const [topicsError, setTopicsError] = useState(null);
  const [editSaveError, setEditSaveError] = useState(null);
  // Latest-request-wins guards: refetch responses dispatched after a newer
  // load (or an optimistic registry mutation) started are discarded, so a
  // slow pre-mutation snapshot can never clobber fresher state.
  const topicsRequestRef = useRef(0);
  const registryRequestRef = useRef(0);

  const loadTopics = async () => {
    const requestId = ++topicsRequestRef.current;
    try {
      const data = await api.listTopics(groupId, { accountId });
      if (requestId !== topicsRequestRef.current) return;
      if (!data.ok) throw new Error(data.error || "Failed to load topics");
      setTopics(data.topics || {});
      setTopicsError(null);
    } catch (e) {
      if (requestId !== topicsRequestRef.current) return;
      setTopicsError(e.message || "Failed to load topics");
    }
  };

  const loadRegistry = async () => {
    const requestId = ++registryRequestRef.current;
    try {
      const data = await getTelegramTopics();
      if (requestId !== registryRequestRef.current) return;
      if (data?.ok) {
        setRegistryError(null);
        setRegistryRows(
          (Array.isArray(data.topics) ? data.topics : []).filter(
            (row) => String(row?.groupId) === String(groupId),
          ),
        );
        setRegistryDiscovery(data.discovery || null);
        return;
      }
      setRegistryError(
        buildRegistryErrorBanner(data) || {
          code: "",
          title: "Topic registry could not be loaded",
          text:
            String(data?.error || "").trim() ||
            "Topic health and discovery data are unavailable right now.",
        },
      );
    } catch (e) {
      if (requestId !== registryRequestRef.current) return;
      setRegistryError({
        code: "",
        title: "Topic registry could not be loaded",
        text:
          String(e?.message || "").trim() ||
          "Topic health and discovery data are unavailable right now.",
      });
    }
  };

  // The child owns topics state: server truth loads here on mount. Parent
  // snapshots (initialTopics) only seed the initial useState — re-applying
  // them on prop change would clobber fresher child fetches.
  useEffect(() => {
    loadTopics();
    loadRegistry();
  }, [groupId]);

  useEffect(() => {
    fetchAgents()
      .then((data) => setAgents(Array.isArray(data?.agents) ? data.agents : []))
      .catch(() => {});
  }, []);

  const createSingle = async () => {
    const name = newTopicName.trim();
    const systemInstructions = newTopicInstructions.trim();
    const agentId = newTopicAgentId.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const data = await api.createTopicsBulk(groupId, [
        {
          name,
          ...(systemInstructions ? { systemInstructions } : {}),
          ...(agentId ? { agentId } : {}),
        },
      ], { accountId });
      if (!data.ok)
        throw new Error(data.results?.[0]?.error || "Failed to create topic");
      const failed = data.results.filter((r) => !r.ok);
      if (failed.length > 0) throw new Error(failed[0].error);
      setNewTopicName("");
      setNewTopicInstructions("");
      setNewTopicAgentId("");
      setShowCreateTopic(false);
      await loadTopics();
      showToast(`Created topic: ${name}`, "success");
    } catch (e) {
      setError(e.message);
    }
    setCreating(false);
  };

  const handleDelete = async (topicId, topicName) => {
    setDeleting(topicId);
    try {
      const data = await api.deleteTopic(groupId, topicId, { accountId });
      if (!data.ok) throw new Error(data.error);
      await loadTopics();
      if (data.removedFromRegistryOnly) {
        showToast(`Removed stale topic from registry: ${topicName}`, "success");
      } else {
        showToast(`Deleted topic: ${topicName}`, "success");
      }
    } catch (e) {
      showToast(`Failed to delete: ${e.message}`, "error");
    }
    setDeleting(null);
  };

  const startRename = (topicId, topicName, topicInstructions = "", topicAgentId = "") => {
    setEditingTopicId(String(topicId));
    setEditingTopicName(String(topicName || ""));
    setEditingTopicInstructions(String(topicInstructions || ""));
    setEditingTopicAgentId(String(topicAgentId || ""));
  };

  const cancelRename = () => {
    setEditingTopicId("");
    setEditingTopicName("");
    setEditingTopicInstructions("");
    setEditingTopicAgentId("");
    setEditSaveError(null);
  };

  const saveRename = async (topicId) => {
    const nextName = editingTopicName.trim();
    const nextSystemInstructions = editingTopicInstructions.trim();
    const nextAgentId = editingTopicAgentId.trim();
    if (!nextName) {
      setEditSaveError("Topic name is required");
      return;
    }
    setRenamingTopicId(String(topicId));
    setEditSaveError(null);
    try {
      const data = await api.updateTopic(groupId, topicId, {
        name: nextName,
        systemInstructions: nextSystemInstructions,
        agentId: nextAgentId,
      }, { accountId });
      if (!data.ok) throw new Error(data.error || "Failed to update topic");
      await loadTopics();
      showToast(`Updated topic: ${nextName}`, "success");
      cancelRename();
    } catch (e) {
      setEditSaveError(e.message);
    }
    setRenamingTopicId("");
  };

  const setRenameDraftValue = (threadId, value) =>
    setRenameDrafts((drafts) => ({
      ...drafts,
      [threadId]: topicRenameStateWithValue(
        drafts[threadId] || createTopicRenameState(threadId),
        value,
      ),
    }));

  // Naming a discovered topic registers it via the existing update endpoint.
  // Failure keeps the typed value in the draft so the operator can retry.
  const saveDiscoveredName = async (threadId) => {
    const draft = renameDrafts[threadId] || createTopicRenameState(threadId);
    const name = draft.value.trim();
    if (!name || draft.saving) return;
    setRenameDrafts((drafts) => ({
      ...drafts,
      [threadId]: topicRenameStateSaving(
        drafts[threadId] || createTopicRenameState(threadId, name),
      ),
    }));
    try {
      const data = await api.updateTopic(groupId, threadId, { name }, { accountId });
      if (!data.ok) throw new Error(data.error || "Failed to name topic");
      setRenameDrafts((drafts) => {
        const next = { ...drafts };
        delete next[threadId];
        return next;
      });
      await Promise.all([loadTopics(), loadRegistry()]);
      showToast(`Registered topic: ${name}`, "success");
    } catch (e) {
      setRenameDrafts((drafts) => ({
        ...drafts,
        [threadId]: topicRenameStateFailed(
          drafts[threadId] || createTopicRenameState(threadId, name),
          e,
        ),
      }));
    }
  };

  const handleVerify = async (threadId) => {
    setVerifyingTopicId(String(threadId));
    try {
      const data = await verifyTelegramTopic(groupId, threadId, { accountId });
      if (!data.ok) throw new Error(data.error || "Failed to verify topic");
      // Invalidate any in-flight registry load: a pre-mutation snapshot must
      // not overwrite this optimistic row update.
      registryRequestRef.current += 1;
      setRegistryRows((rows) =>
        applyVerifyResult(rows, groupId, threadId, data.status),
      );
      showToast(
        data.status === "ok"
          ? "Topic verified: reachable"
          : "Topic is still unreachable (stale)",
        data.status === "ok" ? "success" : "warning",
      );
    } catch (e) {
      showToast(`Verify failed: ${e.message}`, "error");
    }
    setVerifyingTopicId("");
  };

  const handleRestore = async (threadId) => {
    setRestoringTopicId(String(threadId));
    try {
      const data = await restoreTelegramTopic(groupId, threadId);
      if (!data.ok) throw new Error(data.error || "Failed to restore topic");
      registryRequestRef.current += 1;
      setRegistryRows((rows) => applyRestoreResult(rows, groupId, threadId));
      await Promise.all([loadTopics(), loadRegistry()]);
      showToast("Topic restored", "success");
    } catch (e) {
      showToast(`Restore failed: ${e.message}`, "error");
    }
    setRestoringTopicId("");
  };

  const handleSweep = async () => {
    setSweeping(true);
    try {
      const data = await sweepTopicDiscovery();
      if (!data.ok) throw new Error(data.error || "Failed to run sweep");
      await loadRegistry();
      showToast("Discovery sweep complete", "success");
    } catch (e) {
      showToast(`Sweep failed: ${e.message}`, "error");
    }
    setSweeping(false);
  };

  return {
    topics,
    topicsError,
    loadTopics,
    agents,
    registryRows,
    registryDiscovery,
    registryError,
    newTopicName,
    setNewTopicName,
    newTopicInstructions,
    setNewTopicInstructions,
    newTopicAgentId,
    setNewTopicAgentId,
    showCreateTopic,
    setShowCreateTopic,
    creating,
    error,
    createSingle,
    deleting,
    handleDelete,
    editingTopicId,
    editingTopicName,
    setEditingTopicName,
    editingTopicInstructions,
    setEditingTopicInstructions,
    editingTopicAgentId,
    setEditingTopicAgentId,
    renamingTopicId,
    editSaveError,
    startRename,
    cancelRename,
    saveRename,
    renameDrafts,
    setRenameDraftValue,
    saveDiscoveredName,
    verifyingTopicId,
    handleVerify,
    restoringTopicId,
    handleRestore,
    sweeping,
    handleSweep,
  };
};
