# Verdict pass — every section judged against real use

A deliberate stop before any more building. All eight areas of the dashboard were built
from one up-front grilling (`plans/jubot.md`, phases 1–17), written before any of them
could be clicked. Only מאזן ever got a correction pass afterwards
(`plans/maazan-redesign.md`, phases 18–23). This file records Yuval's verdict on each
area, taken with the app running and real-shaped data in it, so that the redesign work
that follows is aimed at stated problems rather than guessed ones.

**Rules of this pass.** The verdict is Yuval's, in his words. No fixes are made while it
runs — a problem found here is written down, not solved. Phase 26 (מעקב תעריפים history)
is frozen until the pass is over.

**Scale.** Each area gets one of:

- **מספק** — good enough to leave alone.
- **פגום** — works, but something specific is wrong with it.
- **שבור** — does not do its job; needs a redesign plan.

## Areas

### מאזן הכנסות-הוצאות — `/balance`

A full year as a grid, monthly entry, closing a month, trends. Already redesigned once in
phases 18–23.

**Verdict:** פגום — see the cross-cutting design verdict below, which Yuval reached
while using this screen. No separate מאזן-specific complaint yet.

### מעקב תעריפים — `/balance` (panel)

The rate breakdown inside מאזן, year against year. Phases 24–25 built; phase 26 frozen.

**Verdict:** פגום.

Yuval: adding a new annual item means pressing **רישום ותיקון של פריטים שנתיים**, and
once that opens there is no way to close it again.

Checked on 2026-11-06. A close control does exist — `סגירת הטפסים`, rendered at
`src/app/balance/rate-watch-panel.tsx:374` — so this is not a missing feature. It is an
affordance failure, and a complete one:

- It is small grey text (`text-sm text-stone-600`) with no underline until hover, sitting
  on the opposite side of a `רישום ותיקון` heading. It reads as a caption, not a control.
  Yuval used the screen and did not see it.
- It sits 1,765px down a 2,973px page, so it is nowhere near the button that opened the
  forms and is usually off-screen when you decide you want out.
- `?rateEdit=1` is sticky: it rides along on *every* other link on מאזן — the view tabs,
  the sort links, `ניהול קטגוריות`, each month's `חסרים`, each cell. So navigating away
  does not shed it either. The one link that drops it is the one he could not find.

The fix is not "add a close button" — there is one. It is that a mode this sticky needs a
control that looks like a way out, next to where the mode was entered.

### מיפוי — `/snapshots`

A complete dated restatement of every Account, with history, comparison and derived
currency tables.

**Verdict:** _pending_

### שווי נטו — `/net-worth`

Trajectory, currency exposure, allocation, change decomposition.

**Verdict:** _pending_

### נכסים ופרוייקטים — `/projects`

Funding legs, expenses, the closed pot and its balance.

**Verdict:** _pending_

### מחשבון RSU — `/rsu`

Position, lots, the 24-month clock, tax under both treatments, lot selection.

**Verdict:** _pending_

### לוח תכנון — `/planning`

Scenarios, the funding gap, allocations, comparison, projections.

**Verdict:** _pending_

### סיכום שנתי — `/annual`

The frozen cross-feature record of where a year ended.

**Verdict:** _pending_

### הגדרות — `/settings`

Household assumptions and targets.

**Verdict:** _pending_

## Cross-cutting

### Design — the whole dashboard

**Verdict:** פגום, everywhere.

Yuval, unprompted and explicitly not only about מאזן: *"העיצוב לא מספיק טוב — יותר מידי
טקסט, מאוד מפוזר. הייתי רוצה עיצוב נקי וחלק."*

Too much text, too scattered; he wants clean and smooth. This is the first verdict of the
pass and it is not a per-section one, which changes the shape of what follows: a section
redesign that only moves figures around will not answer it. The מעקב תעריפים finding above
is the same complaint wearing a bug's clothes — the control he needed was present, and the
density is what hid it.

Open and unanswered, to settle before any redesign work starts: whether "נקי וחלק" is a
visual pass over the existing screens or a reduction in what each screen says at once.

## Ranking

_Filled once every area has a verdict: worst first, one redesign plan at a time, each
gated on Yuval's sign-off before the next begins._
