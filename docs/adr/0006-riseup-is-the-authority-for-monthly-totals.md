# RiseUp is the authority for monthly totals, as totals

Answers the question [0001](0001-monthly-amounts-with-optional-transaction-backing.md) left
open, and does not supersede it: its stored unit and its null/zero distinction stand exactly
as written.

0001 said the household enters about twenty monthly category totals per Person *copied from
RiseUp*, and deliberately refused to decide between carrying on, harvesting RiseUp
automatically, or connecting to banks and cards directly. It made the stored unit
`(month, personal category, amount)` and reserved a second, derived path for dated
transactions, so that the decision could arrive later without a migration.

The decision is: **harvest RiseUp, as totals, per Person, from 2026-10 onward.** The
transactions path stays unbuilt and stays available.

## Why totals rather than transactions

RiseUp's grouping is not a vendor's taxonomy that would have to be re-derived — it **is**
the household's own categorization, maintained by the two of them in the app that produces
the figures. The melt of 2026-11-13 reconciled two months that had already been copied by
hand: Yuval's 2026-10 matched his sheet column to the shekel at category level, total 7,053;
Eden's 2026-09 matched row by row to her total of 16,231, with one 7₪ line that did not.
What the hand-copy was doing was arithmetic over RiseUp's categories, and that arithmetic is
what this automates.

Below the category there is nothing to gain and plenty to carry. No reading in the system
wants a transaction: not the grid, not `month-closure`, not `year-grid`, not the Annual
Review. One month of one account is about 70,000 characters of JSON, and storing
twenty-five months of it would be storing for a reader that does not exist. Two of RiseUp's
own groupings — the weekly `כלכלה` envelopes and the *other spending* bucket — have no
transaction-level equivalent of the sheet rows they feed, so a transaction store would have
to re-invent them.

The honest cost: `/balance` cannot answer *what is inside this 1,846₪ of משתנות*. That is
the one question transactions would unlock, it is a feature of its own, and 0001's reserved
path is still there for the day it is wanted.

## Why a cutover month, and why 2026-10

Two producers writing the same category-month is the one thing that must not happen. The
sheet's export reaches into 2026-10 and the importer can write any month it finds there, so
the boundary is stated once and enforced in code: **the importer owns everything before
2026-10; RiseUp owns 2026-10 and after.** A `/riseup-fill` run naming an earlier month stops
where it would touch the ledger — at the comparison and again at the write. Folding an
earlier month into totals and printing them is still allowed and is not a write: it is how
the two months the household had already copied by hand were used to prove the rules.

October is the boundary rather than August because August and September were recorded from
the sheet and are correct; re-deriving them would churn figures nobody doubts.

## What keeps this honest

- **Nothing is written without a person approving it**, line by line, against a side-by-side
  with what the database already holds. A month that already agrees writes nothing.
- **The translation is committed, reviewable and explicit.** `docs/source/riseup-<person>.json`
  says which RiseUp rows feed which Personal Category, including the charge-label rules that
  split Eden's one `חשבונות` category across five rows of her grid. When a subscription
  changes, a diff shows it.
- **An unmapped row stops the run.** Nothing is guessed and nothing is swept into משתנות. A
  wrong-but-plausible figure is the failure mode worth paying a refusal to avoid.
- **The arithmetic is a pure, tested module**, not a model adding up ninety charges — and the
  script fetches the month from RiseUp itself, so no figure passes through a model on its way
  into the ledger.
- **A blank stays blank.** The run never closes a month and never writes a zero into a
  category RiseUp was silent about, which is 0001's distinction and `month-closure`'s rule,
  untouched.
- **Each Person's account is reached through its own MCP server**, and a missing server stops
  the run rather than falling back to the other account.

## Consequences

The feature's correctness now rests on a file of rules that has to be maintained: a category
renamed in RiseUp, a new subscription, a changed envelope all show up as a refusal on the
next run. That is the intended failure mode, but it does mean the file is load-bearing and
`--map` is part of the feature rather than a one-off setup step.

It also makes RiseUp a dependency of recording a month at all, for the two Persons and the
two tokens the household has. The hand path does not go away — `/balance/month` still takes
a figure typed by a person, and the rows with no RiseUp source (each Person's copy of what
the other one pays) are typed exactly as they are today.

Finally, the figures now carry RiseUp's own tidying as a precondition. An unsquared month
reads wrong in RiseUp before it reads wrong here — Eden's 2026-10 salary sits in RiseUp as
an excluded transaction — so the loop is: tidy the month there, then run, then approve.
