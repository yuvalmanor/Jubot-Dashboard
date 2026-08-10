import { describe, expect, it } from "vitest";

import {
  InvalidCalendarMonthError,
  addMonths,
  calendarMonth,
  compareMonths,
  formatMonth,
  monthKey,
  monthOf,
  monthRange,
  monthsBetween,
  monthsEqual,
  parseMonthKey,
  tryParseMonthKey,
} from "./calendar-month";

describe("calendarMonth", () => {
  it("holds a real calendar month with January as 1", () => {
    expect(calendarMonth(2025, 1)).toEqual({ year: 2025, month: 1 });
    expect(calendarMonth(2025, 12)).toEqual({ year: 2025, month: 12 });
  });

  it("refuses a month outside 1–12", () => {
    expect(() => calendarMonth(2025, 0)).toThrow(InvalidCalendarMonthError);
    expect(() => calendarMonth(2025, 13)).toThrow(InvalidCalendarMonthError);
  });

  it("refuses a non-integer month", () => {
    expect(() => calendarMonth(2025, 6.5)).toThrow(InvalidCalendarMonthError);
  });
});

describe("month keys", () => {
  it("pads to a sortable YYYY-MM", () => {
    expect(monthKey(calendarMonth(2025, 7))).toBe("2025-07");
    expect(monthKey(calendarMonth(2025, 12))).toBe("2025-12");
  });

  it("sorts as text in calendar order across a year boundary", () => {
    const keys = [
      monthKey(calendarMonth(2025, 1)),
      monthKey(calendarMonth(2024, 12)),
      monthKey(calendarMonth(2024, 2)),
    ].sort();
    expect(keys).toEqual(["2024-02", "2024-12", "2025-01"]);
  });

  it("round-trips through parseMonthKey", () => {
    const month = calendarMonth(2022, 3);
    expect(parseMonthKey(monthKey(month))).toEqual(month);
  });

  it("rejects anything that is not YYYY-MM", () => {
    expect(() => parseMonthKey("2025-7")).toThrow(InvalidCalendarMonthError);
    expect(() => parseMonthKey("July 2025")).toThrow(InvalidCalendarMonthError);
    expect(() => parseMonthKey("2025-13")).toThrow(InvalidCalendarMonthError);
  });

  it("tryParseMonthKey returns null instead of throwing, for untrusted input", () => {
    expect(tryParseMonthKey("2025-07")).toEqual(calendarMonth(2025, 7));
    expect(tryParseMonthKey("nonsense")).toBeNull();
    expect(tryParseMonthKey(undefined)).toBeNull();
    expect(tryParseMonthKey(null)).toBeNull();
  });
});

describe("ordering and arithmetic", () => {
  it("orders months across a year boundary", () => {
    expect(compareMonths(calendarMonth(2024, 12), calendarMonth(2025, 1))).toBe(-1);
    expect(compareMonths(calendarMonth(2025, 1), calendarMonth(2024, 12))).toBe(1);
    expect(compareMonths(calendarMonth(2025, 1), calendarMonth(2025, 1))).toBe(0);
  });

  it("counts months across a year boundary the same way as within one", () => {
    expect(monthsBetween(calendarMonth(2024, 12), calendarMonth(2025, 1))).toBe(1);
    expect(monthsBetween(calendarMonth(2024, 1), calendarMonth(2024, 2))).toBe(1);
    expect(monthsBetween(calendarMonth(2022, 1), calendarMonth(2026, 1))).toBe(48);
  });

  it("reports a negative distance when the target precedes the origin", () => {
    expect(monthsBetween(calendarMonth(2025, 1), calendarMonth(2024, 12))).toBe(-1);
  });

  it("steps forward and backward over year boundaries", () => {
    expect(addMonths(calendarMonth(2024, 12), 1)).toEqual(calendarMonth(2025, 1));
    expect(addMonths(calendarMonth(2025, 1), -1)).toEqual(calendarMonth(2024, 12));
    expect(addMonths(calendarMonth(2025, 3), 24)).toEqual(calendarMonth(2027, 3));
    expect(addMonths(calendarMonth(2025, 3), -27)).toEqual(calendarMonth(2022, 12));
  });

  it("is its own inverse", () => {
    const month = calendarMonth(2023, 8);
    expect(addMonths(addMonths(month, 17), -17)).toEqual(month);
  });

  it("compares equality by value", () => {
    expect(monthsEqual(calendarMonth(2025, 5), calendarMonth(2025, 5))).toBe(true);
    expect(monthsEqual(calendarMonth(2025, 5), calendarMonth(2024, 5))).toBe(false);
  });
});

describe("monthRange", () => {
  it("is inclusive at both ends and continuous across years", () => {
    expect(monthRange(calendarMonth(2024, 11), calendarMonth(2025, 2))).toEqual([
      calendarMonth(2024, 11),
      calendarMonth(2024, 12),
      calendarMonth(2025, 1),
      calendarMonth(2025, 2),
    ]);
  });

  it("is a single month when both ends are the same", () => {
    expect(monthRange(calendarMonth(2025, 6), calendarMonth(2025, 6))).toEqual([calendarMonth(2025, 6)]);
  });

  it("is empty when the range runs backwards", () => {
    expect(monthRange(calendarMonth(2025, 6), calendarMonth(2025, 5))).toEqual([]);
  });
});

describe("monthOf", () => {
  it("takes the month from a moment, with the clock supplied by the caller", () => {
    expect(monthOf(new Date(2025, 0, 31, 23, 59))).toEqual(calendarMonth(2025, 1));
    expect(monthOf(new Date(2025, 11, 1))).toEqual(calendarMonth(2025, 12));
  });
});

describe("formatMonth", () => {
  it("reads in Hebrew by default", () => {
    expect(formatMonth(calendarMonth(2025, 7))).toContain("2025");
    expect(formatMonth(calendarMonth(2025, 7))).toContain("יולי");
  });
});
