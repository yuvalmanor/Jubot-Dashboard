# Design: נכסים ופרוייקטים — one dashboard per project

A design note, not a phased plan. It exists because the verdict pass found this area
שבור (`plans/review.md`) and because two of the four things Yuval asked a project
dashboard to show — הכנסות and עדכוני צמיחה — are not in the model and cannot be added
without deciding something first.

Nothing here is built. Two decisions below are his.

## What he asked for

> אני רוצה שתחשוב על דשבורד של פרויקט אבל לא מורכב מידי, כזה שמפרט גורמי מימון,
> הוצאות הכנסות ועדכוני צמיחה

Four bands: funding, expenses, income, growth. Two exist, two do not.

## What is there now

A project page is seven sections stacked down one scroll: הקופה, שער אפקטיבי, רגלי מימון,
ספר ההוצאות, שווי במיפוי, תנאי העסקה, הגדרת הפרוייקט. Each opens with a paragraph
explaining the rule it enforces — why a balance is derived, why an expense cannot exceed
it, why the effective rate is not an average of rate fields, why cost does not fall as the
ledger is spent. Every one of those paragraphs is true and worth having said once.

The trouble is that they are said every time, at the same weight as the figures, so the
page reads as an argument rather than as a position. And the two tables each carry a
four-field form *below* them, so recording a leg means scrolling past the legs.

## The two decisions

### 1. Where does a distribution go?

**Settled: both ways, and the row says which.** A project pays a dividend, and the
household either takes it or leaves it in.

- **יוצאת** — it lands in an Account that מיפוי already counts. The project records that it
  paid out; `יתרה` is untouched, because that money is no longer available to this project.
- **מגולגלת** — it stays in and can be deployed again, so `יתרה` rises by it.

Which means the Pot's balance gains a term:

```
יתרה = Σ legs + Σ rolled − Σ expenses
```

The invariant that matters survives intact: the balance is still derived on every read, it
still cannot be left torn, and it still cannot be topped up by anything that is not a
recorded row. A rolled distribution is money entering the Pot, which the old rule said had
to be a Funding Leg — and it deliberately is not one. A leg is external capital and sets
the effective rate; profit the project made is neither, and counting it as a leg would
inflate גויס and pollute a rate that is supposed to describe a currency conversion.

So four figures, each answering exactly one question, and none of them standing in for
another:

| | |
| --- | --- |
| **גויס** | `Σ legs` — what was put in from outside. Drives the effective rate. |
| **יתרה** | `legs + rolled − expenses` — what is left to deploy. |
| **חולק החוצה** | `Σ distributions going out` — what the household actually received. |
| **חולק בסך הכל** | `Σ all distributions` — what the project produced, taken or not. |

**The cost basis moves with it.** A project's מיפוי value at עלות becomes `Σ legs + Σ
rolled`, not `Σ legs`. That keeps `cost = deployed + undeployed` true, which is what makes
the מיפוי line explainable at all, and it is honest about the word: rolling a dividend back
in *is* putting money in, by choosing not to take it. A project that has rolled nothing
reads exactly as it does today.

### 2. May a project be worth more than it cost?

**Settled: yes.** ADR 0003 said no, and Yuval has withdrawn that decision —
[ADR 0005](../docs/adr/0005-illiquid-assets-carry-their-latest-stated-valuation.md)
supersedes it. 0003's whole argument rested on "no current valuation exists and none will
be sought", which is wrong: the CGM projects are SFH holdings that get re-appraised every
few years, and Meteor's sponsor reported 20% growth over the last year.

What that buys, and what it costs:

- **A Valuation is an event, not a rate.** A figure, the date it was stated, the document
  or party it came from. Nothing extrapolates between two of them, and nothing projects
  Meteor's 20% forward — a project reads the last figure stated about it until the next
  one. An annual rate is what the sponsor said, not a function the dashboard applies.
- **Value Basis does the grading.** A re-appraisal is שווי שוק. A sponsor's own report of
  its own performance is הערכה. עלות is what a project reads between statements, which is
  most of the time.
- **מיפוי follows it, and that is the real change.** Allocation, מט"ח exposure and every
  funding decision keyed off them now move when a valuation is recorded. That is what 0003
  was protecting against, and the safeguard is provenance rather than refusal: a valuation
  cannot be recorded without a source, so whatever moved can be traced to who said so.
- **Cost stays beside it.** "What we put in" and "what it is said to be worth" are two
  questions, and the first cannot be argued with.

## The dashboard

One screen per project. A head, four bands, and the rules moved out of the way.

### The head

One row, read left to right, with a single bar under it:

| גויס | הושקע | יתרה | התקבל | שווי אחרון |
| ---: | ---: | ---: | ---: | ---: |
| Σ legs | Σ expenses | legs − expenses | Σ income | stated, or בעלות |

The bar is deployed against raised, which is the one thing the three stat tiles were
circling: CGM 1 is 79% deployed with $21,188 waiting. שווי אחרון prints the cost and says
so when no valuation has been recorded, which is the usual case and is not a gap.

Under the head, one line, only when it can be said honestly: `התקבל + שווי אחרון מול גויס`
— and only when a stated valuation exists, with its date, basis and source on it. No
valuation, no performance line: a project reading at cost would show "0%", which is a
measurement of nothing rather than a finding.

### The bands

Built as four, then merged to two on Yuval's reading of it: _"תמזג את ההכנסה של רגלי
מימון, הוצאות, חלוקות לרצועה אחת שאפשר לבחור בה האם זה מימון, הוצאה או חלוקה"_.

1. **תנועות** — everything that ever moved, oldest first, with the kind as a column.
   Three ledgers were three places to look and three places to type for what is one
   history, and the per-band totals they carried are all in the head anyway. Columns: סוג,
   מה, תאריך, כפי ששולם, שער, לקופה. A distribution's destination rides in the סוג cell
   (`חלוקה ← עו"ש דיסקונט`, `חלוקה ↩ בחזרה לקופה`), which keeps decision 1 visible on the
   screen without a column that is empty for two kinds out of three.
2. **עדכוני שווי** — what it is said to be worth. Date, figure, basis, source document.
   Separate because it is not a movement: nothing in it moves money and nothing sums it.
   The band reads newest first and the head quotes the top row.

**`לקופה` is signed, and a taken distribution shows a dash rather than a zero.** Zero
would say the row moved nothing; the dash says the balance is not where that money is.
The column sums exactly to `יתרה`, which is pinned by a test.

### Entry

The add-row *is* the table's last row, as in the מאזן grid: the same columns, in place, so
recording anything never leaves what is already there. One row per band.

In תנועות the row's first field is the kind, and the destination is inside it — `מימון`,
`הוצאה`, `חלוקה: גולגלה בחזרה`, `חלוקה: יצאה אל <חשבון>`. One control rather than two,
because "a חלוקה" is not a complete answer (where it went decides whether the balance
moves), and a separate destination field would sit dead for two choices out of three.

### The rules

Everything the current page argues — the derived balance, the refused overdraw, the
effective rate not being an average, the cost that does not fall — moves to one legend
above the bands, the way the year grid's legend works. Said once, available, not repeated
at the weight of a figure.

תנאי העסקה and הגדרת הפרוייקט move behind a `?admin=1`-style toggle, as ניהול קטגוריות
already does in מאזן. They are set once a project and read rarely.

### The look

Asked for after the layout settled: _"תחשוב על משהו נקי בסגנון של Apple"_, with the
instruction to take it from how other people present this kind of thing rather than from a
template. Two ideas came back worth keeping, and they agree with each other:

- **Deference** — Apple's HIG puts the interface in service of the content: hierarchy is
  made of size, weight and space, and the chrome never competes with the figures. The
  practical reading of that here is that a screen of bordered boxes becomes a surface with
  things on it.
- **Default to no ink** — Matthew Ström's rules for data tables: right-align figures, use
  tabular lining numerals, keep rules extremely light or drop them once alignment does the
  work, no zebra striping, keep tables monochromatic, and use shading only to separate one
  *kind* of value from another. Copilot Money's dark palette is the same idea from the
  other end — separation by tint step rather than by border, and colour reserved for data.

What that became, in `src/app/globals.css`:

| | |
| --- | --- |
| Surfaces | `--color-canvas` `#f7f6f4`, `--color-surface` white, `--color-sunken` for fields. Warm, never pure white on pure black — this is a screen read for a long time. |
| Lines | Two hairlines at 7% and 14% black, used only where space cannot do the separating. |
| Lift | `--shadow-card`, two layers and barely visible. A card is lifted off the canvas by light rather than outlined on it. |
| Figures | `.tabular` for every column of money; `.figure` adds −0.022em tracking, because system faces are spaced for running text and a 46px number reads loose without it. |
| Focus | One ring for the whole app. |

And on the screen itself: one lead figure at 46px with the four supporting ones at 19px
rather than five of equal weight; table headers at normal weight with no rule under them;
filled fields instead of outlined ones, so a row of inputs reads as one surface; `הסרה`
revealed on row hover and always present where there is no pointer; a 6px dot for the
movement kind instead of a coloured chip per row; and the `לקופה` column monochrome, its
sign placed by `Intl` through `format(…, { withSign: true })` rather than written in
beside the figure — a `+` in front of a Hebrew-formatted amount is a neutral character at
the edge of an RTL run, and where it lands is then the bidi algorithm's decision.

**Carried across the whole app** in a second pass, since a half-restyled app is worse than
either look on its own. Every screen now reads from the same tokens: there is no
`border border-stone-300` left anywhere in `src`, cards are lifted by `shadow-card`, fields
are filled, buttons are a dark fill or a hover tint, and notices keep their hue and lose
their outline. Three places kept a visible rule on purpose, because space could not do the
job: the pinned rows of the מאזן grid and of מעקב תעריפים, which float over the rows they
are pinned above, and a sticky cell's fill stays opaque for the same reason.

Not done: a dark theme. The tokens are the place it would go, and nothing reads a
`prefers-color-scheme` yet.

### The overview

`/projects` becomes one line per project rather than one card: name, pot currency, the
deployed bar, יתרה, התקבל. The פרוייקט חדש form goes behind the same toggle as the other
settings.

## What this costs

Two tables (`project_distributions`, `project_valuations`), both close in shape to
`project_expenses`. Distributions are additive — nothing existing changes meaning, and
`יתרה` keeps its definition exactly, which is the point. Valuations are not: once מיפוי
reads them, שווי נטו, allocation and מט"ח exposure all move, so the Snapshot's line for a
project has to carry which valuation it was reading and when it was stated.

The screen is a rewrite of `src/app/projects`, not a patch. ADR 0003 is untouched, and if
the second decision ever goes the other way it is amended on purpose rather than eroded.

## Open

- Does a project ever return capital that should genuinely be redeployed inside it, rather
  than landing in a bank account? If so, decision 1 needs a third kind of row.
- Meteor issues reports the household does not read (ADR 0003). If עדכוני שווי is built and
  nobody reads the reports, the band stays empty forever — which is fine, but worth saying
  before it is built.
- **`annual_review_valuations` and `project_valuations` now overlap.** The first predates
  ADR 0005: one figure per project per year, keyed by year, read only by סיכום שנתי, and
  explicitly *not* the project's מיפוי value because 0003 said no project had one. The
  second is the same kind of judgement recorded as a dated, sourced event that מיפוי does
  read. Once a valuation is dated, a year's closing figure is `latestValuation(asOf: 31
  December)` and ADR 0002's own rule — the annual review stores only what cannot be
  recomputed — says the older table should go. That is a decision about סיכום שנתי, which
  has not been through a verdict yet, so both tables stand and each one's comment names
  the other.

## Phases

Three slices, each end to end. Phase numbering continues from `plans/rate-watch.md`, whose
Phase 26 is frozen until this area is done.

---

## Phase 27: חלוקות, both kinds, end to end

**User stories**: 51, 52, 53 (revised), and new ones for a distribution taken and a
distribution rolled.

### What to build

`project_distributions` arrives: a project, a date, an amount with its currency and the
rate used, what it was for, and a destination — an Account for one that goes out, or
nothing for one that is rolled back in. The same shape as `project_expenses`, which is
what it is a sibling of.

`יתרה` becomes `Σ legs + Σ rolled − Σ expenses` in the one place it is derived, and the
overdraw rule follows it without being restated: an expense larger than the balance is
still refused, and a rolled distribution is one of the things that can make room for it.
The effective rate is computed from legs alone and does not move.

The band lands on the project page as it stands — a table and the form the other two have.
The dashboard is Phase 29, and putting the figures in before the layout means the layout is
designed against real rows rather than against a sketch.

### Acceptance criteria

- [x] A distribution records date, amount, currency, rate and purpose, and is refused
      without a destination unless it is marked as rolled
      <!-- One field carries the destination: an account id means it left, empty means it
           was rolled. The column check in the schema holds the two in step from the other
           side, so a row cannot reach the table claiming both or neither. -->
- [x] `יתרה = Σ legs + Σ rolled − Σ expenses`, derived on every read and stored nowhere
      <!-- Verified live on CGM 1: 21,188 → 30,188 on a $9,000 rolled row, and unmoved by
           a $4,000 one that went out. -->
- [x] An expense exceeding the balance is still refused, counting rolled distributions
- [x] A rolled distribution is not a Funding Leg: גויס and the effective rate are unchanged
      by it
      <!-- The rate is drawn from the legs alone and a distribution cannot reach it, which
           is structural rather than a rule anybody has to keep. -->
- [x] חולק החוצה counts only distributions that went out; חולק בסך הכל counts both kinds
- [x] A project's מיפוי value at עלות reads `Σ legs + Σ rolled`
      <!-- Which is `spent + balance`, the identity the panel now states in those words:
           108,082.19 = 77,894.19 spent + 30,188 left. -->
- [x] A distribution going out names the Account it landed in, and that Account is not
      credited automatically
- [x] Removing a distribution that the balance has since been spent against is refused,
      the way removing such a leg already is
      <!-- And one that went out is always removable: it never entered the balance, so
           taking it back out is a correction to where the money went and not to what the
           project has. -->
- [x] `CONTEXT.md` gains the rolled/out distinction under Distribution

---

## Phase 28: עדכוני שווי

Split in two when it was built. The project screen needs the band and the figure; מיפוי
reading them touches שווי נטו, הקצאה, חשיפת מט"ח and the Snapshot's own provenance, which
are other screens and a decision of their own. 28א shipped with Phase 29, which is the
point of splitting it: the fourth band was built straight into the new layout rather than
onto the old page to be thrown away.

**User stories**: 57 (revised under ADR 0005), and new ones for recording a valuation.

### 28א — the band and the figure

`project_valuations`: a project, a date, a figure in the Pot's currency, a Value Basis and
the source it was read from. An event, never a rate — nothing extrapolates between two of
them and nothing projects a stated annual growth forward.

A project reads the last valuation stated about it, or עלות when none has been.

- [x] A valuation records date, figure, Value Basis and source, and is refused without a
      source
      <!-- `source` is `not null` and non-blank in the schema as well as in the domain:
           מיפוי moves when one of these lands, so the safeguard is provenance. -->
- [x] A valuation is stated in the Pot's own currency and carries no rate, since nothing
      was converted
- [x] A project reads its latest valuation as at a given date, and עלות when there is none
- [x] Nothing interpolates, extrapolates or annualises between two valuations
      <!-- Pinned by a test that reads a date halfway between two statements and gets the
           earlier figure exactly, not the average of them. -->
- [x] The performance line measures against `cost`, not against גויס, so a rolled
      distribution is not counted as profit while also being part of what is valued

### 28ב — and מיפוי reads them

Not built. The Snapshot line for a project carries which valuation it read and when that
was stated, so a past Snapshot keeps reading what it read at the time — the same rule the
USD rate already follows. `valueOf` already takes an `asOf`, which is the seam this needs.

- [ ] A Snapshot records the valuation it read, so an old Snapshot does not change when a
      new valuation is recorded
- [ ] שווי נטו, allocation and מט"ח exposure move with a recorded valuation, and state the
      basis they are reading
- [ ] Meteor's 20% reads as one הערכה dated to the sponsor's report, not as a rate
- [ ] `annual_review_valuations` is settled against `project_valuations` — see Open, below

---

## Phase 29: the dashboard

### What to build

The screen described above: the head of five figures over a deployed-against-raised bar,
the four bands each a compact table whose last row is where you type, the arguing prose
moved to one legend, תנאי העסקה and הגדרת הפרוייקט behind a toggle, and `/projects` as one
line per project.

### Acceptance criteria

- [x] A project page is a head and its bands, with no explanatory paragraph between them
      <!-- Eight bordered cards down one scroll became one head, one legend and one
           bordered block. Four bands at first; two once the three ledgers merged. -->
- [x] The three ledgers are one תנועות table with the kind as a column, and one entry row
      whose first field is the kind
      <!-- Verified live: a leg, an expense and a distribution each recorded through the
           one row, each landing in its own table; the overdraw refusal still fires from
           it; and each row's הסרה routes to its own kind's action. -->
- [x] Every band's add-row is the table's own last row, in the table's own columns
      <!-- A `<form>` cannot be a child of `<tbody>`, so the add-row's controls carry
           `form="…"` and the form itself sits beside the table holding nothing but the
           project id. The browser submits form-associated controls from wherever they
           sit, so the row types where it reads. -->
- [x] The performance line appears only when a valuation exists, with its date, basis and
      source on it
      <!-- Verified live: with no valuation there is no line at all, rather than a 0%
           that reads as a measurement. -->
- [x] תנאי העסקה and הגדרת הפרוייקט are behind a toggle, as ניהול קטגוריות is in מאזן
- [x] `/projects` is one line per project, and פרוייקט חדש is behind the same toggle
      <!-- And no total row: the pots are in different currencies and a column of mixed
           money has no sum. That question belongs to מיפוי, which converts at a
           snapshot's own rate and says so. -->
- [x] The rules the current page argues are stated once, in the legend
      <!-- Five of them, in a `<details>` closed by default. Every one was a paragraph
           above a band. -->
- [x] The deployed share reads the same on both screens
      <!-- Whole percent in both. 79% beside 78.6% for one project reads as a
           disagreement rather than as two precisions. -->
