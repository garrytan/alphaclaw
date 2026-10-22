import { authFetch } from "./http.js";
import { parseJsonOrThrow, parseEnvelopeOrThrow } from "./parse.js";

export async function fetchOpenclawCapabilities() {
  const res = await authFetch("/api/openclaw/capabilities");
  return parseEnvelopeOrThrow(res, "Could not probe OpenClaw capabilities");
}

// "Back up now": runs OpenClaw's own `openclaw backup create` in the
// background. 202 { started } on success; 409 backup_in_progress while one
// is already running.
export async function createOpenclawBackup() {
  const res = await authFetch("/api/openclaw/backup", { method: "POST" });
  return parseEnvelopeOrThrow(res, "Could not start the OpenClaw backup");
}

export async function fetchOpenclawBackupStatus() {
  const res = await authFetch("/api/openclaw/backup");
  return parseEnvelopeOrThrow(res, "Could not read the backup status");
}

// OpenClaw's data upgrade alert (members get the reduced view).
export async function fetchUpgradeStatus() {
  const res = await authFetch("/api/openclaw/upgrade-status");
  return parseJsonOrThrow(res, "Could not read the upgrade status");
}

export async function dismissUpgradeNotice(key) {
  const res = await authFetch("/api/openclaw/upgrade-status/dismiss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  return parseJsonOrThrow(res, "Could not dismiss the notice");
}

export async function fetchSnapshotProposal() {
  const res = await authFetch("/api/openclaw/snapshots/proposal");
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error("Could not read the proposed change"), { status: res.status });
  }
  if (!res.ok && data?.ok !== false) {
    throw Object.assign(new Error(data?.error || "Could not read the proposed change"), { status: res.status });
  }
  // ok:false is an answer here (already on / can't be fixed / no room).
  return data;
}

export async function enableSnapshots(proposalId) {
  const res = await authFetch("/api/openclaw/snapshots/enable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proposalId }),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok || data?.ok === false) {
    throw Object.assign(new Error(data?.error || "Could not enable snapshots"), {
      status: res.status,
      code: data?.code || null,
      details: data,
    });
  }
  return data;
}

export async function fetchDoctorOutput() {
  const res = await authFetch("/api/openclaw/doctor-output");
  return parseJsonOrThrow(res, "Could not load the Doctor output");
}

// Retry upgrade: 202 { ok, operationId, kind } with progress on the same
// operation stream a restart uses. Busy and ineligible are 409s with a code.
export async function retryUpgradeAsync({ confirmUnchanged = false } = {}) {
  const res = await authFetch("/api/openclaw/boot-migration/retry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmUnchanged: confirmUnchanged === true }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok || body?.ok !== true) {
    const error = new Error(body?.error || "Could not retry the upgrade");
    error.code = body?.code || null;
    error.hint = body?.hint || null;
    error.status = res.status;
    error.notStarted = res.status < 500;
    error.unchanged = body?.unchanged === true;
    throw error;
  }
  return body;
}

export async function fetchOpenclawMedic() {
  const res = await authFetch("/api/openclaw/medic");
  return parseEnvelopeOrThrow(res, "Could not load medic settings");
}

export async function updateOpenclawMedic(enabled) {
  const res = await authFetch("/api/openclaw/medic", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: enabled === true }),
  });
  return parseEnvelopeOrThrow(res, "Could not save medic settings");
}

export async function fetchOpenclawFeatures() {
  const res = await authFetch("/api/openclaw/features");
  return parseEnvelopeOrThrow(res, "Could not load OpenClaw feature support");
}

export async function fetchOpenclawNotifications() {
  const res = await authFetch("/api/openclaw/notifications");
  return parseEnvelopeOrThrow(res, "Could not load notification settings");
}

export async function updateOpenclawNotifications({
  preferredChannel = null,
  adminTargets = [],
} = {}) {
  const res = await authFetch("/api/openclaw/notifications", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferredChannel, adminTargets }),
  });
  return parseEnvelopeOrThrow(res, "Could not save notification settings");
}
