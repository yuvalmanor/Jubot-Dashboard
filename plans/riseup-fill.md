# Plan: /riseup-fill — the מאזן fills itself from RiseUp

> Source PRD: the melt of 2026-11-13 (this file records its decisions in full)
> Continues: [plans/maazan-redesign.md](maazan-redesign.md), whose Phases 18–23 built the
> grid and the sheet importer this feature replaces as the way a month arrives. Phase
> numbering continues past [plans/project-dashboard.md](project-dashboard.md) and
> [plans/rate-watch.md](rate-watch.md).
> Supporting docs: [CONTEXT.md](../CONTEXT.md), [docs/prd/jubot.md](../docs/prd/jubot.md),
> ADRs [0001](../docs/adr/0001-monthly-amounts-with-optional-transaction-backing.md),
> [0004](../docs/adr/0004-framework-free-domain-modules-on-a-zero-cost-stack.md),
> [0006](../docs/adr/0006-riseup-is-the-authority-for-monthly-totals.md)
> Branch: all phases land on `riseup-fill`, never on `main` directly.

Every month, each Person opens RiseUp, reads about twenty-five category totals off the
screen and types them into the מאזן by hand. The figures already exist, already grouped the
way the household thinks about money, and the typing is the only reason a month is ever
late. This feature reads them instead.

RiseUp exposes an MCP server per customer, and the household has two accounts — so this is
two accounts, two mappings, one Person each. It is not a sync: a run proposes a month, the
household approves it, and only then does anything reach `entries`.

## The household's loop

**Tidy the month in RiseUp → run `/riseup-fill <person>` → approve the side-by-side.**

This order is the feature's one precondition and the skill states it first. Eden's October
2026 is the worked example of why: her salary that month sits in RiseUp as an *excluded*
transaction of 60,341.69 (salary plus a bonus) and the regular salary slot for the month is
empty, because she has not squared the month away yet. A run before tidying would find no
income at all. The skill's refusals are therefore not failures — they are the thing telling
the household that RiseUp is not ready.

## Architectural decisions

Settled during the melt. Not to be re-litigated per phase.

### What is written, and from when

- **The unit is an Entry**: one amount, one Personal Category, one calendar month, written
  with `saveMonthEntries` in [src/db/ledger.ts](../src/db/ledger.ts). No second way into
  `entries`, no new SQL, no transactions table — ADR 0006 settles what ADR 0001 left open.
- **Amounts are rounded to whole shekels, and *where* the rounding happens is a rule.**
  Round **each RiseUp category and each fixed item** to the shekel, then add those rounded
  figures into the Personal Category. This is what the hand-copy did, because it copied what
  the RiseUp app displays — and the app displays each line already rounded. The evidence is
  Yuval's AIAI: 125.74 + 62.74 + 62.83 reads **252** in the sheet (126 + 63 + 63), where
  rounding the sum would give 251. His weekly `כלכלה` envelopes are one category in the app,
  so they are summed first and rounded once: 1,875.57 → **1,876**, which is what the sheet
  says. Netting a credit happens inside its category, before that rounding.
- **RiseUp is the authority from 2026-10 inclusive.** August and September 2026 and
  everything before them stay as the sheet recorded them, and
  [the importer](../src/domain/import/sheet-importer.ts) remains the only thing that writes
  them. The guard therefore sits on **the database comparison and the write**, not on
  folding: a report-only run over a saved response may fold any month, which is how Eden's
  2026-09 — her only month that both RiseUp and the sheet hold — is used as proof.
- **A month is never closed and a blank is never filled with zero.** A category RiseUp says
  nothing about keeps its blank. Closing stays the deliberate act in `/balance` that
  [month-closure.ts](../src/domain/ledger/month-closure.ts) describes, because only a
  person knows whether a blank means *nothing happened* or *not checked yet*.
- **Nothing writes without approval.** Every run prints a side-by-side — category, what
  Jubot holds, what RiseUp says, the difference — and writes only the lines the household
  confirms. A re-run of a month that already agrees writes nothing at all.
- **`rate_watch_items` is never touched.** מעקב תעריפים is the breakdown of money the מאזן
  already counts; this feature writes the מאזן and nothing else.

### One Person, one account

| Person | MCP server | Customer |
| --- | --- | --- |
| `yuval` | `riseup` | 127140 |
| `eden` | `riseup-eden` | 267458 |

The token lives in the server, so "per Person" resolves to a *server*, not a parameter. If
the server for the requested Person is not configured, the run stops and names the entry to
add. It never falls back to the other account: Yuval's spending written into Eden's
categories would look entirely plausible and be entirely wrong.

### The mapping file

One committed file per Person, `docs/source/riseup-<person>.json`, holding four kinds of
rule. In the repo rather than the database: no schema change, it shows up in `git diff` when
a subscription changes, and a person can read it.

1. **Category rules.** A RiseUp tracked category (by name) → a Personal Category. Several
   RiseUp categories may feed one Personal Category — Eden's סופר is `כלכלה` + `השלמות`.
2. **Fixed-item rules.** A RiseUp fixed item has **no name at all**. It is keyed by the
   `sequenceId` **on its charge** — stable across months (Eden's loan is
   `f1315922…` in both September and October) — with the merchant kept beside it as a human
   label. Not by the envelope's own id, which changes every month. And not by the merchant,
   which will not do: Yuval's October held two envelopes both reading
   `חברת פרטנר תקשורת בע`, one 83₪ and one 79₪, which are his אינטרנט and his טלפון 012,
   told apart only by `sequenceId`.
   A consequence: a fixed item with **no** charge this month carries no `sequenceId` and
   cannot be identified at all. It is therefore blank by definition and never an unmapped
   row.
3. **Label rules, which win over category rules.** Every charge carries RiseUp's own label,
   and for Eden those labels are exactly her row names. `שיק`→שכ"ד, `ארנונה`→ארנונה,
   `מים`→מים, `חשמל`→חשמל, `גז`→גז. This is what splits her one `חשבונות` category across
   five rows of her grid, and what rescues the 7,000 rent cheque and the 495 gas bill that
   landed in her *other spending* bucket in October instead. Yuval's file carries none.
4. **Row dispositions.** `hand-typed` for a row with no RiseUp source, so it is never
   flagged again; `never-write` for RiseUp's savings category, which is money moved rather
   than spent and which the מאזן records nowhere (the importer's `transfer` role).

Plus the refund decisions of the next section, keyed by `transactionId`.

**An unmapped row stops the run.** Nothing is guessed, and nothing is swept into משתנות: a
wrong-but-plausible figure in the grid is worse than a run that refuses. The one exemption is
the empty fixed item above, which has nothing to map.

### Reading a month out of RiseUp

Six rules, every one of them proved against a month the household had already copied by
hand (see *What the reconciliation proved*):

- **Ignore everything RiseUp marks excluded.** None of it reached the sheet in any month
  checked — 11,000₪ across six transactions in Yuval's October alone.
- **Use what was actually charged, never the predicted amount.**
- **A fixed item with no charge that month is blank**, not its prediction and not zero.
- **Weekly envelopes are summed into one month**, which is how `כלכלה` becomes סופר.
- **The *other spending* bucket becomes משתנות**, unless a label rule claims a charge.
- **Income is the salary charge, written to that Person's single income category.** If no
  salary charge is found, the run writes **no income** and says what it did see, including
  an excluded salary. It never substitutes RiseUp's predicted salary. A payment the
  household says *is* income — Eden's October salary-plus-bonus of 60,341.69 may well land
  outside the salary slot even after she tidies the month, since the slot predicted
  23,805.34 — is recorded with the `income` disposition below rather than left unwritable.

### Money coming in that is not salary

Refunds and transfers in are real and small in number, and the household treats them three
different ways — so the run surfaces each one and records the answer by `transactionId` in
the mapping file, which makes a re-run silent and leaves the reason on the record:

- **Netted against a category**, which is what the sheet already does: Eden's September
  ביגוד והנעלה reads 249 = 409.30 of charges − a 160.64 credit from the same clothes shop,
  and her חיות מחמד reads 1,466 = 1,505.60 − a 39.90 pet-shop credit. Yuval's October
  חו"ל reads −1,560, a Bit transfer reimbursing a trip expense.
- **Counted as income**, into that Person's income category — the disposition for a salary
  that arrives outside the salary slot, or any other real earning.
- **Ignored**, like the 375₪ Bit transfer in Yuval's October, which reached nothing.
- **A memo, written nowhere**: `מילואים` sits beside the sheet's totals, has no Personal
  Category at all, and reserve pay must not reach one.

So a disposition is one of `net:<category>`, `income`, `ignore`, `memo`. An amount in with no
recorded disposition stops the run.

### The command

```
/riseup-fill yuval            # the last ended month, resolved by RiseUp itself
/riseup-fill eden 2026-10
/riseup-fill yuval 2026-10..2026-11
/riseup-fill eden --map       # propose the mapping file
```

The default month is RiseUp's own `"previous"`, not a month computed here, because a RiseUp
cashflow month need not start on the 1st; the run prints which month that resolved to before
anything else. Each category states the date RiseUp stops waiting for its charges: when any
is still waiting, the run names them and proceeds on the household's say-so rather than
refusing.

### Where the arithmetic lives

One month of `get_budget` is ~70,000 characters, and adding up ninety charges by eye is how
a wrong figure gets into the grid. So the model never does the sums:

- **[src/domain/import/riseup-fold.ts](../src/domain/import/riseup-fold.ts)** — pure,
  framework-free per ADR 0004, tested against a small hand-written fixture. A RiseUp month
  and a mapping file in, one amount per Personal Category out, with every rule above in it.
- **[scripts/riseup-fill.ts](../scripts/riseup-fill.ts)** — the shell around it: read the
  saved JSON, apply the mapping, compare against `DATABASE_URL`, print. Reports by default,
  `--write` writes. Exactly the posture of `scripts/sheet-refresh.ts`.
- **The skill is the plumbing**: it gets a month's response onto disk, hands the path to the
  script, shows the result and asks.

**Open, to settle before Phase 35 (it does not block Phases 30–34, which all read a saved
file):** how the response reaches the disk. Yuval's month is ~70,000 characters and the
harness spills it to a file whose path is in the error, which is usable as-is. Eden's two
months arrived *inline*, and writing those to the scratchpad means the model retyping a
thousand lines of amounts — slow and exactly the kind of transcription this feature exists to
abolish. The alternative is for `scripts/riseup-fill.ts` to be the MCP client itself: launch
`npx -y @riseup-oss/mcp` with that Person's token and call `get_budget` directly, so nothing
passes through the model at all. Same server, same read-only scope; it does mean the script
reads the token out of the MCP configuration.

**No real RiseUp output is ever committed.** Fixtures are written by hand. The response
files live in the scratchpad, and the mapping files hold rules and ids, never amounts.

## What the reconciliation proved

Done during the melt, against `docs/source/maazan-sheet-export.md`. This is the evidence the
acceptance criteria below are written from.

### Yuval, 2026-10 — identity at category level

Every row matched to the shekel, and his sheet total 7,053 equals the sum of the rows:
משתנות 1,846 = the bucket (1,846.31); סופר 1,876 = five weekly `כלכלה` envelopes
(1,875.57, rounded once); רכב 421 (420.73);
אוכל בחוץ 75; בתי קפה 413; תחבצ+ליים 80 = `תחבורה ציבורית` (79.70); AliExpress 6 (6.25);
הלוואות 1,000; צביקה 1,260; Tello/Skype 36 (35.85); אפל מיוזיק 24; רייזאפ 55; מכבי 105
(105.28); לובי99 25; פנאי 362; ספורט ובריאות 615; אינטרנט 83 (83.16); טלפון 012 79.
**AIAI 252** is `AIAI` (125.74 → 126) plus two AI subscriptions RiseUp keeps as separate
fixed items (62.74 → 63, 62.83 → 63) — the case that fixes where rounding happens.
**חו"ל −1,560** is the Bit refund, so it is the one row that needs a disposition: the fold
alone leaves חו"ל blank and the expense rows total **8,613**, and the refund decision is what
turns that into the sheet's 7,053. **Income 17,734** is the salary charge alone (17,734.54); a
second Bit transfer of 375 reached nothing. רפואה and ביגוד והנעלה were blank, not zero.

### Eden, 2026-09 — the same, once three more rules exist

Her sheet total 16,231 equals the sum of her rows: משתנות 753 = the bucket (753.02);
**סופר 617 = `כלכלה` 203.95 + `השלמות` 412.86**; בתי קפה 183 = `אוכל בחוץ - קפה` (182.90);
אוכל בחוץ blank = `בילויים` 0 + `וולט` 0; רכב 2,569 against my 2,562.25 (**7₪
unexplained** — a late charge or a copy slip; the one line that did not reconcile);
**חיות מחמד 1,466** and **ביגוד והנעלה 249**, both net of a credit from the same merchant;
**ארנונה 471 and שכ"ד 7,000 both out of her one `חשבונות` category**; חו"ל 1,029; הלווואות
1,000; רייזאפ 55; העברות EPP 749; כושר 90. Income 20,315 is her salary charge. מילואים
1,250 is the memo row.

### Eden, 2026-10 — what an untidied month looks like

Her October column in the sheet is **empty**; September is her last recorded month. In
RiseUp the salary is excluded (60,341.69) and the salary slot empty, the *other spending*
bucket holds the 7,000 cheque and a 495 gas bill, and `רפואי ופארם` is a live RiseUp
category with no row in her 2026 grid.

### Each Person's grid holds rows the other one actually pays

What the 2026 tab shows: Yuval's שכ"ד and מים are blank every month, and Eden's חשבונות
covers מים, חשמל, גז and ארנונה while her שכ"ד carries the 7,000 cheque. On her side,
אינטרנט, Tello/Skype and אוכל APPLE are blank, and those are live on his.

This is read off the export, **not confirmed against the database**, which is the authority
on which Personal Categories are still active (the census counts one retired category on
each side). `--map` in Phase 34 is what establishes it per Person; until then these are
candidates for `hand-typed`, not facts. `הפקדות לחיסכון` is different and is settled:
transfers are recorded nowhere, so it is `never-write` on both sides. Retiring a dead row is
category administration in `/balance`, which this feature reports on and never performs.

---

## Phase 30: a month folded into totals

### What to build

The tracer bullet: `riseup-fold.ts`, a hand-written fixture, `scripts/riseup-fill.ts`
reporting only, and `docs/source/riseup-yuval.json` written from the reconciliation above.
Category rules, fixed-item rules by `sequenceId`, the weekly sum, the bucket, excluded
ignored, a no-charge fixed item left blank, income from the salary charge. No label rules,
no refunds, no database, no writes.

Nothing in this phase may read the network: the script takes a path to a saved response.

### Acceptance criteria

- [ ] `npm run riseup:fill -- yuval 2026-10 --from <saved.json>` prints one amount per
      Personal Category and writes nothing
- [ ] Every printed figure for Yuval 2026-10 equals his column in
      `docs/source/maazan-sheet-export.md` to the shekel, **except חו"ל**, which prints as
      *not recorded* because its refund has no disposition yet; the expense rows total 8,613
- [ ] סופר prints 1,876 — the five weekly envelopes summed to 1,875.57, then rounded once
- [ ] AIAI prints 252 — 126 + 63 + 63, each RiseUp line rounded before being added, and
      explicitly not the 251 that rounding the sum would give
- [ ] אינטרנט prints 83 and טלפון 012 prints 79, told apart by the `sequenceId` on their
      charges, with the envelope ids ignored
- [ ] רפואה and ביגוד והנעלה print as *not recorded*, never as 0
- [ ] Income prints 17,734 from the salary charge; the predicted salary is never used
- [ ] The two Bit credits are reported as awaiting a disposition and change no figure
- [ ] An excluded transaction never reaches a total
- [ ] A RiseUp row with no rule stops the run and is named in the output; a fixed item with
      no charge does not
- [ ] `riseup-fold.ts` has no import from `pg`, `next` or the database, and its tests read
      only the hand-written fixture

---

## Phase 31: Eden's shape — label rules and refunds

### What to build

The three rules her account needs and his does not: label rules that win over category
rules, credits netted against a category, and `docs/source/riseup-eden.json`. Still no
database and no writes — both accounts must be provably right before anything can write.

### Acceptance criteria

- [ ] `riseup:fill -- eden 2026-09 --from <saved.json>` matches her sheet column row by
      row, and the printed total is 16,231
- [ ] סופר prints 617, from `כלכלה` and `השלמות` together
- [ ] ארנונה prints 471 and שכ"ד prints 7,000, both drawn out of `חשבונות` by label
- [ ] ביגוד והנעלה prints 249 and חיות מחמד prints 1,466, each net of its credit
- [ ] A credit with no recorded disposition stops the run and is reported with its merchant,
      amount and date — never netted by guesswork
- [ ] A disposition recorded by `transactionId` makes the next run silent about it, and
      `income` lands in the Person's income category
- [ ] Yuval's חו"ל prints −1,560 once its Bit credit carries `net:חו"ל`, bringing his
      October expense rows to the sheet's 7,053
- [ ] רכב prints 2,562 and the output says so plainly against the sheet's 2,569; the
      difference is reported, not reconciled away
- [ ] A fixture built from an untidied month — no salary charge, an excluded salary, a rent
      cheque in the *other spending* bucket — reports that it found no salary, names the
      excluded amount and writes no income
      <!-- Taken from Eden's 2026-10 as it stood on 2026-11-13. Her live October will stop
           looking like this the moment she tidies it, so the criterion is pinned to the
           fixture, not to her account. -->
- [ ] For her live 2026-10, after she tidies it, income reads what RiseUp then shows — read
      from the source, never the 60,341.69 written into this plan
- [ ] A label rule applies to a charge in the *other spending* bucket as well as to one in
      a category, so October's 7,000 cheque reaches שכ"ד
- [ ] RiseUp's savings category is marked `never-write` and is silent in every month
- [ ] Reserve pay is reported as a memo and reaches no Personal Category
- [ ] Yuval's fold is unchanged by this phase (his file still carries no label rules)

---

## Phase 32: what the database already holds

### What to build

The side-by-side. Read `entries` for the month, line up Jubot against RiseUp per Personal
Category, print category / Jubot / RiseUp / difference. Still `--write`-less.

### Acceptance criteria

- [ ] The report shows one line per Personal Category with both figures and the difference
- [ ] A month already matching shows an empty diff and says so in one line
- [ ] A row Jubot holds and RiseUp says nothing about is shown as *left alone*, never as a
      proposed zero
- [ ] A row RiseUp has and Jubot never recorded is shown as *new*
- [ ] Yuval 2026-10 against the live database shows **no difference at all** on the rows the
      melt reconciled — the rounding rule of Phase 30 is what makes סופר agree rather than
      differ by a shekel — so anything that does differ is a charge that landed after the
      sheet was copied, and is named
- [ ] The report states which month RiseUp resolved, when its cashflow was last updated,
      and every category still awaiting charges, by name
- [ ] A month before 2026-10 is refused here, where the database is involved, naming the
      cutover; folding such a month report-only stays allowed
- [ ] No `update` or `insert` statement exists anywhere in the script yet

---

## Phase 33: the write

### What to build

`--write`, taking the approved lines only, through `saveMonthEntries`. The 2026-10 guard
enforced at the write as well as at the read, and a month-range run that writes one month at
a time.

### Acceptance criteria

- [ ] `--write` without an explicit confirmation of the lines writes nothing
- [ ] Approved lines land in `entries` as whole shekels, and the grid at `/balance` shows
      them
- [ ] A line the household declines is not written, and the run says what it skipped
- [ ] Re-running the same month after a write reports an empty diff and writes nothing
- [ ] No month before 2026-10 can be written, by any flag combination
- [ ] No blank is ever written as a zero, and `monthClosure` reports the month exactly as it
      did before the run for every category RiseUp was silent about
- [ ] `rate_watch_items` is untouched — the existing guard test still passes
- [ ] A failed write leaves the month as it was (one transaction per month)

---

## Phase 34: `--map`, and the mapping file's birth

### What to build

The proposal mode. Read one month plus that Person's active Personal Categories from the
database, and sort every RiseUp row into four piles: exact name matches, near-matches with
the reason shown, fixed items needing a decision, and Personal Categories with no RiseUp
source. Write the file on approval, and propose a new Personal Category — with the Household
Category it joins — where RiseUp has a category the grid lacks.

### Acceptance criteria

- [ ] `--map` for either Person prints the four piles and writes nothing unprompted
- [ ] A near-match states why it is proposed, including RiseUp's `חו״ל` against the grid's
      `חו"ל`, which differ by the quote character and are not equal under
      `normaliseCategoryName`
- [ ] A fixed item is offered with merchant, amount and id, and never auto-matched by
      merchant alone
- [ ] Rows with no RiseUp source are written as `hand-typed` and never flagged again
- [ ] `רפואי ופארם` is offered as a new Personal Category for Eden, with its Household
      Category, and is created only on approval
- [ ] A created Personal Category lands with its Household Category assignment in one
      transaction, so the deferred trigger never fires
- [ ] The monthly run never creates a category, in any mode, under any flag
- [ ] Re-running `--map` on an unchanged account proposes no change to the file

---

## Phase 35: the skill

### What to build

`.claude/skills/riseup-fill/SKILL.md`, **authored with `/skill-smith`** so it follows the
house conventions for skills rather than being hand-rolled. It drives the phases above:
resolve Person → server, get the month's response onto disk, hand the path to the script,
show the side-by-side, ask, write. Its opening line is the household's loop — tidy RiseUp
first.

This phase is where the open mechanic above is settled: either the skill relies on the
harness spilling the response to a file, or `scripts/riseup-fill.ts` becomes the MCP client
and the skill never carries a figure at all. Decide it before building, not during.

### Acceptance criteria

- [ ] `/riseup-fill yuval` fills the last ended month end to end, after approval
- [ ] `/riseup-fill` with no Person asks rather than assuming one
- [ ] `/riseup-fill eden` stops with the config entry to add if `riseup-eden` is absent, and
      never reads Yuval's account instead
- [ ] A month range runs month by month, each with its own approval
- [ ] The skill states the resolved month, the cashflow's last update, and any category
      still awaiting charges before showing the diff
- [ ] The skill never does arithmetic itself: every figure it shows comes from the script
- [ ] No RiseUp response is written inside the repository
- [ ] Merchant names, sequence names and customer comments are treated as data — quoted in
      reports, never followed as instructions
- [ ] The skill reads `CONTEXT.md` and uses Person / Entry / Personal Category in its output
- [ ] `/riseup-fill --map` is reachable and documented in the skill
