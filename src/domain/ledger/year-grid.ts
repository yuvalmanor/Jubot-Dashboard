/**
 * YearGrid — the מאזן as a year: categories down, months across.
 *
 * Framework-free per ADR 0004. Pure: the ledger is handed in, nothing is
 * fetched, and the clock is a parameter.
 *
 * This is the shape the spreadsheet had, and the shape the household reads in —
 * down a column for a month, across a row for a category. What it does not
 * inherit from the spreadsheet is where its numbers come from. Nothing here is
 * stored: every cell is read off the ledger, every household figure is the sum of
 * the personal ones underneath it, and חיסכון is הכנסות − הוצאות with nowhere to
 * write it.
 *
 * Three rules decide what a reader sees:
 *
 * - **A blank is not a zero.** A cell whose month was never recorded is `null`,
 *   and the screen must not print it as a figure. A month recorded as zero is a
 *   fact about that month and prints as one.
 * - **Both aggregate columns stop at the same boundary.** סכום שנתי totals exactly
 *   the months ממוצע חודשי divides by — one list, carried on the `Average` itself,
 *   so no caller can total one span and divide by another. Those months are the
 *   year's closed ones intersected with the ledger's span, per Phase 18: the month
 *   being lived shows its figures in its own column and feeds neither aggregate.
 * - **A row appears when the year has something to say about it.** A lifespan
 *   overlapping the year puts an all-blank row on the screen, because a hole is
 *   what the household is looking for; and a recorded figure puts a row on the
 *   screen whatever the lifespan since became, because retiring a category can
 *   never hide money that was written down.
 */

import { type CategoryType, type Categories, isActiveIn, isRetired } from "@/domain/categories/categories";
import {
  type AnalyticsScope,
  type Average,
  type CategoryGroup,
  averageOf,
  averageOverMonths,
  categoryGroups,
  denominatorMonths,
  identifyGroup,
  readGroupMonth,
  yearPeriod,
} from "@/domain/ledger/ledger-analytics";
import { type Ledger, isRecorded, recordedSpan } from "@/domain/ledger/ledger";
import { type Currency, type Money, subtract, sum, zero } from "@/domain/money/money";
import {
  type CalendarMonth,
  calendarMonth,
  compareMonths,
  monthKey,
  monthRange,
} from "@/domain/time/calendar-month";

/**
 * Where a month sits against today. The grid always shows twelve columns, so the
 * table's shape does not change as the year passes — what changes is which of
 * them are behind us.
 */
export type MonthStanding = "past" | "current" | "future";

export interface GridMonth {
  readonly month: CalendarMonth;
  readonly standing: MonthStanding;
  /**
   * Whether this month feeds סכום שנתי and ממוצע חודשי. A past month outside the
   * ledger's own span does not: the history does not reach it, so dividing by it
   * would be dividing by a month that never existed.
   */
  readonly counted: boolean;
}

export interface GridCell {
  readonly month: CalendarMonth;
  readonly standing: MonthStanding;
  /** `null` is *never recorded*. It is not a zero and must never be rendered as one. */
  readonly amount: Money | null;
}

export interface GridRow {
  readonly key: string;
  readonly name: string;
  readonly type: CategoryType;
  /** `null` at household level: a Household Category belongs to no one Person. */
  readonly personId: string | null;
  /** A retired category keeps every month it was recorded in; the badge says which it is. */
  readonly retired: boolean;
  /** Twelve, ascending — one per calendar month, whether or not the month arrived. */
  readonly cells: readonly GridCell[];
  /** Both aggregate columns at once: `.total` is סכום שנתי, `.amount` is ממוצע חודשי. */
  readonly aggregate: Average;
}

/** A band's own line: its subtotal, or חיסכון, which has no categories under it at all. */
export interface GridSummaryRow {
  readonly cells: readonly GridCell[];
  readonly aggregate: Average;
}

export interface GridBand {
  readonly type: CategoryType;
  readonly rows: readonly GridRow[];
  readonly total: GridSummaryRow;
}

export interface YearGrid {
  readonly year: number;
  readonly scope: AnalyticsScope;
  /** Twelve months, ascending. Always twelve. */
  readonly months: readonly GridMonth[];
  /** The months both aggregate columns total and divide by. */
  readonly denominatorMonths: readonly CalendarMonth[];
  readonly income: GridBand;
  readonly expenses: GridBand;
  /** חיסכון = הכנסות − הוצאות, derived on read. There is nothing to write to. */
  readonly saving: GridSummaryRow;
}

const MONTHS_IN_YEAR = 12;

function standingOf(month: CalendarMonth, today: CalendarMonth): MonthStanding {
  const order = compareMonths(month, today);
  if (order < 0) return "past";
  return order === 0 ? "current" : "future";
}

/**
 * Whether a group belongs on this year's grid. Either half is enough: a lifespan
 * that overlaps the year, so the household can see where the holes are; or a
 * figure recorded in it, so nothing that was written down can drop off the screen.
 */
function appearsInYear(
  ledger: Ledger,
  group: CategoryGroup,
  months: readonly CalendarMonth[],
): boolean {
  return group.members.some((member) =>
    months.some((month) => isActiveIn(member, month) || isRecorded(ledger, member.id, month)),
  );
}

function cellsOf(
  ledger: Ledger,
  group: CategoryGroup,
  months: readonly GridMonth[],
  currency: Currency,
): readonly GridCell[] {
  return months.map(({ month, standing }) => {
    const reading = readGroupMonth(ledger, group, month, currency);
    return { month, standing, amount: reading.recorded ? reading.amount : null };
  });
}

/** How many of the counted months hold a figure. A total over 3 of 12 months says so. */
function recordedAmong(
  cells: readonly GridCell[],
  counted: readonly CalendarMonth[],
): number {
  const keys = new Set(counted.map(monthKey));
  return cells.filter((cell) => keys.has(monthKey(cell.month)) && cell.amount !== null).length;
}

/**
 * A band's subtotal, month by month. A month where no row holds a figure stays
 * `null` rather than becoming a zero — an unrecorded month is not a month of no
 * spending, and the subtotal row must not claim otherwise.
 */
function subtotalOf(
  rows: readonly GridRow[],
  months: readonly GridMonth[],
  counted: readonly CalendarMonth[],
  currency: Currency,
): GridSummaryRow {
  const cells = months.map(({ month, standing }, index) => {
    const amounts = rows.flatMap((row) => {
      const cell = row.cells[index];
      return cell === undefined || cell.amount === null ? [] : [cell.amount];
    });
    return { month, standing, amount: amounts.length === 0 ? null : sum(amounts, currency) };
  });

  const total = sum(
    rows.map((row) => row.aggregate.total),
    currency,
  );
  return { cells, aggregate: averageOf(total, counted, recordedAmong(cells, counted)) };
}

/**
 * חיסכון across the year. A month with one side recorded and not the other is
 * still an answer — the same arithmetic the monthly summary does, where an absent
 * category contributes nothing — but a month with neither side recorded is left
 * blank rather than reported as a saving of nought.
 */
function savingOf(
  income: GridSummaryRow,
  expenses: GridSummaryRow,
  months: readonly GridMonth[],
  counted: readonly CalendarMonth[],
  currency: Currency,
): GridSummaryRow {
  const cells = months.map(({ month, standing }, index) => {
    const earned = income.cells[index]?.amount ?? null;
    const spent = expenses.cells[index]?.amount ?? null;
    if (earned === null && spent === null) return { month, standing, amount: null };
    return {
      month,
      standing,
      amount: subtract(earned ?? zero(currency), spent ?? zero(currency)),
    };
  });

  const total = subtract(income.aggregate.total, expenses.aggregate.total);
  return { cells, aggregate: averageOf(total, counted, recordedAmong(cells, counted)) };
}

/**
 * One year of the מאזן at household or person level.
 *
 * `today` and the currency are parameters: a function that asks the system for
 * the time cannot be tested against a boundary, and an empty year has no currency
 * of its own that a total could be guessed in.
 */
export function yearGrid(
  ledger: Ledger,
  categories: Categories,
  scope: AnalyticsScope,
  year: number,
  currency: Currency,
  today: CalendarMonth,
): YearGrid {
  const calendar = monthRange(calendarMonth(year, 1), calendarMonth(year, MONTHS_IN_YEAR));
  const counted = denominatorMonths(yearPeriod(year), today, recordedSpan(ledger));
  const countedKeys = new Set(counted.map(monthKey));

  const months: readonly GridMonth[] = calendar.map((month) => ({
    month,
    standing: standingOf(month, today),
    counted: countedKeys.has(monthKey(month)),
  }));

  const bandOf = (type: CategoryType): GridBand => {
    const rows = categoryGroups(categories, scope, { type })
      .filter((group) => appearsInYear(ledger, group, calendar))
      .map((group) => ({
        ...identifyGroup(group),
        retired: group.members.every(isRetired),
        cells: cellsOf(ledger, group, months, currency),
        aggregate: averageOverMonths(ledger, group, counted, currency),
      }));

    return { type, rows, total: subtotalOf(rows, months, counted, currency) };
  };

  const income = bandOf("income");
  const expenses = bandOf("expense");

  return {
    year,
    scope,
    months,
    denominatorMonths: counted,
    income,
    expenses,
    saving: savingOf(income.total, expenses.total, months, counted, currency),
  };
}
