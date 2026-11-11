---
version: 1
slug: "web-src-pages-overview-tsx"
primary_target: "apps/web/src/pages/Overview.tsx"
related_targets: ["apps/web/src/components/Shell.tsx","apps/web/src/pages/Placeholder.tsx"]
---

# Control panel (all pages)

Scope: the whole Commissary control panel in `apps/web`, served at `/` behind the Access admin gate. Primary surface: Overview;
the same world covers Accounts, API keys, Models, Usage, Settings. Visitor mode: Operate. Build path: code-led.

Audience and job: the single operator (PRODUCT.md). Weekly: which account is closest to its limit, when it frees up,
what failed, what the last day cost. Occasionally: connect or re-authorize an account. Rarely: keys, model rules,
settings.

Scene: a desktop monitor in an ordinary lit room during the working day, between other work; a glance, not a session.
Light ground follows from it.

Constraints: show only what applies on Workers; no secrets in the browser; version-checked writes; desktop first,
usable at 390 px; WCAG 2.2 AA, full keyboard.

Memorable moment: the reset blade, the yellow trail sign at the end of each account row that says how far away full
capacity is.

Replaced: the "utility statement" world (blue title strips on ruled cards) was rejected by the user as heavy and boxy;
it is anti-reference: no per-section colour strips, no boxes inside boxes, no repeated per-card labels.

Open decisions: history of past windows (Phase 2, tokens per window); dark theme done (DESIGN.md "Dark Theme").

## Direction contract

THESIS: Quota is a walk to the next reset. Each account reads like a Swiss trail signpost: where it stands now and how
long until capacity is back, in walking-sign time. Refuses the graphite stat-card dashboard and the ruled ledger.

OWN-WORLD: White ground, Wanderweg yellow #F5C400 shell bar and reset blades, black sign ink, a fixed stone ramp for
neutrals (raise from the exposure record: no ad-hoc greys), Swiss red #D52B1E for closed or failing, white-red-white
trail marker for near limit. Atkinson Hyperlegible Next, tabular figures. Hairline rules, no cards, no shadows. Every
colour has one meaning (raise from the orienteering map). Every figure is labelled once, by its column (raise from the
Factory catalog).

STORY: The operator sees which accounts are closed or nearly spent, reads at the row's end how long until each is back,
checks the last day by model, and follows a name to act.

FIRST VIEWPORT: Yellow shell bar: wordmark and host, the org switcher beside them, refresh and the theme and account
menus; the sidebar beside the page: grouped page links (a drawer on narrow screens). One sentence
status line. Then the accounts table in urgency order: marker, provider and address, quota meters, reset blade,
recent requests. Below, last 24 hours: totals beside a by-model table.

FORM: Swiss hiking signage (Wanderweg), position 4 of my ordered list, seed key ebd92ce0.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and
every shipping raster carrying its provenance
