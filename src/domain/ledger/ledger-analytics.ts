/**
 * LedgerAnalytics — the reading half of the מאזן.
 *
 * Framework-free per ADR 0004. Pure functions over entries and categories: the
 * ledger is handed in, nothing is fetched, and the clock is always a parameter.
 *
 * The screen this feeds has one job — say what is *unusual* — rather than
 * present twenty numbers and leave the reading to the reader. So every figure
 * here carries what it would take to argue with it:
 *
 * - **Every average states its denominator.** `Average` cannot be constructed
 *   without one, and there is no field that holds a bare mean. A reader never has
 *   to guess whether a number divided by 6 or by 12.
 * - **A share of nothing is `null`, not zero.** A month with no income did not
 *   save 0% of it. An average over no months is undefined, not nought.
 * - **A category with no history is not compared against zero.** It is reported
 *   as having no history, which is a different fact and often the interesting one.
 *
 * The two denominators here answer two different questions, and the difference is
 * deliberate:
 *
 * - A **period** average divides by the period's *closed calendar months* — the
 *   months strictly before the current one — intersected with the span the ledger
 *   actually covers. Two things follow from that. The month being lived is only
 *   half lived, so it drags an average down for no reason and is left out of both
 *   the total and the divisor. And a year the history reaches into only partway is
 *   divided by the part it reaches: this ledger begins in יולי 2024, so a 2024
 *   average divides by six rather than by twelve months of which six never
 *   existed. Nothing about יולי 2024 is written down here — the span is read off
 *   the ledger, so it stays right as history grows in either direction.
 * - A **trailing** average divides by the months that actually hold a figure,
 *   because the ledger says a missing month was never recorded — not that it was
 *   a month of zero. Dividing by the window would answer a question about a zero
 *   nobody wrote down.
 *
 * Both kinds carry the months they divided by and not merely how many of them, so
 * no caller can total one span and divide by another, and no screen can print a
 * divisor without being able to say which months it counted.
 */

import {
  type Categories,
  type CategoryType,
  type PersonalCategory,
  householdCategoriesFor,
  isActiveIn,
  personalCategoriesFor,
  personalCategoriesOf,
} from "@/domain/categories/categories";
import { type Currency, type Money, add, divide, ratio, subtract, sum, zero } from "@/domain/money/money";
import {
  type Ledger,
  type MonthCompleteness,
  type MonthSummary,
  type RecordedSpan,
  completenessOf,
  householdMonthSummary,
  isRecorded,
  personMonthSummary,
  readAmount,
  recordedSpan,
} from "@/domain/ledger/ledger";
import {
  type CalendarMonth,
  addMonths,
  calendarMonth,
  compareMonths,
  monthRange,
} from "@/domain/time/calendar-month";

// --- what is being read ------------------------------------------------------

/** Whose money the reading is about: one Person's own categories, or both People's. */
export type AnalyticsScope =
  | { readonly kind: "person"; readonly personId: string }
  | { readonly kind: "household" };

export const HOUSEHOLD_SCOPE: AnalyticsScope = { kind: "household" };

export function personScope(personId: string): AnalyticsScope {
  return { kind: "person", personId };
}

/**
 * One row of any reading below: a Household Category at household level, a
 * Personal Category at person level.
 *
 * Both are "a set of Personal Categories read together", which is the only thing
 * the arithmetic needs to know — so every function here is written once and works
 * at either level.
 */
interface CategoryGroup {
  readonly key: string;
  readonly name: string;
  readonly type: CategoryType;
  /** `null` at household level: a Household Category belongs to no one Person. */
  readonly personId: string | null;
  readonly members: readonly PersonalCategory[];
}

function groupsFor(
  categories: Categories,
  scope: AnalyticsScope,
  options: { readonly type?: CategoryType } = {},
): readonly CategoryGroup[] {
  if (scope.kind === "household") {
    return householdCategoriesFor(categories, options).flatMap((household) => {
      const members = personalCategoriesOf(categories, household.id);
      if (members.length === 0) return [];
      return [
        {
          key: household.id,
          name: household.name,
          type: household.type,
          personId: null,
          members,
        },
      ];
    });
  }

  return personalCategoriesFor(categories, scope.personId, options).map((category) => ({
    key: category.id,
    name: category.name,
    type: category.type,
    personId: category.personId,
    members: [category],
  }));
}

/** Every group as its own group — the drill-down under a household line. */
function membersAsGroups(group: CategoryGroup): readonly CategoryGroup[] {
  return group.members.map((member) => ({
    key: member.id,
    name: member.name,
    type: member.type,
    personId: member.personId,
    members: [member],
  }));
}

/**
 * A group's figure for one month.
 *
 * `recorded` is whether anything was written down at all, which is what decides
 * a denominator — never whether the figure came out to zero.
 */
interface GroupMonthReading {
  readonly amount: Money;
  readonly recorded: boolean;
}

function readGroupMonth(
  ledger: Ledger,
  group: CategoryGroup,
  month: CalendarMonth,
  currency: Currency,
): GroupMonthReading {
  const amounts = group.members.flatMap((member) => {
    // A recorded figure is shown whatever the lifespan since became — the same
    // rule the ledger's own month lines follow, so a retirement can never hide
    // money from a total.
    if (!isActiveIn(member, month) && !isRecorded(ledger, member.id, month)) return [];
    const reading = readAmount(ledger, member.id, month);
    return reading === null ? [] : [reading.amount];
  });

  return { amount: sum(amounts, currency), recorded: amounts.length > 0 };
}

function summaryFor(
  ledger: Ledger,
  categories: Categories,
  scope: AnalyticsScope,
  month: CalendarMonth,
  currency: Currency,
): MonthSummary {
  return scope.kind === "household"
    ? householdMonthSummary(ledger, categories, month, currency)
    : personMonthSummary(ledger, categories, scope.personId, month, currency);
}

// --- periods and their denominators ------------------------------------------

export type Period =
  | { readonly kind: "month"; readonly month: CalendarMonth }
  | { readonly kind: "year"; readonly year: number };

export function monthPeriod(month: CalendarMonth): Period {
  return { kind: "month", month };
}

export function yearPeriod(year: number): Period {
  return { kind: "year", year };
}

export function periodMonths(period: Period): readonly CalendarMonth[] {
  if (period.kind === "month") return [period.month];
  return monthRange(calendarMonth(period.year, 1), calendarMonth(period.year, 12));
}

/**
 * The months an average over a period is totalled across and divided by — one
 * list, so a caller cannot total one span and divide by another.
 *
 * A year contributes its **closed calendar months**: the months strictly before
 * the current one, intersected with the span the ledger covers. So in August 2026
 * the year 2026 counts ינואר–יולי; 2025 counts all twelve; 2024 counts יולי–דצמבר,
 * because the history starts there and the six months before it never existed;
 * and 2027 counts none, which makes an average over it undefined rather than
 * nought. The in-progress month is in none of them — a month half lived would drag
 * the average down for no reason other than the date.
 *
 * A month period is that month, whatever the date. There is no aggregate for the
 * current month to distort, and answering "what did August cost" with nothing
 * because August is not over would be a stranger reading than answering it.
 *
 * `today` is a parameter and never read from the clock inside: a function that
 * asks the system for the time cannot be tested against a boundary. The span is a
 * parameter for the same reason.
 */
export function denominatorMonths(
  period: Period,
  today: CalendarMonth,
  span: RecordedSpan | null,
): readonly CalendarMonth[] {
  if (period.kind === "month") return [period.month];
  if (span === null) return [];
  return periodMonths(period).filter(
    (month) =>
      compareMonths(month, today) < 0 &&
      compareMonths(month, span.first) >= 0 &&
      compareMonths(month, span.last) <= 0,
  );
}

/** How many months an average over a period divides by. Always `denominatorMonths().length`. */
export function periodDenominator(
  period: Period,
  today: CalendarMonth,
  span: RecordedSpan | null,
): number {
  return denominatorMonths(period, today, span).length;
}

// --- averages, which never travel without their denominator ------------------

export interface Average {
  readonly total: Money;
  /** `total ÷ denominator`. `null` when the denominator is zero — undefined, not nought. */
  readonly amount: Money | null;
  /** What the total was divided by. Displayed with every average; never implied. */
  readonly denominator: number;
  /**
   * The months that denominator counted, ascending — the same months the total was
   * summed over. `denominator === months.length` always, which is what makes
   * totalling one span and dividing by another impossible rather than merely
   * discouraged, and what lets a screen say *which* months it divided by.
   */
  readonly months: readonly CalendarMonth[];
  /** How many of those months hold a figure. A total over 3 of 12 months says so. */
  readonly recordedMonths: number;
}

function averageOf(
  total: Money,
  months: readonly CalendarMonth[],
  recordedMonths: number,
): Average {
  return {
    total,
    amount: months.length === 0 ? null : divide(total, months.length),
    denominator: months.length,
    months,
    recordedMonths,
  };
}

function averageOverMonths(
  ledger: Ledger,
  group: CategoryGroup,
  months: readonly CalendarMonth[],
  currency: Currency,
): Average {
  let total = zero(currency);
  let recordedMonths = 0;
  for (const month of months) {
    const reading = readGroupMonth(ledger, group, month, currency);
    total = add(total, reading.amount);
    if (reading.recorded) recordedMonths += 1;
  }
  return averageOf(total, months, recordedMonths);
}

// --- חיסכון as a share of הכנסות ---------------------------------------------

/**
 * חיסכון against the income it came out of. It carries both sides rather than a
 * bare percentage, so a 40% month on 5,000₪ never reads like a 40% month on
 * 50,000₪, and a month with no income states that instead of showing 0%.
 */
export interface SavingRate {
  readonly saving: Money;
  readonly income: Money;
  /** `saving ÷ income`. `null` when there was no income for it to be a share of. */
  readonly ratio: number | null;
}

function savingRateOf(summary: { readonly income: Money; readonly saving: Money }): SavingRate {
  return {
    saving: summary.saving,
    income: summary.income,
    ratio: ratio(summary.saving, summary.income),
  };
}

// --- the monthly trend, with the previous year alongside ---------------------

export interface TrendMonth {
  readonly month: CalendarMonth;
  readonly income: Money;
  readonly expenses: Money;
  readonly saving: Money;
  readonly savingRate: SavingRate;
  readonly completeness: MonthCompleteness;
  readonly recordedCount: number;
  readonly categoryCount: number;
}

export interface TrendPoint extends TrendMonth {
  /**
   * The same calendar month one year earlier, or `null` when nothing was recorded
   * for it. A month with no data is left absent rather than drawn as a zero,
   * which would read as a year in which the household earned nothing.
   */
  readonly previous: TrendMonth | null;
}

function trendMonth(
  ledger: Ledger,
  categories: Categories,
  scope: AnalyticsScope,
  month: CalendarMonth,
  currency: Currency,
): TrendMonth {
  const summary = summaryFor(ledger, categories, scope, month, currency);
  return {
    month,
    income: summary.income,
    expenses: summary.expenses,
    saving: summary.saving,
    savingRate: savingRateOf(summary),
    completeness: completenessOf(summary),
    recordedCount: summary.recordedCount,
    categoryCount: summary.categoryCount,
  };
}

/**
 * הכנסות, הוצאות and חיסכון month by month over an inclusive range, each month
 * carrying the same month of the previous year beside it. One continuous ledger:
 * the range crosses year boundaries without anything being stitched together.
 */
export function monthlyTrend(
  ledger: Ledger,
  categories: Categories,
  scope: AnalyticsScope,
  from: CalendarMonth,
  to: CalendarMonth,
  currency: Currency,
): readonly TrendPoint[] {
  return monthRange(from, to).map((month) => {
    const previous = trendMonth(ledger, categories, scope, addMonths(month, -12), currency);
    return {
      ...trendMonth(ledger, categories, scope, month, currency),
      previous: previous.recordedCount === 0 ? null : previous,
    };
  });
}

// --- what is unusual this month ----------------------------------------------

/** How many months a trailing average looks back over, unless told otherwise. */
export const DEFAULT_TRAILING_WINDOW = 6;

/**
 * Why a category ranks where it does.
 *
 * - `compared` — it has a trailing average and a figure this month, so the
 *   deviation between them is a real measurement.
 * - `no-history` — recorded this month with nothing to compare against. Not a
 *   deviation of its full amount: there is no baseline, and inventing a zero one
 *   would put every new category at the top of the list.
 * - `not-recorded` — it has history and this month holds nothing. Possibly an
 *   unfinished month rather than a change in spending, so it is reported and not
 *   ranked as a fall to zero.
 */
export type DeviationBasis = "compared" | "no-history" | "not-recorded";

export interface CategoryDeviation {
  readonly key: string;
  readonly name: string;
  readonly type: CategoryType;
  readonly personId: string | null;
  /** This month's figure, or `null` when nothing was recorded for it. */
  readonly current: Money | null;
  /** The category's own trailing average, carrying the months it divided by. */
  readonly trailing: Average;
  /** `current − trailing.amount`. `null` unless both sides exist. */
  readonly deviation: Money | null;
  /** `deviation ÷ trailing.amount`. `null` when there is no baseline to be a share of. */
  readonly deviationRatio: number | null;
  readonly basis: DeviationBasis;
}

const BASIS_ORDER: Record<DeviationBasis, number> = {
  compared: 0,
  "no-history": 1,
  "not-recorded": 2,
};

/**
 * Each category's month against its own trailing average, largest deviation
 * first — so the screen says what is unusual instead of listing twenty numbers to
 * scan.
 *
 * The order is a total one, tie-broken by category key, so repeating the
 * computation on the same data always produces the same list. A ranking that
 * reshuffled between two reads of the same month would be worse than no ranking:
 * the reader would learn to distrust the top of it.
 */
export function rankCategoryDeviations(
  ledger: Ledger,
  categories: Categories,
  scope: AnalyticsScope,
  month: CalendarMonth,
  currency: Currency,
  options: { readonly window?: number; readonly type?: CategoryType } = {},
): readonly CategoryDeviation[] {
  const window = options.window ?? DEFAULT_TRAILING_WINDOW;
  const trailingMonths = window <= 0 ? [] : monthRange(addMonths(month, -window), addMonths(month, -1));

  const deviations = groupsFor(categories, scope, { type: options.type }).flatMap<CategoryDeviation>(
    (group) => {
      const reading = readGroupMonth(ledger, group, month, currency);
      const current = reading.recorded ? reading.amount : null;

      // A trailing average divides by the months that hold a figure: the ledger
      // says an absent month was never recorded, not that it was a month of zero.
      // Those months are the average's own, so a two-month average drawn out of a
      // six-month window carries the two and never the six.
      let total = zero(currency);
      const counted: CalendarMonth[] = [];
      for (const past of trailingMonths) {
        const pastReading = readGroupMonth(ledger, group, past, currency);
        if (!pastReading.recorded) continue;
        total = add(total, pastReading.amount);
        counted.push(past);
      }
      const trailing = averageOf(total, counted, counted.length);

      // Nothing this month and nothing before it is not a finding.
      if (current === null && trailing.amount === null) return [];

      if (current === null) {
        return [{ ...identify(group), current, trailing, deviation: null, deviationRatio: null, basis: "not-recorded" }];
      }
      if (trailing.amount === null) {
        return [{ ...identify(group), current, trailing, deviation: null, deviationRatio: null, basis: "no-history" }];
      }

      const deviation = subtract(current, trailing.amount);
      return [
        {
          ...identify(group),
          current,
          trailing,
          deviation,
          deviationRatio: ratio(deviation, trailing.amount),
          basis: "compared",
        },
      ];
    },
  );

  return [...deviations].sort(compareDeviations);
}

function identify(group: CategoryGroup): Pick<CategoryDeviation, "key" | "name" | "type" | "personId"> {
  return { key: group.key, name: group.name, type: group.type, personId: group.personId };
}

function compareDeviations(left: CategoryDeviation, right: CategoryDeviation): number {
  const byBasis = BASIS_ORDER[left.basis] - BASIS_ORDER[right.basis];
  if (byBasis !== 0) return byBasis;

  const magnitude = (deviation: CategoryDeviation) =>
    deviation.basis === "compared"
      ? Math.abs(deviation.deviation?.minorUnits ?? 0)
      : Math.abs(deviation.current?.minorUnits ?? deviation.trailing.amount?.minorUnits ?? 0);

  const bySize = magnitude(right) - magnitude(left);
  if (bySize !== 0) return bySize;

  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

// --- where the money went, for a month or a year -----------------------------

export interface BreakdownLine {
  readonly key: string;
  readonly name: string;
  readonly type: CategoryType;
  readonly personId: string | null;
  readonly average: Average;
  /** Share of the period's total for this type. `null` when that total is zero. */
  readonly share: number | null;
  /**
   * At household level, the Personal Categories underneath, each with its share
   * of *this* line. Empty at person level, where the line is already personal.
   */
  readonly contributions: readonly BreakdownLine[];
}

export interface Breakdown {
  readonly period: Period;
  readonly scope: AnalyticsScope;
  /** The months every average on this breakdown divided by. */
  readonly denominator: number;
  readonly months: readonly CalendarMonth[];
  readonly income: readonly BreakdownLine[];
  readonly expenses: readonly BreakdownLine[];
  readonly totals: {
    readonly income: Average;
    readonly expenses: Average;
    readonly saving: Average;
  };
}

/**
 * A month or a year, at household or person level. Lines are ordered largest
 * first, tie-broken by key, so "where did the money go" is answered by reading
 * downwards and the same data always produces the same order.
 */
export function categoryBreakdown(
  ledger: Ledger,
  categories: Categories,
  scope: AnalyticsScope,
  period: Period,
  currency: Currency,
  today: CalendarMonth,
): Breakdown {
  const months = denominatorMonths(period, today, recordedSpan(ledger));

  const summaries = months.map((month) => summaryFor(ledger, categories, scope, month, currency));
  const recordedMonths = summaries.filter((summary) => summary.recordedCount > 0).length;
  const totalOf = (pick: (summary: MonthSummary) => Money) =>
    averageOf(sum(summaries.map(pick), currency), months, recordedMonths);

  const totals = {
    income: totalOf((summary) => summary.income),
    expenses: totalOf((summary) => summary.expenses),
    saving: totalOf((summary) => summary.saving),
  };

  const linesFor = (type: CategoryType, typeTotal: Money): readonly BreakdownLine[] =>
    groupsFor(categories, scope, { type })
      .map((group) => {
        const average = averageOverMonths(ledger, group, months, currency);
        return {
          ...identify(group),
          average,
          share: ratio(average.total, typeTotal),
          contributions: contributionsOf(ledger, group, months, currency, average.total),
        };
      })
      // A category with nothing recorded in the period is not a fact about it.
      .filter((line) => line.average.recordedMonths > 0)
      .sort(compareBreakdownLines);

  return {
    period,
    scope,
    denominator: months.length,
    months,
    income: linesFor("income", totals.income.total),
    expenses: linesFor("expense", totals.expenses.total),
    totals,
  };
}

/**
 * The drill-down under one line: the Personal Categories that produced it, each
 * with its share of the line above.
 *
 * Only members with something recorded in the period appear — a category that was
 * silent all year is not part of the account of where this money went. And a
 * drill-down that would show one member is left out entirely: repeating the line
 * above under itself explains nothing.
 */
function contributionsOf(
  ledger: Ledger,
  group: CategoryGroup,
  months: readonly CalendarMonth[],
  currency: Currency,
  groupTotal: Money,
): readonly BreakdownLine[] {
  if (group.members.length < 2) return [];

  const contributions = membersAsGroups(group)
    .map((member) => {
      const average = averageOverMonths(ledger, member, months, currency);
      return {
        ...identify(member),
        average,
        share: ratio(average.total, groupTotal),
        contributions: [] as readonly BreakdownLine[],
      };
    })
    .filter((line) => line.average.recordedMonths > 0)
    .sort(compareBreakdownLines);

  return contributions.length < 2 ? [] : contributions;
}

function compareBreakdownLines(left: BreakdownLine, right: BreakdownLine): number {
  const bySize = right.average.total.minorUnits - left.average.total.minorUnits;
  if (bySize !== 0) return bySize;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

// --- the same period last year ------------------------------------------------

export interface YearOverYearLine {
  readonly key: string;
  readonly name: string;
  readonly type: CategoryType;
  readonly personId: string | null;
  readonly current: Average;
  /**
   * `null` when the category did not exist in the comparison year — which is a
   * different fact from a year in which it was recorded as nothing, and the
   * difference is what stops a new category reading as a doubling.
   */
  readonly previous: Average | null;
  readonly change: Money | null;
  readonly changeRatio: number | null;
}

export interface YearOverYear {
  readonly year: number;
  readonly comparisonYear: number;
  /** The same span of months on both sides — Jan–Jun against Jan–Jun, never against a full year. */
  readonly months: number;
  /** Which months those are, on the current side. Stated, so "6 months" is never "which six?". */
  readonly currentMonths: readonly CalendarMonth[];
  /** The same months a year earlier — never clamped, or the two sides would not match. */
  readonly previousMonths: readonly CalendarMonth[];
  readonly lines: readonly YearOverYearLine[];
}

/**
 * Each category against the same period last year. When the current year is
 * partial, the comparison is trimmed to the same months on both sides rather than
 * set against a full twelve — otherwise every category would appear to be falling
 * every January.
 *
 * A category that did not exist last year still appears, with `previous: null`.
 * Leaving it out would hide new spending, and showing it against zero would claim
 * a rise that nobody can substantiate.
 */
export function yearOverYear(
  ledger: Ledger,
  categories: Categories,
  scope: AnalyticsScope,
  year: number,
  currency: Currency,
  today: CalendarMonth,
  options: { readonly type?: CategoryType } = {},
): YearOverYear {
  const comparisonYear = year - 1;

  // The current side is the months the year's own average divides by. The
  // comparison side is those very months a year earlier — matched one for one and
  // never clamped to the ledger's span, because a comparison whose two sides
  // divided by different numbers would report the difference between the divisors
  // as a change in spending.
  const currentMonths = denominatorMonths(yearPeriod(year), today, recordedSpan(ledger));
  const previousMonths = currentMonths.map((month) => addMonths(month, -12));
  const months = currentMonths.length;

  const lines = groupsFor(categories, scope, { type: options.type }).flatMap<YearOverYearLine>((group) => {
    const current = averageOverMonths(ledger, group, currentMonths, currency);
    const existedBefore = previousMonths.some((month) =>
      group.members.some((member) => isActiveIn(member, month) || isRecorded(ledger, member.id, month)),
    );
    const previous = existedBefore
      ? averageOverMonths(ledger, group, previousMonths, currency)
      : null;

    if (current.recordedMonths === 0 && (previous === null || previous.recordedMonths === 0)) return [];

    const change = previous === null ? null : subtract(current.total, previous.total);
    return [
      {
        ...identify(group),
        current,
        previous,
        change,
        changeRatio: change === null || previous === null ? null : ratio(change, previous.total),
      },
    ];
  });

  return {
    year,
    comparisonYear,
    months,
    currentMonths,
    previousMonths,
    lines: [...lines].sort((left, right) => {
      const bySize = right.current.total.minorUnits - left.current.total.minorUnits;
      if (bySize !== 0) return bySize;
      return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
    }),
  };
}

// --- how much is available to move into projects ------------------------------

/**
 * This month's חיסכון — what the household has free to move into a project.
 *
 * It is `הכנסות − הוצאות` read straight off the month, and it carries the month's
 * completeness with it: a half-entered month's חיסכון looks generous for the same
 * reason a half-entered month looks cheap, and the figure must never be handed
 * over without that alongside it.
 */
export interface AvailableToMove {
  readonly month: CalendarMonth;
  readonly saving: Money;
  readonly savingRate: SavingRate;
  readonly completeness: MonthCompleteness;
  readonly recordedCount: number;
  readonly categoryCount: number;
}

export function availableToMove(
  ledger: Ledger,
  categories: Categories,
  scope: AnalyticsScope,
  month: CalendarMonth,
  currency: Currency,
): AvailableToMove {
  const point = trendMonth(ledger, categories, scope, month, currency);
  return {
    month: point.month,
    saving: point.saving,
    savingRate: point.savingRate,
    completeness: point.completeness,
    recordedCount: point.recordedCount,
    categoryCount: point.categoryCount,
  };
}
