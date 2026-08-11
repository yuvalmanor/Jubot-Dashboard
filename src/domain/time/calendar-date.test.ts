import { describe, expect, it } from "vitest";

import { calendarMonth } from "./calendar-month";
import {
  InvalidCalendarDateError,
  addDays,
  addMonths,
  calendarDate,
  compareDates,
  containsWholeMonth,
  dateKey,
  dateOf,
  datesEqual,
  firstDayOf,
  formatDate,
  lastDayOf,
  monthContaining,
  parseDateKey,
  tryParseDateKey,
  wholeYearsBetween,
} from "./calendar-date";

describe("calendarDate", () => {
  it("takes a real day", () => {
    expect(calendarDate(2025, 8, 31)).toEqual({ year: 2025, month: 8, day: 31 });
  });

  it("refuses a day the month does not have", () => {
    expect(() => calendarDate(2025, 6, 31)).toThrow(InvalidCalendarDateError);
    expect(() => calendarDate(2025, 2, 29)).toThrow(InvalidCalendarDateError);
  });

  it("takes the 29th of February in a leap year", () => {
    expect(calendarDate(2024, 2, 29).day).toBe(29);
  });

  it("refuses a month outside 1–12 and a year outside the supported range", () => {
    expect(() => calendarDate(2025, 0, 1)).toThrow(InvalidCalendarDateError);
    expect(() => calendarDate(2025, 13, 1)).toThrow(InvalidCalendarDateError);
    expect(() => calendarDate(1999, 1, 1)).toThrow(InvalidCalendarDateError);
  });
});

describe("dateKey", () => {
  it("zero-pads so the text sorts as the calendar does", () => {
    expect(dateKey(calendarDate(2025, 1, 5))).toBe("2025-01-05");
    expect(dateKey(calendarDate(2025, 1, 5)) < dateKey(calendarDate(2025, 1, 12))).toBe(true);
    expect(dateKey(calendarDate(2024, 12, 31)) < dateKey(calendarDate(2025, 1, 1))).toBe(true);
  });

  it("round-trips through parseDateKey", () => {
    const date = calendarDate(2026, 2, 28);
    expect(parseDateKey(dateKey(date))).toEqual(date);
  });

  it("refuses anything that is not YYYY-MM-DD", () => {
    expect(() => parseDateKey("2025-8-3")).toThrow(InvalidCalendarDateError);
    expect(() => parseDateKey("31/08/2025")).toThrow(InvalidCalendarDateError);
  });
});

describe("tryParseDateKey", () => {
  it("answers null rather than throwing, for untrusted input", () => {
    expect(tryParseDateKey("nonsense")).toBeNull();
    expect(tryParseDateKey(undefined)).toBeNull();
    expect(tryParseDateKey("2025-02-30")).toBeNull();
    expect(tryParseDateKey("2025-02-28")).toEqual(calendarDate(2025, 2, 28));
  });
});

describe("compareDates", () => {
  it("orders across month and year boundaries", () => {
    expect(compareDates(calendarDate(2024, 12, 31), calendarDate(2025, 1, 1))).toBe(-1);
    expect(compareDates(calendarDate(2025, 1, 1), calendarDate(2024, 12, 31))).toBe(1);
    expect(compareDates(calendarDate(2025, 3, 9), calendarDate(2025, 3, 9))).toBe(0);
  });

  it("agrees with datesEqual", () => {
    expect(datesEqual(calendarDate(2025, 3, 9), calendarDate(2025, 3, 9))).toBe(true);
    expect(datesEqual(calendarDate(2025, 3, 9), calendarDate(2025, 3, 10))).toBe(false);
  });
});

describe("wholeYearsBetween", () => {
  it("counts completed anniversaries and never a fraction of one", () => {
    expect(wholeYearsBetween(calendarDate(2023, 6, 15), calendarDate(2025, 12, 31))).toBe(2);
    expect(wholeYearsBetween(calendarDate(2023, 6, 15), calendarDate(2024, 5, 31))).toBe(0);
  });

  it("is exact on the day before, the day of, and the day after the anniversary", () => {
    const opened = calendarDate(2023, 6, 15);
    expect(wholeYearsBetween(opened, calendarDate(2024, 6, 14))).toBe(0);
    expect(wholeYearsBetween(opened, calendarDate(2024, 6, 15))).toBe(1);
    expect(wholeYearsBetween(opened, calendarDate(2024, 6, 16))).toBe(1);
  });

  it("counts a span that runs backwards as nought, never as a negative year", () => {
    expect(wholeYearsBetween(calendarDate(2025, 1, 1), calendarDate(2023, 1, 1))).toBe(0);
  });
});

describe("dateOf", () => {
  it("reads the local calendar day of a moment, taking the clock as a parameter", () => {
    expect(dateOf(new Date(2025, 7, 31, 23, 30))).toEqual(calendarDate(2025, 8, 31));
  });
});

describe("the month a day belongs to", () => {
  it("names the month, and the first and last day of it", () => {
    expect(monthContaining(calendarDate(2025, 2, 17))).toEqual(calendarMonth(2025, 2));
    expect(firstDayOf(calendarMonth(2025, 2))).toEqual(calendarDate(2025, 2, 1));
    expect(lastDayOf(calendarMonth(2025, 2))).toEqual(calendarDate(2025, 2, 28));
    // A leap February, read off the calendar rather than off a table of 28s.
    expect(lastDayOf(calendarMonth(2024, 2))).toEqual(calendarDate(2024, 2, 29));
  });

  it("contains a whole month only when it contains every day of it", () => {
    const march = calendarMonth(2025, 3);

    expect(containsWholeMonth(calendarDate(2025, 3, 1), calendarDate(2025, 3, 31), march)).toBe(true);
    // Month ends and month firsts both read the month whole, so the household's
    // choice of when to take a snapshot does not decide what may be compared.
    expect(containsWholeMonth(calendarDate(2025, 2, 28), calendarDate(2025, 4, 1), march)).toBe(true);
    expect(containsWholeMonth(calendarDate(2025, 3, 2), calendarDate(2025, 3, 31), march)).toBe(false);
    expect(containsWholeMonth(calendarDate(2025, 3, 1), calendarDate(2025, 3, 30), march)).toBe(false);
  });
});

describe("moving a date", () => {
  it("adds and subtracts whole days across every boundary", () => {
    expect(addDays(calendarDate(2025, 8, 31), 1)).toEqual(calendarDate(2025, 9, 1));
    expect(addDays(calendarDate(2025, 1, 1), -1)).toEqual(calendarDate(2024, 12, 31));
    expect(addDays(calendarDate(2024, 2, 28), 1)).toEqual(calendarDate(2024, 2, 29));
    expect(addDays(calendarDate(2025, 2, 28), 1)).toEqual(calendarDate(2025, 3, 1));
    expect(addDays(calendarDate(2025, 6, 10), 0)).toEqual(calendarDate(2025, 6, 10));
  });

  it("adds months onto the same day of the month, not onto a count of days", () => {
    expect(addMonths(calendarDate(2024, 1, 15), 24)).toEqual(calendarDate(2026, 1, 15));
    expect(addMonths(calendarDate(2024, 11, 30), 2)).toEqual(calendarDate(2025, 1, 30));
    expect(addMonths(calendarDate(2025, 3, 15), -3)).toEqual(calendarDate(2024, 12, 15));
    expect(addMonths(calendarDate(2025, 6, 10), 0)).toEqual(calendarDate(2025, 6, 10));
  });

  it("clamps to the last day of a month that has no such date", () => {
    // The 31st of a 30-day month, and the 29th of a February that has 28 days:
    // both are dates that never arrive, and the count cannot run past them.
    expect(addMonths(calendarDate(2025, 1, 31), 1)).toEqual(calendarDate(2025, 2, 28));
    expect(addMonths(calendarDate(2024, 2, 29), 24)).toEqual(calendarDate(2026, 2, 28));
    expect(addMonths(calendarDate(2025, 5, 31), 1)).toEqual(calendarDate(2025, 6, 30));
  });

  it("refuses a fraction of a day or of a month", () => {
    expect(() => addDays(calendarDate(2025, 6, 10), 1.5)).toThrow(InvalidCalendarDateError);
    expect(() => addMonths(calendarDate(2025, 6, 10), 0.5)).toThrow(InvalidCalendarDateError);
  });
});

describe("formatDate", () => {
  it("formats in Hebrew and names the year", () => {
    const text = formatDate(calendarDate(2025, 8, 31));
    expect(text).toContain("2025");
    expect(text).toContain("31");
  });
});
