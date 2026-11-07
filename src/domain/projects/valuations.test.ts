import { describe, expect, it } from "vitest";

import { type Money, exchangeRate, money } from "@/domain/money/money";
import { calendarDate } from "@/domain/time/calendar-date";

import {
  type Project,
  type ProjectValuation,
  InvalidProjectValuationError,
  buildFundingLeg,
  buildProject,
  buildProjectDistribution,
  buildProjectValuation,
  growthOf,
  latestValuation,
  potOf,
  readProject,
  valuationsOf,
  valueOf,
} from "./projects";

/**
 * What a project is said to be worth, per ADR 0005.
 *
 * ADR 0003 held every illiquid asset at cost and was withdrawn: the CGM houses
 * are re-appraised and Meteor's sponsor reports its own growth. What replaces it
 * is narrow on purpose, and these are the three edges of that narrowness — a
 * valuation is an event and not a rate, it cannot exist without a source, and it
 * never reaches back into a date before it was stated.
 */

const usd = (major: number): Money => money(Math.round(major * 100), "USD");
const ils = (major: number): Money => money(Math.round(major * 100), "ILS");
const d = (year: number, month: number, day: number) => calendarDate(year, month, day);

/** CGM 1 as the household funded it: 109,800₪ at 3.65 and $69,000 of Apple RSU. */
function cgm1() {
  const project = buildProject("cgm1", {
    name: "CGM 1",
    currency: "USD",
    accountId: "cgm1-account",
    startedOn: d(2024, 3, 1),
  });

  const legs = [
    buildFundingLeg(
      "cgm1-ils",
      {
        projectId: "cgm1",
        source: 'עו"ש דיסקונט',
        amount: ils(109_800),
        rate: exchangeRate("USD", "ILS", 3.65),
        paidOn: d(2024, 3, 1),
      },
      project,
    ),
    buildFundingLeg(
      "cgm1-rsu",
      { projectId: "cgm1", source: "Apple RSU", amount: usd(69_000), paidOn: d(2024, 3, 1) },
      project,
    ),
  ];

  return { project, legs };
}

function valuation(
  id: string,
  project: Project,
  amount: Money,
  statedOn: ReturnType<typeof d>,
  basis: "market" | "estimate" = "market",
  source = "שמאות צד שלישי",
): ProjectValuation {
  return buildProjectValuation(id, { projectId: project.id, amount, basis, source, statedOn }, project);
}

// --- the row itself ----------------------------------------------------------

describe("recording a valuation", () => {
  it("cannot be recorded without a source", () => {
    const { project } = cgm1();
    expect(() => valuation("v1", project, usd(120_000), d(2026, 6, 1), "market", "   ")).toThrow(
      InvalidProjectValuationError,
    );
  });

  it("is stated in the pot's own currency, because nothing was converted", () => {
    const { project } = cgm1();
    expect(() =>
      buildProjectValuation(
        "v1",
        {
          projectId: project.id,
          amount: ils(430_000),
          basis: "market",
          source: "שמאות",
          statedOn: d(2026, 6, 1),
        },
        project,
      ),
    ).toThrow(InvalidProjectValuationError);
  });

  it("is not a negative figure, though it may be zero", () => {
    const { project } = cgm1();
    expect(() => valuation("v1", project, usd(-1), d(2026, 6, 1))).toThrow(
      InvalidProjectValuationError,
    );
    expect(valuation("v1", project, usd(0), d(2026, 6, 1)).amount).toEqual(usd(0));
  });

  it("carries one of the two bases a statement can have, and never עלות", () => {
    const { project } = cgm1();
    expect(valuation("v1", project, usd(1), d(2026, 1, 1), "estimate").basis).toBe("estimate");
    expect(() =>
      buildProjectValuation(
        "v2",
        {
          projectId: project.id,
          amount: usd(1),
          // Cost is what a project reads when nothing was stated about it, which
          // is not something anybody stated.
          basis: "cost" as "market",
          source: "דוח",
          statedOn: d(2026, 1, 1),
        },
        project,
      ),
    ).toThrow(InvalidProjectValuationError);
  });

  it("reads newest first, the opposite of the three ledgers", () => {
    const { project } = cgm1();
    const early = valuation("early", project, usd(110_000), d(2025, 6, 1));
    const late = valuation("late", project, usd(125_000), d(2026, 6, 1));

    expect(valuationsOf([early, late], project.id).map((one) => one.id)).toEqual(["late", "early"]);
    expect(valuationsOf([early, late], "someone-else")).toEqual([]);
  });
});

// --- what a project reads ----------------------------------------------------

describe("what a project is worth", () => {
  it("reads its cost while nothing has been stated about it", () => {
    const { project, legs } = cgm1();
    const value = valueOf({ project, legs });

    expect(value.basis).toBe("cost");
    expect(value.valuation).toBeNull();
    expect(value.amount).toEqual(usd(99_082.19));
    expect(value.amount).toEqual(value.cost);
  });

  it("reads the last figure stated about it, and says on which basis", () => {
    const { project, legs } = cgm1();
    const valuations = [
      valuation("v1", project, usd(110_000), d(2025, 6, 1)),
      valuation("v2", project, usd(125_000), d(2026, 6, 1), "estimate", "דוח היזם"),
    ];

    const value = valueOf({ project, legs, valuations });

    expect(value.amount).toEqual(usd(125_000));
    expect(value.basis).toBe("estimate");
    expect(value.valuation?.source).toBe("דוח היזם");
    // The cost does not move when a valuation lands beside it.
    expect(value.cost).toEqual(usd(99_082.19));
  });

  it("does not reach back behind the day it was stated", () => {
    const { project, legs } = cgm1();
    const valuations = [valuation("v1", project, usd(125_000), d(2026, 6, 1))];

    expect(valueOf({ project, legs, valuations, asOf: d(2026, 5, 31) }).basis).toBe("cost");
    expect(valueOf({ project, legs, valuations, asOf: d(2026, 6, 1) }).amount).toEqual(usd(125_000));
    expect(latestValuation(valuations, project.id, d(2024, 1, 1))).toBeNull();
  });

  it("interpolates nothing between two statements", () => {
    const { project, legs } = cgm1();
    const valuations = [
      valuation("v1", project, usd(100_000), d(2025, 1, 1)),
      valuation("v2", project, usd(200_000), d(2027, 1, 1)),
    ];

    // Halfway between them in time, and reading the earlier figure exactly — not
    // 150,000, which no document states.
    expect(valueOf({ project, legs, valuations, asOf: d(2026, 1, 1) }).amount).toEqual(usd(100_000));
  });
});

// --- the performance line ----------------------------------------------------

describe("what the project has come to", () => {
  it("says nothing at all while nothing has been stated", () => {
    const { project, legs } = cgm1();
    const value = valueOf({ project, legs });

    // Not 0%: with no valuation there is no finding, and a figure would read as
    // one.
    expect(growthOf(value, potOf(project, legs, []))).toBeNull();
  });

  it("counts what was taken out together with what is left standing", () => {
    const { project, legs } = cgm1();
    const taken = buildProjectDistribution(
      "d1",
      {
        projectId: project.id,
        description: "חלוקה רבעונית",
        amount: usd(9_000),
        destination: { kind: "out", accountId: "bank" },
        paidOn: d(2026, 3, 31),
      },
      project,
    );
    const valuations = [valuation("v1", project, usd(105_000), d(2026, 6, 1))];

    const value = valueOf({ project, legs, distributions: [taken], valuations });
    const growth = growthOf(value, potOf(project, legs, [], [taken]));

    // 105,000 standing + 9,000 taken, against the 99,082.19 that went in.
    expect(growth?.gain).toEqual(usd(14_917.81));
    expect(growth?.ratio).toBeCloseTo(14_917.81 / 99_082.19, 10);
  });

  it("measures against the cost, so a rolled dividend is not counted as profit twice", () => {
    const { project, legs } = cgm1();
    const rolled = buildProjectDistribution(
      "d1",
      {
        projectId: project.id,
        description: "חלוקה שגולגלה",
        amount: usd(9_000),
        destination: { kind: "rolled" },
        paidOn: d(2026, 3, 31),
      },
      project,
    );
    const valuations = [valuation("v1", project, usd(108_082.19), d(2026, 6, 1))];

    const value = valueOf({ project, legs, distributions: [rolled], valuations });
    const growth = growthOf(value, potOf(project, legs, [], [rolled]));

    // The valuation covers the rolled money, and so does the cost it is measured
    // against: 99,082.19 + 9,000. Nothing was gained, and the line says so.
    expect(growth?.cost).toEqual(usd(108_082.19));
    expect(growth?.gain).toEqual(usd(0));
    expect(growth?.ratio).toBe(0);
  });

  it("states no ratio for a project nothing was put into", () => {
    const project = buildProject("empty", {
      name: "ריק",
      currency: "USD",
      accountId: null,
      startedOn: d(2026, 1, 1),
    });
    const valuations = [valuation("v1", project, usd(50), d(2026, 2, 1))];

    const growth = growthOf(valueOf({ project, legs: [], valuations }), potOf(project, [], []));

    expect(growth?.gain).toEqual(usd(50));
    expect(growth?.ratio).toBeNull();
  });
});

// --- the whole reading -------------------------------------------------------

describe("one project read whole", () => {
  it("carries its valuations, its value and its growth line together", () => {
    const { project, legs } = cgm1();
    const valuations = [valuation("v1", project, usd(125_000), d(2026, 6, 1))];

    const reading = readProject({ project, legs, expenses: [], valuations, terms: [] });

    expect(reading.valuations).toHaveLength(1);
    expect(reading.value.amount).toEqual(usd(125_000));
    expect(reading.growth?.gain).toEqual(usd(25_917.81));
    // `cost` is still the cost: the two sit beside each other and neither replaces
    // the other.
    expect(reading.cost).toEqual(usd(99_082.19));
  });

  it("reads at cost with no valuations, as every project did before ADR 0005", () => {
    const { project, legs } = cgm1();
    const reading = readProject({ project, legs, expenses: [], terms: [] });

    expect(reading.valuations).toEqual([]);
    expect(reading.value.amount).toEqual(reading.cost);
    expect(reading.value.basis).toBe("cost");
    expect(reading.growth).toBeNull();
  });
});
