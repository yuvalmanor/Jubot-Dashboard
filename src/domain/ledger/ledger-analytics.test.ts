import { describe, expect, it } from "vitest";

import {
  type Categories,
  EMPTY_CATEGORIES,
  applyCreation,
  applyLifespan,
  planLifespanChange,
  planPersonalCategoryCreation,
} from "@/domain/categories/categories";
import { type Money, money } from "@/domain/money/money";
import { type EnteredEntry, EMPTY_LEDGER, buildLedger } from "@/domain/ledger/ledger";
import { type CalendarMonth, calendarMonth, monthKey } from "@/domain/time/calendar-month";

import {
  HOUSEHOLD_SCOPE,
  availableToMove,
  categoryBreakdown,
  monthPeriod,
  monthlyTrend,
  periodDenominator,
  personScope,
  rankCategoryDeviations,
  yearOverYear,
  yearPeriod,
} from "./ledger-analytics";

const ILS = "ILS" as const;
const ils = (major: number) => money(Math.round(major * 100), ILS);
const m = (year: number, month: number) => calendarMonth(year, month);

const YUVAL = personScope("yuval");
const EDEN = personScope("eden");

/**
 * Both People, four household lines. חו"ל is Yuval's alone and starts in 2025, so
 * it is the category that did not exist in the comparison year.
 */
function categories(): Categories {
  const specs = [
    { person: "yuval", name: "משכורת", type: "income" as const, key: "salary", household: "h-salary", from: m(2024, 1) },
    { person: "eden", name: "משכורת עדן", type: "income" as const, key: "eden-salary", household: "h-salary", from: m(2024, 1) },
    { person: "yuval", name: "בריאות", type: "expense" as const, key: "health", household: "h-health", from: m(2024, 1) },
    { person: "eden", name: "רפואה", type: "expense" as const, key: "eden-health", household: "h-health", from: m(2024, 1) },
    { person: "yuval", name: "חשמל", type: "expense" as const, key: "power", household: "h-power", from: m(2024, 1) },
    { person: "yuval", name: 'חו"ל', type: "expense" as const, key: "travel", household: "h-travel", from: m(2025, 1) },
  ];

  const created = new Set<string>();
  return specs.reduce<Categories>((model, spec) => {
    const householdIsNew = !created.has(spec.household);
    created.add(spec.household);
    return applyCreation(
      model,
      planPersonalCategoryCreation(
        model,
        {
          personId: spec.person,
          name: spec.name,
          type: spec.type,
          activeFrom: spec.from,
          household: householdIsNew
            ? { kind: "new", name: `${spec.name} (משותף)` }
            : { kind: "existing", id: spec.household },
        },
        { personalCategoryId: `p-${spec.key}`, householdCategoryId: spec.household },
      ),
    );
  }, EMPTY_CATEGORIES);
}

/** `entries({ "p-health": { "2025-01": 500 } })` — a compact table of major units. */
function entries(table: Record<string, Record<string, number>>): EnteredEntry[] {
  return Object.entries(table).flatMap(([personalCategoryId, months]) =>
    Object.entries(months).map(([key, major]) => ({
      personalCategoryId,
      month: m(Number(key.slice(0, 4)), Number(key.slice(5, 7))),
      amount: ils(major),
    })),
  );
}

function monthsOf(year: number, amounts: readonly number[]): Record<string, number> {
  return Object.fromEntries(amounts.map((amount, index) => [monthKey(m(year, index + 1)), amount]));
}

describe("periodDenominator — what an average divides by", () => {
  const today = m(2026, 6);

  it("divides a complete year by twelve", () => {
    expect(periodDenominator(yearPeriod(2025), today)).toBe(12);
    expect(periodDenominator(yearPeriod(2024), today)).toBe(12);
  });

  it("divides the current year by the months that have elapsed", () => {
    expect(periodDenominator(yearPeriod(2026), today)).toBe(6);
    expect(periodDenominator(yearPeriod(2026), m(2026, 1))).toBe(1);
    expect(periodDenominator(yearPeriod(2026), m(2026, 12))).toBe(12);
  });

  it("has no months to divide a year that has not started by", () => {
    expect(periodDenominator(yearPeriod(2027), today)).toBe(0);
  });

  it("divides a month by one", () => {
    expect(periodDenominator(monthPeriod(m(2026, 6)), today)).toBe(1);
  });
});

describe("this month's חיסכון — what is available to move into projects", () => {
  const ledger = buildLedger({
    entered: entries({
      "p-salary": { "2026-01": 28_500 },
      "p-eden-salary": { "2026-01": 19_000 },
      "p-health": { "2026-01": 1_250.4 },
      "p-eden-health": { "2026-01": 310.6 },
      "p-power": { "2026-01": 430 },
      "p-travel": { "2026-01": 2_000 },
    }),
  });

  it("is הכנסות − הוצאות for the household, in exact minor units", () => {
    const available = availableToMove(ledger, categories(), HOUSEHOLD_SCOPE, m(2026, 1), ILS);

    // 47,500 in, 3,991 out.
    expect(available.saving).toEqual({ minorUnits: 4_350_900, currency: ILS });
    expect(available.savingRate.income).toEqual({ minorUnits: 4_750_000, currency: ILS });
    expect(available.savingRate.ratio).toBeCloseTo(0.916, 3);
  });

  it("carries the month's completeness, so a half-entered month is not read as generous", () => {
    const partial = buildLedger({ entered: entries({ "p-salary": { "2026-01": 28_500 } }) });
    const available = availableToMove(partial, categories(), HOUSEHOLD_SCOPE, m(2026, 1), ILS);

    expect(available.completeness).toBe("partial");
    expect(available.recordedCount).toBe(1);
    expect(available.categoryCount).toBe(6);
  });

  it("has no saving rate to report for a month with no income", () => {
    const spendOnly = buildLedger({ entered: entries({ "p-power": { "2026-01": 430 } }) });
    const available = availableToMove(spendOnly, categories(), HOUSEHOLD_SCOPE, m(2026, 1), ILS);

    expect(available.saving).toEqual({ minorUnits: -43_000, currency: ILS });
    expect(available.savingRate.ratio).toBeNull();
  });

  it("reads one Person's own חיסכון separately from the household's", () => {
    const model = categories();
    const yuval = availableToMove(ledger, model, YUVAL, m(2026, 1), ILS);
    const eden = availableToMove(ledger, model, EDEN, m(2026, 1), ILS);
    const household = availableToMove(ledger, model, HOUSEHOLD_SCOPE, m(2026, 1), ILS);

    expect(yuval.saving.minorUnits + eden.saving.minorUnits).toBe(household.saving.minorUnits);
  });
});

describe("the monthly trend", () => {
  const ledger = buildLedger({
    entered: entries({
      "p-salary": { ...monthsOf(2024, [20_000, 20_000, 20_000]), ...monthsOf(2025, [22_000, 22_000, 22_000]) },
      "p-power": { ...monthsOf(2024, [400, 450, 500]), ...monthsOf(2025, [500, 550, 600]) },
    }),
  });

  it("reports הכנסות, הוצאות and חיסכון for every month in the range", () => {
    const trend = monthlyTrend(ledger, categories(), HOUSEHOLD_SCOPE, m(2025, 1), m(2025, 3), ILS);

    expect(trend.map((point) => monthKey(point.month))).toEqual(["2025-01", "2025-02", "2025-03"]);
    expect(trend[0]?.income).toEqual({ minorUnits: 2_200_000, currency: ILS });
    expect(trend[0]?.expenses).toEqual({ minorUnits: 50_000, currency: ILS });
    expect(trend[0]?.saving).toEqual({ minorUnits: 2_150_000, currency: ILS });
  });

  it("puts the same month of the previous year alongside each point", () => {
    const trend = monthlyTrend(ledger, categories(), HOUSEHOLD_SCOPE, m(2025, 1), m(2025, 3), ILS);

    expect(trend[0]?.previous?.month).toEqual(m(2024, 1));
    expect(trend[0]?.previous?.income).toEqual({ minorUnits: 2_000_000, currency: ILS });
    expect(trend[2]?.previous?.expenses).toEqual({ minorUnits: 50_000, currency: ILS });
  });

  it("leaves the previous year absent rather than drawing it as a zero", () => {
    // 2024-04 was never recorded. A zero there would read as a month in which the
    // household earned nothing, which is not what the ledger says.
    const trend = monthlyTrend(ledger, categories(), HOUSEHOLD_SCOPE, m(2025, 4), m(2025, 4), ILS);

    expect(trend[0]?.previous).toBeNull();
  });

  it("carries חיסכון as a share of income, with both sides of the fraction", () => {
    const trend = monthlyTrend(ledger, categories(), HOUSEHOLD_SCOPE, m(2025, 1), m(2025, 1), ILS);
    const rate = trend[0]?.savingRate;

    expect(rate?.income).toEqual({ minorUnits: 2_200_000, currency: ILS });
    expect(rate?.saving).toEqual({ minorUnits: 2_150_000, currency: ILS });
    expect(rate?.ratio).toBeCloseTo(0.9773, 4);
  });

  it("crosses a year boundary as one continuous ledger", () => {
    const trend = monthlyTrend(ledger, categories(), HOUSEHOLD_SCOPE, m(2024, 12), m(2025, 2), ILS);

    expect(trend.map((point) => monthKey(point.month))).toEqual(["2024-12", "2025-01", "2025-02"]);
  });

  it("marks each month's completeness, so a partial month is not read as a cheap one", () => {
    const trend = monthlyTrend(ledger, categories(), HOUSEHOLD_SCOPE, m(2025, 1), m(2025, 1), ILS);

    expect(trend[0]?.completeness).toBe("partial");
    expect(trend[0]?.recordedCount).toBe(2);
    expect(trend[0]?.categoryCount).toBe(6);
  });
});

describe("what is unusual this month", () => {
  /** Six flat months, then a January in which electricity trebles and health halves. */
  const ledger = buildLedger({
    entered: entries({
      "p-power": {
        "2024-07": 500,
        "2024-08": 500,
        "2024-09": 500,
        "2024-10": 500,
        "2024-11": 500,
        "2024-12": 500,
        "2025-01": 1_500,
      },
      "p-health": {
        "2024-07": 400,
        "2024-08": 400,
        "2024-09": 400,
        "2024-10": 400,
        "2024-11": 400,
        "2024-12": 400,
        "2025-01": 200,
      },
      "p-salary": {
        "2024-07": 20_000,
        "2024-08": 20_000,
        "2024-09": 20_000,
        "2024-10": 20_000,
        "2024-11": 20_000,
        "2024-12": 20_000,
        "2025-01": 20_050,
      },
    }),
  });

  const ranked = () => rankCategoryDeviations(ledger, categories(), YUVAL, m(2025, 1), ILS);

  it("compares each category against its own trailing average", () => {
    const power = ranked().find((line) => line.key === "p-power");

    expect(power?.trailing.amount).toEqual({ minorUnits: 50_000, currency: ILS });
    expect(power?.trailing.denominator).toBe(6);
    expect(power?.current).toEqual({ minorUnits: 150_000, currency: ILS });
    expect(power?.deviation).toEqual({ minorUnits: 100_000, currency: ILS });
    expect(power?.deviationRatio).toBeCloseTo(2, 10);
  });

  it("ranks the largest deviation first, whichever direction it went", () => {
    const order = ranked()
      .filter((line) => line.basis === "compared")
      .map((line) => line.key);

    // +1,000₪ electricity, then −200₪ health, then +50₪ salary.
    expect(order).toEqual(["p-power", "p-health", "p-salary"]);
  });

  it("divides a trailing average by the months that hold a figure, not by the window", () => {
    // חשמל was recorded in two of the six trailing months. Dividing by six would
    // answer a question about four zeros nobody wrote down.
    const sparse = buildLedger({
      entered: entries({ "p-power": { "2024-11": 300, "2024-12": 500, "2025-01": 400 } }),
    });
    const power = rankCategoryDeviations(sparse, categories(), YUVAL, m(2025, 1), ILS).find(
      (line) => line.key === "p-power",
    );

    expect(power?.trailing.denominator).toBe(2);
    expect(power?.trailing.recordedMonths).toBe(2);
    expect(power?.trailing.amount).toEqual({ minorUnits: 40_000, currency: ILS });
    expect(power?.deviation).toEqual({ minorUnits: 0, currency: ILS });
  });

  it("does not compare a category with no history against a baseline of zero", () => {
    const firstMonth = buildLedger({ entered: entries({ "p-travel": { "2025-01": 8_000 } }) });
    const travel = rankCategoryDeviations(firstMonth, categories(), YUVAL, m(2025, 1), ILS).find(
      (line) => line.key === "p-travel",
    );

    expect(travel?.basis).toBe("no-history");
    expect(travel?.trailing.amount).toBeNull();
    expect(travel?.trailing.denominator).toBe(0);
    expect(travel?.deviation).toBeNull();
  });

  it("reports a category with history and nothing this month rather than ranking it as a fall to zero", () => {
    const missing = buildLedger({
      entered: entries({ "p-power": { "2024-11": 500, "2024-12": 500 } }),
    });
    const power = rankCategoryDeviations(missing, categories(), YUVAL, m(2025, 1), ILS).find(
      (line) => line.key === "p-power",
    );

    expect(power?.basis).toBe("not-recorded");
    expect(power?.current).toBeNull();
    expect(power?.deviation).toBeNull();
  });

  it("says nothing about a category with neither a figure nor a history", () => {
    expect(rankCategoryDeviations(EMPTY_LEDGER, categories(), YUVAL, m(2025, 1), ILS)).toEqual([]);
  });

  it("puts measured deviations above the categories it could not compare", () => {
    const mixed = buildLedger({
      entered: entries({
        "p-power": { "2024-12": 500, "2025-01": 900 },
        "p-travel": { "2025-01": 8_000 },
        "p-health": { "2024-12": 400 },
      }),
    });
    const bases = rankCategoryDeviations(mixed, categories(), YUVAL, m(2025, 1), ILS).map(
      (line) => line.basis,
    );

    expect(bases).toEqual(["compared", "no-history", "not-recorded"]);
  });

  it("is stable across repeated computation", () => {
    const once = ranked().map((line) => line.key);
    const twice = ranked().map((line) => line.key);

    expect(twice).toEqual(once);
  });

  it("is stable when two categories deviate by exactly the same amount", () => {
    const tied = buildLedger({
      entered: entries({
        "p-power": { "2024-12": 500, "2025-01": 700 },
        "p-health": { "2024-12": 400, "2025-01": 600 },
      }),
    });
    const order = () => rankCategoryDeviations(tied, categories(), YUVAL, m(2025, 1), ILS).map((l) => l.key);

    expect(order()).toEqual(order());
    // Tied on magnitude, so the key breaks it — deterministically, both times.
    expect(order()).toEqual(["p-health", "p-power"]);
  });

  it("ranks household lines the same way it ranks personal ones", () => {
    const lines = rankCategoryDeviations(ledger, categories(), HOUSEHOLD_SCOPE, m(2025, 1), ILS);

    expect(lines[0]?.key).toBe("h-power");
    expect(lines[0]?.personId).toBeNull();
  });
});

describe("where the money went", () => {
  const ledger = buildLedger({
    entered: entries({
      "p-salary": monthsOf(2025, [20_000, 20_000, 20_000, 20_000, 20_000, 20_000]),
      "p-eden-salary": monthsOf(2025, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000]),
      "p-health": monthsOf(2025, [100, 100, 100, 100, 100, 100]),
      "p-eden-health": monthsOf(2025, [200, 200, 200, 200, 200, 200]),
      "p-power": monthsOf(2025, [500, 500, 500, 500, 500, 500]),
    }),
  });

  const today = m(2025, 6);

  it("breaks a month down at household level, largest first", () => {
    const breakdown = categoryBreakdown(
      ledger,
      categories(),
      HOUSEHOLD_SCOPE,
      monthPeriod(m(2025, 3)),
      ILS,
      today,
    );

    expect(breakdown.denominator).toBe(1);
    expect(breakdown.expenses.map((line) => line.key)).toEqual(["h-power", "h-health"]);
    expect(breakdown.expenses[0]?.average.total).toEqual({ minorUnits: 50_000, currency: ILS });
    expect(breakdown.totals.expenses.total).toEqual({ minorUnits: 80_000, currency: ILS });
  });

  it("divides a partial year by its elapsed months, and says so on every line", () => {
    const breakdown = categoryBreakdown(ledger, categories(), HOUSEHOLD_SCOPE, yearPeriod(2025), ILS, today);

    expect(breakdown.denominator).toBe(6);
    for (const line of [...breakdown.income, ...breakdown.expenses]) {
      expect(line.average.denominator).toBe(6);
      expect(line.average.amount?.minorUnits).toBe(Math.round(line.average.total.minorUnits / 6));
    }
    expect(breakdown.totals.income.amount).toEqual({ minorUnits: 3_000_000, currency: ILS });
    expect(breakdown.totals.income.denominator).toBe(6);
  });

  it("states how many of the period's months actually hold a figure", () => {
    const breakdown = categoryBreakdown(ledger, categories(), HOUSEHOLD_SCOPE, yearPeriod(2025), ILS, today);

    expect(breakdown.totals.income.recordedMonths).toBe(6);
    expect(breakdown.expenses.find((line) => line.key === "h-power")?.average.recordedMonths).toBe(6);
  });

  it("gives each line its share of the period's total for its own type", () => {
    const breakdown = categoryBreakdown(ledger, categories(), HOUSEHOLD_SCOPE, yearPeriod(2025), ILS, today);
    const power = breakdown.expenses.find((line) => line.key === "h-power");

    expect(power?.share).toBeCloseTo(3_000 / 4_800, 10);
    const shares = breakdown.expenses.reduce((running, line) => running + (line.share ?? 0), 0);
    expect(shares).toBeCloseTo(1, 10);
  });

  it("opens a household line onto the personal categories that produced it", () => {
    const breakdown = categoryBreakdown(ledger, categories(), HOUSEHOLD_SCOPE, yearPeriod(2025), ILS, today);
    const health = breakdown.expenses.find((line) => line.key === "h-health");

    expect(health?.contributions.map((line) => line.key)).toEqual(["p-eden-health", "p-health"]);
    const contributed = (health?.contributions ?? []).reduce(
      (running, line) => running + line.average.total.minorUnits,
      0,
    );
    expect(contributed).toBe(health?.average.total.minorUnits);
    expect(health?.contributions[0]?.share).toBeCloseTo(2 / 3, 10);
  });

  it("leaves a silent member out of a drill-down, and drops a drill-down of one", () => {
    // Only Yuval recorded בריאות, so h-health has nothing to open onto: a line
    // repeated under itself explains nothing, and a member with no figure in the
    // period is not part of the account of where the money went.
    const oneSided = buildLedger({ entered: entries({ "p-health": monthsOf(2025, [100, 100, 100]) }) });
    const breakdown = categoryBreakdown(
      oneSided,
      categories(),
      HOUSEHOLD_SCOPE,
      yearPeriod(2025),
      ILS,
      m(2025, 3),
    );

    expect(breakdown.expenses.find((line) => line.key === "h-health")?.contributions).toEqual([]);
  });

  it("breaks the same period down for one Person alone", () => {
    const breakdown = categoryBreakdown(ledger, categories(), EDEN, yearPeriod(2025), ILS, today);

    expect(breakdown.expenses.map((line) => line.name)).toEqual(["רפואה"]);
    expect(breakdown.expenses[0]?.contributions).toEqual([]);
    expect(breakdown.totals.income.total).toEqual({ minorUnits: 6_000_000, currency: ILS });
  });

  it("leaves out a category with nothing recorded in the period", () => {
    const breakdown = categoryBreakdown(ledger, categories(), YUVAL, yearPeriod(2025), ILS, today);

    expect(breakdown.expenses.map((line) => line.key)).not.toContain("p-travel");
  });

  it("counts a retired category's recorded months exactly as it did before retirement", () => {
    const model = categories();
    const retired = applyLifespan(model, planLifespanChange(model, "p-power", { activeUntil: m(2025, 3) }));

    const before = categoryBreakdown(ledger, model, YUVAL, yearPeriod(2025), ILS, today);
    const after = categoryBreakdown(ledger, retired, YUVAL, yearPeriod(2025), ILS, today);

    expect(after.expenses.find((line) => line.key === "p-power")?.average).toEqual(
      before.expenses.find((line) => line.key === "p-power")?.average,
    );
  });

  it("has no average to report for a year that has not started", () => {
    const breakdown = categoryBreakdown(ledger, categories(), HOUSEHOLD_SCOPE, yearPeriod(2027), ILS, today);

    expect(breakdown.denominator).toBe(0);
    expect(breakdown.totals.income.amount).toBeNull();
    expect(breakdown.income).toEqual([]);
  });
});

describe("the same period last year", () => {
  const ledger = buildLedger({
    entered: entries({
      "p-power": {
        ...monthsOf(2024, [400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400]),
        ...monthsOf(2025, [500, 500, 500, 500, 500, 500]),
      },
      "p-health": {
        ...monthsOf(2024, [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]),
        ...monthsOf(2025, [100, 100, 100, 100, 100, 100]),
      },
      // Yuval's חו"ל exists from 2025 only.
      "p-travel": monthsOf(2025, [0, 0, 3_000, 0, 0, 0]),
    }),
  });

  const today = m(2025, 6);
  const compared = () => yearOverYear(ledger, categories(), YUVAL, 2025, ILS, today, { type: "expense" });

  it("compares the same span of months on both sides", () => {
    const result = compared();

    expect(result.year).toBe(2025);
    expect(result.comparisonYear).toBe(2024);
    expect(result.months).toBe(6);

    const power = result.lines.find((line) => line.key === "p-power");
    expect(power?.current.total).toEqual({ minorUnits: 300_000, currency: ILS });
    expect(power?.previous?.total).toEqual({ minorUnits: 240_000, currency: ILS });
    expect(power?.current.denominator).toBe(6);
    expect(power?.previous?.denominator).toBe(6);
  });

  it("reports the change and what it was a change from", () => {
    const power = compared().lines.find((line) => line.key === "p-power");

    expect(power?.change).toEqual({ minorUnits: 60_000, currency: ILS });
    expect(power?.changeRatio).toBeCloseTo(0.25, 10);
  });

  it("includes a category that did not exist in the comparison year, without inventing a baseline", () => {
    const travel = compared().lines.find((line) => line.key === "p-travel");

    expect(travel).toBeDefined();
    expect(travel?.previous).toBeNull();
    expect(travel?.change).toBeNull();
    expect(travel?.changeRatio).toBeNull();
    expect(travel?.current.total).toEqual({ minorUnits: 300_000, currency: ILS });
  });

  it("compares a complete year against the whole of the one before it", () => {
    const result = yearOverYear(ledger, categories(), YUVAL, 2025, ILS, m(2026, 3), { type: "expense" });

    expect(result.months).toBe(12);
    expect(result.lines.find((line) => line.key === "p-power")?.previous?.total).toEqual({
      minorUnits: 480_000,
      currency: ILS,
    });
  });

  it("says nothing about a category recorded in neither year", () => {
    const result = yearOverYear(ledger, categories(), EDEN, 2025, ILS, today);

    expect(result.lines).toEqual([]);
  });

  it("compares household lines the same way", () => {
    const result = yearOverYear(ledger, categories(), HOUSEHOLD_SCOPE, 2025, ILS, today, { type: "expense" });

    expect(result.lines.find((line) => line.key === "h-power")?.change).toEqual({
      minorUnits: 60_000,
      currency: ILS,
    });
  });
});

describe("every average carries its denominator", () => {
  const ledger = buildLedger({
    entered: entries({ "p-power": monthsOf(2025, [300, 400, 500]) }),
  });

  function everyAverage(today: CalendarMonth) {
    const model = categories();
    const breakdown = categoryBreakdown(ledger, model, YUVAL, yearPeriod(2025), ILS, today);
    const comparison = yearOverYear(ledger, model, YUVAL, 2025, ILS, today);
    const deviations = rankCategoryDeviations(ledger, model, YUVAL, m(2025, 3), ILS);

    return [
      breakdown.totals.income,
      breakdown.totals.expenses,
      breakdown.totals.saving,
      ...breakdown.income.map((line) => line.average),
      ...breakdown.expenses.map((line) => line.average),
      ...comparison.lines.flatMap((line) => [line.current, ...(line.previous === null ? [] : [line.previous])]),
      ...deviations.map((line) => line.trailing),
    ];
  }

  it("states the months it divided by, and is null when there were none", () => {
    for (const average of everyAverage(m(2025, 3))) {
      expect(Number.isInteger(average.denominator)).toBe(true);
      if (average.denominator === 0) {
        expect(average.amount).toBeNull();
      } else {
        expect(average.amount).not.toBeNull();
        expect(average.amount?.currency).toBe(ILS);
      }
    }
  });

  it("never divides by more months than the period has", () => {
    for (const average of everyAverage(m(2025, 3))) {
      expect(average.recordedMonths).toBeLessThanOrEqual(Math.max(average.denominator, 0) || 12);
    }
  });

  it("holds amount = total ÷ denominator, rounded at the agora", () => {
    const breakdown = categoryBreakdown(ledger, categories(), YUVAL, yearPeriod(2025), ILS, m(2025, 3));
    const power = breakdown.expenses.find((line) => line.key === "p-power");

    // 1,200₪ over three elapsed months.
    expect(power?.average.total).toEqual({ minorUnits: 120_000, currency: ILS });
    expect(power?.average.denominator).toBe(3);
    expect(power?.average.amount).toEqual({ minorUnits: 40_000, currency: ILS });
  });

  it("rounds an average that does not divide evenly at the minor unit", () => {
    const uneven = buildLedger({ entered: entries({ "p-power": monthsOf(2025, [100, 100, 100.01]) }) });
    const breakdown = categoryBreakdown(uneven, categories(), YUVAL, yearPeriod(2025), ILS, m(2025, 3));
    const power = breakdown.expenses.find((line) => line.key === "p-power");

    expect(power?.average.total).toEqual({ minorUnits: 30_001, currency: ILS });
    expect(power?.average.amount).toEqual({ minorUnits: 10_000, currency: ILS });
  });
});

describe("the ledger is never written by reading it", () => {
  it("leaves the ledger and categories untouched", () => {
    const model = categories();
    const ledger = buildLedger({ entered: entries({ "p-power": monthsOf(2025, [300, 400, 500]) }) });
    const before = JSON.stringify([...ledger.readings.entries()]);
    const categoriesBefore = JSON.stringify(model);

    monthlyTrend(ledger, model, HOUSEHOLD_SCOPE, m(2025, 1), m(2025, 3), ILS);
    rankCategoryDeviations(ledger, model, HOUSEHOLD_SCOPE, m(2025, 3), ILS);
    categoryBreakdown(ledger, model, HOUSEHOLD_SCOPE, yearPeriod(2025), ILS, m(2025, 3));
    yearOverYear(ledger, model, HOUSEHOLD_SCOPE, 2025, ILS, m(2025, 3));

    expect(JSON.stringify([...ledger.readings.entries()])).toBe(before);
    expect(JSON.stringify(model)).toBe(categoriesBefore);
  });
});

/** A hint the fixture stays honest: amounts are built from major units, exactly. */
describe("fixture", () => {
  it("builds exact minor units", () => {
    const amount: Money = ils(1_250.4);
    expect(amount).toEqual({ minorUnits: 125_040, currency: ILS });
  });
});
