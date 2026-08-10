import { describe, expect, it } from "vitest";

import {
  type Categories,
  EMPTY_CATEGORIES,
  applyCreation,
  applyLifespan,
  applyMerge,
  planCategoryMerge,
  planLifespanChange,
  planPersonalCategoryCreation,
} from "@/domain/categories/categories";
import { CurrencyMismatchError, money } from "@/domain/money/money";
import { calendarMonth } from "@/domain/time/calendar-month";

import {
  ConflictingEntrySourceError,
  DuplicateEntryError,
  EMPTY_LEDGER,
  buildLedger,
  completenessOf,
  householdCategoryLines,
  householdMonthSummary,
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

/** Both People. Health is one household line under two personal names; power is Yuval's alone. */
function bothPeople(): Categories {
  const specs = [
    { name: "רפואה", type: "expense" as const, household: "h-health", key: "eden-health" },
    { name: "משכורת עדן", type: "income" as const, household: "h-salary", key: "eden-salary" },
  ];
  return specs.reduce<Categories>(
    (categories, spec) =>
      applyCreation(
        categories,
        planPersonalCategoryCreation(
          categories,
          {
            personId: "eden",
            name: spec.name,
            type: spec.type,
            activeFrom: calendarMonth(2022, 1),
            household: { kind: "existing", id: spec.household },
          },
          { personalCategoryId: `p-${spec.key}`, householdCategoryId: "unused" },
        ),
      ),
    yuvalCategories(),
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

describe("the household reading of a month", () => {
  const monthLedger = () =>
    buildLedger({
      entered: [
        { personalCategoryId: "p-salary", month: JAN_2025, amount: money(28_500_00, "ILS") },
        { personalCategoryId: "p-eden-salary", month: JAN_2025, amount: money(19_000_00, "ILS") },
        { personalCategoryId: "p-health", month: JAN_2025, amount: money(1_250_40, "ILS") },
        { personalCategoryId: "p-eden-health", month: JAN_2025, amount: money(310_60, "ILS") },
        { personalCategoryId: "p-power", month: JAN_2025, amount: money(430_00, "ILS") },
      ],
    });

  it("is both people's figures, in exact minor units", () => {
    const summary = householdMonthSummary(monthLedger(), bothPeople(), JAN_2025, "ILS");

    expect(summary.income).toEqual({ minorUnits: 4_750_000, currency: "ILS" });
    expect(summary.expenses).toEqual({ minorUnits: 199_100, currency: "ILS" });
    expect(summary.saving).toEqual({ minorUnits: 4_550_900, currency: "ILS" });
  });

  it("is exactly the two personal readings added together", () => {
    const ledger = monthLedger();
    const categories = bothPeople();
    const household = householdMonthSummary(ledger, categories, JAN_2025, "ILS");
    const yuval = personMonthSummary(ledger, categories, "yuval", JAN_2025, "ILS");
    const eden = personMonthSummary(ledger, categories, "eden", JAN_2025, "ILS");

    expect(household.saving.minorUnits).toBe(yuval.saving.minorUnits + eden.saving.minorUnits);
  });

  it("puts two personal names under one household line", () => {
    const lines = householdCategoryLines(monthLedger(), bothPeople(), JAN_2025, "ILS", { type: "expense" });

    const health = lines.find((line) => line.household.id === "h-health");
    expect(health?.amount).toEqual({ minorUnits: 156_100, currency: "ILS" });
    expect(health?.contributions.map((line) => line.category.name)).toEqual(["בריאות", "רפואה"]);
  });

  it("drills into a household figure and accounts for it exactly", () => {
    const lines = householdCategoryLines(monthLedger(), bothPeople(), JAN_2025, "ILS");

    for (const line of lines) {
      const contributed = line.contributions.reduce(
        (running, contribution) => running + (contribution.reading?.amount.minorUnits ?? 0),
        0,
      );
      expect(line.amount.minorUnits).toBe(contributed);
    }
  });

  it("is derived on read — correcting a personal figure moves the household one", () => {
    const categories = bothPeople();
    const corrected = buildLedger({
      entered: [{ personalCategoryId: "p-eden-health", month: JAN_2025, amount: money(1_000_00, "ILS") }],
    });

    expect(householdMonthSummary(corrected, categories, JAN_2025, "ILS").expenses.minorUnits).toBe(100_000);
  });

  it("leaves out a household category with nothing feeding it in this month", () => {
    const categories = bothPeople();
    const retired = applyLifespan(
      categories,
      planLifespanChange(categories, "p-power", { activeUntil: calendarMonth(2024, 12) }),
    );

    const lines = householdCategoryLines(EMPTY_LEDGER, retired, JAN_2025, "ILS", { type: "expense" });
    expect(lines.map((line) => line.household.id)).toEqual(["h-health"]);
  });

  it("reports a household line with nothing recorded as zero in the stated currency", () => {
    const lines = householdCategoryLines(EMPTY_LEDGER, bothPeople(), JAN_2025, "ILS", { type: "income" });

    expect(lines[0]?.amount).toEqual({ minorUnits: 0, currency: "ILS" });
    expect(lines[0]?.recordedCount).toBe(0);
    expect(lines[0]?.categoryCount).toBe(2);
  });
});

describe("merging changes the household breakdown and not the money", () => {
  const ledger = buildLedger({
    entered: [
      { personalCategoryId: "p-health", month: JAN_2025, amount: money(400_00, "ILS") },
      { personalCategoryId: "p-power", month: JAN_2025, amount: money(430_00, "ILS") },
    ],
  });

  const merged = () => {
    const before = bothPeople();
    return applyMerge(
      before,
      planCategoryMerge(
        before,
        { personalCategoryIds: ["p-power"], household: { kind: "existing", id: "h-health" } },
        { householdCategoryId: "unused" },
      ),
    );
  };

  it("reads as one household line afterwards, with both amounts under it", () => {
    const lines = householdCategoryLines(ledger, merged(), JAN_2025, "ILS", { type: "expense" });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.household.id).toBe("h-health");
    expect(lines[0]?.amount).toEqual({ minorUnits: 83_000, currency: "ILS" });
    expect(lines[0]?.contributions.map((line) => line.category.name)).toEqual(["בריאות", "חשמל", "רפואה"]);
  });

  it("changes no personal figure and no household total", () => {
    expect(householdMonthSummary(ledger, merged(), JAN_2025, "ILS")).toEqual(
      householdMonthSummary(ledger, bothPeople(), JAN_2025, "ILS"),
    );
    expect(personMonthLines(ledger, merged(), "yuval", JAN_2025)).toEqual(
      personMonthLines(ledger, bothPeople(), "yuval", JAN_2025),
    );
    expect(readAmount(ledger, "p-power", JAN_2025)?.amount.minorUnits).toBe(43_000);
  });
});

describe("a retired category", () => {
  const retiredAtDecember = () => {
    const categories = bothPeople();
    return applyLifespan(
      categories,
      planLifespanChange(categories, "p-power", { activeUntil: DEC_2024 }),
    );
  };

  it("is no longer offered for a current month", () => {
    const lines = personMonthLines(EMPTY_LEDGER, retiredAtDecember(), "yuval", JAN_2025);
    expect(lines.map((line) => line.category.name)).not.toContain("חשמל");
  });

  it("still resolves for the months it covered, reading exactly as before", () => {
    const ledger = buildLedger({
      entered: [{ personalCategoryId: "p-power", month: DEC_2024, amount: money(512_35, "ILS") }],
    });

    // The retirement month itself is still covered, so December reads exactly as
    // it did: the same categories, the same figures, the same denominator.
    const read = (categories: Categories) =>
      personMonthLines(ledger, categories, "yuval", DEC_2024).map((line) => [
        line.category.name,
        line.reading?.amount.minorUnits ?? null,
      ]);

    expect(read(retiredAtDecember())).toEqual(read(bothPeople()));
    expect(personMonthSummary(ledger, retiredAtDecember(), "yuval", DEC_2024, "ILS")).toEqual(
      personMonthSummary(ledger, bothPeople(), "yuval", DEC_2024, "ILS"),
    );
  });

  it("keeps showing a figure recorded after its retirement rather than hiding money", () => {
    const ledger = buildLedger({
      entered: [{ personalCategoryId: "p-power", month: JAN_2025, amount: money(99_00, "ILS") }],
    });

    const lines = personMonthLines(ledger, retiredAtDecember(), "yuval", JAN_2025);
    expect(lines.find((line) => line.category.name === "חשמל")?.reading?.amount.minorUnits).toBe(9_900);
    expect(personMonthSummary(ledger, retiredAtDecember(), "yuval", JAN_2025, "ILS").expenses.minorUnits).toBe(
      9_900,
    );
  });

  it("is left out of the month's denominator once retired", () => {
    expect(personMonthSummary(EMPTY_LEDGER, retiredAtDecember(), "yuval", JAN_2025, "ILS").categoryCount).toBe(2);
    expect(personMonthSummary(EMPTY_LEDGER, bothPeople(), "yuval", JAN_2025, "ILS").categoryCount).toBe(3);
  });

  it("does not appear before the month its lifespan starts", () => {
    expect(personMonthLines(EMPTY_LEDGER, bothPeople(), "yuval", calendarMonth(2021, 12))).toEqual([]);
  });
});

describe("an incomplete month is visible as incomplete", () => {
  it("is empty when nothing has been recorded", () => {
    expect(completenessOf(householdMonthSummary(EMPTY_LEDGER, bothPeople(), JAN_2025, "ILS"))).toBe("empty");
  });

  it("is partial when only some categories have a figure", () => {
    const ledger = buildLedger({
      entered: [{ personalCategoryId: "p-salary", month: JAN_2025, amount: money(28_500_00, "ILS") }],
    });
    const summary = householdMonthSummary(ledger, bothPeople(), JAN_2025, "ILS");

    expect(completenessOf(summary)).toBe("partial");
    expect(summary.recordedCount).toBe(1);
    expect(summary.categoryCount).toBe(5);
  });

  it("is complete only when every category has one, and a recorded zero counts", () => {
    const ledger = buildLedger({
      entered: [
        { personalCategoryId: "p-salary", month: JAN_2025, amount: ils(28_500) },
        { personalCategoryId: "p-eden-salary", month: JAN_2025, amount: ils(19_000) },
        { personalCategoryId: "p-health", month: JAN_2025, amount: ils(0) },
        { personalCategoryId: "p-eden-health", month: JAN_2025, amount: ils(300) },
        { personalCategoryId: "p-power", month: JAN_2025, amount: ils(430) },
      ],
    });

    expect(completenessOf(householdMonthSummary(ledger, bothPeople(), JAN_2025, "ILS"))).toBe("complete");
  });
});
