import { describe, expect, it } from "vitest";

import { type Money, exchangeRate, money } from "@/domain/money/money";
import { calendarDate } from "@/domain/time/calendar-date";

import {
  type DistributionDestination,
  type Project,
  type ProjectDistribution,
  DistributionRequiredError,
  FundingLegRequiredError,
  InvalidProjectDistributionError,
  PotOverdrawnError,
  buildFundingLeg,
  buildProject,
  buildProjectDistribution,
  buildProjectExpense,
  costForSnapshot,
  distributionsOf,
  effectiveRate,
  movementsOf,
  potOf,
  requireDistributionRemovable,
  requireLegRemovable,
  requireWithinPot,
} from "./projects";

/**
 * A project returning money, and the two things the household does with it.
 *
 * That distinction is the whole of this band. Taken, the money is in an Account
 * מיפוי already counts and this project can no longer spend it. Rolled, it never
 * left and can be deployed again. Every assertion here is about one of those being
 * true and the other not quietly also being true — the failure this band is most
 * exposed to is a shekel counted twice.
 */

const ils = (major: number): Money => money(Math.round(major * 100), "ILS");
const usd = (major: number): Money => money(Math.round(major * 100), "USD");
const d = (year: number, month: number, day: number) => calendarDate(year, month, day);
const USD_ILS = (rate: number) => exchangeRate("USD", "ILS", rate);

/** CGM 1 as the household funded it: 109,800₪ at 3.65, and $69,000 of Apple RSU. */
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
        rate: USD_ILS(3.65),
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

function distribution(
  id: string,
  project: Project,
  amount: Money,
  destination: DistributionDestination,
  rate?: ReturnType<typeof USD_ILS>,
): ProjectDistribution {
  return buildProjectDistribution(
    id,
    { projectId: project.id, description: "חלוקה רבעונית", amount, rate, destination, paidOn: d(2026, 3, 31) },
    project,
  );
}

function expense(project: Project, amount: Money) {
  return buildProjectExpense(
    "e1",
    { projectId: project.id, description: "רכישת הנכס", amount, paidOn: d(2024, 4, 15) },
    project,
  );
}

// --- the row itself ----------------------------------------------------------

describe("recording a distribution", () => {
  it("names the account it landed in when it left the project", () => {
    const { project } = cgm1();
    expect(() => distribution("d1", project, usd(5_000), { kind: "out", accountId: "   " })).toThrow(
      InvalidProjectDistributionError,
    );
  });

  it("names no account when it was rolled back in", () => {
    const { project } = cgm1();
    expect(distribution("d1", project, usd(5_000), { kind: "rolled" }).destination).toEqual({
      kind: "rolled",
    });
  });

  it("is an amount greater than zero, like every other movement", () => {
    const { project } = cgm1();
    expect(() => distribution("d1", project, usd(0), { kind: "rolled" })).toThrow(
      InvalidProjectDistributionError,
    );
  });

  it("carries a rate where it converted and refuses one where it did not", () => {
    const { project } = cgm1();

    expect(() => distribution("d1", project, usd(500), { kind: "rolled" }, USD_ILS(3.6))).toThrow(
      InvalidProjectDistributionError,
    );
    expect(() => distribution("d2", project, ils(1_800), { kind: "rolled" })).toThrow(
      InvalidProjectDistributionError,
    );
    expect(distribution("d3", project, ils(1_825), { kind: "rolled" }, USD_ILS(3.65)).amount).toEqual(
      ils(1_825),
    );
  });

  it("reads one project's distributions oldest first", () => {
    const { project } = cgm1();
    const late = buildProjectDistribution(
      "late",
      {
        projectId: project.id,
        description: "חלוקה",
        amount: usd(1),
        destination: { kind: "rolled" },
        paidOn: d(2026, 6, 30),
      },
      project,
    );
    const early = distribution("early", project, usd(2), { kind: "rolled" });

    expect(distributionsOf([late, early], project.id).map((one) => one.id)).toEqual(["early", "late"]);
    expect(distributionsOf([late, early], "someone-else")).toEqual([]);
  });
});

// --- what it does to the קופה -------------------------------------------------

describe("what a distribution does to the קופה", () => {
  it("leaves the balance alone when it went out", () => {
    const { project, legs } = cgm1();
    const taken = distribution("d1", project, usd(9_000), { kind: "out", accountId: "bank" });

    const before = potOf(project, legs, []);
    const after = potOf(project, legs, [], [taken]);

    expect(after.balance).toEqual(before.balance);
    expect(after.paidOut).toEqual(usd(9_000));
    expect(after.rolled).toEqual(usd(0));
  });

  it("raises the balance when it was rolled back in", () => {
    const { project, legs } = cgm1();
    const rolled = distribution("d1", project, usd(9_000), { kind: "rolled" });

    const before = potOf(project, legs, []);
    const after = potOf(project, legs, [], [rolled]);

    expect(after.balance.minorUnits - before.balance.minorUnits).toBe(usd(9_000).minorUnits);
    expect(after.rolled).toEqual(usd(9_000));
    expect(after.paidOut).toEqual(usd(0));
  });

  it("never becomes a funding leg: גויס does not move, and nor does the effective rate", () => {
    const { project, legs } = cgm1();
    const rolled = distribution("d1", project, usd(9_000), { kind: "rolled" });

    expect(potOf(project, legs, [], [rolled]).funded).toEqual(potOf(project, legs, []).funded);
    // The rate is drawn from the legs alone, so a distribution cannot reach it at
    // all — this pins that the signature stays that way.
    expect(effectiveRate(project, legs).rate).toBeCloseTo(3.65, 6);
  });

  it("counts what reached the household apart from what the project produced", () => {
    const { project, legs } = cgm1();
    const taken = distribution("out", project, usd(4_000), { kind: "out", accountId: "bank" });
    const rolled = distribution("in", project, usd(6_000), { kind: "rolled" });

    const pot = potOf(project, legs, [], [taken, rolled]);

    expect(pot.paidOut).toEqual(usd(4_000));
    expect(pot.distributed).toEqual(usd(10_000));
    expect(pot.distributionCount).toBe(2);
  });
});

// --- what מיפוי reads ---------------------------------------------------------

describe("the cost מיפוי reads", () => {
  it("keeps cost = spent + balance, which is what makes the מיפוי line explainable", () => {
    const { project, legs } = cgm1();
    const rolled = distribution("in", project, usd(6_000), { kind: "rolled" });
    const pot = potOf(project, legs, [expense(project, usd(70_000))], [rolled]);

    expect(costForSnapshot(project, legs, [rolled]).minorUnits).toBe(
      pot.spent.minorUnits + pot.balance.minorUnits,
    );
  });

  it("is unmoved by one that was taken, since the account it landed in holds it", () => {
    const { project, legs } = cgm1();
    const taken = distribution("out", project, usd(9_000), { kind: "out", accountId: "bank" });

    expect(costForSnapshot(project, legs, [taken])).toEqual(costForSnapshot(project, legs));
  });

  it("is unmoved by the expense ledger being spent down", () => {
    const { project, legs } = cgm1();
    const rolled = distribution("in", project, usd(6_000), { kind: "rolled" });

    expect(costForSnapshot(project, legs, [rolled])).toEqual(usd(105_082.19));
  });
});

// --- the three ledgers read as one -------------------------------------------

describe("the three ledgers read as one", () => {
  it("puts every row in one list, oldest first", () => {
    const { project, legs } = cgm1();
    const spent = expense(project, usd(70_000));
    const taken = distribution("out", project, usd(4_000), { kind: "out", accountId: "bank" });

    const rows = movementsOf({ project, legs, expenses: [spent], distributions: [taken] });

    expect(rows.map((row) => row.kind)).toEqual(["leg", "leg", "expense", "distribution"]);
    // The two legs share a day, so they fall back to the description, in Hebrew
    // collation — which puts the shekel leg ahead of the English-named one.
    expect(rows.map((row) => row.description)).toEqual([
      'עו"ש דיסקונט',
      "Apple RSU",
      "רכישת הנכס",
      "חלוקה רבעונית",
    ]);
  });

  it("orders money in before money out on one day, the order they could have happened in", () => {
    const { project, legs } = cgm1();
    // An expense on the very day the pot was filled was paid for by that leg.
    const sameDay = buildProjectExpense(
      "same-day",
      { projectId: project.id, description: "מקדמה", amount: usd(1_000), paidOn: d(2024, 3, 1) },
      project,
    );

    const rows = movementsOf({ project, legs, expenses: [sameDay] });

    // Both legs are on that day too, so the expense comes after both of them.
    expect(rows.map((row) => row.kind)).toEqual(["leg", "leg", "expense"]);
  });

  it("signs what each row did to the balance, and a taken distribution did nothing to it", () => {
    const { project, legs } = cgm1();
    const spent = expense(project, usd(70_000));
    const taken = distribution("out", project, usd(4_000), { kind: "out", accountId: "bank" });
    const rolled = distribution("in", project, usd(6_000), { kind: "rolled" });

    const rows = movementsOf({
      project,
      legs,
      expenses: [spent],
      distributions: [taken, rolled],
    });
    const effect = (id: string) => rows.find((row) => row.id === id)?.effect;

    expect(effect("cgm1-rsu")).toEqual(usd(69_000));
    // The shekel leg at 3.65, in the pot's currency.
    expect(effect("cgm1-ils")).toEqual(usd(30_082.19));
    expect(effect("e1")).toEqual(usd(-70_000));
    expect(effect("in")).toEqual(usd(6_000));
    // Not zero: zero would say it moved nothing, and the truth is that the money
    // is in the account beside it rather than in the pot.
    expect(effect("out")).toBeNull();
  });

  it("adds up to the יתרה the pot reports, counting the dashes as nothing", () => {
    const { project, legs } = cgm1();
    const spent = expense(project, usd(70_000));
    const rolled = distribution("in", project, usd(6_000), { kind: "rolled" });

    const rows = movementsOf({ project, legs, expenses: [spent], distributions: [rolled] });
    const total = rows.reduce((sofar, row) => sofar + (row.effect?.minorUnits ?? 0), 0);

    expect(total).toBe(potOf(project, legs, [spent], [rolled]).balance.minorUnits);
  });

  it("carries a distribution's destination and nothing else's", () => {
    const { project, legs } = cgm1();
    const taken = distribution("out", project, usd(4_000), { kind: "out", accountId: "bank" });

    const rows = movementsOf({ project, legs, expenses: [], distributions: [taken] });

    expect(rows.find((row) => row.id === "out")?.destination).toEqual({
      kind: "out",
      accountId: "bank",
    });
    expect(rows.find((row) => row.id === "cgm1-rsu")?.destination).toBeNull();
  });
});

// --- the closed-pot rules, with rolled money in them -------------------------

describe("what a rolled distribution lets the קופה do", () => {
  it("makes room for an expense the legs alone could not pay for", () => {
    const { project, legs } = cgm1();
    const candidate = { amount: usd(105_000), rate: null };

    expect(() => requireWithinPot({ project, legs, expenses: [], candidate })).toThrow(
      PotOverdrawnError,
    );

    const rolled = distribution("in", project, usd(9_000), { kind: "rolled" });
    expect(() =>
      requireWithinPot({ project, legs, expenses: [], distributions: [rolled], candidate }),
    ).not.toThrow();
  });

  it("cannot be taken back out once the balance has been spent against it", () => {
    const { project, legs } = cgm1();
    const rolled = distribution("in", project, usd(9_000), { kind: "rolled" });

    expect(() =>
      requireDistributionRemovable({
        project,
        legs,
        expenses: [expense(project, usd(105_000))],
        distributions: [rolled],
        distributionId: "in",
      }),
    ).toThrow(DistributionRequiredError);
  });

  it("can be taken back out while the pot can still cover what it spent", () => {
    const { project, legs } = cgm1();
    const rolled = distribution("in", project, usd(9_000), { kind: "rolled" });

    expect(() =>
      requireDistributionRemovable({
        project,
        legs,
        expenses: [],
        distributions: [rolled],
        distributionId: "in",
      }),
    ).not.toThrow();
  });

  it("is always removable when it went out, since it never entered the balance", () => {
    const { project, legs } = cgm1();
    const taken = distribution("out", project, usd(9_000), { kind: "out", accountId: "bank" });

    expect(() =>
      requireDistributionRemovable({
        project,
        legs,
        expenses: [expense(project, usd(99_000))],
        distributions: [taken],
        distributionId: "out",
      }),
    ).not.toThrow();
  });

  it("holds the funding-leg rule in both directions, counting rolled money", () => {
    const { project, legs } = cgm1();
    const rolled = distribution("in", project, usd(9_000), { kind: "rolled" });
    // $75,000 spent against $99,082.19 of legs. Take the shekel leg away and only
    // the $69,000 RSU leg is left, which is $6,000 short of what went out.
    const spent = [expense(project, usd(75_000))];

    // Without the rolled row that shortfall stands, so removing the leg is refused.
    expect(() => requireLegRemovable({ project, legs, expenses: spent, legId: "cgm1-ils" })).toThrow(
      FundingLegRequiredError,
    );
    // With it there is room, and the same leg may go.
    expect(() =>
      requireLegRemovable({
        project,
        legs,
        expenses: spent,
        distributions: [rolled],
        legId: "cgm1-ils",
      }),
    ).not.toThrow();
  });
});
