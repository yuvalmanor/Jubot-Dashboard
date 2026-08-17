import { loadCategories } from "@/db/categories";
import { loadLedgerForMonth, saveMonthEntries } from "@/db/ledger";
import { HOUSEHOLD_SCOPE } from "@/domain/ledger/ledger-analytics";
import { monthClosure, planMonthClosure } from "@/domain/ledger/month-closure";
import { type CalendarMonth } from "@/domain/time/calendar-month";

/**
 * Closing a month — the one write behind both offers, so the grid and the month
 * form cannot do the same thing two different ways.
 *
 * It takes **one** `CalendarMonth`. Every path that closes a month goes through
 * here, which is why there is no action anywhere that closes more than one:
 * rewriting years of imported history in a single click is the irreversible mass
 * edit the phase deliberately refuses to build a button for.
 */

/** The ledger is kept in shekels. Explicit, never assumed from context. */
const LEDGER_CURRENCY = "ILS" as const;

/**
 * Write a real zero into each blank that was named on the screen the person
 * accepted, and into nothing else. Answers how many zeros landed.
 *
 * The blanks are recomputed here rather than trusted from the form: a category
 * given a figure between the screen being drawn and the button being pressed is no
 * longer blank, so closing cannot overwrite it. `named` is what keeps the write
 * inside what was actually shown — the recomputation can only ever narrow it.
 *
 * The recomputation is at household level whatever view asked for it. `named`
 * already fixes exactly which categories are in play, and reading both People's
 * makes sure every one of them is seen; a person-level read could miss a named
 * category owned by the other and quietly leave it out.
 */
export async function closeOneMonth(
  month: CalendarMonth,
  named: readonly string[],
): Promise<number> {
  if (named.length === 0) return 0;

  const [categories, ledger] = await Promise.all([loadCategories(), loadLedgerForMonth(month)]);
  const writes = planMonthClosure(
    monthClosure(ledger, categories, HOUSEHOLD_SCOPE, month),
    named,
    LEDGER_CURRENCY,
  );

  await saveMonthEntries(month, writes);
  return writes.length;
}
