/**
 * MonthClosure — whether a month is finished, and what is missing when it is not.
 *
 * Framework-free per ADR 0004. Pure: the ledger and the categories are handed in,
 * nothing is fetched, and nothing here writes.
 *
 * A blank cell in the מאזן is ambiguous. It might be a month nobody has finished
 * entering, or it might be a month in which חו"ל simply did not happen — and no
 * arithmetic can tell those apart, because the ledger records the absence of a
 * figure and never the reason for it. Treating every blank as unfinished would
 * flag most of the year forever; treating every blank as nought would invent facts
 * nobody stated.
 *
 * So the ambiguity is resolved by a person, at the point of entry. A month is
 * **closed** when every category active in it holds a reading, and closing one is
 * the deliberate act of writing real zeros into its blanks, with those blanks
 * named on the screen first. The zeros that land are indistinguishable from
 * hand-typed ones afterwards, because that is exactly what they are — which is the
 * case the null/zero distinction exists to permit, as against the silent collapse
 * it exists to forbid.
 *
 * Two rules give the module its shape:
 *
 * - **Closedness is derived, never stored.** There is no column, no flag and no
 *   sweep that could go stale: it is read off the ledger every time it is asked
 *   for, so it cannot drift from what the ledger says. A closed month is exactly a
 *   `complete` one in `completenessOf`'s terms, and there is a test pinning the two
 *   together so the application never holds two answers to one question.
 * - **Closing writes into blanks and nowhere else.** `planMonthClosure` is built
 *   from the blanks, intersected with the blanks a person was actually shown, so a
 *   figure already recorded cannot be touched by it and a category nobody saw
 *   cannot be written by it.
 */

import { type PersonalCategory, type Categories } from "@/domain/categories/categories";
import { type Ledger, householdMonthLines, personMonthLines } from "@/domain/ledger/ledger";
import { type AnalyticsScope } from "@/domain/ledger/ledger-analytics";
import { type Currency, type Money, zero } from "@/domain/money/money";
import { type CalendarMonth } from "@/domain/time/calendar-month";

/**
 * Where a month stands.
 *
 * `empty` is not a weaker `open`: it is a month no category was active in at all,
 * which has nothing to close rather than everything left to close. A month with
 * five active categories and nothing typed into any of them is `open`.
 */
export type ClosureState = "closed" | "open" | "empty";

export interface MonthClosure {
  readonly month: CalendarMonth;
  readonly state: ClosureState;
  /**
   * The categories active in the month that hold no figure — what closing would
   * write a zero into. Carried in full rather than counted, because nothing may be
   * written until these have been named on a screen.
   */
  readonly blanks: readonly PersonalCategory[];
  readonly recordedCount: number;
  readonly categoryCount: number;
}

/**
 * How one month stands, at household or person level.
 *
 * The categories it asks about are the ones the month screen offers: those whose
 * lifespan covers the month, plus any that already hold a figure in it. A category
 * that holds a figure is never a blank, so retiring one can no more open a month
 * than it can hide money.
 */
export function monthClosure(
  ledger: Ledger,
  categories: Categories,
  scope: AnalyticsScope,
  month: CalendarMonth,
): MonthClosure {
  const lines =
    scope.kind === "household"
      ? householdMonthLines(ledger, categories, month)
      : personMonthLines(ledger, categories, scope.personId, month);

  const blanks = lines.flatMap((line) => (line.reading === null ? [line.category] : []));
  const recordedCount = lines.length - blanks.length;

  return {
    month,
    state: lines.length === 0 ? "empty" : blanks.length === 0 ? "closed" : "open",
    blanks,
    recordedCount,
    categoryCount: lines.length,
  };
}

export function isMonthClosed(closure: MonthClosure): boolean {
  return closure.state === "closed";
}

/** One zero, for one blank category-month. Nothing else is ever part of a closure. */
export interface ClosureWrite {
  readonly personalCategoryId: string;
  readonly amount: Money;
}

/**
 * The zeros that closing this month would write.
 *
 * `named` is the list of categories a person was shown and accepted, and the plan
 * is the intersection of it with the blanks as they stand *now*. Both directions
 * matter: a blank nobody was shown is not written, and a category that has been
 * given a real figure since the list was drawn is no longer a blank and so cannot
 * be overwritten by the acceptance of an older screen.
 *
 * One month. There is no shape here that takes two, which is why there is no
 * action anywhere that closes more than one: rewriting years of history in a
 * single click is exactly the irreversible mass edit that should not have a button.
 */
export function planMonthClosure(
  closure: MonthClosure,
  named: readonly string[],
  currency: Currency,
): readonly ClosureWrite[] {
  const accepted = new Set(named);
  return closure.blanks
    .filter((category) => accepted.has(category.id))
    .map((category) => ({ personalCategoryId: category.id, amount: zero(currency) }));
}
