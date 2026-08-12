import { describe, expect, it } from "vitest";

import { type Money, exchangeRate, money } from "@/domain/money/money";
import { calendarMonth, monthKey } from "@/domain/time/calendar-month";

import {
  type SavingAllocation,
  InvalidAllocationError,
  allocationsOf,
  buildSavingAllocation,
  projectAllocations,
} from "./allocations";

/**
 * Plain data in, plain data out: no database, no browser, no network. Every money
 * assertion is on exact minor units — a household reads "the emergency fund is full
 * in month 24" and acts on it.
 */

const ils = (major: number): Money => money(Math.round(major * 100), "ILS");
const usd = (major: number): Money => money(Math.round(major * 100), "USD");
const m = (year: number, month: number) => calendarMonth(year, month);

const PLAN = "cgm3";

function allocation(
  id: string,
  goal: string,
  monthly: Money,
  target: Money | null = null,
  scenarioId = PLAN,
): SavingAllocation {
  return buildSavingAllocation(id, { scenarioId, goal, monthly, target });
}

/** The household's own example: 5,000 to the emergency fund, 10,000 to real estate. */
function household(): readonly SavingAllocation[] {
  return [
    allocation("emergency", "קרן חירום", ils(5_000), ils(120_000)),
    allocation("property", 'נדל"ן', ils(10_000)),
  ];
}

// --- one allocation ----------------------------------------------------------

describe("an allocation is a goal and a monthly amount", () => {
  it("records the goal, the monthly amount and an optional target", () => {
    expect(allocation("emergency", "  קרן   חירום ", ils(5_000), ils(120_000))).toEqual({
      id: "emergency",
      scenarioId: PLAN,
      goal: "קרן חירום",
      monthly: ils(5_000),
      target: ils(120_000),
    });
  });

  it("treats no target as a complete intention rather than as a missing field", () => {
    expect(allocation("property", 'נדל"ן', ils(10_000)).target).toBeNull();
  });

  it("refuses a goal with no name, no amount, or a target in another currency", () => {
    expect(() => allocation("x", "   ", ils(5_000))).toThrow(InvalidAllocationError);
    expect(() => allocation("x", "קרן חירום", ils(0))).toThrow(InvalidAllocationError);
    expect(() => allocation("x", "קרן חירום", ils(-5_000))).toThrow(InvalidAllocationError);
    expect(() => allocation("x", "קרן חירום", ils(5_000), usd(30_000))).toThrow(
      InvalidAllocationError,
    );
  });

  it("reads one scenario's allocations, largest first", () => {
    const other = allocation("other", "טיול", ils(50_000), null, "meteor");
    expect(allocationsOf([...household(), other], PLAN).map((line) => line.id)).toEqual([
      "property",
      "emergency",
    ]);
  });
});

// --- played forward ----------------------------------------------------------

describe("allocations played out over time", () => {
  it("accumulates each goal separately, month by month", () => {
    const projection = projectAllocations({
      allocations: household(),
      scenarioId: PLAN,
      from: m(2026, 9),
      months: 3,
    });

    expect(projection.months.map((month) => monthKey(month.month))).toEqual([
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
    expect(projection.committed).toEqual(ils(15_000));

    const [september, october, november] = projection.months;
    expect(september?.cumulative).toEqual(ils(15_000));
    expect(october?.cumulative).toEqual(ils(30_000));
    expect(november?.cumulative).toEqual(ils(45_000));

    // Largest first, so נדל"ן leads and קרן חירום follows.
    expect(november?.goals.map((goal) => [goal.goal, goal.cumulative.minorUnits])).toEqual([
      ['נדל"ן', 30_000_00],
      ["קרן חירום", 15_000_00],
    ]);
  });

  it("says which month a target is reached in, and counts the first month as one", () => {
    const projection = projectAllocations({
      allocations: household(),
      scenarioId: PLAN,
      from: m(2026, 9),
      months: 36,
    });

    const emergency = projection.goals.find((goal) => goal.allocation.id === "emergency");
    // 120,000 at 5,000 a month is 24 months, and the 24th is August 2028.
    expect(emergency?.monthsToTarget).toBe(24);
    expect(emergency?.reachesIn).toEqual(m(2028, 8));
    expect(emergency?.shortOfTarget).toBeNull();
    expect(emergency?.ending).toEqual(ils(180_000));
  });

  it("reports what a target is still short of rather than reporting it reached", () => {
    const projection = projectAllocations({
      allocations: household(),
      scenarioId: PLAN,
      from: m(2026, 9),
      months: 12,
    });

    const emergency = projection.goals.find((goal) => goal.allocation.id === "emergency");
    expect(emergency?.reachesIn).toBeNull();
    expect(emergency?.monthsToTarget).toBeNull();
    expect(emergency?.ending).toEqual(ils(60_000));
    expect(emergency?.shortOfTarget).toEqual(ils(60_000));
  });

  it("has no target to reach where none was set", () => {
    const projection = projectAllocations({
      allocations: household(),
      scenarioId: PLAN,
      from: m(2026, 9),
      months: 36,
    });

    const property = projection.goals.find((goal) => goal.allocation.id === "property");
    expect(property?.reachesIn).toBeNull();
    expect(property?.shortOfTarget).toBeNull();
    expect(property?.ending).toEqual(ils(360_000));
  });

  it("starts every goal from nought, because these are contributions and not balances", () => {
    const projection = projectAllocations({
      allocations: [allocation("emergency", "קרן חירום", ils(5_000), ils(5_000))],
      scenarioId: PLAN,
      from: m(2026, 9),
      months: 2,
    });

    expect(projection.months[0]?.goals[0]?.cumulative).toEqual(ils(5_000));
    expect(projection.goals[0]?.monthsToTarget).toBe(1);
  });

  it("crosses a year boundary without stitching", () => {
    const projection = projectAllocations({
      allocations: [allocation("emergency", "קרן חירום", ils(5_000))],
      scenarioId: PLAN,
      from: m(2026, 11),
      months: 4,
    });

    expect(projection.months.map((month) => monthKey(month.month))).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    expect(projection.months[3]?.cumulative).toEqual(ils(20_000));
  });

  it("refuses a horizon that is not a whole number of months greater than zero", () => {
    for (const months of [0, -3, 2.5]) {
      expect(() =>
        projectAllocations({ allocations: household(), scenarioId: PLAN, from: m(2026, 9), months }),
      ).toThrow(InvalidAllocationError);
    }
  });

  it("refuses two currencies inside one scenario's allocations", () => {
    expect(() =>
      projectAllocations({
        allocations: [
          allocation("emergency", "קרן חירום", ils(5_000)),
          allocation("apple", "Apple RSU", usd(2_000)),
        ],
        scenarioId: PLAN,
        from: m(2026, 9),
        months: 3,
      }),
    ).toThrow(InvalidAllocationError);
  });

  it("projects a scenario with no allocations at all, in the currency it is told", () => {
    const projection = projectAllocations({
      allocations: [],
      scenarioId: PLAN,
      from: m(2026, 9),
      months: 2,
      currency: "ILS",
    });

    expect(projection.committed).toEqual(ils(0));
    expect(projection.months).toHaveLength(2);
    expect(projection.goals).toEqual([]);

    expect(() =>
      projectAllocations({ allocations: [], scenarioId: PLAN, from: m(2026, 9), months: 2 }),
    ).toThrow(InvalidAllocationError);
  });
});

// --- held against what the household actually saves ---------------------------

describe("what is committed against what is saved", () => {
  it("reports saving left unspoken for", () => {
    const projection = projectAllocations({
      allocations: household(),
      scenarioId: PLAN,
      from: m(2026, 9),
      months: 6,
      pace: ils(18_000),
    });

    expect(projection.paceStanding).toBe("computed");
    expect(projection.pace).toEqual(ils(18_000));
    expect(projection.unallocated).toEqual(ils(3_000));
    expect(projection.over).toBeNull();
  });

  it("reports over-commitment rather than quietly shrinking the promise", () => {
    const projection = projectAllocations({
      allocations: household(),
      scenarioId: PLAN,
      from: m(2026, 9),
      months: 6,
      pace: ils(12_000),
    });

    expect(projection.over).toEqual(ils(3_000));
    expect(projection.unallocated).toBeNull();
    // The projection still plays out the promise that was made, undamped.
    expect(projection.months[5]?.cumulative).toEqual(ils(90_000));
  });

  it("is neither over nor under when the two agree exactly", () => {
    const projection = projectAllocations({
      allocations: household(),
      scenarioId: PLAN,
      from: m(2026, 9),
      months: 1,
      pace: ils(15_000),
    });

    expect(projection.over).toBeNull();
    expect(projection.unallocated).toBeNull();
    expect(projection.paceStanding).toBe("computed");
  });

  it("reads the pace across currencies at a stated rate", () => {
    const projection = projectAllocations({
      allocations: [allocation("apple", "Apple RSU", usd(3_000))],
      scenarioId: PLAN,
      from: m(2026, 9),
      months: 6,
      pace: ils(14_600),
      rate: exchangeRate("USD", "ILS", 3.65),
    });

    // 14,600₪ ÷ 3.65 is exactly $4,000, so 3,000 of it is committed.
    expect(projection.pace).toEqual(usd(4_000));
    expect(projection.unallocated).toEqual(usd(1_000));
  });

  it("says there is no rate rather than converting at one nobody quoted", () => {
    const projection = projectAllocations({
      allocations: [allocation("apple", "Apple RSU", usd(3_000))],
      scenarioId: PLAN,
      from: m(2026, 9),
      months: 6,
      pace: ils(14_600),
    });

    expect(projection.paceStanding).toBe("no-rate");
    expect(projection.pace).toBeNull();
    expect(projection.over).toBeNull();
    expect(projection.unallocated).toBeNull();
  });

  it("says there is no pace rather than reading an unrecorded מאזן as nought", () => {
    const projection = projectAllocations({
      allocations: household(),
      scenarioId: PLAN,
      from: m(2026, 9),
      months: 6,
      pace: null,
    });

    expect(projection.paceStanding).toBe("no-pace");
    expect(projection.over).toBeNull();
    expect(projection.unallocated).toBeNull();
    // And the allocations are still projected: an intention does not need a pace.
    expect(projection.months[5]?.cumulative).toEqual(ils(90_000));
  });

  it("reports the whole commitment as over when the household saves nothing", () => {
    const projection = projectAllocations({
      allocations: household(),
      scenarioId: PLAN,
      from: m(2026, 9),
      months: 6,
      pace: ils(0),
    });

    expect(projection.over).toEqual(ils(15_000));
  });
});
