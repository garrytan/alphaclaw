# Chat/session reliability — protocol v2, run lifecycle, durable outcomes

Status: shipped (Phases 1–5; Phase 5 resume-streaming landed with the v0.9.52 adversarial-hardening wave — `hello.activeRuns` + `resume`/`resumed`/`resume-failed`)
Owner surfaces: `lib/server/chat/`, `lib/server/db/chat-runs/`, `lib/public/js/components/chat/`

## Problem

The Chat tab ate messages and was nondeterministic around Stop/Send:

- Enter during a streaming run was a silent no-op; the draft was cleared
  before `ws.send` with no ack/retry; every history response wholesale-replaced
  the transcript (wiping optimistic messages and remounting the list).
- Stop was blind-optimistic on the client, and the bridge deleted its run
  routing BEFORE awaiting `chat.abort`, then reported `stopped` even when the
  abort failed.
- A gateway restart never terminalized in-flight runs — the UI streamed
  forever; nothing anywhere recorded stops/interruptions.

## Architecture

```
 browser (components/chat/)                 alphaclaw (lib/server/chat/)              OpenClaw gateway
 ┌───────────────────────────┐   WS /api/ws/chat   ┌───────────────────────────┐   ws://127.0.0.1:<port>
 │ composer ─▶ send-outbox ──┼────── protocol v2 ──▶ send-service ─▶ run-registry│──── chat.send/abort/history
 │ (durable, localStorage)   │◀─ ack/started/seq ──│  (atomic finalize, 1 run  │◀─── agent/chat events
 │ run-state (per session)   │   chunk/tool/done   │   per session)            │
 │ transcript-store (merge)  │   markers/truncated │ gateway-client (1 socket) │
 │ connection (reconnect/    │                     │ db/chat-runs (durable     │
 │  legacy/staleness)        │                     │  outcomes + boot recon.)  │
 └───────────────────────────┘                     └───────────────────────────┘
```

Two truths, never conflated:

- **Registry = live routing truth** (`run-registry.js`): which socket gets
  which run's frames right now. ONE active browser run per session
  (`session_busy` rejects the rest; the client outbox queues them) — event
  attribution is unambiguous and the session-scoped `chat.abort` is
  effectively run-scoped for browser traffic.
- **Store = durable outcome truth** (`db/chat-runs`): status/ids/timestamps
  + a classified ≤500-char error string — never message content, never raw
  gateway error text. Powers the inline stop/interrupt/unknown markers merged
  into history, cross-restart send dedupe, and boot reconciliation.

## Protocol v2 (browser ⇄ bridge)

Constants + validators: `lib/server/chat/protocol.js`; browser mirror
`components/chat/chat-protocol.js` (drift pinned by
`tests/frontend/chat-protocol-sync.test.js`).

- Browser → server: `message {clientMsgId, sessionKey, content, sentAt}`,
  `stop {sessionKey, runId?}`, `history {sessionKey, reqId}`, `ping`,
  (`resume` — Phase 5).
- Server → browser: `hello {protocolVersion, maxContentBytes, activeRuns}`
  (first frame on every connection; `activeRuns` advertises resumable runs —
  Phase 5), `ack`, `started`, `chunk`, `tool`,
  `done {reason: complete|stopped|interrupted|error, confidence, stopped?}`,
  `stopping`, `stop-failed`, `send-failed {code, retryable}`,
  `history {messages, markers, truncated}`, `desync`, `error`, `pong`,
  (`resumed`/`resume-failed` — Phase 5).
- STREAM frames (`started/chunk/tool/done`) carry a per-run monotonic `seq`;
  control frames don't.
- Ordering invariants: `ack` → `started` → stream → exactly ONE terminal
  `done` per started run — enforced by the registry's atomic
  compare-and-finalize (`finalize`: first caller to flip
  `record.finalized` wins; lifecycle end, stop-confirm timer, stall sweeper,
  RPC rejection, gateway disconnect, and stop-failed all funnel through it).

### Error taxonomy

`classifyError` (`chat/errors.js`) → `{code, retryable, message}`; codes:
`gateway_unavailable | gateway_timeout | gateway_auth | protocol_mismatch |
protocol_invalid | session_busy | too_many_pending | unsupported | run_failed
| payload_too_large | unknown_outcome | unknown`. Socket-close reasons map to
`gateway_unavailable`, not the generic bucket. Raw error text goes to the
server log only.

## Idempotency + the ambiguity policy (unknown is unknown)

- The client-generated `clientMsgId` IS the gateway `idempotencyKey`; the
  bridge dedupes by `(sessionKey, clientMsgId)` — live records re-ack, recent
  terminal store rows re-ack AND replay the stored terminal frame so a retried
  outbox item always settles. Dedupe binds the session: a client-controlled id
  can never replay another session's outcome (store UNIQUE(session_key,
  client_msg_id)).
- Each record tracks `rpcWritten` (the chat.send frame reached the gateway
  socket). Pre-write failures → retryable `send-failed`. Post-write
  timeout/disconnect (NOT an explicit gateway rejection — those carry
  `gatewayResponded`) → terminal `unknown`: "may have been sent — check the
  transcript", manual Retry/Discard only, NEVER auto-retried.
- Boot reconciliation (`initChatRunsDb`): dangling `pending` → `unknown`
  (genuinely ambiguous), dangling `running` → `interrupted` unconfirmed (the
  run definitely started; its stream died with the process). The house
  "dangling in-flight state always resolves to a terminal answer" pattern.

## Stop lifecycle

`stop` → record marked `stopping` (works during the send window too — records
register BEFORE the RPC; `promote` preserves `stopping`) → `stopping` frame →
`await chat.abort {sessionKey}`:

- abort ok + gateway `lifecycle:end` → `done {reason: stopped, confidence:
  confirmed}` (`stop_confirmed=1`);
- abort ok, no lifecycle end in 10s → the stop-confirm timer finalizes
  `unconfirmed` (`stop_confirmed=0`);
- abort failure → `stop-failed`, the run honestly stays live (a failure that
  lost the race to a real terminal is swallowed — finalized records are never
  mutated);
- `chat.send` resolving AFTER its record finalized (stop/disconnect won) →
  the bridge immediately aborts the late run and never announces it (no
  orphan).

Documented semantics: with one active run per session, stop from any tab (or
any team member, per the TODOS.md team-mode access model) stops the session's
active browser run — ChatGPT semantics, intentional. Upstream limitation
(R1): `chat.abort` is session-scoped at the gateway and can also abort a
concurrent foreign (Telegram/cron) run sharing the session — identical to the
pre-rework behavior. A stop racing a natural completion records as stopped —
the user asked for it; accepted residual.

## Interruption honesty

- Gateway disconnect: every STARTED record finalizes `interrupted`
  (unconfirmed) — browsers get a terminal `done` + a persisted marker; the
  "UI streams forever" class is gone. Pending sends settle via their RPC
  rejection (rpcWritten decides retryable vs unknown).
- Stall sweeper (30s tick): a run silent for 5+ minutes finalizes
  `interrupted` with honest copy ("may still be executing") and writes an
  info-severity `chat_run_stall_interrupted` watchdog event (chat-domain
  telemetry riding the ops event stream — never creates a gateway-health
  incident).
- Queued outbox items NEVER auto-flush into an ambiguous ending (interrupted /
  unknown): the composer shows an explicit "Send queued" confirmation
  (run-state `holdFlush`).

## Client

Feature folder `lib/public/js/components/chat/` (the 1116-line chat-route
monolith is deleted). Pure, node-tested modules:

- `run-state.js` — per-session reducer (the three global booleans are gone);
  late `done` for a stale runId is ignored; `SOCKET_CLOSED` maps pendingSend →
  idle and running → interruptedLocal.
- `send-outbox.js` — durable localStorage outbox (persist-first,
  dedupe-by-id, merge-on-fresh-read against other tabs, byte+count caps with
  terminal-first eviction, quota → in-memory fallback + loud chip, logout
  clear). Content is retained until history-confirmed or terminally failed —
  ack/started are display states. Reload restores non-terminal items as
  `failed` ("Not sent — Retry"), never auto-sends. `session_busy` waits on a
  5s recheck without consuming attempts.
- `transcript-store.js` — merge-by-stable-id history (server mints
  deterministic row ids; native row ids preferred when the gateway provides
  them), bounded one-shot outbox confirmation, marker interleaving, live-row
  retention until history covers them; chunk-merge by id anywhere; tool
  dedupe by toolCallId only.
- `connection.js` — unlimited jittered reconnect (1s→15s), 60s budget →
  visible offline + Retry-now, hello-timeout → LEGACY mode (old server: no
  ack/dedupe ⇒ single-shot sends, no auto-retry), app-level ping staleness,
  MW5-safe httpFallback (never latches while CONNECTING/OPEN; any open
  clears).

History flow: requested on connect/reconnect/switch/done/desync/window-focus,
always MERGED (2s stacking dedupe + latest-request-wins reqId guard); HTTP
fallback keeps history readable when the socket can't connect.

## Preserved invariants

- **H8** markdown safety — `components/chat/markdown.js` (verbatim path),
  guarded by `tests/frontend/chat-route-markdown.test.js`.
- **H16** solo-browser fallback only for id-less events; hardened further: an
  event with an explicit-but-unknown runId NEVER falls through to session
  routing (a finalized run's late output must not attach to the next run).
- **H13** foreign-run event buffer caps (64 runs × 200 events, FIFO evict).
- **MW5** realtime latch semantics (connection.js httpFallback).
- **C2** browser socket 'error' handling (close quietly, never crash).
- **Fix wave PR 9b (v0.9.83)** — outbox and transcript invariants pinned by
  `tests/frontend/chat-*.test.js`: (1) only an item that was actually SENT
  (`sentAt`/`ackedAt`) can be confirmed against a history row — a never-sent
  queued item is never deleted by the merge; (2) sent (inflight/acked)
  optimistic bubbles render ABOVE the live assistant/tool rows of the run they
  started, unsent ones below; (3) an ack timeout exits `pendingSend`
  (`ACK_TIMEOUT` → idle) so the requeued item auto-flushes; (4) the outbox is
  one per page load, not per `/chat` mount (`restoreOnLoad` runs once); (5)
  acked items whose socket died wait for the reconnect's history merge
  (`awaitingHistoryAt` → `releaseAwaitingHistory`, 30s staleness fallback)
  before any re-send — never a blind 5s timer; (6) `RESUME_ATTACH` carries the
  live row's `messageId` (from `hello.activeRuns` and the `resumed` frame) and
  never clears a known one. Server side: typed non-text history parts are never
  scraped for text; a runId-less session-routed `chat` error does not finalize
  a pending send (same guard as lifecycle end).
- Old-bundle compat: legacy `message` frames (no clientMsgId) work — the
  bridge mints an id; validation/errors surface as plain `error` frames;
  `done.stopped === true` stays on stop terminals permanently.

## Operations / runbook

| Operator sees | Meaning | Response |
|---|---|---|
| "You stopped this response" marker | confirmed stop (`stop_confirmed=1`) | none |
| same, but store row `stop_confirmed=0` | abort acked, gateway never confirmed | check gateway logs if frequent |
| "Interrupted — connection lost…" marker | gateway restart/crash mid-run | watchdog handles the restart; transcript reconciles on reload |
| "No output for 5+ minutes…" marker + `chat_run_stall_interrupted` events | run stalled without lifecycle end | inspect gateway health; repeated events trend in the ops stream |
| "may have been sent — check the transcript" | post-write ambiguity / boot-reconciled pending | user decides Retry/Discard after reading the transcript |
| "Limited mode" banner | old/rolled-back server (no hello) | upgrade/redeploy; sends still work single-shot |
| "Messages can't be saved in this browser" | localStorage unavailable/full | in-session guarantees hold; don't close mid-send |
| `?chatDebug=1` | raw history + inbound event log + outbox/run state | forensic view |

Store failure is warn-once + counted in `getChatStats()`; sends never block on
the store.

## Deliberate limits (recorded, not accidental)

- History window: newest 200 rows; `truncated` is honest (fetch 201, trim).
  Pagination needs an upstream cursor — TODOS.
- Chat is not per-operator attributed in team mode (pre-existing; TODOS).
- No session deep-links yet (TODOS).
- The identical-content confirmation window and the same-millisecond
  duplicate-row id edge are documented residuals (native row ids remove the
  latter where the gateway provides them).
- R2 (does the gateway dedupe on idempotencyKey?) is hedged, not assumed:
  nothing auto-resends after the RPC frame was written.
- `lib/server/chat-ws.js` is a temporary re-export shim; remove once all
  imports point at `lib/server/chat`.
