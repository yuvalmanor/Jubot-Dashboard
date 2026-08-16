# Plan: מאזן הכנסות-הוצאות — the yearly grid

> Source PRD: the melt of 2026-08-16 (this file records its decisions in full)
> Continues: [plans/jubot.md](jubot.md), whose Phases 2, 3 and 5 built the screens this
> redesign replaces. Phase numbering continues from there.
> Supporting docs: [CONTEXT.md](../CONTEXT.md), [docs/prd/jubot.md](../docs/prd/jubot.md),
> ADRs [0001](../docs/adr/0001-monthly-amounts-with-optional-transaction-backing.md),
> [0004](../docs/adr/0004-framework-free-domain-modules-on-a-zero-cost-stack.md)

The מאזן was built month-first: `/balance` is one month's entry form, and the year only
exists on the analytics screen. The spreadsheet it replaced was year-first — a grid of
categories against months, read down for a month and across for a category. This plan puts
the year back at the front without reintroducing the spreadsheet's failure mode.

## What this supersedes

- **Phase 5's acceptance criterion "Current-year averages divide by elapsed months"** is
  retired by Phase 18 below. The rule becomes *closed* months, clamped to the recorded span.
- **`/balance/categories` as a route** is absorbed by Phase 22 into a panel beneath the grid.
- **`/balance`'s month form** moves to `/balance/month` in Phase 19 and stays the only place
  a whole month is written.

## Architectural decisions

Durable decisions that apply across all phases. Settled during the melt; not to be
re-litigated per phase.

### Routes

| Path | Change |
| --- | --- |
| `/balance` | **now the yearly grid.** `?year=YYYY&view=<personId\|household>&sort=<size\|name>` |
| `/balance/month` | **new.** the month entry form, moved verbatim from `/balance`. `?month=YYYY-MM` |
| `/balance/categories` | **removed.** folds into a panel below the grid |
| `/balance/insights` | narrowed to trend, year-over-year and deviations |
| `/balance/import` | unchanged; gains a repeatable converter feeding its export file |

### The two aggregate columns

Both stop at the same boundary, so `ממוצע חודשי × n = סכום שנתי` holds exactly and the
columns can be checked against each other by eye.

- **The divisor** is the count of *closed calendar months* of the year — months strictly
  before the current one — **intersected with the ledger's recorded span**. It is derived
  from the calendar and the span, never from which cells happen to hold a figure, so every
  row in the table divides by the same number and the column sums correctly.
- 2024 → ÷6 (יולי–דצמבר, the span starts mid-year) · 2025 → ÷12 · 2026 → ÷7 (in August) ·
  a future year → ÷0, which is *undefined*, never nought.
- **The divisor and its span are printed in the column header.** `ממוצע חודשי ÷7 (ינואר–יולי)`.
- **The current month feeds neither aggregate.** It shows its figures in its own column,
  tinted בתהליך.

### Household figures stay derived

Every משותף number is the sum of the two personal ones, computed at read time. There is no
household ledger and no phase here adds one. This is why the משותף tab has no inputs.

### Zero is a fact; blank is the absence of one

`readAmount` returning `null` means the month was never recorded, which is not the same as
a month recorded as zero, and no phase may collapse the two silently. Phase 21 writes zeros
**deliberately** — the blanks are named on screen and the person accepts them — which is
the case the distinction was always protecting.

### A month is *closed*, and closedness is derived

A month is closed when every category active in it has a reading. No column, no flag, no
new state: it is computed from the ledger, so it cannot drift from what the ledger says.

### Ownership

Both People administer both columns and may write into either. The `not-yours` check is
removed in Phases 21 and 22. Category **type** remains immutable and **deletion** remains
absent — retirement is a lifespan, and both exclusions are load-bearing.

---

## Phase 18: the denominator becomes closed months

**User stories**: 16, 17, 19, 20 (revised)

### What to build

`periodDenominator` today returns `today.month` for the current year — 8 in August — so a
2026 average is dragged down by a month that is only half lived. It also returns 12 for any
past year, which halves every 2024 figure, because the ledger's history starts in יולי 2024
and the six months before it never existed.

Both become one rule: the closed calendar months of the year, intersected with the ledger's
recorded span. The span is read from the ledger, not hardcoded, so it stays correct as
history grows backwards or forwards.

Every screen that displays an average moves with it and states the span alongside the count,
because "÷6" without "יולי–דצמבר" is exactly the ambiguity the denominator was introduced to
remove. No new UI, no new route. It lands alone so that if a figure looks wrong afterwards,
exactly one change can have caused it.

### Acceptance criteria

- [x] `periodDenominator` divides a year by its closed calendar months, not elapsed ones
- [x] The divisor is clamped to the ledger's recorded span, so a partly-covered year is
      never divided by months that predate the history
      <!-- 2024 divides by 6, not 12. The span is derived from the ledger; nothing about
           יולי 2024 is written into the code. -->
- [x] A year that has not started still yields a denominator of 0, and an average over it
      is `null` rather than zero
- [x] The current, in-progress month is excluded from the denominator and from period totals
      <!-- A *month* period is still that month, whatever the date: there is no aggregate
           for it to distort, and answering "what did August cost" with nothing because
           August is not over would be a stranger reading than answering it. -->
- [x] `/balance/insights` and `/annual` report the new figures, and display the span
      alongside the count wherever they display a denominator
      <!-- A set of months with gaps prints as "3 חודשים (מתוך ינואר–יוני)", so a trailing
           average over 3 of 6 months never reads as six months' evidence. -->
- [x] `elapsedPeriodMonths` returns exactly the months the denominator counted, so no caller
      can total one span and divide by another
      <!-- Renamed `denominatorMonths`: "elapsed" was the name of the rule it no longer
           follows. `Average` now carries the months themselves, so the invariant is
           structural rather than a convention two call sites have to keep. -->
- [x] Phase 5's "elapsed months" criterion is marked superseded in `plans/jubot.md`
- [x] The module doc comment, which currently argues for the elapsed-month rule, is rewritten
      to argue for this one

---

## Phase 19: the year grid, read-only

**User stories**: 12, 18 · requirement 1

### What to build

`/balance` becomes a year: categories down, months across, at household or per-person level.
It is the tracer bullet — a complete path from the ledger through a new domain reading to a
rendered table — and it is read-only, so nothing about writing has to be settled to ship it.

Three tabs as today (עדן, יובל, משותף), defaulting to **משותף**, because the question the
household opens this screen to ask is the household one. A year selector offering the years
that hold data, defaulting to the current year.

All twelve months are always columns, so the table's shape does not change as the year
passes; months that have not arrived are greyed. סכום שנתי and ממוצע חודשי sit at the left
end, past דצמבר, where the sheet put them. One table with three bands — הכנסות and its
subtotal, הוצאות and its subtotal, then חיסכון as a derived footer line, visibly set apart
because there is nowhere to write it. A summary strip above carries the three averages.

The existing month form moves to `/balance/month` untouched and stays reachable, so no
recording ability is lost while the grid is being built.

### Acceptance criteria

- [ ] `/balance` renders a category × month grid for one year at household or person level
- [ ] The משותף grid's figures are the sum of the two personal grids, derived at read time
- [ ] Tabs are עדן / יובל / משותף and default to משותף; the year defaults to the current one
- [ ] The year selector offers exactly the years the ledger holds data for
- [ ] All twelve months are columns; months that have not arrived are visibly inert
- [ ] סכום שנתי and ממוצע חודשי are the two leftmost columns, and `ממוצע × n = סכום` exactly
- [ ] The ממוצע column header states its divisor and its span
- [ ] The current month is tinted בתהליך and feeds neither aggregate
- [ ] A month recorded as zero renders as `0`; a month never recorded renders as a muted `—`,
      and the two are never the same glyph
- [ ] A category appears in a year if it holds a recording that year **or** its lifespan
      overlaps it; a retired category carries a badge and keeps every month it was recorded in
      <!-- Retiring a category can never hide money that was written down. -->
- [ ] Income, expenses and חיסכון read as three bands of one table with aligned columns
- [ ] The חיסכון line is visibly derived and has no input anywhere
- [ ] The month form is reachable at `/balance/month` and behaves exactly as it did
- [ ] The grid reading is a pure domain function with no database in its tests

---

## Phase 20: the grid earns its density

**User stories**: 15, 18 · requirement 3

### What to build

Fifteen columns is a lot of table, and a lot of table read badly is worse than a list. This
phase makes the grid navigable rather than merely correct.

Horizontal scroll with קטגוריה pinned to the right edge and both aggregate columns pinned to
the left, so on a phone you swipe through months without losing the row you are on or the
totals you are comparing against. One table on every device; no second mobile layout to keep
in sync.

Rows sort by largest annual sum by default — the top of the table is where the money went —
with a toggle to Hebrew alphabetical for when you want the same row in the same place every
time. A single expand-all toggle reveals עדן's and יובל's contributions beneath each משותף
row, which is what makes a surprising household figure traceable without changing tabs.

And a quiet kind of emphasis: a cell is marked only when it deviates materially from **its
own row's average**, so חו"ל's 9,905 in מאי stands out while שכ״ד's identical 7,000 every
month never does. Not a heatmap — tinting three hundred cells by magnitude would mostly
report that rent is larger than bus fare.

`/balance/insights` loses its category breakdown here, since the grid now owns that question,
and is left as the screen that answers whether a figure is *normal*.

### Acceptance criteria

- [ ] The category column and both aggregate columns stay pinned while months scroll
- [ ] The grid is usable on a phone without a separate mobile layout
- [ ] Rows sort by largest annual sum by default, with a toggle to Hebrew alphabetical
- [ ] Both orders are total and deterministic — the same data always renders the same order
- [ ] An expand-all toggle shows each משותף row's personal contributions across all months
- [ ] Each expanded group's contributions sum exactly to the household row above them
- [ ] A cell is marked only when it deviates materially from its own row's average, measured
      against the row and never against the table
      <!-- Threshold is relative *and* absolute: a 12₪ jump on a 20₪ row is not a finding. -->
- [ ] `/balance/insights` no longer carries a category breakdown and is trend, year-over-year
      and deviations only
- [ ] No figure appears on both `/balance` and `/balance/insights` computed two different ways

---

## Phase 21: entry from the grid, and closing a month

**User stories**: 1, 3 · requirements from the melt's Q2 and Q16

### What to build

The grid shows you where the holes are; this phase lets you fill them. A cell links to the
month screen for that month, and a single cell can be opened inline for the one-off case —
"I forgot חו"ל in May" should not require loading a form of twenty-two fields. Either person
may write into either column: the household needs a complete ledger more than it needs to
know whose hand typed a figure.

Then the harder half. A blank cell is ambiguous today: it might be an unfinished month, or
it might be a month where חו"ל simply did not happen. The averages cannot tell these apart,
and treating "no trip in March" as "March is unfinished" would flag most of the year forever.

So the ambiguity is resolved at the point of entry, by a person. On save, any blank
categories are **named on screen** and offered as zero. Accepting writes real zeros — a
deliberate act with the list in view, which is precisely the case the null/zero distinction
exists to permit, as opposed to the silent collapse it exists to forbid. Once accepted the
month is closed, and closedness is derived from the ledger rather than stored.

Imported history is full of the same ambiguity, and it gets the same treatment one month at
a time: a `סגירת חודש` action that lists that month's blanks before writing anything. There
is deliberately no bulk path. Rewriting two years of history in one click is the kind of
irreversible mass edit that should not have a button.

### Acceptance criteria

- [ ] A grid cell links to `/balance/month` for that month
- [ ] A single cell can be opened and saved inline without leaving the grid
- [ ] Either person can record amounts in either person's categories
- [ ] Saving a month with blank categories names them and offers to record them as zero
- [ ] Declining leaves them unrecorded — the offer is never pre-accepted and never implicit
- [ ] Accepting writes real zeros that are indistinguishable from a hand-typed zero, because
      that is what they are
- [ ] A month is closed when every category active in it has a reading, computed from the
      ledger with no stored flag
- [ ] A past month can be closed from the grid via an action that lists its blanks first
- [ ] There is no action anywhere that closes more than one month
- [ ] The grid marks which closed months are not yet complete
- [ ] Closing a month changes no figure that was already recorded

---

## Phase 22: category management under the grid

**User stories**: 3, 5, 6, 10, 23

### What to build

Category administration moves from its own route to a panel beneath the grid, where the
consequences of a change are visible in the table above it. Everything `/balance/categories`
does today comes across — rename a household category, merge two, reassign a personal one,
move a lifespan — and two things it never did are added.

**Creation**, which today exists only on the month form, so making a category has always
required going somewhere you did not want to be. And **renaming a personal category**, which
exists nowhere at all. That gap is not hypothetical: the sheet carried `הלווואות` with three
ו's in one column against `הלוואות` in the other, the importer noticed the near-miss and
reported it, and there is currently no screen in the application that can correct it.

Both People administer both columns. Type stays immutable and nothing is ever deleted;
retirement remains a lifespan, so every month a category was recorded in keeps reading
exactly as it did.

### Acceptance criteria

- [ ] Category administration renders below the grid; `/balance/categories` no longer exists
- [ ] A personal category can be created from the panel, and always creates or joins a
      household category in one indivisible operation
- [ ] A personal category can be renamed, and `הלווואות` is correctable
- [ ] Renaming a personal category changes no household name, no assignment and no amount
- [ ] Household rename, merge, reassignment and lifespan all work as they did
- [ ] Either person can perform any of these on either person's categories
- [ ] No operation in the panel can leave a personal category unassigned
- [ ] No operation can change a category's type or delete anything
- [ ] Every figure in the grid above reads identically before and after a rename or a merge
      <!-- A merge moves assignments only. The household total is the same money counted
           under a different heading. -->

---

## Phase 23: Drive-backed sheet refresh

**User stories**: 21, 22, 23 · requirement 4

### What to build

`docs/source/maazan-sheet-export.md` already carries the 2026 tab through יולי, and
`applyImportPlan` is upserts throughout so re-running is safe by construction. What is
missing is a way to *refresh* it: the export was taken by hand, it stops mid-year, and
anything added to the sheet since — August figures, corrections, new categories — is not
here.

The sheet is
[Mapping](https://docs.google.com/spreadsheets/d/1tOw032pAwJSVOVv66wnILR1X5rxVVCI2paNAzDdJGLg/edit?gid=285116412),
read through the Drive connector. What Drive returns is not the format the parser expects —
`sheet-export.ts` reads markdown tables with merged cells written as `[merged] label` — so
this phase builds the converter between them, and commits it, so the next refresh is a
command rather than an afternoon.

Done tab by tab with the household watching, because a converter that silently mis-reads one
block produces a plausible import, and a plausible wrong import is worse than a failed one.
The existing review screen is the backstop: it still proposes rather than decides, still
reports every row it declines and why, and still checks each month's recomputed total against
the sheet's own `סה"כ הוצאות`.

Before anything is written, confirm what the live database already holds — the export sitting
in the repository is not evidence that the import was ever run against it.

### Acceptance criteria

- [ ] What the live database currently holds for 2024–2026 is established and recorded before
      any write
- [ ] The מאזן tab is read from the sheet through the Drive connector
- [ ] A committed script converts what Drive returns into the format `sheet-export.ts` parses
- [ ] The conversion is verified block by block against the sheet, with a person confirming
      each
- [ ] The refreshed export parses into the same proposals for months that have not changed
      <!-- A refresh that silently re-reads settled history differently is the failure mode
           this criterion exists to catch. -->
- [ ] Re-running the import over existing data changes nothing that was already correct
- [ ] Each month's recomputed expense total is checked against the sheet's own figure, and
      disagreements are reported per month rather than as one verdict
- [ ] 2026 through the latest month the sheet holds is readable in the grid
- [ ] The refresh is repeatable by running one command and reviewing the result
