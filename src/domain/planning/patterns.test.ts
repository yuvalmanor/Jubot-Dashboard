import { describe, expect, it } from "vitest";

import { type Money, money } from "@/domain/money/money";
import { type DealTerms, buildDealTerms } from "@/domain/projects/projects";
import { calendarDate } from "@/domain/time/calendar-date";
import { calendarMonth, monthKey } from "@/domain/time/calendar-month";

import {
  type EffectiveTerms,
  type InvestmentPattern,
  InvalidPatternError,
  buildInvestmentPattern,
  buildScenarioTerms,
  distributionOf,
  effectiveTerms,
  occurrenceDates,
  patternFor,
  projectPattern,
} from "./patterns";

/**
 * Plain data in, plain data out: no database, no browser, no network. The figures
 * are exact minor units, because "the fourth CGM is where this runs out" is a
 * sentence somebody plans ten years around.
 */

const usd = (major: number): Money => money(Math.round(major * 100), "USD");
const ils = (major: number): Money => money(Math.round(major * 100), "ILS");
const d = (year: number, month: number, day: number) => calendarDate(year, month, day);
const m = (year: number, month: number) => calendarMonth(year, month);

const PLAN = "every-year";
const CGM = "cgm1";

/** "A CGM every year for ten years" — the sentence the PRD names. */
function everyYear(overrides: Partial<Parameters<typeof buildInvestmentPattern>[0]> = {}): InvestmentPattern {
  return buildInvestmentPattern({
    scenarioId: PLAN,
    amount: usd(100_000),
    everyMonths: 12,
    occurrences: 10,
    firstOn: d(2027, 1, 15),
    modelledOn: CGM,
    ...overrides,
  });
}

function recorded(fields: Partial<DealTerms> = {}): DealTerms {
  return buildDealTerms({
    projectId: CGM,
    targetReturnBasisPoints: 1_825,
    holdMonths: 36,
    distribution: "רבעוני",
    source: "מצגת היזם",
    recordedOn: d(2026, 3, 1),
    ...fields,
  });
}

function terms(input: {
  recorded?: readonly DealTerms[];
  overrides?: readonly ReturnType<typeof buildScenarioTerms>[];
}): EffectiveTerms {
  return effectiveTerms({
    scenarioId: PLAN,
    projectId: CGM,
    recorded: input.recorded ?? [recorded()],
    overrides: input.overrides ?? [],
  });
}

// --- the pattern -------------------------------------------------------------

describe("a repeating pattern is a strategy said as data", () => {
  it("records the amount, the gap, how many times and where it starts", () => {
    expect(everyYear()).toEqual({
      scenarioId: PLAN,
      amount: usd(100_000),
      everyMonths: 12,
      occurrences: 10,
      firstOn: d(2027, 1, 15),
      modelledOn: CGM,
    });
  });

  it("lands on the same day of the month, ten years running", () => {
    const dates = occurrenceDates(everyYear());
    expect(dates).toHaveLength(10);
    expect(dates[0]).toEqual(d(2027, 1, 15));
    expect(dates[9]).toEqual(d(2036, 1, 15));
  });

  it("refuses a pattern with no amount, no occurrences or no gap", () => {
    expect(() => everyYear({ amount: usd(0) })).toThrow(InvalidPatternError);
    expect(() => everyYear({ occurrences: 0 })).toThrow(InvalidPatternError);
    expect(() => everyYear({ everyMonths: 0 })).toThrow(InvalidPatternError);
    expect(() => everyYear({ occurrences: 2.5 })).toThrow(InvalidPatternError);
  });

  it("refuses a pattern reaching further than a household plans", () => {
    expect(() => everyYear({ occurrences: 60, everyMonths: 12 })).toThrow(InvalidPatternError);
  });

  it("holds no pattern for a scenario that has none", () => {
    expect(patternFor([everyYear()], PLAN)).not.toBeNull();
    expect(patternFor([everyYear()], "another")).toBeNull();
  });
});

// --- the terms a projection runs on -------------------------------------------

describe("projections default to the recorded deal terms", () => {
  it("reads what the paperwork says when the scenario says nothing", () => {
    const effective = terms({});

    expect(effective.basis).toBe("recorded");
    expect(effective.targetReturnBasisPoints).toBe(1_825);
    expect(effective.holdMonths).toBe(36);
    expect(effective.overridden).toEqual([]);
    expect(effective.recorded?.projectId).toBe(CGM);
  });

  it("reads a project with no recorded terms as promising nothing", () => {
    const effective = terms({ recorded: [] });

    expect(effective.basis).toBe("none");
    expect(effective.targetReturnBasisPoints).toBeNull();
    expect(effective.holdMonths).toBeNull();
  });

  it("reads a row of nulls as no promise rather than as a promise of nothing", () => {
    const empty = buildDealTerms({ projectId: CGM, recordedOn: d(2026, 3, 1) });
    expect(terms({ recorded: [empty] }).basis).toBe("none");
  });
});

describe("a scenario overrides the terms without touching them", () => {
  it("lays only the fields it states over the recorded ones", () => {
    const effective = terms({
      overrides: [
        buildScenarioTerms({ scenarioId: PLAN, projectId: CGM, targetReturnBasisPoints: 800 }),
      ],
    });

    expect(effective.basis).toBe("overridden");
    expect(effective.overridden).toEqual(["target-return"]);
    expect(effective.targetReturnBasisPoints).toBe(800);
    // Untouched, and still readable beside the override.
    expect(effective.holdMonths).toBe(36);
    expect(effective.recorded?.targetReturnBasisPoints).toBe(1_825);
  });

  it("states both fields when both are disagreed with", () => {
    const effective = terms({
      overrides: [
        buildScenarioTerms({
          scenarioId: PLAN,
          projectId: CGM,
          targetReturnBasisPoints: 800,
          holdMonths: 60,
        }),
      ],
    });

    expect(effective.overridden).toEqual(["target-return", "hold-period"]);
    expect(effective.holdMonths).toBe(60);
  });

  it("belongs to one scenario: another scenario's override is not read here", () => {
    const effective = terms({
      overrides: [
        buildScenarioTerms({ scenarioId: "someone-else", projectId: CGM, targetReturnBasisPoints: 1 }),
      ],
    });

    expect(effective.basis).toBe("recorded");
    expect(effective.targetReturnBasisPoints).toBe(1_825);
  });

  it("allows a loss as a stress test and refuses losing more than went in", () => {
    expect(
      buildScenarioTerms({ scenarioId: PLAN, projectId: CGM, targetReturnBasisPoints: -2_000 })
        .targetReturnBasisPoints,
    ).toBe(-2_000);
    expect(() =>
      buildScenarioTerms({ scenarioId: PLAN, projectId: CGM, targetReturnBasisPoints: -10_001 }),
    ).toThrow(InvalidPatternError);
    expect(() =>
      buildScenarioTerms({ scenarioId: PLAN, projectId: CGM, holdMonths: 0 }),
    ).toThrow(InvalidPatternError);
  });
});

describe("what one investment comes back as", () => {
  it("reads the stated return as the total over the hold period", () => {
    // 18.25% on $100,000 is $118,250 back, capital included.
    expect(distributionOf(usd(100_000), terms({}))).toEqual(usd(118_250));
  });

  it("returns the capital and nothing more where no return was stated", () => {
    expect(distributionOf(usd(100_000), terms({ recorded: [recorded({ targetReturnBasisPoints: null })] }))).toEqual(
      usd(100_000),
    );
  });

  it("returns nothing at all where no hold period was stated", () => {
    expect(distributionOf(usd(100_000), terms({ recorded: [recorded({ holdMonths: null })] }))).toBeNull();
    expect(distributionOf(usd(100_000), null)).toBeNull();
  });

  it("rounds a promise at the cent and never at a float", () => {
    // 3.33% of $1,000.01 — the arithmetic runs on exact fractions.
    expect(distributionOf(money(1_000_01, "USD"), terms({ recorded: [recorded({ targetReturnBasisPoints: 333 })] })))
      .toEqual(money(1_033_31, "USD"));
  });
});

// --- the pattern played forward ----------------------------------------------

describe("a repeating pattern projected over multiple years", () => {
  it("pays for each occurrence out of what has accumulated, and reports what comes back", () => {
    const projection = projectPattern({
      pattern: everyYear({ occurrences: 3, amount: usd(60_000) }),
      terms: terms({ recorded: [recorded({ holdMonths: 12, targetReturnBasisPoints: 1_000 })] }),
      from: m(2026, 9),
      monthly: usd(5_000),
      opening: usd(45_000),
    });

    // Runs to the last occurrence (January 2029) plus its twelve-month hold.
    expect(monthKey(projection.from)).toBe("2026-09");
    expect(monthKey(projection.to)).toBe("2030-01");

    expect(projection.investments.map((investment) => investment.funded)).toEqual([
      true,
      true,
      true,
    ]);
    expect(projection.firstMissed).toBeNull();
    expect(projection.fundedCount).toBe(3);
    expect(projection.invested).toEqual(usd(180_000));

    // Each $60,000 comes back as $66,000 a year later; all three land inside the horizon.
    expect(projection.distributed).toEqual(usd(198_000));
    expect(projection.outstanding).toEqual(usd(0));
    expect(projection.investments[0]?.returnsIn).toEqual(m(2028, 1));
    expect(projection.investments[0]?.returns).toEqual(usd(66_000));
  });

  it("names the occurrence the money runs out at, and does not slide it forward", () => {
    const projection = projectPattern({
      pattern: everyYear({ occurrences: 4, amount: usd(60_000) }),
      terms: terms({ recorded: [recorded({ holdMonths: 120, targetReturnBasisPoints: 1_000 })] }),
      from: m(2026, 9),
      monthly: usd(4_000),
      opening: usd(0),
      months: 60,
    });

    // 4,000 a month: January 2027 has 20,000 and the first one already fails.
    const [first] = projection.investments;
    expect(first?.funded).toBe(false);
    expect(first?.available).toEqual(usd(20_000));
    expect(first?.shortfall).toEqual(usd(40_000));
    expect(first?.month).toEqual(m(2027, 1));
    expect(projection.firstMissed).toBe(1);

    // And it is not retried: the second one is judged on its own date.
    expect(projection.investments[1]?.month).toEqual(m(2028, 1));
    expect(projection.investments[1]?.funded).toBe(true);
    expect(projection.investments[1]?.available).toEqual(usd(68_000));
  });

  it("lets what comes back pay for what comes next", () => {
    const withReturns = projectPattern({
      pattern: everyYear({ occurrences: 3, amount: usd(50_000), everyMonths: 24 }),
      terms: terms({ recorded: [recorded({ holdMonths: 12, targetReturnBasisPoints: 2_000 })] }),
      from: m(2026, 9),
      monthly: usd(1_500),
      opening: usd(45_000),
      months: 120,
    });

    const withoutReturns = projectPattern({
      pattern: everyYear({ occurrences: 3, amount: usd(50_000), everyMonths: 24 }),
      terms: terms({ recorded: [recorded({ holdMonths: null })] }),
      from: m(2026, 9),
      monthly: usd(1_500),
      opening: usd(45_000),
      months: 120,
    });

    expect(withReturns.fundedCount).toBe(3);
    // The same saving without a promise coming back reaches fewer of them.
    expect(withoutReturns.fundedCount).toBeLessThan(withReturns.fundedCount);
    expect(withoutReturns.returnsNothing).toBe(true);
    expect(withoutReturns.distributed).toEqual(usd(0));
  });

  it("counts capital still out there at the end of the horizon", () => {
    const projection = projectPattern({
      pattern: everyYear({ occurrences: 2, amount: usd(50_000) }),
      terms: terms({ recorded: [recorded({ holdMonths: 36, targetReturnBasisPoints: 1_825 })] }),
      from: m(2026, 9),
      monthly: usd(5_000),
      opening: usd(50_000),
      months: 30,
    });

    // Both are paid for — January 2027 and January 2028 — and a thirty-six month
    // hold means neither has come back by the horizon in February 2029.
    expect(projection.invested).toEqual(usd(100_000));
    expect(projection.distributed).toEqual(usd(0));
    expect(projection.outstanding).toEqual(usd(100_000));
    expect(projection.investments[0]?.returnsIn).toEqual(m(2030, 1));
  });

  it("holds the balance to saved plus returned less invested, every month", () => {
    const projection = projectPattern({
      pattern: everyYear({ occurrences: 3, amount: usd(60_000) }),
      terms: terms({ recorded: [recorded({ holdMonths: 12, targetReturnBasisPoints: 1_000 })] }),
      from: m(2026, 9),
      monthly: usd(5_000),
      opening: usd(20_000),
    });

    let running = usd(20_000);
    for (const month of projection.months) {
      running = money(
        running.minorUnits +
          month.saved.minorUnits +
          month.distributed.minorUnits -
          month.invested.minorUnits,
        "USD",
      );
      expect(month.balance).toEqual(running);
    }
    expect(projection.ending).toEqual(running);
  });

  it("reports an occurrence dated before the projection starts as missed, not dropped", () => {
    const projection = projectPattern({
      pattern: everyYear({ occurrences: 3, amount: usd(10_000), firstOn: d(2025, 1, 15) }),
      terms: terms({}),
      from: m(2026, 9),
      monthly: usd(5_000),
      months: 24,
    });

    // January 2025 and January 2026 both fall before the projection begins.
    expect(projection.investments).toHaveLength(3);
    expect(projection.investments.map((investment) => monthKey(investment.month))).toEqual([
      "2025-01",
      "2026-01",
      "2027-01",
    ]);
    expect(projection.investments.map((investment) => investment.funded)).toEqual([
      false,
      false,
      true,
    ]);
    expect(projection.firstMissed).toBe(1);
  });

  it("runs on a pattern with no terms at all, and says nothing comes back", () => {
    const projection = projectPattern({
      pattern: everyYear({ occurrences: 2, amount: usd(30_000), modelledOn: null }),
      from: m(2026, 9),
      monthly: usd(3_000),
      months: 40,
    });

    expect(projection.terms).toBeNull();
    expect(projection.returnsNothing).toBe(true);
    expect(projection.investments.every((investment) => investment.returns === null)).toBe(true);
    expect(projection.outstanding).toEqual(projection.invested);
  });

  it("refuses a pace or an opening balance in another currency", () => {
    expect(() =>
      projectPattern({ pattern: everyYear(), from: m(2026, 9), monthly: ils(15_000) }),
    ).toThrow(InvalidPatternError);
    expect(() =>
      projectPattern({ pattern: everyYear(), from: m(2026, 9), opening: ils(15_000) }),
    ).toThrow(InvalidPatternError);
  });

  it("refuses terms belonging to a project the pattern is not modelled on", () => {
    expect(() =>
      projectPattern({
        pattern: everyYear({ modelledOn: "meteor6" }),
        terms: terms({}),
        from: m(2026, 9),
      }),
    ).toThrow(InvalidPatternError);
  });

  it("is stable across repeated computation", () => {
    const input = {
      pattern: everyYear({ occurrences: 4, amount: usd(40_000) }),
      terms: terms({}),
      from: m(2026, 9),
      monthly: usd(4_000),
      opening: usd(10_000),
    } as const;

    expect(projectPattern(input)).toEqual(projectPattern(input));
  });
});
