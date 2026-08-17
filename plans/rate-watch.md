# Plan: מעקב תעריפים — rates, year against year

> Source PRD: the melt of 2026-08-17 (this file records its decisions in full)
> Continues: [plans/maazan-redesign.md](maazan-redesign.md), whose Phases 18–23 built the
> grid this panel sits under. Phase numbering continues from there.
> Supporting docs: [CONTEXT.md](../CONTEXT.md), [docs/prd/jubot.md](../docs/prd/jubot.md),
> ADRs [0001](../docs/adr/0001-monthly-amounts-with-optional-transaction-backing.md),
> [0002](../docs/adr/0002-annual-review-freezes-only-unrecomputable-facts.md),
> [0004](../docs/adr/0004-framework-free-domain-modules-on-a-zero-cost-stack.md)

The מאזן answers *where did the money go*. It does not answer *is this getting more
expensive, and could we phone someone and argue about it* — the question behind a car
insurance renewal, a מכבי premium that crept 96 → 207 over three years, and an internet
line nobody has renegotiated since it was installed.

The sheet tried twice. A `שנתי - X` block on the 2023 tab — רו"ח 3,346, ביטוח רכב 5,139,
רישיון רכב 1,154, טיפול רכב 2,830, ביטוח דירה 590, תספורת 1,190, each with its ÷12 beside
it — which exists on no later tab. And a `ביטוחים` block, which reads **273 / 1,619 / 4,104
/ 1,297 identically on the 2024 tab and the 2025 tab** and is empty on 2026: filled in once,
copied forward, abandoned. Neither carries a date. Neither was ever compared to anything.

This plan builds the third attempt with the two properties the first two lacked: it is
always on screen, and every figure in it is dated.

## New user stories

The PRD's stories 15 and 20 cover comparing a category against its own history. Nothing in
it covers a bill that arrives once a year, so the melt adds three.

25. As a household member, I want the fixed charges we pay — insurance, subscriptions,
    annual bills — listed with their monthly and yearly rate, so I can tell whether a rate
    has crept up and decide whether to renegotiate.
26. As a household member, I want to record what each annual bill actually cost at each
    renewal, so that next year's quote can be held against the last one.
27. As a household member, I want to mark any household category as watched, so that
    everything whose rate I care about is in one place, regardless of how often it is billed.

---

## Architectural decisions

Durable decisions that apply across all phases. Settled during the melt; not to be
re-litigated per phase.

### It never writes the ledger

**This is the load-bearing decision.** The annual money is *already counted in the מאזן*:
when the car insurance bill is paid, that shekel is typed into an existing Personal Category
— יובל's `רכב`, עדן's `קבועות` / `חשבונות`. Confirmed by the household on 2026-08-17.

So מעקב תעריפים records a **detail breakdown of figures the grid above already holds**.
No phase here writes `entries`, and no phase adds an amount to `סה"כ הוצאות` or moves
`חיסכון`. Writing these figures into the ledger would double-count them.

The corollary: **the two bands are never summed.** One band breaks down ledger rows and the
other band *is* ledger rows, so a total across them is a figure with no meaning. Per-band
subtotals only.

### Language

Four terms, for CONTEXT.md:

**Rate Watch** (מעקב תעריפים):
The panel below the year grid. Named for the question it answers — whether a price someone
set has moved — not for the things currently in it.
_Avoid_: fixed charges, recurring expenses (both name today's contents rather than the idea)

**Annual Item** (פריט שנתי):
A named thing billed about once a year and typed by hand — ביטוח רכב מקיף, רו"ח, רישוי.
It belongs to the Household and to no Person. Ending one is a lifespan, never a delete.
_Avoid_: annual expense, yearly bill, subscription

**Renewal** (חידוש):
One Annual Item's price on one date. The amount is the **policy total**, whatever number of
תשלומים it was actually billed in, because that is the figure being negotiated. The year an
Annual Item's figure belongs to is derived from this date and stored nowhere.
_Avoid_: payment, charge, instalment

**Watched Category** (קטגוריה במעקב):
A Household Category flagged to appear in Rate Watch. Deliberately not "Subscription": the
household may watch anything, including a variable row, and the panel works out whether a
rate exists rather than requiring the answer up front.
_Avoid_: subscription, מנוי, fixed category

### Routes

No new route. `/balance` gains query parameters, in the same idiom as `expand` and `admin`,
so a view of the panel is a URL that can be sent to the other person.

| Parameter | Meaning |
| --- | --- |
| `rates=all` | the panel shows every recorded year rather than the selected one and its predecessor |
| `rateEdit=1` | the Annual Item forms are open inside the panel |
| `rateItem=<id>` | which Annual Item is being edited |

The panel itself is **always rendered** — never behind a link. At roughly fifteen rows it is
nothing like the ~135 forms that justified hiding `?admin=1`, and out of sight is precisely
how both sheet attempts died.

### Schema

```
household_categories.watched  boolean not null default false

rate_watch_items (
  id         uuid primary key,
  name       text not null unique,
  started_on date not null,
  ended_on   date,                       -- retirement is a lifespan, never a delete
  check (ended_on is null or ended_on >= started_on)
)

rate_watch_renewals (
  item_id      uuid   not null references rate_watch_items (id) on delete cascade,
  renewed_on   date   not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency     text   not null check (char_length(currency) = 3),
  primary key (item_id, renewed_on)
)
```

The composite primary key is what permits two renewals inside one calendar year — a policy
that slips from December to January must not overwrite anything — while making one item's
price on one day unambiguous.

There is no `year` column. The year is derived from `renewed_on`, so a September renewal
cannot be filed under the wrong year by hand.

There is no owner column on `rate_watch_items`. The car and the apartment are household
facts, and this is a deliberate exception to CONTEXT's *"every household-level number is
derived from Person-level data"* — legitimate, because these are not מאזן figures.

### Currency

**ILS only.** The `currency` column is still explicit and still required, exactly as every
other money column in this schema, so recording a USD subscription later is an addition and
not a migration. Until then a `$20/mo` charge is recorded at what it actually cost in
shekels, and a rate move is indistinguishable from a price rise — stated, and accepted.

### One figure, one computation

Any monthly average this panel prints must be the same `averageOverMonths` over the same
`denominatorMonths` the grid directly above it uses. Phase 20 established that no figure
appears twice computed two ways, and this panel sits inches below that column.

### The threshold

A row is **marked** when it moved by ≥10% **and** ≥300₪ over the year, both required. The
grid's own 50% / 1,000₪ bar is calibrated for three hundred cells and would miss everything
this panel exists to catch — car insurance at 5,139 → 5,900 is +15% / +761₪ and would not
trip it. The two bars here are calibrated in Phase 24 against real subscription history, the
same way Phase 20's were calibrated against the real 2025 year.

### No backfill

The panel's typed band ships empty. The sheet's annual figures are one undated snapshot
copied across two tabs, and the PRD's own Out of Scope already retires the 2023 tab as
structurally incomparable. Nothing in this panel is ever a number of unknown vintage.

The derived band ships with 25 months of real history (2024-07 – 2026-07), so the feature is
useful on the day it lands rather than a year later.

### Ownership and lifecycle

Both People add and edit everything here; Phases 21 and 22 removed the ownership check
throughout the מאזן and a new panel reintroducing one would be the odd screen out.

A **Renewal** is editable and removable — a figure typed once a year must be correctable the
day it is mistyped. An **Annual Item** ends with `ended_on` and is never deleted, so past
years keep reading exactly as they did and the price history that was the point of tracking
it survives.

### `/annual` is untouched

Per ADR 0002 the סיכום שנתי holds only what cannot be recomputed. Every figure here is a
pure function of the items, the renewals and the ledger, forever.

### Known limitation, accepted

An Annual Item does **not** name the Personal Category it sits inside. The household chose
this. The consequences, recorded so nobody rediscovers them as bugs:

- Nothing can reconcile a typed detail against the category actually holding that money.
- Nothing can detect the double-count if `ביטוח רכב` is recorded as an Annual Item *and*
  `רכב` is flagged as a Watched Category. This is why there is no combined total.

The mitigations are structural rather than computed: the panel is always visible, and a
stale item announces itself rather than going quiet.

---

## Phase 24: the derived band, end to end

**User stories**: 15, 20, 25, 27

### What to build

The tracer bullet: a complete path from a new flag on a Household Category, through a new
domain reading, to a rendered panel below the grid — and it needs no new money to be typed,
because the figures already exist. `רייזאפ`, `מכבי`, `אינטרנט`, `אפל מיוזיק`, `לובי99`,
`טלפון 012` and `AIAI` have been recorded every month since 2024-07.

A Household Category is flagged with one checkbox on the card that already exists in
`?admin=1`. Flagged categories appear in the panel's `חיובים חודשיים` band, each summing
both People automatically — which is what a Household Category is for, and why the flag is
there rather than on the personal rows.

Each row shows its **current rate**, the selected year and the one before as **actual sums**,
and the change between them in ₪ and %. No annualising: `רייזאפ` in 2025 was 45 for ten
months and 55 for two, and the row reads its real 560 rather than 55 × 12.

The current rate is not asked for, it is worked out. Where the last three recorded months
carry the same figure, that figure is the rate. Where they do not, the row reads `משתנה`
with the year's monthly average beside it and carries no mark — a variable row deviating is
not news, and the household may watch a variable row if it wants to.

The 10% / 300₪ bars are calibrated here, against the real history, and the calibration is
recorded — not asserted.

### Acceptance criteria

- [x] A Household Category can be flagged as watched from the card it already has in
      `?admin=1`, and unflagged the same way
- [x] The מעקב תעריפים panel renders below the year grid on every read of `/balance`, with no
      link or toggle needed to see it
- [x] The `חיובים חודשיים` band lists exactly the watched Household Categories, each summing
      both People's contributions
- [x] A row whose last three recorded months are equal shows that figure as `עכשיו X/חודש`
- [x] A row whose last three recorded months differ shows `משתנה` with the year's monthly
      average beside it, and is never marked
- [x] Each row shows the selected year and the preceding year as actual sums of what was
      recorded, never a rate multiplied by twelve
- [x] Each row prints its change from the preceding year in both ₪ and %
- [x] A row is marked only when the change is ≥10% **and** ≥300₪, and the calibration is
      recorded against the real 2024–2026 subscription history
- [x] The band prints its own subtotal, excluding `משתנה` rows, which have no rate to add
- [x] Nothing in this phase writes `entries`, and the grid above reads identically before and
      after flagging or unflagging any category
- [x] A year with no recording for a watched category renders as a muted blank, never as `0`
- [x] The panel's monthly figures are the same `averageOverMonths` over the same
      `denominatorMonths` the grid's own aggregate column uses
- [x] The band's reading is a pure domain function with no database in its tests
- [x] The panel is readable on a phone with no separate mobile layout, and the page itself
      never scrolls sideways

### What the build settled

Two things the phase decided that the plan did not, both recorded here so Phase 25 inherits
them rather than rediscovering them:

**The earlier year is read over the same months as the selected one.** Calibrating against
the real history showed the alternative immediately: in August 2026 the selected year counts
ינואר–יולי, and setting seven months against a full 2025 made every row on the default
screen read as a collapse of two fifths. The comparison is therefore `denominatorMonths`
matched one for one a year back — the rule `yearOverYear` already follows — and each year
column states the span it counted. Where the two sides still rest on different numbers of
*recorded* months, as 2025's twelve against 2024's six do, the row prints `אין השוואה` with
both counts rather than reporting missing history as a change in price.

**The calibration's finding is that the bars mark nothing in this band.** Every fixed-rate
subscription the household holds is 22₪–110₪ a month, so none can move 300₪ over a year.
The two nearest misses are what each bar is for: רייזאפ at +22% / +140₪, which a percentage
bar alone would report as a finding about a twenty-shekel subscription, and מכבי at +15% /
+104₪, whose real story is the three-year creep Phase 26 opens the panel to show. The bars
are set for the typed band's annual bills — the plan's own 5,139 → 5,900 renewal trips both,
and `rate-watch.test.ts` pins that alongside the real rows it leaves alone.

---

## Phase 25: the typed band

**User stories**: 25, 26

### What to build

The half the ledger cannot supply. `rate_watch_items` and `rate_watch_renewals` arrive, with
a small add/edit form inside the panel behind `?rateEdit=1`, so the panel still reads clean
by default.

One record is a name, a total and a renewal date — `ביטוח רכב מקיף, 4,104, 2025-09`. The
amount is the policy price regardless of how many תשלומים it was billed in, because that is
the number being negotiated. The year is derived from the date.

The `פריטים שנתיים` band renders above the derived one, reusing Phase 24's comparison
machinery unchanged: the same delta, the same 10% / 300₪ mark, its own subtotal. Its monthly
figure is the renewal total ÷ 12. A year the item was not renewed in reads **`לא חודש`** and
never `0`, which is the ledger's blank-is-not-zero rule applied one level up.

Correction ships with entry rather than after it. A form that can produce a typo and cannot
fix it is a trap, and this is a form used about six times a year — by the time the mistake
is noticed the person will not remember making it.

### Acceptance criteria

- [x] An Annual Item can be created with a name, and a Renewal recorded against it with a
      total and a date
- [x] The year a Renewal belongs to is derived from its date; no year is stored and none can
      be typed
- [x] Two Renewals in one calendar year both survive, and neither overwrites the other
- [x] A Renewal can be corrected and can be removed
- [x] The `פריטים שנתיים` band shows, per item: the current rate as total ÷ 12, the selected
      year and the preceding year, and the change in ₪ and %
- [x] The band uses the identical comparison and marking used by `חיובים חודשיים` — one
      implementation, not two
- [x] A year in which an item was not renewed renders as `לא חודש`, visibly distinct from a
      recorded zero and from a year outside the item's life
- [x] The band prints its own subtotal, and no total is printed across both bands anywhere
      on the page
- [x] The typed band writes nothing to `entries`; the grid above and both band subtotals are
      independent, and a criterion pins that the grid's figures are byte-identical before and
      after any Rate Watch write
- [x] Either person can create, edit and remove any item and any renewal
- [x] The amount is stored in integer minor units with an explicit currency, and a non-ILS
      currency is refused for now rather than silently coerced
- [x] An item's first year shows its figures and no comparison, rather than a change against
      nothing

### What the build settled

Three decisions the phase had to make that the plan left open, recorded so Phase 26 inherits
them:

**An Annual Item is created with its first Renewal, and its life begins there.** The schema's
`started_on` needs a source, and the only honest one is the earliest price recorded — an item
with a life but no price would be a start date somebody guessed. The corollary is that
recording a Renewal *older* than the item moves `started_on` back to it rather than refusing:
backfilling last September's quote against an item created today is an ordinary act, not an
error. This is what makes *a year outside the item's life* a real state — the third reading of
a year cell, beside `לא חודש` and a figure.

**A typed year is a whole calendar year.** The derived band matches ינואר–יולי against
ינואר–יולי because a monthly charge has a partial year; a renewal is one dated event and has
none. So the two bands' year columns count different things and each says which — `שנה מלאה`
above, the month span below — and neither is ever added to the other.

**Two renewals in one year sum, and refuse to be compared against one.** The composite key
lets a policy that slipped from December to January leave one year holding both. The year's
figure is their sum, and the comparison reports `אין השוואה` with both counts rather than
reading the slip as a doubling — which is Phase 24's `uneven` rule applied a year up, through
the same `changeOf`.

---

## Phase 26: the full history, and the life of an item

**User stories**: 25, 26

### What to build

Two columns answer "did it move". Four years answer "has it been creeping" — which is the
`מכבי` case, 96 → 207 across three years without any single year jumping enough to be
marked. `?rates=all` opens the panel to every recorded year, in the same idiom as the grid's
own expand toggle.

Then the two states an item can be in that the panel has so far had no way to say.

**Stale.** An item whose newest Renewal is more than thirteen months old reads
`לא חודש מאז ספטמבר 2025` in place of a rate. Thirteen and not twelve, because a renewal
that arrives a fortnight late is not an anomaly. Without this, a policy quietly cancelled
keeps reporting a confident monthly figure forever, and a panel that lies while looking
healthy is worse than one that is empty.

**Ended.** An item is retired with `ended_on` — the car was sold, the subscription dropped —
and disappears from the current reading while keeping every year it was recorded in. Nothing
is deleted, so the price history that was the whole point of tracking it survives the thing
it was tracking.

CONTEXT.md gains the four terms, and the panel gains the sentence that keeps a reader from
adding it to the grid above: these figures are already counted in the מאזן.

### Acceptance criteria

- [ ] `?rates=all` shows every recorded year for both bands; without it the panel shows the
      selected year and its predecessor
- [ ] The toggle carries the rest of the view with it, and every other control on the page
      carries the toggle, so opening the history never resets the year or the tab
- [ ] An Annual Item whose newest Renewal is more than 13 months old shows
      `לא חודש מאז <חודש שנה>` instead of a monthly rate, and is not marked
- [ ] An Annual Item can be ended with a date, and ending one deletes nothing
- [ ] An ended item is absent from the current year's reading and still present, with all its
      figures, in the years it was recorded in
- [ ] An ended item's rows are visibly marked as ended, so a reader does not take an old
      price for a live one
- [ ] Ending an item changes no figure of any other item and nothing in the grid above
- [ ] The panel states, in one line on screen, that these figures are a breakdown of money
      the מאזן already counts and are not additional spending
- [ ] CONTEXT.md carries מעקב תעריפים, פריט שנתי, חידוש and קטגוריה במעקב, each with its
      _Avoid_ list, and the relationships section records that an Annual Item belongs to the
      Household and to no Person
- [ ] The known limitation — items are not linked to categories, so nothing can reconcile
      them or detect an overlap — is recorded in CONTEXT.md's flagged ambiguities
