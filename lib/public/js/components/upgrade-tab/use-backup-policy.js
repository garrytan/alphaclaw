import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { fetchOpenclawBackupPolicy, updateOpenclawBackupPolicy } from "../../lib/api.js";
import { setCached } from "../../lib/api-cache.js";
import { useSavedSetting } from "../../hooks/use-saved-setting.js";

export const kBackupPolicyCacheKey = "/api/openclaw/backup-policy";
const toDraft = (policy) => ({
  excludes: (policy?.excludes || []).join("\n"),
  rootExcludes: (policy?.rootExcludes || []).join("\n"),
});
const parseLines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
const selectDocument = (data) => {
  if (!Array.isArray(data?.policy?.excludes) || !Array.isArray(data?.policy?.rootExcludes) ||
      !Array.isArray(data?.defaults?.excludes) || !Array.isArray(data?.defaults?.rootExcludes)) {
    throw new Error("The server returned an invalid backup policy.");
  }
  return data;
};

// Both fields are one saved document. Unsaved text has its own generation:
// a delayed GET or completed save must never replace newer typing.
export const useBackupPolicy = () => {
  const active = useRef(true);
  const editGeneration = useRef(0);
  const dirtyRef = useRef(false);
  const draftRef = useRef(null);
  const savingRef = useRef(false);
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(false);
  const setting = useSavedSetting({
    cacheKey: kBackupPolicyCacheKey,
    load: fetchOpenclawBackupPolicy,
    select: selectDocument,
    selectSaved: selectDocument,
    save: (document) => updateOpenclawBackupPolicy(document.policy),
    onSaved: (_document, response) => {
      if (active.current) setCached(kBackupPolicyCacheKey, response);
    },
    label: "backup exclusions",
  });
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (!dirtyRef.current && setting.value?.policy) {
      draftRef.current = toDraft(setting.value.policy);
      setDraft(draftRef.current);
    }
  }, [setting.value]);
  const edit = useCallback((field, text) => {
    if (!["excludes", "rootExcludes"].includes(field)) return;
    editGeneration.current += 1;
    dirtyRef.current = true;
    const next = { ...(draftRef.current || toDraft(setting.value?.policy)), [field]: text };
    draftRef.current = next;
    setDraft(next);
    setSaved(false);
    setting.clearSaveError();
  }, [setting.value, setting.clearSaveError]);
  const restoreDefaults = useCallback(() => {
    if (!setting.value?.defaults) return;
    editGeneration.current += 1;
    dirtyRef.current = true;
    draftRef.current = toDraft(setting.value.defaults);
    setDraft(draftRef.current);
    setSaved(false);
    setting.clearSaveError();
  }, [setting.value, setting.clearSaveError]);
  const save = useCallback(async () => {
    if (savingRef.current || !setting.hydrated || setting.loadError || !draftRef.current) return;
    savingRef.current = true;
    const generation = editGeneration.current;
    const policy = Object.fromEntries(Object.entries(draftRef.current).map(([key, value]) => [key, parseLines(value)]));
    try {
      const outcome = await setting.commit({ ...setting.value, policy });
      if (!active.current || generation !== editGeneration.current) return;
      if (outcome.ok) {
        dirtyRef.current = false;
        draftRef.current = toDraft(outcome.value.policy);
        setDraft(draftRef.current);
        setSaved(true);
      }
    } finally {
      savingRef.current = false;
    }
  }, [setting.value, setting.hydrated, setting.loadError, setting.commit]);
  return {
    ...setting, draft: draft || toDraft(setting.value?.policy), dirty: dirtyRef.current,
    saved, edit, save, restoreDefaults,
    refusedExcludes: setting.saveError?.error?.refusedExcludes || setting.value?.refusedExcludes || [],
  };
};
