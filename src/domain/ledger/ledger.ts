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
  type PersonalCategory,
  personalCategoriesFor,
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

/** One person's categories for a month, each with its reading or the absence of one. */
export function personMonthLines(
  ledger: Ledger,
  categories: Categories,
  personId: string,
  month: CalendarMonth,
  options: { readonly type?: CategoryType } = {},
): readonly CategoryLine[] {
  return personalCategoriesFor(categories, personId, options).map((category) => ({
    category,
    reading: readAmount(ledger, category.id, month),
  }));
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
  const lines = personMonthLines(ledger, categories, personId, month);

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
