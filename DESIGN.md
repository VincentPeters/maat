---
name: Maat
description: Local fraud check for student submissions; the report reads like a station timetable printed in riso inks.
colors:
  ground: "#f1e9d7"
  raised: "#f8f3e8"
  rule: "#d9ccb2"
  ink: "#0b3a4e"
  muted: "#4d6470"
  vermilion-deep: "#b3290c"
  vermilion: "#f13e21"
  vermilion-wash: "#f6cdb9"
  navy-panel: "#06364a"
  navy-deep: "#042536"
  navy-ground: "#072f40"
  navy-raised: "#0d3b50"
  navy-rule: "#1f4e62"
  cream: "#f1e9d7"
  sea-glass: "#9fb3b4"
  vermilion-night: "#ff6a45"
  vermilion-wash-night: "#5a2a1f"
typography:
  wordmark:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "26px"
    fontWeight: 800
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "19px"
    fontWeight: 700
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "17px"
    fontWeight: 600
  score:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    fontFeature: "tnum"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  subhead:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    letterSpacing: "0.06em"
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "13px"
rounded:
  none: "0px"
  bar: "2px"
  control: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  section: "28px"
components:
  button:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  field:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
  header-bar:
    backgroundColor: "{colors.navy-panel}"
    textColor: "{colors.cream}"
    padding: "18px 24px"
  tab:
    textColor: "{colors.muted}"
    padding: "10px 0"
  pair-row:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "12px 0"
  score-bar:
    backgroundColor: "{colors.vermilion}"
    rounded: "{rounded.bar}"
    height: "4px"
    width: "48px"
  code-block:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.control}"
    padding: "12px"
---

# Design System: Maat

## Overview

**Creative North Star: "The Station Timetable"**

The Maat report reads like a well-set railway timetable: one calm column rhythm the eye runs down, rank carried by tabular figures and weight rather than by colour, boxes or badges. It is a work tool a teacher may show to a student or a colleague, so it stays neutral, quiet and legible above all. The single vermilion accent appears where something is measured (the score weight bar, links, focus) and almost nowhere else.

The brand source is the README hero (`docs/maat-hero.png`): a three-ink risograph print, vermilion and deep navy on cream paper. The report takes those three inks as its whole palette: cream paper and navy ink in light mode, the navy sky as ground with cream text in dark mode, and vermilion as the one accent. The print's texture stays in the header only: a navy panel with a faint cream grain and a thin inner frame line near its bottom edge, after the hero's printed border. Everything is local: system fonts only, the grain is an inline SVG, no external fonts, scripts or requests.

Density is moderate: rows at 12px vertical padding on a 15px/1.55 body, separated by hairlines. The page follows the system light/dark preference and is always light in print.

**Key Characteristics:**
- One column rhythm with hairline rules; no cards, no shadows.
- Rank by tabular figures and weight; colour is reserved for the single vermilion accent.
- A grained navy header panel in both themes, framed like the hero print.
- System sans throughout; mono only for file names, code and commands.
- Checked rows recede to muted text instead of disappearing.

## Colors

The hero's three riso inks: cream paper, deep navy and vermilion. Light mode is navy ink on cream; dark mode is cream on the navy sky. Secondary text is tinted from navy, never grey.

### Primary
- **Vermilion Ink** (vermilion-deep): the light-theme text accent, darkened from the print's vermilion for 5.4:1 on cream. Links, focus outline, checkbox fill, Dolos scores above the class threshold.
- **Vermilion** (vermilion): the print's own red. The score weight bar in light mode (a graphic, 3.2:1).
- **Vermilion Night** (vermilion-night): the dark-theme accent for text and bars (5:1 on navy ground), and in both themes the wordmark full stop and the "Not checked" line in the header.
- **Vermilion Wash** (vermilion-wash / vermilion-wash-night): text selection background only.

### Neutral
- **Cream Paper** (ground): light page ground; also the sticky toolbar background.
- **Light Paper** (raised): inputs, selects, buttons, code blocks in light mode.
- **Tan Rule** (rule): every divider, row rule, field border and image frame in light mode.
- **Navy Ink** (ink): light-theme body text (10:1 on cream).
- **Slate** (muted): navy-tinted secondary text, column heads, tags, captions, checked rows.
- **Navy Panel** (navy-panel / navy-deep): the header panel; navy-deep in dark mode so it still sits apart from the ground.
- **Navy Ground** (navy-ground), **Navy Raised** (navy-raised), **Navy Rule** (navy-rule): dark-mode page, fields and hairlines.
- **Cream** (cream): text on the header panel and dark-mode body text.
- **Sea Glass** (sea-glass): muted text on navy.

Print overrides the palette to white ground, black text, #444 muted, #ccc rules and a black accent; the header panel becomes white with a 2px black bottom rule.

### Named Rules
**The One Vermilion Rule.** Vermilion is the only hue besides the navy and cream grounds. It marks measurement and interaction (score bars, links, focus, checkboxes), never decoration or category. Signal types are muted text, not coloured badges.

**The Print Panel Rule.** The header is always the grained navy panel with its inner frame line, in both themes. It is the one place the print's texture shows; the rest of the page stays flat paper. The grain is sparse cream speckle at low opacity and must never cost the header text its contrast.

## Typography

**Display Font:** none; the wordmark is system sans at heavy weight.
**Body Font:** system-ui (with -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif)
**Label/Mono Font:** ui-monospace (with SFMono-Regular, Menlo, Consolas, monospace)

**Character:** Plain system sans set like a timetable: weight and tabular figures carry hierarchy, sizes stay close together.

### Hierarchy
- **Wordmark** (800, 26px, -0.03em): `maat` in the header panel, followed by a vermilion full stop.
- **Headline** (700, 19px): section titles (Pairs to look at, Clusters, Students).
- **Title** (600, 17px): assignment name in the header; 600 weight at body size for student names and tabs.
- **Score** (700, 17px, tabular): the score figure in each pair row; table numbers use the same weight with tabular figures at body size.
- **Body** (400, 15px, 1.55): all running text; intro and section notes capped at 75ch.
- **Subhead** (700, 14px, 0.06em, uppercase, muted): evidence sub-sections inside an opened pair (Matching images, Shared sentences, The two submissions).
- **Label** (400, 13px, muted): column heads, captions, footer, earlier-year marker.
- **Mono** (13px): file names, the viewer commands, code.

### Named Rules
**The Tabular Rule.** Every count and score uses tabular numerals so columns align and ranks can be read down the page.

**The Mono-Means-Literal Rule.** Monospace is only for literal strings a teacher might copy or match: file names, commands, code.

## Layout

A single centred column, max 1180px with 24px side padding (16px under 720px). The pair list is a five-column grid: checkbox 40px, score 92px, students 1fr, signals 1.4fr, action 120px, 16px column gap; column heads sit above it in label type over a hairline. Sections open with 28px top padding. The header and the sticky toolbar run full-bleed with their content inside the same column.

Under 720px the grid tightens to checkbox 28px, score 52px, students, action (10px gap); the weight bar hides, signals wrap to a second line under the names, side-by-side evidence collapses to one column with each cell labelled by student name, and the students table becomes stacked label: value rows.

Print hides the toolbar, tabs, buttons and checkboxes, drops to three columns (score, students, signals), keeps each pair unbroken, and can print a single pair with its evidence open.

## Elevation & Depth

Flat. No shadows anywhere. Depth comes from the dark header panel against the paper ground, the sticky toolbar's hairline bottom rule, and light-paper (or navy-raised) fields sitting on the ground.

### Named Rules
**The Hairline Rule.** Structure is drawn with 1px rules in the rule colour, never with shadows or filled cards. Quotes inside evidence use a dashed hairline.

## Shapes

Square by default. Rows, sections, tables and image frames have no radius. Interactive controls and code blocks get gently softened corners (control radius); the score weight bar is a 4px-tall rounded strip (bar radius) whose width is the score scaled to at most 48px.

## Components

### Buttons
- **Shape:** softened corners (control radius), 1px hairline border.
- **Default:** raised background, ink text, 6px 12px padding, inherits body type.
- **Hover / Focus:** border darkens to muted; focus is a 2px accent outline at 2px offset (global `:focus-visible`).
- One quiet button style only: Evidence / Hide evidence, Print this pair, Clear filters.

### Inputs / Fields
- **Style:** search and selects share the button frame: raised background, hairline border, control radius, 7px 10px padding. Search is up to 260px wide.
- **Checkboxes:** native, 18px, filled with the accent.
- **Focus:** the global accent outline.

### Navigation
- **Tabs:** a row of anchor links with counts, 24px apart over a hairline. 600 weight muted text, count in 400 tabular; hover shifts to ink.
- **Toolbar:** sticky at top, page ground, hairline bottom; search, signal filter, minimum score, hide checked, and a right-aligned tabular "n of m checked".

### Pair Row (signature)
The timetable row: checkbox, score figure with its vermilion weight bar, "A and B" in 600 weight with a muted "and", signal tags as muted text joined by a middle dot, and an Evidence button at the end. Rows are separated by hairlines and open in place to a side-by-side evidence block indented 56px. A checked row turns its score and names muted at regular weight and its bar to the rule colour.

### Charts
Inline SVG drawn by `maat.js`, no library, max 720px wide. Marks are vermilion (measurement) or navy ink (identity); text stays in ink and muted tokens, never the mark colour. Grid lines use the rule colour; numbers are tabular. One shared tooltip on the navy panel colour. Each chart has a table view already on the page (the pairs list, the students table).
- **Who connects to whom:** students with a signal on a circle, one curve per pair; stroke width and opacity scale with score, earlier-year pairs dashed and their student a hollow dot, checked pairs drop to the rule colour. Hover a name to isolate its links; click a curve to open that pair.
- **Writing time:** words against editing time (square-root x), the "pasted?" corner shaded in the vermilion wash, students inside it a vermilion dot with a direct label. Scrolls sideways under 720px rather than shrinking its labels.

### Header Panel
Grained navy panel with the wordmark, the assignment name, muted tabular counts joined by middle dots, and a vermilion "Not checked" line on its own row when helpers were skipped.

## Do's and Don'ts

### Do:
- **Do** carry rank with tabular figures and weight; let the vermilion weight bar be the only graphic in a row.
- **Do** draw structure with 1px hairlines in the rule colour.
- **Do** keep the header on the grained navy panel in both themes, with the vermilion full stop on the wordmark.
- **Do** use vermilion-deep for text on cream and vermilion-night on navy; the raw print vermilion only for graphics.
- **Do** mute finished items rather than hide them, unless the user asks to hide them.
- **Do** keep everything local: system font stacks, inline CSS and JS, no external requests.

### Don't:
- **Don't** use coloured badges or chips for signal types; they are muted text.
- **Don't** introduce a second accent hue or colour-code scores.
- **Don't** add shadows or rounded, filled cards; only controls and code blocks get the 6px corner.
- **Don't** use monospace for anything that isn't a literal file name, command or code.
