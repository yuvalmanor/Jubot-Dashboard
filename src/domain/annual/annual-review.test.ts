import { describe, expect, it } from "vitest";

import {
  type Categories,
  EMPTY_CATEGORIES,
  applyCreation,
  planPersonalCategoryCreation,
} from "@/domain/categories/categories";
import { type EnteredEntry, type Ledger, buildLedger } from "@/domain/ledger/ledger";
import { type Money, exchangeRate, money } from "@/domain/money/money";
import {
  type FundingLeg,
  type Project,
  type ProjectExpense,
  buildFundingLeg,
  buildProject,
  buildProjectExpense,
} from "@/domain/projects/projects";
import {
  type Grant,
  type RsuPosition,
  type Vest,
  buildGrant,
  buildVest,
  readPosition,
  sharePriceFromMajorUnits,
} from "@/domain/rsu/rsu-position";
import {
  type Account,
  type Snapshot,
  buildAccount,
  buildSnapshot,
} from "@/domain/snapshot/snapshot";
import { calendarDate } from "@/domain/time/calendar-date";
import { calendarMonth, monthKey } from "@/domain/time/calendar-month";

import {
  type AnnualReview,
  type AnnualReviewReading,
  InvalidAnnualReviewError,
  InvalidReviewComparisonError,
  UnknownAnnualReviewError,
  buildAnnualReview,
  closesOn,
  compareAnnualReviews,
  missingFacts,
  readAnnualReview,
  requireAnnualReview,
  reviewsInReadingOrder,
  valuationFor,
} from "./annual-review";

/**
 * Plain data in, plain data out: no database, no browser, no network. Every money
 * assertion is on exact minor units.
 *
 * The two facts this suite exists to hold are the two halves of ADR 0002: a frozen
 * fact never moves when the records move, and a live figure always does.
 */

const ils = (major: number): Money => money(Math.round(major * 100), "ILS");
const usd = (major: number): Money => money(Math.round(major * 100), "USD");
const d = (year: number, month: number, day: number) => calendarDate(year, month, day);
const m = (year: number, month: number) => calendarMonth(year, month);
const USD_ILS = (rate: number) => exchangeRate("USD", "ILS", rate);

/** The month the reviews below are read from — 2025 and 2026 are both behind it. */
const TODAY = m(2027, 3);

// --- the מאזן fixture ----------------------------------------------------------

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

function everyMonth(year: number, amount: number): Record<string, number> {
  return Object.fromEntries(
    Array.from({ length: 12 }, (unused, index) => [monthKey(m(year, index + 1)), amount]),
  );
}

/**
 * A full year of 2025: 40,000₪ in and 25,000₪ out every month, so the year reads
 * 480,000₪ / 300,000₪ / 180,000₪.
 */
function fullYear(overrides: Record<string, Record<string, number>> = {}): Ledger {
  return buildLedger({
    entered: entries({
      "p-salary": everyMonth(2025, 30_000),
      "p-eden-salary": everyMonth(2025, 10_000),
      "p-health": everyMonth(2025, 15_000),
      "p-eden-health": everyMonth(2025, 10_000),
      ...overrides,
    }),
  });
}

// --- the מיפוי fixture ---------------------------------------------------------

function accounts(): readonly Account[] {
  return [
    buildAccount("a-liquid", {
      personId: "yuval",
      name: "עו״ש",
      currency: "ILS",
      valueBasis: "market",
      category: "liquid",
      assetKind: "עו״ש",
      openedOn: d(2020, 1, 1),
    }),
    buildAccount("a-rsu", {
      personId: "yuval",
      name: "Apple RSU",
      currency: "USD",
      valueBasis: "market",
      category: "investments",
      assetKind: "RSU",
      openedOn: d(2020, 1, 1),
    }),
    buildAccount("a-cgm1", {
      personId: "yuval",
      name: "CGM 1",
      currency: "USD",
      valueBasis: "cost",
      category: "property",
      assetKind: "נדל״ן",
      openedOn: d(2020, 1, 1),
    }),
  ];
}

function snapshot(options: { readonly rates?: readonly ReturnType<typeof USD_ILS>[] } = {}): Snapshot {
  const takenOn = d(2025, 12, 31);
  return buildSnapshot({
    id: "s-2025",
    takenOn,
    rates: options.rates ?? [USD_ILS(3.6)],
    lines: [
      { accountId: "a-liquid", balance: ils(200_000), source: "entered", measuredOn: takenOn },
      { accountId: "a-rsu", balance: usd(50_000), source: "entered", measuredOn: takenOn },
      { accountId: "a-cgm1", balance: usd(99_082.19), source: "entered", measuredOn: takenOn },
    ],
  });
}

// --- the projects fixture ------------------------------------------------------

function cgm1(): Project {
  return buildProject("cgm1", { name: "CGM 1", currency: "USD", startedOn: d(2023, 4, 1) });
}

function meteor(): Project {
  return buildProject("meteor", { name: "Meteor 6", currency: "ILS", startedOn: d(2024, 2, 1) });
}

function legs(): readonly FundingLeg[] {
  return [
    buildFundingLeg(
      "l1",
      { projectId: "cgm1", source: "Apple RSU", amount: usd(69_000), paidOn: d(2023, 4, 1) },
      cgm1(),
    ),
    buildFundingLeg(
      "l2",
      {
        projectId: "cgm1",
        source: "עו״ש",
        amount: ils(109_800),
        rate: USD_ILS(3.65),
        paidOn: d(2023, 4, 1),
      },
      cgm1(),
    ),
    buildFundingLeg(
      "l3",
      { projectId: "meteor", source: "עו״ש", amount: ils(200_000), paidOn: d(2024, 2, 1) },
      meteor(),
    ),
  ];
}

function expenses(): readonly ProjectExpense[] {
  return [
    buildProjectExpense(
      "e1",
      { projectId: "cgm1", description: "רכישה", amount: usd(77_894.19), paidOn: d(2023, 6, 1) },
      cgm1(),
    ),
  ];
}

// --- the RSU fixture -----------------------------------------------------------

function grant(): Grant {
  return buildGrant("g1", {
    personId: "yuval",
    reference: "APPL-2023-11",
    grantedOn: d(2023, 11, 11),
    totalShares: 400,
  });
}

function vests(): readonly Vest[] {
  return [
    buildVest(
      "v1",
      { grantId: "g1", vestedOn: d(2024, 11, 11), shares: 100, priceAtVest: price(150) },
      grant(),
    ),
    buildVest(
      "v2",
      { grantId: "g1", vestedOn: d(2025, 11, 11), shares: 80, priceAtVest: price(230) },
      grant(),
    ),
    // Ahead of the close, so the position holds it out of the year's figures.
    buildVest(
      "v3",
      { grantId: "g1", vestedOn: d(2026, 11, 11), shares: 60, priceAtVest: price(250) },
      grant(),
    ),
  ];
}

function price(major: number) {
  return sharePriceFromMajorUnits(major, "USD");
}

function positionAt(year: number): RsuPosition {
  return readPosition({ grants: [grant()], vests: vests(), sales: [], asOf: closesOn(year) });
}

// --- the review fixture --------------------------------------------------------

function review(overrides: Partial<Parameters<typeof buildAnnualReview>[0]> = {}): AnnualReview {
  return buildAnnualReview({
    year: 2025,
    recordedOn: d(2026, 1, 8),
    closingSnapshotId: "s-2025",
    closingRate: USD_ILS(3.6),
    closingSharePrice: price(280),
    valuations: [{ projectId: "cgm1", amount: usd(120_000) }],
    ...overrides,
  });
}

function reading(
  options: {
    readonly review?: AnnualReview;
    readonly ledger?: Ledger;
    readonly snapshot?: Snapshot | null;
    readonly withRsu?: boolean;
  } = {},
): AnnualReviewReading {
  const own = options.review ?? review();
  return readAnnualReview({
    review: own,
    ledger: options.ledger ?? fullYear(),
    categories: categories(),
    currency: "ILS",
    today: TODAY,
    snapshot: options.snapshot === undefined ? snapshot() : options.snapshot,
    accounts: accounts(),
    projects: [cgm1(), meteor()],
    legs: legs(),
    expenses: expenses(),
    position: options.withRsu === false ? null : positionAt(own.year),
  });
}

// --- the review as a record ----------------------------------------------------

describe("an annual review holds a year and the facts nothing can reconstruct", () => {
  it("records the year, its frozen facts and the day it was written", () => {
    expect(review()).toEqual({
      year: 2025,
      recordedOn: d(2026, 1, 8),
      note: null,
      closingSnapshotId: "s-2025",
      closingRate: USD_ILS(3.6),
      closingSharePrice: price(280),
      valuations: [{ projectId: "cgm1", amount: usd(120_000) }],
    });
  });

  it("closes on the last day of December, whatever day it was written on", () => {
    expect(closesOn(2025)).toEqual(d(2025, 12, 31));
    expect(closesOn(2024)).toEqual(d(2024, 12, 31));
  });

  it("treats a blank note as no note", () => {
    expect(review({ note: "   " }).note).toBeNull();
    expect(review({ note: " שנה של CGM 2 " }).note).toBe("שנה של CGM 2");
  });

  it("is a legitimate state with no frozen facts at all, and names what is missing", () => {
    const bare = buildAnnualReview({ year: 2025, recordedOn: d(2026, 1, 8) });

    expect(bare.closingSnapshotId).toBeNull();
    expect(bare.closingRate).toBeNull();
    expect(bare.closingSharePrice).toBeNull();
    expect(missingFacts(bare)).toEqual(["closing-snapshot", "closing-rate", "closing-share-price"]);
    expect(missingFacts(review())).toEqual([]);
  });

  it("refuses a year that is not a calendar year", () => {
    expect(() => buildAnnualReview({ year: 1999, recordedOn: d(2026, 1, 8) })).toThrow(
      InvalidAnnualReviewError,
    );
    expect(() => buildAnnualReview({ year: 2025.5, recordedOn: d(2026, 1, 8) })).toThrow(
      InvalidAnnualReviewError,
    );
  });

  it("refuses a closing rate quoted for any pair but USD/ILS", () => {
    expect(() => review({ closingRate: exchangeRate("ILS", "USD", 0.27) })).toThrow(
      InvalidAnnualReviewError,
    );
  });

  it("refuses two valuations of one project, and a negative one", () => {
    expect(() =>
      review({
        valuations: [
          { projectId: "cgm1", amount: usd(120_000) },
          { projectId: "cgm1", amount: usd(130_000) },
        ],
      }),
    ).toThrow(InvalidAnnualReviewError);

    expect(() => review({ valuations: [{ projectId: "cgm1", amount: usd(-1) }] })).toThrow(
      InvalidAnnualReviewError,
    );
  });

  it("reads newest year first, and resolves one by year", () => {
    const older = buildAnnualReview({ year: 2024, recordedOn: d(2025, 1, 5) });
    const newer = buildAnnualReview({ year: 2025, recordedOn: d(2026, 1, 8) });

    expect(reviewsInReadingOrder([older, newer]).map((one) => one.year)).toEqual([2025, 2024]);
    expect(requireAnnualReview([older, newer], 2024)).toBe(older);
    expect(() => requireAnnualReview([older, newer], 2023)).toThrow(UnknownAnnualReviewError);
  });

  it("answers what a project was valued at, and says nothing for one nobody valued", () => {
    expect(valuationFor(review(), "cgm1")).toEqual(usd(120_000));
    expect(valuationFor(review(), "meteor")).toBeNull();
  });
});

// --- the מאזן figures, which are live -----------------------------------------

describe("the מאזן bottom line is recomputed from the ledger on every read", () => {
  it("reads the year's הכנסות, הוצאות and חיסכון with its denominator", () => {
    const balance = reading().balance;

    expect(balance.income.value).toEqual(ils(480_000));
    expect(balance.expenses.value).toEqual(ils(300_000));
    expect(balance.saving.value).toEqual(ils(180_000));
    expect(balance.denominator).toBe(12);
    expect(balance.recordedMonths).toBe(12);
  });

  it("labels every one of them live", () => {
    const balance = reading().balance;

    expect([balance.income.basis, balance.expenses.basis, balance.saving.basis]).toEqual([
      "live",
      "live",
      "live",
    ]);
  });

  it("moves when an entry from the reviewed year is corrected", () => {
    const before = reading().balance;
    const corrected = reading({
      // One month of בריאות corrected from 15,000₪ to 5,000₪.
      ledger: fullYear({ "p-health": { ...everyMonth(2025, 15_000), "2025-06": 5_000 } }),
    }).balance;

    expect(before.expenses.value).toEqual(ils(300_000));
    expect(corrected.expenses.value).toEqual(ils(290_000));
    expect(corrected.saving.value).toEqual(ils(190_000));
    // The review itself did not change — only what it reads did.
    expect(corrected.income.value).toEqual(before.income.value);
  });

  it("says how much of the year was recorded rather than reading a part year as a cheap one", () => {
    const half = reading({
      ledger: buildLedger({
        entered: entries({
          "p-salary": { "2025-01": 30_000, "2025-02": 30_000 },
          "p-health": { "2025-01": 15_000, "2025-02": 15_000 },
        }),
      }),
    }).balance;

    expect(half.recordedMonths).toBe(2);
    expect(half.denominator).toBe(12);
    expect(half.saving.value).toEqual(ils(30_000));
  });
});

// --- the frozen facts, which are not ------------------------------------------

describe("a frozen fact does not move when the records move", () => {
  it("keeps the closing valuation while the project's cost is recomputed", () => {
    const before = reading().projects.lines.find((line) => line.project.id === "cgm1");

    const withAnotherLeg = readAnnualReview({
      review: review(),
      ledger: fullYear(),
      categories: categories(),
      currency: "ILS",
      today: TODAY,
      projects: [cgm1()],
      legs: [
        ...legs(),
        buildFundingLeg(
          "l4",
          { projectId: "cgm1", source: "Apple RSU", amount: usd(10_000), paidOn: d(2025, 9, 1) },
          cgm1(),
        ),
      ],
      expenses: expenses(),
      position: positionAt(2025),
    }).projects.lines.find((line) => line.project.id === "cgm1");

    // 69,000 + 109,800 ÷ 3.65 = 99,082.19, and a leg later makes it 109,082.19.
    expect(before?.cost.value).toEqual(usd(99_082.19));
    expect(withAnotherLeg?.cost.value).toEqual(usd(109_082.19));
    // The valuation is a judgement somebody placed on 31 December and is untouched.
    expect(withAnotherLeg?.valuation?.value).toEqual(usd(120_000));
    expect(withAnotherLeg?.valuation?.basis).toBe("frozen");
    expect(withAnotherLeg?.aboveCost).toEqual(usd(10_917.81));
  });

  it("prices the RSU holding at the frozen price and never at the vest's own", () => {
    const rsu = reading().rsu;

    // 180 shares held at the close — the 2026 vest is not one of them.
    expect(rsu?.shares.value).toBe(180);
    expect(rsu?.shares.basis).toBe("live");
    expect(rsu?.price?.value).toEqual(price(280));
    expect(rsu?.price?.basis).toBe("frozen");
    expect(rsu?.value?.value).toEqual(usd(50_400));
    expect(rsu?.value?.basis).toBe("live-at-frozen");
  });

  it("reads the holding into shekels at the frozen closing rate", () => {
    // 50,400 × 3.6 = 181,440, at the rate the year closed at rather than today's.
    expect(reading().rsu?.valueInCurrency?.value).toEqual(ils(181_440));
    expect(reading().rsu?.valueInCurrency?.basis).toBe("live-at-frozen");
  });

  it("states no shekel figure at all where no closing rate was frozen", () => {
    const unrated = reading({ review: review({ closingRate: null }) });

    expect(unrated.rsu?.value?.value).toEqual(usd(50_400));
    expect(unrated.rsu?.valueInCurrency).toBeNull();
    expect(unrated.missing).toEqual(["closing-rate"]);
  });

  it("states no value at all where no closing price was frozen", () => {
    const unpriced = reading({ review: review({ closingSharePrice: null }) });

    expect(unpriced.rsu?.shares.value).toBe(180);
    expect(unpriced.rsu?.price).toBeNull();
    expect(unpriced.rsu?.value).toBeNull();
  });
});

// --- the position is read as of the close --------------------------------------

describe("the position on the review is the position as the year closed", () => {
  it("holds a vest still ahead of the closing date out of the count", () => {
    expect(reading().rsu?.shares.value).toBe(180);
    expect(positionAt(2026).remainingShares).toBe(240);
  });

  it("splits the count by each lot's own clock at the close", () => {
    const rsu = reading().rsu;

    // Granted 2023-11-11, so both lots are Qualified by 2025-12-31.
    expect(rsu?.qualifiedShares.value).toBe(180);
    expect(rsu?.unqualifiedShares.value).toBe(0);
  });

  it("refuses a position read on any day but the closing one", () => {
    expect(() =>
      readAnnualReview({
        review: review(),
        ledger: fullYear(),
        categories: categories(),
        currency: "ILS",
        today: TODAY,
        position: positionAt(2026),
      }),
    ).toThrow(InvalidAnnualReviewError);
  });

  it("is silent about RSU where the household recorded none", () => {
    expect(reading({ withRsu: false }).rsu).toBeNull();
  });
});

// --- the closing snapshot -------------------------------------------------------

describe("the closing snapshot is totalled at its own rate", () => {
  it("totals the reading at the rate the snapshot carries", () => {
    const netWorth = reading().netWorth;

    // 200,000₪ + (50,000 + 99,082.19) × 3.6 = 736,695.88.
    expect(netWorth?.total?.value).toEqual(ils(736_695.88));
    expect(netWorth?.total?.basis).toBe("live");
    expect(netWorth?.takenOn).toEqual(d(2025, 12, 31));
    expect(netWorth?.withinYear).toBe(true);
  });

  it("does not re-total at the review's own rate when the two differ", () => {
    // The snapshot's rate is 3.6; the review freezes 3.9. A snapshot keeps reading
    // as it read on the day, so the total is unmoved.
    const different = reading({ review: review({ closingRate: USD_ILS(3.9) }) });

    expect(different.netWorth?.total?.value).toEqual(ils(736_695.88));
  });

  it("says how much of the total is held at cost", () => {
    const split = reading().netWorth?.split;

    expect(split?.byBasis.cost).toEqual(ils(356_695.88));
    expect(split?.byBasis.market).toEqual(ils(380_000));
  });

  it("has no total where the snapshot carries no rate for a currency it holds", () => {
    const unconvertible = reading({ snapshot: snapshot({ rates: [] }) });

    expect(unconvertible.netWorth?.total).toBeNull();
    expect(unconvertible.netWorth?.split).toBeNull();
    expect(unconvertible.netWorth?.accountCount).toBe(3);
  });

  it("says when the reading was not taken inside the year it closes", () => {
    const january = buildSnapshot({
      id: "s-late",
      takenOn: d(2026, 1, 4),
      rates: [USD_ILS(3.6)],
      lines: [{ accountId: "a-liquid", balance: ils(200_000), source: "entered", measuredOn: d(2026, 1, 4) }],
    });

    expect(reading({ snapshot: january }).netWorth?.withinYear).toBe(false);
  });

  it("is silent where no closing snapshot was named", () => {
    expect(reading({ snapshot: null }).netWorth).toBeNull();
  });
});

// --- the projects ---------------------------------------------------------------

describe("the projects read as cost, spend and a frozen judgement beside them", () => {
  it("reads each pot live, in the pot's own currency", () => {
    const lines = reading().projects.lines;
    const cgm = lines.find((line) => line.project.id === "cgm1");
    const met = lines.find((line) => line.project.id === "meteor");

    expect(cgm?.cost.value).toEqual(usd(99_082.19));
    expect(cgm?.spent.value).toEqual(usd(77_894.19));
    expect(cgm?.balance.value).toEqual(usd(21_188));
    expect([cgm?.cost.basis, cgm?.spent.basis, cgm?.balance.basis]).toEqual(["live", "live", "live"]);
    expect(met?.cost.value).toEqual(ils(200_000));
  });

  it("totals the costs into one currency at the frozen rate, and says so", () => {
    const projects = reading().projects;

    // 99,082.19 × 3.6 = 356,695.88, plus Meteor's 200,000₪ already in shekels.
    expect(projects.cost?.value).toEqual(ils(556_695.88));
    expect(projects.cost?.basis).toBe("live-at-frozen");
  });

  it("has no total where a conversion was needed and no rate was frozen", () => {
    const unrated = reading({ review: review({ closingRate: null }) });

    expect(unrated.projects.cost).toBeNull();
    expect(unrated.projects.unreadable).toEqual(["cgm1"]);
    // The lines themselves still read, each in its own currency.
    expect(unrated.projects.lines[0]?.cost.value).toEqual(usd(99_082.19));
  });

  it("names the projects nobody placed a valuation on rather than valuing them at cost", () => {
    const projects = reading().projects;

    expect(projects.unvalued).toEqual(["meteor"]);
    expect(projects.valuation?.value).toEqual(ils(432_000));
    expect(projects.valuation?.basis).toBe("frozen");
  });

  it("states no difference from cost where the valuation is in another currency", () => {
    const crossed = reading({
      review: review({ valuations: [{ projectId: "cgm1", amount: ils(430_000) }] }),
    });
    const cgm = crossed.projects.lines.find((line) => line.project.id === "cgm1");

    expect(cgm?.valuation?.value).toEqual(ils(430_000));
    expect(cgm?.aboveCost).toBeNull();
  });
});

// --- two reviews side by side ----------------------------------------------------

describe("two reviews compare in calendar order", () => {
  const twentyFive = () => reading();

  const twentySix = () =>
    reading({
      review: review({
        year: 2026,
        recordedOn: d(2027, 1, 6),
        closingSnapshotId: null,
        closingSharePrice: price(300),
        valuations: [{ projectId: "cgm1", amount: usd(140_000) }],
      }),
      ledger: buildLedger({
        entered: entries({
          "p-salary": everyMonth(2026, 32_000),
          "p-eden-salary": everyMonth(2026, 10_000),
          "p-health": everyMonth(2026, 15_000),
          "p-eden-health": everyMonth(2026, 10_000),
        }),
      }),
      snapshot: null,
    });

  it("puts the earlier year first whichever way round it was handed in", () => {
    const forwards = compareAnnualReviews(twentyFive(), twentySix());
    const backwards = compareAnnualReviews(twentySix(), twentyFive());

    expect(forwards.earlier.review.year).toBe(2025);
    expect(forwards.later.review.year).toBe(2026);
    expect(backwards.earlier.review.year).toBe(2025);
    expect(backwards.later.review.year).toBe(2026);
  });

  it("states the difference as the later year less the earlier one", () => {
    const rows = compareAnnualReviews(twentyFive(), twentySix()).rows;
    const income = rows.find((row) => row.key === "income");
    const saving = rows.find((row) => row.key === "saving");

    // 504,000₪ against 480,000₪.
    expect(income?.earlier).toEqual(ils(480_000));
    expect(income?.later).toEqual(ils(504_000));
    expect(income?.difference).toEqual(ils(24_000));
    expect(saving?.difference).toEqual(ils(24_000));
  });

  it("carries the basis of every row, so a frozen rise never reads as a measured one", () => {
    const rows = compareAnnualReviews(twentyFive(), twentySix()).rows;

    expect(rows.find((row) => row.key === "saving")?.basis).toBe("live");
    expect(rows.find((row) => row.key === "project-valuation")?.basis).toBe("frozen");
    expect(rows.find((row) => row.key === "rsu-value")?.basis).toBe("live-at-frozen");
  });

  it("states one side alone rather than dropping a row the other year cannot answer", () => {
    const netWorth = compareAnnualReviews(twentyFive(), twentySix()).rows.find(
      (row) => row.key === "net-worth",
    );

    expect(netWorth?.earlier).toEqual(ils(736_695.88));
    expect(netWorth?.later).toBeNull();
    expect(netWorth?.difference).toBeNull();
  });

  it("counts shares as a count and not as money", () => {
    const shares = compareAnnualReviews(twentyFive(), twentySix()).rows.find(
      (row) => row.key === "rsu-shares",
    );

    expect(shares?.kind).toBe("count");
    expect(shares?.earlier).toBe(180);
    expect(shares?.later).toBe(240);
    expect(shares?.difference).toBe(60);
  });

  it("says when the two years converted at different rates", () => {
    const comparison = compareAnnualReviews(twentyFive(), twentySix());

    // Both froze 3.6 here, so a converted row moved because money moved.
    expect(comparison.sameRate).toBe(true);

    const laterRate = compareAnnualReviews(
      twentyFive(),
      reading({
        review: review({ year: 2026, recordedOn: d(2027, 1, 6), closingRate: USD_ILS(3.9) }),
        snapshot: null,
      }),
    );

    expect(laterRate.sameRate).toBe(false);
    expect(laterRate.rates).toEqual({ earlier: USD_ILS(3.6), later: USD_ILS(3.9) });
    // The costs are identical records read at two rates, and the difference is
    // entirely the rate — which is exactly why the screen may not print it bare.
    const cost = laterRate.rows.find((row) => row.key === "project-cost");
    expect(cost?.basis).toBe("live-at-frozen");
    expect(cost?.difference).toEqual(ils(29_724.66));
  });

  it("treats two years that froze no rate as having no rate difference to hide", () => {
    const comparison = compareAnnualReviews(
      reading({ review: review({ closingRate: null }), snapshot: null }),
      reading({
        review: review({ year: 2026, recordedOn: d(2027, 1, 6), closingRate: null }),
        snapshot: null,
      }),
    );

    expect(comparison.sameRate).toBe(true);
    expect(comparison.rates).toEqual({ earlier: null, later: null });
  });

  it("refuses a year compared against itself", () => {
    expect(() => compareAnnualReviews(twentyFive(), twentyFive())).toThrow(
      InvalidReviewComparisonError,
    );
  });
});
