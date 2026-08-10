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
