import { describe, expect, it } from "vitest";

import { type Money, exchangeRate, money } from "@/domain/money/money";
import {
  type Account,
  type Snapshot,
  buildAccount,
  convertedReadings,
  restate,
  seedSnapshot,
} from "@/domain/snapshot/snapshot";
import { type CalendarDate, calendarDate } from "@/domain/time/calendar-date";

import {
  InvalidAllocationTargetError,
  InvalidAppreciationError,
  allocation,
  appreciationRange,
  buildAllocationTargets,
  buildAppreciationAssumption,
  concentrationOf,
  currencyExposure,
  growthFactor,
  netWorthTrajectory,
  targetFor,
} from "./net-worth-analytics";

/**
 * Plain data in, plain data out: no database, no browser, no network. Every money
 * assertion is on exact minor units — an allocation that is out by an agora is an
 * allocation that will not add up on screen.
 */

const ils = (major: number): Money => money(Math.round(major * 100), "ILS");
const usd = (major: number): Money => money(Math.round(major * 100), "USD");
const d = (year: number, month: number, day: number) => calendarDate(year, month, day);

/**
 * The household's real shape: liquid shekels, a dollar brokerage, a pension, and
 * CGM 2 — converted but not yet invested, and classified under נדל"ן by decision.
 */
function accounts(): Account[] {
  return [
    buildAccount("current", {
      personId: "yuval",
      name: 'עו"ש דיסקונט',
      currency: "ILS",
      valueBasis: "market",
      category: "liquid",
      assetKind: "עובר ושב",
      openedOn: d(2020, 1, 1),
    }),
    buildAccount("brokerage", {
      personId: "yuval",
      name: "תיק השקעות",
      currency: "USD",
      valueBasis: "market",
      category: "investments",
      assetKind: "ניירות ערך",
      openedOn: d(2020, 1, 1),
    }),
    buildAccount("rsu", {
      personId: "yuval",
      name: "Apple RSU",
      currency: "USD",
      valueBasis: "market",
      category: "investments",
      assetKind: "RSU",
      openedOn: d(2021, 3, 1),
    }),
    buildAccount("pension", {
      personId: "eden",
      name: "קרן פנסיה",
      currency: "ILS",
      valueBasis: "market",
      category: "pension",
      assetKind: "פנסיה",
      openedOn: d(2018, 1, 1),
    }),
    buildAccount("cgm2", {
      personId: "yuval",
      name: "CGM 2",
      currency: "USD",
      valueBasis: "cost",
      category: "property",
      assetKind: "פרוייקט נדלן",
      openedOn: d(2023, 6, 15),
    }),
  ];
}

function snapshotOf(input: {
  readonly id: string;
  readonly takenOn: CalendarDate;
  readonly rate: number;
  readonly balances: readonly { accountId: string; balance: Money }[];
}): Snapshot {
  const seeded = seedSnapshot({
    id: input.id,
    takenOn: input.takenOn,
    rates: [exchangeRate("USD", "ILS", input.rate)],
    accounts: accounts(),
    previous: null,
  });
  return restate(
    seeded,
    input.balances.map((balance) => ({ ...balance, measured: true })),
  );
}

/** 100,000₪ liquid, $40,000 brokerage, $20,000 RSU, 300,000₪ pension, $82,000 CGM 2. */
function fullSnapshot(id: string, takenOn: CalendarDate, rate: number): Snapshot {
  return snapshotOf({
    id,
    takenOn,
    rate,
    balances: [
      { accountId: "current", balance: ils(100_000) },
      { accountId: "brokerage", balance: usd(40_000) },
      { accountId: "rsu", balance: usd(20_000) },
      { accountId: "pension", balance: ils(300_000) },
      { accountId: "cgm2", balance: usd(82_000) },
    ],
  });
}

function readings(snapshot: Snapshot) {
  return convertedReadings(snapshot, accounts(), "ILS");
}

// --- the trajectory ----------------------------------------------------------

describe("net worth over time", () => {
  it("charts every snapshot at its own rate, oldest first", () => {
    const january = fullSnapshot("s1", d(2025, 1, 31), 3.65);
    const july = fullSnapshot("s2", d(2025, 7, 31), 3.2);

    // Handed in newest first, as the database returns them.
    const points = netWorthTrajectory({
      snapshots: [july, january],
      accounts: accounts(),
      currency: "ILS",
    });

    expect(points.map((point) => point.takenOn.month)).toEqual([1, 7]);
    // 100,000 + 300,000 shekels, plus $142,000 at each snapshot's own rate.
    expect(points[0]?.total).toEqual(ils(400_000 + 142_000 * 3.65));
    expect(points[1]?.total).toEqual(ils(400_000 + 142_000 * 3.2));
  });

  it("reports the change against the previous point, and whether the rate held still", () => {
    const january = fullSnapshot("s1", d(2025, 1, 31), 3.65);
    const march = fullSnapshot("s2", d(2025, 3, 31), 3.65);
    const july = fullSnapshot("s3", d(2025, 7, 31), 3.2);

    const points = netWorthTrajectory({
      snapshots: [january, march, july],
      accounts: accounts(),
      currency: "ILS",
    });

    expect(points[0]?.change).toBeNull();
    expect(points[1]?.change).toEqual(ils(0));
    expect(points[1]?.sameRate).toBe(true);
    // Nothing moved but the rate, and the point says so rather than calling it growth.
    expect(points[2]?.change).toEqual(ils(142_000 * 3.2 - 142_000 * 3.65));
    expect(points[2]?.sameRate).toBe(false);
  });

  it("reads a snapshot with no rate for a currency it holds as unreadable, not as a smaller total", () => {
    const rateless = restate(
      seedSnapshot({
        id: "s0",
        takenOn: d(2024, 12, 31),
        rates: [],
        accounts: accounts(),
        previous: null,
      }),
      [{ accountId: "current", balance: ils(100_000), measured: true }],
    );

    const points = netWorthTrajectory({
      snapshots: [rateless],
      accounts: accounts(),
      currency: "ILS",
    });

    expect(points[0]?.total).toBeNull();
    expect(points[0]?.basis).toBeNull();
  });

  it("compares across a gap to the last readable point, never across the gap itself", () => {
    const january = fullSnapshot("s1", d(2025, 1, 31), 3.65);
    const rateless = restate(
      seedSnapshot({
        id: "s2",
        takenOn: d(2025, 3, 31),
        rates: [],
        accounts: accounts(),
        previous: null,
      }),
      [{ accountId: "current", balance: ils(100_000), measured: true }],
    );
    const july = fullSnapshot("s3", d(2025, 7, 31), 3.65);

    const points = netWorthTrajectory({
      snapshots: [january, rateless, july],
      accounts: accounts(),
      currency: "ILS",
    });

    expect(points[1]?.change).toBeNull();
    expect(points[2]?.change).toEqual(ils(0));
  });

  it("states how much of each point was measured rather than carried", () => {
    const january = fullSnapshot("s1", d(2025, 1, 31), 3.65);
    const july = seedSnapshot({
      id: "s2",
      takenOn: d(2025, 7, 31),
      rates: [exchangeRate("USD", "ILS", 3.65)],
      accounts: accounts(),
      previous: january,
    });

    const points = netWorthTrajectory({
      snapshots: [january, july],
      accounts: accounts(),
      currency: "ILS",
    });

    expect(points[0]?.measured).toBe(5);
    expect(points[1]?.measured).toBe(0);
    expect(points[1]?.carried).toBe(5);
    // The total is the same money — carried forward, and the point says so.
    expect(points[1]?.total).toEqual(points[0]?.total);
  });
});

// --- חשיפה למט"ח --------------------------------------------------------------

describe("currency exposure", () => {
  it("is derived from each account's own currency", () => {
    const exposure = currencyExposure(readings(fullSnapshot("s1", d(2025, 1, 31), 3.65)), "ILS");

    expect(exposure.lines.map((line) => line.currency)).toEqual(["ILS", "USD"]);
    expect(exposure.lines[0]?.native).toEqual(ils(400_000));
    expect(exposure.lines[1]?.native).toEqual(usd(142_000));
    expect(exposure.lines[1]?.amount).toEqual(ils(142_000 * 3.65));
    expect(exposure.foreign).toEqual(ils(142_000 * 3.65));
  });

  it("counts a dollar asset as fully exposed however it was funded", () => {
    // CGM 2 is a dollar stake most of whose funding began as shekels. Nothing in
    // a snapshot records that, and exposure would not consult it if it did.
    const withCgm = currencyExposure(readings(fullSnapshot("s1", d(2025, 1, 31), 3.65)), "ILS");
    const cgmAlone = withCgm.lines.find((line) => line.currency === "USD");

    expect(cgmAlone?.accountCount).toBe(3);
    expect(cgmAlone?.native).toEqual(usd(142_000));
  });

  it("has no percentages at all when there is nothing to be a percentage of", () => {
    const empty = currencyExposure([], "ILS");

    expect(empty.total).toEqual(ils(0));
    expect(empty.foreignShare).toBeNull();
    expect(empty.lines).toEqual([]);
  });
});

// --- הקצאה --------------------------------------------------------------------

describe("allocation targets", () => {
  it("rejects a duplicate bucket, a fraction of a basis point, and more than 100%", () => {
    expect(() =>
      buildAllocationTargets([
        { category: "liquid", basisPoints: 1000 },
        { category: "liquid", basisPoints: 2000 },
      ]),
    ).toThrow(InvalidAllocationTargetError);
    expect(() => buildAllocationTargets([{ category: "liquid", basisPoints: 12.5 }])).toThrow(
      InvalidAllocationTargetError,
    );
    expect(() => buildAllocationTargets([{ category: "liquid", basisPoints: 10_001 }])).toThrow(
      InvalidAllocationTargetError,
    );
  });

  it("drops a target of zero rather than storing it, so untargeted stays untargeted", () => {
    const targets = buildAllocationTargets([
      { category: "liquid", basisPoints: 0 },
      { category: "pension", basisPoints: 3000 },
    ]);

    expect(targetFor(targets, "liquid")).toBeNull();
    expect(targetFor(targets, "pension")).toBe(3000);
  });
});

describe("allocation against רצוי targets", () => {
  const snapshot = fullSnapshot("s1", d(2025, 1, 31), 3.65);

  it("identifies over- and under-weight buckets, in money as well as in percent", () => {
    // 918,300₪ in total: 100,000 liquid, 219,000 investments, 300,000 pension,
    // 299,300 property.
    const result = allocation({
      readings: readings(snapshot),
      targets: buildAllocationTargets([
        { category: "liquid", basisPoints: 2000 },
        { category: "investments", basisPoints: 2000 },
        { category: "pension", basisPoints: 3000 },
        { category: "property", basisPoints: 3000 },
      ]),
      currency: "ILS",
    });

    expect(result.total).toEqual(ils(918_300));
    const liquid = result.lines.find((line) => line.category === "liquid");
    expect(liquid?.targetAmount).toEqual(ils(183_660));
    expect(liquid?.drift).toEqual(ils(-83_660));
    expect(liquid?.stance).toBe("under");

    const pension = result.lines.find((line) => line.category === "pension");
    expect(pension?.targetAmount).toEqual(ils(275_490));
    expect(pension?.drift).toEqual(ils(24_510));
    expect(pension?.stance).toBe("over");
  });

  it("reads CGM 2 under נדל\"ן, so allocation percentages read accordingly", () => {
    const result = allocation({
      readings: readings(snapshot),
      targets: buildAllocationTargets([]),
      currency: "ILS",
    });

    const property = result.lines.find((line) => line.category === "property");
    const liquid = result.lines.find((line) => line.category === "liquid");

    // $82,000 at 3.65 — the whole of it under נדל"ן, and none of it under נזילות.
    expect(property?.actual).toEqual(ils(299_300));
    expect(property?.accountCount).toBe(1);
    expect(liquid?.actual).toEqual(ils(100_000));
    // Which is the entire cost-held part of the portfolio, and the line says so.
    expect(property?.basis.byBasis.cost).toEqual(ils(299_300));
    expect(property?.basis.costShare).toBe(1);
  });

  it("keeps an untargeted bucket distinct from one that is on target", () => {
    const result = allocation({
      readings: readings(snapshot),
      targets: buildAllocationTargets([{ category: "liquid", basisPoints: 2000 }]),
      currency: "ILS",
    });

    expect(result.lines.find((line) => line.category === "pension")?.stance).toBe("untargeted");
    expect(result.lines.find((line) => line.category === "pension")?.drift).toBeNull();
    expect(result.targetsTotal).toBe(2000);
  });

  it("keeps a targeted bucket that holds nothing, because that is the most under-weight there is", () => {
    // A household that wants 30% in נדל"ן and owns none of it yet.
    const result = allocation({
      readings: readings(snapshot).filter((reading) => reading.account.category !== "property"),
      targets: buildAllocationTargets([{ category: "property", basisPoints: 3000 }]),
      currency: "ILS",
    });

    const property = result.lines.find((line) => line.category === "property");
    expect(property?.actual).toEqual(ils(0));
    expect(property?.stance).toBe("under");
    expect(property?.accountCount).toBe(0);
  });
});

// --- the appreciation assumption ---------------------------------------------

describe("the appreciation assumption", () => {
  it("is whole basis points a year, and nothing else", () => {
    expect(buildAppreciationAssumption(300).annualBasisPoints).toBe(300);
    expect(buildAppreciationAssumption(0).annualBasisPoints).toBe(0);
    expect(() => buildAppreciationAssumption(3.5)).toThrow(InvalidAppreciationError);
    expect(() => buildAppreciationAssumption(-100)).toThrow(InvalidAppreciationError);
  });

  it("compounds exactly, with no float anywhere in the factor", () => {
    expect(growthFactor({ annualBasisPoints: 300 }, 0)).toBe("1");
    expect(growthFactor({ annualBasisPoints: 300 }, 1)).toBe("1.0300");
    // 1.03 squared is 1.0609 exactly; a double would make it 1.0608999999999999.
    expect(growthFactor({ annualBasisPoints: 300 }, 2)).toBe("1.06090000");
    expect(growthFactor({ annualBasisPoints: 0 }, 5)).toBe("1.00000000000000000000");
  });

  it("applies only to cost-held assets, and grows each from its own opening date", () => {
    const snapshot = fullSnapshot("s1", d(2025, 12, 31), 3.65);
    const range = appreciationRange({
      readings: readings(snapshot),
      assumption: buildAppreciationAssumption(300),
      asOf: d(2025, 12, 31),
      currency: "ILS",
    });

    expect(range.recorded).toEqual(ils(918_300));
    // Only CGM 2 is held at cost; everything else is a measurement and is untouched.
    expect(range.assets.map((asset) => asset.account.id)).toEqual(["cgm2"]);
    expect(range.excludingCostHeld).toEqual(ils(619_000));
    expect(range.costHeld).toEqual(ils(299_300));

    // Opened 2023-06-15, read 2025-12-31: two completed years, 1.0609.
    expect(range.assets[0]?.years).toBe(2);
    expect(range.assets[0]?.factor).toBe("1.06090000");
    expect(range.appreciatedCostHeld).toEqual(ils(317_527.37));
    expect(range.withAssumption).toEqual(ils(936_527.37));
    expect(range.uplift).toEqual(ils(18_227.37));
  });

  it("grows nothing at all under an assumption of zero", () => {
    const snapshot = fullSnapshot("s1", d(2025, 12, 31), 3.65);
    const range = appreciationRange({
      readings: readings(snapshot),
      assumption: buildAppreciationAssumption(0),
      asOf: d(2025, 12, 31),
      currency: "ILS",
    });

    expect(range.withAssumption).toEqual(range.recorded);
    expect(range.uplift).toEqual(ils(0));
  });

  it("grows an asset held under a year by nothing rather than by a fraction", () => {
    const snapshot = fullSnapshot("s1", d(2024, 5, 31), 3.65);
    const range = appreciationRange({
      readings: readings(snapshot),
      assumption: buildAppreciationAssumption(300),
      asOf: d(2024, 5, 31),
      currency: "ILS",
    });

    // Opened 2023-06-15; the day before the anniversary is still the year before it.
    expect(range.assets[0]?.years).toBe(0);
    expect(range.withAssumption).toEqual(range.recorded);
  });

  it("carries the assumption on the result, so a grown figure cannot be printed as a measurement", () => {
    const snapshot = fullSnapshot("s1", d(2025, 12, 31), 3.65);
    const range = appreciationRange({
      readings: readings(snapshot),
      assumption: buildAppreciationAssumption(450),
      asOf: d(2025, 12, 31),
      currency: "ILS",
    });

    expect(range.assumption.annualBasisPoints).toBe(450);
    expect(range.assets[0]?.factor).toBe("1.09202500");
  });
});

// --- concentration ------------------------------------------------------------

describe("concentration", () => {
  const snapshot = fullSnapshot("s1", d(2025, 1, 31), 3.65);

  it("states the Apple RSU share of total wealth", () => {
    const concentration = concentrationOf({
      readings: readings(snapshot),
      accountIds: ["rsu"],
      currency: "ILS",
    });

    expect(concentration.holding).toEqual(ils(73_000));
    expect(concentration.total).toEqual(ils(918_300));
    expect(concentration.share).toBeCloseTo(73_000 / 918_300, 10);
  });

  it("reports a named account the snapshot does not hold rather than counting it as nothing", () => {
    const concentration = concentrationOf({
      readings: readings(snapshot),
      accountIds: ["rsu", "sold-last-year"],
      currency: "ILS",
    });

    expect(concentration.missing).toEqual(["sold-last-year"]);
    expect(concentration.holding).toEqual(ils(73_000));
  });

  it("has no share when no account is named, and none when there is no wealth", () => {
    expect(
      concentrationOf({ readings: readings(snapshot), accountIds: [], currency: "ILS" }).share,
    ).toBe(0);
    expect(concentrationOf({ readings: [], accountIds: ["rsu"], currency: "ILS" }).share).toBeNull();
  });
});
