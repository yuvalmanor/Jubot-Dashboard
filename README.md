# Jubot

A private household financial dashboard for two people. See [CONTEXT.md](CONTEXT.md) for the
domain language, [docs/adr](docs/adr) for the decisions, and [plans/jubot.md](plans/jubot.md)
for the phased build.

## Stack

Next.js (App Router) + TypeScript on Vercel, Postgres on Neon or Supabase, Tailwind,
Auth.js with Google OAuth restricted to two accounts. Everything stays on free tiers.

Domain modules under `src/domain/` import nothing from Next.js, React or the database
client ([ADR 0004](docs/adr/0004-framework-free-domain-modules-on-a-zero-cost-stack.md)).
They take plain data and return plain data; persistence and rendering wrap them from the
outside. `src/domain/architecture.test.ts` enforces this.

## Gates

All three must pass before anything is committed.

```bash
npm test && npx tsc --noEmit && npm run build
```

## Local development

1. `npm install`
2. `cp .env.example .env.local` and fill it in (see below).
3. Start a database. Either point `DATABASE_URL` at a real one and apply the SQL:
   ```bash
   psql "$DATABASE_URL" -f db/schema.sql -f db/seed.sql
   ```
   or run the bundled local one, which needs no install:
   ```bash
   npm run db:local
   ```
   `db:local` is PGlite — real Postgres compiled to WebAssembly — served over the ordinary
   wire protocol on port 5433, with `db/schema.sql` and `db/seed.sql` already applied. The
   app connects to it with the same `pg` client it uses against Neon. It is a
   devDependency: nothing in the deployed app imports it. It holds the database in memory,
   so restarting it starts from the seed again.
4. `npm run dev`

### Linking a sign-in to a Person

`JUBOT_ALLOWED_EMAILS` decides *who may sign in*. `people.email` decides *which of the two
they are* — it is what connects a Google account to that Person's categories and entries.
The two must agree. `db/seed.sql` ships the same placeholder addresses as `.env.example`;
on a real instance put the two real addresses in both places:

```sql
update people set email = 'yuval@…' where id = 'yuval';
update people set email = 'eden@…'  where id = 'eden';
```

An allowed address with no matching Person row gets a signed-in shell that says so, rather
than someone else's ledger.

### Google OAuth client

In the Google Cloud console, create an OAuth 2.0 Client ID of type *Web application*.
Authorised redirect URIs:

- `http://localhost:3000/api/auth/callback/google`
- `https://<your-vercel-domain>/api/auth/callback/google`

Put the client ID and secret in `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`, and the two
household addresses in `JUBOT_ALLOWED_EMAILS`. An address outside that list is refused in
the `signIn` callback, so no session is ever issued for it.

## Deploying

1. Create a Postgres database on Neon or Supabase (free tier) and run `db/schema.sql` and
   `db/seed.sql` against it.
2. Set the two real addresses on the `people` rows (see *Linking a sign-in to a Person*).
3. Import the repository into Vercel (Hobby plan).
4. Set `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `JUBOT_ALLOWED_EMAILS` and
   `DATABASE_URL` as environment variables in the Vercel project.
5. Add the deployed domain's callback URL to the Google OAuth client.
6. Deploy.

## Money

Every amount in the system is an integer number of minor units plus an explicit currency
code — never a float, never a bare number. `src/domain/money/money.ts` owns the arithmetic:
addition across currencies throws, conversion requires an explicit rate that names its
currency pair, and rounding happens at the minor-unit boundary, half away from zero. Rates
are read as exact decimals rather than doubles, so 3.65 means 365/100. It also owns the
boundary with a keyboard: `parseMoneyInput` reads what a person typed and `toDecimalString`
writes it back, and a field left untouched round-trips to the same minor units. `divide` is
exact in the same way — a three-month average of 1,000₪ is 333.33 and not a drifting float —
and `ratio` answers `null` rather than a percentage when there is nothing to be a percentage
of.

## מאזן

`src/domain/categories` holds Personal Categories, Household Categories and the Assignment
between them. Creating a personal category is one indivisible result — the category, the
household category it joins, and the assignment — so there is no shape in which money is
recorded personally and missing from the household. The database holds the same rule as a
deferred constraint, so it cannot be broken by anything that writes around the domain.

`src/domain/ledger` holds Entries, keyed by real calendar `(year, month)`. `readAmount` is
the only read path for a category-month and hides whether the figure was entered by hand or
derived from transactions ([ADR 0001](docs/adr/0001-monthly-amounts-with-optional-transaction-backing.md));
a category-month carrying both is refused. A month that was never recorded reads as `null`,
which is not the same fact as a month recorded as zero. חיסכון is `הכנסות − הוצאות`,
computed on read, with nowhere to write it.

### Reading a month at three levels

`/balance` reads one month as either Person or as the Household. Only the signed-in
Person's own view has inputs: the other's is readable and not writable, and the household
view has nothing to write to at all — `householdMonthSummary` and `householdCategoryLines`
derive every household figure from the personal ones on each read, and each household line
opens onto the personal categories that produced it, so a figure and its drill-down cannot
disagree.

Every view states how much of the month has been recorded. A month with some categories
filled and some empty reads as *חודש חלקי*, never as a cheap month.

### Category lifecycle

`/balance/categories` administers the taxonomy over the amounts. None of it touches
`entries`, which is why any of it is safe to run over four years of history.

- **Renaming** a household category changes one column on one row. Personal names are the
  Person's own and are never touched by it.
- **Merging** moves assignments from one household line to another and drops the emptied
  one — a household category holds no amounts, so an empty one is a name and nothing else.
  Household totals before and after a merge are the same money under a different heading.
- **Retiring** closes a lifespan (`active_until`, inclusive) rather than deleting a row. A
  retired category drops off the months outside its lifespan, and any month that already
  holds a figure for it keeps showing that figure — retiring can never hide money. Moving
  `active_from` earlier is what makes an older month enterable.

Household lines belong to both People, so either may rename or merge them. A personal
category is one Person's own naming, so only its owner may move or retire it.

### Reading the trend

`src/domain/ledger/ledger-analytics.ts` is the reading half: pure functions over the entries,
with the clock always a parameter. `/balance/insights` renders them. Nothing on that screen is
writable and no figure there is stored.

The screen is driven by one control — a focus month — so no figure is ever ambiguous about
which month it belongs to. The trend is the twelve months ending there with the same month of
the previous year beside each one; the deviations are that month against the six before it;
the breakdown and the year-over-year comparison are that month's year.

Three rules run through the module, and each exists because the alternative would be a lie:

- **Every average states its denominator.** `Average` cannot be built without one and there is
  no field holding a bare mean, so nothing can reach the screen without saying whether it
  divided by 6 or by 12.
- **A share of nothing is `null`.** A month with no income did not save 0% of it; an average
  over no months is undefined, not nought. The screen prints the absence.
- **Two denominators, two questions.** A *period* average divides by elapsed months — twelve
  for a past year, eight for August of the current one — so a partial year compares against a
  full one. A *trailing* average divides by the months that actually hold a figure, because
  the ledger says an absent month was never recorded rather than recorded as zero.

The same distinction decides what may be ranked. A category with a figure this month and a
trailing average is a measurement. A category with no history is reported as having none
rather than compared against an invented zero, which would put every new category at the top;
a category with history and nothing this month is reported too, rather than ranked as a fall
to zero that might only be an unfinished month. The order is total and tie-broken by id, so
two reads of the same month always produce the same list. Year-over-year trims both sides to
the same span — Jan–Aug against Jan–Aug — so no category appears to collapse every January,
and a category that did not exist last year reads *לא הייתה קיימת* rather than a rise from
nothing.

Both charts are inline SVG, server-rendered, with no client JavaScript and no charting
dependency. Every figure in them is repeated in the table beneath, so no number lives only in
a picture.

### Importing the sheet

`docs/source/maazan-sheet-export.md` is the מאזן half of the household's Google Sheet,
exported verbatim — errors included. `src/domain/import` reads it: `sheet-export.ts` knows
the shape of the file and `sheet-importer.ts` knows what the rows mean. Both are
framework-free, and both are disposable once the history is in.

The importer **proposes**. `/balance/import` shows every proposal with the reason behind
it, and the button at the bottom is the only thing that writes. What it will not decide on
its own:

- **Which rows are categories.** `סה"כ הוצאות` and `חיסכון` are computed by the sheet, so
  importing them would double-count the first and contradict the invariant behind the
  second. `הפקדות לחיסכון` is money moved rather than spent — the sheet leaves it out of
  its own expense total, and the household records no transfers — so it is proposed as
  excluded, with that reason attached.
- **Which household line a category joins.** Matching names are proposed together, `EPP`
  is paired with `אוכל APPLE` because the household said so, and two names one character
  apart (`הלוואות` / `הלווואות`) are reported and left alone.
- **Which tab is right.** Jan–Jun 2025 appears on two tabs. Where they agree the month
  collapses to one entry silently; where they disagree both figures are shown with the tab
  each came from, and the choice is a radio button.

Every month's expenses are recomputed from the rows that would be written and compared
against the sheet's own `סה"כ הוצאות`. 61 of the 62 stated totals match to the agora; the
62nd is the sheet contradicting itself, and it is displayed rather than absorbed.

Two things the sheet does that are worth knowing when reading the import: the current
year's tab carries formula zeros for months that have not happened, which are dropped
because a zero is a recorded fact and would otherwise be indistinguishable from a real one;
and its own משותף block nets `EPP` out of both sides, so that block's expense total is not
the sum of the two personal ones. The משותף blocks are not imported at all — every
household figure is derived at read time.

Running it twice is safe. Every statement is an upsert, and a re-run never undoes a merge
or a retirement made afterwards.

## מיפוי

`src/domain/snapshot` holds Accounts and Snapshots. An Account is *where* value is held —
a Person, a native currency, a Value Basis, a קטגוריה and a סוג נכס. It never holds an
amount: how much is in it is a fact with a date on it, and that is what a Snapshot is for.
`/accounts` defines them and `/snapshots` reads them.

Three rules do the work, and each exists because the spreadsheet broke without it:

- **A snapshot is complete by construction.** Taking one seeds a line for every Account open
  on its date, carried forward from the previous snapshot, so restating means correcting
  what changed rather than re-typing everything — and no account can be left out by being
  forgotten. An Account defined *after* a snapshot was taken is reported on that snapshot as
  missing rather than quietly absent, and can be added as a never-measured row.
- **Every figure says whether it was measured.** A line is `entered` — someone stated it for
  this snapshot's date — or `carried`, and `measuredOn` names the day it was last actually
  stated. A pension untouched for five months reads *נגרר — נמדד לאחרונה ב־31 בינואר* rather
  than as a measured flat line. Changing a figure records it as measured; resubmitting the
  form unchanged does not, because re-sending a form is not a measurement. The `נמדד`
  checkbox is how an unchanged figure is confirmed as one.
- **One rate per snapshot.** Each snapshot carries its own `USD/ILS` rate and every
  conversion inside it uses that and nothing else. The same $100,000 reads as 365,000₪ in
  the January snapshot and 320,000₪ in the July one, and neither moves when today's rate
  does — the direct fix for the sheet's hardcoded 3.602. `convertWithin` is the only
  conversion path, and it throws rather than reaching for a rate from elsewhere.

Balances are held in the account's own currency and never pre-converted; `snapshotReadings`
is the read path that needs no rate at all, and `convertedReadings` is the one that restates
them. Rollups run off the Account's own קטגוריה (נזילות / השקעות / פנסיה / נדל"ן, a closed
set, because a rollup over free text is a typo away from being wrong) and its סוג נכס, and
each bucket opens onto exactly the readings its total was computed from. Every bucket also
states how many of its figures were carried rather than measured.

Closing an account is a lifespan (`closed_on`), never a delete: a closed account drops out
of later snapshots and keeps resolving in every snapshot it already appears in. Its currency
is not editable at all — changing it would re-denominate every figure already recorded
against it.

### The שקל and the דולר tables

`currencyTable` is one function; the שקל table and the דולר table are it with a different
argument. Neither is stored and neither has an input in it, so the sheet's failure — the
pension reading 519,088 in one table and 450,376 in the other — has nowhere to happen. The
one editable surface is the restatement form, in the account's own currency, once.

Both directions run off the snapshot's single rate. Reading shekels back as dollars divides
by the stored rate rather than multiplying by an inverse of it (`convertBack`), because an
inverse rounded to a few decimals *is* a second rate, and two rates for one pair is exactly
how two tables drift apart. `canConvertWithin` is the question "can this snapshot restate
that pair at all"; `hasRateWithin` stays the narrower "is the rate quoted in this direction",
and only the display of the stored quote uses it.

Every total on the screen states what it is made of: `basisSplitOf` divides it into שווי
שוק, עלות and הערכה with each one's share, for the snapshot as a whole and for every rollup
bucket. Per [ADR 0003](docs/adr/0003-illiquid-assets-are-held-at-cost.md) a cost-held asset
is never re-valued, so a total that does not say how much of itself is cost is claiming to
know more than it does. A share of nothing prints as nothing rather than as 0%.

### Browsing the history, and comparing two

`/snapshots` lists the complete history by date, newest first, each row with its own total
at its own rate. A snapshot is a reading in a series, so the series is walkable from inside
one: `/snapshots/[id]` carries the previous and next dates and a link straight to the
comparison with the previous.

`/snapshots/compare` puts any two side by side. Two rules keep it honest:

- **Per-account differences are in the account's own currency.** Subtracting two converted
  figures taken at different rates mixes what the money did with what the shekel did.
  Separating those is the decomposition's work, so this screen shows a figure no rate can
  distort, says outright when the two snapshots' rates differ, and links to the decomposition
  of exactly that pair.
- **A row that carried is never presented as a measurement.** `ComparisonKind` says which of
  five things a row is — measured, carried, unmeasured on one side, opened, closed — and it
  is orthogonal to whether the figure moved: a July row carrying April's pension against a
  January reading has changed *and* was not measured, and reads as both. A side nobody ever
  measured is a placeholder, so there is no difference to state and none is invented.

Argument order does not matter: the earlier date is always the *before*, so a comparison
cannot read backwards by accident.

### החזקות and ייעודים

`src/domain/snapshot/holdings.ts` holds the two claims on what is inside an Account. They
look alike and are opposites.

A **Position** (החזקה) says what the money is invested in — `1159235 ACWI`. It carries no
amount, deliberately: how much an account holds is a fact with a date on it, and the
Snapshot is where dated facts live. A figure stored beside it would drift from the snapshot
exactly the way the sheet's two currency tables drifted from each other. An account held at
cost is refused one outright — per [ADR 0003](docs/adr/0003-illiquid-assets-are-held-at-cost.md)
nothing in it is priced, so there is no composition to state.

An **Earmark** (ייעוד) says what the money is promised to — קרן חירום's claim inside the
liquid account. It *is* an amount and it is fixed, held in the account's own currency by a
composite foreign key rather than by a check anyone can forget. Spending the account down
does not shrink the claim; it makes it **underfunded**, and the shortfall is the figure
worth seeing. Releasing one is a lifespan, so a snapshot taken while the claim stood keeps
reading as it did, and one declared in 2026 never appears on a 2025 reading.

Both are defined on `/accounts`. Whether a claim is *funded* is read on `/snapshots/[id]`,
against that snapshot's own figures, and three rules keep it honest:

- **The comparison is in the account's own currency**, so no rate can turn a shortfall into
  a surplus.
- **An account nobody ever measured is `unmeasured`, not underfunded.** A placeholder is not
  a shortfall.
- **Claims on one account are assessed together**, because they compete for the same money.
  Two 80,000₪ promises against 100,000₪ are jointly short, and nothing here invents a
  priority that would make one of them whole at the other's expense.

`freeLiquid` answers what is actually available: the נזילות bucket less what is promised out
of it. A claim on an account in another bucket is spoken for out of *that* bucket and does
not reduce it. The claim is subtracted whole even where its backing is short — what was
promised is what was promised — and the unbacked part is reported beside it rather than
written off. The figure goes negative rather than clamping, because a promise with nothing
behind it is a fact and not a zero.

## שווי נטו

`src/domain/networth/net-worth-analytics.ts` is the derived view over the snapshot history,
and `/net-worth` renders it. Nothing on that screen is writable and no figure there is
stored. One control names the snapshot everything but the trajectory is read from, so no
figure is ambiguous about which reading it belongs to.

- **The trajectory** is every snapshot's total at *its own* rate, so the line does not
  redraw itself when today's rate moves. A snapshot carrying no rate for a currency it holds
  has no point at all: the line breaks there rather than plotting a total that quietly
  dropped the dollar accounts. Each row states how many of its lines were measured on the
  day, and a change across two different rates is labelled as such — separating what the
  money did from what the shekel did is the decomposition's work, below.
- **Exposure is what an asset *is*.** It is grouped by each Account's own currency and never
  by how the money that bought it was funded. A $104,000 stake is fully exposed even if two
  thirds of it began as shekels — the funding history is not consulted, and could not be:
  nothing in a Snapshot records it.
- **Allocation states its target.** Every קטגוריה gets a row whether or not it holds
  anything, because a bucket targeted at 30% and holding nothing is the largest deviation
  the portfolio can have. A bucket with no target reads *לא נקבע יעד* rather than as a target
  of nothing, and the drift is a Money as well as a percentage — "9% under" is not
  actionable until it says how much money that is. Targets are read as they were set: a set
  adding to 97.5% says so, and nothing completes it to 100% behind the reader's back. CGM 2
  sits under נדל"ן by the household's decision, and the percentages read accordingly.
- **Growth is an assumption or it is absent.** Per [ADR 0003](docs/adr/0003-illiquid-assets-are-held-at-cost.md)
  a cost-held asset is never re-valued, so שווי נטו is read twice: as recorded, holding cost
  at cost, and with the household's appreciation assumption applied to the cost-held part
  only. Both travel together and the assumption travels with them, so the grown figure
  cannot be printed as though it were a measurement. Each asset grows from its own opening
  date in *whole* years — an asset held eleven months grows by nothing rather than by a
  fraction nobody can check — and the multiplier is exact: 3% for five years is
  `1.15927407430000000000` and not a float near it.
- **Concentration is named by account id**, not matched on a name, so renaming the Apple RSU
  account cannot make the concentration quietly read as zero. An account marked for the
  watch but absent from the snapshot is reported rather than counted as nothing.

### What a change was made of, and whether it holds

Between two readings, only three things can have happened: money went in or came out, what
was held moved, or the shekel moved. `decomposeChange` says how much of each, and
`/net-worth` prints it against the reading before the one being read.

The arithmetic is exact by construction. Each account is read three times — opening at the
opening rate, opening at the closing rate, closing at the closing rate — and the three
components are the consecutive differences, so they telescope to the change with nothing
left over at any rate, however awkward. The screen prints the leftover rather than asserting
there is none.

The split between market movement and money added is the one part that is *not* arithmetic.
Two snapshots record positions and not flows, and the household records no transfers, so
nothing in the data can say whether a fund rose or was paid into. It is therefore declared:
`/settings` names the accounts that move on their own, and everything else that moved reads
as money added. Not marking anything is the position the system starts from. An account held
at cost is refused the mark outright — per [ADR 0003](docs/adr/0003-illiquid-assets-are-held-at-cost.md)
nothing in it is priced, so its value changes only when more money goes in. An account that
opened or closed inside the period is money arriving or leaving whatever it is marked as: a
position nobody held cannot have grown.

`reconcileMoneyAdded` is then the check the spreadsheet never had: money added, against the
מאזן's own חיסכון for the same period. חיסכון is read through the Ledger, so it is the same
figure the מאזן screens show and cannot drift from them.

- **The period is the whole calendar months between the two readings.** A month the period
  only clips is named and left out — the ledger records months, and there is no part-month
  figure to take. Month ends and month firsts both read a month whole, so when the household
  takes a snapshot does not decide what may be compared. A period holding no whole month says
  so instead of comparing against half a month nobody recorded.
- **The residual is displayed, never absorbed.** Less arrived than was saved: money left
  without being written down. More arrived than was saved: an income nobody recorded, or
  movement in an account nobody marked as floating. Both readings are stated on the screen,
  and months that are only half recorded are named beside them, because an unfinished month
  understates its own חיסכון and can look exactly like a leak.
- **It is on the dashboard**, not only on a detail screen — a discrepancy nobody passes is a
  discrepancy nobody finds. The dashboard reconciles the latest reading against the nearest
  earlier one the מאזן can answer for, so a weekly cadence does not switch the check off, and
  it names the period it used. It says just as plainly when the two agree: a check that is
  only visible when it fails teaches nobody that it is running.

### Settings

`/settings` holds the household's own dials: the appreciation assumption, the רצוי
allocation targets, which accounts the concentration is watched on, and which accounts move
with a market. Later phases add the GP window and the fee and tax rates beside them.

None of it is a measurement, which is exactly why none of it is a constant in the code — a
rate that can only move by shipping a deploy stops reading as an assumption and starts
reading as a fact. Percentages are stored as whole basis points for the same reason money is
stored in minor units, and a bucket left blank is stored as no target at all rather than as
a target of zero.

## נכסים ופרוייקטים

`src/domain/projects/projects.ts` holds the closed pot, and `/projects` reads it. A Project
is a pot with one currency — a pot has one size, so it has one currency — and three rules
give it its shape:

- **Funding Legs fill it, and nothing else does.** A leg records one source in the currency
  it was actually paid in: CGM 1 was funded by 109,800₪ out of the current account and by
  $69,000 of Apple RSU. Putting more money in is adding a leg, so a pot cannot be topped up
  without it being written down where from.
- **Expenses are drawn out of it.** `יתרה = Σ(legs) − Σ(expenses)`, computed on every read
  with nowhere to write it, so no sequence of operations can leave the balance disagreeing
  with the rows beneath it. An expense larger than the balance is refused before it is
  written — the overdrawn state never exists, not even inside a transaction — and so is
  removing a leg the pot has already spent against, which is the same broken state reached
  from the other side.
- **A rate is recorded where a conversion happened, and nowhere else.** A leg already in the
  pot's currency converted nothing and carries no rate; a rate beside it would be a number
  nobody used. The database holds the same rule as a trigger, because it needs the project's
  own currency and a column check cannot reach it.

From those comes the **effective rate**: the shekels on one side of the conversions this
project actually took and the dollars on the other, and the shekels-per-dollar those imply.
It is derived from the recorded amounts rather than averaged out of the rate fields, so
dividing one by the other reproduces the shekel total exactly — and two shekel legs
converted at 4.00 and at 3.00 blend to 3.4286, which is what they cost, not to the 3.50 an
average of the rates would claim. Legs that were already in the pot's currency are not in it
at all: money that was already dollars was never bought.

The rate is shown against today's, and the screen says only what the two numbers are. Which
of them is the good one depends on which way the money went — dollars bought with shekels
want a low rate, dollars sold for shekels want a high one — so the direction is stated and
the reader is not told what to feel about it. A difference smaller than the four decimals on
screen reads as "the same rate", because the effective figure is derived from amounts rounded
to the agora and can sit a fraction of a ten-thousandth from the rate that produced it.

**Deal Terms** are what the sponsor's paperwork stated — target return in whole basis points,
hold period in months, the distribution pattern in the sponsor's own words, and which
document it was read off. A promise and not a measurement: nothing in the system is derived
from them, and Phase 15's Scenarios are what consume them.

Per [ADR 0003](docs/adr/0003-illiquid-assets-are-held-at-cost.md) a project's value in מיפוי
is its **total cost** and stays there as the expense ledger is spent down: CGM 1 reads
$99,082.19 with $77,894.19 already deployed, because converting cash into property moves
money inside the same pot. Naming the account that carries the project lets the screen state
what that account should read and report it when it does not — it never writes into the
snapshot, because a project's value in מיפוי is a figure a person states.
