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

   **Resolved for now, 2026-08-11 — still to be confirmed.** The household chose the סעיף
   102 reading as the starting value, and it is a `/settings` dial as planned, so confirming
   it against an ESOP statement costs a form submission. Two consequences worth carrying
   forward: an estimate already taken keeps the window it was taken under and is flagged
   when the setting moves, so changing this never rewrites a figure behind the reader; and
   Phase 13's *"reproduces the existing spreadsheet rows exactly"* criterion is written
   against the sheet's window, so that phase must set the window to the sheet's rule to
   reproduce the sheet, and say which window each figure used.

2. **Qualified/Unqualified share counts.** `RSU_Grants!M50` in the live sheet holds the
   formula behind the $68,619 / $48,879 split. The markdown export lost cell references and
   the two blocks appear priced differently (219 shares at 313.33 vs 214 at roughly 228).
   Read from the live sheet before RsuPosition is built.

   **Still open.** Phase 12 was built past it by decision, with the gap recorded rather than
   papered over: `RsuPosition` derives the split from recorded lots and is verified on
   fixtures and live, but nothing has been reconciled against the household's own two
   figures, because no real grant is recorded anywhere in the repository and `M50` is still
   unread. Reading it is what turns the mechanism into the household's actual position.

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

- [x] The app is deployed to Vercel and reachable at a stable URL, on free tiers only
      <!-- https://jubot-dashboard.vercel.app — Vercel Hobby, Neon free tier in eu-central-1,
           pooled connection. Deployed 2026-08-15. The five environment variables were first
           created with empty values during the project import, which surfaced as
           `MissingSecret` on every /api/auth route and as a name collision that stopped the
           Neon integration attaching; both are described in README "Deploying". -->
- [x] An address not on the two-account allow-list is refused, and no route renders data
      for it
- [x] Both household accounts can sign in with Google and reach the dashboard
      <!-- Verified 2026-08-15 by both people signing in against the deployed instance. The
           OAuth client is in Testing mode with the two addresses as test users, so the
           unverified-app interstitial is expected. `JUBOT_ALLOWED_EMAILS` and the two
           `people.email` rows were set to the same pair — the allow-list decides who may
           sign in, the rows decide which of the two they are. -->
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
- [x] ~~Current-year averages divide by elapsed months; complete years divide by twelve~~
      **Superseded by [maazan-redesign](maazan-redesign.md) Phase 18.** The rule is now the
      year's *closed* calendar months — those strictly before the current one — intersected
      with the ledger's recorded span. So the month in progress feeds no aggregate, and 2024
      divides by six rather than by twelve months of which six never existed.
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

- [x] The change between two snapshots is decomposed into money added, market movement and
      currency movement
      <!-- Two snapshots record positions and not flows, and the household records no
           transfers, so the split between market movement and money added cannot be
           measured. It is declared: `/settings` names the accounts that move on their own
           and everything else that moved reads as money added. A cost-held account is
           refused the mark (ADR 0003), and an account that opened or closed inside the
           period is money arriving or leaving whatever it is marked as. -->
- [x] The decomposition sums exactly to the total change with no residual when inputs are
      consistent
      <!-- Exact by construction rather than by rounding luck: each account is read three
           times — opening at the opening rate, opening at the closing rate, closing at the
           closing rate — and the components are the consecutive differences. Verified at
           3.6547 against balances chosen to round badly, per row and in total. -->
- [x] The reconciliation compares money added against the מאזן's חיסכון for the same period
      <!-- חיסכון is read through the Ledger, so it is the same figure the מאזן screens show.
           The period is the whole calendar months between the two readings; a month the
           period only clips is named and left out, and a period holding no whole month says
           so rather than comparing against half a month nobody recorded. -->
- [x] When the two disagree, the residual is displayed as a flagged discrepancy, not
      silently absorbed
      <!-- Verified live: 50,600₪ arrived against 21,000₪ of חיסכון and the screen reported
           a 29,600₪ gap; marking the pension as moving with the market moved 5,000₪ out of
           money added and the gap read −5,000₪. Months that are only half recorded are
           named beside it, because an unfinished month looks exactly like a leak. -->
- [x] The discrepancy is surfaced where it will be seen, not only on a detail screen
      <!-- The dashboard carries it, against the nearest earlier reading the מאזן can answer
           for — so a weekly cadence does not switch the check off — and it names the period
           it used. It says as plainly when the two agree: a check only visible when it fails
           teaches nobody that it is running. -->
- [x] `NetWorthAnalytics` decomposition and reconciliation are tested on plain data with
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

- [x] A project records its funding legs, each with source, amount, currency and the rate
      used
      <!-- The rate is recorded where a conversion happened and refused where none did: a
           leg already in the pot's currency converted nothing, and a rate beside it would
           be a number nobody used. The database holds the same rule as a trigger. -->
- [ ] The effective blended rate is computed on read and matches hand-computed values for
      the real CGM 1, CGM 2 and Meteor structures
      <!-- CGM 1 and CGM 2 verified live against their real funding amounts: 109,800₪ +
           $69,000 reads $99,082.19 at 3.6500, and 295,200₪ at 3.60 reads $82,000. But the
           repository records amounts, never the rates they were paid at, and Meteor's
           funding structure appears nowhere at all — only that the sheet valued it twice
           and disagreed. The arithmetic is verified; the real figures need the household's
           own rates and Meteor's legs. Surfaced rather than checked off on a fixture. -->
- [x] The blended rate is displayed against today's rate
      <!-- The screen says only where the two numbers sit. Which is the good one depends on
           which way the money went — dollars bought with shekels want a low rate, dollars
           sold for shekels want a high one — so the direction is stated and the domain
           answers "above" or "below" and nothing else. A difference smaller than the four
           decimals shown reads as the same rate. -->
- [x] A project has a running expense ledger showing what was spent and on what
- [x] `יתרה = Σ(legs) − Σ(expenses)` holds after any sequence of legs and expenses
      <!-- Computed on every read with nowhere to write it, so there is no state to leave
           inconsistent. Asserted after every step of a 24-step interleaving, and the pot
           reads identically whatever order the rows arrive in. -->
- [x] An expense that would exceed the pot is refused; adding money requires a new funding
      leg
      <!-- Verified live: against $21,188.00 of room, $21,188.00 was accepted and
           $21,188.01 refused with the agora named. Removing a leg the pot has already
           spent against is refused too — it is the same broken state from the other side,
           and CGM 1 reported the $8,894.19 that would go missing. -->
- [x] Undeployed capital is displayed per project
      <!-- Verified live: CGM 1 reads $21,188.00 not yet working, the figure the PRD names,
           on both the list and the project. -->
- [x] Deal Terms are recorded per project as data, entered by hand
      <!-- Entered as a percentage, stored in whole basis points: 18.25% round-trips as
           1,825. Nothing derives from them and nothing else reads them yet; a row of nulls
           reports as no promise rather than as a promise of nothing. -->
- [x] A project's snapshot value remains at total cost as its expense ledger is spent down
      <!-- Verified live: CGM 1 reads $99,082.19 in מיפוי with $77,894.19 already deployed.
           Naming the account that carries the project lets the screen state what that
           account should read and report the difference when it does not — it never writes
           into the snapshot, because the value there is a figure a person states. -->

---

## Phase 12: RSU — position, lots and the 24-month clock

**User stories**: 58, 59, 60, 61, 62, 63, 70, 71

> **Was blocked** on the GP window and the `RSU_Grants!M50` share counts — see *Blocking
> open items* above. The window is settled as a starting value and remains a setting; the
> share counts are still unread, and what that leaves unverified is recorded on the
> criterion it belongs to rather than checked off.

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

- [x] Grants are recorded with ID, date and total shares
      <!-- The document's own ID, kept as written and in English. The grant's total is held
           against the sum of its vests: shares vesting out of a grant that never awarded
           them are refused, because the two figures come off the same document. -->
- [x] Vests are recorded with date, shares and price at vest
      <!-- A price per share is not a Money — GP 149.4219 is a real figure and cents cannot
           hold it — so prices are exact integer ten-thousandths and become money only when
           multiplied by shares, rounded once at the end. -->
- [x] Future vests can be recorded and are excluded from the current position
      <!-- Verified live: a vest dated 2027-11-11 read as 60 shares "רשומות, ואינן נספרות",
           with the held count unmoved at 100. Nothing marks it as future; the position
           compares its date to the day it is read on. -->
- [x] A sale is recorded against a specific lot and reduces that lot
      <!-- Verified live: 45 shares sold out of a 100-share lot left it at 55 with the other
           lot untouched, and a 56th share was refused with "במנה יש 55 מניות, והמכירה
           מבקשת 56". A sale dated ahead of the reading date is not counted yet. -->
- [x] Lot qualification is derived from grant date + 24 months, with no stored flag
      <!-- There is no column to store one. The clock runs from the *grant* date, so a lot
           that vested in November 2024 under an August 2024 grant qualifies in August
           2026 — verified live. -->
- [x] The 24-month boundary is correct on the day before, the day of, and the day after
      <!-- Verified live on one lot with nothing written between the three reads: on
           2026-08-10 it read 0 qualified / 100 unqualified, on 2026-08-11 100 / 0, and on
           2026-08-12 100 / 0. Counted in months rather than days, so a leap year cannot
           move it and 29 February clamps to the 28th. -->
- [x] The position displays Qualified and Unqualified share counts
      <!-- Verified live at 55 Qualified against 80 Unqualified across two grants. The
           counts are of what is *held* — a lot sold down to nothing stays in the record and
           out of the totals. Not reconciled against the household's own $68,619 / $48,879
           split: `RSU_Grants!M50` is still unread and no real grant is recorded anywhere in
           the repository. That is the open item, and it is unchanged. -->
- [x] The GP estimation window is a setting changeable without a code change
      <!-- Both candidate rules are one shape with different numbers in it, and the grant
           day is its own field rather than an off-by-one inside a count. Verified live:
           switching from 30 trading days preceding to the sheet's 15 calendar days either
           side moved the same twelve pasted closes from $104.5000 over 10 to $170.5000 over
           12. Starts at the סעיף 102 reading by the household's decision; whether that is
           the right one is the open item this setting exists for. -->
- [x] Estimated GP figures are visibly flagged as estimates
      <!-- One component renders every GP, so there is no second path that could forget. An
           estimate reads "אומדן" with the sample size and the window behind it; a price
           read off a document reads "מהמסמך" and carries no window, because none produced
           it. An estimate taken under a window since changed says so and is not silently
           rewritten — verified live. -->

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
      <!-- It does not, and the gap is reconstructible to the cent rather than being
           rounding. Verified live on that exact row: $2,839.02 of ordinary income at
           62.17% and a $2,480.98 gain at 25% give tax $2,385.27 and net $2,934.73. The
           sheet's two figures leave 5,320.00 − 2,385.14 − 2,934.67 = $0.19 unaccounted —
           a cent a share of selling cost — and taking that $0.19 off the *ordinary-income
           base* before the 62.17% yields 2,385.1442 and then 2,934.67, both to the cent.
           Nothing else fits both at 62.17% and 25%. So the sheet taxed the sale net of its
           selling cost, which is exactly what the sixth criterion below forbids: the two
           cannot both hold on a row carrying a fee. The remaining agora is that each
           component here is a real amount rounded to the cent once, where the sheet
           carried unrounded floats into one total. Surfaced rather than reinterpreted —
           whether the household wants the sheet's arithmetic or the correct one is its
           decision, not an implementation detail. -->
- [x] The Unqualified path taxes the entire gain as ordinary income
      <!-- Verified live on the same row read four months before its boundary: the whole
           $5,320.00 is ordinary income, the gain is nought and the tax is $3,307.44. An
           RSU costs nothing to acquire, so the entire sale is the benefit. It does not
           consult GP at all — a lot under an estimated GP is not an estimate when sold
           early, and does not read as one. -->
- [x] Treatment is selected per lot from its own qualification date, automatically
      <!-- From the grant date and the *sale* date, never from the lot's own `qualified`,
           which is a fact about the day the position was read. Verified live: one lot,
           nothing written between the two reads, priced as an early sale on 2025-06-01 and
           as a Qualified one on 2026-08-11. Tested on the day before, the day of and the
           day after its boundary, and across two grants inside one sale. -->
- [x] Selling a given number of shares today reports net proceeds in both USD and ILS
      <!-- Verified live: 19 shares at $280 read as $2,934.73 and ₪10,711.76, with the rate
           and its date named beside the figure. Where no rate is stored the net stays in
           dollars and the screen says why rather than converting at one nobody quoted. A
           request larger than the position fills what exists and reports the shortfall. -->
- [x] Any lot can be shown as net-today versus net-once-Qualified, with the difference
      stated
      <!-- Verified live: $2,012.56 today against $2,934.73 from 15 January 2026, a
           difference of $922.17. The price is held flat between the two readings on
           purpose, so the difference is what the clock is worth and not a guess about the
           share price; the fees are charged on both sides for the same reason. A lot with
           nothing to wait for says so and reads as no difference rather than as ₪0. -->
- [x] Fees are settings, not constants, and are subtracted from net proceeds and not from
      the taxable base
      <!-- Verified live: $0.01 a share, $15.00 flat and 0.5% to the trustee came to $41.79
           and took the net from $2,934.73 to $2,892.94, with the tax unmoved at $2,385.27.
           Charged once over a sale rather than per lot — a flat commission on one sale is
           one commission however many lots it drew on — and a fee quoted in a currency the
           sale is not in throws rather than converting at a rate nobody named. -->
- [ ] `RsuTax` tests assert exact figures against the household's existing sheet rows
      <!-- The tests assert exact minor-unit integers on that row's own inputs, and the
           sheet row is the fixture. But they assert what this module produces, because it
           does not produce what the sheet states — see the first criterion. Left unchecked
           with the first one rather than checked on a weaker reading of it. -->

Two things were built that no criterion names, and both are recorded here rather than added
as criteria: the **two tax rates are `/settings` dials** in whole basis points, because
62.17% and 25% are the household's reading of סעיף 102 and not a fact of the world, and
every figure on screen names the two that produced it; and a **Qualified sale out of a grant
with no GP is refused** rather than approximated, because without a GP there is no split
between work income and gain and any number shown would rest on nothing.

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

- [x] Given a target amount and date, a set of lots is selected that reaches at least the
      target
      <!-- The target is measured on the **net**, not the gross: selling to the target in
           gross would leave the household short by exactly the tax, which is the thing the
           question is for. Verified live: against $5,000 the selector took 33 shares out of
           the Qualified lot for $5,097.18 net, and 32 would have brought $4,942.72. A target
           larger than the position fills what exists and states the shortfall rather than
           refusing to answer. -->
- [x] No cheaper valid selection exists, verified by exhaustive search on small cases
      <!-- The tests enumerate every way of splitting a sale across the candidate lots — not
           just every subset — and assert that nothing reaching the target costs less tax
           than what was returned. Held across two clocks, four lots, a price below GP, fees
           charged over the sale, and a sweep of twenty targets. The answer is exact rather
           than greedy on purpose: rounding at the cent makes a lot's per-share tax not
           quite constant, so sorting by a per-share rate is right almost always, and
           "almost always" is not something a household can check. -->
- [x] Lots not yet vested at the target date are excluded from selection
      <!-- And named, with the reason, beside the answer: "we are short until November" is
           the useful reply. Verified live — the 60 shares vesting 2026-11-11 are excluded
           for money needed in August and are candidates for money needed in December, where
           the position reads 240 held rather than 180. A lot that would be a Qualified sale
           out of a grant with no GP is excluded the same way rather than blocking the whole
           question, which is what Phase 13's refusal would otherwise do here. -->
- [x] The selection strategy is isolated from the tax calculation
      <!-- `RsuTax` was given one entry point, `sellShares`, which takes an allocation —
           which lots, how many out of each — and never learns how it was arrived at.
           Oldest-first is now one strategy over that seam (`allocateInOrder`) and
           `LotSelector` is another. Tested by pricing the selector's allocation again from
           outside and getting the identical figures, and by pricing an allocation no
           drawing order could produce. -->
- [x] A forward vest schedule displays upcoming vests with projected value at today's price
      <!-- Verified live: 60 shares vesting 2026-11-11 read as $16,800.00 at $280.0000, with
           a running cumulative beside them and each row's own qualification date. -->
- [x] Forecast prices are flat at the current price with no growth assumption
      <!-- One price for every row, and there is no parameter that could make it otherwise.
           Verified live: the vest's own recorded price of $250.0000 is not what values it —
           the schedule uses the one price handed in, because what it answers is what is
           already promised, not what a share will be worth. -->
- [x] The RSU account's value in מיפוי is derived from the position, not entered separately
      <!-- The restatement form has no amount box for that account at all. Its share count is
           `remainingShares` read as of the snapshot's own date; the only thing anybody
           states is the price, which the snapshot stores the way it stores its exchange
           rate. Verified live: 180 × $300.0000 = $54,000.00; recording a 45-share sale left
           the snapshot reading $54,000.00 and the screen reported the $13,500.00 gap rather
           than rewriting it behind the reader, and saving the form re-derived it to
           $40,500.00. A snapshot taken before a sale keeps the shares that were held then. -->
- [x] The RSU figure in מיפוי uses the snapshot's FX rate, not a hardcoded one
      <!-- Verified live on two snapshots holding the same 135 shares at the same $300.0000:
           ₪147,825.00 at the August 12 reading's 3.65 and ₪129,600.00 at the August 20
           reading's 3.20, each after the other was written. The conversion path is
           `convertWithin`, which cannot reach today's rate; a snapshot carrying no rate for
           the pair yields no figure rather than one converted at a rate nobody quoted. -->

The share price is stored on the snapshot rather than looked up, for the same reason its
exchange rate is: a reading must keep reading as it did on the day. The account that carries
the position is a `/settings` dial named by id, so renaming it cannot quietly detach the
derivation — and naming none is a position too, under which nothing is derived at all.

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

- [x] A scenario can be created with a name and no effect on any recorded data
      <!-- A name is all it takes, and a scenario with no plan stays a legitimate state — a
           name and a thought — rather than reading as something half-finished. Verified
           live, and the "no effect" half is the last criterion below. -->
- [x] A funding plan records what a future investment needs and which sources would cover it
      <!-- The requirement is one figure with a date, corrected in place; the sources are
           rows. A planned source deliberately carries **no rate and no date**: a future
           conversion has no rate yet, and one written down before the money moved would be
           a number nobody used. Reading a shekel source into a dollar plan therefore needs
           a rate handed in from outside, which is named and dated on screen — and a source
           no stored rate can read is listed beside the gap rather than converted, so the
           covered figure is the *most* that is covered. -->
- [x] The funding gap is computed and displayed
      <!-- Verified live: $100,000 against 180,000₪ of free liquid money read $49,315.07
           covered at 3.6500 and a $50,684.93 gap; adding a stated $45,000.50 source took it
           to $5,684.43, and needing $90,000 against the same sources read as $4,315.57
           *over* rather than as a negative requirement. Computed on every read with nowhere
           to store it. -->
- [x] Months-to-close-the-gap is computed from the current savings rate
      <!-- Verified live: 15,000₪ a month, read through the Ledger over the six months the
           מאזן holds (פברואר–יולי 2026, denominator stated), converted to $4,109.59 and
           divided into the gap — 13 months on $50,684.93, 10 on $40,684.93, 15 on
           $61,643.84. Rounded **up**: saving arrives in monthly lumps and a part-month
           closes nothing. Where there is no answer the screen says which of four things is
           true — nothing recorded, a pace of nought or less, no rate between two
           currencies, or a plan already covered — rather than printing a number. -->
- [x] A new scenario is seeded from current real figures, not from stale or typed-in ones
      <!-- Free liquid money out of the latest מיפוי, written in as a `seeded` source stamped
           with that reading's date. Verified live twice against the same reading restated:
           the first scenario seeded 180,000₪ and the second, after the liquid account was
           restated, seeded 140,000₪ — so the seed is read at creation and never copied from
           an older scenario. The seeded line is *not* rewritten behind the reader when the
           figure moves: it states the drift (−40,000₪) and leaves the decision to a person.
           A shortfall seeds nothing, because a promise with nothing behind it is not money
           to invest. -->
- [x] No scenario operation modifies a ledger entry, snapshot, account or project
      <!-- Verified two ways. Empirically: every recorded table was fingerprinted (row count
           and an order-independent hash), a scenario was then created, seeded, given a plan,
           given and stripped of a source, renamed and removed through the screens, and every
           fingerprint came back byte-identical. Structurally:
           `src/domain/planning/writes-nothing-recorded.test.ts` reads the area off disk and
           fails on a write statement against any recorded table or on an imported writer
           from another area — a write reached through somebody else's function reaches the
           same table. Removing a scenario cascades to its plan and its sources and nothing
           else is reachable from there. -->

The plan header sketched two tables; there are three. The requirement and the sources have
different lifetimes — a scenario may need $100,000 before anybody has said where a shekel of
it comes from — so `funding_plans` holds the requirement, one row per scenario, and
`funding_plan_sources` holds the lines. `FundingPlan` in the domain is still the whole thing
CONTEXT.md describes; it is assembled on read.

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

- [x] Monthly saving allocations can be set across multiple goals and projected over time
      <!-- Verified live on the PRD's own example: 5,000₪ to קרן חירום and 10,000₪ to
           נדל"ן read 90,000₪ after six months and 450,000₪ after thirty. Every goal
           accumulates from nought, because these are contributions and the balance a
           goal already holds is an Earmark somebody measured in מיפוי — mixing the two
           would put a plan and a measurement in one figure. Deliberately not damped by
           the pace: promising 15,000₪ out of a 12,000₪ month is reported as 3,000₪
           over-committed and the promise is still played out as written, because a
           quietly reduced number hides which of the two is wrong. -->
- [x] Two scenarios can be compared side by side
      <!-- Verified live: CGM 3 at $100,000 against Meteor 7 at $60,000 read a −$40,000
           difference on the requirement, −$40,000 on the gap and −9 on the months. Every
           figure is one each scenario already shows on its own page, read through the
           same functions, so a scenario cannot say one thing alone and another beside its
           rival. A difference is stated only where the two are the same question — a
           dollar plan against a shekel one has none — and the column says which is
           smaller, never which is better. -->
- [x] A repeating investment pattern can be projected over multiple years
      <!-- Verified live on "a CGM every year for ten years": $100,000 × 10 from January
           2027, played out to January 2039. The first is missed with $36,986.30 short and
           the eighth is where the money runs out; a missed occurrence is *not* slid
           forward, because a delay invents a schedule nobody chose. What comes back pays
           for what comes next — the fifth reads $178,524.02 available because the second's
           $118,250 landed that January. -->
- [x] Projections default to the project's recorded Deal Terms
      <!-- Verified live: the pattern named CGM 1 and read 18.25% over 36 months straight
           off the recorded row. One reading had to be chosen and is stated on screen
           rather than buried: the percentage is taken as the **total return over the hold
           period**, not per year, because it sits beside a hold period on a document that
           says nothing about compounding. A project with no terms, or a row of nulls,
           returns nothing and says so — a promise of nothing is not a promise. -->
- [x] Deal Terms can be overridden inside a scenario without changing the recorded terms
      <!-- Verified live both ways: overriding the return to 8% moved every distribution
           from $118,250 to $108,000 and the ending cash from $800,794.66 to $718,794.66,
           while `deal_terms` still read 1,825bp and 36 months in the database. A null
           field is not an override but an absence of opinion, so the hold period stayed
           the document's; the screen names the recorded figure beside the overridden one,
           so a stress test never hides what was actually promised. -->
- [x] Exactly one scenario can be marked as the active plan, and the dashboard measures
      against its targets
      <!-- Verified live: marking a second scenario released the first, and a direct
           `update` marking two was refused by `scenarios_one_active_plan`. Marking none is
           a legitimate state and reads as silence rather than as an empty panel. The
           dashboard states the gap, whether saving closes it before the date the plan
           needs it (October 2027 against 30 June 2027 — late), and what the plan allocates
           against what the מאזן says is saved. -->
- [x] Executing a funding plan creates the project's funding legs at real rates
      <!-- Verified live end to end: 140,000₪ of planned source became a funding leg paid
           2027-01-15 at 3.650000, and CGM 1's pot read $38,356.16 with an effective rate
           of 3.6500 — the project screen renders it exactly as it renders a leg typed into
           it, because it is written through the same `insertFundingLeg`. The household's
           own name for the source travels onto the leg, which is the whole point: the
           transition from plan to record is not re-typing. Sources falling short of the
           requirement are executed and the difference stated; a conversion with no rate is
           refused whole, and the refusal names the line. -->
- [x] Execution is the only scenario operation that writes recorded data, and it is
      explicit
      <!-- Explicit in three ways. It asks twice: the household names the project, the day
           and the rate, reads back exactly which legs that produces, and confirms — and
           the action rebuilds that preview from stored data rather than trusting the form.
           It happens once: the scenario is the execution row's primary key, and the
           reference to `scenarios` deliberately does not cascade, so an executed scenario
           cannot be edited or deleted — verified live, where adding a source afterwards was
           refused. And it is findable: `writes-nothing-recorded.test.ts` now reads the whole
           area off disk and asserts that no file writes a recorded table in SQL, that
           exactly two files reach a writer at all — `plan-execution.ts` for the leg writer
           and `actions.ts` for its single entry point — and that every other file in לוח
           תכנון reaches neither. -->

The plan header sketched three planning tables; there are six. Allocations, the pattern and
the overridden terms are three lifetimes rather than one — a scenario may have a pattern
before it has a requirement, and an override outlives whichever projection asked for it —
and `funding_plan_executions` is the record that the exception ran, kept apart from the plan
it executed so that deleting a thought and deleting a fact cannot be the same statement.

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

- [x] An annual review can be created for a year and covers מאזן, snapshot, projects and
      RSU on one page
      <!-- Verified live on 2025: 480,000₪ / 300,000₪ / 180,000₪ from the מאזן, a closing
           מיפוי of 736,695.88₪ at that reading's own 3.60, CGM 1 at $99,082.19 with
           $21,188.00 left and Meteor at 200,000₪, and 180 shares held. Each area is read
           through the function its own screens read through, so the page cannot state a
           figure its area disagrees with. -->
- [x] Closing FX rate, share prices and project valuations are frozen on the review
      <!-- The three are columns; there is no column for a ledger figure, a net-worth total
           or a share count. They are seeded from the last reading taken by 31 December —
           2025 opened at 3.6000 and $250.0000 off that מיפוי — and stay editable: moving
           the price to $280.0000 moved the holding to $50,400.00 and ₪181,440.00. A fact
           nobody stated reads as missing and is named: the 2024 review has no closing price
           and says so rather than valuing 100 shares at nothing. -->
- [x] הכנסות, הוצאות and חיסכון are recomputed live from the Ledger on every read
      <!-- Through the same `categoryBreakdown` the insights screens use, with the year's
           denominator and recorded months beside them — a year recorded in part is never
           shown as a cheap one. -->
- [x] Correcting a ledger entry from a reviewed year changes that review's מאזן figures
      <!-- Verified live end to end: יוני 2025's בריאות corrected from 15,000₪ to 5,000₪ on
           the מאזן screen moved the 2025 review from 300,000₪ / 180,000₪ to 290,000₪ /
           190,000₪, on the review and on the list, while every frozen figure — the
           $280.0000 price, the $120,000 valuation, the 432,000₪ total — was unmoved. -->
- [x] Live figures are labelled as live, distinguishably from frozen ones
      <!-- Structurally rather than by discipline: the domain returns `Stated<Money>` and
           never a bare Money, and the screens render every amount through a component that
           takes only that. There are three bases and not two, because a mixture is neither:
           the RSU holding is a live share count at a frozen price and reads "חי, לפי עובדה
           שהוקפאה" rather than borrowing one of the other two labels. -->
- [x] Two annual reviews can be compared side by side
      <!-- Verified live: 2024 against 2025 read +36,000₪ income, +28,000₪ חיסכון,
           +146,204.11₪ net worth and +80 shares. The earlier year is always the left-hand
           side whichever way round they were picked, so the difference means progress; each
           row carries its basis; a row only one year can answer says so rather than
           subtracting against a blank. Two things the comparison states rather than hides:
           each year's recorded months, so a part year is never set silently against a full
           one, and the two frozen rates where they differ — 3.5500 against 3.6000 made the
           identical funding legs read 4,954.11₪ apart, which is the rate moving and not
           money moving. -->

Removing a review takes its own row and its valuations and nothing else: verified by
fingerprinting every recorded table before and after, where entries, snapshots, snapshot
lines, accounts, projects, funding legs and vests all came back identical.
