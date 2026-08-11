import { describe, expect, it } from "vitest";

import { type Money, exchangeRate, money } from "@/domain/money/money";
import { calendarDate } from "@/domain/time/calendar-date";

import {
  type FundingLeg,
  type Project,
  type ProjectExpense,
  FundingLegRequiredError,
  InvalidDealTermsError,
  InvalidFundingLegError,
  InvalidProjectError,
  InvalidProjectExpenseError,
  PotOverdrawnError,
  UnknownProjectError,
  UnusableRateError,
  againstToday,
  buildDealTerms,
  buildFundingLeg,
  buildProject,
  buildProjectExpense,
  costForSnapshot,
  effectiveRate,
  expensesOf,
  legsOf,
  potOf,
  projectsInReadingOrder,
  readProject,
  requireLegRemovable,
  requireProject,
  requireWithinPot,
  statesAnything,
  termsFor,
} from "./projects";

/**
 * Plain data in, plain data out: no database, no browser, no network. Every money
 * assertion is on exact minor units — a יתרה out by an agora is a יתרה nobody can
 * act on, and the whole point of the pot is that it adds up.
 */

const ils = (major: number): Money => money(Math.round(major * 100), "ILS");
const usd = (major: number): Money => money(Math.round(major * 100), "USD");
const d = (year: number, month: number, day: number) => calendarDate(year, month, day);

const USD_ILS = (rate: number) => exchangeRate("USD", "ILS", rate);

// --- the real structures -----------------------------------------------------

/**
 * CGM 1 as the household actually funded it: 109,800₪ out of the current account
 * and $69,000 of Apple RSU. The pot is a dollar pot, so the shekel leg converted
 * and the RSU leg did not.
 *
 * The amounts are the household's real ones. The rate on the shekel leg is stated
 * here rather than read from anywhere: the repository records what was paid, not
 * the rate it was paid at, and that is a figure only the household can supply.
 */
function cgm1() {
  const project = buildProject("cgm1", {
    name: "CGM 1",
    currency: "USD",
    accountId: "cgm1-account",
    startedOn: d(2023, 4, 1),
  });

  const legs = [
    buildFundingLeg(
      "cgm1-ils",
      {
        projectId: "cgm1",
        source: 'עו"ש דיסקונט',
        amount: ils(109_800),
        rate: USD_ILS(3.65),
        paidOn: d(2023, 4, 1),
      },
      project,
    ),
    buildFundingLeg(
      "cgm1-rsu",
      { projectId: "cgm1", source: "Apple RSU", amount: usd(69_000), paidOn: d(2023, 4, 12) },
      project,
    ),
  ];

  return { project, legs };
}

/** CGM 2: 295,200₪ converted at 3.60 into the $82,000 that is not yet invested. */
function cgm2() {
  const project = buildProject("cgm2", {
    name: "CGM 2",
    currency: "USD",
    startedOn: d(2025, 2, 1),
  });

  const legs = [
    buildFundingLeg(
      "cgm2-ils",
      {
        projectId: "cgm2",
        source: 'עו"ש דיסקונט',
        amount: ils(295_200),
        rate: USD_ILS(3.6),
        paidOn: d(2025, 2, 1),
      },
      project,
    ),
  ];

  return { project, legs };
}

/**
 * Meteor 6: a shekel pot funded mostly in shekels with one dollar leg. The
 * repository records no funding structure for Meteor at all — only that the sheet
 * valued it twice and disagreed with itself — so these amounts are illustrative
 * and the shape is what is under test: a pot whose conversions ran the other way.
 */
function meteor() {
  const project = buildProject("meteor", {
    name: "Meteor 6",
    currency: "ILS",
    startedOn: d(2024, 9, 1),
  });

  const legs = [
    buildFundingLeg(
      "meteor-current",
      { projectId: "meteor", source: 'עו"ש דיסקונט', amount: ils(150_000), paidOn: d(2024, 9, 1) },
      project,
    ),
    buildFundingLeg(
      "meteor-fund",
      { projectId: "meteor", source: "איילון קרן כספית", amount: ils(50_000), paidOn: d(2024, 9, 5) },
      project,
    ),
    buildFundingLeg(
      "meteor-rsu",
      {
        projectId: "meteor",
        source: "Apple RSU",
        amount: usd(12_000),
        rate: USD_ILS(3.7),
        paidOn: d(2024, 10, 1),
      },
      project,
    ),
  ];

  return { project, legs };
}

// --- funding legs and the cost -----------------------------------------------

describe("a funding leg records the currency and the rate actually used", () => {
  it("converts a shekel leg into a dollar pot at its own rate", () => {
    const { project, legs } = cgm1();
    const pot = potOf(project, legs, []);

    // 109,800₪ ÷ 3.65 is $30,082.19, and $69,000 needed no conversion.
    expect(pot.funded).toEqual(usd(99_082.19));
    expect(pot.legCount).toBe(2);
  });

  it("refuses a rate beside money that never changed currency", () => {
    const { project } = cgm1();
    expect(() =>
      buildFundingLeg(
        "extra",
        { projectId: "cgm1", source: "Apple RSU", amount: usd(1_000), rate: USD_ILS(3.65), paidOn: d(2024, 1, 1) },
        project,
      ),
    ).toThrow(InvalidFundingLegError);
  });

  it("refuses a converting leg with no rate at all", () => {
    const { project } = cgm1();
    expect(() =>
      buildFundingLeg(
        "extra",
        { projectId: "cgm1", source: 'עו"ש', amount: ils(1_000), paidOn: d(2024, 1, 1) },
        project,
      ),
    ).toThrow(InvalidFundingLegError);
  });

  it("refuses a rate quoted for a pair it does not convert", () => {
    const project = buildProject("mixed", { name: "Mixed", currency: "USD", startedOn: d(2024, 1, 1) });
    expect(() =>
      buildFundingLeg(
        "leg",
        {
          projectId: "mixed",
          source: 'עו"ש',
          amount: ils(1_000),
          rate: { from: "ILS", to: "ILS", rate: 1 },
          paidOn: d(2024, 1, 1),
        },
        project,
      ),
    ).toThrow(InvalidFundingLegError);
  });

  it("refuses a leg of nothing", () => {
    const { project } = cgm1();
    expect(() =>
      buildFundingLeg(
        "empty",
        { projectId: "cgm1", source: "Apple RSU", amount: usd(0), paidOn: d(2024, 1, 1) },
        project,
      ),
    ).toThrow(InvalidFundingLegError);
  });

  it("refuses a leg belonging to another project", () => {
    const { project } = cgm1();
    expect(() =>
      buildFundingLeg(
        "stray",
        { projectId: "meteor", source: "Apple RSU", amount: usd(10), paidOn: d(2024, 1, 1) },
        project,
      ),
    ).toThrow(InvalidFundingLegError);
  });

  it("reads a project's legs oldest first", () => {
    const { legs } = cgm1();
    expect(legsOf([...legs].reverse(), "cgm1").map((leg) => leg.id)).toEqual(["cgm1-ils", "cgm1-rsu"]);
    expect(legsOf(legs, "meteor")).toEqual([]);
  });
});

// --- the effective blended rate ----------------------------------------------

describe("the effective rate is computed on read", () => {
  it("reads CGM 1 as the shekels it converted over the dollars it received", () => {
    const { project, legs } = cgm1();
    const effective = effectiveRate(project, legs);

    // Only the shekel leg converted: the RSU dollars were never bought.
    expect(effective.legCount).toBe(1);
    expect(effective.ils).toEqual(ils(109_800));
    expect(effective.usd).toEqual(usd(30_082.19));
    expect(effective.direction).toEqual({ from: "ILS", to: "USD" });
    // 10,980,000 agorot ÷ 3,008,219 cents. Fractionally above 3.65 because the
    // dollar figure rounded down, which is what the money actually did.
    expect(effective.rate).toBeCloseTo(3.650_000_216, 9);
  });

  it("reads CGM 2 at the single rate its whole pot was converted at", () => {
    const { project, legs } = cgm2();
    const pot = potOf(project, legs, []);
    const effective = effectiveRate(project, legs);

    expect(pot.funded).toEqual(usd(82_000));
    expect(effective.ils).toEqual(ils(295_200));
    expect(effective.usd).toEqual(usd(82_000));
    expect(effective.rate).toBe(3.6);
  });

  it("reads Meteor's dollar leg in the other direction, at the same shekels-per-dollar", () => {
    const { project, legs } = meteor();
    const pot = potOf(project, legs, []);
    const effective = effectiveRate(project, legs);

    // 150,000 + 50,000 + $12,000 × 3.70.
    expect(pot.funded).toEqual(ils(244_400));
    expect(effective.legCount).toBe(1);
    expect(effective.ils).toEqual(ils(44_400));
    expect(effective.usd).toEqual(usd(12_000));
    expect(effective.direction).toEqual({ from: "USD", to: "ILS" });
    expect(effective.rate).toBe(3.7);
  });

  it("blends several conversions by what they cost, not by averaging the rates", () => {
    const project = buildProject("blend", { name: "Blend", currency: "USD", startedOn: d(2024, 1, 1) });
    const legs = [
      buildFundingLeg(
        "dear",
        { projectId: "blend", source: 'עו"ש', amount: ils(100_000), rate: USD_ILS(4), paidOn: d(2024, 1, 1) },
        project,
      ),
      buildFundingLeg(
        "cheap",
        { projectId: "blend", source: 'עו"ש', amount: ils(100_000), rate: USD_ILS(3), paidOn: d(2024, 6, 1) },
        project,
      ),
    ];

    const effective = effectiveRate(project, legs);
    expect(effective.ils).toEqual(ils(200_000));
    // $25,000.00 and $33,333.33.
    expect(effective.usd).toEqual(usd(58_333.33));
    // 200,000 ÷ 58,333.33 is 3.4286, not the 3.50 an average of the rates would give.
    expect(effective.rate).toBeCloseTo(3.428_571_7, 6);
  });

  it("has no rate at all when nothing was converted", () => {
    const project = buildProject("shekels", { name: "Shekels", currency: "ILS", startedOn: d(2024, 1, 1) });
    const legs = [
      buildFundingLeg(
        "only",
        { projectId: "shekels", source: 'עו"ש', amount: ils(10_000), paidOn: d(2024, 1, 1) },
        project,
      ),
    ];

    const effective = effectiveRate(project, legs);
    expect(effective.rate).toBeNull();
    expect(effective.direction).toBeNull();
    expect(effective.legCount).toBe(0);
    expect(againstToday(effective, USD_ILS(3.4))).toBeNull();
  });
});

describe("the effective rate held against today's", () => {
  it("says where the two sit and by how much", () => {
    const { project, legs } = cgm2();
    const standing = againstToday(effectiveRate(project, legs), USD_ILS(3.4));

    expect(standing?.effective).toBe(3.6);
    expect(standing?.today.rate).toBe(3.4);
    expect(standing?.standing).toBe("above");
    expect(standing?.difference).toBeCloseTo(0.2, 10);
  });

  it("reads below when today's rate is the higher one", () => {
    const { project, legs } = cgm2();
    expect(againstToday(effectiveRate(project, legs), USD_ILS(3.9))?.standing).toBe("below");
    expect(againstToday(effectiveRate(project, legs), USD_ILS(3.6))?.standing).toBe("same");
  });

  it("refuses a rate that is not shekels per dollar", () => {
    const { project, legs } = cgm2();
    expect(() => againstToday(effectiveRate(project, legs), exchangeRate("ILS", "USD", 0.28))).toThrow(
      UnusableRateError,
    );
  });
});

// --- the pot invariant -------------------------------------------------------

describe("יתרה = Σ(legs) − Σ(expenses)", () => {
  /** CGM 1 spent down to the $21,188 the household knows is not yet working. */
  function cgm1Spent() {
    const { project, legs } = cgm1();
    const expenses = [
      buildProjectExpense(
        "land",
        { projectId: "cgm1", description: "רכישת הקרקע", amount: usd(60_000), paidOn: d(2023, 5, 1) },
        project,
      ),
      buildProjectExpense(
        "fees",
        { projectId: "cgm1", description: "עלויות עסקה", amount: usd(17_894.19), paidOn: d(2023, 6, 1) },
        project,
      ),
    ];
    return { project, legs, expenses };
  }

  it("leaves CGM 1 with exactly the undeployed capital the household knows about", () => {
    const { project, legs, expenses } = cgm1Spent();
    const pot = potOf(project, legs, expenses);

    expect(pot.funded).toEqual(usd(99_082.19));
    expect(pot.spent).toEqual(usd(77_894.19));
    expect(pot.balance).toEqual(usd(21_188));
    expect(pot.expenseCount).toBe(2);
  });

  it("holds under any sequence of legs and expenses", () => {
    const { project } = cgm1();
    const legs: FundingLeg[] = [];
    const expenses: ProjectExpense[] = [];

    // A deterministic walk that interleaves the two: every step re-reads the pot
    // and asserts the invariant, so no ordering can leave it disagreeing.
    for (let step = 1; step <= 24; step += 1) {
      if (step % 3 === 0) {
        expenses.push(
          buildProjectExpense(
            `expense-${step}`,
            { projectId: "cgm1", description: `תשלום ${step}`, amount: usd(step * 7.13), paidOn: d(2024, 1, 1) },
            project,
          ),
        );
      } else {
        legs.push(
          buildFundingLeg(
            `leg-${step}`,
            { projectId: "cgm1", source: `מקור ${step}`, amount: usd(step * 100), paidOn: d(2024, 1, 1) },
            project,
          ),
        );
      }

      const pot = potOf(project, legs, expenses);
      expect(pot.balance.minorUnits).toBe(pot.funded.minorUnits - pot.spent.minorUnits);
      expect(pot.balance.currency).toBe("USD");
    }
  });

  it("reads the same pot whatever order the rows arrive in", () => {
    const { project, legs, expenses } = cgm1Spent();
    const forwards = potOf(project, legs, expenses);
    const backwards = potOf(project, [...legs].reverse(), [...expenses].reverse());

    expect(backwards).toEqual(forwards);
  });

  it("draws an expense paid in the other currency out at its own rate", () => {
    const { project, legs } = cgm1();
    const expenses = [
      buildProjectExpense(
        "local",
        {
          projectId: "cgm1",
          description: "אגרות בישראל",
          amount: ils(36_500),
          rate: USD_ILS(3.65),
          paidOn: d(2023, 5, 1),
        },
        project,
      ),
    ];

    const pot = potOf(project, legs, expenses);
    expect(pot.spent).toEqual(usd(10_000));
    expect(pot.balance).toEqual(usd(89_082.19));
  });

  it("reads a project's expenses oldest first", () => {
    const { project, legs, expenses } = cgm1Spent();
    expect(expensesOf([...expenses].reverse(), "cgm1").map((expense) => expense.id)).toEqual([
      "land",
      "fees",
    ]);
    expect(readProject({ project, legs, expenses, terms: [] }).expenses).toHaveLength(2);
  });

  it("refuses an expense of nothing", () => {
    const { project } = cgm1();
    expect(() =>
      buildProjectExpense(
        "empty",
        { projectId: "cgm1", description: "כלום", amount: usd(0), paidOn: d(2024, 1, 1) },
        project,
      ),
    ).toThrow(InvalidProjectExpenseError);
  });

  it("refuses an expense with no description of what it was spent on", () => {
    const { project } = cgm1();
    expect(() =>
      buildProjectExpense(
        "blank",
        { projectId: "cgm1", description: "   ", amount: usd(10), paidOn: d(2024, 1, 1) },
        project,
      ),
    ).toThrow(InvalidProjectExpenseError);
  });
});

// --- the pot cannot be overdrawn or silently topped up -----------------------

describe("an expense that would exceed the pot is refused", () => {
  function spentDown() {
    const { project, legs } = cgm1();
    const expenses = [
      buildProjectExpense(
        "land",
        { projectId: "cgm1", description: "רכישת הקרקע", amount: usd(77_894.19), paidOn: d(2023, 5, 1) },
        project,
      ),
    ];
    return { project, legs, expenses };
  }

  it("accepts an expense the pot can pay for, to the last agora", () => {
    const { project, legs, expenses } = spentDown();
    expect(() =>
      requireWithinPot({
        project,
        legs,
        expenses,
        candidate: { amount: usd(21_188), rate: null },
      }),
    ).not.toThrow();
  });

  it("refuses the one that goes an agora past it", () => {
    const { project, legs, expenses } = spentDown();
    let thrown: unknown;
    try {
      requireWithinPot({ project, legs, expenses, candidate: { amount: usd(21_188.01), rate: null } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PotOverdrawnError);
    expect((thrown as PotOverdrawnError).shortfall).toEqual(usd(0.01));
    expect((thrown as PotOverdrawnError).balance).toEqual(usd(21_188));
  });

  it("lets a new funding leg make room, which is the only way money goes in", () => {
    const { project, legs, expenses } = spentDown();
    const topped = [
      ...legs,
      buildFundingLeg(
        "cgm1-more",
        { projectId: "cgm1", source: "Apple RSU", amount: usd(1_000), paidOn: d(2024, 3, 1) },
        project,
      ),
    ];

    expect(() =>
      requireWithinPot({
        project,
        legs: topped,
        expenses,
        candidate: { amount: usd(21_188.01), rate: null },
      }),
    ).not.toThrow();
    expect(potOf(project, topped, expenses).balance).toEqual(usd(22_188));
  });

  it("weighs a candidate paid in the other currency at its own rate", () => {
    const { project, legs, expenses } = spentDown();
    // $21,188 of room. 77,336.20₪ at 3.65 is $21,188.00 exactly; a shekel more is not.
    expect(() =>
      requireWithinPot({
        project,
        legs,
        expenses,
        candidate: { amount: ils(77_336.2), rate: USD_ILS(3.65) },
      }),
    ).not.toThrow();
    expect(() =>
      requireWithinPot({
        project,
        legs,
        expenses,
        candidate: { amount: ils(77_436.2), rate: USD_ILS(3.65) },
      }),
    ).toThrow(PotOverdrawnError);
  });

  it("refuses to remove a leg the pot has already spent against", () => {
    const { project, legs, expenses } = spentDown();
    let thrown: unknown;
    try {
      requireLegRemovable({ project, legs, expenses, legId: "cgm1-rsu" });
    } catch (error) {
      thrown = error;
    }

    // Without the $69,000 leg the pot holds $30,082.19 against $77,894.19 spent.
    expect(thrown).toBeInstanceOf(FundingLegRequiredError);
    expect((thrown as FundingLegRequiredError).shortfall).toEqual(usd(47_812));
    expect(() => requireLegRemovable({ project, legs, expenses: [], legId: "cgm1-rsu" })).not.toThrow();
  });
});

// --- what מיפוי reads --------------------------------------------------------

describe("a project's snapshot value stays at total cost", () => {
  it("does not fall as the expense ledger is spent down", () => {
    const { project, legs } = cgm1();
    const cost = costForSnapshot(project, legs);
    expect(cost).toEqual(usd(99_082.19));

    const expenses: ProjectExpense[] = [];
    for (let step = 1; step <= 5; step += 1) {
      expenses.push(
        buildProjectExpense(
          `spend-${step}`,
          { projectId: "cgm1", description: `תשלום ${step}`, amount: usd(10_000), paidOn: d(2024, 1, step) },
          project,
        ),
      );

      // The balance falls; the cost does not. Converting cash into property moves
      // money inside the pot, and the pot cost what it cost (ADR 0003).
      expect(potOf(project, legs, expenses).balance).toEqual(usd(99_082.19 - step * 10_000));
      expect(costForSnapshot(project, legs)).toEqual(cost);
    }
  });

  it("is the same figure the pot reports as funded", () => {
    const { project, legs } = meteor();
    const reading = readProject({ project, legs, expenses: [], terms: [] });
    expect(reading.cost).toEqual(reading.pot.funded);
    expect(reading.cost).toEqual(ils(244_400));
  });
});

// --- deal terms --------------------------------------------------------------

describe("deal terms are recorded as data", () => {
  it("keeps what the paperwork stated, in whole basis points and whole months", () => {
    const terms = buildDealTerms({
      projectId: "cgm1",
      targetReturnBasisPoints: 1_800,
      holdMonths: 60,
      distribution: "רבעוני לאחר שנתיים",
      source: "מצגת הסבב, אפריל 2023",
      recordedOn: d(2023, 4, 20),
    });

    expect(terms.targetReturnBasisPoints).toBe(1_800);
    expect(terms.holdMonths).toBe(60);
    expect(terms.distribution).toBe("רבעוני לאחר שנתיים");
    expect(statesAnything(terms)).toBe(true);
  });

  it("is a row of nulls when nothing was stated, and says so", () => {
    const terms = buildDealTerms({ projectId: "meteor", recordedOn: d(2024, 9, 1) });
    expect(statesAnything(terms)).toBe(false);
    expect(terms.distribution).toBeNull();
  });

  it("refuses a fractional target return or a hold period of no months", () => {
    expect(() =>
      buildDealTerms({ projectId: "cgm1", targetReturnBasisPoints: 12.5, recordedOn: d(2023, 4, 20) }),
    ).toThrow(InvalidDealTermsError);
    expect(() => buildDealTerms({ projectId: "cgm1", holdMonths: 0, recordedOn: d(2023, 4, 20) })).toThrow(
      InvalidDealTermsError,
    );
  });

  it("is found per project, and absent rather than invented", () => {
    const terms = [buildDealTerms({ projectId: "cgm1", holdMonths: 60, recordedOn: d(2023, 4, 20) })];
    expect(termsFor(terms, "cgm1")?.holdMonths).toBe(60);
    expect(termsFor(terms, "meteor")).toBeNull();
  });
});

// --- the project itself ------------------------------------------------------

describe("a project", () => {
  it("refuses a nameless one", () => {
    expect(() => buildProject("x", { name: "  ", currency: "USD", startedOn: d(2024, 1, 1) })).toThrow(
      InvalidProjectError,
    );
  });

  it("holds no account until one is named", () => {
    const project = buildProject("x", { name: "CGM 3", currency: "USD", startedOn: d(2027, 1, 1) });
    expect(project.accountId).toBeNull();
  });

  it("reads oldest first and refuses to resolve one that does not exist", () => {
    const projects = [cgm2().project, meteor().project, cgm1().project];
    expect(projectsInReadingOrder(projects).map((project) => project.name)).toEqual([
      "CGM 1",
      "Meteor 6",
      "CGM 2",
    ]);
    expect(requireProject(projects, "cgm1").name).toBe("CGM 1");
    expect(() => requireProject(projects, "nothing")).toThrow(UnknownProjectError);
  });

  it("reads whole, with the pot, the rate and the terms in one shape", () => {
    const { project, legs } = cgm1();
    const reading = readProject({
      project,
      legs,
      expenses: [],
      terms: [buildDealTerms({ projectId: "cgm1", holdMonths: 60, recordedOn: d(2023, 4, 20) })],
    });

    expect(reading.pot.balance).toEqual(usd(99_082.19));
    expect(reading.effective.rate).toBeCloseTo(3.65, 6);
    expect(reading.terms?.holdMonths).toBe(60);
    expect(reading.legs).toHaveLength(2);
  });
});
