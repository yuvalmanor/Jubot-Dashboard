# Jubot

A private household financial dashboard for two people (Yuval and Eden) who keep separate
bank accounts and credit cards but manage their money as a single unit. It replaces a
Google Sheet that tracked monthly income/expenses, a net-worth snapshot, investment
planning, RSU forecasting, and per-project real-estate holdings.

The UI language is Hebrew. This document records the canonical Hebrew term for each concept
alongside its English identifier, which is what appears in code.

## Language

### People and scope

**Person** (אדם):
One of the two humans in the household. There are exactly two: Yuval and Eden.
_Avoid_: user, account holder, member

**Household** (משק בית / משותף):
The two People treated as one financial unit. Every household-level number is derived from
Person-level data, never entered directly.
_Avoid_: family, couple, joint

### Income and expenses

**Personal Category** (קטגוריה אישית):
A spending or income bucket owned by exactly one Person, using that Person's own naming.
Yuval's `בריאות` and Eden's `רפואה` are two distinct Personal Categories.
_Avoid_: category (ambiguous — always qualify personal vs household)

**Category Type** (סוג קטגוריה):
Either הכנסה or הוצאה, fixed when a Personal Category is created and not varied per month.

**Saving** (חיסכון):
`הכנסות − הוצאות` for a period. It answers one question: how much is available to move into
projects. It is always computed and never entered.
_Avoid_: surplus, balance, net, leftover

**Household Category** (קטגוריה משותפת):
A spending or income bucket at the Household level, defined as the sum of the Personal
Categories assigned to it. It has no amounts of its own.
_Avoid_: shared category, common category, combined category

**Category Assignment** (שיוך קטגוריות):
The rule that routes a Personal Category into a Household Category. Many Personal
Categories may be assigned to one Household Category; a Personal Category is assigned to
at most one Household Category.
_Avoid_: mapping, מיפוי (reserved for the net-worth snapshot — see below)

### Net worth

**Snapshot** (מיפוי):
A complete, dated restatement of every Account — every row current as of the Snapshot date,
taken whenever the household chooses (weekly, monthly, no fixed cadence). It answers "where
is our money and how much of it", not "what are we worth".
_Avoid_: mapping of categories, balance sheet, net worth

**Value Basis** (בסיס השווי):
How an Account's value was arrived at: שווי שוק (an exact market figure), עלות (what was
put in, never re-assessed), or הערכה (someone's judgement). Real estate is held at עלות
because no current valuation exists and none will be sought.
_Avoid_: valuation method, source

**Funding Leg** (רגל מימון):
One source that funded a project, in the currency it was actually paid in — e.g. CGM 1 was
funded by 109,800₪ and by $69,000 of Apple RSU. A project's cost is the sum of its Funding
Legs, so an ILS leg stays at its shekel cost while a USD leg converts at the live rate.
_Avoid_: source, contribution, tranche

**Currency Exposure** (חשיפה למט"ח):
The share of household value denominated in a foreign currency, determined by what each
Account *is*, never by how it was funded. A $104,000 stake is fully exposed even if two
thirds of the money began as shekels.
_Avoid_: FX exposure (English), dollar exposure

**Annual Review** (סיכום שנתי):
A frozen, cross-feature record of where a year ended — the מאזן bottom line, the closing
Snapshot, project positions, RSU position. Unlike a Snapshot it spans every feature, and
unlike the ledger it does not change once written.
_Avoid_: yearly snapshot, archive, year close

**Account** (חשבון):
A single place value is held — a bank account, a money-market fund, a pension, a brokerage
holding, an RSU position, or a stake in a real-estate project. Every Account belongs to a
Person and carries a native currency.
_Avoid_: asset, holding, position

**Entry** (רישום):
One amount for one Personal Category in one calendar month. This is the atomic record of
the מאזן. Months are always real calendar months — the year a figure belongs to is never a
matter of which table it was typed into.
_Avoid_: row, cell, record, line item

### Projects and holdings

**Project** (פרוייקט):
A closed pot of capital with a name and a purpose — CGM 1, CGM 2, Meteor 6. Its Funding
Legs fill it, its Expenses drain it, and `יתרה = legs − expenses`. Expenses are always paid
*out of* the pot, never added to it; putting more money in means adding a Funding Leg.
_Avoid_: investment, deal, asset

**Position** (החזקה):
What an Account is invested in — `1159235 ACWI`, `1209220 FTSE`. Answers "what did we buy".
Positions move with the market and nothing is wrong when they do.
_Avoid_: holding, allocation, asset

**Earmark** (ייעוד):
A claim on money inside an Account — קרן חירום's 120,000₪ of the איילון fund. Answers "what
is this money promised to". Unlike a Position, an Earmark can be *underfunded*, and that is
a meaningful state.
_Avoid_: goal, target, reserve, allocation

### Planning

**Scenario** (תרחיש):
A named what-if held in the לוח תכנון — "CGM 3 in 2027", "a CGM every year for ten years",
"Meteor vs CGM 1". It carries its own targets and assumptions and never touches recorded
data.
_Avoid_: plan, model, forecast

**Funding Plan** (תוכנית מימון):
Inside a Scenario: how much a future investment needs and which sources would cover it.
It is the *before* of a Project's Funding Legs — same shape, future tense. Executing a
Funding Plan is what turns its lines into Funding Legs at real rates.
_Avoid_: allocation, הקצאות (which the household uses for the actual funding record)

**Deal Terms** (תנאי העסקה):
What a project's sponsor stated it would return — target return, hold period, distribution
pattern. Recorded once from the paperwork, entered by hand for now. It is a promise, not a
measurement, and Scenarios may override it.
_Avoid_: return, yield, performance (those imply something measured)

### Equity

**Qualified Shares** (מניות אחרי התקופה, the sheet's `RSU After`):
Vested shares that have also passed סעיף 102's 24-month holding period, so a sale is taxed
at the capital-gains rate (25%).
_Avoid_: after, mature, seasoned

**Unqualified Shares** (מניות לפני התקופה, the sheet's `RSU Before`):
Vested shares still inside the 24-month window, so a sale is taxed as ordinary income
(62.17%). A share becomes Qualified by nothing but the passage of time — which makes
*when* to sell a real decision, not an afterthought.
_Avoid_: before, immature, unvested (unvested is a different thing entirely)

## Relationships

- A **Household** contains exactly two **People**
- A **Personal Category** belongs to exactly one **Person** and has one **Category Type**
- A **Household Category** is the sum of one or more **Personal Categories**, via **Category Assignment**
- Creating a **Personal Category** always creates or joins a **Household Category** — none is ever unassigned
- An **Entry** belongs to exactly one **Personal Category** and one calendar month
- A **Snapshot** captures the balance of every **Account** at one moment in time
- An **Annual Review** freezes one year's unrecomputable facts; its מאזן figures stay live

## Example dialogue

> **Dev:** "Yuval's `בריאות` and Eden's `רפואה` — is that one **Personal Category** with two names?"
> **Domain expert:** "No, two separate **Personal Categories**. Each of us names our own. But at the household level I want one line for health, so both get a **Category Assignment** into the same **Household Category**."
> **Dev:** "So if Eden renames hers, does the **Household Category** change?"
> **Domain expert:** "No. The **Household Category** has its own name. The assignment is what connects them."

## Flagged ambiguities

- **מיפוי** was used for both the net-worth snapshot and category-to-category routing.
  Resolved: מיפוי means **Snapshot** only; category routing is **שיוך קטגוריות**.
- The per-Person columns in the sheet mix "whose expense" with "whose account paid".
  Resolved: a **Personal Category** records spending attributed to that **Person**;
  which Account the money physically left from is a separate concern.
- **EPP** is Apple's employee food benefit, not ESPP (the stock purchase plan). Eden's
  `העברות EPP` and Yuval's `אוכל APPLE` are the same real-world spend under two names —
  the canonical example of two **Personal Categories** sharing one **Household Category**.
- There is no transfer concept. Money moved into savings or projects is not recorded in
  the מאזן at all; it appears as growth in the **Snapshot**.
- CGM 2 is $82,000 converted but not yet invested. Flagged as arguably נזילות; the
  household decided it stays under נדל"ן. Allocation percentages read accordingly.
- The exact share counts behind Qualified/Unqualified need checking against the live
  formula (`RSU_Grants!M50`) — the markdown export loses cell references, and the two
  blocks appear to be priced differently.
