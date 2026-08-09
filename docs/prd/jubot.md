# PRD: Jubot — Household Financial Dashboard

Feature: `jubot`

## Problem Statement

Yuval and Eden keep separate bank accounts and credit cards but run their money as one unit.
Everything they know about their finances lives in a Google Sheet with eleven tabs: monthly
income and expenses per person and combined, a net-worth מיפוי, an investment allocation
whiteboard, per-project real-estate records, and an RSU vesting and tax calculator.

The sheet works, and it has kept four years of history. But it has run out of room in
specific ways:

- **The household view drifts from its parts.** Personal totals and the combined total are
  maintained by hand, so a category can be counted at one level and silently dropped at
  another. Whether a row is included is expressed by where a SUM range happens to stop —
  not by anything anyone can see or review.
- **The same fact appears in several places and disagrees with itself.** מיפוי is duplicated
  into a שקל table and a דולר table with hand-copied numbers; Eden's pension reads 519,088
  in one and 450,376 in the other. Meteor is worth 244,607 in one table and 224,989 in
  another on the same day.
- **Nothing checks anything else.** A month's חיסכון and the change in net worth are
  computed in different places from different data and never compared, so an error can sit
  for years without surfacing.
- **The RSU calculator models only one of the two tax outcomes.** It splits grant-price as
  ordinary income and appreciation as capital gains — correct once סעיף 102's 24-month clock
  has run. It cannot express selling early, when the whole gain is taxed as ordinary income
  at 62.17%. That gap covers $68,619 of the current position, and it is exactly the number
  that would change a decision about when to sell.
- **Planning and reality are the same table.** The allocation whiteboard is where new
  investments are planned *and* where completed funding is recorded, so there is no way to
  hold two competing ideas side by side, and no way to ask "what if we did this every year
  for ten years".
- **It is a spreadsheet.** No graphs worth reading, no insights, no history beyond more tabs,
  and it is unpleasant on any screen smaller than a laptop.

## Solution

A private, hosted web dashboard in Hebrew, used by exactly two people, that holds every
financial fact once and derives everything else.

Six areas, each with its own history and insights:

1. **מאזן הכנסות-הוצאות** — monthly income and expenses. Each person keeps their own
   category names; household categories are defined as sums of personal ones, so the
   household view can never disagree with its parts.
2. **מיפוי** — a complete, dated restatement of every account, answering *where is our money
   and how much of it*.
3. **שווי נטו** — the derived view: net worth over time, currency exposure, allocation
   against targets, and a decomposition of every change into money added, market movement,
   and currency movement.
4. **נכסים ופרוייקטים** — each project as a closed pot of capital, with its funding legs,
   its expense ledger, and what remains undeployed.
5. **מחשבון RSU** — the full position with each lot's own סעיף 102 clock, correct tax under
   both treatments, what waiting is worth, which lots to sell to raise a given amount most
   cheaply, and a forward vest schedule.
6. **לוח תכנון** — named scenarios for future investments, showing the funding gap and how
   long saving takes to close it.

The system's organising principle: **every fact is recorded once, in one place, and
everything else is computed.** Where two things can be cross-checked — a month's חיסכון
against the change in net worth — the system checks them.

## User Stories

### מאזן הכנסות-הוצאות

1. As a household member, I want to enter my monthly amount for each of my own categories, so that recording a month takes a few minutes and not an evening.
2. As a household member, I want my own category names, so that Yuval's `בריאות` and Eden's `רפואה` can coexist without either of us having to adopt the other's vocabulary.
3. As a household member, I want to create a new personal category at the moment I need it, so that entry is never blocked by taxonomy admin.
4. As a household member, I want a new personal category to immediately appear at the household level, so that no money I record can silently vanish from the household total.
5. As a household member, I want to merge two personal categories into one household category, so that `בריאות` and `רפואה` read as one line for the household.
6. As a household member, I want to rename a household category independently of the personal ones feeding it, so that the household vocabulary can be clearer than either of ours.
7. As a household member, I want each category marked as הכנסה or הוצאה once when I create it, so that I never have to think about direction again.
8. As a household member, I want חיסכון computed as הכנסות − הוצאות, so that it is never a number someone typed and later forgot to update.
9. As a household member, I want to see how much we saved this month, so that I know how much is available to move into projects.
10. As a household member, I want to retire a category without deleting its history, so that `ClubRRRR` stops cluttering 2026 while 2024 still reads correctly.
11. As a household member, I want to see a month's figures for myself, for Eden, or for the household, so that I can read the same month at whichever level the question needs.
12. As a household member, I want to drill from a household category into the personal categories that feed it, so that a surprising household number can be traced to its source.
13. As a household member, I want to correct a figure from any past month, so that discovering an old typo does not mean living with it.
14. As a household member, I want a monthly trend of הכנסות, הוצאות and חיסכון with the previous year alongside, so that I can see direction rather than a single month in isolation.
15. As a household member, I want each category's current month compared against its own trailing average with the largest deviations first, so that the screen tells me what is unusual instead of making me scan twenty numbers.
16. As a household member, I want averages calculated over elapsed months in the current year, so that a partial year is comparable to a full one.
17. As a household member, I want to see the denominator used for any average, so that I never have to guess whether it divided by 6 or 12.
18. As a household member, I want a household and per-person category breakdown for a month or a year, so that I can see where the money actually went.
19. As a household member, I want חיסכון as a percentage of income over time, so that I can tell whether we are genuinely improving rather than just earning more.
20. As a household member, I want each category compared against the same period last year, so that I can see whether `חו"ל` is creeping up.
21. As a household member, I want all years in one continuous ledger, so that multi-year trends work without stitching anything together.
22. As a household member, I want my 2022–2026 history imported from the sheet, so that trends and averages are useful on day one rather than a year from now.
23. As a household member, I want to review and correct the category assignments the importer guessed, so that imported history lands in the right household buckets.
24. As a household member, I want to see which months are incomplete, so that a half-entered month is not mistaken for a cheap one.

### מיפוי

25. As a household member, I want to record a complete dated restatement of every account, so that a snapshot is never partial and never ambiguous about when it applies.
26. As a household member, I want to take a snapshot whenever I choose — weekly, monthly, whenever — so that the system does not impose a cadence I will not keep.
27. As a household member, I want each row pre-filled with the previous snapshot's value, so that a restatement means correcting what changed rather than re-typing everything.
28. As a household member, I want the system to record whether each value was entered or carried forward, so that a pension I have not updated in five months does not masquerade as a measured flat line.
29. As a household member, I want each account tagged with its Value Basis — שווי שוק, עלות, or הערכה — so that I know which parts of my net worth are real numbers and which are placeholders.
30. As a household member, I want totals to state how much is held at cost rather than measured, so that the mix is a stated fact rather than a hidden inconsistency.
31. As a household member, I want each account to carry its native currency and balance, so that dollar accounts are dollar accounts and nothing is silently pre-converted.
32. As a household member, I want one exchange rate per snapshot, so that every dollar figure in a given snapshot converts consistently.
33. As a household member, I want the שקל and דולר tables derived automatically from מיפוי, so that they can never drift from it or from each other.
34. As a household member, I want to categorise accounts by קטגוריה and סוג נכס, so that rollups by נזילות, השקעות and פנסיה work the way I already think.
35. As a household member, I want to see the full history of snapshots, so that I can look back at where our money was at any point.
36. As a household member, I want to compare any two snapshots side by side, so that I can see exactly what moved between them.
37. As a household member, I want to record positions inside an investment account, so that I can see what the portfolio is actually invested in.
38. As a household member, I want to record earmarks against money in an account, so that קרן חירום's 120,000 is visibly spoken for.
39. As a household member, I want to see when an earmark is underfunded, so that spending from the emergency fund shows up as a shortfall rather than disappearing.
40. As a household member, I want to see how much of our liquid money is genuinely free after earmarks, so that I know what is actually available.

### שווי נטו

41. As a household member, I want net worth over time from the snapshot history, so that I can see the trajectory rather than today's number alone.
42. As a household member, I want every change between snapshots decomposed into money we added, market movement, and currency movement, so that I can tell an earned month from a lucky one.
43. As a household member, I want the "money added" figure to tie back to חיסכון from the מאזן, so that the two halves of the system check each other.
44. As a household member, I want to be told when that reconciliation does not hold, so that an untracked expense or a forgotten account surfaces in weeks rather than years.
45. As a household member, I want currency exposure computed from what each asset *is*, so that a dollar-denominated stake counts as fully exposed regardless of whether the money that bought it started as shekels.
46. As a household member, I want current allocation shown against my רצוי targets, so that I can see where we are over- and under-weight.
47. As a household member, I want a property-appreciation assumption I control, so that net worth can be read as a range instead of a falsely precise number.
48. As a household member, I want to see what share of our wealth sits in Apple RSU, so that concentration is visible rather than implicit.

### נכסים ופרוייקטים

49. As a household member, I want each project recorded as a closed pot with its funding legs, so that I can see exactly where its money came from.
50. As a household member, I want each funding leg to record the currency and rate actually used, so that the effective blended rate is derived rather than maintained.
51. As a household member, I want a running expense ledger per project, so that I can see what has been spent and on what.
52. As a household member, I want expenses drawn from the project's own pot, so that `יתרה` always equals legs minus expenses.
53. As a household member, I want adding money to a project to create a new funding leg, so that the pot's balance can never go negative or be silently topped up.
54. As a household member, I want to see how much of a project's capital is still undeployed, so that I know CGM 1 has $21,188 not yet working.
55. As a household member, I want a project's effective conversion rate compared against today's rate, so that I can see whether I converted well.
56. As a household member, I want each project's stated deal terms recorded from the sponsor's paperwork, so that projections and comparisons rest on something other than my own guess.
57. As a household member, I want a project's מיפוי value to stay at total cost as its expense ledger is spent down, so that converting cash into property is not mistaken for losing money.

### מחשבון RSU

58. As Eden, I want to record each grant with its ID, date and total shares, so that the position is grounded in real grant documents.
59. As Eden, I want to record each vest with its date, shares and price at vest, so that the position reflects what actually happened.
60. As Eden, I want to record future vests ahead of time, so that the forecast has something to work with.
61. As Eden, I want to record shares sold against a specific lot, so that the remaining position is accurate.
62. As Eden, I want each lot to know whether it has passed סעיף 102's 24-month clock, so that its tax treatment is determined by data rather than by memory.
63. As Eden, I want to see my position split into Qualified and Unqualified shares, so that I know how much of it is exposed to the 62.17% rate.
64. As Eden, I want to know what lands in the bank if I sell a given number of shares today, in both USD and ILS, so that I can plan around a real figure.
65. As Eden, I want the calculation to pick the right treatment per lot automatically, so that an early sale is not quietly priced as though the clock had run.
66. As Eden, I want to see what waiting is worth for any lot — net today versus net once Qualified — so that the timing decision is quantified rather than a vague preference.
67. As Eden, I want to know which lots to sell to raise a target amount by a target date at the lowest tax cost, so that funding a project does not cost more than it needs to.
68. As Eden, I want a forward vest schedule with projected value at today's price, so that I can see what is coming.
69. As Eden, I want broker and trustee fees included, so that the net figure is what actually arrives.
70. As Eden, I want the GP estimation window to be a setting, so that it can be corrected once I check an ESOP statement without anyone touching code.
71. As Eden, I want to see which GP figures were estimated, so that I know which tax numbers carry an approximation.
72. As a household member, I want the RSU position to feed מיפוי automatically, so that it is not maintained in two places.

### לוח תכנון

73. As a household member, I want to create a named scenario, so that I can think about "CGM 3 in 2027" without disturbing anything recorded.
74. As a household member, I want to define what a future investment needs and where the money would come from, so that a plan is concrete rather than a hope.
75. As a household member, I want to see the funding gap for a scenario, so that I know how much is missing.
76. As a household member, I want to see how many months of saving close that gap at our current rate, so that "when can we afford this" has an answer.
77. As a household member, I want to set monthly saving allocations across goals, so that I can see 5,000 to emergency and 10,000 to real estate playing out over time.
78. As a household member, I want to compare two scenarios side by side, so that "Meteor or another CGM" is a comparison rather than a feeling.
79. As a household member, I want to project a repeating pattern — a CGM project every year for ten years — so that I can see where a strategy leads.
80. As a household member, I want scenarios to draw on recorded deal terms by default and let me override them, so that I can stress-test a sponsor's promise.
81. As a household member, I want to mark one scenario as the plan we are actually following, so that the dashboard knows which targets to measure against.
82. As a household member, I want a scenario to start from current real numbers, so that planning never begins from stale figures.
83. As a household member, I want executing a plan to create the project's funding legs, so that the transition from planning to record is not re-typing.

### היסטוריה וסיכום שנתי

84. As a household member, I want a frozen סיכום שנתי per year, so that there is a definitive record of where each year ended.
85. As a household member, I want the review to freeze prices, exchange rates and valuations as of the closing date, so that facts that cannot be recovered later are not lost.
86. As a household member, I want ledger figures on the review to stay live, so that correcting an old typo flows through rather than leaving a known-wrong number on screen.
87. As a household member, I want the review to span every feature, so that "where did 2025 end" is one page and not five.
88. As a household member, I want to compare annual reviews, so that year-over-year progress is visible at the top level.

### Access, language, and shape

89. As a household member, I want to sign in with my Google account, so that there is no password to manage and no email service to pay for.
90. As a household member, I want only Yuval and Eden to be able to reach the dashboard, so that our complete financial picture stays private.
91. As a household member, I want the interface in Hebrew and laid out right-to-left, so that it reads naturally.
92. As a household member, I want terms like RSU, ACWI and IRR left in English, so that they read the way they actually do in Israeli finance.
93. As a household member, I want the dashboard designed for a laptop, so that wide tables and side-by-side scenarios have room to work.
94. As a household member, I want to read dashboards on my phone, so that checking a number away from a desk is possible even if entry is not.
95. As a household member, I want amounts formatted with Hebrew locale conventions, so that numbers and dates look right.
96. As a household member, I want dollar amounts shown in their native currency alongside the shekel figure, so that I do not lose sight of what an account actually holds.

## Implementation Decisions

### Stack

- **Next.js (App Router) + TypeScript**, deployed to **Vercel** (Hobby tier — personal use, free).
- **Postgres** on Neon or Supabase free tier.
- **Auth.js with Google OAuth**, restricted to an allow-list of two accounts. Chosen over
  magic links because it needs no email-sending service and therefore costs nothing.
- **Tailwind + shadcn/ui**, with `dir="rtl"` at the document level.
- Cost target is zero; nothing in the design should require a paid tier for two users.

### Module structure

The domain logic is deliberately framework-free: none of the modules below import Next.js,
React, or the database client. They take plain data and return plain data. Persistence and
rendering sit outside them. This keeps the expensive logic testable without a browser or a
database, and portable if the frontend choice turns out wrong.

- **Money** — a value type pairing an amount with a currency, plus conversion at an explicit
  rate and Hebrew-locale formatting. Every amount in the system is a Money, never a bare
  number. This exists because loose numbers with implicit currencies are the root cause of
  the spreadsheet's valuation inconsistencies.
- **Categories** — Personal Categories, Household Categories, and Category Assignment.
  Enforces that creating a Personal Category always creates or joins a Household Category,
  so nothing is ever unassigned. Handles merging, renaming, and category lifespans
  (active-from / active-until) so a retired category keeps its history.
- **Ledger** — Entries keyed by `(year, month, personalCategoryId)`. Exposes a single
  accessor for "the amount for this category-month" which hides whether the figure was
  entered directly or derived from transactions, per ADR 0001. A category-month is either
  entered or transaction-backed, never both.
- **LedgerAnalytics** — pure functions over entries: monthly trends, averages using elapsed
  months as the denominator for the current year, year-over-year comparison, deviation from
  trailing average, savings rate. Returns the denominator alongside every average so the UI
  can display it.
- **Snapshot** — Accounts, dated restatements, Value Basis, and the entered-vs-carried
  marking. A Snapshot is complete by construction: creating one seeds every active account
  from the previous snapshot. Carries exactly one FX rate per currency pair.
- **NetWorthAnalytics** — currency exposure derived from each account's native currency
  (never from funding history), allocation against רצוי targets, appreciation ranges, and
  the change decomposition between two snapshots into money-added / market-movement /
  FX-movement. The decomposition also produces the reconciliation against the מאזן's חיסכון
  for the same period, and the residual when they disagree.
- **Projects** — the closed-pot invariant: `יתרה = Σ(funding legs) − Σ(expenses)`. Funding
  Legs record currency and rate as used; the effective blended rate is derived, never
  stored. Deal Terms are recorded here as data and consumed by Scenarios.
- **RsuPosition** — grants, vests, and lots, with each lot's own qualification date derived
  from its grant date plus 24 months. Answers "what lots exist and what is each one's status
  on date D".
- **RsuTax** — given a lot, a sale price, a sale date and rate settings, produces the tax
  breakdown and net proceeds. Implements both treatments: Qualified (grant-price average as
  ordinary income, appreciation at the capital-gains rate) and Unqualified (entire gain as
  ordinary income). Fees are inputs, not constants.
- **LotSelector** — given a target amount and date, selects the set of lots that raises it
  at the lowest total tax, using RsuPosition and RsuTax. Isolated so the selection strategy
  can be changed or replaced without touching the tax maths.
- **Scenarios** — named what-ifs holding target allocations, funding plans and assumption
  overrides. Reads recorded data, writes none of it. Computes gaps, months-to-fund from a
  savings rate, and multi-year projections from Deal Terms. Executing a Funding Plan is the
  operation that produces a Project's Funding Legs.
- **AnnualReview** — implements ADR 0002: persists the year's unrecomputable facts (closing
  FX rate, share prices, valuations) and recomputes ledger figures live from the Ledger on
  every read.
- **SheetImporter** — one-off translation of the Google Sheet export into Categories and
  Entries for 2022–2026. Isolated and disposable. Produces a proposed Category Assignment
  set for human review rather than committing its guesses.

### Schema decisions

- Amounts are stored as integer minor units with an explicit currency code. No floats.
- Entries are keyed by real calendar `(year, month)`. The sheet's July–June tab boundaries
  were presentational; every figure in it is already calendar-keyed and imports directly.
  Verified: the overlapping Jan–Jun 2025 cells in the "2024" and "2025" tabs are identical.
- Category Type is an enum of `income | expense`. There is no transfer type — the household
  has no transfers. The enum is extensible if that changes.
- Value Basis is an enum of `market | cost | estimate`, required on every Account.
- A Snapshot stores its own FX rate. Historical snapshots never re-convert.
- Projects store Funding Legs as `(source, amount, currency, rate)` rows. The effective
  blended rate is computed on read.
- RSU lots derive qualification from grant date, never from a stored flag, so the boundary
  moves correctly as time passes.

### Behavioural decisions carried from the melt

- Household figures are always derived from personal ones. There is no writable household
  ledger.
- מיפוי answers "where is our money", not "what are we worth". Illiquid assets are held at
  cost and never re-valued — see ADR 0003.
- CGM 2 remains classified under נדל"ן despite being converted-but-not-yet-invested. This is
  a deliberate household decision; allocation percentages read accordingly.
- Averages for the current year divide by elapsed months, and the denominator is displayed.
- Forecast share prices are flat at the current price. No growth assumption.
- GP is estimated from market data with a configurable window; the estimate is flagged in
  the UI. The correct window for סעיף 102 needs confirming against an ESOP statement.

## Testing Decisions

**What makes a good test here:** tests exercise a module's public interface with plain data
in and plain data out, and assert on the returned values. They never reach into internal
state, never assert on how a result was computed, and never require a database, a browser or
a network. A test should survive any refactor that preserves behaviour. Where money is
involved, tests assert on exact minor-unit integers, not approximate floats.

There is no prior art in this repository — it is empty. These tests set the pattern.

**Modules under test — all of the following:**

- **Money** — conversion at explicit rates, rounding at minor-unit boundaries, refusal to
  add across currencies, Hebrew formatting.
- **Categories** — creating a personal category always yields a household category; merging
  preserves history; a retired category still resolves for past months; no state exists in
  which a personal category is unassigned.
- **Projects** — the pot invariant holds under any sequence of legs and expenses; the
  effective blended rate matches hand-computed values for the real CGM 1, CGM 2 and Meteor
  funding structures; expenses cannot exceed the pot without a new leg.
- **Ledger accessor** — a category-month returns the entered value when entered and the
  derived value when transaction-backed; the two paths are never both active; missing months
  are distinguishable from zero months.
- **LedgerAnalytics** — averages use elapsed months for a partial year and twelve for a
  complete one, and report their denominator; year-over-year handles categories that did not
  exist in the comparison year; deviation ranking is stable.
- **NetWorthAnalytics** — currency exposure counts a dollar asset fully regardless of
  funding mix; the change decomposition sums exactly to the total change with no residual
  when inputs are consistent, and reports the residual when they are not.
- **RsuPosition** — the 24-month boundary is correct on the day before, the day of, and the
  day after; sold shares reduce the right lot; future vests appear in the schedule and not
  in the current position.
- **RsuTax** — the Qualified path reproduces the existing spreadsheet rows exactly (row 1:
  19 shares at $280 with GP 149.4219 yields tax $2,385.14 and net $2,934.67); the
  Unqualified path taxes the entire gain as ordinary income; fees are subtracted from net,
  not from the taxable base.
- **LotSelector** — the selection reaches at least the target amount; no cheaper valid
  selection exists for small cases verified by exhaustive search; lots not yet vested at the
  target date are excluded.
- **SheetImporter** — tested against fixtures taken from the real sheet export. Asserts that
  the overlapping Jan–Jun 2025 months resolve to a single entry each, that per-person
  categories land under the right person, and that totals recomputed from imported entries
  match the sheet's own stated totals for a sample of months.

## Out of Scope

- **Transaction-level data.** ADR 0001 keeps the seam open, but no transaction import,
  storage or UI is built in this PRD.
- **RiseUp harvesting and direct bank/card connections.** Explicitly parked; the household
  wants advice on this separately. All entry is manual.
- **Valuing real-estate projects.** No current valuations exist, none will be sought, and
  ADR 0003 records why cost is used instead.
- **Distributions, exits and IRR.** Projects are a capital record. Long-run comparison is
  driven by recorded Deal Terms in Scenarios, not by measured performance.
- **Live data feeds for deal terms and returns.** Hand-entered this phase; a live connection
  is a later phase.
- **Automated RSU import from ESOP.** Vest rows are entered manually by decision.
- **Mobile-optimised data entry.** Dashboards are readable on a phone; entry assumes a
  laptop.
- **More than two users, roles, or permissions.** Exactly two accounts, equal access.
- **Currencies beyond ILS and USD.**
- **Tax filing, reporting to authorities, or anything constituting tax advice.** The RSU
  calculator is a planning tool; figures should be confirmed with the household's רו"ח.
- **The 2023 sheet tab.** Superseded by the 2022–2026 import; its structure predates the
  household's move and does not compare.

## Further Notes

**Open items carried from the melt, to be resolved before or during implementation:**

1. **GP window.** The sheet averages closes from grant date −15 to +15 days. For סעיף 102 the
   relevant figure is generally the average over the 30 trading days *preceding* the grant.
   This shifts the ordinary/capital-gains boundary on every row and must be confirmed against
   a real ESOP statement or with the household's רו"ח. The window is a setting for exactly
   this reason.
2. **Qualified/Unqualified share counts.** `RSU_Grants!M50` in the live sheet holds the
   formula behind the $68,619 / $48,879 split. The markdown export lost cell references, and
   the two blocks appear to be priced differently (219 shares at 313.33 versus 214 shares at
   roughly 228). Needs reading from the live sheet before RsuPosition is built.
3. **Data import strategy.** Whether to build a RiseUp harvesting skill or connect directly
   to banks and cards. ADR 0001 makes this cheap to answer later.

**Known data quality issues in the source sheet**, to be handled by SheetImporter or flagged
for human correction: `#REF!` errors in the נדל"ן block; `#DIV/0!` in the 2026 משותף
`אוכל APPLE` row; the duplicated מיפוי tables with divergent pension figures; and the RSU
tab's hardcoded FX of 3.602 against מיפוי's live rate.

**Correction recorded during the melt:** `EPP` in Eden's columns is Apple's employee food
benefit, not ESPP. It is an ordinary expense and pairs with Yuval's `אוכל APPLE` under one
household category.

**Related documentation:** [CONTEXT.md](../../CONTEXT.md),
[ADR 0001](../adr/0001-monthly-amounts-with-optional-transaction-backing.md),
[ADR 0002](../adr/0002-annual-review-freezes-only-unrecomputable-facts.md),
[ADR 0003](../adr/0003-illiquid-assets-are-held-at-cost.md).
