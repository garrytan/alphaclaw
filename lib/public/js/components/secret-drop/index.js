import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { InlineErrorChip } from "../inline-error-chip.js";
import { LoadingSpinner } from "../loading-spinner.js";
import { formatLocaleTime } from "../../lib/format.js";

const html = htm.bind(h);

// The secret drop page (/secret/<token>, routes/secret-drop.js): one form,
// one Save. The value lives only in this component and the Save's POST body;
// it is never logged, put in a URL or read back from the server.

const kInputClass =
  "w-full bg-field border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-fg-muted text-body";
const kCardClass = "bg-surface border border-border rounded-xl p-5 space-y-3";
const kNoAnswer = "The save got no answer, so it may not have run. Press Retry; saving again is safe.";

const readJson = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

const fetchLink = async (token) => {
  try {
    const res = await fetch(`/secret/${token}/status`, { cache: "no-store", headers: { Accept: "application/json" } });
    return { status: res.status, body: await readJson(res) };
  } catch {
    return { status: 0, body: null };
  }
};

// Whether the key is usable now or only after the gateway's next start, from
// the save's reach data.
export const describeUsability = (link) => {
  const stores = link?.stores || {};
  const reach = link?.reach || {};
  if (stores.store && reach.reloaded === true) return "Usable now: OpenClaw reloaded its secrets, so the gateway already uses the new value.";
  if (stores.env) {
    return reach.env === "never"
      ? "Usable now by programs that read .env, including commands the agent runs. The gateway's own environment never gets it."
      : "Usable now by programs that read .env, including commands the agent runs. The gateway picks it up after its next start.";
  }
  if (stores.store) return "In OpenClaw's secret store now. The gateway uses it after its next start.";
  return "";
};

const Name = ({ name }) => html`<code class="text-bright">${name}</code>`;

const Details = ({ lines = [] }) =>
  lines.length
    ? html`<ul class="space-y-1">
        ${lines.map((line) => html`<li class="text-xs text-fg-muted">${line}</li>`)}
      </ul>`
    : null;

const SavedCard = ({ link }) => html`
  <section class=${kCardClass} role="status" aria-live="polite">
    <h1 class="text-heading font-semibold text-status-success">
      Saved <${Name} name=${link.name} /> at ${formatLocaleTime(link.savedAt)}
    </h1>
    <p class="text-sm text-body">${describeUsability(link)}</p>
    <${Details} lines=${[...(link.outcome || []), ...(link.notices || [])]} />
    <p class="text-xs text-fg-muted">You can close this page. The agent learns that the secret was stored, never its value.</p>
  </section>
`;

const GoneCard = ({ name = "" }) => html`
  <section class=${kCardClass} role="status">
    <h1 class="text-heading font-semibold text-bright">This link has expired</h1>
    <p class="text-sm text-body">
      Nothing was saved with it. Links work for 15 minutes; ask for a new one (for example
      <code>/secret ${name || "NAME"}</code> in Telegram).
    </p>
  </section>
`;

const PartialSummary = ({ link }) => html`
  <div class="space-y-1" role="status" aria-live="polite">
    <p class="text-sm font-medium text-status-warning">
      Partly saved at ${formatLocaleTime(link.savedAt)}: ${link.stores?.env ? "AlphaClaw's .env" : "OpenClaw's secret store"} holds it, the other store does not.
    </p>
    <p class="text-sm text-body">${describeUsability(link)}</p>
    <${Details} lines=${[...(link.outcome || []), ...(link.notices || [])]} />
  </div>
`;

export const SecretDropPage = ({ token }) => {
  const [phase, setPhase] = useState("loading");
  const [link, setLink] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [value, setValue] = useState("");
  const [multiValue, setMultiValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const savingRef = useRef(false);

  const showLink = (next) => {
    setLink(next);
    setPhase(next.status === "expired" ? "gone" : "ready");
  };

  const load = async () => {
    setLoadError(null);
    const { status, body } = await fetchLink(token);
    if (body?.ok && body.link) return showLink(body.link);
    if (status === 410) return setPhase("gone");
    setPhase("load_error");
    setLoadError({ message: body?.error || "This link could not be loaded. Check your connection, then press Retry.", signIn: status === 401 });
  };

  useEffect(() => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(token || ""))) {
      setPhase("gone");
      return;
    }
    load();
  }, [token]);

  const save = async () => {
    if (savingRef.current || !link?.csrf) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const savedBefore = link.savedAt || null;
    try {
      const fields = multiValue ? { csrf: link.csrf, value_multiline: multiValue } : { csrf: link.csrf, value };
      let res = null;
      try {
        res = await fetch(`/secret/${token}`, {
          method: "POST",
          cache: "no-store",
          headers: { Accept: "application/json" },
          body: new URLSearchParams(fields),
        });
      } catch {
        res = null;
      }
      const body = res ? await readJson(res) : null;
      if (res?.ok && body?.ok && body.link) {
        setValue("");
        setMultiValue("");
        return showLink(body.link);
      }
      if (res?.status === 410) {
        if (body?.link) return showLink(body.link);
        return setPhase("gone");
      }
      if (body?.link && (res.status === 400 || res.status === 500)) {
        showLink(body.link);
        return setError({ message: body.error || "Nothing was saved.", notices: body.notices || [] });
      }
      // No answer that says what happened (a dropped connection, a proxy's
      // error page, a sign-in that ended): ask the link itself.
      const fresh = await fetchLink(token);
      const freshLink = fresh.body?.ok ? fresh.body.link : null;
      if (freshLink && freshLink.savedAt && freshLink.savedAt !== savedBefore) {
        setValue("");
        setMultiValue("");
        return showLink(freshLink);
      }
      if (freshLink) showLink(freshLink);
      setError({ message: body?.error || kNoAnswer, signIn: res?.status === 401 || fresh.status === 401 });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const onSubmit = (event) => {
    event.preventDefault();
    save();
  };

  const signInLink = html`<a class="ac-tip-link text-xs" href=${`/login.html?next=${encodeURIComponent(`/secret/${token}`)}`} target="_blank" rel="noopener">Sign in in a new tab</a>`;

  if (phase === "loading") {
    return html`<div class="flex items-center gap-2 text-sm text-fg-muted" role="status"><${LoadingSpinner} className="h-4 w-4" /> Loading…</div>`;
  }
  if (phase === "gone") return html`<${GoneCard} name=${link?.name} />`;
  if (phase === "load_error") {
    return html`<div class="space-y-2">
      <${InlineErrorChip} error=${loadError?.message} onRetry=${load} />
      ${loadError?.signIn ? signInLink : null}
    </div>`;
  }
  if (link.status === "stored") return html`<${SavedCard} link=${link} />`;
  if (link.status === "partial_expired") {
    return html`<section class=${kCardClass}>
      <h1 class="text-heading font-semibold text-bright">Store <${Name} name=${link.name} /></h1>
      <${PartialSummary} link=${link} />
      <p class="text-xs text-fg-muted">This link has expired, so it cannot save again. Ask for a new one to finish the other store.</p>
    </section>`;
  }

  const partial = link.status === "partial";
  return html`
    <form class=${kCardClass} onSubmit=${onSubmit} autocomplete="off">
      <h1 class="text-heading font-semibold text-bright">Store <${Name} name=${link.name} /></h1>
      ${link.reason ? html`<p class="text-sm text-body">Requested for: ${link.reason}</p>` : null}
      ${partial ? html`<${PartialSummary} link=${link} />` : null}
      <p class="text-sm text-body">
        Paste the value and press Save. AlphaClaw writes it to its .env and to OpenClaw's secret store. It never goes into the chat; the agent only learns that it was stored.
      </p>
      <div class="space-y-1">
        <label for="secret-drop-value" class="block text-xs text-fg-muted">Value of ${link.name}</label>
        <input
          id="secret-drop-value"
          type="password"
          class=${kInputClass}
          value=${value}
          onInput=${(event) => setValue(event.currentTarget.value)}
          disabled=${saving || Boolean(multiValue)}
          autocomplete="off"
          spellcheck=${false}
          autocapitalize="off"
          autofocus
        />
      </div>
      <details class="text-xs text-fg-muted">
        <summary class="cursor-pointer">The value has several lines (a PEM key)</summary>
        <label for="secret-drop-multiline" class="block mt-2 mb-1">Multi-line value (saved to OpenClaw's secret store only; .env holds one line)</label>
        <textarea
          id="secret-drop-multiline"
          class=${`${kInputClass} min-h-[120px]`}
          style="-webkit-text-security: disc"
          value=${multiValue}
          onInput=${(event) => setMultiValue(event.currentTarget.value)}
          disabled=${saving}
          autocomplete="off"
          spellcheck=${false}
          autocapitalize="off"
        ></textarea>
      </details>
      ${error
        ? html`<div class="space-y-1">
            <${InlineErrorChip} error=${error.message} onRetry=${save} />
            <${Details} lines=${error.notices || []} />
            ${error.signIn ? signInLink : null}
          </div>`
        : null}
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs text-fg-muted">This link works once and expires at ${formatLocaleTime(link.expiresAt)}.</p>
        <${ActionButton}
          type="submit"
          size="md"
          tone="primary"
          loading=${saving}
          idleLabel=${partial ? "Save again" : "Save"}
          loadingLabel="Saving…"
        />
      </div>
    </form>
  `;
};
