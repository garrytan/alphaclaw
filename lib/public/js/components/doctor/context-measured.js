import { h } from "preact";
import htm from "htm";
import { Badge } from "../badge.js";
import { formatInteger, formatRelativeTime } from "../../lib/format.js";

const html = htm.bind(h);

// Same heuristic as OpenClaw's /context (estimateTokensFromChars).
const approxTokens = (chars) => Math.ceil(Math.max(0, Number(chars) || 0) / 4);
const formatCharsWithTokens = (chars) =>
  `${formatInteger(chars)} chars (~${formatInteger(approxTokens(chars))} tok)`;

const kSessionKindCopy = {
  main: "main session",
  direct: "direct chat",
  group: "group chat",
  cron: "cron run",
  subagent: "subagent run",
};

const kUnavailableCopy = {
  no_run: "No run recorded yet for this agent. Send it a message, then refresh.",
  gateway: "The gateway did not answer. Check that it is running, then refresh.",
  unsupported: "This OpenClaw version does not report per-run context. The estimate below still applies.",
};

export const buildMeasuredContextModel = (measured = null, { nowMs = Date.now() } = {}) => {
  if (!measured || typeof measured !== "object") return null;
  if (measured.available !== true) {
    return {
      available: false,
      message: kUnavailableCopy[measured.reason] || kUnavailableCopy.gateway,
    };
  }
  const files = Array.isArray(measured.files) ? measured.files : [];
  const filesTotal = Number(measured.filesTotal?.injectedChars || 0);
  const systemChars = Number(measured.systemPrompt?.chars || 0);
  const rows = files
    .filter((file) => !file.missing)
    .map((file) => {
      const verified = file.verified !== false;
      const chars = verified ? Number(file.injectedChars || 0) : Number(file.rawChars || 0);
      return {
        key: file.path,
        path: file.path,
        managed: file.managed === true,
        chars,
        detail: verified
          ? `${formatCharsWithTokens(chars)}${file.truncated ? ` of ${formatInteger(file.rawChars)}` : ""}`
          : `${formatInteger(file.rawChars)} chars on disk`,
        share: verified && filesTotal > 0 ? Math.round((chars / filesTotal) * 100) : null,
        state: !verified ? "unverified" : file.truncated ? "truncated" : "ok",
      };
    })
    .sort((a, b) => b.chars - a.chars);
  const skills = measured.skills || {};
  const tools = measured.tools || {};
  return {
    available: true,
    summary: `${formatCharsWithTokens(systemChars)} system prompt`,
    meta: [
      kSessionKindCopy[measured.sessionKind] || kSessionKindCopy.direct,
      [measured.provider, measured.model].filter(Boolean).join("/"),
      measured.generatedAt ? formatRelativeTime(measured.generatedAt, { nowMs, style: "long" }) : "",
    ]
      .filter(Boolean)
      .join(" · "),
    rows,
    lines: [
      { label: "Workspace files (Project Context)", value: formatCharsWithTokens(filesTotal) },
      {
        label: "AlphaClaw's own files",
        value: formatCharsWithTokens(measured.filesTotal?.managedInjectedChars || 0),
      },
      {
        label: `Skills list (${formatInteger(skills.count || 0)} skills)`,
        value: formatCharsWithTokens(skills.promptChars || 0),
      },
      {
        label: `Tool schemas (${formatInteger(tools.count || 0)} tools)`,
        value: formatCharsWithTokens(tools.schemaChars || 0),
      },
    ],
    unverifiedFiles: Number(measured.filesTotal?.unverifiedFiles || 0),
  };
};

const kRowChips = {
  truncated: { tone: "danger", label: "Truncated" },
  unverified: { tone: "neutral", label: "Unverified" },
};

export const MeasuredContextCard = ({
  measured = null,
  loading = false,
  error = null,
  onOpenFile = () => {},
  highlighted = false,
  nowMs = Date.now(),
}) => {
  const model = buildMeasuredContextModel(measured, { nowMs });
  const shell = (body) => html`
    <div
      class=${`bg-surface border ${
        highlighted ? "border-cyan-500/60" : "border-border"
      } rounded-xl p-4 space-y-3`}
    >
      ${body}
    </div>
  `;
  if (!model) {
    return shell(html`
      <h2 class="card-label">Measured context (last run)</h2>
      <p class="text-xs text-fg-muted">
        ${error ? String(error.message || error) : loading ? "Loading…" : kUnavailableCopy.gateway}
      </p>
    `);
  }
  if (!model.available) {
    return shell(html`
      <h2 class="card-label">Measured context (last run)</h2>
      <p class="text-xs text-fg-muted">${model.message}</p>
    `);
  }
  return shell(html`
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="card-label">Measured context (last run)</h2>
      <span class="text-xs text-fg-muted">${model.summary}</span>
    </div>
    <p class="text-xs text-fg-dim">${model.meta}</p>
    <div class="space-y-2">
      ${model.rows.map(
        (row) => html`
          <div key=${row.key} class="flex items-center justify-between gap-3 text-xs">
            <span class="flex items-center gap-2 min-w-0">
              <button
                type="button"
                class="font-mono text-body ac-tip-link hover:underline text-left cursor-pointer truncate"
                onClick=${() => onOpenFile(row.path)}
              >
                ${row.path}
              </button>
              ${row.managed ? html`<${Badge} tone="info">AlphaClaw<//>` : null}
            </span>
            <span class="flex items-center gap-3 whitespace-nowrap">
              <span class="text-fg-muted">${row.detail}</span>
              ${row.share !== null ? html`<span class="text-fg-dim">${row.share}%</span>` : null}
              ${kRowChips[row.state]
                ? html`<${Badge} tone=${kRowChips[row.state].tone}>${kRowChips[row.state].label}<//>`
                : null}
            </span>
          </div>
        `,
      )}
    </div>
    <div class="border-t border-border pt-2 space-y-1">
      ${model.lines.map(
        (line) => html`
          <div key=${line.label} class="flex items-center justify-between gap-3 text-xs">
            <span class="text-fg-muted">${line.label}</span>
            <span class="text-fg-muted whitespace-nowrap">${line.value}</span>
          </div>
        `,
      )}
    </div>
    ${model.unverifiedFiles > 0
      ? html`<p class="text-xs text-fg-muted">
          ${formatInteger(model.unverifiedFiles)} file(s) are injected by a native harness that does not report
          injected sizes; their size on disk is shown.
        </p>`
      : null}
    <p class="text-xs text-fg-dim leading-5">
      Recorded by OpenClaw for this run. Token counts are approximate (chars ÷ 4). Per-session detail: 
      <a class="ac-tip-link hover:underline" href="/openclaw/usage" target="_blank" rel="noopener noreferrer"
        >OpenClaw Usage</a
      >.
    </p>
  `);
};
