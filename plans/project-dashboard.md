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

### 1. Where does income go?

A distribution arrives from the sponsor. It is not an expense and it is not a funding leg.
Two readings:

**It refills the pot.** `יתרה = legs − expenses + income`, so returned capital can be spent
again inside the project.

**It leaves the pot.** The money lands in a bank account that מיפוי already counts, and the
project records that it paid out. `יתרה` is untouched.

**Recommended: it leaves.** The pot's invariant is the one thing this feature gets right —
`יתרה = Σlegs − Σexpenses`, derived on every read, impossible to leave torn. Income that
refilled it would make יתרה mean two things at once: capital waiting to be deployed, and
profit already taken. And the cash really is in the bank, where a Snapshot already sees it;
counting it inside the pot as well would double it in שווי נטו.

So income is recorded *against* the project and flows *out* of it. It answers "what has
this returned", never "what is left to spend". If it is wanted in שווי נטו it is already
there, in the account it landed in.

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

### The four bands

Each is a compact table and nothing else. Same columns everywhere: מה, תאריך, כפי ששולם,
שער, בקופה.

1. **רגלי מימון** — what filled it. Unchanged.
2. **הוצאות** — what drained it. Unchanged.
3. **הכנסות** — what it returned. New. Each row carries the account it landed in, which is
   what keeps decision 1 visible on the screen rather than buried in a comment.
4. **עדכוני שווי** — what it is said to be worth. New. Date, figure, basis, source
   document. Nothing sums them: these are statements, not movements. The band reads newest
   first and the head quotes the top row.

### Entry

The add-row *is* the table's last row, as in the מאזן grid: the same columns, in place, so
recording a leg never leaves the legs. One row per band, not a block beneath it.

### The rules

Everything the current page argues — the derived balance, the refused overdraw, the
effective rate not being an average, the cost that does not fall — moves to one legend
above the bands, the way the year grid's legend works. Said once, available, not repeated
at the weight of a figure.

תנאי העסקה and הגדרת הפרוייקט move behind a `?admin=1`-style toggle, as ניהול קטגוריות
already does in מאזן. They are set once a project and read rarely.

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
