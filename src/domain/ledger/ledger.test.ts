import { describe, expect, it } from "vitest";

import {
  type Categories,
  EMPTY_CATEGORIES,
  applyCreation,
  planPersonalCategoryCreation,
} from "@/domain/categories/categories";
import { CurrencyMismatchError, money } from "@/domain/money/money";
import { calendarMonth } from "@/domain/time/calendar-month";

import {
  ConflictingEntrySourceError,
  DuplicateEntryError,
  EMPTY_LEDGER,
  buildLedger,
  isRecorded,
  personMonthLines,
  personMonthSummary,
  readAmount,
  recordedMonths,
} from "./ledger";

const JAN_2025 = calendarMonth(2025, 1);
const FEB_2025 = calendarMonth(2025, 2);
const DEC_2024 = calendarMonth(2024, 12);

const ils = (major: number) => money(major * 100, "ILS");

/** Yuval: one income category and two expense categories. */
function yuvalCategories(): Categories {
  const specs = [
    { name: "משכורת", type: "income" as const, key: "salary" },
    { name: "בריאות", type: "expense" as const, key: "health" },
    { name: "חשמל", type: "expense" as const, key: "power" },
  ];
  return specs.reduce<Categories>(
    (categories, spec) =>
      applyCreation(
        categories,
        planPersonalCategoryCreation(
          categories,
          {
            personId: "yuval",
            name: spec.name,
            type: spec.type,
            activeFrom: calendarMonth(2022, 1),
            household: { kind: "new", name: spec.name },
          },
          { personalCategoryId: `p-${spec.key}`, householdCategoryId: `h-${spec.key}` },
        ),
      ),
    EMPTY_CATEGORIES,
  );
}

describe("readAmount", () => {
  it("returns the entered amount as exact minor units", () => {
    const ledger = buildLedger({
      entered: [{ personalCategoryId: "p-health", month: JAN_2025, amount: money(45_012, "ILS") }],
    });

    expect(readAmount(ledger, "p-health", JAN_2025)).toEqual({
      source: "entered",
      amount: { minorUnits: 45_012, currency: "ILS" },
    });
  });

  it("distinguishes a month that was never recorded from a month recorded as zero", () => {
    const ledger = buildLedger({
      entered: [{ personalCategoryId: "p-health", month: JAN_2025, amount: ils(0) }],
    });

    expect(readAmount(ledger, "p-health", JAN_2025)).toEqual({
      source: "entered",
      amount: { minorUnits: 0, currency: "ILS" },
    });
    expect(readAmount(ledger, "p-health", FEB_2025)).toBeNull();

    expect(isRecorded(ledger, "p-health", JAN_2025)).toBe(true);
    expect(isRecorded(ledger, "p-health", FEB_2025)).toBe(false);
  });

  it("keeps each category-month separate", () => {
    const ledger = buildLedger({
      entered: [
        { personalCategoryId: "p-health", month: JAN_2025, amount: ils(100) },
        { personalCategoryId: "p-power", month: JAN_2025, amount: ils(200) },
        { personalCategoryId: "p-health", month: FEB_2025, amount: ils(300) },
      ],
    });

    expect(readAmount(ledger, "p-health", JAN_2025)?.amount.minorUnits).toBe(10_000);
    expect(readAmount(ledger, "p-power", JAN_2025)?.amount.minorUnits).toBe(20_000);
    expect(readAmount(ledger, "p-health", FEB_2025)?.amount.minorUnits).toBe(30_000);
    expect(readAmount(ledger, "p-power", FEB_2025)).toBeNull();
  });

  it("reads nothing from an empty ledger", () => {
    expect(readAmount(EMPTY_LEDGER, "p-health", JAN_2025)).toBeNull();
  });
});

describe("the entered / derived seam (ADR 0001)", () => {
  it("derives an amount from backing transactions and reports how many", () => {
    const ledger = buildLedger({
      transactions: [
        { personalCategoryId: "p-health", month: JAN_2025, amount: money(12_050, "ILS") },
        { personalCategoryId: "p-health", month: JAN_2025, amount: money(7_925, "ILS") },
      ],
    });

    expect(readAmount(ledger, "p-health", JAN_2025)).toEqual({
      source: "derived",
      amount: { minorUnits: 19_975, currency: "ILS" },
      transactionCount: 2,
    });
  });

  it("reads through one accessor regardless of source", () => {
    const ledger = buildLedger({
      entered: [{ personalCategoryId: "p-power", month: JAN_2025, amount: ils(400) }],
      transactions: [{ personalCategoryId: "p-health", month: JAN_2025, amount: ils(150) }],
    });

    expect(readAmount(ledger, "p-power", JAN_2025)?.amount).toEqual({ minorUnits: 40_000, currency: "ILS" });
    expect(readAmount(ledger, "p-health", JAN_2025)?.amount).toEqual({ minorUnits: 15_000, currency: "ILS" });
  });

  it("refuses a category-month that is both entered and transaction-backed", () => {
    expect(() =>
      buildLedger({
        entered: [{ personalCategoryId: "p-health", month: JAN_2025, amount: ils(100) }],
        transactions: [{ personalCategoryId: "p-health", month: JAN_2025, amount: ils(100) }],
      }),
    ).toThrow(ConflictingEntrySourceError);
  });

  it("allows the same category to be entered in one month and derived in another", () => {
    const ledger = buildLedger({
      entered: [{ personalCategoryId: "p-health", month: JAN_2025, amount: ils(100) }],
      transactions: [{ personalCategoryId: "p-health", month: FEB_2025, amount: ils(250) }],
    });

    expect(readAmount(ledger, "p-health", JAN_2025)?.source).toBe("entered");
    expect(readAmount(ledger, "p-health", FEB_2025)?.source).toBe("derived");
  });

  it("refuses two entered amounts for the same category-month", () => {
    expect(() =>
      buildLedger({
        entered: [
          { personalCategoryId: "p-health", month: JAN_2025, amount: ils(100) },
          { personalCategoryId: "p-health", month: JAN_2025, amount: ils(200) },
        ],
      }),
    ).toThrow(DuplicateEntryError);
  });

  it("refuses to derive an amount from transactions in mixed currencies", () => {
    expect(() =>
      buildLedger({
        transactions: [
          { personalCategoryId: "p-health", month: JAN_2025, amount: money(100_00, "ILS") },
          { personalCategoryId: "p-health", month: JAN_2025, amount: money(100_00, "USD") },
        ],
      }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe("one continuous ledger", () => {
  it("orders recorded months across a year boundary", () => {
    const ledger = buildLedger({
      entered: [
        { personalCategoryId: "p-health", month: JAN_2025, amount: ils(1) },
        { personalCategoryId: "p-power", month: DEC_2024, amount: ils(1) },
        { personalCategoryId: "p-health", month: calendarMonth(2022, 3), amount: ils(1) },
      ],
    });

    expect(recordedMonths(ledger)).toEqual([calendarMonth(2022, 3), DEC_2024, JAN_2025]);
  });

  it("reports a month once however many categories it holds", () => {
    const ledger = buildLedger({
      entered: [
        { personalCategoryId: "p-health", month: JAN_2025, amount: ils(1) },
        { personalCategoryId: "p-power", month: JAN_2025, amount: ils(1) },
        { personalCategoryId: "p-salary", month: JAN_2025, amount: ils(1) },
      ],
    });

    expect(recordedMonths(ledger)).toEqual([JAN_2025]);
  });

  it("reads a month from four years ago exactly as it reads this one", () => {
    const old = calendarMonth(2022, 6);
    const ledger = buildLedger({
      entered: [{ personalCategoryId: "p-health", month: old, amount: money(123_45, "ILS") }],
    });

    expect(readAmount(ledger, "p-health", old)).toEqual({
      source: "entered",
      amount: { minorUnits: 12_345, currency: "ILS" },
    });
  });
});

describe("personMonthLines", () => {
  it("lists every one of the person's categories, recorded or not", () => {
    const categories = yuvalCategories();
    const ledger = buildLedger({
      entered: [{ personalCategoryId: "p-health", month: JAN_2025, amount: ils(500) }],
    });

    const lines = personMonthLines(ledger, categories, "yuval", JAN_2025);

    expect(lines).toHaveLength(3);
    expect(lines.filter((line) => line.reading === null).map((line) => line.category.name).sort()).toEqual(
      ["חשמל", "משכורת"].sort(),
    );
    expect(lines.find((line) => line.category.name === "בריאות")?.reading?.amount.minorUnits).toBe(50_000);
  });

  it("lists nothing for a person with no categories", () => {
    expect(personMonthLines(EMPTY_LEDGER, yuvalCategories(), "eden", JAN_2025)).toEqual([]);
  });

  it("filters by category type", () => {
    const categories = yuvalCategories();
    const income = personMonthLines(EMPTY_LEDGER, categories, "yuval", JAN_2025, { type: "income" });
    expect(income.map((line) => line.category.name)).toEqual(["משכורת"]);
  });
});

describe("חיסכון", () => {
  it("is income minus expenses, in exact minor units", () => {
    const categories = yuvalCategories();
    const ledger = buildLedger({
      entered: [
        { personalCategoryId: "p-salary", month: JAN_2025, amount: money(28_500_00, "ILS") },
        { personalCategoryId: "p-health", month: JAN_2025, amount: money(1_250_40, "ILS") },
        { personalCategoryId: "p-power", month: JAN_2025, amount: money(430_60, "ILS") },
      ],
    });

    const summary = personMonthSummary(ledger, categories, "yuval", JAN_2025, "ILS");

    expect(summary.income).toEqual({ minorUnits: 2_850_000, currency: "ILS" });
    expect(summary.expenses).toEqual({ minorUnits: 168_100, currency: "ILS" });
    expect(summary.saving).toEqual({ minorUnits: 2_681_900, currency: "ILS" });
    expect(summary.saving.minorUnits).toBe(summary.income.minorUnits - summary.expenses.minorUnits);
  });

  it("goes negative when a month spends more than it earns", () => {
    const categories = yuvalCategories();
    const ledger = buildLedger({
      entered: [
        { personalCategoryId: "p-salary", month: JAN_2025, amount: ils(1_000) },
        { personalCategoryId: "p-health", month: JAN_2025, amount: ils(1_500) },
      ],
    });

    expect(personMonthSummary(ledger, categories, "yuval", JAN_2025, "ILS").saving).toEqual({
      minorUnits: -50_000,
      currency: "ILS",
    });
  });

  it("is zero in the stated currency for a month with nothing recorded", () => {
    const summary = personMonthSummary(EMPTY_LEDGER, yuvalCategories(), "yuval", JAN_2025, "ILS");

    expect(summary.income).toEqual({ minorUnits: 0, currency: "ILS" });
    expect(summary.saving).toEqual({ minorUnits: 0, currency: "ILS" });
    expect(summary.recordedCount).toBe(0);
    expect(summary.categoryCount).toBe(3);
  });

  it("counts how much of the month has been entered", () => {
    const categories = yuvalCategories();
    const ledger = buildLedger({
      entered: [
        { personalCategoryId: "p-salary", month: JAN_2025, amount: ils(1_000) },
        { personalCategoryId: "p-health", month: JAN_2025, amount: ils(0) },
      ],
    });

    const summary = personMonthSummary(ledger, categories, "yuval", JAN_2025, "ILS");
    expect(summary.recordedCount).toBe(2);
    expect(summary.categoryCount).toBe(3);
  });

  it("counts a derived figure exactly as it counts an entered one", () => {
    const categories = yuvalCategories();
    const entered = buildLedger({
      entered: [{ personalCategoryId: "p-health", month: JAN_2025, amount: ils(300) }],
    });
    const derived = buildLedger({
      transactions: [
        { personalCategoryId: "p-health", month: JAN_2025, amount: ils(100) },
        { personalCategoryId: "p-health", month: JAN_2025, amount: ils(200) },
      ],
    });

    expect(personMonthSummary(derived, categories, "yuval", JAN_2025, "ILS").expenses).toEqual(
      personMonthSummary(entered, categories, "yuval", JAN_2025, "ILS").expenses,
    );
  });

  it("reads a corrected month as the corrected figure", () => {
    const categories = yuvalCategories();
    const before = buildLedger({
      entered: [{ personalCategoryId: "p-health", month: DEC_2024, amount: money(999_99, "ILS") }],
    });
    const after = buildLedger({
      entered: [{ personalCategoryId: "p-health", month: DEC_2024, amount: money(120_00, "ILS") }],
    });

    expect(personMonthSummary(before, categories, "yuval", DEC_2024, "ILS").expenses.minorUnits).toBe(99_999);
    expect(personMonthSummary(after, categories, "yuval", DEC_2024, "ILS").expenses.minorUnits).toBe(12_000);
  });

  it("counts only the person asked about", () => {
    const shared = applyCreation(
      yuvalCategories(),
      planPersonalCategoryCreation(
        yuvalCategories(),
        {
          personId: "eden",
          name: "רפואה",
          type: "expense",
          activeFrom: calendarMonth(2022, 1),
          household: { kind: "existing", id: "h-health" },
        },
        { personalCategoryId: "p-eden-health", householdCategoryId: "unused" },
      ),
    );

    const ledger = buildLedger({
      entered: [
        { personalCategoryId: "p-health", month: JAN_2025, amount: ils(100) },
        { personalCategoryId: "p-eden-health", month: JAN_2025, amount: ils(700) },
      ],
    });

    expect(personMonthSummary(ledger, shared, "yuval", JAN_2025, "ILS").expenses.minorUnits).toBe(10_000);
    expect(personMonthSummary(ledger, shared, "eden", JAN_2025, "ILS").expenses.minorUnits).toBe(70_000);
  });
});
