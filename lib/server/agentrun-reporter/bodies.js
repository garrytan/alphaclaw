// AgentRun SDK-run bodies for AlphaClaw's reporters (GST-2907), built once
// per turn and stored, so every retry sends the same bytes. Every field is cut
// to AgentRun's limits here (packages/serve/src/sdk/runs.ts): input, answer
// and instructions 128,000 characters, error 8,000, model and session id 256,
// a batch at most 100 events and 256 KB.
const kInputMax = 128000;
const kErrorMax = 8000;
const kShortMax = 256;
const kTextEventMax = 16000;
const kRunTextBudget = 512 * 1024;
const kBatchEvents = 100;
const kBatchBytes = 200 * 1024;
const kCutMarker = " [cut]";

const cut = (value, max) => {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  if (max <= kCutMarker.length) return text.slice(0, Math.max(0, max));
  return text.slice(0, max - kCutMarker.length) + kCutMarker;
};

const kInstructions =
  "Reported by AlphaClaw: a task its source system ran itself. AgentRun only records it; nothing here runs it again.";

const agentDefinition = ({ agentId, name, description, runtime }) => ({
  id: agentId,
  name: cut(name, 120),
  description: cut(description, 500),
  instructions: kInstructions,
  sdk: { runtime },
  learning: false,
});

// extra: the fields an AgentRun that advertises features.sdk_runs takes
// (started_at, title, labels), already decided by the caller.
const startBody = ({ runtime, input, model, extra = {} }) => ({
  runtime,
  input: cut(input, kInputMax) || "(no input recorded)",
  instructions: kInstructions,
  ...(model ? { model: cut(model, kShortMax) } : {}),
  ...extra,
});

// [{ sequence, events }] — a session event, the turn's text (contents runs
// only, already decided by the caller) and its tools, with deterministic ids.
// A live run's later batches continue the numbering: firstTool tools and
// firstSequence - 1 batches went before.
const eventBatches = ({ rowId, sessionLabel, texts = [], tools = [], firstTool = 0, firstSequence = 1 }) => {
  const events = [];
  if (sessionLabel) events.push({ type: "session", session_id: cut(sessionLabel, kShortMax) });
  let budget = kRunTextBudget;
  for (const text of texts) {
    if (!text || budget <= 0) continue;
    const piece = cut(text, Math.min(kTextEventMax, budget));
    budget -= piece.length;
    events.push({ type: "text", text: piece });
  }
  tools.forEach((tool, index) => {
    const id = `${rowId}-t${firstTool + index + 1}`;
    const name = cut(tool.name || "tool", kShortMax);
    events.push({ type: "tool", id, name, status: "started" });
    events.push({ type: "tool", id, name, status: tool.ok === false ? "failed" : "completed" });
  });
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event));
    // Keep a tool's started/completed pair in one batch.
    const pairStart = event.type === "tool" && event.status === "started";
    const needed = pairStart ? size * 2 : size;
    if (current.length && (current.length + (pairStart ? 2 : 1) > kBatchEvents || bytes + needed > kBatchBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches.map((batch, index) => ({ sequence: firstSequence + index, events: batch }));
};

const completeBody = ({ status, answer, error, model, sessionLabel, usage, evidenceComplete }) => ({
  status,
  answer: cut(answer || "", kInputMax),
  ...(error ? { error: cut(error, kErrorMax) } : {}),
  ...(model ? { model: cut(model, kShortMax) } : {}),
  ...(sessionLabel ? { session_id: cut(sessionLabel, kShortMax) } : {}),
  ...(usage ? { usage } : {}),
  evidence_complete: Boolean(evidenceComplete),
});

module.exports = { kInstructions, agentDefinition, startBody, eventBatches, completeBody, cut };
