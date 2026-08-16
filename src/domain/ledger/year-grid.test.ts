import { describe, expect, it } from "vitest";

import {
  type Categories,
  EMPTY_CATEGORIES,
  applyCreation,
  applyLifespan,
  planLifespanChange,
  planPersonalCategoryCreation,
} from "@/domain/categories/categories";
import {
  type EnteredEntry,
  EMPTY_LEDGER,
  buildLedger,
  householdMonthSummary,
  personMonthSummary,
  recordedYears,
} from "@/domain/ledger/ledger";
import {
  HOUSEHOLD_SCOPE,
  denominatorMonths,
  personScope,
  yearPeriod,
} from "@/domain/ledger/ledger-analytics";
import { type Money, divide, money, subtract, sum } from "@/domain/money/money";
import { type CalendarMonth, calendarMonth, monthKey } from "@/domain/time/calendar-month";

import { type GridRow, type GridSort, type YearGrid, yearGrid } from "./year-grid";

/**
 * The grid reading, tested against nothing but plain data. No database is
 * imported here and none is needed: the ledger, the categories and the clock are
 * all parameters.
 */

const ILS = "ILS" as const;
const ils = (major: number) => money(Math.round(major * 100), ILS);
const m = (year: number, month: number) => calendarMonth(year, month);

const TODAY = m(2026, 8);
const YUVAL = personScope("yuval");
const EDEN = personScope("eden");

/**
 * Both People. חו"ל is Yuval's alone and starts in 2025 — it is the category
 * whose lifespan does not cover the whole history. חשמל is retired mid-2025.
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

function monthsOf(year: number, from: number, amounts: readonly number[]): Record<string, number> {
  return Object.fromEntries(amounts.map((amount, index) => [monthKey(m(year, from + index)), amount]));
}

/**
 * The household's own shape: history begins in יולי 2024, 2025 is covered end to
 * end, and 2026 runs to the month being lived.
 */
const LEDGER = buildLedger({
  entered: entries({
    "p-salary": {
      ...monthsOf(2024, 7, [20000, 20000, 20000, 20000, 20000, 20000]),
      ...monthsOf(2025, 1, [21000, 21000, 21000, 21000, 21000, 21000, 21000, 21000, 21000, 21000, 21000, 21000]),
      ...monthsOf(2026, 1, [22000, 22000, 22000, 22000, 22000, 22000, 22000]),
      "2026-08": 22000,
    },
    "p-eden-salary": {
      ...monthsOf(2024, 7, [15000, 15000, 15000, 15000, 15000, 15000]),
      ...monthsOf(2025, 1, [16000, 16000, 16000, 16000, 16000, 16000, 16000, 16000, 16000, 16000, 16000, 16000]),
      ...monthsOf(2026, 1, [17000, 17000, 17000, 17000, 17000, 17000, 17000]),
    },
    "p-health": {
      ...monthsOf(2024, 7, [300, 300, 300, 300, 300, 300]),
      ...monthsOf(2025, 1, [400, 0, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400]),
      ...monthsOf(2026, 1, [500, 500, 500, 500, 500, 500, 500]),
    },
    "p-eden-health": {
      ...monthsOf(2025, 1, [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]),
    },
    "p-power": {
      ...monthsOf(2024, 7, [600, 600, 600, 600, 600, 600]),
      // Recorded after the retirement below closes its lifespan in מרץ 2025.
      ...monthsOf(2025, 1, [700, 700, 700, 700]),
    },
    // Recorded in 2024, months before the category's own lifespan begins.
    "p-travel": { "2024-11": 9000, "2025-05": 9905 },
  }),
});

/** חשמל is retired at מרץ 2025 — after the last month it holds a figure for. */
const CATEGORIES = applyLifespan(
  categories(),
  planLifespanChange(categories(), "p-power", { activeUntil: m(2025, 3) }),
);

function grid(year: number, scope = HOUSEHOLD_SCOPE, today = TODAY, sort?: GridSort): YearGrid {
  return yearGrid(LEDGER, CATEGORIES, scope, year, ILS, today, { sort });
}

function row(bandRows: readonly GridRow[], key: string): GridRow {
  const found = bandRows.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`No row ${key} in [${bandRows.map((r) => r.key).join(", ")}]`);
  return found;
}

function amountsOf(cells: readonly { readonly amount: Money | null }[]): (number | null)[] {
  return cells.map((cell) => (cell.amount === null ? null : cell.amount.minorUnits));
}

describe("yearGrid — the year as categories against months", () => {
  it("always renders twelve month columns, whatever the year", () => {
    for (const year of [2024, 2025, 2026, 2027]) {
      expect(grid(year).months.map((column) => monthKey(column.month))).toEqual(
        Array.from({ length: 12 }, (_unused, index) => monthKey(m(year, index + 1))),
      );
    }
  });

  it("marks each month as behind us, being lived, or not yet arrived", () => {
    const standings = grid(2026).months.map((column) => column.standing);
    expect(standings).toEqual([
      "past", "past", "past", "past", "past", "past", "past",
      "current",
      "future", "future", "future", "future",
    ]);
  });

  it("reads one row per category at person level and one per household line at household level", () => {
    const personal = grid(2025, YUVAL);
    expect(personal.income.rows.map((line) => line.key)).toEqual(["p-salary"]);
    expect(personal.expenses.rows.map((line) => line.key).sort()).toEqual(["p-health", "p-power", "p-travel"]);

    const household = grid(2025);
    expect(household.income.rows.map((line) => line.key)).toEqual(["h-salary"]);
    expect(household.expenses.rows.map((line) => line.key).sort()).toEqual(["h-health", "h-power", "h-travel"]);
  });

  it("renders the same rows in the same order every time it is read", () => {
    const once = grid(2025);
    const twice = grid(2025);
    expect(twice.expenses.rows.map((line) => line.key)).toEqual(once.expenses.rows.map((line) => line.key));
  });
});

describe("yearGrid — a blank month and a month of nought are different facts", () => {
  it("reads a month recorded as zero as zero, and a month never recorded as nothing", () => {
    const cells = row(grid(2025, YUVAL).expenses.rows, "p-health").cells;
    // בריאות was 0 in פברואר 2025 and recorded every month of the year.
    expect(cells[1]?.amount).toEqual(ils(0));
    expect(amountsOf(cells).every((amount) => amount !== null)).toBe(true);

    // Eden recorded no רפואה at all in 2024.
    expect(amountsOf(row(grid(2024, EDEN).expenses.rows, "p-eden-health").cells)).toEqual(
      Array.from({ length: 12 }, () => null),
    );
  });

  it("leaves a band's subtotal blank for a month nothing was recorded in", () => {
    const subtotal = grid(2024).expenses.total.cells;
    // The history begins in יולי; the first half of 2024 holds nothing at all.
    expect(amountsOf(subtotal).slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(subtotal[6]?.amount).toEqual(ils(900));
  });

  it("leaves חיסכון blank for a month with neither income nor expenses recorded", () => {
    expect(grid(2024).saving.cells[0]?.amount).toBeNull();
    expect(grid(2024).saving.cells[6]?.amount).toEqual(ils(20000 + 15000 - 300 - 600));
  });
});

describe("yearGrid — which categories a year holds", () => {
  it("shows a category whose lifespan overlaps the year even with nothing recorded", () => {
    // חו"ל is active from 2025 and holds one figure, in מאי. The other eleven
    // months are the holes the household opens this screen to find.
    const travel = row(grid(2025, YUVAL).expenses.rows, "p-travel");
    expect(amountsOf(travel.cells)).toEqual([
      null, null, null, null, ils(9905).minorUnits, null, null, null, null, null, null, null,
    ]);
  });

  it("shows a category for a year its lifespan never covered, when that year holds a figure", () => {
    // חו"ל begins in 2025 but was recorded in נובמבר 2024. Money that was written
    // down is never dropped for being outside a lifespan.
    const travel = row(grid(2024, YUVAL).expenses.rows, "p-travel");
    expect(travel.cells[10]?.amount).toEqual(ils(9000));
  });

  it("keeps every month a retired category was recorded in, and says it is retired", () => {
    // חשמל was retired at מרץ 2025 and holds figures through אפריל.
    const power = row(grid(2025, YUVAL).expenses.rows, "p-power");
    expect(power.retired).toBe(true);
    expect(amountsOf(power.cells).slice(0, 4)).toEqual([70000, 70000, 70000, 70000]);
    expect(power.aggregate.total).toEqual(ils(2800));
  });

  it("leaves a year the category has nothing to do with off the grid entirely", () => {
    expect(grid(2026, YUVAL).expenses.rows.map((line) => line.key)).not.toContain("p-power");
  });

  it("has no rows at all for a year the ledger never reached", () => {
    expect(grid(2023).income.rows).toEqual([]);
    expect(grid(2023).expenses.rows).toEqual([]);
  });
});

describe("yearGrid — the two aggregate columns", () => {
  it("totals and divides by exactly the year's closed months inside the ledger's span", () => {
    // 2024 begins in יולי, so six; 2025 is covered end to end; 2026 stops before
    // the month being lived.
    expect(grid(2024).denominatorMonths.map(monthKey)).toEqual(
      denominatorMonths(yearPeriod(2024), TODAY, { first: m(2024, 7), last: m(2026, 8) }).map(monthKey),
    );
    expect(grid(2024).income.total.aggregate.denominator).toBe(6);
    expect(grid(2025).income.total.aggregate.denominator).toBe(12);
    expect(grid(2026).income.total.aggregate.denominator).toBe(7);
  });

  it("carries the months themselves, so no column can total one span and divide by another", () => {
    const grid2026 = grid(2026);
    for (const line of [...grid2026.income.rows, ...grid2026.expenses.rows]) {
      expect(line.aggregate.months.map(monthKey)).toEqual(grid2026.denominatorMonths.map(monthKey));
      expect(line.aggregate.denominator).toBe(line.aggregate.months.length);
      expect(line.aggregate.amount).toEqual(divide(line.aggregate.total, line.aggregate.denominator));
    }
  });

  it("totals exactly the counted cells of its own row", () => {
    const line = row(grid(2026, YUVAL).income.rows, "p-salary");
    const counted = line.cells.filter((cell) => cell.standing === "past");
    expect(line.aggregate.total).toEqual(sum(counted.flatMap((cell) => (cell.amount === null ? [] : [cell.amount])), ILS));
  });

  it("shows the month being lived in its own column and feeds it into neither aggregate", () => {
    const grid2026 = grid(2026, YUVAL);
    const august = grid2026.months[7];
    expect(august?.standing).toBe("current");
    expect(august?.counted).toBe(false);
    expect(grid2026.denominatorMonths.map(monthKey)).not.toContain("2026-08");

    // אוגוסט's משכורת is on the screen — 22,000 — and the year's total is the
    // seven closed months without it.
    const salary = row(grid2026.income.rows, "p-salary");
    expect(salary.cells[7]?.amount).toEqual(ils(22000));
    expect(salary.aggregate.total).toEqual(ils(22000 * 7));
  });

  it("has no denominator for a year that has not started, and an undefined average rather than nought", () => {
    const future = grid(2027);
    expect(future.denominatorMonths).toEqual([]);
    expect(future.income.total.aggregate.denominator).toBe(0);
    expect(future.income.total.aggregate.amount).toBeNull();
    expect(future.saving.aggregate.amount).toBeNull();
  });

  it("says how many of the counted months hold a figure", () => {
    // חו"ל holds one of 2025's twelve.
    expect(row(grid(2025, YUVAL).expenses.rows, "p-travel").aggregate.recordedMonths).toBe(1);
    expect(row(grid(2025, YUVAL).income.rows, "p-salary").aggregate.recordedMonths).toBe(12);
  });
});

describe("yearGrid — the household is the sum of the two people", () => {
  it("adds the two personal cells into every household cell", () => {
    const household = row(grid(2025).income.rows, "h-salary");
    const mine = row(grid(2025, YUVAL).income.rows, "p-salary");
    const theirs = row(grid(2025, EDEN).income.rows, "p-eden-salary");

    expect(amountsOf(household.cells)).toEqual(
      mine.cells.map((cell, index) => {
        const other = theirs.cells[index]?.amount ?? null;
        if (cell.amount === null && other === null) return null;
        return (cell.amount?.minorUnits ?? 0) + (other?.minorUnits ?? 0);
      }),
    );
  });

  it("adds the two personal totals into the household total", () => {
    const household = row(grid(2025).income.rows, "h-salary").aggregate.total;
    const mine = row(grid(2025, YUVAL).income.rows, "p-salary").aggregate.total;
    const theirs = row(grid(2025, EDEN).income.rows, "p-eden-salary").aggregate.total;
    expect(household).toEqual(sum([mine, theirs], ILS));
  });
});

describe("yearGrid — the bands agree with the month they are read from", () => {
  it("subtotals each month to the same figure the monthly reading gives", () => {
    for (const [scope, read] of [
      [HOUSEHOLD_SCOPE, (month: CalendarMonth) => householdMonthSummary(LEDGER, CATEGORIES, month, ILS)],
      [YUVAL, (month: CalendarMonth) => personMonthSummary(LEDGER, CATEGORIES, "yuval", month, ILS)],
    ] as const) {
      const yearly = grid(2025, scope);
      yearly.months.forEach((column, index) => {
        const summary = read(column.month);
        expect(yearly.income.total.cells[index]?.amount ?? ils(0)).toEqual(summary.income);
        expect(yearly.expenses.total.cells[index]?.amount ?? ils(0)).toEqual(summary.expenses);
        expect(yearly.saving.cells[index]?.amount ?? ils(0)).toEqual(summary.saving);
      });
    }
  });

  it("derives חיסכון as הכנסות − הוצאות in every column, including the aggregates", () => {
    const yearly = grid(2025);
    expect(yearly.saving.aggregate.total).toEqual(
      subtract(yearly.income.total.aggregate.total, yearly.expenses.total.aggregate.total),
    );
    expect(yearly.saving.aggregate.months.map(monthKey)).toEqual(yearly.denominatorMonths.map(monthKey));
  });
});

describe("yearGrid — the order rows come out in", () => {
  it("puts the largest annual sum first by default", () => {
    const totals = grid(2025).expenses.rows.map((line) => line.aggregate.total.minorUnits);
    expect(totals).toEqual([...totals].sort((left, right) => right - left));
    expect(grid(2025).sort).toBe("size");
  });

  it("orders by Hebrew alphabet when asked, and it is a different order", () => {
    const alphabetical = grid(2025, HOUSEHOLD_SCOPE, TODAY, "name");
    const names = alphabetical.expenses.rows.map((line) => line.name);
    expect(names).toEqual([...names].sort((left, right) => new Intl.Collator("he").compare(left, right)));
    expect(names).not.toEqual(grid(2025).expenses.rows.map((line) => line.name));
  });

  it("renders the same order every time, in both orders", () => {
    for (const sort of ["size", "name"] as const) {
      const keys = () => grid(2025, HOUSEHOLD_SCOPE, TODAY, sort).expenses.rows.map((line) => line.key);
      expect(keys()).toEqual(keys());
    }
  });

  it("breaks a tie on the category key, so equal rows cannot swap places", () => {
    // Two categories with nothing recorded in 2027 both total nought.
    const tied = grid(2027, YUVAL, m(2027, 6), "size").expenses.rows.map((line) => line.key);
    expect(tied).toEqual([...tied].sort());
  });

  it("orders the contributions under a row the same way as the rows themselves", () => {
    const health = row(grid(2025).expenses.rows, "h-health");
    const totals = health.contributions.map((line) => line.aggregate.total.minorUnits);
    expect(totals).toEqual([...totals].sort((left, right) => right - left));

    const byName = row(grid(2025, HOUSEHOLD_SCOPE, TODAY, "name").expenses.rows, "h-health");
    expect(byName.contributions.map((line) => line.name)).toEqual(["בריאות", "רפואה"]);
  });
});

describe("yearGrid — a household row opens onto the people under it", () => {
  it("carries each משותף row's personal contributions across all twelve months", () => {
    const health = row(grid(2025).expenses.rows, "h-health");
    expect(health.contributions.map((line) => line.key).sort()).toEqual(["p-eden-health", "p-health"]);
    for (const contribution of health.contributions) {
      expect(contribution.cells).toHaveLength(12);
      expect(contribution.personId).not.toBeNull();
    }
  });

  it("adds the contributions up to the household row above them, in every column", () => {
    for (const line of [...grid(2025).income.rows, ...grid(2025).expenses.rows]) {
      if (line.contributions.length === 0) continue;

      expect(line.aggregate.total).toEqual(
        sum(line.contributions.map((contribution) => contribution.aggregate.total), ILS),
      );

      line.cells.forEach((cell, index) => {
        const parts = line.contributions.flatMap((contribution) => {
          const amount = contribution.cells[index]?.amount;
          return amount === undefined || amount === null ? [] : [amount];
        });
        expect(cell.amount).toEqual(parts.length === 0 ? null : sum(parts, ILS));
      });
    }
  });

  it("has nothing to open at person level, where the row is already personal", () => {
    for (const line of [...grid(2025, YUVAL).income.rows, ...grid(2025, YUVAL).expenses.rows]) {
      expect(line.contributions).toEqual([]);
    }
  });

  it("does not repeat a single-member household row underneath itself", () => {
    // חו"ל is Yuval's alone, so its household line has one member.
    expect(row(grid(2025).expenses.rows, "h-travel").contributions).toEqual([]);
  });
});

describe("yearGrid — which cells are worth a reader's attention", () => {
  it("marks a month that departs from its own row's average", () => {
    // חו"ל 2025: 9,905 in מאי against a ÷12 average of 825.42.
    const travel = row(grid(2025, YUVAL).expenses.rows, "p-travel");
    expect(travel.cells[4]?.deviation).toBe("above");
    expect(travel.cells.filter((cell) => cell.deviation !== null)).toHaveLength(1);
  });

  it("measures against the row and never against the table", () => {
    // משכורת is twenty times the size of every expense row and never moves.
    // Against the table it would dominate; against itself it is unremarkable.
    const salary = row(grid(2025, YUVAL).income.rows, "p-salary");
    expect(salary.cells.every((cell) => cell.deviation === null)).toBe(true);
  });

  it("marks a fall below the row's own average as well as a rise above it", () => {
    // 3,000 every month bar פברואר, which is a recorded nought — a real month of
    // no spending, 2,750 below the ÷12 average, and the one month of the row
    // worth looking at. The other eleven are 250 off it and are left alone.
    const steady = buildLedger({
      entered: entries({ "p-health": monthsOf(2025, 1, [3000, 0, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000]) }),
    });
    const line = yearGrid(steady, CATEGORIES, YUVAL, 2025, ILS, TODAY).expenses.rows.find(
      (candidate) => candidate.key === "p-health",
    );
    expect(line?.cells[1]?.amount).toEqual(ils(0));
    expect(line?.cells[1]?.deviation).toBe("below");
    expect(line?.cells.filter((cell) => cell.deviation !== null)).toHaveLength(1);
  });

  it("leaves a row alone when the swing is large as a share but small as money", () => {
    // חשמל holds 700 in four months of 2025 and nothing after, so each of them is
    // three times its own ÷12 average of 233.33 — and 466.67₪, which is not news.
    // This is the case a relative test on its own would mark four times.
    const power = row(grid(2025, YUVAL).expenses.rows, "p-power");
    expect(power.cells[0]?.amount).toEqual(ils(700));
    expect(power.cells.every((cell) => cell.deviation === null)).toBe(true);
  });

  it("marks nothing at all when the row has no average to have departed from", () => {
    const future = grid(2027);
    expect(future.income.total.aggregate.amount).toBeNull();
    expect(future.saving.cells.every((cell) => cell.deviation === null)).toBe(true);
  });

  it("never marks a month that was never recorded", () => {
    for (const line of [...grid(2025).income.rows, ...grid(2025).expenses.rows]) {
      for (const cell of line.cells) {
        if (cell.amount === null) expect(cell.deviation).toBeNull();
      }
    }
  });
});

describe("yearGrid — the year totals agree with the month they are read from", () => {
  it("totals each band to the same figure the monthly reading gives over the same months", () => {
    // The grid and /balance/insights must never state one figure two ways: the
    // year's totals here are the sum of exactly the months the trend screen reads.
    const yearly = grid(2025);
    const summaries = yearly.denominatorMonths.map((month) =>
      householdMonthSummary(LEDGER, CATEGORIES, month, ILS),
    );
    expect(yearly.income.total.aggregate.total).toEqual(sum(summaries.map((s) => s.income), ILS));
    expect(yearly.expenses.total.aggregate.total).toEqual(sum(summaries.map((s) => s.expenses), ILS));
    expect(yearly.saving.aggregate.total).toEqual(sum(summaries.map((s) => s.saving), ILS));
  });
});

describe("recordedYears — what a year selector may offer", () => {
  it("offers exactly the years the ledger holds data for", () => {
    expect(recordedYears(LEDGER)).toEqual([2024, 2025, 2026]);
  });

  it("offers nothing for a ledger with nothing in it", () => {
    expect(recordedYears(EMPTY_LEDGER)).toEqual([]);
  });
});
