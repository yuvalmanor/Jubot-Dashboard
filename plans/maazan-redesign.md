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

Both stop at the same boundary, so `ממוצע חודשי` and `סכום שנתי` always cover the same
months and the columns can be checked against each other by eye.

`ממוצע חודשי` is printed **to the shekel**. `divide` rounds at the agora, so an average
carrying its agorot could be multiplied by the divisor printed in its own header and fail
to return the total in the column beside it — `94,677.00 ÷ 7 × 7` reads `94,677.03`. The
shekel is the precision the figure actually holds. *(Amended 2026-08-16, resolving the
Phase 19 criterion that had asked for the multiplication to hold exactly.)*

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

- [x] `/balance` renders a category × month grid for one year at household or person level
- [x] The משותף grid's figures are the sum of the two personal grids, derived at read time
      <!-- ינואר 2025 הוצאות: 12,410 (יובל) + 16,335 (עדן) = 28,745 משותף, and the year
           365,175 = 135,811 + 229,364. -->
- [x] Tabs are עדן / יובל / משותף and default to משותף; the year defaults to the current one
- [x] The year selector offers exactly the years the ledger holds data for
      <!-- `recordedYears`. The one addition is the selected year itself when it holds
           nothing, marked (ריקה): a control that cannot show its own state would be a
           worse lie than an option that turns out to be empty. -->
- [x] All twelve months are columns; months that have not arrived are visibly inert
- [x] סכום שנתי and ממוצע חודשי are the two leftmost columns, covering one and the same
      list of months, with the average stated to the shekel
      <!-- Both columns are one `Average` over one `denominatorMonths`, so they cannot
           cover different spans. The original wording asked for `ממוצע × n = סכום`
           exactly, which rounding cannot give — `divide` rounds at the agora, so
           94,677.00 ÷ 7 × 7 reads 94,677.03. Resolved 2026-08-16 by printing the ממוצע
           column in whole shekels rather than an agora figure that invites an arithmetic
           it cannot honour; the header decision above now says the same. Verified on
           2026 יובל: 79,024.00 ÷7 shows as 11,289, and the summary strip above the table
           prints the identical figure. -->
- [x] The ממוצע column header states its divisor and its span
      <!-- `ממוצע חודשי ÷7 (ינואר–יולי 2026)`, and `÷6 (יולי–דצמבר 2024)` for the year the
           history only reaches into. -->
- [x] The current month is tinted בתהליך and feeds neither aggregate
      <!-- Verified by writing 312.50 into אוגוסט 2026 and back out: the cell showed it,
           the year's total and average did not move. -->
- [x] A month recorded as zero renders as `0`; a month never recorded renders as a muted `—`,
      and the two are never the same glyph
      <!-- `0.00` against a greyed `—`, which also carries לא נרשם / טרם הגיע for a reader
           who cannot see the grey. -->
- [x] A category appears in a year if it holds a recording that year **or** its lifespan
      overlaps it; a retired category carries a badge and keeps every month it was recorded in
      <!-- Retiring a category can never hide money that was written down. -->
- [x] Income, expenses and חיסכון read as three bands of one table with aligned columns
- [x] The חיסכון line is visibly derived and has no input anywhere
      <!-- The grid carries no control at all: the only input on the page is the sign-out
           form's hidden field. -->
- [x] The month form is reachable at `/balance/month` and behaves exactly as it did
- [x] The grid reading is a pure domain function with no database in its tests

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

- [x] The category column and both aggregate columns stay pinned while months scroll
      <!-- Scrolled to the end of 2025: ינואר's right edge moved 1064 → 1337 while קטגוריה
           held at the container's right edge and both aggregates at its left. The widths
           and the pinned offsets are one set of custom properties, so סכום שנתי parks
           exactly one aggregate column in and cannot overlap ממוצע. `border-separate`,
           because a collapsed border belongs to the table and does not travel with a
           pinned cell; every pinned cell is opaque, so nothing shows through. -->
- [x] The grid is usable on a phone without a separate mobile layout
      <!-- One table. At 375px the columns narrow through the same custom properties —
           at desktop widths the three pinned columns would fill the screen and leave no
           month visible at all. The page itself never scrolls sideways; only the table
           does, and no cell overflows its column. -->
- [x] Rows sort by largest annual sum by default, with a toggle to Hebrew alphabetical
      <!-- `?sort=size|name`, ordered in the domain rather than the markup, so the order
           is testable without a browser. Alphabetical comes from `Intl.Collator("he")`. -->
- [x] Both orders are total and deterministic — the same data always renders the same order
      <!-- Both fall through to the category key, so two rows totalling the same amount —
           or named the same thing, which happens — cannot swap places between reads. -->
- [x] An expand-all toggle shows each משותף row's personal contributions across all months
      <!-- `?expand=1`, one toggle for the whole table. Absent at person level, where a
           row is already personal, rather than present and inert. Each contribution
           carries the owner's name: both People may name a category ארנונה, and two
           identical labels one above the other say nothing about whose money it is. -->
- [x] Each expanded group's contributions sum exactly to the household row above them
      <!-- Checked in the domain and again against the rendered DOM: 14 expanded groups
           in 2025, zero mismatches across all twelve months and סכום שנתי. -->
- [x] A cell is marked only when it deviates materially from its own row's average, measured
      against the row and never against the table
      <!-- Threshold is relative *and* absolute: a 12₪ jump on a 20₪ row is not a finding. -->
      <!-- 50% and 1,000₪, calibrated against the real 2025 year. The money bar is the
           load-bearing one: at 40%/200₪ the table came out marked nearly everywhere,
           because ארנונה and גז are billed every second month and every bill reads as a
           deviation. At these two, ארנונה, חשמל, בתי קפה and מכבי carry no mark at all,
           while חו"ל's מאי and כושר's one 1,336₪ month do. משכורת, twenty times any
           expense row and unchanging, is never marked — the test that the measurement is
           against the row. -->
- [x] `/balance/insights` no longer carries a category breakdown and is trend, year-over-year
      and deviations only
      <!-- The `?period=` control went with it: it existed to switch the breakdown between
           a month and a year. The screen now carries five panels and a line pointing at
           the grid for the question it no longer answers. -->
- [x] No figure appears on both `/balance` and `/balance/insights` computed two different ways
      <!-- The year-over-year figures and the grid's aggregate columns are the same
           `averageOverMonths` over the same `denominatorMonths`; a month's category figure
           on both screens is the same `readGroupMonth`. The one figure reached by two
           routes is a month's band total — `subtotalOf` sums the rows on screen, while the
           trend reads `householdMonthSummary` — and there are now golden tests pinning
           them together month by month *and* over the year, so the two cannot drift. -->
- [x] The ממוצע חודשי column prints to the shekel, matching the amended header decision
      <!-- Added when the Phase 19 criterion above was resolved. `format`'s new
           `withMinorUnits` option; the summary strip prints the same figures the same
           way, so one number never appears at two precisions on one screen. -->

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

- [x] A grid cell links to `/balance/month` for that month
      <!-- Every משותף cell summing two People does, which is the view the screen
           opens in, and so does every month heading. One affordance per cell: at
           5.25rem a phone column holds `37,000.00` and nothing beside it, so a
           second control in the same cell would break Phase 20's no-overflow
           check. `writesTo` decides which of the two a cell gets. -->
- [x] A single cell can be opened and saved inline without leaving the grid
      <!-- `?cell=<categoryId>@<YYYY-MM>`, so an opened cell is a URL like every
           other state on this screen. Verified: מים מאי 2025 blank → 123.45 saved
           in place, row total 1,985.00 → 2,108.45 and average 165 → 176, then
           cleared back to a muted `—` (aria-label לא נרשם, not `0.00`) and the
           total returned to 1,985.00 exactly. -->
- [x] Either person can record amounts in either person's categories
      <!-- `collectWrites` matches fields against the categories that exist rather
           than against who is signed in. Verified live: signed in as יובל, עדן's
           tab now carries 22 inputs where it had none, and 77.50 written into her
           ביגוד והנעלה landed. The tab travels with the write, so a save returns
           to the column it was made in. The משותף tab still has no input at all. -->
- [x] Saving a month with blank categories names them and offers to record them as zero
      <!-- The blanks are recomputed on the page, never carried in the URL, so the
           list cannot be stale. Verified: 7 named, all 7 listed by name. -->
- [x] Declining leaves them unrecorded — the offer is never pre-accepted and never implicit
      <!-- השארה ריקה is a button of its own, and doing nothing writes nothing
           either. After declining, all 7 fields were still empty and the panel
           said so rather than falling silent. -->
- [x] Accepting writes real zeros that are indistinguishable from a hand-typed zero, because
      that is what they are
      <!-- `{ source: "entered", amount: 0 }` — the same shape any typed figure
           has, pinned by a domain test. Verified live: 7 blanks became `0.00`. -->
- [x] A month is closed when every category active in it has a reading, computed from the
      ledger with no stored flag
      <!-- `monthClosure`, off `personMonthLines` / `householdMonthLines`, so a
           recorded figure is never a blank whatever the lifespan since became. A
           closed month is exactly a `complete` one in `completenessOf`'s terms and
           a test pins the two together month by month, so the application holds
           one answer and not two. `empty` is its own state: a month no category
           was active in has nothing to close, which is not everything to close. -->
- [x] A past month can be closed from the grid via an action that lists its blanks first
      <!-- `?close=YYYY-MM` opens a panel above the table naming each blank with
           its owner — both People may name a category ארנונה. It reads the closure
           off the grid itself, so the panel and the column heading above it cannot
           describe different blanks. -->
- [x] There is no action anywhere that closes more than one month
      <!-- Every path goes through `closeOneMonth`, which takes one
           `CalendarMonth`; both callers read one `month` key off one form. There
           is no shape in `planMonthClosure` that reaches two. -->
- [x] The grid marks which closed months are not yet complete
      <!-- On the column heading, for the months the aggregates count and no
           others: `חסרים 12`, which is the link that closes it. A closed one reads
           a quiet `מלא` rather than nothing — a check visible only when it fails
           teaches nobody it is running, and a blank heading would leave "nothing
           missing" and "nothing checked" looking identical. -->
- [x] Closing a month changes no figure that was already recorded
      <!-- The blanks are recomputed at write time and intersected with the ones
           named on screen, so the write can only ever narrow. Verified twice: 12
           zeros into יוני 2025 at household level left all 21 recorded figures and
           both band subtotals untouched (23,256.00 before and after), and 7 zeros
           into עדן's יולי changed none of her 15. -->

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

- [x] Category administration renders below the grid; `/balance/categories` no longer exists
      <!-- `?admin=1`, so the panel is a URL like every other piece of state on this
           screen and a write can land back on it. Closed by default: it is a
           screenful of forms — 84 rename forms against the real data — and the
           question the screen is opened to ask is about the money. The route is
           gone; `/balance/categories` now 404s, verified. -->
- [x] A personal category can be created from the panel, and always creates or joins a
      household category in one indivisible operation
      <!-- `planPersonalCategoryCreation`, which returns the category, the household
           line and the assignment as one result. Verified live: עדן's בדיקת פאנל,
           active from 2025-03, created together with the household line it joins.
           The lifespan is a field, so a category invented today can still cover the
           months it was actually being spent in. -->
- [x] A personal category can be renamed, and `הלווואות` is correctable
      <!-- `planPersonalCategoryRename`. Verified against the real near-miss: עדן's
           `הלווואות` with three ו's, corrected to `הלוואות`. -->
- [x] Renaming a personal category changes no household name, no assignment and no amount
      <!-- Verified live after that rename: the household line was still `הלווואות`,
           the assignment still pointed at it, and the grid's 478 cells hashed
           identically before and after. -->
- [x] Household rename, merge, reassignment and lifespan all work as they did
      <!-- All four exercised live. The merge folded household `הלווואות` into
           `הלוואות`: two rows of 5,000.00 became one of 10,000.00 and the emptied
           line went. -->
- [x] Either person can perform any of these on either person's categories
      <!-- The ownership check is gone — there is no `requireOwn` and no `not-yours`
           outcome. Verified signed in as יובל: renamed עדן's category, created one
           for her, retired it and reassigned it. -->
- [x] No operation in the panel can leave a personal category unassigned
      <!-- The reassign control offers the household lines of that type plus a new
           one, never "none", and every write goes through `planCategoryMerge`,
           which reassigns rather than unassigns. `buildCategories` rejects an
           unassigned model, and the tests assert one assignment per personal
           category after each operation. -->
- [x] No operation can change a category's type or delete anything
      <!-- There is no shape in the domain that does either: no type field on any
           plan, and no `plan…Deletion`. Pinned by a test that runs all four
           lifecycle operations and compares types and ids before and after. An
           emptied *household* line is dropped, which is a name with no amounts
           under it. -->
- [x] Every figure in the grid above reads identically before and after a rename or a merge
      <!-- A merge moves assignments only. The household total is the same money counted
           under a different heading. -->
      <!-- Checked in the domain over the whole history at all three levels, and
           again live: through a personal rename, a household merge, a creation, a
           retirement and a reassignment, the 2025 הכנסות / הוצאות / חיסכון rows
           stayed byte-identical — 570,931.00, 365,175.00, 205,756.00. -->

---

## Phase 22 — what came out differently

The panel is **closed by default**, behind `?admin=1`. The criterion asks for it below the
grid, and it is; rendering ~35 household cards and ~100 personal forms on every read of the
מאזן would have made the screen slower to answer the question it is actually opened for.
Opening it is one link, in the same place the old route's link was.

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

- [x] What the live database currently holds for 2024–2026 is established and recorded before
      any write
      <!-- `npm run db:census`, every statement a select, committed at
           `docs/source/ledger-census.md`: 796 entries across 49 personal
           categories, 2024-07 – 2026-07, month by month at both People. Taken
           against Neon before this phase read the sheet at all. -->
- [x] The מאזן tab is read from the sheet through the Drive connector
      <!-- `read_file_content` on the Mapping spreadsheet. All eleven tabs come
           back in one reading; the four מאזן ones are selected out of it. -->
- [x] A committed script converts what Drive returns into the format `sheet-export.ts` parses
      <!-- `scripts/sheet-refresh.ts` around `src/domain/import/drive-read.ts`.
           The conversion turned out to be a *selection* and not a translation —
           see "what came out differently" below — so what is pinned by tests is
           that it keeps every tab carrying the banner, drops the other seven,
           reproduces the export from its own tables, and refuses a reading with
           no banner rather than writing one tab short. -->
- [x] The conversion is verified block by block against the sheet, with a person confirming
      each
      <!-- `--blocks` prints every cell of all nine blocks against their months.
           Confirmed by Yuval on 2026-08-17, including that אוגוסט 2026 is blank
           because it has not been filled in yet — which is the one thing no
           check here could have distinguished from a stale reading. -->
- [x] The refreshed export parses into the same proposals for months that have not changed
      <!-- A refresh that silently re-reads settled history differently is the failure mode
           this criterion exists to catch. -->
      <!-- All 25 recorded months read identically; the grid came back byte for
           byte identical to the committed export, so the diff is not "no month
           moved" but "no character did". The header is static for exactly this
           reason: a stamp that moved every run would make an unchanged sheet
           produce a changed file, and this answer would be unreadable. -->
- [x] Re-running the import over existing data changes nothing that was already correct
      <!-- `--against-db`, which is read-only: it compares the plan against what
           is stored rather than finding out by writing. 796 of 796 planned
           entries already identical, 0 to insert, 0 to change, 0 categories to
           create, and 0 rows held that the plan does not name. -->
- [x] Each month's recomputed expense total is checked against the sheet's own figure, and
      disagreements are reported per month rather than as one verdict
      <!-- 61 of 62 agree to the agora. The 62nd is יוני 2025, עדן: the sheet
           states 14,814.00 against 15,291.00 in its own rows. Reported as one
           row naming the month and the person, not folded into a verdict. -->
- [x] 2026 through the latest month the sheet holds is readable in the grid
      <!-- The sheet holds through יולי 2026 and the grid reads through יולי 2026.
           Checked live at household level (יולי: 38,147.00 in, 34,045.00 out)
           and at יובל's, whose סה"כ הוצאות row matches the sheet's own month for
           month: 10,605 / 7,988 / 6,679 / 9,371 / 14,915 / 14,477 / 14,989.
           אוגוסט is tinted בתהליך and empty, which is what the sheet says too. -->
- [x] The refresh is repeatable by running one command and reviewing the result
      <!-- `npm run sheet:refresh -- <drive-read> --blocks --against-db` reports
           and writes nothing; `--write` is the separate act. Run twice here: the
           second run reported the file unchanged, which is the property being
           claimed rather than a description of it. -->

---

## Phase 23 — what came out differently

**The export was not stale.** The phase was written to refresh a hand-taken file that
"stops mid-year", and it does stop mid-year — because the *sheet* does. אוגוסט 2026 has not
been filled in. So the refresh moved no figure, and the import that was to follow it had
nothing to write: the live database already held all 796 entries at the planned amounts.
The machinery is still the deliverable, and it is now the thing that can say so cheaply.

**The converter is a selector.** The phase expected a translation — "what Drive returns is
not the format the parser expects". It is that format. `read_file_content` hands back
Markdown tables with merged cells already written as `[merged] label`, the same shape
`sheet-export.ts` has always read, which is presumably how the file was first made. So
`drive-read.ts` reads no figure and moves no column; it decides which tabs are the מאזן and
composes the file. That is a smaller thing than planned and a better one: the only step
that could silently mis-read a block is the one that no longer exists.

**The check against the database is read-only.** "Re-running changes nothing" was going to
be verified by re-running. It is verified instead by comparing the plan against what is
stored and reporting what a write *would* move — which answers the same question without
the answer depending on having already done it, and needs no production write at all.
