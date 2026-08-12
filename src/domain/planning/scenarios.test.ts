import { describe, expect, it } from "vitest";

import {
  type Categories,
  EMPTY_CATEGORIES,
  applyCreation,
  planPersonalCategoryCreation,
} from "@/domain/categories/categories";
import { type EnteredEntry, EMPTY_LEDGER, buildLedger } from "@/domain/ledger/ledger";
import { type Money, exchangeRate, money } from "@/domain/money/money";
import { calendarDate } from "@/domain/time/calendar-date";
import { calendarMonth, monthKey } from "@/domain/time/calendar-month";

import {
  type FundingPlan,
  type PlannedSource,
  type SavingPace,
  InvalidFundingPlanError,
  InvalidPlannedSourceError,
  InvalidSavingPaceError,
  InvalidScenarioError,
  UnknownScenarioError,
  buildFundingPlan,
  buildPlannedSource,
  activeScenario,
  buildScenario,
  fundingGap,
  monthsToClose,
  planFor,
  proposedFreeLiquid,
  readScenario,
  readScenarios,
  requireScenario,
  savingPace,
  scenariosInReadingOrder,
  sourcesOf,
} from "./scenarios";

/**
 * Plain data in, plain data out: no database, no browser, no network. Every money
 * assertion is on exact minor units, and every month count is exact — "eleven
 * months" is a figure somebody will make a decision against.
 */

const ils = (major: number): Money => money(Math.round(major * 100), "ILS");
const usd = (major: number): Money => money(Math.round(major * 100), "USD");
const d = (year: number, month: number, day: number) => calendarDate(year, month, day);
const m = (year: number, month: number) => calendarMonth(year, month);

const USD_ILS = (rate: number) => exchangeRate("USD", "ILS", rate);

const CGM3 = "cgm3";

/** "CGM 3 ב־2027" — a dollar investment, the shape the household actually plans in. */
function plan(needs: Money = usd(100_000)): FundingPlan {
  return buildFundingPlan({ scenarioId: CGM3, needs, neededBy: d(2027, 6, 30) });
}

function source(id: string, name: string, amount: Money, scenarioId = CGM3): PlannedSource {
  return buildPlannedSource(id, { scenarioId, source: name, amount });
}

// --- the scenario ------------------------------------------------------------

describe("a scenario is a name and a thought", () => {
  it("records a name, an optional note and the day it was created", () => {
    const scenario = buildScenario("s1", {
      name: "CGM 3 ב־2027",
      note: "  אם המכירה של הלוט הראשון תצא  ",
      createdOn: d(2026, 8, 12),
    });

    expect(scenario).toEqual({
      id: "s1",
      name: "CGM 3 ב־2027",
      note: "אם המכירה של הלוט הראשון תצא",
      createdOn: d(2026, 8, 12),
      active: false,
    });
  });

  it("starts as a thought rather than as the plan being followed", () => {
    const thought = buildScenario("s1", { name: "CGM 3", createdOn: d(2026, 8, 12) });
    const followed = buildScenario("s2", {
      name: "Meteor 7",
      createdOn: d(2026, 1, 4),
      active: true,
    });

    expect(thought.active).toBe(false);
    expect(activeScenario([thought])).toBeNull();
    expect(activeScenario([thought, followed])).toBe(followed);
  });

  it("treats a blank note as no note rather than as an empty thought", () => {
    expect(buildScenario("s1", { name: "CGM 3", note: "   ", createdOn: d(2026, 8, 12) }).note).toBeNull();
    expect(buildScenario("s2", { name: "CGM 3", createdOn: d(2026, 8, 12) }).note).toBeNull();
  });

  it("refuses a scenario with no name", () => {
    expect(() => buildScenario("s1", { name: "   ", createdOn: d(2026, 8, 12) })).toThrow(
      InvalidScenarioError,
    );
  });

  it("reads newest first, and resolves one by id", () => {
    const older = buildScenario("older", { name: "Meteor 7", createdOn: d(2026, 1, 4) });
    const newer = buildScenario("newer", { name: "CGM 3", createdOn: d(2026, 8, 12) });

    expect(scenariosInReadingOrder([older, newer]).map((scenario) => scenario.id)).toEqual([
      "newer",
      "older",
    ]);
    expect(requireScenario([older, newer], "older")).toBe(older);
    expect(() => requireScenario([older, newer], "nobody")).toThrow(UnknownScenarioError);
  });
});

describe("a funding plan is what a future investment needs", () => {
  it("records the requirement and the date it is needed by", () => {
    expect(plan()).toEqual({
      scenarioId: CGM3,
      needs: usd(100_000),
      neededBy: d(2027, 6, 30),
    });
  });

  it("refuses a requirement of nothing — a plan for nought is not a plan", () => {
    expect(() =>
      buildFundingPlan({ scenarioId: CGM3, needs: usd(0), neededBy: d(2027, 6, 30) }),
    ).toThrow(InvalidFundingPlanError);
    expect(() =>
      buildFundingPlan({ scenarioId: CGM3, needs: usd(-1), neededBy: d(2027, 6, 30) }),
    ).toThrow(InvalidFundingPlanError);
  });

  it("leaves a scenario with no plan as a scenario with no plan", () => {
    expect(planFor([plan()], "meteor")).toBeNull();
    expect(planFor([], CGM3)).toBeNull();
  });
});

describe("a planned source is the before of a funding leg", () => {
  it("records where the money would come from, and how much", () => {
    const line = source("l1", "Apple RSU", usd(40_000));

    expect(line.source).toBe("Apple RSU");
    expect(line.amount).toEqual(usd(40_000));
    expect(line.origin).toEqual({ kind: "stated" });
  });

  it("carries no rate at all — a future conversion has no rate yet", () => {
    // The shape is the assertion: there is no field to put one in, so nothing can
    // record a rate before the money moved. Executing the plan is what supplies it.
    expect(Object.keys(source("l1", "Apple RSU", usd(40_000))).sort()).toEqual([
      "amount",
      "id",
      "origin",
      "scenarioId",
      "source",
    ]);
  });

  it("refuses a source of nothing", () => {
    expect(() => source("l1", "Apple RSU", usd(0))).toThrow(InvalidPlannedSourceError);
  });

  it("refuses a source with no name — the plan is unreadable without one", () => {
    expect(() => source("l1", "  ", usd(1_000))).toThrow(InvalidPlannedSourceError);
  });

  it("reads one scenario's sources largest first, and only its own", () => {
    const lines = [
      source("small", "חיסכון", usd(5_000)),
      source("big", "Apple RSU", usd(40_000)),
      source("other", "משהו אחר", usd(90_000), "meteor"),
    ];

    expect(sourcesOf(lines, CGM3).map((line) => line.id)).toEqual(["big", "small"]);
  });
});

// --- seeding from recorded figures --------------------------------------------

describe("seeding a scenario from figures the household actually has", () => {
  it("proposes free liquid money as a source, stamped with the reading it came from", () => {
    const proposed = proposedFreeLiquid({
      scenarioId: CGM3,
      source: "כסף נזיל פנוי",
      free: ils(214_600),
      asOf: d(2026, 8, 12),
    });

    expect(proposed).not.toBeNull();
    if (proposed === null) return;

    const built = buildPlannedSource("seeded", proposed);
    expect(built.amount).toEqual(ils(214_600));
    expect(built.origin).toEqual({ kind: "seeded", figure: "free-liquid", asOf: d(2026, 8, 12) });
  });

  it("proposes nothing out of a shortfall — a negative figure is not money to invest", () => {
    expect(
      proposedFreeLiquid({
        scenarioId: CGM3,
        source: "כסף נזיל פנוי",
        free: ils(-15_000),
        asOf: d(2026, 8, 12),
      }),
    ).toBeNull();
    expect(
      proposedFreeLiquid({
        scenarioId: CGM3,
        source: "כסף נזיל פנוי",
        free: ils(0),
        asOf: d(2026, 8, 12),
      }),
    ).toBeNull();
  });
});

// --- the gap ------------------------------------------------------------------

describe("the funding gap", () => {
  it("is what the plan needs less what the sources come to", () => {
    const gap = fundingGap({
      plan: plan(usd(100_000)),
      sources: [source("rsu", "Apple RSU", usd(40_000)), source("cash", "חיסכון", usd(12_500))],
    });

    expect(gap.needs).toEqual(usd(100_000));
    expect(gap.covered).toEqual(usd(52_500));
    expect(gap.gap).toEqual(usd(47_500));
    expect(gap.closed).toBe(false);
    expect(gap.surplus).toBeNull();
    expect(gap.rate).toBeNull();
    expect(gap.unreadable).toEqual([]);
  });

  it("is the whole requirement when nothing has been named yet", () => {
    const gap = fundingGap({ plan: plan(usd(100_000)), sources: [] });

    expect(gap.covered).toEqual(usd(0));
    expect(gap.gap).toEqual(usd(100_000));
  });

  it("reads a shekel source into the plan's dollars at the rate it is handed", () => {
    const gap = fundingGap({
      plan: plan(usd(100_000)),
      sources: [source("liquid", "כסף נזיל פנוי", ils(214_600))],
      rate: USD_ILS(3.65),
    });

    // 214,600 ÷ 3.65 = 58,794.52 to the cent, and the gap is the rest.
    expect(gap.sources[0]?.inPlanCurrency).toEqual(usd(58_794.52));
    expect(gap.covered).toEqual(usd(58_794.52));
    expect(gap.gap).toEqual(usd(41_205.48));
    expect(gap.rate).toEqual(USD_ILS(3.65));
  });

  it("names a source it cannot read rather than converting at a rate nobody quoted", () => {
    const gap = fundingGap({
      plan: plan(usd(100_000)),
      sources: [source("rsu", "Apple RSU", usd(40_000)), source("liquid", "נזיל", ils(214_600))],
      rate: null,
    });

    expect(gap.covered).toEqual(usd(40_000));
    expect(gap.gap).toEqual(usd(60_000));
    expect(gap.unreadable.map((line) => line.id)).toEqual(["liquid"]);
    expect(gap.sources.find((line) => line.source.id === "liquid")?.inPlanCurrency).toBeNull();
  });

  it("does not read a source at a rate quoted for the wrong pair", () => {
    const gap = fundingGap({
      plan: plan(usd(100_000)),
      sources: [source("liquid", "נזיל", ils(214_600))],
      rate: exchangeRate("ILS", "ILS", 1),
    });

    expect(gap.unreadable.map((line) => line.id)).toEqual(["liquid"]);
    expect(gap.covered).toEqual(usd(0));
  });

  it("reports being over-covered as a surplus rather than as a negative need", () => {
    const gap = fundingGap({
      plan: plan(usd(100_000)),
      sources: [source("rsu", "Apple RSU", usd(120_000))],
    });

    expect(gap.gap).toEqual(usd(-20_000));
    expect(gap.surplus).toEqual(usd(20_000));
    expect(gap.closed).toBe(true);
  });

  it("says the plan is closed when the sources come to exactly the requirement", () => {
    const gap = fundingGap({
      plan: plan(usd(100_000)),
      sources: [source("rsu", "Apple RSU", usd(100_000))],
    });

    expect(gap.gap).toEqual(usd(0));
    expect(gap.surplus).toBeNull();
    expect(gap.closed).toBe(true);
  });

  it("counts only the scenario's own sources", () => {
    const gap = fundingGap({
      plan: plan(usd(100_000)),
      sources: [source("mine", "Apple RSU", usd(40_000)), source("theirs", "אחר", usd(50_000), "meteor")],
    });

    expect(gap.covered).toEqual(usd(40_000));
  });

  it("states no rate when nothing needed converting, even where one was handed in", () => {
    const gap = fundingGap({
      plan: plan(usd(100_000)),
      sources: [source("rsu", "Apple RSU", usd(40_000))],
      rate: USD_ILS(3.65),
    });

    // A rate beside money that never changed currency is a number nobody used —
    // the same rule a Funding Leg holds.
    expect(gap.rate).toBeNull();
  });
});

// --- the pace the household is actually saving at -----------------------------

/** Both People, one income line each and one expense line each. */
function categories(): Categories {
  const specs = [
    { person: "yuval", name: "משכורת", type: "income" as const, key: "salary", household: "h-salary" },
    { person: "eden", name: "משכורת עדן", type: "income" as const, key: "eden-salary", household: "h-salary" },
    { person: "yuval", name: "בריאות", type: "expense" as const, key: "health", household: "h-health" },
    { person: "eden", name: "רפואה", type: "expense" as const, key: "eden-health", household: "h-health" },
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
          activeFrom: m(2024, 1),
          household: householdIsNew
            ? { kind: "new", name: `${spec.name} (משותף)` }
            : { kind: "existing", id: spec.household },
        },
        { personalCategoryId: `p-${spec.key}`, householdCategoryId: spec.household },
      ),
    );
  }, EMPTY_CATEGORIES);
}

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
  return Object.fromEntries(
    amounts.map((amount, index) => [monthKey(m(year, from + index)), amount]),
  );
}

/**
 * Six recorded months, every category filled: 40,000₪ in and 25,000₪ out a month,
 * so חיסכון is 15,000₪ a month and the pace is exactly that.
 */
function sixSteadyMonths() {
  const model = categories();
  const ledger = buildLedger({
    entered: entries({
      "p-salary": monthsOf(2026, 2, [30_000, 30_000, 30_000, 30_000, 30_000, 30_000]),
      "p-eden-salary": monthsOf(2026, 2, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000]),
      "p-health": monthsOf(2026, 2, [15_000, 15_000, 15_000, 15_000, 15_000, 15_000]),
      "p-eden-health": monthsOf(2026, 2, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000]),
    }),
  });
  return { model, ledger };
}

function paceOf(overrides: Partial<Parameters<typeof savingPace>[0]> = {}): SavingPace {
  const { model, ledger } = sixSteadyMonths();
  return savingPace({
    ledger,
    categories: model,
    endingWith: m(2026, 7),
    currency: "ILS",
    ...overrides,
  });
}

describe("the pace the household is currently saving at", () => {
  it("is חיסכון over the months that hold a figure, with the denominator stated", () => {
    const pace = paceOf();

    expect(pace.total).toEqual(ils(90_000));
    expect(pace.monthly).toEqual(ils(15_000));
    expect(pace.denominator).toBe(6);
    expect(pace.window).toHaveLength(6);
    expect(pace.incomplete).toEqual([]);
    expect(pace.missing).toEqual([]);
  });

  it("divides by the months recorded and not by the length of the window", () => {
    // The window reaches back to September 2025; only February onwards is recorded,
    // so the pace is over six months and says so rather than reading 90,000 ÷ 11.
    const pace = paceOf({ endingWith: m(2026, 7), months: 11 });

    expect(pace.window).toHaveLength(11);
    expect(pace.denominator).toBe(6);
    expect(pace.monthly).toEqual(ils(15_000));
    expect(pace.missing.map(monthKey)).toEqual([
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
  });

  it("has no pace at all when nothing in the window was recorded", () => {
    const pace = savingPace({
      ledger: EMPTY_LEDGER,
      categories: categories(),
      endingWith: m(2026, 7),
      currency: "ILS",
    });

    expect(pace.monthly).toBeNull();
    expect(pace.denominator).toBe(0);
    expect(pace.total).toEqual(ils(0));
  });

  it("counts a half-recorded month and names it, because it understates its own חיסכון", () => {
    const model = categories();
    const ledger = buildLedger({
      entered: entries({
        // July holds only the two income lines: the expenses have not been entered.
        "p-salary": monthsOf(2026, 6, [30_000, 30_000]),
        "p-eden-salary": monthsOf(2026, 6, [10_000, 10_000]),
        "p-health": monthsOf(2026, 6, [15_000]),
        "p-eden-health": monthsOf(2026, 6, [10_000]),
      }),
    });

    const pace = savingPace({ ledger, categories: model, endingWith: m(2026, 7), currency: "ILS" });

    expect(pace.denominator).toBe(2);
    expect(pace.total).toEqual(ils(15_000 + 40_000));
    expect(pace.incomplete.map(monthKey)).toEqual(["2026-07"]);
  });

  it("refuses a window that is not a whole number of months", () => {
    expect(() => paceOf({ months: 0 })).toThrow(InvalidSavingPaceError);
    expect(() => paceOf({ months: 2.5 })).toThrow(InvalidSavingPaceError);
  });

  it("reads the same figure twice — the pace is derived and never stored", () => {
    expect(paceOf()).toEqual(paceOf());
  });
});

// --- how long the gap takes to close ------------------------------------------

describe("months to close the gap", () => {
  it("divides the gap by the pace and rounds up, because saving arrives monthly", () => {
    const gap = fundingGap({ plan: plan(ils(100_000)), sources: [source("s", "חיסכון", ils(10_000))] });
    const closure = monthsToClose({ gap, pace: paceOf() });

    // 90,000 ÷ 15,000 is exactly six.
    expect(closure.months).toBe(6);
    expect(closure.basis).toBe("computed");
    expect(closure.monthly).toEqual(ils(15_000));
    expect(closure.denominator).toBe(6);
    expect(closure.closesIn).toEqual(m(2027, 1));
  });

  it("rounds a part-month up rather than reporting a gap closed before it is", () => {
    const gap = fundingGap({ plan: plan(ils(90_000.01)), sources: [] });
    const closure = monthsToClose({ gap, pace: paceOf() });

    // Six months of saving is one agora short, so it takes seven.
    expect(closure.months).toBe(7);
    expect(closure.closesIn).toEqual(m(2027, 2));
  });

  it("takes no months at all when the sources already cover the plan", () => {
    const gap = fundingGap({ plan: plan(ils(50_000)), sources: [source("s", "נזיל", ils(50_000))] });
    const closure = monthsToClose({ gap, pace: paceOf() });

    expect(closure.months).toBe(0);
    expect(closure.basis).toBe("already-covered");
  });

  it("has no answer when nothing was recorded to measure a pace over", () => {
    const gap = fundingGap({ plan: plan(ils(100_000)), sources: [] });
    const closure = monthsToClose({
      gap,
      pace: savingPace({
        ledger: EMPTY_LEDGER,
        categories: categories(),
        endingWith: m(2026, 7),
        currency: "ILS",
      }),
    });

    expect(closure.months).toBeNull();
    expect(closure.basis).toBe("no-pace");
    expect(closure.closesIn).toBeNull();
  });

  it("says the gap never closes at a pace of nought or less, rather than inventing a count", () => {
    const model = categories();
    const ledger = buildLedger({
      entered: entries({
        "p-salary": monthsOf(2026, 7, [20_000]),
        "p-eden-salary": monthsOf(2026, 7, [10_000]),
        "p-health": monthsOf(2026, 7, [25_000]),
        "p-eden-health": monthsOf(2026, 7, [10_000]),
      }),
    });
    const pace = savingPace({ ledger, categories: model, endingWith: m(2026, 7), currency: "ILS" });
    expect(pace.monthly).toEqual(ils(-5_000));

    const closure = monthsToClose({ gap: fundingGap({ plan: plan(ils(100_000)), sources: [] }), pace });

    expect(closure.months).toBeNull();
    expect(closure.basis).toBe("not-saving");
    expect(closure.monthly).toEqual(ils(-5_000));
  });

  it("reads a shekel pace into a dollar gap at the rate it is handed", () => {
    const gap = fundingGap({ plan: plan(usd(100_000)), sources: [] });
    const closure = monthsToClose({ gap, pace: paceOf(), rate: USD_ILS(3.65) });

    // 15,000₪ a month is $4,109.59, and $100,000 ÷ 4,109.59 is 24.33 → 25 months.
    expect(closure.monthly).toEqual(usd(4_109.59));
    expect(closure.rate).toEqual(USD_ILS(3.65));
    expect(closure.months).toBe(25);
  });

  it("refuses to compare a dollar gap against a shekel pace with no rate", () => {
    const gap = fundingGap({ plan: plan(usd(100_000)), sources: [] });
    const closure = monthsToClose({ gap, pace: paceOf() });

    expect(closure.months).toBeNull();
    expect(closure.basis).toBe("no-rate");
  });
});

// --- one scenario, read whole -------------------------------------------------

describe("reading a scenario whole", () => {
  const scenario = buildScenario(CGM3, { name: "CGM 3 ב־2027", createdOn: d(2026, 8, 12) });

  it("assembles the plan, its sources, the gap and the closure from one read", () => {
    const reading = readScenario({
      scenario,
      plans: [plan(ils(400_000))],
      sources: [source("liquid", "כסף נזיל פנוי", ils(214_600))],
      pace: paceOf(),
    });

    expect(reading.plan?.needs).toEqual(ils(400_000));
    expect(reading.sources.map((line) => line.id)).toEqual(["liquid"]);
    expect(reading.gap?.gap).toEqual(ils(185_400));
    // 185,400 ÷ 15,000 = 12.36 → thirteen months.
    expect(reading.closure?.months).toBe(13);
  });

  it("has no gap and no closure for a scenario nobody has priced yet", () => {
    const reading = readScenario({ scenario, plans: [], sources: [], pace: paceOf() });

    expect(reading.plan).toBeNull();
    expect(reading.gap).toBeNull();
    expect(reading.closure).toBeNull();
  });

  it("reads a list in the same order, and each scenario only its own rows", () => {
    const other = buildScenario("meteor", { name: "Meteor 7", createdOn: d(2026, 1, 4) });
    const readings = readScenarios({
      scenarios: [other, scenario],
      plans: [plan(ils(400_000))],
      sources: [source("liquid", "כסף נזיל פנוי", ils(214_600))],
      pace: paceOf(),
    });

    expect(readings.map((reading) => reading.scenario.id)).toEqual([CGM3, "meteor"]);
    expect(readings[1]?.plan).toBeNull();
    expect(readings[1]?.sources).toEqual([]);
  });

  it("produces the identical reading twice — nothing here is stored", () => {
    const input = {
      scenario,
      plans: [plan(ils(400_000))],
      sources: [source("liquid", "כסף נזיל פנוי", ils(214_600))],
      pace: paceOf(),
    };

    expect(readScenario(input)).toEqual(readScenario(input));
  });
});
