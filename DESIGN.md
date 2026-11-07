# AlphaClaw Setup UI design system

This file records how the Setup UI (`lib/public`) should look and read. It is the reference for every UI change after the ALPH-69 overhaul (GST-1697). Tokens live in `lib/public/css/theme.css` (dark values on `:root`, light values on `[data-theme="light"]`) and are exposed to Tailwind in `tailwind.config.cjs`. Use a token or its Tailwind class instead of a raw hex value, an `rgba()` literal or a raw palette class such as `text-gray-400` or `bg-yellow-500/10`.

Status of each part of this document:

| Part | Ships in |
|---|---|
| Tokens, status tones, Badge and ActionButton on tokens, contrast floor | PR 1a |
| Typography switch (sans for UI text, mono for data) and the type scale applied | PR 1b |
| Accessible primitives (ModalShell dialog semantics, Tabs, SegmentedControl, focus ring) | PR 1c |
| Navigation names and grouping | PR 2b |
| General split into Home and Integrations | PR 3a |

## Principles

- Keep the dark theme, the cyan accent and the wolf mark. The light theme is a first-class theme, so every change is checked in both.
- One page, one job. A page leads with its title, a one-line purpose and its primary action, then the thing that needs attention.
- Status is never colour alone. Pair a tone with a word or a glyph.
- Text meets WCAG 2 AA, which is 4.5:1 for normal text and 3:1 for large text and for non-text marks such as dots and borders.

## Colour

### Surfaces and text

| Token | Tailwind | Use |
|---|---|---|
| `--bg` | (body) | Page and modal background |
| `--bg-sidebar` | `bg-surface`* | Sidebar |
| `--bg-content` | | Content column |
| `--panel-bg-contrast`, `--panel-border-contrast` | `bg-surface`, `border-border` | Cards and their borders |
| `--field-bg-contrast`, `--field-border-contrast` | `bg-field` | Inputs, selects, textareas |
| `--text-bright` | `text-bright` | Headings and values that must stand out |
| `--text` | `text-body` | Body text |
| `--text-muted` | `text-fg-muted` | Secondary text, labels, metadata |
| `--text-dim` | `text-fg-dim`, `placeholder-fg-dim` | Tertiary text and placeholders |
| `--accent` | `text-accent`, `bg-accent`, `border-accent` | Brand cyan for links, active states and progress |
| `--accent-dim`, `--accent-link` | `border-accent-dim`, `text-accent-link` | Accent borders and inline links |

\* `.bg-surface` is redefined in `theme.css` as the card treatment.

Contrast floor (PR 1a). `--text-muted` and `--text-dim` both measure at least 4.5:1 on the page, the sidebar, a card and a neutral badge tint in both themes. Dim stays one step below muted, so the hierarchy holds without dropping under the floor.

| Token | Dark | Light |
|---|---|---|
| `--text-muted` | `#9198a1` (6.1:1 on a card) | `#57606a` (5.8:1 on a card) |
| `--text-dim` | `#848d97` (5.3:1 on a card) | `#5f6873` (5.1:1 on a card) |
| `--accent` | `#63ebff` | `#0e7490` (was `#0891b2`, 3.7:1 on white) |

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

Typography decision (Garry's decision 1, ships in PR 1b). Interface text uses the system sans stack and monospace stays for data, meaning ids, paths, versions, keys, hashes, logs and code. No font files are added.

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

## Layout

| Measure | Token | Tailwind |
|---|---|---|
| Sidebar width 248 px | `--layout-sidebar` | `w-sidebar` |
| Content max width 1,120 px, left-aligned | `--layout-content-max` | `max-w-content` |
| Content gutters 40 px (16 px on phones) | `--layout-gutter` | `px-gutter` |

Pages use a 1 or 2 column card grid inside the content column. Two columns from 1,024 px wide, one column below. Phones (390 px) get one column, 40 px minimum tap targets and no horizontal scroll. The current shell still uses a 220 px sidebar and a 672 px column; the layout tokens are applied in the screen passes (PR 3a to 3d).

## Page header rule

Every page starts with `PageHeader` (`components/page-header.js`). It holds an h1 with the page name, one line saying what the page is for, and the page's primary action on the right. Secondary actions go in the card they act on, not in the header. Sub-navigation inside a page uses Tabs under the header.

## Building blocks

Use these before writing new markup. The ones marked "planned" land in the PR named.

| Block | Where | Rule |
|---|---|---|
| ActionButton | `components/action-button.js` | The one button. Tones are primary (accent), secondary, success (ok), danger (bad), warning (warn), neutral and ghost; `subtle` is an alias of neutral. Sizes sm, md and lg. Every button has a `type`. |
| Badge | `components/badge.js` | Status label in one of the five tones. Accepts the tone names `ok`, `warn`, `bad`, `accent`, `neutral` and the older names (`success`, `warning`, `danger`, `info`, `cyan`, `secondary`, `subtle`) as aliases; an unknown tone renders neutral. |
| PageHeader | `components/page-header.js` | Title, purpose line and primary action (see above). |
| Card | planned (PR 3a) | Header with a title and an actions slot, then a body. Today use `bg-surface border border-border rounded-xl p-4`. |
| StatusStrip | planned (PR 3a) | A row of 2 to 4 status cells (label, value, tone). |
| EmptyState | planned (PR 3b) | A title, one sentence and one action. |
| AsyncSection | `components/async-section.js` | Loading, error and empty states for a section. |
| ModalShell | `components/modal-shell.js` | Every modal. Gains dialog semantics and a focus trap in PR 1c. |
| ConfirmDialog | `components/confirm-dialog.js` | Confirmations. Rebuilt on ModalShell in PR 1c with the same API. |
| Tabs | planned (PR 1c) | Page sub-navigation with `role="tablist"`. Replaces `pill-tabs.js`. |
| SegmentedControl | `components/segmented-control.js` | Picks one value (range, mode). Gets `aria-pressed` in PR 1c. |
| ToggleSwitch | `components/toggle-switch.js` | On and off settings. |
| InfoTooltip | `components/info-tooltip.js` | Extra explanation behind a focusable "?". |
| WizardShell and WizardProgress | `components/wizard-shell.js`, planned (PR 3d) | Multi-step flows share one shell and one step indicator. |

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
