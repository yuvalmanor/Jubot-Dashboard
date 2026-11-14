/**
 * The cutover of ADR 0006, as one fact two producers both read.
 *
 * **The importer owns everything before 2026-10; RiseUp owns 2026-10 and after.**
 * Two producers writing one category-month is the thing that must not happen, so
 * the boundary is stated once, here, and enforced on both sides of it:
 *
 * - [riseup-compare.ts](riseup-compare.ts) refuses to compare — and
 *   [riseup-write.ts](riseup-write.ts) refuses to write — a month before it.
 * - [sheet-importer.ts](sheet-importer.ts)'s `planWrites` refuses to write a
 *   month from it onward, which is what stops the committed export's 2026-10
 *   column landing over a RiseUp figure.
 *
 * It lived in `riseup-compare.ts` until Phase 33 gave the importer the other
 * half: a module that only reads the sheet has no business importing the RiseUp
 * comparison to find out where it must stop.
 *
 * Framework-free per ADR 0004.
 */

import { type CalendarMonth, compareMonths, monthKey } from "@/domain/time/calendar-month";

/**
 * The cutover. RiseUp owns this month and everything after it; the sheet importer
 * owns everything before.
 */
export const RISEUP_AUTHORITY_FROM: CalendarMonth = { year: 2026, month: 10 };

export class RiseUpCutoverError extends Error {
  readonly month: CalendarMonth;

  constructor(month: CalendarMonth) {
    super(
      `${monthKey(month)} is before ${monthKey(RISEUP_AUTHORITY_FROM)}, the month RiseUp becomes ` +
        `the authority for the מאזן's totals (ADR 0006). Everything earlier was recorded from ` +
        `the sheet and is correct, and the sheet importer is the only thing that writes it — so ` +
        `nothing here reads the database for such a month and nothing here will write one. ` +
        `Folding it and printing its totals is allowed and is what just happened above.`,
    );
    this.name = "RiseUpCutoverError";
    this.month = month;
  }
}

/** True when RiseUp is the authority for this month. */
export function isRiseUpAuthority(month: CalendarMonth): boolean {
  return compareMonths(month, RISEUP_AUTHORITY_FROM) >= 0;
}

/** Stops a comparison or a write dead for a month the sheet importer owns. */
export function assertRiseUpAuthority(month: CalendarMonth): void {
  if (!isRiseUpAuthority(month)) throw new RiseUpCutoverError(month);
}

/**
 * Why the sheet importer will not write this month: it is RiseUp's, from the
 * cutover onward. The mirror image of `RiseUpCutoverError`, said from the other
 * side of the same boundary.
 */
export function sheetImporterGaveUp(month: CalendarMonth): string {
  return (
    `${monthKey(month)} is ${monthKey(RISEUP_AUTHORITY_FROM)} or later, which RiseUp is the ` +
    `authority for (ADR 0006). The sheet's column for it is not imported: /riseup-fill reads ` +
    `that month out of RiseUp and a person approves it, and the importer writing the sheet's ` +
    `figure over it would be the second producer the cutover exists to forbid.`
  );
}
