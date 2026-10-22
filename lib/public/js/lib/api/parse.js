export const parseJsonOrThrow = async (res, fallbackError) => {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error(text || fallbackError), { status: res.status });
  }
  if (!res.ok || data?.ok === false) {
    // Prefer the human-readable message when the server sends one alongside
    // the machine code — operators should never be toasted "rate_limited".
    throw Object.assign(new Error(data.message || data.error || text || `HTTP ${res.status}`), {
      status: res.status, code: data.code, hint: data.hint, docsUrl: data.docsUrl,
    });
  }
  return data;
};

// Structured error envelope ({ok, code, message, hint, docsUrl}); keep those
// fields on the thrown error so the UI can render `message` with `hint`
// underneath verbatim.
// Explicit partial-success facts only. Never attach an arbitrary failure
// body to Error: consent tokens and other response credentials stay private.
const kPartialOutcomeBooleanFields = [
  "configSaved", "restartDeferred", "restartRequired", "enabled", "disabled", "changed",
  "restored", "configApplied", "gatewayApplied", "configRestored", "gatewayRestored",
  "ownerCreated", "memberSaved", "gatewayConfigSaved", "gatewayConfigDeferred",
];
export const parseEnvelopeOrThrow = async (res, fallbackError) => {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error(text || fallbackError), { status: res.status });
  }
  if (!res.ok || data?.ok === false) {
    const error = new Error(
      data?.message || data?.error || text || `HTTP ${res.status}`,
    );
    error.status = res.status;
    if (data?.code) error.code = data.code;
    if (data?.hint) error.hint = data.hint;
    if (data?.docsUrl) error.docsUrl = data.docsUrl;
    for (const field of kPartialOutcomeBooleanFields) {
      if (typeof data?.[field] === "boolean") error[field] = data[field];
    }
    throw error;
  }
  return data;
};
