const parseEventPayload = (value) => {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

export const subscribeToSse = ({
  url = "",
  onMessage = () => {},
  onError = () => {},
}) => {
  if (typeof window?.EventSource !== "function") {
    throw new Error("Server events are not supported in this browser");
  }
  const source = new window.EventSource(String(url || ""), { withCredentials: true });
  const handlePhase = (event) => {
    onMessage({
      event: "phase",
      data: parseEventPayload(event?.data || ""),
    });
  };
  const handleDone = (event) => {
    onMessage({
      event: "done",
      data: parseEventPayload(event?.data || ""),
    });
  };
  const handleFailure = (event) => {
    // Two different things arrive as "error" (fix wave F139): a SERVER-sent
    // `event: error` frame carries data (the operation failed — a message);
    // a plain connection drop fires EventSource's error event with NO data
    // and belongs to onError, or a stream hiccup reads as "Could not create
    // channel" and the real onError path is unreachable.
    const raw = typeof event?.data === "string" ? event.data : "";
    if (!raw.trim()) {
      onError(event);
      return;
    }
    onMessage({ event: "error", data: parseEventPayload(raw) });
  };
  const handleError = (event) => {
    onError(event);
  };
  source.addEventListener("phase", handlePhase);
  source.addEventListener("done", handleDone);
  source.addEventListener("error", handleFailure);
  source.onerror = handleError;
  return () => {
    source.removeEventListener("phase", handlePhase);
    source.removeEventListener("done", handleDone);
    source.removeEventListener("error", handleFailure);
    source.onerror = null;
    source.close();
  };
};
