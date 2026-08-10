/**
 * CalendarDate — a real calendar day, the key of the מיפוי.
 *
 * Framework-free per ADR 0004.
 *
 * The מאזן needs only months (see calendar-month); a Snapshot is taken on a day,
 * with no cadence, so it needs one more field. It is `{year, month, day}` and not
 * a `Date` for the same reason a month is not: a `Date` is a moment on a timeline,
 * and a moment crossing a timezone is one of the few ways "the snapshot of the
 * 31st" quietly becomes the snapshot of the 30th.
 *
 * Dates are compared as their `YYYY-MM-DD` text, which orders correctly because
 * every field is zero-padded and fixed width.
 */

export interface CalendarDate {
  readonly year: number;
  /** 1–12. January is 1, not 0. */
  readonly month: number;
  /** 1–31, checked against the actual length of the month. */
  readonly day: number;
}

export class InvalidCalendarDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCalendarDateError";
  }
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function calendarDate(year: number, month: number, day: number): CalendarDate {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new InvalidCalendarDateError(`Year must be an integer between 2000 and 2100, received ${String(year)}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new InvalidCalendarDateError(`Month must be an integer between 1 and 12, received ${String(month)}`);
  }
  const length = daysInMonth(year, month);
  if (!Number.isInteger(day) || day < 1 || day > length) {
    throw new InvalidCalendarDateError(
      `Day must be an integer between 1 and ${length} for ${year}-${month}, received ${String(day)}`,
    );
  }
  return { year, month, day };
}

/** `2025-08-31`. Sorts correctly as text, which makes it a safe key and a safe order-by. */
export function dateKey(date: CalendarDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateKey(text: string): CalendarDate {
  const match = DATE_KEY_PATTERN.exec(text.trim());
  if (match === null) {
    throw new InvalidCalendarDateError(
      `Expected a date of the form YYYY-MM-DD, received ${JSON.stringify(text)}`,
    );
  }
  return calendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** Returns the parsed date, or `null` for anything unparseable. For untrusted input. */
export function tryParseDateKey(text: string | undefined | null): CalendarDate | null {
  if (typeof text !== "string") return null;
  try {
    return parseDateKey(text);
  } catch {
    return null;
  }
}

export function compareDates(left: CalendarDate, right: CalendarDate): -1 | 0 | 1 {
  const a = dateKey(left);
  const b = dateKey(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function datesEqual(left: CalendarDate, right: CalendarDate): boolean {
  return compareDates(left, right) === 0;
}

/**
 * The day a moment falls on. The clock is a parameter, never read from inside — a
 * function that asks the system for today cannot be tested against a boundary.
 */
export function dateOf(moment: Date): CalendarDate {
  return calendarDate(moment.getFullYear(), moment.getMonth() + 1, moment.getDate());
}

/** Hebrew by default, e.g. `31 באוגוסט 2025`. */
export function formatDate(date: CalendarDate, locale = "he-IL"): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(
    new Date(date.year, date.month - 1, date.day),
  );
}
