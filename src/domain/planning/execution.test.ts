import { describe, expect, it } from "vitest";

import { type Money, exchangeRate, money } from "@/domain/money/money";
import { type Project, buildProject, potOf } from "@/domain/projects/projects";
import { calendarDate } from "@/domain/time/calendar-date";

import {
  InvalidExecutionError,
  PlanAlreadyExecutedError,
  buildPlanExecution,
  executionFor,
  previewExecution,
  requireExecutable,
  requireNotExecuted,
} from "./execution";
import { buildFundingPlan, buildPlannedSource } from "./scenarios";

/**
 * Plain data in, plain data out. The assertions are on the legs an execution would
 * produce, to the agora — this is the one planning operation whose output is a
 * recorded fact, and a wrong figure here is a wrong figure in a project's pot.
 */

const ils = (major: number): Money => money(Math.round(major * 100), "ILS");
const usd = (major: number): Money => money(Math.round(major * 100), "USD");
const d = (year: number, month: number, day: number) => calendarDate(year, month, day);

const CGM3 = "cgm3";
const USD_ILS = exchangeRate("USD", "ILS", 3.65);

/** A dollar pot, the shape CGM 1 and CGM 2 actually have. */
function pot(currency: "USD" | "ILS" = "USD"): Project {
  return buildProject("project-cgm3", {
    name: "CGM 3",
    currency,
    startedOn: d(2027, 1, 15),
  });
}

const plan = buildFundingPlan({
  scenarioId: CGM3,
  needs: usd(100_000),
  neededBy: d(2027, 6, 30),
});

function source(id: string, name: string, amount: Money) {
  return buildPlannedSource(id, { scenarioId: CGM3, source: name, amount });
}

/** The household's real shape: some shekels and some Apple RSU. */
const SOURCES = [
  source("s1", "כסף נזיל פנוי", ils(180_000)),
  source("s2", "Apple RSU", usd(55_000)),
];

function preview(overrides: Partial<Parameters<typeof previewExecution>[0]> = {}) {
  return previewExecution({
    scenarioId: CGM3,
    plan,
    sources: SOURCES,
    project: pot(),
    paidOn: d(2027, 1, 15),
    rate: USD_ILS,
    ...overrides,
  });
}

// --- what executing would produce ---------------------------------------------

describe("executing a funding plan creates the project's funding legs", () => {
  it("turns every planned source into a leg, at the rate actually used", () => {
    const result = preview();

    expect(result.executable).toBe(true);
    expect(result.refusal).toBeNull();
    expect(result.lines).toHaveLength(2);

    // Largest first, the order the sources already read in.
    const [liquid, rsu] = result.lines;
    expect(liquid?.source.source).toBe("כסף נזיל פנוי");
    expect(liquid?.definition.amount).toEqual(ils(180_000));
    expect(liquid?.leg.rate).toEqual(USD_ILS);
    expect(liquid?.inPotCurrency).toEqual(usd(49_315.07));

    // A source already in the pot's currency converted nothing and carries no rate.
    expect(rsu?.definition.amount).toEqual(usd(55_000));
    expect(rsu?.leg.rate).toBeNull();
    expect(rsu?.inPotCurrency).toEqual(usd(55_000));
  });

  it("carries the name the household gave the source onto the leg", () => {
    expect(preview().lines.map((line) => line.definition.source)).toEqual([
      "כסף נזיל פנוי",
      "Apple RSU",
    ]);
  });

  it("pays every leg on the day stated, not on the day the plan was written", () => {
    const result = preview({ paidOn: d(2027, 3, 2) });
    expect(result.lines.every((line) => line.definition.paidOn.day === 2)).toBe(true);
  });

  it("states what the legs come to against what the plan needed", () => {
    const result = preview();

    expect(result.total).toEqual(usd(104_315.07));
    expect(result.needs).toEqual(usd(100_000));
    expect(result.difference).toEqual(usd(4_315.07));
  });

  it("states a shortfall rather than refusing to fund a project for less", () => {
    const result = preview({ sources: [source("s2", "Apple RSU", usd(60_000))] });

    expect(result.executable).toBe(true);
    expect(result.total).toEqual(usd(60_000));
    expect(result.difference).toEqual(usd(-40_000));
  });

  it("produces a pot whose יתרה is exactly what the legs came to", () => {
    const result = preview();
    const project = pot();
    const legs = result.lines.map((line) => line.leg);

    expect(potOf(project, legs, []).funded).toEqual(usd(104_315.07));
    expect(potOf(project, legs, []).balance).toEqual(result.total);
  });

  it("converts nothing into a shekel pot, and records no rate on any leg", () => {
    const result = previewExecution({
      scenarioId: CGM3,
      plan: buildFundingPlan({ scenarioId: CGM3, needs: ils(600_000), neededBy: d(2027, 6, 30) }),
      sources: [source("s1", "כסף נזיל פנוי", ils(180_000))],
      project: pot("ILS"),
      paidOn: d(2027, 1, 15),
    });

    expect(result.executable).toBe(true);
    expect(result.rate).toBeNull();
    expect(result.lines[0]?.leg.rate).toBeNull();
    expect(result.total).toEqual(ils(180_000));
  });

  it("names no rate where nothing was converted, even if one was supplied", () => {
    const result = preview({ sources: [source("s2", "Apple RSU", usd(55_000))] });
    expect(result.rate).toBeNull();
    expect(result.lines[0]?.leg.rate).toBeNull();
  });
});

// --- what executing refuses ----------------------------------------------------

describe("an execution that cannot be trusted is refused whole", () => {
  it("refuses a conversion with no rate rather than inventing one", () => {
    const result = preview({ rate: null });

    expect(result.executable).toBe(false);
    expect(result.refusal?.code).toBe("unusable-line");
    expect(result.refusal?.detail).toContain("כסף נזיל פנוי");
    expect(result.lines).toEqual([]);
    expect(() => requireExecutable(result)).toThrow(InvalidExecutionError);
  });

  it("refuses a rate quoted for the wrong pair", () => {
    const result = preview({ rate: exchangeRate("ILS", "ILS", 1) });
    expect(result.executable).toBe(false);
    expect(result.refusal?.code).toBe("unusable-line");
  });

  it("refuses the whole execution when one line is unusable, not just that line", () => {
    const result = previewExecution({
      scenarioId: CGM3,
      plan,
      sources: SOURCES,
      project: pot(),
      paidOn: d(2027, 1, 15),
      rate: null,
    });

    // The dollar source alone would have been fine. It is not written either.
    expect(result.lines).toEqual([]);
    expect(result.total).toEqual(usd(0));
  });

  it("refuses a plan nobody has priced", () => {
    const result = preview({ plan: null });
    expect(result.refusal?.code).toBe("no-plan");
    expect(result.needs).toBeNull();
  });

  it("refuses a plan with no sources to turn into legs", () => {
    const result = preview({ sources: [] });
    expect(result.refusal?.code).toBe("no-sources");
  });

  it("reads only its own scenario's sources", () => {
    const other = buildPlannedSource("x", {
      scenarioId: "somebody-else",
      source: "לא שייך",
      amount: usd(1_000),
    });

    expect(preview({ sources: [...SOURCES, other] }).lines).toHaveLength(2);
    expect(preview({ sources: [other] }).refusal?.code).toBe("no-sources");
  });
});

// --- once, and only once -------------------------------------------------------

describe("a plan is executed once and then it is a record", () => {
  const execution = buildPlanExecution({
    scenarioId: CGM3,
    projectId: "project-cgm3",
    executedOn: d(2027, 1, 15),
    rate: USD_ILS,
    legCount: 2,
  });

  it("refuses a second execution, which would double every leg", () => {
    const result = preview({ executed: execution });

    expect(result.executable).toBe(false);
    expect(result.refusal?.code).toBe("already-executed");
    expect(result.lines).toEqual([]);
    expect(result.executed).toBe(execution);
  });

  it("freezes the plan behind it", () => {
    expect(() => requireNotExecuted(execution)).toThrow(PlanAlreadyExecutedError);
    expect(() => requireNotExecuted(null)).not.toThrow();
  });

  it("finds one scenario's execution and no other's", () => {
    expect(executionFor([execution], CGM3)).toBe(execution);
    expect(executionFor([execution], "meteor7")).toBeNull();
  });

  it("refuses a record of an execution that created no legs", () => {
    expect(() =>
      buildPlanExecution({
        scenarioId: CGM3,
        projectId: "project-cgm3",
        executedOn: d(2027, 1, 15),
        legCount: 0,
      }),
    ).toThrow(InvalidExecutionError);
  });
});
