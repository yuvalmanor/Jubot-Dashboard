# Plan: Jubot — Household Financial Dashboard

> Source PRD: [docs/prd/jubot.md](../docs/prd/jubot.md)
> Supporting docs: [CONTEXT.md](../CONTEXT.md), ADRs [0001](../docs/adr/0001-monthly-amounts-with-optional-transaction-backing.md), [0002](../docs/adr/0002-annual-review-freezes-only-unrecomputable-facts.md), [0003](../docs/adr/0003-illiquid-assets-are-held-at-cost.md), [0004](../docs/adr/0004-framework-free-domain-modules-on-a-zero-cost-stack.md)

## Architectural decisions

Durable decisions that apply across all phases. Everything here is settled before Phase 1
and should not be re-litigated per phase.

### Stack and hosting

- **Next.js (App Router) + TypeScript** on **Vercel** Hobby. **Postgres** on Neon or
  Supabase free tier. **Tailwind + shadcn/ui**. Cost target is zero for two users; no phase
  may introduce a dependency that requires a paid tier.
- **Auth.js with Google OAuth**, allow-list of exactly two accounts. Every route is
  authenticated — there is no public surface, no roles, no permissions.

### Layering

- Domain modules live under `src/domain/` and import **nothing** from Next.js, React, or
  the database client (ADR 0004). They take plain data and return plain data.
- Persistence and rendering wrap the domain from outside. Data is fetched at the edge and
  handed to domain functions; a domain function never queries.
- Tests are plain-data-in/plain-data-out against each module's public interface. No
  database, browser or network in the domain test suite.

### Routes

Laptop-first, readable on a phone. `dir="rtl"` at the document level; English is preserved
for terms like RSU, ACWI, IRR.

| Path | Area |
| --- | --- |
| `/` | dashboard overview |
| `/balance` | מאזן הכנסות-הוצאות — month entry and reading |
| `/balance/categories` | category administration (personal, household, assignments) |
| `/balance/insights` | trends, averages, deviations, year-over-year |
| `/balance/import` | sheet import review (disposable) |
| `/snapshots` | מיפוי — snapshot list and history |
| `/snapshots/[id]` | one snapshot |
| `/snapshots/compare` | two snapshots side by side |
| `/accounts` | account definitions, positions, earmarks |
| `/net-worth` | שווי נטו — trajectory, exposure, allocation, decomposition |
| `/projects` | נכסים ופרוייקטים |
| `/projects/[id]` | one project: legs, expenses, יתרה, deal terms |
| `/rsu` | מחשבון RSU — position, tax, selection, schedule |
| `/planning` | לוח תכנון — scenario list |
| `/planning/[id]` | one scenario |
| `/annual/[year]` | סיכום שנתי |
| `/settings` | rates, fees, GP window, appreciation assumption, targets |

### Schema shape

- **Amounts are integer minor units with an explicit currency code.** Never floats, never a
  bare number. Every amount crossing a boundary is a `Money`.
- `people` — exactly two rows.
- `personal_categories` — owner person, name, `type` enum (`income | expense`),
  `active_from`, `active_until`. Retirement is a lifespan, never a delete.
- `household_categories` — own name, independent of the personal names feeding it.
- `category_assignments` — personal → household, many-to-one. **No personal category may be
  unassigned in any state.**
- `entries` — keyed `(year, month, personal_category_id)`, real calendar months. Optional
  transaction backing per ADR 0001: a category-month is *either* entered *or* derived,
  never both. All reads go through one accessor that hides which applies.
- `accounts` — belongs to a person, native currency, `value_basis` enum
  (`market | cost | estimate`), קטגוריה and סוג נכס for rollups.
- `snapshots` — dated, complete by construction, carrying its own FX rate per currency
  pair. Historical snapshots never re-convert.
- `snapshot_lines` — one per active account per snapshot, with an `entered | carried` flag.
- `positions`, `earmarks` — held against an account.
- `projects`, `funding_legs` `(source, amount, currency, rate)`, `project_expenses`,
  `deal_terms`. The blended effective rate is **computed on read**, never stored.
- `rsu_grants`, `rsu_vests`, `rsu_sales`. Lot qualification is **derived** from grant date
  + 24 months, never a stored flag, so the boundary moves correctly with time.
- `scenarios`, `funding_plans` — read recorded data, write none of it.
- `annual_reviews` — stores only the year's unrecomputable facts (ADR 0002).
- `settings` — GP window, fee rates, tax rates, appreciation assumption, allocation targets.

### Key domain models

`Money`, `Categories`, `Ledger`, `LedgerAnalytics`, `Snapshot`, `NetWorthAnalytics`,
`Projects`, `RsuPosition`, `RsuTax`, `LotSelector`, `Scenarios`, `AnnualReview`,
`SheetImporter`.

### Invariants that hold from the phase they appear in, forever after

- Household figures are always derived from personal ones. There is no writable household
  ledger.
- חיסכון is always `הכנסות − הוצאות`, computed, never entered.
- `יתרה = Σ(funding legs) − Σ(expenses)` for every project, under any sequence of
  operations.
- Illiquid assets are held at cost and never re-valued (ADR 0003). A project's מיפוי value
  does not fall as its expense ledger is spent down.
- Currency exposure is derived from what an asset *is*, never from how it was funded.
- Every average displays its own denominator.

### Blocking open items

Two PRD questions must be answered before **Phase 12** begins, and neither is a coding
task:

1. **GP window.** The sheet averages closes from grant date −15 to +15 days; סעיף 102
   generally uses the average over the 30 trading days *preceding* the grant. This shifts
   the ordinary/capital-gains boundary on every row. Confirm against a real ESOP statement
   or with the household's רו"ח. It is a setting precisely so this can be corrected without
   a code change.
2. **Qualified/Unqualified share counts.** `RSU_Grants!M50` in the live sheet holds the
   formula behind the $68,619 / $48,879 split. The markdown export lost cell references and
   the two blocks appear priced differently (219 shares at 313.33 vs 214 at roughly 228).
   Read from the live sheet before RsuPosition is built.

---

## Phase 1: Tracer bullet — signed-in Hebrew shell over a live database

**User stories**: 89, 90, 91, 92, 93, 94, 95, 96

### What to build

The thinnest possible complete path through every layer, deployed. A visitor hits the
dashboard, is bounced to Google sign-in, is admitted only if their address is one of the
two on the allow-list, and lands on a right-to-left Hebrew shell that reads a single stored
amount from Postgres and renders it in Hebrew locale conventions with its dollar figure
alongside its shekel figure.

This phase exists to prove the pipe, not to deliver a feature. The one thing it delivers
for real is `Money`: the value type every later phase depends on, with conversion at an
explicit rate, rounding at minor-unit boundaries, refusal to add across currencies, and
Hebrew formatting. Getting it right here means no later phase has to think about it.

The layout is laptop-first — wide tables and side-by-side panels have room — and degrades
to readable (not enterable) on a phone. English terms are preserved inside Hebrew text.

### Acceptance criteria

- [ ] The app is deployed to Vercel and reachable at a stable URL, on free tiers only
      <!-- Needs the household's Vercel and Neon/Supabase accounts; see README "Deploying". -->
- [x] An address not on the two-account allow-list is refused, and no route renders data
      for it
- [ ] Both household accounts can sign in with Google and reach the dashboard
      <!-- Needs a real Google OAuth client and the two real addresses. -->
- [x] The document is `dir="rtl"` and the shell renders in Hebrew
- [x] `Money` is a framework-free module: conversion at an explicit rate, minor-unit
      rounding, an error when adding across currencies, Hebrew-locale formatting
- [x] `Money` has tests asserting exact minor-unit integers, running with no database,
      browser or network
- [x] A dollar amount renders with its native figure alongside the shekel figure
- [x] A stored amount round-trips from Postgres to the screen as integer minor units with
      an explicit currency code
- [x] The shell is legible on a phone viewport without horizontal scrolling

---

## Phase 2: מאזן — recording a month

**User stories**: 1, 2, 3, 4, 7, 8, 13, 21

### What to build

A person signs in, picks a month, and types an amount against each of their own
categories. When they need a category that does not exist, they create it inline — naming
it themselves, marking it הכנסה or הוצאה once — and it is immediately usable without
leaving the screen. Creating it also creates or joins a Household Category, so the money
can never be recorded at the personal level and vanish at the household level.

חיסכון for the month is shown as `הכנסות − הוצאות`, computed on read. Any past month can
be reopened and corrected. Months are real calendar months in one continuous ledger with
no year boundaries to stitch across.

This is the first slice of `Categories` and `Ledger`. The Ledger accessor is built now with
the entered/derived seam from ADR 0001 in place, even though only the entered path has a
producer in this PRD.

### Acceptance criteria

- [x] A person can enter an amount for each of their own categories for a chosen month
- [x] Each person's categories are separate — the same real-world spend can be named
      `בריאות` by one and `רפואה` by the other
- [x] A new personal category can be created during entry without leaving the screen
- [x] Creating a personal category always creates or joins a household category; there is
      no reachable state in which a personal category is unassigned
- [x] Category Type is set once at creation and is not variable per month
- [x] חיסכון displays as `הכנסות − הוצאות` and is nowhere writable
- [x] Any month in any year can be reopened and a figure corrected
- [x] Entries are keyed by real calendar `(year, month)` and read as one continuous ledger
- [x] The Ledger accessor returns the entered value and is the only read path for a
      category-month; a category-month cannot be both entered and transaction-backed
- [x] A missing month is distinguishable from a month of zeros
- [x] `Categories` and `Ledger` tests run on plain data with no database

---

## Phase 3: מאזן — household view and category lifecycle

**User stories**: 5, 6, 10, 11, 12, 24

### What to build

The same month, read at three levels: mine, Eden's, or the household's. A household
category can be renamed to something clearer than either personal name feeding it, and two
personal categories can be merged so they read as one household line — both without
touching the personal names or losing any history.

A category that has stopped being used is retired rather than deleted: it disappears from
current months and still resolves correctly for the past months it appears in. Months where
only part of the data has been entered are marked as incomplete, so a half-entered month is
never mistaken for a cheap one.

Any household number can be drilled into to see the personal categories that produced it.

### Acceptance criteria

- [x] A month can be read as personal (either person) or household
- [x] Two personal categories can be merged into one household category, and both
      contribute to the same household line afterwards
- [x] Merging preserves all prior entries; no historical figure changes
- [x] A household category can be renamed without changing any personal category name
- [x] A retired category no longer appears for current months but still resolves for past
      months, which read exactly as they did before
- [x] A household category figure can be drilled into to reveal its contributing personal
      categories and their amounts
- [x] Incomplete months are visibly marked as such
- [x] Household totals are derived at read time; no writable household ledger exists

---

## Phase 4: מאזן — sheet import for 2022–2026

**User stories**: 22, 23

### What to build

`SheetImporter` translates the Google Sheet export into personal categories and entries for
2022–2026 and *proposes* a set of category assignments rather than committing its guesses.
A review screen presents those proposals for confirmation or correction before anything is
written as final.

The importer handles the known damage in the source: `#REF!` errors in the נדל"ן block,
`#DIV/0!` in the 2026 משותף `אוכל APPLE` row, and the Jan–Jun 2025 months that appear in
both the 2024 and 2025 tabs with identical values. The July–June tab boundaries were
presentational — every figure is already calendar-keyed and imports directly.

The module is isolated and disposable by design. It is placed before analytics so that the
trend screens are built and eyeballed against four years of real data, and so that the
sheet's surprises surface while the category model is still cheap to change.

### Acceptance criteria

- [ ] 2022–2026 income and expense history is imported and readable through the Phase 2/3
      screens
      <!-- 2024-07 – 2026-07 is imported and verified readable. 2022–2023 is not: the only
           tab holding it is the 2023 tab, which the PRD puts out of scope and whose layout
           differs from the three the importer reads. Surfaced rather than reinterpreted. -->
- [x] The importer produces *proposed* category assignments; nothing is finalised without
      human confirmation
- [x] Proposed assignments can be reviewed and corrected before commit
- [x] Each overlapping Jan–Jun 2025 month resolves to exactly one entry
- [x] Per-person categories land under the correct person
- [x] Totals recomputed from imported entries match the sheet's own stated totals for a
      sampled set of months
      <!-- 61 of 62 stated monthly totals match to the agora. The 62nd is the sheet
           disagreeing with itself: עדן's ארנונה for 2025-06 is 477 on the 2024 tab and
           blank on the 2025 tab. Reported on the review screen, not absorbed. -->
- [x] `#REF!` and `#DIV/0!` cells are flagged for human correction rather than imported as
      values
- [x] `EPP` is treated as Apple's food benefit — an ordinary expense pairing with
      `אוכל APPLE` under one household category — not as ESPP
- [x] Importer tests run against fixtures taken from the real sheet export
- [x] The importer imports nothing from Next.js, React or the database client

---

## Phase 5: מאזן — trends, averages and deviations

**User stories**: 9, 14, 15, 16, 17, 18, 19, 20

### What to build

The reading half of the מאזן, built on four years of imported data. A monthly trend of
הכנסות, הוצאות and חיסכון with the previous year alongside. A ranked list of the categories
whose current month deviates most from their own trailing average, so the screen says what
is unusual instead of presenting twenty numbers to scan. Category breakdowns for a month or
a year, at household and per-person level. חיסכון as a percentage of income over time. Each
category against the same period last year.

Averages for the current year divide by elapsed months so a partial year compares against a
full one, and **every average displays its denominator** — the reader never has to guess
whether it divided by 6 or 12.

`LedgerAnalytics` is pure functions over entries and returns the denominator alongside every
average it produces.

### Acceptance criteria

- [x] This month's חיסכון is visible as the amount available to move into projects
- [x] A monthly trend of הכנסות, הוצאות and חיסכון shows the previous year alongside
- [x] Each category's current month is compared to its own trailing average, ranked by
      largest deviation first
      <!-- A category with no trailing history is reported as having none rather than
           compared against an invented zero, and one with history but no figure this
           month is reported rather than ranked as a fall to zero. Both sit below the
           measured deviations. -->
- [x] Current-year averages divide by elapsed months; complete years divide by twelve
- [x] Every displayed average shows the denominator used
- [x] Category breakdowns are available for a month or a year, at household and per-person
      level
- [x] חיסכון as a percentage of income is charted over time
- [x] Each category is comparable against the same period last year, including categories
      that did not exist in the comparison year
      <!-- Both sides are trimmed to the same span, so a partial year is never set
           against a full one. A category absent last year reads "לא הייתה קיימת". -->
- [x] Deviation ranking is stable across repeated computation
- [x] `LedgerAnalytics` is pure functions with no database in its tests

---

## Phase 6: מיפוי — accounts and a complete snapshot

**User stories**: 25, 26, 27, 28, 29, 31, 32, 34

### What to build

Accounts are defined once — belonging to a person, carrying a native currency, a Value
Basis (שווי שוק / עלות / הערכה), and a קטגוריה and סוג נכס for rollups. Taking a snapshot
seeds a row for every active account from the previous snapshot, so a snapshot is complete
by construction and never partial or ambiguous about when it applies.

Restating means correcting what changed rather than re-typing everything, and the system
records for each row whether the value was **entered or carried forward** — so a pension
untouched for five months does not masquerade as a measured flat line.

Snapshots are taken whenever the household chooses; no cadence is imposed. Each snapshot
carries exactly one FX rate, so every dollar figure inside it converts consistently, and
historical snapshots never re-convert.

### Acceptance criteria

- [x] An account carries a person, a native currency, a Value Basis, a קטגוריה and a
      סוג נכס
- [x] Value Basis is required on every account
- [x] Creating a snapshot seeds every active account from the previous snapshot's value
      <!-- An account with no line in the previous snapshot — a newly defined one, or the
           first snapshot ever — seeds as never measured rather than as a zero somebody
           stated. An account defined after a snapshot was taken is reported on it as
           missing rather than silently absent. -->
- [x] A snapshot has a date and can be taken at any time with no enforced cadence
      <!-- One snapshot per date, so "the previous snapshot" is never ambiguous. That is
           the only constraint on when: a day later and a year later are both accepted. -->
- [x] Each row records whether its value was entered or carried forward, and this is
      visible when reading the snapshot
      <!-- A carried row also states the day it was last actually measured. Changing a
           figure records it as measured; resubmitting the form unchanged does not, which
           is what the נמדד checkbox is for. -->
- [x] Balances are held in the account's native currency and are not pre-converted
- [x] A snapshot stores exactly one FX rate per currency pair, and every conversion inside
      it uses that rate
- [x] Re-reading a historical snapshot produces the same converted figures it produced when
      taken
      <!-- Verified live: $100,000 reads as 365,000₪ in the January snapshot and 320,000₪
           in the July one, at each snapshot's own rate, both after the other was written. -->
- [x] Rollups by נזילות, השקעות and פנסיה work from קטגוריה and סוג נכס

---

## Phase 7: מיפוי — history, comparison, and derived currency tables

**User stories**: 30, 33, 35, 36

### What to build

The שקל and דולר tables are derived from the snapshot rather than maintained beside it, so
they cannot drift from it or from each other — this is the direct fix for the pension
reading 519,088 in one table and 450,376 in the other.

Totals state how much of the figure is held at cost rather than measured, making the mix an
explicit fact instead of a hidden inconsistency (ADR 0003). The full snapshot history is
browsable, and any two snapshots can be placed side by side to see exactly what moved.

### Acceptance criteria

- [x] The שקל and דולר tables are computed from the snapshot; neither is separately
      editable
      <!-- One function with a different currency argument. Both directions run off the
           snapshot's single rate — shekels read back as dollars by dividing by it, never
           by an inverse rounded to a few decimals, which would be a second rate. -->
- [x] The same account reads identically in both tables
      <!-- Verified live: the pension is 450,376₪ and $123,390.68 in the January snapshot
           — one recorded figure, two readings of it. -->
- [x] Every total states how much of it is held at cost versus measured
      <!-- The snapshot total, both table totals and every rollup bucket. A share of
           nothing prints as nothing rather than as 0%. -->
- [x] The complete snapshot history is browsable by date
      <!-- The list states how many it holds; each snapshot carries the previous and next
           dates, so the series is walkable from inside one reading. -->
- [x] Any two snapshots can be compared side by side with per-account differences shown
      <!-- Differences are in the account's own currency, so a rate move cannot look like
           money moving. The totals are each read at their own snapshot's rate, and the
           screen says when those rates differ rather than decomposing the difference,
           which is Phase 10's work. -->
- [x] A comparison distinguishes rows that changed from rows that were carried forward
      <!-- The two are orthogonal and both are reported: a row carrying April's figure
           against a January reading has changed and was not measured, and reads as both.
           A side nobody ever measured yields no difference rather than an invented one. -->

---

## Phase 8: מיפוי — positions and earmarks

**User stories**: 37, 38, 39, 40

### What to build

Two different claims on what is inside an account. A **Position** records what the money is
invested in — `1159235 ACWI`, `1209220 FTSE` — answering "what did we buy"; positions move
with the market and nothing is wrong when they do. An **Earmark** records what money is
promised to — קרן חירום's 120,000₪ inside the איילון fund — answering "what is this money
spoken for".

Unlike a position, an earmark can be **underfunded**, and that is a meaningful state worth
surfacing: spending from the emergency fund shows up as a shortfall rather than quietly
disappearing. From this, the screen answers how much of the household's liquid money is
genuinely free after everything already claimed.

### Acceptance criteria

- [x] Positions can be recorded inside an investment account and read back per account
      <!-- A position carries no amount: how much an account holds is a dated fact and the
           snapshot owns it, so a figure stored beside it could only drift from it. An
           account held at cost is refused one — per ADR 0003 nothing in it is priced. -->
- [x] Earmarks can be recorded against money in an account
      <!-- In the account's own currency, held there by a composite foreign key. Releasing
           one is a lifespan, so a claim declared in 2026 does not appear on a 2025
           snapshot, and one released later still reads on the snapshots it stood for. -->
- [x] An earmark whose backing has fallen below its claim is shown as underfunded, with the
      shortfall figure
      <!-- An account nobody ever measured reads as unmeasured rather than underfunded — a
           placeholder is not a shortfall. Claims on one account are assessed together,
           because they compete for the same money and no priority between them exists. -->
- [x] Free liquid money is computed as liquid holdings less earmarked amounts
      <!-- נזילות only: a claim on an account in another bucket is spoken for out of that
           bucket. The claim is subtracted whole even where its backing is short, and the
           unbacked part is stated beside it rather than written off. -->
- [x] Spending an earmarked account down surfaces as a shortfall rather than reducing the
      earmark silently
      <!-- Verified live: restating the liquid account from 61,400₪ to 25,000₪ left the
           40,000₪ claim untouched and reported 15,000₪ missing, with free liquid money
           reading −15,000₪ rather than clamping to zero. -->


---

## Phase 9: שווי נטו — trajectory, exposure and allocation

**User stories**: 41, 45, 46, 47, 48

### What to build

The derived view over the snapshot history. Net worth over time as a trajectory rather than
today's number alone. Currency exposure computed from what each asset *is* — a
dollar-denominated stake counts as fully exposed regardless of whether the money that
bought it started as shekels. Current allocation against the household's רצוי targets,
showing where it is over- and under-weight. The share of household wealth sitting in Apple
RSU, so concentration is visible rather than implicit.

A property-appreciation assumption the household controls lets net worth be read as a
range rather than a falsely precise number. Per ADR 0003 the assumption never becomes a
fact in מיפוי: any screen implying growth either excludes cost-held assets or states the
assumption it applied.

### Acceptance criteria

- [x] Net worth over time is charted from the snapshot history
      <!-- Each point at its own snapshot's rate. A snapshot carrying no rate for a currency
           it holds has no point rather than a total with those accounts dropped out, and a
           change measured across two different rates is labelled as such rather than read
           as growth. -->
- [x] Currency exposure is derived from each account's native currency and is unaffected by
      funding history
      <!-- The Account's own currency is the only input; nothing in a Snapshot records how an
           asset was funded, and this would not consult it if it did. -->
- [x] Current allocation is displayed against רצוי targets with over- and under-weights
      identified
      <!-- Verified live: at 1,134,176₪ against 10/25/32.5/30, נזילות reads 52,017.60₪ under
           and פנסיה 81,768.80₪ over. Every bucket appears whether or not it holds anything,
           an untargeted bucket is not "on target", and a set of targets adding to 97.5% is
           reported as such rather than completed to 100%. -->
- [x] The appreciation assumption is a household-editable setting, not a constant
      <!-- `/settings`, stored in whole basis points. Blank is nought — "we assume nothing"
           is a position, and it is the one the system starts from. -->
- [x] Any figure incorporating the appreciation assumption states the assumption applied,
      or excludes cost-held assets
      <!-- The range panel prints all three: recorded, recorded excluding cost-held, and the
           grown figure beside the rate and the exact multiplier it used. The assumption is
           carried on the result, so the grown figure has nowhere to be printed alone. -->
- [x] The Apple RSU share of total wealth is displayed
      <!-- Verified live: $112,500 reads as 360,000₪, 31.7% of 1,134,176₪. The accounts are
           named by id rather than matched on a name, so a rename cannot make the
           concentration read as zero, and one marked but absent from the snapshot is
           reported rather than counted as nothing. -->
- [x] CGM 2 is classified under נדל"ן, and allocation percentages read accordingly
      <!-- Verified live against the real account: $82,000 held at cost reads under נדל"ן at
           23.1%, and none of it under נזילות. -->

---

## Phase 10: שווי נטו — change decomposition and reconciliation

**User stories**: 42, 43, 44

### What to build

The phase that makes the two halves of the system check each other. Every change between
two snapshots is decomposed into money added, market movement, and currency movement — so
an earned month reads differently from a lucky one.

The "money added" figure is then reconciled against חיסכון from the מאזן for the same
period. When the two disagree, the residual is reported rather than absorbed: an untracked
expense or a forgotten account surfaces in weeks rather than sitting undiscovered for
years. This is the check the spreadsheet never had.

### Acceptance criteria

- [ ] The change between two snapshots is decomposed into money added, market movement and
      currency movement
- [ ] The decomposition sums exactly to the total change with no residual when inputs are
      consistent
- [ ] The reconciliation compares money added against the מאזן's חיסכון for the same period
- [ ] When the two disagree, the residual is displayed as a flagged discrepancy, not
      silently absorbed
- [ ] The discrepancy is surfaced where it will be seen, not only on a detail screen
- [ ] `NetWorthAnalytics` decomposition and reconciliation are tested on plain data with
      exact minor-unit assertions

---

## Phase 11: נכסים ופרוייקטים — the closed pot

**User stories**: 49, 50, 51, 52, 53, 54, 55, 56, 57

### What to build

Each project is a closed pot of capital. Funding Legs fill it, each recording the currency
and the rate actually used — CGM 1 was funded by 109,800₪ and by $69,000 of Apple RSU — so
the effective blended rate is derived on read, never maintained by hand. That blended rate
is shown against today's rate, answering whether the conversion was a good one.

Expenses are drawn *out of* the pot and never added to it, so `יתרה = legs − expenses`
holds under every sequence of operations. Putting more money in means adding a Funding Leg;
the balance can never go negative or be silently topped up. What remains undeployed is
visible — CGM 1's $21,188 not yet working.

Each project's stated Deal Terms are recorded from the sponsor's paperwork as data. They
are a promise, not a measurement, and Phase 15 consumes them.

Per ADR 0003, a project's מיפוי value stays at total cost as its expense ledger is spent
down — converting cash into property is not losing money.

### Acceptance criteria

- [ ] A project records its funding legs, each with source, amount, currency and the rate
      used
- [ ] The effective blended rate is computed on read and matches hand-computed values for
      the real CGM 1, CGM 2 and Meteor structures
- [ ] The blended rate is displayed against today's rate
- [ ] A project has a running expense ledger showing what was spent and on what
- [ ] `יתרה = Σ(legs) − Σ(expenses)` holds after any sequence of legs and expenses
- [ ] An expense that would exceed the pot is refused; adding money requires a new funding
      leg
- [ ] Undeployed capital is displayed per project
- [ ] Deal Terms are recorded per project as data, entered by hand
- [ ] A project's snapshot value remains at total cost as its expense ledger is spent down

---

## Phase 12: RSU — position, lots and the 24-month clock

**User stories**: 58, 59, 60, 61, 62, 63, 70, 71

> **Blocked until** the GP window and the `RSU_Grants!M50` share counts are resolved — see
> *Blocking open items* above.

### What to build

The position, grounded in real grant documents. Each grant with its ID, date and total
shares; each vest with its date, shares and price at vest; future vests recorded ahead of
time so the forecast has something to work with; shares sold recorded against a specific
lot so the remaining position is accurate.

Every lot carries its own סעיף 102 clock, derived from its grant date plus 24 months —
never a stored flag, so the boundary moves correctly as time passes. The position reads as
Qualified and Unqualified shares, making visible how much is exposed to the 62.17% rate.

GP is estimated from market data over a **configurable window**, because the correct window
for סעיף 102 is exactly the thing that needs confirming. Estimated GP figures are flagged
in the UI so it is always clear which tax numbers rest on an approximation.

### Acceptance criteria

- [ ] Grants are recorded with ID, date and total shares
- [ ] Vests are recorded with date, shares and price at vest
- [ ] Future vests can be recorded and are excluded from the current position
- [ ] A sale is recorded against a specific lot and reduces that lot
- [ ] Lot qualification is derived from grant date + 24 months, with no stored flag
- [ ] The 24-month boundary is correct on the day before, the day of, and the day after
- [ ] The position displays Qualified and Unqualified share counts
- [ ] The GP estimation window is a setting changeable without a code change
- [ ] Estimated GP figures are visibly flagged as estimates

---

## Phase 13: RSU — tax under both treatments

**User stories**: 64, 65, 66, 69

### What to build

The gap the spreadsheet could not express. Given a lot, a sale price, a sale date and the
rate settings, `RsuTax` produces the full breakdown and net proceeds under **both**
treatments: Qualified (grant-price average as ordinary income, appreciation at the
capital-gains rate) and Unqualified (the entire gain as ordinary income at 62.17%). The
right treatment is chosen per lot automatically from its own clock, so an early sale is
never quietly priced as though the 24 months had run.

From this: what actually lands in the bank if a given number of shares is sold today, in
both USD and ILS; and what waiting is worth for any lot — net today versus net once
Qualified — turning the timing decision into a number instead of a preference.

Broker and trustee fees are inputs, not constants, and are subtracted from net proceeds
rather than from the taxable base.

### Acceptance criteria

- [ ] The Qualified path reproduces the existing spreadsheet rows exactly — row 1: 19
      shares at $280 with GP 149.4219 yields tax $2,385.14 and net $2,934.67
- [ ] The Unqualified path taxes the entire gain as ordinary income
- [ ] Treatment is selected per lot from its own qualification date, automatically
- [ ] Selling a given number of shares today reports net proceeds in both USD and ILS
- [ ] Any lot can be shown as net-today versus net-once-Qualified, with the difference
      stated
- [ ] Fees are settings, not constants, and are subtracted from net proceeds and not from
      the taxable base
- [ ] `RsuTax` tests assert exact figures against the household's existing sheet rows

---

## Phase 14: RSU — lot selection, forward schedule, and feeding מיפוי

**User stories**: 67, 68, 72

### What to build

`LotSelector` answers the funding question: to raise a target amount by a target date,
which lots should be sold to incur the lowest total tax? It composes `RsuPosition` and
`RsuTax` and is isolated so the selection strategy can be replaced without touching the tax
maths. Lots not yet vested at the target date are excluded.

Alongside it, a forward vest schedule with projected value at today's price — forecasts are
flat at the current price, with no growth assumption baked in.

Finally the position feeds מיפוי automatically, so the RSU holding is never maintained in
two places and cannot drift the way the sheet's hardcoded 3.602 FX drifted from מיפוי's
live rate.

### Acceptance criteria

- [ ] Given a target amount and date, a set of lots is selected that reaches at least the
      target
- [ ] No cheaper valid selection exists, verified by exhaustive search on small cases
- [ ] Lots not yet vested at the target date are excluded from selection
- [ ] The selection strategy is isolated from the tax calculation
- [ ] A forward vest schedule displays upcoming vests with projected value at today's price
- [ ] Forecast prices are flat at the current price with no growth assumption
- [ ] The RSU account's value in מיפוי is derived from the position, not entered separately
- [ ] The RSU figure in מיפוי uses the snapshot's FX rate, not a hardcoded one

---

## Phase 15: לוח תכנון — a scenario with a funding gap

**User stories**: 73, 74, 75, 76, 82

### What to build

A named what-if — "CGM 3 in 2027" — that can be thought about without disturbing anything
recorded. A scenario defines what a future investment needs and where the money would come
from: this is a Funding Plan, the same shape as a Project's Funding Legs but in the future
tense.

From that, two answers: the funding gap, and how many months of saving close it at the
household's current rate — so "when can we afford this" stops being a feeling. A scenario
starts from current real numbers, so planning never begins from stale figures.

`Scenarios` reads recorded data and writes none of it.

### Acceptance criteria

- [ ] A scenario can be created with a name and no effect on any recorded data
- [ ] A funding plan records what a future investment needs and which sources would cover it
- [ ] The funding gap is computed and displayed
- [ ] Months-to-close-the-gap is computed from the current savings rate
- [ ] A new scenario is seeded from current real figures, not from stale or typed-in ones
- [ ] No scenario operation modifies a ledger entry, snapshot, account or project

---

## Phase 16: לוח תכנון — allocations, comparison, projections and execution

**User stories**: 77, 78, 79, 80, 81, 83

### What to build

Monthly saving allocations across goals — 5,000 to the emergency fund and 10,000 to real
estate — played out over time. Two scenarios side by side, so "Meteor or another CGM" is a
comparison rather than a feeling. A repeating pattern projected forward — a CGM project
every year for ten years — so a strategy can be followed to where it leads.

Projections draw on recorded Deal Terms by default and can be overridden per scenario, so
a sponsor's promise can be stress-tested rather than assumed. One scenario can be marked as
the plan actually being followed, and the dashboard measures against its targets.

Executing a Funding Plan is what turns its lines into a Project's Funding Legs at real
rates — the transition from planning to record is not re-typing.

### Acceptance criteria

- [ ] Monthly saving allocations can be set across multiple goals and projected over time
- [ ] Two scenarios can be compared side by side
- [ ] A repeating investment pattern can be projected over multiple years
- [ ] Projections default to the project's recorded Deal Terms
- [ ] Deal Terms can be overridden inside a scenario without changing the recorded terms
- [ ] Exactly one scenario can be marked as the active plan, and the dashboard measures
      against its targets
- [ ] Executing a funding plan creates the project's funding legs at real rates
- [ ] Execution is the only scenario operation that writes recorded data, and it is
      explicit

---

## Phase 17: סיכום שנתי — the annual review

**User stories**: 84, 85, 86, 87, 88

### What to build

One page that answers "where did 2025 end" across every feature — the מאזן bottom line, the
closing snapshot, project positions, the RSU position — rather than five pages.

Per ADR 0002 the review freezes **only what cannot be recomputed**: the closing FX rate,
share prices, and the valuations placed on real-estate projects, because nothing can
reconstruct those afterwards. Ledger figures stay live and are recomputed from the Ledger
on every read, so correcting an old typo flows through rather than leaving a known-wrong
number frozen on screen. The review must show those figures *as live*, so the difference
between two prints is never mistaken for data loss.

Reviews can be compared, making year-over-year progress visible at the top level.

### Acceptance criteria

- [ ] An annual review can be created for a year and covers מאזן, snapshot, projects and
      RSU on one page
- [ ] Closing FX rate, share prices and project valuations are frozen on the review
- [ ] הכנסות, הוצאות and חיסכון are recomputed live from the Ledger on every read
- [ ] Correcting a ledger entry from a reviewed year changes that review's מאזן figures
- [ ] Live figures are labelled as live, distinguishably from frozen ones
- [ ] Two annual reviews can be compared side by side
