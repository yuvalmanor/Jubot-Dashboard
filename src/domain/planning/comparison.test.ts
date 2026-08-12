import { describe, expect, it } from "vitest";

import { type Money, exchangeRate, money } from "@/domain/money/money";
import { buildDealTerms } from "@/domain/projects/projects";
import { calendarDate } from "@/domain/time/calendar-date";
import { calendarMonth } from "@/domain/time/calendar-month";

import { buildSavingAllocation, projectAllocations } from "./allocations";
import {
  type ComparableScenario,
  type ComparisonRow,
  type MoneyRow,
  InvalidComparisonError,
  compareScenarios,
} from "./comparison";
import { buildInvestmentPattern, effectiveTerms, projectPattern } from "./patterns";
import {
  type SavingPace,
  buildFundingPlan,
  buildPlannedSource,
  buildScenario,
  readScenario,
} from "./scenarios";

/**
 * Plain data in, plain data out. Every figure compared here is one the scenario's
 * own screen already shows, so the assertions are on the difference — which is the
 * only thing the comparison adds.
 */

const ils = (major: number): Money => money(Math.round(major * 100), "ILS");
const usd = (major: number): Money => money(Math.round(major * 100), "USD");
const d = (year: number, month: number, day: number) => calendarDate(year, month, day);
const m = (year: number, month: number) => calendarMonth(year, month);

/** A pace of 15,000₪ a month over six recorded months. */
function pace(monthly: Money | null = ils(15_000)): SavingPace {
  return {
    currency: "ILS",
    window: [],
    total: monthly ?? ils(0),
    monthly,
    denominator: monthly === null ? 0 : 6,
    incomplete: [],
    missing: [],
  };
}

interface SideInput {
  readonly id: string;
  readonly name: string;
  readonly needs?: Money | null;
  readonly sources?: readonly Money[];
  readonly allocations?: readonly (readonly [string, Money])[];
  readonly pattern?: { readonly amount: Money; readonly occurrences: number } | null;
}

function side(input: SideInput): ComparableScenario {
  const scenario = buildScenario(input.id, { name: input.name, createdOn: d(2026, 8, 12) });
  const plans =
    input.needs === undefined || input.needs === null
      ? []
      : [buildFundingPlan({ scenarioId: input.id, needs: input.needs, neededBy: d(2027, 6, 30) })];
  const sources = (input.sources ?? []).map((amount, index) =>
    buildPlannedSource(`${input.id}-${index}`, {
      scenarioId: input.id,
      source: `מקור ${index + 1}`,
      amount,
    }),
  );

  const allocations = (input.allocations ?? []).map(([goal, monthly], index) =>
    buildSavingAllocation(`${input.id}-goal-${index}`, { scenarioId: input.id, goal, monthly }),
  );

  const pattern =
    input.pattern === undefined || input.pattern === null
      ? null
      : buildInvestmentPattern({
          scenarioId: input.id,
          amount: input.pattern.amount,
          everyMonths: 12,
          occurrences: input.pattern.occurrences,
          firstOn: d(2027, 1, 15),
          modelledOn: "cgm1",
        });

  return {
    reading: readScenario({
      scenario,
      plans,
      sources,
      pace: pace(),
      rate: exchangeRate("USD", "ILS", 3.65),
    }),
    allocations:
      allocations.length === 0
        ? null
        : projectAllocations({
            allocations,
            scenarioId: input.id,
            from: m(2026, 9),
            months: 12,
            pace: ils(15_000),
          }),
    pattern:
      pattern === null
        ? null
        : projectPattern({
            pattern,
            terms: effectiveTerms({
              scenarioId: input.id,
              projectId: "cgm1",
              recorded: [
                buildDealTerms({
                  projectId: "cgm1",
                  targetReturnBasisPoints: 1_825,
                  holdMonths: 36,
                  recordedOn: d(2026, 3, 1),
                }),
              ],
              overrides: [],
            }),
            from: m(2026, 9),
            monthly: usd(4_000),
            months: 60,
          }),
  };
}

function row(rows: readonly ComparisonRow[], key: string): ComparisonRow | undefined {
  return rows.find((candidate) => candidate.key === key);
}

// --- two scenarios side by side ------------------------------------------------

describe("two scenarios compared", () => {
  it("states the difference on every figure the two share", () => {
    const comparison = compareScenarios(
      side({ id: "cgm3", name: "CGM 3", needs: usd(100_000), sources: [usd(40_000)] }),
      side({ id: "meteor7", name: "Meteor 7", needs: usd(60_000), sources: [usd(45_000)] }),
    );

    expect(comparison.sameCurrency).toBe(true);

    const needs = row(comparison.rows, "needs") as MoneyRow;
    expect(needs.left).toEqual(usd(100_000));
    expect(needs.right).toEqual(usd(60_000));
    expect(needs.difference).toEqual(usd(-40_000));
    expect(needs.smaller).toBe("right");

    const gap = row(comparison.rows, "gap") as MoneyRow;
    expect(gap.left).toEqual(usd(60_000));
    expect(gap.right).toEqual(usd(15_000));
    expect(gap.difference).toEqual(usd(-45_000));
    expect(gap.smaller).toBe("right");
  });

  it("compares months to close and the month each one closes in", () => {
    const comparison = compareScenarios(
      side({ id: "cgm3", name: "CGM 3", needs: usd(100_000), sources: [usd(40_000)] }),
      side({ id: "meteor7", name: "Meteor 7", needs: usd(60_000), sources: [usd(45_000)] }),
    );

    // 15,000₪ a month is $4,109.59; $60,000 takes 15 months and $15,000 takes 4.
    const months = row(comparison.rows, "months-to-close");
    expect(months?.left).toBe(15);
    expect(months?.right).toBe(4);
    expect(months?.difference).toBe(-11);
    expect(months?.smaller).toBe("right");
  });

  it("states both figures and no difference across currencies", () => {
    const comparison = compareScenarios(
      side({ id: "cgm3", name: "CGM 3", needs: usd(100_000) }),
      side({ id: "beit", name: "דירה", needs: ils(1_200_000) }),
    );

    expect(comparison.sameCurrency).toBe(false);
    expect(comparison.currencies).toEqual({ left: "USD", right: "ILS" });

    const needs = row(comparison.rows, "needs") as MoneyRow;
    expect(needs.left).toEqual(usd(100_000));
    expect(needs.right).toEqual(ils(1_200_000));
    expect(needs.comparable).toBe(false);
    expect(needs.difference).toBeNull();
    expect(needs.smaller).toBeNull();
  });

  it("states one side alone where the other has no plan at all", () => {
    const comparison = compareScenarios(
      side({ id: "cgm3", name: "CGM 3", needs: usd(100_000) }),
      side({ id: "idea", name: "רעיון" }),
    );

    const needs = row(comparison.rows, "needs") as MoneyRow;
    expect(needs.left).toEqual(usd(100_000));
    expect(needs.right).toBeNull();
    expect(needs.comparable).toBe(false);
    expect(needs.difference).toBeNull();
    expect(comparison.sameCurrency).toBe(false);
  });

  it("leaves out a row neither scenario says anything about", () => {
    const comparison = compareScenarios(
      side({ id: "cgm3", name: "CGM 3", needs: usd(100_000) }),
      side({ id: "meteor7", name: "Meteor 7", needs: usd(60_000) }),
    );

    expect(row(comparison.rows, "allocated-monthly")).toBeUndefined();
    expect(row(comparison.rows, "pattern-commitment")).toBeUndefined();
    expect(row(comparison.rows, "needs")).toBeDefined();
  });

  it("compares monthly allocations across goals", () => {
    const comparison = compareScenarios(
      side({
        id: "cgm3",
        name: "CGM 3",
        allocations: [
          ["קרן חירום", ils(5_000)],
          ['נדל"ן', ils(10_000)],
        ],
      }),
      side({ id: "meteor7", name: "Meteor 7", allocations: [['נדל"ן', ils(8_000)]] }),
    );

    const allocated = row(comparison.rows, "allocated-monthly") as MoneyRow;
    expect(allocated.left).toEqual(ils(15_000));
    expect(allocated.right).toEqual(ils(8_000));
    expect(allocated.difference).toEqual(ils(-7_000));
  });

  it("compares what two repeating patterns commit to, and how many are reachable", () => {
    const comparison = compareScenarios(
      side({ id: "cgm3", name: "CGM 3", pattern: { amount: usd(100_000), occurrences: 10 } }),
      side({ id: "meteor7", name: "Meteor 7", pattern: { amount: usd(50_000), occurrences: 4 } }),
    );

    const commitment = row(comparison.rows, "pattern-commitment") as MoneyRow;
    expect(commitment.left).toEqual(usd(1_000_000));
    expect(commitment.right).toEqual(usd(200_000));
    expect(commitment.difference).toEqual(usd(-800_000));

    const funded = row(comparison.rows, "pattern-funded");
    expect(funded?.left).not.toBeNull();
    expect(funded?.right).not.toBeNull();
  });

  it("refuses a scenario compared against itself", () => {
    const only = side({ id: "cgm3", name: "CGM 3", needs: usd(100_000) });
    expect(() => compareScenarios(only, only)).toThrow(InvalidComparisonError);
  });

  it("reads the same both ways round, with the difference reversed", () => {
    const left = side({ id: "cgm3", name: "CGM 3", needs: usd(100_000), sources: [usd(40_000)] });
    const right = side({ id: "meteor7", name: "Meteor 7", needs: usd(60_000) });

    const forwards = row(compareScenarios(left, right).rows, "needs") as MoneyRow;
    const backwards = row(compareScenarios(right, left).rows, "needs") as MoneyRow;

    expect(forwards.difference).toEqual(usd(-40_000));
    expect(backwards.difference).toEqual(usd(40_000));
    expect(forwards.smaller).toBe("right");
    expect(backwards.smaller).toBe("left");
  });
});
