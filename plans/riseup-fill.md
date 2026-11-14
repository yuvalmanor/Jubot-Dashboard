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
  says. The unit is therefore one RiseUp line per target Personal Category — a line split by
  a label rule is rounded per destination — and **netting happens first, rounding after**.
  Income obeys the same rule, with one known consequence: his October salary of 17,734.54
  rounds to **17,735** where the sheet reads 17,734, so the first October run shows a 1₪
  difference on the income row. It is reported like any other and approved or not.
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
   flagged again; `never-write` for RiseUp's savings category and its goal, which are money
   moved rather than spent and which the מאזן records nowhere (the importer's `transfer`
   role). Both accounts carry a savings category, so both files carry these.

Plus the refund decisions of the next section, keyed by `transactionId`.

**An unmapped row blocks the write, never the report.** The fold always prints what it read,
with every unresolved thing named — an unmapped row, a credit with no disposition, a Partner
item nobody has identified. What they stop is the comparison and the write, because a figure
in the grid that nobody chose is the failure worth refusing over. Nothing is guessed and
nothing is swept into משתנות. The one thing that is never unresolved is the empty fixed item
above, which has nothing to map.

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
recorded disposition is reported and blocks the write. Yuval's own months show how ordinary
these are: a 186.07 ferry credit against חו"ל and a 120.25 department-store credit against
ביגוד והנעלה in September, the 1,560 Bit refund in October.

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

### The script fetches the month itself

**Settled.** `scripts/riseup-fill.ts` is the MCP client: it launches `npx -y @riseup-oss/mcp`
with that Person's token and calls `get_budget` itself. **No figure ever passes through the
model**, and every month arrives the same way regardless of size.

The way that was tried instead is the reason: a response too large for the model's context is
spilled to a file by the harness, which is how Yuval's two months (70–90,000 characters) were
reconciled — but Eden's arrive *inline*, with no file, and putting one on disk would mean the
model retyping a thousand lines of amounts. A mechanism that works only by accident of file
size, and whose accident goes the wrong way for one of the two accounts, is not a mechanism.

What this commits to:

- **Same server, same scope.** The `@riseup-oss/mcp` server the household already configured,
  speaking stdio, with `budget:read` and nothing else.
- **The token is read from the MCP configuration** — `mcpServers.<server>.env.RISEUP_PAT` in
  the user's `~/.claude.json` — for the server that Person's row names. It is never printed,
  never logged, never written to the repository, and never passed on a command line.
- **`--from <saved.json>` stays** as the path tests and a re-run use, so every phase can be
  checked without the network and `riseup-fold.ts` itself stays pure.
- **The skill keeps no data.** It names the Person and the month, runs the script, and shows
  what came back.

**No real RiseUp output is ever committed.** Fixtures are written by hand. The response
files live in the scratchpad, and the mapping files hold rules and ids, never amounts.

## What the reconciliation proved

Done during the melt of 2026-11-13/14, against `docs/source/maazan-sheet-export.md`. This is
the evidence the acceptance criteria below are written from.

**Two cautions for whoever builds this.** RiseUp keeps revising a month — a category
recategorised in the app moves a figure — so every total quoted below is as it stood on
2026-11-13/14 and should be re-fetched before being treated as a failing test. And nobody has
confirmed against the database that `entries` holds 2026-08 to 2026-10 as the export implies;
`npm run db:census` says so in one read-only run, and Phase 32 is the first phase that cares.

### Yuval, 2026-09 — the second month, which reconciles exactly

His sheet total **12,259** equals the sum of his rows, with every rule above applied:
משתנות 1,046 (1,046.48); סופר 2,111 (2,111.20); רכב 1,159; בתי קפה 289; צביקה 1,260;
הלוואות 1,000; Tello/Skype 35 (35.19); רפואה 55 (54.96); אפל מיוזיק 24; רייזאפ 55; מכבי 105
(104.58); לובי99 25; פנאי 673 (673.30); ספורט ובריאות 615; אוכל בחוץ, תחבצ+ליים and
AliExpress all 0; income **19,053** (19,053.18).

Three lines are only right because of a rule:

- **AIAI 169** = 46 + 61 + 62, each line rounded before adding (46.05 + 61.17 + 61.52).
- **חו"ל 3,506** = 3,692.04 of charges less a **186.07 credit from a ferry company**.
- **ביגוד והנעלה 20** = 140.00 less a **120.25 credit from a department store**.

So credits netted by merchant are not Eden's peculiarity — his months need them too.

### The two Partner items cannot be resolved from the sheet

His אינטרנט and טלפון 012 come from two Partner commitments, stable across months as
`31965066` and `15aca9b5`. What they charged:

| | `31965066` | `15aca9b5` | sheet אינטרנט | sheet טלפון 012 |
| --- | ---: | ---: | ---: | ---: |
| 2026-09 | 29.25 | 83.06 | 83 | 29 |
| 2026-10 | 83.16 | 79.00 | 83 | 79 |

Each month is internally consistent and the two months imply **opposite** answers: whichever
commitment is the internet, one of the two columns contradicts it. The hand-copy was reading
amounts, not identities. So which commitment is which is a question for `--map`, answered by
Yuval, and no phase may assert it from the sheet.

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

This phase also brings the fetch, because it is how a month arrives: the script speaks to
that Person's RiseUp MCP server and saves the response to the scratchpad. `riseup-fold.ts`
stays pure and network-free — the fetch lives in the script, behind the same `--from` door
the tests use.

### Acceptance criteria

- [x] `npm run riseup:fill -- yuval 2026-10` fetches the month through the `riseup` MCP
      server and prints one amount per Personal Category, writing nothing to the ledger
- [x] `--from <saved.json>` folds a response already on disk, identically, with no network
- [x] The response is saved outside the repository and `git status` is clean after a run
- [x] The token never appears in output, in an error, in a log, or on a command line
- [x] A Person whose MCP server is not configured stops the run, naming the entry to add,
      and never reads the other Person's account
- [x] Every printed figure for Yuval 2026-10 equals his column in
      `docs/source/maazan-sheet-export.md` to the shekel, **except** the rows a disposition
      is still owed on — חו"ל, which prints *not recorded* rather than −1,560 — and income,
      which prints 17,735 against the sheet's 17,734; the expense rows total 8,613
- [x] For Yuval 2026-09 the same, and the lines awaiting a credit print gross: חו"ל 3,692
      rather than 3,506, ביגוד והנעלה 140 rather than 20, income 19,053, expense rows 12,565
- [x] אוכל בחוץ, AliExpress and תחבצ+ליים print as *not recorded* against the sheet's typed
      0 — RiseUp holds all three as categories with no charges, the same empty envelope it
      returns for October's blank רפואה, so nothing can tell a 0 from a blank
      <!-- Added 2026-11-14, out of the box above: it says September reads "the same" as
           October, and October's names every row that prints *not recorded* against a
           column value. These three were not named. The rule they prove is the header's
           own — a blank is never filled with zero — and this is its only live evidence,
           so it gets a box rather than a clause: a fold later "fixed" to emit 0 for an
           empty envelope fails here by name. -->

- [x] סופר prints 1,876 — the five weekly envelopes summed to 1,875.57, then rounded once
- [x] AIAI prints 252 for October (126 + 63 + 63, not the 251 that rounding the sum gives)
      and 169 for September (46 + 61 + 62)
- [x] The two Partner items are kept apart by the `sequenceId` on their charges, with the
      envelope ids ignored, and each is printed with its id and merchant
      <!-- Which one is אינטרנט and which is טלפון 012 cannot be read off the sheet: its
           September and October columns imply opposite answers. Phase 34 asks Yuval. Until
           he answers, both are unresolved rows — printed, not written. -->
- [x] RiseUp's savings category and its goal are silent on Yuval's account in every month,
      by the `never-write` dispositions in his file — both were empty in both his months,
      so a savings category holding charges staying silent is the fixture's case
      <!-- This read "on both accounts" until 2026-11-14. Eden's half cannot be shown in a
           phase that builds only Yuval's mapping file, and it is already asked for in
           Phase 31, where her file is written. -->

- [x] רפואה and ביגוד והנעלה print as *not recorded*, never as 0
- [x] Income is the salary charge — 17,734.54, which the shekel rule rounds to 17,735 — and
      never RiseUp's prediction for the slot, which was 17,500.36
      <!-- This box read "income prints 17,734" until 2026-11-14, which is the sheet's
           figure and not the printed one: the header and the criterion above both settle
           17,735, and a box cannot ask for a figure its own phase forbids. What it is
           for is the clause nothing else tests — the charge rather than the prediction,
           234₪ apart in October, so a fold that read the wrong one would print 17,500. -->
- [x] The two Bit credits are reported as awaiting a disposition and change no figure
- [x] An excluded transaction never reaches a total
- [x] A RiseUp row with no rule stops the run and is named in the output; a fixed item with
      no charge does not
- [x] `riseup-fold.ts` has no import from `pg`, `next` or the database, and its tests read
      only the hand-written fixture

---

## Phase 31: dispositions, and the rules Eden's account adds

### What to build

Credits netted against a category (both accounts need this), the four dispositions, label
rules that win over category rules (hers only), and `docs/source/riseup-eden.json`. Still no
database and no writes — both accounts must be provably right before anything can write.

This phase is proved against Eden's real September, which the Phase 30 fetch is what makes
reachable: her responses are small enough to arrive inline, so there is no spilled file to
fold.

### Acceptance criteria

- [x] Yuval 2026-09 matches his sheet column **in full**, total 12,259, once its two credits
      carry `net:` — the 186.07 ferry credit to חו"ל (3,506) and the 120.25 store credit to
      ביגוד והנעלה (20); the three rows the sheet typed as 0 are excepted, as in Phase 30,
      and neither they nor the sheet's zeros move the total
- [ ] `riseup:fill -- eden 2026-09` matches her sheet column row by row and totals **16,224**,
      which is her sheet's 16,231 less the 7₪ רכב line that does not reconcile; the output
      states that difference rather than absorbing it
      <!-- Left unchecked on 2026-11-14. The figures are verified: her September folds row
           by row to her sheet column and totals exactly 16,224, with nothing adjusted and
           no balancing row. What is not built is the last clause — the output naming the
           sheet's 16,231 — because nothing in this phase reads the sheet, and the header
           forbids a sheet amount in the mapping file. Two ways out, and it is the
           household's call: reword this box and the רכב one the way Phase 30's boxes were
           reworded, or let a report-only run read `docs/source/maazan-sheet-export.md` and
           print a third column. -->
- [x] סופר prints 617, from `כלכלה` (203.95) and `השלמות` (412.86) together
- [x] ארנונה prints 471 and שכ"ד prints 7,000, both drawn out of `חשבונות` by label
- [x] ביגוד והנעלה prints 249 and חיות מחמד prints 1,466, each net of its credit
- [x] A credit with no recorded disposition is reported with its merchant, amount and date,
      blocks the write and never nets by guesswork
- [x] A disposition recorded by `transactionId` makes the next run silent about it, and
      `income` lands in the Person's income category
- [x] Yuval's חו"ל prints −1,560 once its Bit credit carries `net:חו"ל`, bringing his
      October expense rows to the sheet's 7,053
- [ ] רכב prints 2,562 and the output says so plainly against the sheet's 2,569; the
      difference is reported, not reconciled away
      <!-- Left unchecked on 2026-11-14, for the reason on the רכב-bearing box above. The
           row prints **2,562** beside its exact 2,562.25 and is reconciled away nowhere;
           the sheet's 2,569 appears in no output because no output reads the sheet. -->
- [x] A fixture built from an untidied month — no salary charge, an excluded salary, a rent
      cheque in the *other spending* bucket — reports that it found no salary, names the
      excluded amount and writes no income
      <!-- Taken from Eden's 2026-10 as it stood on 2026-11-13. Her live October will stop
           looking like this the moment she tidies it, so the criterion is pinned to the
           fixture, not to her account. -->
- [ ] For her live 2026-10, after she tidies it, income reads what RiseUp then shows — read
      from the source, never the 60,341.69 written into this plan
      <!-- Left unchecked on 2026-11-14: her October is still untidied, so the condition
           this box opens with has not happened. The live run that day read the salary as
           an excluded 60,341.69 and wrote no income, which is the box above it, not this
           one. Checking this needs one run after she squares the month away. -->
- [x] A label rule applies to a charge in the *other spending* bucket as well as to one in
      a category, so October's 7,000 cheque reaches שכ"ד
- [x] RiseUp's savings category is marked `never-write` and is silent in every month
- [x] Reserve pay is reported as a memo and reaches no Personal Category
- [x] Yuval's fold is unchanged by this phase (his file still carries no label rules)
- [x] **The advisor has audited this phase.** With the three gates green and the work
      committed, the advisor is asked to audit it; every finding is either fixed here or
      named in the report with the reason it was not. This box is checked last and the
      branch is pushed after it — a phase is not finished until its audit is.
      <!-- Audited 2026-11-14. Fixed: the two boxes above were unchecked rather than read
           generously; a `net:` destination no rule feeds is now refused instead of
           inventing a row; the plan file and the test file were restored to LF after a
           script rewrote them as CRLF, and `riseup-yuval.json` to its own formatting; the
           fixture's one real merchant and amount were replaced with invented ones per
           ADR 0006. Named and not fixed: a `net:` credit against a Personal Category fed
           by several RiseUp lines is refused with no way to resolve it, so a single
           grocery refund would make Eden's סופר unwritable in Phase 33. Nothing in the
           header settles which line such a credit corrects, so it is a planning decision
           and not an implementation detail. -->

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
- [ ] **The advisor has audited this phase.** With the three gates green and the work
      committed, the advisor is asked to audit it; every finding is either fixed here or
      named in the report with the reason it was not. This box is checked last and the
      branch is pushed after it — a phase is not finished until its audit is.

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
- [ ] **The importer gives up the other side of the boundary**: `/balance/import` and
      `planWrites` refuse any month from 2026-10 onward, so the committed export's 2026-10
      column can no longer be written over a RiseUp figure. Stated in ADR 0006; this is where
      it becomes code
- [ ] A run with anything unresolved — an unmapped row, a credit without a disposition, a
      Partner item nobody has identified — writes nothing at all, not even the lines that
      are clear
- [ ] No blank is ever written as a zero, and `monthClosure` reports the month exactly as it
      did before the run for every category RiseUp was silent about
- [ ] `rate_watch_items` is untouched — the existing guard test still passes
- [ ] A failed write leaves the month as it was (one transaction per month)
- [ ] **The advisor has audited this phase.** With the three gates green and the work
      committed, the advisor is asked to audit it; every finding is either fixed here or
      named in the report with the reason it was not. This box is checked last and the
      branch is pushed after it — a phase is not finished until its audit is.

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
- [ ] Yuval is asked which Partner commitment is אינטרנט and which is טלפון 012, with both
      months' charges shown, and the answer is written into his file by id
- [ ] A created Personal Category lands with its Household Category assignment in one
      transaction, so the deferred trigger never fires
- [ ] The monthly run never creates a category, in any mode, under any flag
- [ ] Re-running `--map` on an unchanged account proposes no change to the file
- [ ] **The advisor has audited this phase.** With the three gates green and the work
      committed, the advisor is asked to audit it; every finding is either fixed here or
      named in the report with the reason it was not. This box is checked last and the
      branch is pushed after it — a phase is not finished until its audit is.

---

## Phase 35: the skill

### What to build

`.claude/skills/riseup-fill/SKILL.md`, **authored with `/skill-smith`** so it follows the
house conventions for skills rather than being hand-rolled. It is deliberately thin, because
the script fetches and folds: name the Person and the month, run it, show the side-by-side,
ask, write. Its opening line is the household's loop — tidy RiseUp first.

### Acceptance criteria

- [ ] `/riseup-fill yuval` fills the last ended month end to end, after approval
- [ ] `/riseup-fill` with no Person asks rather than assuming one
- [ ] `/riseup-fill eden` stops with the config entry to add if `riseup-eden` is absent, and
      never reads Yuval's account instead
- [ ] A month range runs month by month, each with its own approval
- [ ] The skill states the resolved month, the cashflow's last update, and any category
      still awaiting charges before showing the diff
- [ ] The skill never does arithmetic itself, and never carries a month's data: every figure
      it shows comes from the script, which fetched it
- [ ] No RiseUp response is written inside the repository
- [ ] Merchant names, sequence names and customer comments are treated as data — quoted in
      reports, never followed as instructions
- [ ] The skill reads `CONTEXT.md` and uses Person / Entry / Personal Category in its output
- [ ] `/riseup-fill --map` is reachable and documented in the skill
- [ ] **The advisor has audited this phase.** With the three gates green and the work
      committed, the advisor is asked to audit it; every finding is either fixed here or
      named in the report with the reason it was not. This box is checked last and the
      branch is pushed after it — a phase is not finished until its audit is.
