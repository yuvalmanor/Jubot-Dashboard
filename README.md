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
   devDependency: nothing in the deployed app imports it. It keeps the database in
   `.pglite/` (gitignored), so a restart keeps whatever was entered; `LOCAL_PG_DATA=memory://`
   opts back into a throwaway one, and `LOCAL_PG_PORT` moves it off 5433.
4. `npm run dev`

The seed is deliberately almost empty — two People and one tracer amount — because every
category is named by the Person who owns it. To look at populated screens instead:

```bash
npm run db:demo
```

That empties every domain table and reloads one coherent household. The **מאזן is real**: it
runs the committed sheet export through the very same importer `/balance/import` uses, which
is 796 entries across 49 categories. **Everything else is invented** — nothing in the
repository records the household's actual accounts, balances or grants — but it keeps the
shapes and the round figures that CONTEXT.md and the PRD do name, so the screens are
exercised the way real data would exercise them. It is destructive and repeatable: run it
again and the same database comes back.

### Signing in locally

Real Google sign-in needs a real OAuth client (below), which a fresh checkout does not have.
So in development — and only there — `/signin` also offers a button per allowed address,
backed by an ordinary Auth.js Credentials provider that is subject to the same two-account
allow-list. `NODE_ENV` is `production` in any `next build`, so the provider is absent from a
deployment rather than merely refusing.

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

The domain and the Google OAuth client depend on each other: the client needs the deployed
callback URL, and the URL is not known until something has been deployed. So the first
deploy is expected to be one you cannot sign in to, and step 6 is what fixes that. Nothing
is lost by it — no route renders data without a session.

1. **Database.** Create a Postgres on Neon or Supabase (free tier). Neon through the Vercel
   marketplace sets `DATABASE_URL` on the project for you; anything else, copy the *pooled*
   connection string. Apply the schema and the seed:
   ```bash
   psql "$DATABASE_URL" -f db/schema.sql -f db/seed.sql
   ```
   `DATABASE_SSL` is not needed — TLS is on for every host except localhost.
2. **The two People.** `db/seed.sql` ships placeholder addresses; put the two real ones on
   the rows, or a sign-in lands in a signed-in shell with no ledger behind it:
   ```sql
   update people set email = 'yuval@…' where id = 'yuval';
   update people set email = 'eden@…'  where id = 'eden';
   ```
3. **Import the repository into Vercel** (Hobby plan). The framework preset, build command
   and output directory are all detected; nothing needs overriding.
4. **Environment variables**, on Production and Preview both:

   | Variable | Value |
   | --- | --- |
   | `AUTH_SECRET` | 32 random bytes, base64 — `npx auth secret` |
   | `AUTH_GOOGLE_ID` | from the OAuth client, step 5 |
   | `AUTH_GOOGLE_SECRET` | from the OAuth client, step 5 |
   | `JUBOT_ALLOWED_EMAILS` | the two real addresses, comma separated |
   | `DATABASE_URL` | pooled connection string from step 1 |

   `JUBOT_ALLOWED_EMAILS` and the `people.email` values must agree — the first decides who
   may sign in, the second decides which of the two they are.
5. **Google OAuth client.** Cloud console → APIs & Services → Credentials → OAuth 2.0
   Client ID, type *Web application*. Authorised redirect URIs:
   - `http://localhost:3000/api/auth/callback/google`
   - `https://<your-vercel-domain>/api/auth/callback/google`
6. **Deploy, then add the real domain** to the client's redirect URIs and redeploy. Preview
   deployments get their own URLs; each one that must be signed in to needs its callback
   added too, which is the usual reason to keep reviewing on Production.

The development sign-in buttons do not exist in any of this: `next build` sets
`NODE_ENV=production`, and the provider behind them is only added when it is not.

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

### Reading a year

`/balance` is the year: categories down, months across, at Household or Person level,
defaulting to משותף because that is the question the household opens the screen to ask.
`yearGrid` in `src/domain/ledger/year-grid.ts` is the whole reading — pure, handed a ledger
and a clock — and the table renders it without adding anything up itself.

All twelve months are always columns, so the table's shape does not change as the year
passes: a month that has not arrived is greyed and says so, and the month being lived shows
its figures in its own column tinted *בתהליך* while feeding neither aggregate. סכום שנתי and
ממוצע חודשי sit past דצמבר, and they are one `Average` over one list of months — the year's
closed months as far as the ledger's history reaches — so the two columns cannot cover
different spans, and the ממוצע header prints both the divisor and the span it counted.

A row is on the grid when its lifespan overlaps the year *or* it holds a figure in it. The
first half is what makes the holes visible; the second is why retiring a category can never
hide money. A cell that was never recorded is a muted `—` and a cell recorded as nought is
`0.00`, and no path in the grid turns the first into the second.

### Filling the holes from the grid

Every cell leads to wherever its figure can be written, and gets exactly one affordance,
because at 5.25rem a phone column holds a figure and nothing beside it. A cell that is a
single category-month **opens in place** — "I forgot חו"ל in May" should not cost a form of
twenty-two fields — and a משותף cell summing two People **links to `/balance/month`**, which
is the one screen that can say whose money it was. `writesTo` on the reading is what decides
which, so the one line with no input anywhere is the one line the domain gives nothing to
write to: חיסכון has no target on any cell, and neither does a band subtotal.

Either Person records into either Person's categories, on the grid and on the month form
both. The names stay the owner's own — that is what a Personal Category is — but recording
an amount against one is administration, and the household needs a complete ledger more than
it needs to know whose hand typed a figure. The משותף tab still has no inputs at all.

### Reading and writing a month at three levels

`/balance/month` records one month as either Person or as the Household. Both personal views
have inputs and either Person may use either; the household view has nothing to write to at
all — `householdMonthSummary` and `householdCategoryLines` derive every household figure from
the personal ones on each read, and each household line opens onto the personal categories
that produced it, so a figure and its drill-down cannot disagree.

Every view states how much of the month has been recorded. A month with some categories
filled and some empty reads as *חודש חלקי*, never as a cheap month.

### Closing a month

A blank cell is ambiguous, and no arithmetic can resolve it: it might be an unfinished month,
or a month in which חו"ל simply did not happen. Treating every blank as unfinished would flag
most of the year forever; treating every blank as nought would invent facts nobody stated.

So it is resolved by a person, at the point of entry. `src/domain/ledger/month-closure.ts`
says a month is **closed** when every category active in it holds a reading — derived off the
ledger on every read, with no column, no flag and no sweep that could go stale. Saving a month
that still has blanks names them on screen and offers them as zero; the grid marks every
closed *calendar* month that is not a closed month (`חסרים 12`, against a quiet `מלא` where
nothing is outstanding — a check that is only visible when it fails teaches nobody that it is
running) and the same offer is one click from the column heading.

Three rules hold it together:

- **Accepting writes real zeros**, indistinguishable from hand-typed ones, because that is
  what they are. This is the deliberate act the null/zero distinction exists to permit, as
  against the silent collapse it exists to forbid.
- **Declining writes nothing**, and says so. The offer is never pre-accepted and never
  implicit: doing nothing leaves the month exactly as the save left it.
- **Closing writes into blanks and nowhere else.** `planMonthClosure` intersects the blanks
  as they stand *now* with the blanks the person was actually shown, so a category given a
  figure since the screen was drawn cannot be overwritten and a category nobody saw cannot be
  written. Every path goes through `closeOneMonth`, which takes one `CalendarMonth` — which is
  why there is no action anywhere that closes more than one. Rewriting two years of imported
  history in a single click is the irreversible mass edit this deliberately has no button for.

### Category lifecycle

Category administration is a **panel beneath the grid**, not a route of its own. It used to
be one, which meant every rename and every merge was made on a screen with no figures on it;
now the table is directly above, so the consequence of a change is in view while it is made.
`?admin=1` opens it, like every other piece of state on that screen. None of it touches
`entries`, which is why any of it is safe to run over four years of history.

- **Creating** a personal category yields the category, the household line it joins or
  creates, and the assignment between them as one indivisible result. It used to exist only
  on the month form, so making a category always meant going somewhere you did not want to be.
- **Renaming a personal category** changes one column on one row: no household name, no
  assignment, no amount. This is what corrects `הלווואות` — three ו's in one column against
  `הלוואות` in the other, which the importer reported to a screen that could do nothing
  about it.
- **Renaming** a household category likewise changes one column on one row. Personal names
  are the Person's own and are never touched by it.
- **Merging** moves assignments from one household line to another and drops the emptied
  one — a household category holds no amounts, so an empty one is a name and nothing else.
  Household totals before and after a merge are the same money under a different heading.
- **Retiring** closes a lifespan (`active_until`, inclusive) rather than deleting a row. A
  retired category drops off the months outside its lifespan, and any month that already
  holds a figure for it keeps showing that figure — retiring can never hide money. Moving
  `active_from` earlier is what makes an older month enterable.

Both People administer both columns — the same rule that governs recording amounts. A
Personal Category is still one Person's own naming, and the panel says whose each one is,
but there is no read-only half of the screen.

Two things are absent by design rather than unbuilt. **Type** is fixed at creation: a
category does not change direction from month to month, and one that did would make every
month before the change unreadable. And nothing is **deleted** — there is no `plan…Deletion`
in the domain and no shape that drops a Personal Category, because the amounts recorded
against one are still money that happened. `categories.test.ts` pins both absences, so
adding either becomes a deliberate act with a failing test in front of it.

That none of this moves money is checked where it would show: `year-grid.test.ts` renders
the whole grid at all three levels across the whole history, before and after each
operation, and compares the figures.

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
allocation targets, which accounts the concentration is watched on, which accounts move
with a market, the GP window the RSU screen estimates over, the two tax rates a sale can
meet, and what the broker and the trustee charge.

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

## מחשבון RSU

`src/domain/rsu/rsu-position.ts` holds the position and `/rsu` reads it. A **Grant** is what
the paperwork awarded; a **Vest** is a slice of it becoming the household's, on a date at a
price; a **Sale** is shares leaving one named vest. A vest with shares still in it is a
**Lot**, and a lot is the unit everything is answered in, because a lot is the unit tax is
answered in.

Nothing on the screen is stored. Every share count and every qualification is derived on each
read, which is why the reading date is a control rather than a fixed "today": the same rows
read on two days give two answers, and for a boundary whose only input is the passage of time
that is the correct behaviour.

- **Qualification is derived, never stored.** A lot is Qualified when סעיף 102's twenty-four
  months from its *grant* date have run — `granted_on` plus 24 months, computed in months and
  not in days, so a leap year cannot move it and a grant made on 29 February qualifies on the
  28th. There is no flag to go stale, and therefore no sweep that could fail and price an
  early sale as though the clock had finished. Verified live across the day before, the day
  of and the day after, with nothing written between the three reads.
- **A future vest is not a position.** Vests are recorded ahead of their date so the forecast
  has something to work with, and they are held out of every figure until that date arrives.
  Nothing marks them: the position compares their date to the day it is read on.
- **A sale names its lot.** Which lot shares left decides how they are taxed, so a sale
  without one would be a question rather than a record. It reduces that lot and no other, and
  one larger than the lot holds is refused before it is written — the same shape as an
  overdrawing project expense. Vests are checked against their grant's own total the same way.

A **price per share is not money.** GP 149.4219 is a real figure off a real statement and
cents cannot hold it, so a price is an exact integer count of ten-thousandths with its own
currency — the same idea as minor units, one scale finer. It becomes a `Money` only when
multiplied by a whole number of shares, rounded once at the end rather than in every share.

### GP, and the window it rests on

A grant's GP is one of two different kinds of thing, and the system never lets them read
alike. **Stated** means read off an ESOP document: a fact. **Estimated** means averaged out
of closes over a window: not one. An estimate carries the window and the sample size that
produced it, so it cannot be printed anywhere as though somebody had measured it, and one
component renders every GP on the screen so there is no second path that could forget.

The window is a `/settings` dial rather than a constant, because *which* window סעיף 102
means is the open question this area waits on. Both candidate rules are the same shape with
different numbers in it — the household's sheet averages 15 calendar days either side of the
grant including the grant day; סעיף 102 is generally applied as the 30 trading days
*preceding* it. The system starts from the latter. On the trading basis the pasted closes
themselves are the calendar, so "the thirty preceding sessions" counts rows and skips
weekends, while the calendar basis counts dates and a shut market simply shortens the sample.

Changing the window does not rewrite a figure already taken: an estimate keeps the window it
was taken under, and `/rsu` flags it as taken under a different one. Correcting the setting
corrects the next reading, and says which older ones are owed a recomputation.

### What a sale costs, under both treatments

`src/domain/rsu/rsu-tax.ts` is the gap the spreadsheet could not express. It priced one
outcome — GP as ordinary income and the appreciation above it at the capital-gains rate,
which is correct *once* the 24 months have run — and had no way to say what selling early
costs. Both treatments are here, and neither is ever chosen by hand:

- **The treatment comes from the lot's own clock.** `treatmentOn` asks the grant date and
  the *sale* date and nothing else — never the lot's `qualified`, which is a fact about the
  day the position was read. Verified live on one lot with nothing written between the two
  reads: sold on 1 June 2025 it is an early sale taxed on the whole $5,320.00, and sold on
  11 August 2026 it is $2,839.02 of ordinary income against a $2,480.98 gain. That the same
  function answers both is what makes *what is waiting worth* a question it can answer by
  asking itself twice, at the same price, so the difference is the clock and not a guess
  about the share price.
- **A sale is priced or it is refused.** A Qualified lot out of a grant with no GP recorded
  cannot be split into work income and gain at all, so `/rsu` says so instead of putting a
  number on the screen that rests on nothing. Where the price has fallen *below* GP the
  whole of the proceeds is ordinary income and the gain is nought — a work-income component
  larger than the money received would tax income nobody got — and the row says that is why.
- **The rates are the household's.** 62.17% and 25% are its reading of סעיף 102, and a
  reading belongs in `/settings` rather than in a constant. Every figure names the two rates
  that produced it.
- **Fees come off the net and never off the base.** A commission is money that did not
  arrive, not income nobody earned; taking it off the taxable base would reduce a tax on a
  figure the tax authority never saw reduced, and would make "what was taxed" and "what
  arrived" impossible to read apart. They are charged once over a whole sale rather than per
  lot, because a flat commission on one sale is one commission however many lots the shares
  came out of. Verified live: $0.01 a share, $15.00 flat and 0.5% to the trustee took
  $41.79 off a $2,934.73 net and left the $2,385.27 of tax exactly where it was.

Shares are drawn from the oldest lot first. That is a *stated convention* and not an
optimisation — which lots are cheapest to sell is Phase 14's question, and it answers it by
handing a different list to the same function, so the tax arithmetic never has to know how
the lots were chosen. Asking for more shares than are held fills what it can and reports the
shortfall rather than refusing the question.

The net is reported in dollars and in shekels, at the latest stored rate, which is named and
dated beside the figure. Where no rate is stored the net stays in dollars and the screen
says why, rather than converting at one nobody quoted.

**One row does not reproduce.** The household's own sheet states that 19 shares at $280 with
GP 149.4219 yield tax $2,385.14 and net $2,934.67; this module produces $2,385.27 and
$2,934.73. The gap is reconstructible to the cent and it is not rounding:
`5,320.00 − 2,385.14 − 2,934.67 = 0.19`, a cent a share of selling cost, and taking that
$0.19 off the *ordinary-income base* before the 62.17% gives 2,385.1442 — the sheet's tax to
the cent, and then its net to the cent. Nothing else fits both figures at 62.17% and 25%. So
the sheet deducted the selling cost from what it taxed, which is the one thing the PRD names
as wrong; the remaining agora is that each component here is a real amount rounded to the
cent once, where the sheet carried unrounded floats into a single total. Reproducing the
sheet exactly would mean reproducing that, and this does not.

## לוח תכנון

`src/domain/planning/scenarios.ts` holds the what-ifs, and `/planning` reads them. A
**Scenario** (תרחיש) is a thought with a name — "CGM 3 ב־2027" — and the whole point of it is
that thinking it disturbs nothing. A **Funding Plan** (תוכנית מימון) is what a future
investment needs and which sources would cover it: the *before* of a Project's Funding Legs,
the same facts in the future tense.

Three rules give the area its shape:

- **It reads recorded data and writes none of it.** The only tables the planning screens
  write are `scenarios`, `funding_plans` and `funding_plan_sources`; the מאזן, מיפוי,
  the accounts and the projects are read and never touched. `src/domain/planning/
  writes-nothing-recorded.test.ts` is the guard on that — it reads the area off disk and
  fails on a write statement or on an imported writer, because a rule worth stating is worth
  something that keeps it from eroding one query at a time. Removing a scenario deletes a
  thought and not a fact: the cascade reaches its plan and its sources, and nothing recorded
  is reachable from there.
- **A planned source carries no rate and no date.** A future conversion has no rate yet, and
  one written down before the money moved would be a number nobody used. Both arrive when the
  plan is *executed* and its lines become real legs, which is Phase 16's work. Reading a
  shekel source into a dollar plan therefore needs a rate handed in from outside: it is named
  and dated on the screen, and a source that cannot be read at any rate the system holds is
  listed beside the gap rather than converted at one nobody quoted — so the covered figure is
  the *most* that is covered.
- **A new scenario is seeded from what is recorded, and the seed states its vintage.** Free
  liquid money out of the latest מיפוי — the נזילות bucket less what is already promised out of
  it — is written in as a source marked `seeded`, stamped with that reading's own date. It
  stays editable, because a plan is a what-if; what it is not is a figure of unknown
  provenance. When the same figure now reads differently the screen says so and leaves the
  line alone: silently moving a number somebody already decided against is the failure, not
  the drift. A shortfall seeds nothing — a promise with nothing behind it is not money to
  invest.

From those come the two answers the area exists for. The **gap** is `needs − Σ(sources)`,
computed on every read with nowhere to store it, and being over-covered reads as a surplus
rather than as a negative requirement. **Months to close it** is that gap over what the
household actually saves a month, read through the Ledger so it is the same חיסכון the מאזן
screens show, and rounded *up*: saving arrives in monthly lumps and a part-month closes
nothing. The pace divides by the months that hold a figure rather than by the length of the
window, states that denominator, and names the months that are only half recorded — an
unfinished month understates its own חיסכון, so a pace resting on one is understated too.

Where there is no answer the screen says which of four things is true rather than printing a
number: nothing recorded to measure a pace over, a pace of nought or less at which the gap
never closes, a gap and a pace in different currencies with no rate between them, or a plan
the sources already cover.
