/**
 * CalendarMonth — a real calendar month, the key of the מאזן.
 *
 * Framework-free per ADR 0004.
 *
 * The sheet this replaces kept July–June tabs, so a figure's year was a matter of
 * which table it had been typed into. Here a month is (year, month) and nothing
 * else: 2024-12 and 2025-01 are adjacent, and no year boundary needs stitching.
 *
 * Months are compared and stepped through as a single ordinal — `year * 12 +
 * month` — so arithmetic across a year boundary is the same arithmetic as within
 * one.
 */

export interface CalendarMonth {
  readonly year: number;
  /** 1–12. January is 1, not 0 — this is a calendar month, not a Date field. */
  readonly month: number;
}

export class InvalidCalendarMonthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCalendarMonthError";
  }
}

export function calendarMonth(year: number, month: number): CalendarMonth {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new InvalidCalendarMonthError(`Year must be an integer between 2000 and 2100, received ${String(year)}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new InvalidCalendarMonthError(`Month must be an integer between 1 and 12, received ${String(month)}`);
  }
  return { year, month };
}

/** Stable string form, `2025-07`. Sorts correctly as text, which makes it a safe map key. */
export function monthKey(month: CalendarMonth): string {
  return `${String(month.year).padStart(4, "0")}-${String(month.month).padStart(2, "0")}`;
}

const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/;

export function parseMonthKey(text: string): CalendarMonth {
  const match = MONTH_KEY_PATTERN.exec(text.trim());
  if (match === null) {
    throw new InvalidCalendarMonthError(`Expected a month of the form YYYY-MM, received ${JSON.stringify(text)}`);
  }
  return calendarMonth(Number(match[1]), Number(match[2]));
}

/** Returns the parsed month, or `null` for anything unparseable. For untrusted input. */
export function tryParseMonthKey(text: string | undefined | null): CalendarMonth | null {
  if (typeof text !== "string") return null;
  try {
    return parseMonthKey(text);
  } catch {
    return null;
  }
}

function ordinal(month: CalendarMonth): number {
  return month.year * 12 + (month.month - 1);
}

export function compareMonths(left: CalendarMonth, right: CalendarMonth): -1 | 0 | 1 {
  const a = ordinal(left);
  const b = ordinal(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function monthsEqual(left: CalendarMonth, right: CalendarMonth): boolean {
  return left.year === right.year && left.month === right.month;
}

/** Signed distance in months. Negative when `to` precedes `from`. */
export function monthsBetween(from: CalendarMonth, to: CalendarMonth): number {
  return ordinal(to) - ordinal(from);
}

export function addMonths(month: CalendarMonth, count: number): CalendarMonth {
  if (!Number.isInteger(count)) {
    throw new InvalidCalendarMonthError(`Step must be a whole number of months, received ${String(count)}`);
  }
  const moved = ordinal(month) + count;
  return calendarMonth(Math.floor(moved / 12), (moved % 12) + 1);
}

/** Inclusive range, ascending. The continuous ledger, materialised. */
export function monthRange(from: CalendarMonth, to: CalendarMonth): CalendarMonth[] {
  const span = monthsBetween(from, to);
  if (span < 0) return [];
  return Array.from({ length: span + 1 }, (_unused, index) => addMonths(from, index));
}

/**
 * The month a moment falls in. The clock is a parameter, never read from inside —
 * a function that asks the system for the time cannot be tested against a boundary.
 */
export function monthOf(moment: Date): CalendarMonth {
  return calendarMonth(moment.getFullYear(), moment.getMonth() + 1);
}

/** Hebrew by default, e.g. `יולי 2025`. */
export function formatMonth(month: CalendarMonth, locale = "he-IL"): string {
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(
    new Date(month.year, month.month - 1, 1),
  );
}

/** The month's name alone, e.g. `יולי`. For a range whose year is stated once. */
export function formatMonthName(month: CalendarMonth, locale = "he-IL"): string {
  return new Intl.DateTimeFormat(locale, { month: "long" }).format(
    new Date(month.year, month.month - 1, 1),
  );
}

/**
 * An inclusive range of months, e.g. `יולי–דצמבר 2024`. A range inside one year
 * names the year once; a range that crosses one names it on both sides, because
 * `דצמבר–ינואר` alone does not say which December.
 */
export function formatMonthRange(from: CalendarMonth, to: CalendarMonth, locale = "he-IL"): string {
  if (monthsEqual(from, to)) return formatMonth(from, locale);
  if (from.year === to.year) {
    return `${formatMonthName(from, locale)}–${formatMonthName(to, locale)} ${String(from.year)}`;
  }
  return `${formatMonth(from, locale)}–${formatMonth(to, locale)}`;
}

/**
 * Whether an ascending list of months runs without a gap.
 *
 * A count and a range are the same statement only when this holds. Two months
 * drawn out of a six-month window are not "פברואר–מאי", and a screen that printed
 * them as one would be claiming four months' worth of evidence for two.
 */
export function monthsAreContiguous(months: readonly CalendarMonth[]): boolean {
  const first = months[0];
  const last = months[months.length - 1];
  if (first === undefined || last === undefined) return true;
  return monthsBetween(first, last) + 1 === months.length;
}
