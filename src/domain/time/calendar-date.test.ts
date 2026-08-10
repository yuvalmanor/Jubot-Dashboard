import { describe, expect, it } from "vitest";

import {
  InvalidCalendarDateError,
  calendarDate,
  compareDates,
  dateKey,
  dateOf,
  datesEqual,
  formatDate,
  parseDateKey,
  tryParseDateKey,
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

describe("dateOf", () => {
  it("reads the local calendar day of a moment, taking the clock as a parameter", () => {
    expect(dateOf(new Date(2025, 7, 31, 23, 30))).toEqual(calendarDate(2025, 8, 31));
  });
});

describe("formatDate", () => {
  it("formats in Hebrew and names the year", () => {
    const text = formatDate(calendarDate(2025, 8, 31));
    expect(text).toContain("2025");
    expect(text).toContain("31");
  });
});
