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
 *
 * Two more decide how it reads, and both are here rather than in the markup so
 * that what the screen emphasises is testable without a browser:
 *
 * - **A cell is measured against its own row and never against the table.** חו"ל's
 *   9,905 in מאי is a finding; שכ״ד's identical 7,000 every month is not, however
 *   much larger it is. Tinting by magnitude would mostly report that rent costs
 *   more than bus fare, which nobody opened the screen to learn.
 * - **Both row orders are total.** Largest annual sum first is the default,
 *   because the top of the table is where the money went; Hebrew alphabetical is
 *   for when the same row should be in the same place every time. Either way ties
 *   break on the category key, so the same data always renders the same order.
 *
 * And one more, because the grid is also where the holes get filled: **the reading
 * says what each cell writes to and where each month stands on being closed.**
 * Both are decided here rather than in the markup, so the one row with no input
 * anywhere is the one row the reading gives nothing to write to, and the columns
 * marked as unfinished are marked from the ledger rather than from a stored flag.
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
  membersAsGroups,
  readGroupMonth,
  yearPeriod,
} from "@/domain/ledger/ledger-analytics";
import { type Ledger, isRecorded, recordedSpan } from "@/domain/ledger/ledger";
import { type MonthClosure, monthClosure } from "@/domain/ledger/month-closure";
import { type Currency, type Money, ratio, subtract, sum, zero } from "@/domain/money/money";
import {
  type CalendarMonth,
  addMonths,
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
  /**
   * Whether the month has a figure for every category active in it, and which ones
   * it does not. This is what makes the holes findable: a closed calendar month
   * that is not yet a *closed* month is a column the reader can still finish.
   */
  readonly closure: MonthClosure;
}

/**
 * Which side of its own row's average a cell fell on, when it fell far enough to
 * be worth a reader's attention. `null` is the ordinary case and by far the
 * commonest: a month that behaved like the rest of its row.
 */
export type CellDeviation = "above" | "below" | null;

export interface GridCell {
  readonly month: CalendarMonth;
  readonly standing: MonthStanding;
  /** `null` is *never recorded*. It is not a zero and must never be rendered as one. */
  readonly amount: Money | null;
  /** Marked only against this row's own ממוצע חודשי — never against the table. */
  readonly deviation: CellDeviation;
  /**
   * The Personal Category a figure typed into this cell would be written to, and
   * `null` wherever there is nothing single to write it to: a משותף row summing two
   * People, a band subtotal, חיסכון, a month the category's lifespan does not
   * cover, or a month that has not arrived.
   *
   * It is decided here rather than in the markup, so the one line with no input
   * anywhere on the screen is the one line the reading says has nothing to write.
   */
  readonly writesTo: string | null;
}

export interface GridRow {
  readonly key: string;
  readonly name: string;
  readonly type: CategoryType;
  /** `null` at household level: a Household Category belongs to no one Person. */
  readonly personId: string | null;
  /** The Group its Household Category is marked with, or `null`. See `ShareSlice`. */
  readonly group: string | null;
  /** A retired category keeps every month it was recorded in; the badge says which it is. */
  readonly retired: boolean;
  /** Twelve, ascending — one per calendar month, whether or not the month arrived. */
  readonly cells: readonly GridCell[];
  /** Both aggregate columns at once: `.total` is סכום שנתי, `.amount` is ממוצע חודשי. */
  readonly aggregate: Average;
  /**
   * The Personal Categories this row is the sum of, each a full row of its own.
   * Empty at person level, where the row is already personal, and empty for a
   * Household Category with a single member — repeating a row underneath itself
   * explains nothing. Every column of these rows adds up to the row above them.
   */
  readonly contributions: readonly GridRow[];
}

/** Largest annual sum first, or Hebrew alphabetical. Both total, both stable. */
export type GridSort = "size" | "name";

export const DEFAULT_GRID_SORT: GridSort = "size";

export function isGridSort(value: unknown): value is GridSort {
  return value === "size" || value === "name";
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

/**
 * The same year one year earlier, over exactly the months this year's aggregates
 * count.
 *
 * The two sides are matched one for one and the earlier side is never clamped to
 * the ledger's own span: a comparison whose halves divided by different numbers
 * of months would report the difference between the divisors as a change in
 * spending. So a year read in אוגוסט compares ינואר–יולי against ינואר–יולי, and
 * a year the history does not reach behind compares against nothing and says so.
 */
export interface YearBefore {
  readonly year: number;
  /** The counted months of this year, each moved back twelve. */
  readonly months: readonly CalendarMonth[];
  /**
   * How many of those months hold a figure anywhere in scope. Nought means there
   * is no comparison to draw, which is a different fact from a comparison to zero.
   */
  readonly recordedMonths: number;
  readonly income: Money;
  readonly expenses: Money;
  readonly saving: Money;
}

/**
 * One wedge of "where the money went": a Household Category on its own, or every
 * line marked with one Group read as a single part.
 *
 * A Group is drawn as one wedge because that is the whole point of marking lines
 * with one — חשמל, ארנונה, גז, מים, שכ"ד and אינטרנט are six rows in the table
 * and one question in the chart. The rows underneath travel with the wedge in
 * `parts`, so the chart can name what a Group is made of without the screen
 * going back to the taxonomy and adding it up a second way.
 *
 * A line whose year came to nought or less is left out. A share of a total is
 * only meaningful for a part that is some of it, and a category that was
 * refunded more than it was charged has no wedge to draw — it is still in the
 * table above, where a negative figure reads as the fact it is.
 */
export interface ShareSlice {
  readonly key: string;
  readonly name: string;
  /** Whether this wedge is a Group rather than one Household Category. */
  readonly isGroup: boolean;
  readonly total: Money;
  /** Of the band's own total. `null` when that total is nought — not 0%. */
  readonly share: number | null;
  /** What a Group is made of, largest first. Empty for a single line. */
  readonly parts: readonly SharePart[];
}

export interface SharePart {
  readonly key: string;
  readonly name: string;
  readonly total: Money;
  /** Of the whole band, so a part and its wedge are read on one scale. */
  readonly share: number | null;
}

export interface YearGrid {
  readonly year: number;
  readonly scope: AnalyticsScope;
  readonly sort: GridSort;
  /** Twelve months, ascending. Always twelve. */
  readonly months: readonly GridMonth[];
  /** The months both aggregate columns total and divide by. */
  readonly denominatorMonths: readonly CalendarMonth[];
  readonly income: GridBand;
  readonly expenses: GridBand;
  /** חיסכון = הכנסות − הוצאות, derived on read. There is nothing to write to. */
  readonly saving: GridSummaryRow;
  /** The same months a year earlier, for the three figures the year is read for. */
  readonly before: YearBefore;
  /** Where the year's הוצאות went, as parts of one whole, largest first. */
  readonly expenseShares: readonly ShareSlice[];
}

const MONTHS_IN_YEAR = 12;

/**
 * What makes a month worth marking on its own row. Both bars must be cleared,
 * and the second is the load-bearing one: a 12₪ jump on a 20₪ row is 60% and
 * still not a finding, while the same 60% on a 9,000₪ row is the trip to חו"ל
 * the household is looking for.
 *
 * A relative test alone marks half the table. Ordinary household spending on a
 * small category swings by more than half most months — ארנונה, גז, חשמל are
 * billed every second month and every bill is a "deviation" — so the money bar
 * is what keeps the mark meaning *look at this* rather than decorating the grid.
 * The pair was calibrated against a real year: chosen so חו"ל's מאי and כושר's
 * one 1,336₪ month are marked while ארנונה and חשמל are left entirely alone.
 */
const DEVIATION_RATIO = 0.5;

/**
 * In minor units of the row's own currency — 1,000₪, roughly a thirtieth of a
 * month, below which a swing is not news however large a share of its row it is.
 */
const DEVIATION_MINIMUM = 1_000_00;

/**
 * Hebrew alphabetical order, from the platform's own collation rather than a
 * hand-rolled letter table. `base` sensitivity so a name that differs only in
 * niqqud or final-form spelling does not sort away from its neighbours; ties fall
 * through to the category key, which makes the order total.
 */
const hebrewOrder = new Intl.Collator("he", { numeric: true, sensitivity: "base" });

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
    return {
      month,
      standing,
      amount: reading.recorded ? reading.amount : null,
      deviation: null,
      writesTo: writeTargetOf(ledger, group, month, standing),
    };
  });
}

/**
 * Which Personal Category a cell writes to, if any.
 *
 * A row that is one Personal Category is writable in a month its lifespan covers,
 * and in any month that already holds a figure for it, so a mistake made outside
 * the lifespan can still be corrected where it was made. A row that is two — a
 * משותף line summing both People — is not: there is no household ledger, and
 * picking one of the two to receive the figure would be inventing whose money it
 * was. Its contributions carry the write instead.
 */
function writeTargetOf(
  ledger: Ledger,
  group: CategoryGroup,
  month: CalendarMonth,
  standing: MonthStanding,
): string | null {
  const [member, ...rest] = group.members;
  if (member === undefined || rest.length > 0) return null;
  // A month nobody has lived through yet is inert on this screen, blanks and all.
  if (standing === "future") return null;
  return isActiveIn(member, month) || isRecorded(ledger, member.id, month) ? member.id : null;
}

/**
 * Each cell against its own row's ממוצע חודשי. A row with no average — a year
 * with no closed months, a category that holds nothing — marks nothing, because
 * there is no baseline to have departed from and inventing one at zero would mark
 * every figure on the screen.
 */
function markDeviations(cells: readonly GridCell[], average: Money | null): readonly GridCell[] {
  if (average === null) return cells;

  return cells.map((cell) => {
    if (cell.amount === null) return cell;
    const difference = subtract(cell.amount, average).minorUnits;
    const size = Math.abs(difference);
    if (size < DEVIATION_MINIMUM || size < DEVIATION_RATIO * Math.abs(average.minorUnits)) {
      return cell;
    }
    return { ...cell, deviation: difference > 0 ? ("above" as const) : ("below" as const) };
  });
}

/** One row — a Household Category or a Personal one — with its cells already marked. */
function rowOf(
  ledger: Ledger,
  group: CategoryGroup,
  months: readonly GridMonth[],
  counted: readonly CalendarMonth[],
  currency: Currency,
  contributions: readonly GridRow[] = [],
): GridRow {
  const aggregate = averageOverMonths(ledger, group, counted, currency);
  return {
    ...identifyGroup(group),
    retired: group.members.every(isRetired),
    cells: markDeviations(cellsOf(ledger, group, months, currency), aggregate.amount),
    aggregate,
    contributions,
  };
}

/**
 * The Personal Categories under a household row, in the same order as the rows
 * they sit beneath.
 *
 * A member with nothing to do with the year is left out — its row would be twelve
 * blanks — and dropping it costs the sum nothing, since a category the year never
 * touched contributes nothing to any column of the row above.
 */
function contributionsOf(
  ledger: Ledger,
  group: CategoryGroup,
  months: readonly GridMonth[],
  calendar: readonly CalendarMonth[],
  counted: readonly CalendarMonth[],
  currency: Currency,
  sort: GridSort,
): readonly GridRow[] {
  if (group.members.length < 2) return [];

  return membersAsGroups(group)
    .filter((member) => appearsInYear(ledger, member, calendar))
    .map((member) => rowOf(ledger, member, months, counted, currency))
    .sort(byOrder(sort));
}

/**
 * Either order, made total by the same tie-break: a screen whose rows reshuffled
 * between two reads of the same data would teach the household to distrust the
 * top of it.
 */
function byOrder(sort: GridSort): (left: GridRow, right: GridRow) => number {
  return (left, right) => {
    if (sort === "size") {
      const bySize = right.aggregate.total.minorUnits - left.aggregate.total.minorUnits;
      if (bySize !== 0) return bySize;
    } else {
      const byName = hebrewOrder.compare(left.name, right.name);
      if (byName !== 0) return byName;
    }
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  };
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
    return {
      month,
      standing,
      amount: amounts.length === 0 ? null : sum(amounts, currency),
      deviation: null,
      // A subtotal is the rows above it added up. There is nothing to write to.
      writesTo: null,
    };
  });

  const total = sum(
    rows.map((row) => row.aggregate.total),
    currency,
  );
  const aggregate = averageOf(total, counted, recordedAmong(cells, counted));
  return { cells: markDeviations(cells, aggregate.amount), aggregate };
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
  // חיסכון is הכנסות − הוצאות and nothing else, so no cell of it writes anywhere.
  const cells = months.map(({ month, standing }, index): GridCell => {
    const earned = income.cells[index]?.amount ?? null;
    const spent = expenses.cells[index]?.amount ?? null;
    const base = { month, standing, deviation: null, writesTo: null } as const;
    if (earned === null && spent === null) return { ...base, amount: null };
    return { ...base, amount: subtract(earned ?? zero(currency), spent ?? zero(currency)) };
  });

  const total = subtract(income.aggregate.total, expenses.aggregate.total);
  const aggregate = averageOf(total, counted, recordedAmong(cells, counted));
  return { cells: markDeviations(cells, aggregate.amount), aggregate };
}

/**
 * The three headline figures over the same months one year earlier.
 *
 * Read from the same primitives the grid itself reads from, so the comparison and
 * the figure it is a comparison *of* cannot be arrived at by two different routes.
 */
function yearBefore(
  ledger: Ledger,
  categories: Categories,
  scope: AnalyticsScope,
  counted: readonly CalendarMonth[],
  currency: Currency,
  year: number,
): YearBefore {
  const months = counted.map((month) => addMonths(month, -MONTHS_IN_YEAR));

  const totalOf = (type: CategoryType): Money =>
    sum(
      categoryGroups(categories, scope, { type }).map(
        (group) => averageOverMonths(ledger, group, months, currency).total,
      ),
      currency,
    );

  const income = totalOf("income");
  const expenses = totalOf("expense");
  const every = categoryGroups(categories, scope);

  return {
    year: year - 1,
    months,
    recordedMonths: months.filter((month) =>
      every.some((group) => readGroupMonth(ledger, group, month, currency).recorded),
    ).length,
    income,
    expenses,
    saving: subtract(income, expenses),
  };
}

/**
 * The band as parts of one whole, largest first.
 *
 * Nothing is read off the ledger here: every figure is the `aggregate.total` the
 * rows already carry, so a wedge and the row it was drawn from cannot come to
 * two different numbers. The order is total, tie-broken on the key, so the same
 * data always draws the same chart.
 */
function sharesOf(band: GridBand, currency: Currency): readonly ShareSlice[] {
  const whole = band.total.aggregate.total;
  const positive = band.rows.filter((row) => row.aggregate.total.minorUnits > 0);

  const grouped = new Map<string, GridRow[]>();
  for (const row of positive) {
    if (row.group === null) continue;
    grouped.set(row.group, [...(grouped.get(row.group) ?? []), row]);
  }

  const partOf = (row: GridRow): SharePart => ({
    key: row.key,
    name: row.name,
    total: row.aggregate.total,
    share: ratio(row.aggregate.total, whole),
  });

  const slices: ShareSlice[] = [];

  for (const [group, rows] of grouped) {
    const total = sum(rows.map((row) => row.aggregate.total), currency);
    slices.push({
      key: `group:${group}`,
      name: group,
      isGroup: true,
      total,
      share: ratio(total, whole),
      parts: [...rows].map(partOf).sort(bySlice),
    });
  }

  for (const row of positive) {
    if (row.group !== null) continue;
    slices.push({
      key: row.key,
      name: row.name,
      isGroup: false,
      total: row.aggregate.total,
      share: ratio(row.aggregate.total, whole),
      parts: [],
    });
  }

  return slices.sort(bySlice);
}

function bySlice(
  left: { readonly key: string; readonly total: Money },
  right: { readonly key: string; readonly total: Money },
): number {
  const bySize = right.total.minorUnits - left.total.minorUnits;
  if (bySize !== 0) return bySize;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
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
  options: { readonly sort?: GridSort } = {},
): YearGrid {
  const sort = options.sort ?? DEFAULT_GRID_SORT;
  const calendar = monthRange(calendarMonth(year, 1), calendarMonth(year, MONTHS_IN_YEAR));
  const counted = denominatorMonths(yearPeriod(year), today, recordedSpan(ledger));
  const countedKeys = new Set(counted.map(monthKey));

  const months: readonly GridMonth[] = calendar.map((month) => ({
    month,
    standing: standingOf(month, today),
    counted: countedKeys.has(monthKey(month)),
    closure: monthClosure(ledger, categories, scope, month),
  }));

  const bandOf = (type: CategoryType): GridBand => {
    const rows = categoryGroups(categories, scope, { type })
      .filter((group) => appearsInYear(ledger, group, calendar))
      .map((group) =>
        rowOf(
          ledger,
          group,
          months,
          counted,
          currency,
          contributionsOf(ledger, group, months, calendar, counted, currency, sort),
        ),
      )
      .sort(byOrder(sort));

    return { type, rows, total: subtotalOf(rows, months, counted, currency) };
  };

  const income = bandOf("income");
  const expenses = bandOf("expense");

  return {
    year,
    scope,
    sort,
    months,
    denominatorMonths: counted,
    income,
    expenses,
    saving: savingOf(income.total, expenses.total, months, counted, currency),
    before: yearBefore(ledger, categories, scope, counted, currency, year),
    expenseShares: sharesOf(expenses, currency),
  };
}
