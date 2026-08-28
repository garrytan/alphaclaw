# TODOS

## P2 — Gateway child re-ownership spike
- **What:** Investigate re-owning the gateway process after a manual restart so exit codes and crash attribution stay reliable (today the first `openclaw gateway --force` restart detaches the child; crash detection falls back to TCP-probe inference labeled "estimated").
- **Why:** Exit-based detection is instant and attributable; probe-based is ~10s and inferred.
- **Context:** Trigger condition (from the gateway-state design): schedule this spike only if production unified-state staleness p95 (real gateway death → state change; recorded on watchdog events) exceeds 15s now that event-driven probes shipped. Supervision honesty labels are in lib/server/gateway-state.js.
- **Effort:** M (spike) — outcome decides the real work.

## P2 — Remove legacy status fields (next minor)
- **What:** Drop `gateway` and `watchdogStatus`-derived legacy projections from `/api/status` and flip `POST /api/gateway/restart` to async-by-default (blocking behavior behind an opt-out for one more release).
- **Why:** They exist only as a one-minor-release compat window for old clients; the reducer-backed `status.state` is the contract now. A projection-equality test pins them equal until removal.
- **Context:** lib/server/routes/system.js (projection + restart route), client version-skew adapter in components/gateway.js can drop its legacy path at the same time.
- **Effort:** S.

## P3 — Watchdog health-timeline sparkline
- **What:** Small timeline strip on the watchdog page showing health-check outcomes/gateway state over the last 24h (data already persisted in watchdog_events).
- **Why:** "Was it flapping overnight?" currently requires reading incident rows one by one.
- **Effort:** S-M.

## P3 — Notification remediation-action parity
- **What:** Alerts name the primary remediation ("Repair from the Watchdog tab") with the same action vocabulary as the card's `actions[]`; today they share state labels and deep links but not the action wording.
- **Context:** Copy source: lib/server/gateway-state.js catalog + actionsForState.
- **Effort:** S.

## P3 — Downloadable redacted diagnostic bundle
- **What:** One-click export: recent watchdog events, redacted log tail, doctor summary, config (env-values masked), version/channel info.
- **Why:** "Send me diagnostics" is the support loop for self-hosters; redaction plumbing (lib/server/utils/redact.js) already exists.
- **Effort:** M.

## P3 — Browser-first recovery flows for dev-repair/backup-restore
- **What:** Guided UI flows for the recovery paths that still assume shell access (restoring a version backup, dev-channel repair after a failed build).
- **Effort:** M.

## P4 — SSE log streaming
- **What:** Push log deltas over SSE instead of the 3s delta poll.
- **Why (deferred):** Delta polling + gzip already cut the transfer to near-nothing; revisit only if log latency becomes a complaint.
- **Effort:** S.

## P4 — Operator runbook + DESIGN.md + a11y audit
- **What:** Full operator runbook doc (state glossary → remediation per state); DESIGN.md via /design-consultation capturing the status-surface design system; app-wide accessibility audit extending the Gateway-card live-region/reduced-motion work to the rest of the UI.
- **Effort:** M each.

## P3 — Verify sendChatAction deleted-topic semantics; optional opt-in liveness probe
- **What:** On wintermute, call `sendChatAction` with a `message_thread_id` of a deleted forum topic and record whether Telegram returns a distinct thread-not-found error (reports exist of `ok: true` regardless). If it errors distinctly, consider an opt-in, low-frequency background probe for topics that never receive sends (default off — probes show "bot is typing…" to group members).
- **Why:** Lazy stale-marking (shipped) only fires on real send failures; never-posted-to topics stay unverified.
- **Context:** `isMissingTopicError` (lib/server/routes/telegram.js) is the error matcher; the per-topic "verify now" UI button covers on-demand checks regardless of this TODO.
- **Effort:** S. **Depends on:** telegram-topics-discovery shipping (docs/designs/telegram-topics-discovery.md).

## P3 — Redact inline secrets from JSON5/broken openclaw.json in restart evidence
- **What:** `collectSecretValues({configObjects})` gets the parsed openclaw.json; when the config is JSON5-flavored (or unparseable), `readOpenclawConfig` falls back to `{}` and inline tokens echoed to gateway stderr are not masked in restart-failure evidence. Env/env-file secrets still redact.
- **Why:** Same evidence-honesty goal as the shipped inline-JSON redaction; JSON5 configs are the remaining gap (needs a JSON5 parser or openclaw's own reader).
- **Context:** lib/server/routes/system.js redactEvidenceTail, lib/server/utils/redact.js. Surfaced (unverified severity) by the branch adversarial review, 2026-08-28.
- **Effort:** S once config.patch/openclaw reader migration (below) lands — likely subsumed by it.

## P3 — Migrate openclaw.json writes to openclaw's config.patch RPC
- **What:** Replace alphaclaw's direct read-modify-write of openclaw.json (syncConfigForTelegram et al) with openclaw's `config.patch` gateway RPC.
- **Why:** openclaw's writer natively handles JSON5, `${ENV}` refs, `$include`, snapshot-hash conflict detection, and rolling backups — alphaclaw's JSON.parse/writeFileSync cannot. Fail-closed reads (shipped with topics-discovery) prevent wipes but refuse to sync JSON5-flavored configs; config.patch would sync them correctly.
- **Context:** Surfaced by /plan-eng-review outside voice (E2) on the telegram-topics-discovery plan. openclaw's writer: dist io chunk `writeConfigFileLocal`; alphaclaw reader: lib/server/openclaw-config.js.
- **Effort:** M (→S with CC). **Depends on:** telegram-topics-discovery shipping; verify `gateway call config.patch` surface.
