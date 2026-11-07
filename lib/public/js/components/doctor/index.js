import { h } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import htm from "htm";
import { usePolling } from "../../hooks/usePolling.js";
import {
  fetchDoctorCards,
  fetchDoctorStatus,
  fetchDoctorRuns,
  startDoctorRun,
  updateDoctorCardStatus,
} from "../../lib/api.js";
import { formatLocaleDateTime } from "../../lib/format.js";
import { ActionButton } from "../action-button.js";
import { LoadingSpinner } from "../loading-spinner.js";
import { RoutePageHeader } from "../page-header.js";
import { AsyncSection } from "../async-section.js";
import { InlineErrorChip } from "../inline-error-chip.js";
import { showToast } from "../toast.js";
import { DoctorFindingsList } from "./findings-list.js";
import { DoctorFixCardModal } from "./fix-card-modal.js";
import { ContextInjectionPanel } from "./context-injection-panel.js";
import { DoctorScheduledScans } from "./scheduled-scans.js";
import {
  buildDoctorRunMarkers,
  buildDoctorPriorityCounts,
  formatGatewayNotReadyMessage,
  getDoctorBootstrapTruncationItems,
  getDoctorBootstrapWarningTitle,
  getDoctorChangeLabel,
  getDoctorScanLimitedLine,
  getDoctorNoChangesNote,
  getDoctorRunDisabledReason,
  getDoctorRunPillDetail,
  getGatewayNotReadyMessage,
  groupDoctorCardsByStatus,
  hasDoctorBootstrapWarnings,
  resolveDoctorFocus,
  shouldShowDoctorWarning,
} from "./helpers.js";
import { readHashQueryParam } from "../../lib/hash-query.js";
import { buildDoctorHeadline } from "./headline-model.js";

const html = htm.bind(h);

const kIdlePollMs = 15000;
const kActivePollMs = 2000;

export const DoctorTab = ({ isActive = false, onOpenFile = () => {} }) => {
  const statusPoll = usePolling(fetchDoctorStatus, kIdlePollMs, {
    enabled: isActive,
  });
  const doctorStatus = statusPoll.data?.status || null;
  const runPollIntervalMs = doctorStatus?.runInProgress
    ? kActivePollMs
    : kIdlePollMs;
  const runsPoll = usePolling(() => fetchDoctorRuns(10), runPollIntervalMs, {
    enabled: isActive,
  });
  const [selectedRunFilter, setSelectedRunFilter] = useState("all");
  // { cardId, status } while a status update is in flight — drives the
  // clicked button's pending label and disables that card's sibling actions.
  const [busyAction, setBusyAction] = useState(null);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [fixCard, setFixCard] = useState(null);
  const [pendingRunSelectionId, setPendingRunSelectionId] = useState("");

  const runs = runsPoll.data?.runs || [];
  const activeRunId = String(doctorStatus?.activeRunId || "");
  const selectedRunId = String(selectedRunFilter || "");
  const shouldRenderPendingRunTab =
    selectedRunId !== "" &&
    selectedRunId !== "all" &&
    !runs.some((run) => String(run.id || "") === selectedRunId) &&
    (pendingRunSelectionId === selectedRunId ||
      (doctorStatus?.runInProgress && activeRunId === selectedRunId));
  const pendingRun = shouldRenderPendingRunTab
    ? {
        id: Number(selectedRunId || 0),
        status: "running",
        summary: "",
        priorityCounts: { P0: 0, P1: 0, P2: 0 },
        statusCounts: { open: 0, working: 0, dismissed: 0, fixed: 0 },
      }
    : null;
  const displayRuns = pendingRun ? [pendingRun, ...runs] : runs;
  const selectedRunIsActiveRun =
    selectedRunFilter !== "all" &&
    !!activeRunId &&
    String(selectedRunFilter || "") === activeRunId;
  const selectedRun =
    selectedRunFilter === "all"
      ? null
      : displayRuns.find(
          (run) => String(run.id || "") === String(selectedRunFilter || ""),
        ) || null;
  const cardsPoll = usePolling(
    () => fetchDoctorCards({ runId: selectedRunFilter || "all" }),
    doctorStatus?.runInProgress || selectedRun?.status === "running"
      ? kActivePollMs
      : kIdlePollMs,
    { enabled: isActive },
  );
  const allCards = cardsPoll.data?.cards || [];

  useEffect(() => {
    if (!runs.length) {
      if (pendingRunSelectionId && selectedRunId === pendingRunSelectionId)
        return;
      if (selectedRunIsActiveRun && doctorStatus?.runInProgress) return;
      if (selectedRunFilter !== "all") setSelectedRunFilter("all");
      return;
    }
    if (selectedRunFilter === "all") return;
    const hasSelectedRun = runs.some(
      (run) => String(run.id || "") === String(selectedRunFilter || ""),
    );
    if (hasSelectedRun) return;
    if (selectedRunIsActiveRun && doctorStatus?.runInProgress) return;
    setSelectedRunFilter("all");
  }, [
    runs,
    selectedRunId,
    selectedRunFilter,
    selectedRunIsActiveRun,
    pendingRunSelectionId,
    doctorStatus?.runInProgress,
  ]);

  useEffect(() => {
    if (!pendingRunSelectionId) return;
    if (selectedRunFilter !== pendingRunSelectionId) {
      setSelectedRunFilter(pendingRunSelectionId);
      return;
    }
    const hasPendingRun = runs.some(
      (run) => String(run.id || "") === String(pendingRunSelectionId || ""),
    );
    const activePendingRun =
      !!activeRunId &&
      activeRunId === pendingRunSelectionId &&
      !!doctorStatus?.runInProgress;
    if (!hasPendingRun && !activePendingRun) return;
    setPendingRunSelectionId("");
  }, [
    activeRunId,
    doctorStatus?.runInProgress,
    pendingRunSelectionId,
    runs,
    selectedRunFilter,
  ]);

  // usePolling already fetches on mount; only filter *changes* need an
  // immediate out-of-band refresh.
  const cardsFilterMountedRef = useRef(false);
  useEffect(() => {
    if (!cardsFilterMountedRef.current) {
      cardsFilterMountedRef.current = true;
      return;
    }
    cardsPoll.refresh();
  }, [selectedRunFilter]);

  // #/doctor?focus=context (the General hardening card's CTA): scroll to the
  // context section once as it mounts; when the cards poll later surfaces a
  // fresh open det:hardening:* finding, highlight it WITHOUT re-scrolling.
  // Param consumed once per navigation; it stays in the hash so a refresh
  // re-scrolls (the #/watchdog?incident= precedent). Highlight persists until
  // navigation — never a timed fade that vanishes mid-read.
  // Read live (cheap string parse): navigating to plain #/doctor keeps this
  // Route mounted, so the param must be re-read to clear the persistent
  // highlight when it leaves the hash.
  const focusParam =
    typeof window === "undefined"
      ? ""
      : readHashQueryParam(window.location.hash, "focus");
  const focusScrolledRef = useRef(false);
  const [focusHighlightCardId, setFocusHighlightCardId] = useState("");
  const latestCompletedRunId = useMemo(
    () =>
      Number(
        (runs.find((run) => String(run.status || "") === "completed") || {}).id ||
          0,
      ),
    [runs],
  );
  useEffect(() => {
    if (focusParam !== "context") {
      // Param left the hash (in-tab navigation): the "persistent until
      // navigation" highlight ends now, and a re-entry re-scrolls.
      if (focusHighlightCardId) setFocusHighlightCardId("");
      focusScrolledRef.current = false;
      return;
    }
    const resolved = resolveDoctorFocus({
      focusParam,
      cards: allCards,
      latestCompletedRunId,
    });
    if (
      resolved.scrollTarget &&
      !focusScrolledRef.current &&
      typeof document !== "undefined"
    ) {
      const section = document.getElementById(resolved.scrollTarget);
      // The wrapper div can exist while the meter inside is still null —
      // don't consume the one-shot scroll on an empty placeholder.
      if (
        section &&
        section.childElementCount > 0 &&
        typeof section.scrollIntoView === "function"
      ) {
        focusScrolledRef.current = true;
        const reducedMotion =
          typeof window !== "undefined" &&
          window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        section.scrollIntoView({
          block: "center",
          behavior: reducedMotion ? "auto" : "smooth",
        });
      }
    }
    if (!focusHighlightCardId && resolved.highlightCardId) {
      setFocusHighlightCardId(resolved.highlightCardId);
    }
  }, [focusParam, doctorStatus, allCards, latestCompletedRunId, focusHighlightCardId]);

  const selectedRunIsInProgress =
    selectedRun?.status === "running" ||
    (selectedRunIsActiveRun && doctorStatus?.runInProgress);
  const selectedRunSummary = useMemo(
    () => (selectedRunIsInProgress ? "" : selectedRun?.summary || ""),
    [selectedRun, selectedRunIsInProgress],
  );
  const changeLabel = useMemo(
    () => getDoctorChangeLabel(doctorStatus?.changeSummary || null),
    [doctorStatus],
  );
  const runDoctorDisabledReason = useMemo(
    () => getDoctorRunDisabledReason(doctorStatus),
    [doctorStatus],
  );
  const canRunDoctor = !runDoctorDisabledReason;
  const gatewayNotReadyNote = useMemo(
    () => getGatewayNotReadyMessage(doctorStatus),
    [doctorStatus],
  );
  // Informational only — the button stays ENABLED on zero changes (the
  // server runs a cheap reuse pass that re-evaluates environment checks).
  // Suppressed while the gateway banner already explains the disabled state.
  const noChangesNote = useMemo(
    () => getDoctorNoChangesNote(doctorStatus),
    [doctorStatus],
  );
  const runButtonNote = gatewayNotReadyNote ? "" : noChangesNote;
  const showDoctorStaleBanner = useMemo(
    () => shouldShowDoctorWarning(doctorStatus, 0),
    [doctorStatus],
  );
  const showBootstrapTruncationBanner = useMemo(
    () => hasDoctorBootstrapWarnings(doctorStatus),
    [doctorStatus],
  );
  const bootstrapTruncationMessage = useMemo(
    () => getDoctorBootstrapWarningTitle(doctorStatus),
    [doctorStatus],
  );
  const bootstrapTruncationItems = useMemo(
    () => getDoctorBootstrapTruncationItems(doctorStatus),
    [doctorStatus],
  );
  const hasCompletedDoctorRun = !!doctorStatus?.lastRunAt;
  const hasRuns = runs.length > 0;
  const hasLoadedRuns = runsPoll.data !== null || runsPoll.error !== null;
  const hasLoadedCards = cardsPoll.data !== null || cardsPoll.error !== null;
  const showInitialLoadingState =
    !hasLoadedRuns || (hasRuns && !hasLoadedCards);
  const groupedCards = useMemo(() => groupDoctorCardsByStatus(allCards), [allCards]);
  const visibleRuns = useMemo(() => displayRuns.slice(0, 2), [displayRuns]);
  const overflowRuns = useMemo(() => displayRuns.slice(2), [displayRuns]);
  const selectedOverflowRunValue = useMemo(() => {
    if (selectedRunFilter === "all") return "";
    return overflowRuns.some(
      (run) => String(run.id || "") === String(selectedRunFilter || ""),
    )
      ? String(selectedRunFilter || "")
      : "";
  }, [overflowRuns, selectedRunFilter]);

  const getRunTabClassName = (selected = false) =>
    [
      "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
      selected
        ? "border-cyan-500/40 bg-cyan-500/10 text-status-info shadow-[0_0_0_1px_rgba(34,211,238,0.08)]"
        : "border-border bg-field text-body hover:border-fg-muted hover:text-bright",
    ].join(" ");

  const getRunMarkerClassName = (tone = "neutral") => {
    if (tone === "success") return "bg-green-400";
    if (tone === "warning") return "bg-yellow-400";
    if (tone === "danger") return "bg-red-400";
    if (tone === "cyan") return "ac-status-dot ac-status-dot--info";
    return "bg-gray-500";
  };
  const showRunLayout =
    !showInitialLoadingState &&
    (runs.length > 0 ||
      !!pendingRunSelectionId ||
      !!activeRunId ||
      !!doctorStatus?.runInProgress);

  const handleRunDoctor = async () => {
    if (isStartingRun) return;
    setIsStartingRun(true);
    try {
      const result = await startDoctorRun();
      showToast(
        result?.reusedPreviousRun
          ? "No workspace changes since the last scan; reused previous findings"
          : "Doctor run started",
        "success",
      );
      if (result?.runId) {
        const runId = String(result.runId);
        setPendingRunSelectionId(runId);
        setSelectedRunFilter(runId);
      }
      // Hold "Starting..." until this status refresh lands so the button
      // hands off to runInProgress ("Running...") without an idle flash.
      await statusPoll.refresh();
      runsPoll.refresh();
      cardsPoll.refresh();
      setTimeout(statusPoll.refresh, 1200);
      setTimeout(runsPoll.refresh, 1200);
      setTimeout(cardsPoll.refresh, 1200);
    } catch (error) {
      const message = error?.gatewayUnavailable
        ? error.reason
          ? formatGatewayNotReadyMessage(error.reason)
          : error.message || "Could not start Doctor run"
        : error.message || "Could not start Doctor run";
      showToast(message, "error");
      statusPoll.refresh();
    } finally {
      setIsStartingRun(false);
    }
  };

  const handleUpdateStatus = async (card, status) => {
    if (!card?.id || busyAction) return;
    try {
      setBusyAction({ cardId: card.id, status });
      await updateDoctorCardStatus({ cardId: card.id, status });
      showToast("Doctor card updated", "success");
      await cardsPoll.refresh();
      await runsPoll.refresh();
      await statusPoll.refresh();
    } catch (error) {
      showToast(error.message || "Could not update Doctor card", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const runDoctorButtonLoading =
    isStartingRun || !!doctorStatus?.runInProgress || showInitialLoadingState;
  const runDoctorButtonLoadingLabel = isStartingRun
    ? "Starting..."
    : doctorStatus?.runInProgress
      ? "Running..."
      : "Loading...";

  const latestRun = displayRuns.find((run) => String(run?.status || "") !== "running") || null;
  const latestRunFailed = String(latestRun?.status || "") === "failed";
  const headline = buildDoctorHeadline({
    doctorStatus,
    runs: hasLoadedRuns && !runsPoll.error ? runs : runsPoll.data ? runs : null,
    nowMs: Date.now(),
  });
  const openFindings = [...groupedCards.open, ...groupedCards.working];
  const closedFindings = [...groupedCards.fixed, ...groupedCards.dismissed];
  const priorityCounts = buildDoctorPriorityCounts(groupedCards.open);
  const findingRows = (list, emptyHidden) => html`<${DoctorFindingsList}
    cards=${list}
    busyAction=${busyAction}
    onAskAgentFix=${setFixCard}
    onUpdateStatus=${handleUpdateStatus}
    onOpenFile=${onOpenFile}
    changedPaths=${doctorStatus?.changeSummary?.changedPaths || []}
    showRunMeta=${selectedRunFilter === "all"}
    hideEmptyState=${emptyHidden}
    highlightCardId=${focusHighlightCardId}
  />`;

  return html`
    <div class="doctor briefing">
      <${RoutePageHeader}
        routeId="doctor"
        actions=${html`
          <div class="flex flex-col items-end gap-1">
            <${ActionButton}
              onClick=${handleRunDoctor}
              disabled=${!canRunDoctor}
              loading=${runDoctorButtonLoading}
              tone="solid"
              size="md"
              idleLabel="Run Doctor"
              loadingLabel=${runDoctorButtonLoadingLabel}
              title=${runDoctorDisabledReason}
            />
            ${runButtonNote
              ? html`<p class="text-xs text-fg-muted leading-5 text-right">${runButtonNote}</p>`
              : null}
          </div>
        `}
      />
      <p class="briefing-headline" aria-live="polite">${headline}</p>
      ${hasCompletedDoctorRun
        ? html`
            <p class="briefing-facts">
              Last run <span class="font-mono">${formatLocaleDateTime(doctorStatus?.lastRunAt, { fallback: "Never" })}</span>
              <span aria-hidden="true"> · </span>
              ${changeLabel}
              ${doctorStatus?.changeSummary?.workspaceLimited
                ? html`<span class="block text-fg-dim">
                    ${getDoctorScanLimitedLine(doctorStatus?.workspaceScan)}
                    ${" "}Changes in files beyond the cap are not detected.${" "}
                    <a
                      href="#doctor-scan-limits"
                      class="ac-tip-link"
                      onClick=${(event) => {
                        event.preventDefault();
                        document
                          .getElementById("doctor-scan-limits")
                          ?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }}
                      >Adjust scan limits</a
                    >
                  </span>`
                : null}
            </p>
          `
        : null}
      ${latestRunFailed
        ? html`<${InlineErrorChip}
            error=${latestRun?.error || null}
            headline=${headline}
            onRetry=${canRunDoctor && !runDoctorButtonLoading ? handleRunDoctor : null}
            retryLabel="Run Doctor again"
          />`
        : null}
      ${gatewayNotReadyNote
        ? html`
            <div
              class="text-xs text-status-warning bg-yellow-500/10 border border-yellow-500/35 rounded-lg px-3 py-2"
            >
              ${gatewayNotReadyNote}
            </div>
          `
        : null}
      ${showDoctorStaleBanner && hasRuns
        ? html`
            <div
              class="text-xs text-status-warning bg-yellow-500/10 border border-yellow-500/35 rounded-lg px-3 py-2"
            >
              Doctor should be run again because the latest completed run is
              older than one week and the workspace has changed.
            </div>
          `
        : null}
      ${showBootstrapTruncationBanner && hasRuns && hasCompletedDoctorRun
        ? html`
            <section class="briefing-section" aria-label="Truncated bootstrap files">
              <p class="text-sm text-status-warning-muted">${bootstrapTruncationMessage}</p>
              <div class="space-y-2">
                ${bootstrapTruncationItems.map(
                  (item) => html`
                    <div class="flex items-center justify-between gap-3 text-xs">
                      <button
                        type="button"
                        class="font-mono text-body ac-tip-link hover:underline text-left cursor-pointer"
                        onClick=${() => onOpenFile(String(item.path || ""))}
                      >
                        ${item.path}
                      </button>
                      <span class="flex items-center gap-3 whitespace-nowrap">
                        <span class="text-fg-muted">${item.size}</span>
                        <span class=${item.statusTone === "warning" ? "text-status-warning" : "text-status-error"}>
                          ${item.statusText}
                        </span>
                      </span>
                    </div>
                  `,
                )}
              </div>
              <p class="text-xs text-fg-muted leading-5">
                Truncated files become partially hidden from your agent and could cause drift.
              </p>
            </section>
          `
        : null}

      <section class="briefing-section" aria-labelledby="doctor-context-title">
        <div class="briefing-section-head">
          <h2 class="briefing-section-title" id="doctor-context-title">Context per turn</h2>
        </div>
        <div id="doctor-context-section">
          <${ContextInjectionPanel}
            doctorStatus=${doctorStatus}
            onOpenFile=${onOpenFile}
            highlighted=${focusParam === "context" && !focusHighlightCardId}
          />
        </div>
      </section>

      <section class="briefing-section" aria-labelledby="doctor-findings-title">
        <div class="briefing-section-head">
          <h2 class="briefing-section-title" id="doctor-findings-title">Findings</h2>
          ${showRunLayout && openFindings.length
            ? html`<p class="briefing-section-caption">
                ${openFindings.length} open · ${priorityCounts.P0} P0 · ${priorityCounts.P1} P1 · ${priorityCounts.P2} P2
              </p>`
            : null}
        </div>
        ${showRunLayout
          ? html`
              <div class="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  class=${getRunTabClassName(selectedRunFilter === "all")}
                  onClick=${() => setSelectedRunFilter("all")}
                >
                  <span class="font-medium">All runs</span>
                </button>
                ${visibleRuns.map((run) => {
                  const selected = String(selectedRunFilter || "") === String(run.id || "");
                  const markers = buildDoctorRunMarkers(run);
                  return html`
                    <button
                      key=${run.id}
                      type="button"
                      class=${getRunTabClassName(selected)}
                      onClick=${() => setSelectedRunFilter(String(run.id || ""))}
                    >
                      <span class="font-medium">Run #${run.id}</span>
                      <span class="inline-flex items-center gap-1">
                        ${markers.map(
                          (marker) => html`
                            <span class="inline-flex items-center" title=${marker.label}>
                              <span
                                class=${getRunMarkerClassName(marker.tone).startsWith("ac-status-dot")
                                  ? getRunMarkerClassName(marker.tone)
                                  : `h-2 w-2 rounded-full ${getRunMarkerClassName(marker.tone)}`}
                              ></span>
                            </span>
                          `,
                        )}
                      </span>
                    </button>
                  `;
                })}
                ${overflowRuns.length
                  ? html`
                      <select
                        aria-label="Show an older run"
                        value=${selectedOverflowRunValue}
                        onChange=${(event) => {
                          const nextValue = String(event.currentTarget?.value || "");
                          if (!nextValue) return;
                          setSelectedRunFilter(nextValue);
                        }}
                        class="bg-field border rounded-full px-3 py-1.5 text-xs text-body focus:border-fg-muted"
                      >
                        <option value="">More runs</option>
                        ${overflowRuns.map(
                          (run) => html`
                            <option value=${String(run.id || "")}>
                              Run #${run.id} · ${getDoctorRunPillDetail(run)}
                            </option>
                          `,
                        )}
                      </select>
                    `
                  : null}
              </div>
              ${selectedRunSummary
                ? html`
                    <div class="space-y-1">
                      <p class="text-xs text-fg-muted">
                        ${selectedRun?.id ? `Run #${selectedRun.id} summary` : "Run summary"}
                      </p>
                      <p class="text-sm text-body leading-5">${selectedRunSummary}</p>
                    </div>
                  `
                : null}
              ${selectedRunIsInProgress
                ? html`
                    <div class="flex items-center gap-2 text-sm text-fg-muted" role="status">
                      <${LoadingSpinner} className="h-3.5 w-3.5" />
                      <span>Run in progress. Findings will appear when analysis completes.</span>
                    </div>
                  `
                : null}
            `
          : null}
        ${allCards.length > 0 && cardsPoll.error
          ? html`<${InlineErrorChip}
              error=${cardsPoll.error}
              headline="Couldn't refresh findings — showing the last loaded list."
              onRetry=${cardsPoll.refresh}
            />`
          : null}
        <${AsyncSection}
          loading=${showInitialLoadingState && !runsPoll.error && !cardsPoll.error}
          loadingLabel="Loading…"
          error=${(!hasRuns && runsPoll.error && !runsPoll.data) || (hasRuns && cardsPoll.error && allCards.length === 0)
            ? runsPoll.error || cardsPoll.error
            : null}
          errorHeadline="Couldn't load Doctor's findings."
          onRetry=${() => {
            runsPoll.refresh();
            cardsPoll.refresh();
          }}
          empty=${!showRunLayout}
          emptyTitle="No findings yet"
          emptyBody="Doctor scans the workspace for guidance drift, misplaced instructions, redundant docs and cleanup opportunities. It runs on your main agent and uses tokens, and nothing changes without your approval."
        >
          ${findingRows(openFindings, selectedRunIsInProgress || closedFindings.length > 0)}
          ${closedFindings.length
            ? html`
                <details class="briefing-disclosure" data-disclosure="closed-findings">
                  <summary class="briefing-disclosure-summary">
                    Fixed or dismissed (${closedFindings.length})
                  </summary>
                  <div class="mt-3">${findingRows(closedFindings, true)}</div>
                </details>
              `
            : null}
        </${AsyncSection}>
      </section>

      ${doctorStatus
        ? html`<${DoctorScheduledScans} doctorStatus=${doctorStatus} />`
        : null}
      <${DoctorFixCardModal}
        visible=${!!fixCard}
        card=${fixCard}
        onClose=${() => setFixCard(null)}
        onComplete=${async () => {
          await statusPoll.refresh();
          await runsPoll.refresh();
          await cardsPoll.refresh();
        }}
      />
    </div>
  `;
};
