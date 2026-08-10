/**
 * Ledger — Entries: one amount, for one Personal Category, in one calendar month.
 *
 * Framework-free per ADR 0004.
 *
 * ADR 0001 leaves a seam open: a category-month's amount is *either* entered by
 * hand *or* derived from dated transactions, and which one applies is not the
 * reader's business. `readAmount` is that single accessor. Only the entered side
 * has a producer today; the derived side is built and tested here so that when
 * transaction import arrives, nothing that reads amounts has to change.
 *
 * The two sources are mutually exclusive by construction: a category-month
 * carrying both is a contradiction with no non-arbitrary resolution, so
 * `buildLedger` refuses it rather than picking one.
 *
 * A month that was never recorded is `null`, which is a different fact from a
 * month recorded as zero. Nothing here ever turns the first into the second.
 */

import {
  type CategoryType,
  type Categories,
  type HouseholdCategory,
  type PersonalCategory,
  allPersonalCategories,
  householdCategoriesFor,
  isActiveIn,
  personalCategoriesFor,
  personalCategoriesOf,
} from "@/domain/categories/categories";
import { type Currency, type Money, add, subtract, sum, zero } from "@/domain/money/money";
import { type CalendarMonth, compareMonths, monthKey, parseMonthKey } from "@/domain/time/calendar-month";

/** A hand-entered amount for a category-month. The only producer in this phase. */
export interface EnteredEntry {
  readonly personalCategoryId: string;
  readonly month: CalendarMonth;
  readonly amount: Money;
}

/** A dated transaction backing a category-month. No producer yet — the seam of ADR 0001. */
export interface BackingTransaction {
  readonly personalCategoryId: string;
  readonly month: CalendarMonth;
  readonly amount: Money;
}

/**
 * What a category-month is worth, and where the figure came from. Callers that
 * only want the number read `.amount`; the source is there for the screens that
 * must say whether a figure was typed or measured.
 */
export type LedgerReading =
  | { readonly source: "entered"; readonly amount: Money }
  | { readonly source: "derived"; readonly amount: Money; readonly transactionCount: number };

export interface Ledger {
  /** Keyed `${personalCategoryId}@${YYYY-MM}`. Absent means not recorded. */
  readonly readings: ReadonlyMap<string, LedgerReading>;
}

export class ConflictingEntrySourceError extends Error {
  constructor(
    readonly personalCategoryId: string,
    readonly month: CalendarMonth,
  ) {
    super(
      `Category ${personalCategoryId} for ${monthKey(month)} is both entered and transaction-backed; ` +
        "a category-month has exactly one source (ADR 0001)",
    );
    this.name = "ConflictingEntrySourceError";
  }
}

export class DuplicateEntryError extends Error {
  constructor(
    readonly personalCategoryId: string,
    readonly month: CalendarMonth,
  ) {
    super(`Category ${personalCategoryId} has more than one entered amount for ${monthKey(month)}`);
    this.name = "DuplicateEntryError";
  }
}

function readingKey(personalCategoryId: string, month: CalendarMonth): string {
  return `${personalCategoryId}@${monthKey(month)}`;
}

export const EMPTY_LEDGER: Ledger = { readings: new Map() };

export function buildLedger(input: {
  readonly entered?: readonly EnteredEntry[];
  readonly transactions?: readonly BackingTransaction[];
}): Ledger {
  const readings = new Map<string, LedgerReading>();

  for (const entry of input.entered ?? []) {
    const key = readingKey(entry.personalCategoryId, entry.month);
    if (readings.has(key)) {
      throw new DuplicateEntryError(entry.personalCategoryId, entry.month);
    }
    readings.set(key, { source: "entered", amount: entry.amount });
  }

  const grouped = new Map<string, { transactions: BackingTransaction[]; month: CalendarMonth; id: string }>();
  for (const transaction of input.transactions ?? []) {
    const key = readingKey(transaction.personalCategoryId, transaction.month);
    const group = grouped.get(key);
    if (group === undefined) {
      grouped.set(key, {
        transactions: [transaction],
        month: transaction.month,
        id: transaction.personalCategoryId,
      });
    } else {
      group.transactions.push(transaction);
    }
  }

  for (const [key, group] of grouped) {
    if (readings.has(key)) {
      throw new ConflictingEntrySourceError(group.id, group.month);
    }
    readings.set(key, {
      source: "derived",
      amount: sum(group.transactions.map((transaction) => transaction.amount)),
      transactionCount: group.transactions.length,
    });
  }

  return { readings };
}

/**
 * The one read path for a category-month. `null` means the month was never
 * recorded — a fact the screens must keep distinct from a recorded zero.
 */
export function readAmount(
  ledger: Ledger,
  personalCategoryId: string,
  month: CalendarMonth,
): LedgerReading | null {
  return ledger.readings.get(readingKey(personalCategoryId, month)) ?? null;
}

export function isRecorded(ledger: Ledger, personalCategoryId: string, month: CalendarMonth): boolean {
  return ledger.readings.has(readingKey(personalCategoryId, month));
}

/** Every month holding at least one reading, ascending. One continuous ledger, no year seams. */
export function recordedMonths(ledger: Ledger): CalendarMonth[] {
  const keys = new Set<string>();
  for (const key of ledger.readings.keys()) {
    keys.add(key.slice(key.indexOf("@") + 1));
  }
  return [...keys].map(parseMonthKey).sort(compareMonths);
}

export interface CategoryLine {
  readonly category: PersonalCategory;
  /** `null` when this category has no figure for the month. */
  readonly reading: LedgerReading | null;
}

/**
 * Whether a category belongs on a month's screen.
 *
 * A category's lifespan decides what is *offered* — a retired one drops off the
 * current month, and one created last year does not appear before it existed. A
 * recorded figure overrides that entirely: money that was written down is always
 * shown, whatever the lifespan since became. Retiring a category can therefore
 * never make a past month read differently than it did.
 */
function appearsIn(ledger: Ledger, category: PersonalCategory, month: CalendarMonth): boolean {
  return isActiveIn(category, month) || isRecorded(ledger, category.id, month);
}

function linesFor(
  ledger: Ledger,
  personal: readonly PersonalCategory[],
  month: CalendarMonth,
): readonly CategoryLine[] {
  return personal
    .filter((category) => appearsIn(ledger, category, month))
    .map((category) => ({ category, reading: readAmount(ledger, category.id, month) }));
}

/** One person's categories for a month, each with its reading or the absence of one. */
export function personMonthLines(
  ledger: Ledger,
  categories: Categories,
  personId: string,
  month: CalendarMonth,
  options: { readonly type?: CategoryType } = {},
): readonly CategoryLine[] {
  return linesFor(ledger, personalCategoriesFor(categories, personId, options), month);
}

/** Both people's categories for a month. What the household level is derived from. */
export function householdMonthLines(
  ledger: Ledger,
  categories: Categories,
  month: CalendarMonth,
  options: { readonly type?: CategoryType } = {},
): readonly CategoryLine[] {
  return linesFor(ledger, allPersonalCategories(categories, options), month);
}

export interface MonthSummary {
  readonly month: CalendarMonth;
  readonly income: Money;
  readonly expenses: Money;
  /** Always `income − expenses`. Computed on read; there is nowhere to write it. */
  readonly saving: Money;
  /** How many of `categoryCount` categories have a figure — a half-entered month is visible. */
  readonly recordedCount: number;
  readonly categoryCount: number;
}

function summarise(
  lines: readonly CategoryLine[],
  month: CalendarMonth,
  currency: Currency,
): MonthSummary {
  let income = zero(currency);
  let expenses = zero(currency);
  let recordedCount = 0;

  for (const line of lines) {
    if (line.reading === null) continue;
    recordedCount += 1;
    if (line.category.type === "income") {
      income = add(income, line.reading.amount);
    } else {
      expenses = add(expenses, line.reading.amount);
    }
  }

  return {
    month,
    income,
    expenses,
    saving: subtract(income, expenses),
    recordedCount,
    categoryCount: lines.length,
  };
}

/**
 * חיסכון for one Person for one month. The currency is explicit because an empty
 * month has no currency of its own, and a total that guessed one would be a lie
 * about which money it counted.
 */
export function personMonthSummary(
  ledger: Ledger,
  categories: Categories,
  personId: string,
  month: CalendarMonth,
  currency: Currency,
): MonthSummary {
  return summarise(personMonthLines(ledger, categories, personId, month), month, currency);
}

/**
 * חיסכון for the Household for one month — the same arithmetic over both People's
 * categories. It is derived here and nowhere stored: there is no household ledger
 * to write to, and no path in this module that would accept one.
 */
export function householdMonthSummary(
  ledger: Ledger,
  categories: Categories,
  month: CalendarMonth,
  currency: Currency,
): MonthSummary {
  return summarise(householdMonthLines(ledger, categories, month), month, currency);
}

/**
 * Whether a month has been fully recorded. A month with some categories filled and
 * some not is `partial` — it must never be read as a cheap month, only as an
 * unfinished one.
 */
export type MonthCompleteness = "empty" | "partial" | "complete";

export function completenessOf(summary: MonthSummary): MonthCompleteness {
  if (summary.recordedCount === 0) return "empty";
  return summary.recordedCount === summary.categoryCount ? "complete" : "partial";
}

/** One Household Category's figure for a month, and the personal ones that produced it. */
export interface HouseholdCategoryLine {
  readonly household: HouseholdCategory;
  /** The sum of the contributions below. Never stored, never entered. */
  readonly amount: Money;
  /** The drill-down: every contributing Personal Category, recorded or not. */
  readonly contributions: readonly CategoryLine[];
  readonly recordedCount: number;
  readonly categoryCount: number;
}

/**
 * The household reading of a month, one line per Household Category, each
 * carrying the Personal Categories underneath it. A household figure is never
 * anything but the sum of what is shown beneath it, so drilling into one can
 * always account for it exactly.
 *
 * A Household Category with nothing feeding it in this month is left out rather
 * than shown as a zero: an empty line is not a fact about the month.
 */
export function householdCategoryLines(
  ledger: Ledger,
  categories: Categories,
  month: CalendarMonth,
  currency: Currency,
  options: { readonly type?: CategoryType } = {},
): readonly HouseholdCategoryLine[] {
  return householdCategoriesFor(categories, options).flatMap((household) => {
    const contributions = linesFor(ledger, personalCategoriesOf(categories, household.id), month);
    if (contributions.length === 0) return [];

    const amounts = contributions.flatMap((line) => (line.reading === null ? [] : [line.reading.amount]));
    return [
      {
        household,
        amount: sum(amounts, currency),
        contributions,
        recordedCount: amounts.length,
        categoryCount: contributions.length,
      },
    ];
  });
}
