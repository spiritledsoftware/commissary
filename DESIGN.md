---
name: Commissary control panel
description: Commissary's control panel set as Swiss hiking trail signage (Wanderweg), where quota is a walk to the next reset.
colors:
  white: "#ffffff"
  stone-1: "#f3f3f1"
  stone-2: "#e3e3df"
  stone-3: "#c4c5c0"
  stone-4: "#6a6c69"
  ink: "#1b1c1b"
  yellow: "#f5c400"
  yellow-deep: "#dcae00"
  red: "#d52b1e"
  night-field: "#0e0f0c"
  night-ground: "#131412"
  night-raised: "#1a1b18"
  night-sunk: "#242422"
  night-hairline: "#30312e"
  night-step: "#4f504d"
  night-quiet: "#959692"
  night-text: "#e1e2de"
  night-red: "#f45c4a"
typography:
  totals:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 750
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  status:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 750
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  section:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 750
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  table:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.5
rounded:
  default: "3px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "24px"
  6: "40px"
  7: "64px"
components:
  shell-bar:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.ink}"
    height: "64px"
  sidebar:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    width: "240px"
  button-connect:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.white}"
    rounded: "{rounded.default}"
    height: "40px"
    padding: "0 16px 0 12px"
  button-refresh:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.ink}"
    rounded: "{rounded.default}"
    size: "40px"
  button-refresh-hover:
    backgroundColor: "{colors.yellow-deep}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.white}"
    rounded: "{rounded.default}"
    height: "44px"
    padding: "0 24px 0 16px"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.default}"
    height: "40px"
    padding: "0 16px"
  button-secondary-hover:
    backgroundColor: "{colors.stone-1}"
  reset-blade:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.ink}"
    height: "34px"
    width: "192px"
  reset-blade-closed:
    backgroundColor: "{colors.red}"
    textColor: "{colors.white}"
  meter-track:
    backgroundColor: "{colors.stone-2}"
    height: "8px"
  meter-fill:
    backgroundColor: "{colors.ink}"
  meter-fill-out:
    backgroundColor: "{colors.red}"
  meter-pace-tick:
    backgroundColor: "{colors.ink}"
    width: "2px"
    height: "14px"
  trail-mark:
    backgroundColor: "{colors.red}"
    width: "16px"
    height: "8px"
  button-danger:
    backgroundColor: "{colors.white}"
    textColor: "{colors.red}"
    rounded: "{rounded.default}"
    height: "40px"
    padding: "0 16px"
  button-danger-hover:
    backgroundColor: "{colors.red}"
    textColor: "{colors.white}"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.default}"
    height: "40px"
    padding: "0 12px"
  history-bar:
    backgroundColor: "{colors.stone-3}"
  history-bar-current:
    backgroundColor: "{colors.ink}"
  step-number:
    textColor: "{colors.ink}"
    size: "32px"
  dialog:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.default}"
---

# Design System: Commissary control panel

## Overview

**Creative North Star: "The Trail Signpost"**

Quota is a walk to the next reset. Each account reads like a Swiss Wanderweg signpost: where it stands now, and how long until capacity is back, in walking-sign time. By day the ground is plain white; at night (the dark theme) it is a warm near-black. Either way the only loud things are the yellow route (the reset blades, and the shell: a yellow bar by day, a yellow band at night) and, when something is wrong, red. It is a glance tool for one operator at a desktop monitor between agent runs, usable down to 390 px.

Structure comes from hairlines and one ink rule under table headings. There are no cards, no boxes inside boxes, no shadows, and no per-section colour strips. Type is Atkinson Hyperlegible Next with tabular figures throughout.

**Key Characteristics:**

- White ground, yellow shell bar, black sign ink; at night a dark ground, a dark shell on a yellow route band, light stone text.
- One meaning per colour; stone is the only neutral ramp.
- Every figure is labelled once, by its column.
- The reset blade is the memorable object; its unfold is the only authored motion.
- Hairlines, no cards, no shadows.

## Colors

A signage palette: white, sign ink, one route yellow, one danger red, and a fixed stone ramp. These paints are defined once in `apps/web/src/styles/tokens.css`; stylesheets never use them directly but through the semantic tokens below, so the dark theme is a remap of roles, not a second set of rules.

### Primary

- **Wanderweg Yellow** (#f5c400): the route. The shell bar and the reset blades only. 12:1 against ink.
- **Pressed Yellow** (#dcae00): hover of the shell bar's squares and org switcher.

### Secondary

- **Swiss Red** (#d52b1e): closed or failing. The closed blade, the red trail mark, failed counts, meters at 100%, the red band on a near-limit tip. 4.9:1 on white.

### Neutral

- **White** (#ffffff): page ground, secondary button fill, tip bands.
- **Sign Ink** (#1b1c1b): text, figures, the connect button, meter fills, table-heading rules, focus ring.
- **Stone 1** (#f3f3f1): hover and sunk fields.
- **Stone 2** (#e3e3df): meter tracks and row hairlines.
- **Stone 3** (#c4c5c0): strong rules, link underlines, scrollbar.
- **Stone 4** (#6a6c69): secondary text and captions, 5.4:1 on white; also the edge on the near-limit tip.

### Semantic Tokens

Each token is a `light-dark()` pair (day / night); contrast of text on its ground in `tokens.css`.

- **ground** (white / #131412): the page, secondary and danger button fills, sticky bars. **field** (white / #0e0f0c): text inputs, a well at night. **raised** (white / #1a1b18): dialogs, the bar's menus, the sidebar drawer, the night shell. **sunk** (stone-1 / #242422): hover fills and set-apart blocks.
- **hairline** (stone-2 / #30312e): row hairlines, meter tracks, tab hover. **rule** (stone-3 / stone-4; at night 3.5:1 on the ground, so field frames and chart bars clear WCAG's 3:1 for controls): strong rules, field frames, link underlines, scrollbar, past history bars, the Settings save bar's top edge.
- **text** (ink / #e1e2de, 17.1 / 14.2): text, figures, meter fills, heading rules, the current bar; **focus** is the same colour. **quiet** (stone-4 / #959692, 5.3 / 6.2): secondary text and captions.
- **inverse** / **on-inverse** (text on ground, swapped): the ink blocks: primary and Connect buttons, filter chips, the skip link, selection. **inverse-hover** (darker by day, stone-1 at night, so a hovered block brightens rather than greys), **inverse-quiet**, **inverse-muted**, **inverse-muted-quiet**: their hover and secondary text.
- **route** (yellow, both) with **on-route** (ink, both): the reset blades. The sign keeps its black lettering at night.
- **danger** (red / #f45c4a, 5.0 / 5.7 as text) with **on-danger** (white / ink): closed blades, marks, failed figures, 100% meters, the danger button.
- **paint** / **paint-edge**: the white of the white-red-white tip band and its stone-4 edge (no edge at night).
- **bar**, **on-bar**, **bar-quiet** (the host), **bar-pressed**, **bar-route**: the shell. **backdrop**: behind a dialog.
- **weight-body** / **tracking-body**: body text weight and tracking (400 / normal; 430 / 0.005em at night).

### Dark Theme

The night version of the trail sign, for the same operator checking in after dark. The stone ramp keeps its roles on a dark ground, in the same warm grey (oklch hue 118, chroma 0.005): sunk and raised surfaces sit a step above the ground, hairlines step up from it, rules are stone-4 (3.5:1, so field frames and chart bars stay visible), secondary text is a mid stone (6.2:1) and sign ink becomes a light stone (14.2:1), never pure white. Elevation is still flat: a dialog or menu is one step lighter with a 2px text-colour frame, no shadow. Ink blocks (primary buttons) brighten to stone-1 on hover instead of greying.

- **Yellow stays the route.** The blades keep Wanderweg yellow with ink lettering (10.4:1). The shell becomes a dark board (raised) with a 4px yellow band along its foot: a full yellow bar is the loudest thing on a dark screen and would outshout the blades, while the band keeps "yellow = route" and reads calmly at night.
- **Red stays danger.** At night it is a lighter Swiss red, #f45c4a, so red text passes on the dark ground (5.7:1, 4.8 on sunk); red fills take ink lettering (5.3:1), since white on that red would not pass.
- **The near-limit tip** keeps its white-red-white band in a light stone paint; it needs no edge against a dark page.
- **Body text** gains a little weight (430) and tracking (0.005em): light text on a dark ground reads thinner.
- Browser surfaces follow through `color-scheme`: scrollbars, form controls (accent is the text colour), date and select popups, and the `theme-color` (yellow by day, the dark board at night).

**Choosing it.** The theme follows the system (`prefers-color-scheme`) until the operator picks Light or Dark in the shell's theme menu; the choice is kept in `localStorage` and applied before the first paint by a same-origin script (`apps/web/src/theme-boot.ts`), since the CSP allows no inline script.

### Named Rules

**The One Meaning Rule.** Every colour carries one meaning. Yellow is the route, never a link underline or a highlight. Red is closed or failing, never decoration. Stone is the only neutral ramp; no ad-hoc greys.

**The Near-Limit Rule.** Near-limit is never solid red. It is the white-red-white band on the blade tip, with an ink note in the row. Solid red is reserved for closed, failed, and 100%.

## Typography

**Display Font:** Atkinson Hyperlegible Next Variable (with system-ui, sans-serif), self-hosted via @fontsource-variable.
**Body Font:** the same family; one face only.

**Character:** Legible first, in sign-painter weights: heavy for names and totals, plain for table text. Tabular numerals on the whole body so columns of figures align.

### Hierarchy

- **Totals** (750, 2.25rem, 1.1, -0.025em): the day's totals.
- **Status** (750, 2rem desktop / 1.625rem mobile, 1.15, -0.025em): the one sentence under the shell. Headings: 800 at 1.25–2.25rem with -0.03em for the wordmark and empty-page titles.
- **Section** (750, 1.375rem, 1.15): section headings.
- **Body** (400, 1rem, 1.5): prose, capped at 65–70ch; provider names are 750 at 1rem.
- **Table** (400, 0.875rem): table text, nav, buttons (700).
- **Caption** (600, 0.8125rem, stone-4): column headings, meter labels, clock times, notes.

### Named Rules

**The One Label Rule.** A figure is labelled once, by its column head. On narrow screens, where heads disappear, the request figure gets one key line above the list, not a label per row.

## Layout

The shell bar spans the window; under it a 15rem sidebar (`--sidebar-width`) sits beside a single page column, max width 80rem, gutter 2.5rem (1rem under 40rem); bar and frame share one centred max width (95rem), so the wordmark stands over the sidebar's links. Below 64rem the sidebar is a drawer and the page takes the full width. Page sections stack on a 4rem gap. Spacing scale: 4, 8, 12, 16, 24, 40, 64 px. The accounts table runs in urgency order: marker, provider and address, quota meters (max 26rem), reset blade, requests right-aligned. Below, the last day: a 13rem column of totals beside the by-model table with a thin ink share bar.

Pages size themselves by the page column, not the window (`@container` queries on `main`), since the sidebar takes part of a wide window. A query measures the column inside its gutters, the window less 5rem below 64rem, so a page breakpoint is its window breakpoint less 5rem (35rem, 43rem, 59rem for windows of 40rem, 48rem, 64rem). Under a 43rem page each account row becomes a grid: account, quota, then reset blade left and request count right.

## Elevation & Depth

Flat. Depth is carried by hairlines (1px stone-2 between rows), a 2px ink rule under table headings, and colour blocks. There are no cards and no shadows. The single exception is a drop-shadow filter on the blade tip, used purely as a 1px stone-4 edge so the white band reads against the white page.

### Named Rules

**The Hairline Rule.** Separate with rules, never with boxes or shadows.

## Shapes

Square signage. Buttons take a 3px radius; meters 1px. Blades have a square tail and a pointed head (clip-path polygon, tip 0.875rem) and a fixed length of 12rem, so tips align down the column like blades on one post. The trail mark is a flat 1rem by 0.5rem red band.

## Components

### Shell Bar

- Yellow, min-height 4rem, ink text, holding only what is global to the page: the wordmark (800, 1.25rem; 1.125rem on phones) over the host in 0.8125rem, right beside it the org switcher, then on the right Refresh, the theme menu and the account menu. Connecting an account starts on the Accounts page, never from the bar. Refresh is a 2px ink outline square that turns Pressed Yellow on hover and spins while loading. At night the bar is a dark board with a 4px yellow route band along its foot (see Dark Theme). The page links live in the sidebar.
- **Org switcher:** for a caller of several orgs or one who may create them, a 40px select framed like the bar's squares (2px ink outline, Pressed Yellow on hover) with the org's name in 700 and its own chevron, its "Org" label for screen readers only; the last option opens the org chooser. Beside the name it shortens before the name or the bar's squares do; under 30rem (phones) it takes a full-width row of its own along the bar's foot. Choosing an org reloads the panel at its address.
- **Account menu:** the theme menu's twin (a framed square with the account icon, an "Account" caption): Sign out on Commissary Cloud, and Delete my account in red (the danger colour, since it deletes), which asks in the typed confirmation dialog. Focus returns to the square when the menu or the dialog closes.
- **Theme menu:** the square between Refresh and the account menu, framed like Refresh so the two read as a pair, showing the choice's icon (sun-and-moon for System, sun, moon) with a "Theme: <choice>" tooltip; it opens a menu framed like the dialog with a "Theme" caption and System, Light and Dark as radio items (the chosen one 750 with a check). Arrows, Home and End move; Enter picks and closes; Escape closes. Hover fills on the bar's squares apply only where the pointer can hover, so a tap leaves no stuck fill.

### Sidebar

- The page links of the caller's role, on the page's own ground, set off from the page by one 1px hairline down its right edge: no fill, no box. It stays in view while the page scrolls (sticky, scrolling itself on a short window).
- Links in groups (`pageGroupsFor` in `apps/web/src/lib/role.ts`, the only source of the links): Overview and Usage first without a heading, then Providers, People and access, and Org, each under a caption heading (0.8125rem, 600, stone-4); a group the role has no page in is left out. Links are 0.9375rem (500), 2.25rem rows (2.75rem on touch screens), spaced 1.5rem between groups.
- The current page (`aria-current="page"`) is set in 750 with a 4px ink underline under its label, hover a 4px hairline one: the filter tabs' underline language turned into a column. Never a coloured side stripe or a fill.
- **Drawer (below 64rem):** a framed menu square at the bar's left opens the same content in a native modal `<dialog>` along the left edge (raised, 2px text-colour right edge, no shadow, the dialog backdrop; at most 20rem, always leaving a strip of page in view). Its close square lands where the menu square was. Tab wraps inside it, Escape, the close square, the backdrop and following any link close it, and focus returns to the menu square. No slide: the unfold stays the only authored motion.

### Buttons

- **Primary / Connect:** ink fill, white text, 3px radius, 700 weight, leading icon from lucide-react; 44px tall. Hover mixes ink toward white.
- **Secondary:** white, 2px ink border, 40px tall; hover fills stone-1.
- **Danger:** white, 2px red border, red text, 40px tall; hover fills red with white text. Only for deleting.
- **Busy:** the leading icon spins and the label turns into what is happening ("Checking…"); the button is disabled
  until the request settles. A
  disabled button sits at 55% opacity with no hover change.

### Form Fields

- Label above in 0.75rem stone-4 (600); the input is 40px, white, 2px stone-3 border that goes ink on focus and red
  when invalid, with the message beneath in red 0.75rem (650). Help text beneath in stone-4.

### Filter Tabs

- A radiogroup above a list: 0.875rem labels (650) with an optional count in stone-4 (400), 40px tall, a 4px underline
  that is stone-2 on hover and ink when chosen. Same underline language as the sidebar links. Shared from `Kit` (`tabs`,
  `tab`, `tabCount`): the Accounts filter, the Usage range, breakdown and All / Failed switches.

### Filter Chips

- What a page is narrowed to, after a stone-4 "Narrowed to" caption: ink blocks (3px radius, 2.25rem tall) with the
  filter's name in stone-3 (400) and its value in white (650), ending in an ×, stone-4 on hover; choosing one removes
  that filter. The only
  inverted element besides the shell bar's ink text, so a narrowed page is never mistaken for the whole.

### History Chart

- Columns of one window or day each, 2px apart, at most 2.75rem wide (a chart of few windows stays narrow), 6rem tall
  over a 2px ink baseline. Past bars stone-3, the bar in progress ink; the pointed bar stone-4. A readout above names
  the pointed (else current) period with its tokens (750) and requests (stone-4); the first period and "Now" sit under
  the baseline. A visually hidden table carries the same figures.

### Steps

- Numbered 2rem squares with a 2px ink border and the number in 750, the step title (1rem, 750) beside, the step's
  content indented under the title. A device code is set very large in 800 with a secondary Copy code button.

### Dialog

- Native `<dialog>`, 28rem, white (raised), 2px ink border, no shadow; the backdrop is ink at 45% (night-field at 65% at night). Title 1.25rem (750), body,
  then actions left-aligned (the danger action first, the safe one second).
- **Focus:** 3px ink outline, 2px offset, on every element.

### Reset Blade (signature)

- 12rem by 2.125rem. Yellow with ink text; the destination (window name, 500) sits left and the time (750, "1 h 34 min") right; the clock time sits beneath in a stone-4 caption. Closed: red with white text, destination "Back in". Near limit: a white-red-white band on the tip, with extra right padding. It has a role=img and a full aria-label.
- **Motion:** on load the blades unfold left to right (520ms, ease-out-expo), staggered 45ms per row; the tip band fades in 420ms later. Reduced motion collapses it.

### Meter

- Grid of label (5rem; a longer window name wraps rather than touching the track), track, value (2.75rem). Track stone-2, 8px high; fill ink; at 100% fill and value turn red. The scale is a shared 0–100%.
- **Free usage** (the Billing page): the label is the month's free usage of the unit ("25,000"), so the column head names it once. The meter turns red only where using it up refuses something (on Free, or while a payment is past due): on Pay as you go what is above free usage is billed, not refused, so a meter at 100% stays ink. The billing cap's meter turns red once the cap is reached.
- **Pace:** when an allowance has a pace, a tick marks the share of its period that had passed when the figures were read: ink, 2px by 14px, so it stands proud of the track, with a 1px ground-coloured edge so it reads over the fill. A caption sits under the track (0.8125rem, stone-4): "8 pts ahead", "On pace" or "12 pts behind". Pace is information, so neither tick nor caption ever turns yellow or red. The meter's spoken value carries the pace ("62%, 8 points ahead of pace"); the caption is hidden from assistive technology so it isn't read twice. Without a pace, the meter has neither.

### Trail Mark

- The red 1rem by 0.5rem band beside a closed or failing item, including load-error messages.
- **Near mark:** its near-limit twin, the white-red-white band (paint, danger, paint, with the 1px paint edge) beside
  something at 80% of a limit, per the Near-Limit Rule.

### Plan Notices

- Commissary Cloud's notices of free usage and the billing cap at 80% and 100% and of a failed payment, over an org's
  pages for its owners and admins (not on the Billing page, which shows the same state in place): one set-apart block
  on the sunk ground across the page column, a mark and a 600-weight sentence per notice (the trail mark for 100% and a failed
  payment, the near mark at 80%), most urgent first, then a "Plan and usage" link to the Billing page. No colour fill,
  no stripe: the marks carry the urgency.

### Tables

- 0.875rem text, 1rem cell padding, a 2px ink rule under headings, stone-2 hairlines between rows, numbers right-aligned. A failed count above zero is red.

### Request Log

- A table of requests, newest first: the time (a chevron button, 600, tabular figures) opens the request in place as a
  stone-1 block of labelled facts (caption labels, 600 values), then the provider's failure body under a hairline,
  captioned with the trail mark and its status.
  Secondary figures (in/out tokens, the user) sit under the main one in stone-4 captions. A failed result is red with
  the trail mark and the HTTP status. Older pages append below behind a secondary "Show older requests" button. On
  narrow screens each request becomes three lines: time and result, model and tokens, account and latency.

### Links

- Ink text with a 2px stone-3 underline that goes ink on hover. Never yellow.

## Do's and Don'ts

### Do:

- **Do** keep yellow to the shell bar and the reset blades.
- **Do** use red only for closed, failing, and 100%; show near-limit as the tip band plus an ink note.
- **Do** draw every neutral from stone-1 to stone-4.
- **Do** colour through the semantic tokens (`--ground`, `--text`, `--quiet`, `--danger`, …), never a paint directly, so both themes follow.
- **Do** give blades a fixed 12rem length with destination left and time right.
- **Do** label each figure once, by its column; give the mobile request figure one key line above the list.
- **Do** separate with 1px stone-2 hairlines and the 2px ink heading rule.
- **Do** keep the unfold as the only authored motion and respect reduced motion.

### Don't:

- **Don't** use cards, boxes inside boxes, shadows, or per-section colour strips.
- **Don't** colour link underlines yellow, or add a second accent.
- **Don't** fill a meter or blade solid red for near-limit.
- **Don't** repeat a label on every row.
- **Don't** add greys outside the stone ramp.
