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
 * - A **period** average divides by *elapsed* months (twelve for a past year),
 *   because "what do we spend a month" must not read as half its true size just
 *   because half of 2026 has not happened yet.
 * - A **trailing** average divides by the months that actually hold a figure,
 *   because the ledger says a missing month was never recorded — not that it was
 *   a month of zero. Dividing by the window would answer a question about a zero
 *   nobody wrote down.
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
  completenessOf,
  householdMonthSummary,
  isRecorded,
  personMonthSummary,
  readAmount,
} from "@/domain/ledger/ledger";
import {
  type CalendarMonth,
  addMonths,
  calendarMonth,
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
 * What an average over a period divides by.
 *
 * A past year divides by twelve. The current year divides by the months that have
 * elapsed, so a June reading of 2026 compares against a full 2025 rather than
 * looking half as expensive. A year that has not started has no elapsed months at
 * all, and an average over none of them is undefined rather than zero.
 *
 * `today` is a parameter and never read from the clock inside: a function that
 * asks the system for the time cannot be tested against a boundary.
 */
export function periodDenominator(period: Period, today: CalendarMonth): number {
  if (period.kind === "month") return 1;
  if (period.year < today.year) return 12;
  if (period.year > today.year) return 0;
  return today.month;
}

/** The months of a period that have actually elapsed, ascending. */
export function elapsedPeriodMonths(period: Period, today: CalendarMonth): readonly CalendarMonth[] {
  const count = periodDenominator(period, today);
  return periodMonths(period).slice(0, count);
}

// --- averages, which never travel without their denominator ------------------

export interface Average {
  readonly total: Money;
  /** `total ÷ denominator`. `null` when the denominator is zero — undefined, not nought. */
  readonly amount: Money | null;
  /** What the total was divided by. Displayed with every average; never implied. */
  readonly denominator: number;
  /** How many of those months hold a figure. A total over 3 of 12 months says so. */
  readonly recordedMonths: number;
}

function averageOf(total: Money, denominator: number, recordedMonths: number): Average {
  return {
    total,
    amount: denominator === 0 ? null : divide(total, denominator),
    denominator,
    recordedMonths,
  };
}

function averageOverMonths(
  ledger: Ledger,
  group: CategoryGroup,
  months: readonly CalendarMonth[],
  currency: Currency,
  denominator: number,
): Average {
  let total = zero(currency);
  let recordedMonths = 0;
  for (const month of months) {
    const reading = readGroupMonth(ledger, group, month, currency);
    total = add(total, reading.amount);
    if (reading.recorded) recordedMonths += 1;
  }
  return averageOf(total, denominator, recordedMonths);
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
      let total = zero(currency);
      let recordedMonths = 0;
      for (const past of trailingMonths) {
        const pastReading = readGroupMonth(ledger, group, past, currency);
        if (!pastReading.recorded) continue;
        total = add(total, pastReading.amount);
        recordedMonths += 1;
      }
      const trailing = averageOf(total, recordedMonths, recordedMonths);

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
  const denominator = periodDenominator(period, today);
  const months = elapsedPeriodMonths(period, today);

  const summaries = months.map((month) => summaryFor(ledger, categories, scope, month, currency));
  const recordedMonths = summaries.filter((summary) => summary.recordedCount > 0).length;
  const totalOf = (pick: (summary: MonthSummary) => Money) =>
    averageOf(sum(summaries.map(pick), currency), denominator, recordedMonths);

  const totals = {
    income: totalOf((summary) => summary.income),
    expenses: totalOf((summary) => summary.expenses),
    saving: totalOf((summary) => summary.saving),
  };

  const linesFor = (type: CategoryType, typeTotal: Money): readonly BreakdownLine[] =>
    groupsFor(categories, scope, { type })
      .map((group) => {
        const average = averageOverMonths(ledger, group, months, currency, denominator);
        return {
          ...identify(group),
          average,
          share: ratio(average.total, typeTotal),
          contributions: contributionsOf(ledger, group, months, currency, denominator, average.total),
        };
      })
      // A category with nothing recorded in the period is not a fact about it.
      .filter((line) => line.average.recordedMonths > 0)
      .sort(compareBreakdownLines);

  return {
    period,
    scope,
    denominator,
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
  denominator: number,
  groupTotal: Money,
): readonly BreakdownLine[] {
  if (group.members.length < 2) return [];

  const contributions = membersAsGroups(group)
    .map((member) => {
      const average = averageOverMonths(ledger, member, months, currency, denominator);
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
  const months = periodDenominator(yearPeriod(year), today);
  const comparisonYear = year - 1;

  const currentMonths = monthRange(calendarMonth(year, 1), calendarMonth(year, 12)).slice(0, months);
  const previousMonths = monthRange(
    calendarMonth(comparisonYear, 1),
    calendarMonth(comparisonYear, 12),
  ).slice(0, months);

  const lines = groupsFor(categories, scope, { type: options.type }).flatMap<YearOverYearLine>((group) => {
    const current = averageOverMonths(ledger, group, currentMonths, currency, months);
    const existedBefore = previousMonths.some((month) =>
      group.members.some((member) => isActiveIn(member, month) || isRecorded(ledger, member.id, month)),
    );
    const previous = existedBefore
      ? averageOverMonths(ledger, group, previousMonths, currency, months)
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
