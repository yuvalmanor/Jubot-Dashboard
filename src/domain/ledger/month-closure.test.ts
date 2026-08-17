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
  buildLedger,
  completenessOf,
  householdMonthSummary,
  readAmount,
} from "@/domain/ledger/ledger";
import { HOUSEHOLD_SCOPE, personScope } from "@/domain/ledger/ledger-analytics";
import { money } from "@/domain/money/money";
import { type CalendarMonth, calendarMonth, monthKey, monthRange } from "@/domain/time/calendar-month";

import { isMonthClosed, monthClosure, planMonthClosure } from "./month-closure";

/**
 * Closing a month, tested against plain data. No database is imported here and
 * none is needed: closedness is derived from the ledger, so the ledger is the
 * whole input.
 */

const ILS = "ILS" as const;
const ils = (major: number) => money(Math.round(major * 100), ILS);
const m = (year: number, month: number) => calendarMonth(year, month);

const YUVAL = personScope("yuval");
const EDEN = personScope("eden");

/**
 * Two People. חשמל is Yuval's and is retired at מרץ 2025; חו"ל is Yuval's and only
 * starts in 2025 — the two lifespans are what make "active in the month" mean
 * something other than "exists".
 */
function categories(): Categories {
  const specs = [
    { person: "yuval", name: "משכורת", key: "salary", type: "income" as const, household: "h-salary", from: m(2024, 7) },
    { person: "eden", name: "משכורת עדן", key: "eden-salary", type: "income" as const, household: "h-salary", from: m(2024, 7) },
    { person: "yuval", name: "בריאות", key: "health", type: "expense" as const, household: "h-health", from: m(2024, 7) },
    { person: "eden", name: "רפואה", key: "eden-health", type: "expense" as const, household: "h-health", from: m(2024, 7) },
    { person: "yuval", name: "חשמל", key: "power", type: "expense" as const, household: "h-power", from: m(2024, 7) },
    { person: "yuval", name: 'חו"ל', key: "travel", type: "expense" as const, household: "h-travel", from: m(2025, 1) },
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

const CATEGORIES = applyLifespan(
  categories(),
  planLifespanChange(categories(), "p-power", { activeUntil: m(2025, 3) }),
);

function entries(table: Record<string, Record<string, number>>): EnteredEntry[] {
  return Object.entries(table).flatMap(([personalCategoryId, months]) =>
    Object.entries(months).map(([key, major]) => ({
      personalCategoryId,
      month: m(Number(key.slice(0, 4)), Number(key.slice(5, 7))),
      amount: ils(major),
    })),
  );
}

/**
 * ינואר 2025 holds every category active in it. פברואר is missing רפואה alone.
 * מרץ is missing three. אפריל is past חשמל's retirement, so its four active
 * categories are all recorded and it is closed with חשמל absent entirely.
 */
const LEDGER = buildLedger({
  entered: entries({
    "p-salary": { "2025-01": 21000, "2025-02": 21000, "2025-03": 21000, "2025-04": 21000 },
    "p-eden-salary": { "2025-01": 16000, "2025-02": 16000, "2025-04": 16000 },
    "p-health": { "2025-01": 400, "2025-02": 0, "2025-04": 400 },
    "p-eden-health": { "2025-01": 100, "2025-04": 100 },
    "p-power": { "2025-01": 700, "2025-02": 700, "2025-03": 700 },
    "p-travel": { "2025-01": 0, "2025-02": 0, "2025-03": 0, "2025-04": 9905 },
  }),
});

const closureOf = (month: CalendarMonth, scope = HOUSEHOLD_SCOPE) =>
  monthClosure(LEDGER, CATEGORIES, scope, month);

const blankKeys = (month: CalendarMonth, scope = HOUSEHOLD_SCOPE) =>
  closureOf(month, scope)
    .blanks.map((category) => category.id)
    .sort();

describe("monthClosure — a month is closed when every active category has a reading", () => {
  it("closes a month in which every category active in it holds a figure", () => {
    const closure = closureOf(m(2025, 1));
    expect(closure.state).toBe("closed");
    expect(isMonthClosed(closure)).toBe(true);
    expect(closure.blanks).toEqual([]);
    expect(closure.recordedCount).toBe(6);
    expect(closure.categoryCount).toBe(6);
  });

  it("leaves a month open and names exactly what is missing", () => {
    expect(closureOf(m(2025, 2)).state).toBe("open");
    expect(blankKeys(m(2025, 2))).toEqual(["p-eden-health"]);
    expect(blankKeys(m(2025, 3))).toEqual(["p-eden-health", "p-eden-salary", "p-health"]);
  });

  it("counts a figure of nought as a reading, because that is what it is", () => {
    // בריאות is 0 in פברואר and חו"ל is 0 in three months; neither leaves a blank.
    expect(blankKeys(m(2025, 2))).not.toContain("p-health");
    expect(readAmount(LEDGER, "p-health", m(2025, 2))?.amount).toEqual(ils(0));
  });

  it("asks only about the categories active in the month", () => {
    // חשמל retired at מרץ 2025, so אפריל never asks for it and is closed without it.
    const april = closureOf(m(2025, 4));
    expect(april.state).toBe("closed");
    expect(april.categoryCount).toBe(5);
    expect(april.blanks).toEqual([]);
  });

  it("never counts a recorded figure as a blank, whatever the lifespan since became", () => {
    // חשמל is retired and מרץ 2025 is inside its lifespan; its figure is there.
    expect(blankKeys(m(2025, 3))).not.toContain("p-power");
  });

  it("reports a month no category was active in as empty rather than as everything missing", () => {
    const closure = closureOf(m(2024, 1));
    expect(closure.state).toBe("empty");
    expect(closure.categoryCount).toBe(0);
    expect(closure.blanks).toEqual([]);
  });

  it("distinguishes a month with categories and nothing typed from a month with no categories", () => {
    // יולי 2024: five categories active, none recorded. Open, not empty.
    const closure = closureOf(m(2024, 7));
    expect(closure.state).toBe("open");
    expect(closure.recordedCount).toBe(0);
    expect(closure.categoryCount).toBe(5);
  });

  it("answers at person level about that person's categories alone", () => {
    expect(blankKeys(m(2025, 3), YUVAL)).toEqual(["p-health"]);
    expect(blankKeys(m(2025, 3), EDEN)).toEqual(["p-eden-health", "p-eden-salary"]);
    expect(closureOf(m(2025, 2), YUVAL).state).toBe("closed");
    expect(closureOf(m(2025, 2), EDEN).state).toBe("open");
  });

  it("is the same fact as a complete month, so the application holds one answer and not two", () => {
    for (const month of monthRange(m(2024, 7), m(2025, 12))) {
      const summary = householdMonthSummary(LEDGER, CATEGORIES, month, ILS);
      const complete = completenessOf(summary) === "complete";
      expect({ month: monthKey(month), closed: isMonthClosed(closureOf(month)) }).toEqual({
        month: monthKey(month),
        closed: complete,
      });
    }
  });
});

describe("planMonthClosure — what accepting the offer writes", () => {
  it("writes one zero per blank that was named on screen, in the order they were named", () => {
    const closure = closureOf(m(2025, 3));
    const named = closure.blanks.map((category) => category.id);
    // Hebrew alphabetical, the order the month screen lists them in: בריאות,
    // משכורת עדן, רפואה.
    expect(planMonthClosure(closure, named, ILS)).toEqual([
      { personalCategoryId: "p-health", amount: ils(0) },
      { personalCategoryId: "p-eden-salary", amount: ils(0) },
      { personalCategoryId: "p-eden-health", amount: ils(0) },
    ]);
  });

  it("writes nothing at all for a month that is already closed", () => {
    expect(planMonthClosure(closureOf(m(2025, 1)), ["p-health", "p-salary"], ILS)).toEqual([]);
  });

  it("leaves a blank that was not named alone — nothing is written that was not shown", () => {
    const closure = closureOf(m(2025, 3));
    expect(planMonthClosure(closure, ["p-health"], ILS).map((write) => write.personalCategoryId)).toEqual([
      "p-health",
    ]);
  });

  it("changes no figure that was already recorded, even when one is named", () => {
    const closure = closureOf(m(2025, 3));
    // Everything on the screen, including the three categories מרץ already holds.
    const named = CATEGORIES.personal.map((category) => category.id);
    const written = planMonthClosure(closure, named, ILS).map((write) => write.personalCategoryId);

    for (const id of written) {
      expect(readAmount(LEDGER, id, m(2025, 3))).toBeNull();
    }
    expect(written).not.toContain("p-power");
    expect(written).not.toContain("p-salary");
    expect(written).not.toContain("p-travel");
  });

  it("closes the month when its writes are applied, and moves no figure that was there", () => {
    const month = m(2025, 3);
    const closure = closureOf(month);
    const writes = planMonthClosure(closure, closure.blanks.map((category) => category.id), ILS);

    const closed = buildLedger({
      entered: [
        ...entries({
          "p-salary": { "2025-01": 21000, "2025-02": 21000, "2025-03": 21000, "2025-04": 21000 },
          "p-eden-salary": { "2025-01": 16000, "2025-02": 16000, "2025-04": 16000 },
          "p-health": { "2025-01": 400, "2025-02": 0, "2025-04": 400 },
          "p-eden-health": { "2025-01": 100, "2025-04": 100 },
          "p-power": { "2025-01": 700, "2025-02": 700, "2025-03": 700 },
          "p-travel": { "2025-01": 0, "2025-02": 0, "2025-03": 0, "2025-04": 9905 },
        }),
        ...writes.map((write) => ({ ...write, month })),
      ],
    });

    expect(isMonthClosed(monthClosure(closed, CATEGORIES, HOUSEHOLD_SCOPE, month))).toBe(true);

    // Every figure מרץ already held reads exactly as it did.
    for (const id of ["p-salary", "p-power", "p-travel"]) {
      expect(readAmount(closed, id, month)).toEqual(readAmount(LEDGER, id, month));
    }
    // And the zeros are ordinary entered figures, not a state of their own.
    expect(readAmount(closed, "p-health", month)).toEqual({ source: "entered", amount: ils(0) });
  });
});
