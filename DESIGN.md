# AlphaClaw Setup UI design system

This file records how the Setup UI (`lib/public`) should look and read. It is the reference for every UI change after the ALPH-69 overhaul (GST-1697). Tokens live in `lib/public/css/theme.css` (dark values on `:root`, light values on `[data-theme="light"]`) and are exposed to Tailwind in `tailwind.config.cjs`. Use a token or its Tailwind class instead of a raw hex value, an `rgba()` literal or a raw palette class such as `text-gray-400` or `bg-yellow-500/10`.

Status of each part of this document:

| Part | Ships in |
|---|---|
| Tokens, status tones, Badge and ActionButton on tokens, contrast floor | PR 1a |
| Direction, colour budget, motion rules; token fixes for code colours, field borders, light accent-dim and the light green dot | Design consultation token PR |
| Typography switch (sans for UI text, mono for data) and the type scale applied | PR 1b |
| Accessible primitives (ModalShell dialog semantics, Tabs, SegmentedControl, focus ring) | PR 1c |
| Navigation names and grouping | PR 2b |
| General split into Home and Integrations | PR 3a |

## Direction

The Setup UI is an instrument panel for one box: a calm, cool control room where neutral surfaces carry everything and colour appears only when it means something. The one thing an operator should take away is "my box is fine, and when it isn't, AlphaClaw tells me exactly what to do next". Every choice below serves that.

- Aesthetic: industrial and utilitarian. Function first, data dense where the data is real, quiet everywhere else.
- Decoration: minimal. The faint 48 px grid behind the content column (`body::before`) is the only texture. Nothing glows, nothing has a gradient, and cards never sit inside cards.
- Voices: sans for the interface, JetBrains Mono for literal values. The mono is AlphaClaw's identity, so it is kept for the data the operator copies and for the wordmark.
- Sibling: the OpenClaw Control UI (`/openclaw`) is warm with a red accent. AlphaClaw stays cool and cyan so the operator always knows which layer they are in, and shares its 6/10 px radii and JetBrains Mono so the jump between them feels like the same box.

## Principles

- Keep the dark theme, the cyan accent and the wolf mark. The light theme is a first-class theme, so every change is checked in both.
- One page, one job. A page leads with its title, a one-line purpose and its primary action, then the thing that needs attention.
- Status is never colour alone. Pair a tone with a word or a glyph.
- Colour budget. Cyan means "you can act here" or "in progress". Green, amber and red appear only for status, always with a word. A page where nothing is wrong is neutral plus one cyan primary button, so the thing that is wrong is the only thing in colour.
- Text meets WCAG 2 AA, which is 4.5:1 for normal text and 3:1 for large text and for non-text marks such as dots and borders.

## Colour

### Surfaces and text

| Token | Tailwind | Use |
|---|---|---|
| `--bg` | (body) | Page and modal background |
| `--bg-sidebar` | `bg-surface`* | Sidebar |
| `--bg-content` | | Content column |
| `--panel-bg-contrast`, `--panel-border-contrast` | `bg-surface`, `border-border` | Cards and their borders |
| `--field-bg-contrast`, `--field-border-contrast` | `bg-field` (border from theme.css) | Inputs, selects, textareas. Give them `border` for the width and no `border-border`, whose `!important` would replace the field border. |
| `--text-bright` | `text-bright` | Headings and values that must stand out |
| `--text` | `text-body` | Body text |
| `--text-muted` | `text-fg-muted` | Secondary text, labels, metadata |
| `--text-dim` | `text-fg-dim`, `placeholder-fg-dim` | Tertiary text and placeholders |
| `--accent` | `text-accent`, `bg-accent`, `border-accent` | Brand cyan for links, active states and progress |
| `--accent-dim`, `--accent-link` | `border-accent-dim`, `text-accent-link` | Accent borders and inline links |
| `--focus-ring` | (theme.css rule) | Keyboard focus ring on buttons, links, tabs and inputs |

\* `.bg-surface` is redefined in `theme.css` as the card treatment.

Contrast floor (PR 1a). `--text-muted` and `--text-dim` both measure at least 4.5:1 on the page, the sidebar, a card and a neutral badge tint in both themes. Dim stays one step below muted, so the hierarchy holds without dropping under the floor.

| Token | Dark | Light |
|---|---|---|
| `--text-muted` | `#9198a1` (6.1:1 on a card) | `#57606a` (5.8:1 on a card) |
| `--text-dim` | `#848d97` (5.3:1 on a card) | `#5f6873` (5.1:1 on a card) |
| `--accent` | `#63ebff` | `#0e7490` (was `#0891b2`, 3.7:1 on white) |

Non-text marks (WCAG 1.4.11, 3:1 against the surface they sit on). Measured on the page, sidebar, content column, card and field surfaces; the lowest value is shown.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--field-border-contrast` | `#626d7c` (3.3:1, was 1.5:1) | `#7a8491` (3.3:1, was 1.4:1) | Edge of inputs, selects, textareas, toggle tracks |
| `--accent-dim` | `rgba(99,235,255,0.4)` (3.0:1) | `#3f93a8` (3.2:1, was 1.4:1) | Completed-step connectors, quote rules |
| `--gateway-dot-*` | gray 3.6, green 7.5, cyan 9.5, yellow 8.9, red 4.6 | gray 6.7, green `#15803d` 4.5 (was `#16a34a`, 2.9 on the sidebar), cyan 3.3, yellow 4.4, red 4.3 | Status dots, including the global status chip in the sidebar |

Card and divider borders (`--border`, `--panel-border-contrast`) and tone borders on badges stay below 3:1 on purpose: they are decorative, because the content or the word carries the meaning. A border that is the only way to see a control uses `--field-border-contrast`.

Code colours (file viewer syntax highlighting) meet the text floor on the content, card and field surfaces: `--comment` is `#8b949e` dark (5.6:1, was 3.6:1) and `#5f6873` light (5.0:1, was 2.3:1); light `--keyword` is `#b91c1c` (5.7:1, was `#dc2626` at 4.2:1 on a field) and light `--number` is `#0369a1` (5.2:1, was `#0284c7` at 3.6:1). Dark `--keyword`, `--string`, `--number` and light `--string` already pass and are unchanged.

Planned tokens, added by the PR that first uses them:

| Token | Dark | Light | Added in |
|---|---|---|---|
| `--on-accent` | `#0d121b` (13.3:1 on accent) | `#ffffff` (5.4:1 on accent) | The PR that ships the solid primary button (PageHeader, PR 2b) |
| `--focus-ring` | `#63ebff` (12.1:1) | `#0e7490` (4.7:1) | PR 1c. A 2 px outline with a 2 px offset on `:focus-visible`. Today's `focus-visible:ring-border` ring measures 1.2:1 and is replaced. |

Do not lower text with `opacity` to make it look secondary. An opacity of 0.7 on muted text drops it under 4.5:1. Use `text-fg-muted` or `text-fg-dim` instead. Disabled controls are exempt from the contrast rule and keep `opacity-50`.

### Status tones

One set of five tones covers Badge, ActionButton, status dots and callouts. Each tone has a foreground, a tint and a border. The foreground is at least 4.5:1 on its own tint over a card in both themes.

| Tone | Meaning | Foreground | Tint | Border | Tailwind |
|---|---|---|---|---|---|
| ok | Healthy, done, connected | `--tone-ok` | `--tone-ok-bg` | `--tone-ok-border` | `text-tone-ok bg-tone-ok-bg border-tone-ok-border` |
| warn | Needs attention soon, partial | `--tone-warn` | `--tone-warn-bg` | `--tone-warn-border` | `text-tone-warn bg-tone-warn-bg border-tone-warn-border` |
| bad | Failed, blocked, destructive | `--tone-bad` | `--tone-bad-bg` | `--tone-bad-border` | `text-tone-bad bg-tone-bad-bg border-tone-bad-border` |
| accent | In progress, primary, selected | `--tone-accent` | `--tone-accent-bg` | `--tone-accent-border` | `text-tone-accent bg-tone-accent-bg border-tone-accent-border` |
| neutral | Informational, off, unknown | `--tone-neutral` | `--tone-neutral-bg` | `--tone-neutral-border` | `text-tone-neutral bg-tone-neutral-bg border-tone-neutral-border` |

Every status dot also differs by shape or carries a word next to it, so colour-blind operators and greyscale screenshots read it too: a filled dot for ok, a ring for off or unknown, and the word for warn and bad. Order matters as much as colour: put the state first, then what to do.

Pick by meaning, not by colour. "Nothing needs your attention" is neutral or ok, never warn. A running operation is accent. Reserve bad for something that failed or will destroy data.

The older `--status-*` tokens (`text-status-error`, `bg-status-warning-bg` and the rest) stay for the solid callout boxes and the restart banner. New code uses the tone tokens.

Tailwind opacity modifiers such as `bg-accent/20` do not work on these colours, because they are CSS variables. Use the tint token instead.

## Type

The scale has six sizes. Today the UI is all monospace at 13 px; PR 1b switches interface text to the system sans stack and applies this scale. Until then the tokens exist but are not applied broadly.

| Size | Token | Tailwind | Line height | Use |
|---|---|---|---|---|
| 12 px | `--font-size-caption` | `text-caption` | 16 px | Badges, captions, table metadata, timestamps |
| 13 px | `--font-size-small` | `text-small` | 20 px | Secondary text, controls, sidebar items |
| 14 px | `--font-size-copy` | `text-copy` | 22 px | Body copy and form fields |
| 16 px | `--font-size-heading` | `text-heading` | 24 px | Card titles |
| 20 px | `--font-size-stat` | `text-stat` | 28 px | Status strip values and large numbers |
| 22 px | `--font-size-title` | `text-title` | 28 px | Page title (the PageHeader h1) |

Weights are 400 for text, 500 for labels and buttons, and 600 for titles. Use no other sizes.

Typography decision (Garry's decision 1, ships in PR 1b). Interface text uses the system sans stack and monospace stays for data, meaning ids, paths, versions, keys, hashes, logs and code.

| Role | Stack | Notes |
|---|---|---|
| Interface (`--font-sans`) | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif` | No download. SF Pro on macOS and iOS, Segoe UI on Windows, Roboto on Android. The deliberate exception to "pick a real typeface": on an operate surface read at 13 to 14 px, the native face renders best, and the identity is carried by the mono, the cyan and the wolf. |
| Data (`--font-mono`) | `"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` | Ids, paths, versions, model refs, env keys, pids, durations, timestamps, logs, code and the wordmark. |

Rules for the two voices:

- If an operator could paste it into a terminal or a config file, it is mono. Everything else is sans.
- Mono inside sans copy is set one step down (13 px inside 14 px copy, 12 px inside captions) so the two match optically.
- Numbers that update in place (spend, counts, memory) use `font-variant-numeric: tabular-nums` in sans, so a status strip does not jitter.
- Sidebar group labels are sentence case at 12 px, weight 600, muted. No uppercase tracking.

Font loading (Garry's decision, 2026-11-07). JetBrains Mono is self-hosted and the Google Fonts link in `setup.html` and `login.html` goes, because a third-party request from a self-hosted box leaks a page view and fails offline. The files are the upright variable woff2 (latin 31 KB, latin-ext 12 KB loaded only when those characters appear), SIL OFL 1.1 with the licence text beside them, the same files the OpenClaw Control UI already serves. Interface text stays on the system sans stack, so no sans webfont is added. PR 1b ships the font files.

## Spacing

The spacing scale is 4, 8, 12, 16, 24 and 32 px. These are Tailwind's default units 1, 2, 3, 4, 6 and 8, so use those classes (`gap-2`, `p-4`, `mb-6`) and skip 5, 7 and the half steps. The CSS variables carry the Tailwind unit in their name, so `p-3` equals `--space-3` (12 px).

| px | Token | Tailwind unit | Typical use |
|---|---|---|---|
| 4 | `--space-1` | `1` | Icon to label |
| 8 | `--space-2` | `2` | Between controls in a row |
| 12 | `--space-3` | `3` | Inside compact rows |
| 16 | `--space-4` | `4` | Card padding, between cards |
| 24 | `--space-6` | `6` | Between page sections |
| 32 | `--space-8` | `8` | Page top padding |

## Radius

| Radius | Token | Tailwind | Use |
|---|---|---|---|
| 6 px | `--radius-control` | `rounded-control` | Buttons, inputs, segmented controls |
| 10 px | `--radius-card` | `rounded-card` | Cards, modals, inset panels |
| pill | `--radius-pill` | `rounded-pill` (or `rounded-full`) | Badges, toggles, status chips |

## Motion

Minimal and functional. Motion explains a change of state; it never decorates.

| Use | Duration | Easing |
|---|---|---|
| Hover, press, colour change | 120 ms | `cubic-bezier(0.2, 0, 0, 1)` |
| Disclosure, tab switch, drawer | 180 ms | same |
| Pulse on a status dot or step pill | 2.6 s loop | ease-in-out, only while an operation is in progress |

No entrance animations, no skeleton shimmer longer than the request, and settled states (running, healthy) never pulse. The global `prefers-reduced-motion` block in `theme.css` stops every pulse and slows spinners; new animations join that block. The motion tokens (`--motion-fast`, `--motion-base`, `--ease-standard`) are added by the first screen pass that migrates the literal `0.15s` transitions.

## Layout

| Measure | Token | Tailwind |
|---|---|---|
| Sidebar width 248 px | `--layout-sidebar` | `w-sidebar` |
| Content max width 1,120 px, left-aligned | `--layout-content-max` | `max-w-content` |
| Content gutters 40 px (16 px on phones) | `--layout-gutter` | `px-gutter` |

A status strip (2 to 4 cells, label, value, one mono detail line) is the first row on Home and Health. On Home its cells follow the path a message takes through the box, gateway first, so a fault reads in the place it happens. Pages use a 1 or 2 column card grid inside the content column; the common split is 3:2 with the work on the left and summaries on the right. Two columns from 1,024 px wide, one column below. Phones (390 px) get one column, 40 px minimum tap targets and no horizontal scroll. The current shell still uses a 220 px sidebar and a 672 px column; the layout tokens are applied in the screen passes (PR 3a to 3d).

## Page header rule

Every page starts with `PageHeader` (`components/page-header.js`). It holds an h1 with the page name, one line saying what the page is for, and the page's primary action on the right. Secondary actions go in the card they act on, not in the header. Sub-navigation inside a page uses Tabs under the header.

## Building blocks

Use these before writing new markup. The ones marked "planned" land in the PR named.

| Block | Where | Rule |
|---|---|---|
| ActionButton | `components/action-button.js` | The one button. One solid accent button per page at most, the page's primary action in the PageHeader; every other primary-looking action uses the tinted primary tone. Sizes still use `rounded-lg`/`rounded-xl` today and move to `rounded-control` in a screen pass. Tones are primary (accent), secondary, success (ok), danger (bad), warning (warn), neutral and ghost; `subtle` is an alias of neutral. Sizes sm, md and lg. Every button has a `type`. |
| Badge | `components/badge.js` | Status label in one of the five tones. Accepts the tone names `ok`, `warn`, `bad`, `accent`, `neutral` and the older names (`success`, `warning`, `danger`, `info`, `cyan`, `secondary`, `subtle`) as aliases; an unknown tone renders neutral. |
| PageHeader | `components/page-header.js` | Title, purpose line and primary action (see above). |
| Card | planned (PR 3a) | Header with a title and an actions slot, then a body. Today use `bg-surface border border-border rounded-xl p-4`. |
| StatusStrip | planned (PR 3a) | A row of 2 to 4 status cells (label, value, tone). |
| EmptyState | planned (PR 3b) | A title, one sentence and one action. |
| AsyncSection | `components/async-section.js` | Loading, error and empty states for a section. |
| ModalShell | `components/modal-shell.js` | Every modal. A `role="dialog"` with `aria-modal`, named by `ariaLabel`, `ariaLabelledby` or its first heading. Traps Tab, moves focus in on open (an `autofocus` control, else the panel) and back to the opener on close. Only the topmost open dialog handles Tab and Escape. |
| ConfirmDialog | `components/confirm-dialog.js` | Confirmations, built on ModalShell. |
| Tabs | `components/tabs.js` | Page sub-navigation with `role="tablist"`. Arrows, Home and End move and select; only the selected tab is in the Tab order. Spread `getTabPanelProps(idBase, value)` on each panel. Variants `pill` (default) and `segmented`. |
| SegmentedControl | `components/segmented-control.js` | Picks one value (range, mode). Each option is a `type="button"` with `aria-pressed`. Use Tabs instead when the choice swaps what the page shows. |
| ToggleSwitch | `components/toggle-switch.js` | On and off settings. |
| InfoTooltip | `components/info-tooltip.js` | Extra explanation behind a focusable "?". Renders nothing without text. Never put it inside another control; make the row's action a sibling button. |
| WizardShell and WizardProgress | `components/wizard-shell.js`, planned (PR 3d) | Multi-step flows share one shell and one step indicator. |

## Keyboard and focus

- Every control is reachable with Tab and shows the `--focus-ring` outline on `:focus-visible`. The ring is at least 3:1 against every surface in both themes. Do not remove it with `outline-none` on a control.
- A scrolling region with no control inside (a log, an output `pre`) gets `tabindex="0"` so keyboard users can scroll it.
- Escape closes the topmost layer only. Menus and dialogs ignore an Escape that another handler already used (`defaultPrevented`) or that an IME is composing, and a closed menu returns focus to its trigger.
- Never nest a focusable element inside another control (`role="button"` rows included). Make the row's action a button and keep extra controls beside it.

## Copy rules

- Sentence case for headings, buttons and labels ("Restart gateway", not "Restart Gateway").
- "gateway" is the process and "OpenClaw" is the product.
- Loading text is "Loading…" with the ellipsis character.
- No emoji in status text. Use a tone and a word.
- Buttons are verbs that say what happens ("Save key", "Run Doctor"). Avoid "OK" and "Submit".
- Say what is wrong and what to do next in plain words. Never tell the operator to restart the container.

## Navigation names (decision 2, ships in PR 2b)

The sidebar regroups into Home, Chat, Agents, Operate (Health, Doctor, Schedules, Usage), Connect (Channels, Integrations, Relay) and Settings (Models & keys, Environment, Team). The renames are General to Home, Watchdog to Health, Cron to Schedules and Envars to Environment. Old hash links (`#/general`, `#/watchdog`, `#/cron`, `#/envars`) redirect to the new ones and keep their query string.

## General card disposition (decision 3, ships in PR 3a)

General splits into Home (status and next steps) and Integrations. Every card on General today has a destination.

| Card on General today | New page |
|---|---|
| Gateway (status, Restart, Repair, Details) | Health (Home shows the status strip, linking there) |
| Restart-required banner, restart progress card | Global, shown on every page under the page header while active, as the global restart banner does today |
| OpenclawPinWarning, UpgradeAlert, GeneralDoctorWarning, hardening badge and card | Home, in an "Attention" slot above the checklist, shown only when they have something to say |
| WhatsNextCard | Home (becomes the Finish-setting-up checklist) |
| Channels, ChannelOperationsPanel, Pairings (channel pairing approvals), WhatsApp QR | Channels page (new route reusing these components); Home shows a compact Channels summary |
| DevicePairings (pending device approvals) | Home "Attention" slot while any are pending, and the Channels page |
| Features (memory embeddings, audio transcription) | Integrations |
| Google Accounts | Integrations |
| ApiFeaturePanel, AgentAdminPanel | Integrations |
| Workspace sync (SyncLastRunLine, sync schedule), UpdateActionButton | Home, in a "This box" card (version, update, sync) |
| BackupsCard | Home, in the same "This box" card group |

## Checking a change

- Run the targeted vitest files for the components you touched.
- On a real box, run the UX audit (`ux-audit.js --theme both`, desktop 1440x900 and mobile 390x844) and quote axe and contrast counts against main. The bar after PR 1a is 0 colour-contrast violations outside `#/chat` and `#/relay` internals.
- Screenshot the pages you changed in both themes at both widths.
