import { describe, expect, it } from "vitest";

import { type Money, exchangeRate, money } from "@/domain/money/money";
import { calendarDate, dateKey } from "@/domain/time/calendar-date";

import {
  type Account,
  type Snapshot,
  InvalidAccountError,
  MalformedSnapshotError,
  MissingSnapshotRateError,
  SnapshotOrderError,
  UnknownAccountError,
  accountsMissingFrom,
  accountsOpenOn,
  addMissingLines,
  buildAccount,
  buildSnapshot,
  completenessOf,
  convertWithin,
  convertedReadings,
  findLine,
  isOpenOn,
  isUnmeasured,
  previousSnapshot,
  rateWithin,
  readingsIn,
  requireAccount,
  restate,
  rollupBy,
  seedSnapshot,
  snapshotReadings,
  snapshotTotal,
} from "./snapshot";

const ils = (major: number): Money => money(Math.round(major * 100), "ILS");
const usd = (major: number): Money => money(Math.round(major * 100), "USD");
const d = (year: number, month: number, day: number) => calendarDate(year, month, day);

const USD_ILS = exchangeRate("USD", "ILS", 3.65);

/**
 * Four accounts across both People and all four קטגוריה buckets, two currencies
 * and all three Value Bases — the shape the real household has.
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
    buildAccount("rsu", {
      personId: "yuval",
      name: "Apple RSU",
      currency: "USD",
      valueBasis: "market",
      category: "investments",
      assetKind: "RSU",
      openedOn: d(2020, 1, 1),
    }),
    buildAccount("pension", {
      personId: "eden",
      name: "פנסיה מנורה",
      currency: "ILS",
      valueBasis: "estimate",
      category: "pension",
      assetKind: "פנסיה",
      openedOn: d(2020, 1, 1),
    }),
    buildAccount("cgm2", {
      personId: "yuval",
      name: "CGM 2",
      currency: "USD",
      valueBasis: "cost",
      category: "property",
      assetKind: "פרוייקט נדלן",
      openedOn: d(2024, 6, 1),
    }),
  ];
}

/** A first snapshot with every figure stated by hand. */
function firstSnapshot(): Snapshot {
  const seeded = seedSnapshot({
    id: "s1",
    takenOn: d(2025, 1, 31),
    rates: [USD_ILS],
    accounts: accounts(),
    previous: null,
  });

  return restate(seeded, [
    { accountId: "current", balance: ils(50_000), measured: true },
    { accountId: "rsu", balance: usd(100_000), measured: true },
    { accountId: "pension", balance: ils(450_376), measured: true },
    { accountId: "cgm2", balance: usd(82_000), measured: true },
  ]);
}

// --- accounts ----------------------------------------------------------------

describe("an account", () => {
  it("carries a person, a native currency, a Value Basis, a קטגוריה and a סוג נכס", () => {
    const account = requireAccount(accounts(), "rsu");

    expect(account.personId).toBe("yuval");
    expect(account.currency).toBe("USD");
    expect(account.valueBasis).toBe("market");
    expect(account.category).toBe("investments");
    expect(account.assetKind).toBe("RSU");
  });

  it("refuses a Value Basis that is not one of the three", () => {
    expect(() =>
      buildAccount("x", {
        personId: "yuval",
        name: "חשבון",
        currency: "ILS",
        valueBasis: "guess" as never,
        category: "liquid",
        assetKind: "עובר ושב",
        openedOn: d(2020, 1, 1),
      }),
    ).toThrow(InvalidAccountError);
  });

  it("refuses a missing Value Basis outright — there is no default", () => {
    expect(() =>
      buildAccount("x", {
        personId: "yuval",
        name: "חשבון",
        currency: "ILS",
        valueBasis: undefined as never,
        category: "liquid",
        assetKind: "עובר ושב",
        openedOn: d(2020, 1, 1),
      }),
    ).toThrow(InvalidAccountError);
  });

  it("refuses an empty name and an empty סוג נכס", () => {
    const base = {
      personId: "yuval",
      currency: "ILS" as const,
      valueBasis: "market" as const,
      category: "liquid" as const,
      openedOn: d(2020, 1, 1),
    };
    expect(() => buildAccount("x", { ...base, name: "   ", assetKind: "עובר ושב" })).toThrow(
      InvalidAccountError,
    );
    expect(() => buildAccount("x", { ...base, name: "חשבון", assetKind: " " })).toThrow(InvalidAccountError);
  });

  it("refuses a קטגוריה outside the rollup buckets", () => {
    expect(() =>
      buildAccount("x", {
        personId: "yuval",
        name: "חשבון",
        currency: "ILS",
        valueBasis: "market",
        category: "crypto" as never,
        assetKind: "עובר ושב",
        openedOn: d(2020, 1, 1),
      }),
    ).toThrow(InvalidAccountError);
  });

  it("is open on its lifespan, inclusive of the closing day", () => {
    const account = buildAccount("closed", {
      personId: "eden",
      name: "חשבון ישן",
      currency: "ILS",
      valueBasis: "market",
      category: "liquid",
      assetKind: "עובר ושב",
      openedOn: d(2020, 1, 1),
      closedOn: d(2025, 3, 31),
    });

    expect(isOpenOn(account, d(2019, 12, 31))).toBe(false);
    expect(isOpenOn(account, d(2020, 1, 1))).toBe(true);
    expect(isOpenOn(account, d(2025, 3, 31))).toBe(true);
    expect(isOpenOn(account, d(2025, 4, 1))).toBe(false);
  });

  it("refuses a closing that precedes the opening", () => {
    expect(() =>
      buildAccount("x", {
        personId: "yuval",
        name: "חשבון",
        currency: "ILS",
        valueBasis: "market",
        category: "liquid",
        assetKind: "עובר ושב",
        openedOn: d(2025, 1, 1),
        closedOn: d(2024, 12, 31),
      }),
    ).toThrow(InvalidAccountError);
  });

  it("names the account when one is asked for and does not exist", () => {
    expect(() => requireAccount(accounts(), "nope")).toThrow(UnknownAccountError);
  });
});

// --- taking a snapshot -------------------------------------------------------

describe("seeding a snapshot", () => {
  it("covers every account open on the date and nothing else", () => {
    const seeded = seedSnapshot({
      id: "s0",
      takenOn: d(2024, 1, 31),
      rates: [USD_ILS],
      accounts: accounts(),
      previous: null,
    });

    // CGM 2 opened in June 2024, so a January snapshot does not hold it.
    expect(seeded.lines.map((line) => line.accountId).sort()).toEqual(["current", "pension", "rsu"]);
    expect(accountsOpenOn(accounts(), d(2024, 1, 31)).map((account) => account.id).sort()).toEqual([
      "current",
      "pension",
      "rsu",
    ]);
  });

  it("gives an account nobody has ever valued a placeholder, not a measurement", () => {
    const seeded = seedSnapshot({
      id: "s0",
      takenOn: d(2025, 1, 31),
      rates: [USD_ILS],
      accounts: accounts(),
      previous: null,
    });

    const line = findLine(seeded, "pension");
    expect(line?.balance).toEqual(money(0, "ILS"));
    expect(line?.source).toBe("carried");
    expect(line?.measuredOn).toBeNull();
    expect(isUnmeasured(line!)).toBe(true);
  });

  it("seeds each row from the previous snapshot's value", () => {
    const next = seedSnapshot({
      id: "s2",
      takenOn: d(2025, 2, 28),
      rates: [USD_ILS],
      accounts: accounts(),
      previous: firstSnapshot(),
    });

    expect(findLine(next, "pension")?.balance).toEqual(ils(450_376));
    expect(findLine(next, "rsu")?.balance).toEqual(usd(100_000));
    expect(next.lines).toHaveLength(4);
  });

  it("imposes no cadence — a day later or a year later are both acceptable", () => {
    const previous = firstSnapshot();
    const takenOn = [d(2025, 2, 1), d(2025, 7, 14), d(2026, 1, 31)];

    for (const date of takenOn) {
      const next = seedSnapshot({ id: "s", takenOn: date, rates: [USD_ILS], accounts: accounts(), previous });
      expect(dateKey(next.takenOn)).toBe(dateKey(date));
    }
  });

  it("refuses a snapshot that does not follow the previous one", () => {
    const previous = firstSnapshot();
    expect(() =>
      seedSnapshot({ id: "s", takenOn: d(2024, 12, 31), rates: [USD_ILS], accounts: accounts(), previous }),
    ).toThrow(SnapshotOrderError);
    expect(() =>
      seedSnapshot({ id: "s", takenOn: previous.takenOn, rates: [USD_ILS], accounts: accounts(), previous }),
    ).toThrow(SnapshotOrderError);
  });

  it("finds the snapshot a new one should seed from", () => {
    const january = firstSnapshot();
    const march = seedSnapshot({
      id: "s2",
      takenOn: d(2025, 3, 31),
      rates: [USD_ILS],
      accounts: accounts(),
      previous: january,
    });

    expect(previousSnapshot([march, january], d(2025, 6, 1))?.id).toBe("s2");
    expect(previousSnapshot([march, january], d(2025, 2, 1))?.id).toBe("s1");
    expect(previousSnapshot([march, january], d(2024, 1, 1))).toBeNull();
  });
});

// --- entered or carried ------------------------------------------------------

describe("entered or carried", () => {
  it("records a changed figure as entered, on the snapshot's own date", () => {
    const next = restate(
      seedSnapshot({
        id: "s2",
        takenOn: d(2025, 2, 28),
        rates: [USD_ILS],
        accounts: accounts(),
        previous: firstSnapshot(),
      }),
      [{ accountId: "current", balance: ils(61_400), measured: false }],
    );

    const line = findLine(next, "current");
    expect(line?.balance).toEqual(ils(61_400));
    expect(line?.source).toBe("entered");
    expect(line?.measuredOn).toEqual(d(2025, 2, 28));
  });

  it("keeps an untouched figure carried, pointing at the day it was actually measured", () => {
    const next = restate(
      seedSnapshot({
        id: "s2",
        takenOn: d(2025, 2, 28),
        rates: [USD_ILS],
        accounts: accounts(),
        previous: firstSnapshot(),
      }),
      // Resubmitted unchanged and unconfirmed: re-sending a form is not a measurement.
      [{ accountId: "pension", balance: ils(450_376), measured: false }],
    );

    const line = findLine(next, "pension");
    expect(line?.source).toBe("carried");
    expect(line?.measuredOn).toEqual(d(2025, 1, 31));
  });

  it("records an unchanged figure as entered when it was explicitly confirmed", () => {
    const next = restate(
      seedSnapshot({
        id: "s2",
        takenOn: d(2025, 2, 28),
        rates: [USD_ILS],
        accounts: accounts(),
        previous: firstSnapshot(),
      }),
      [{ accountId: "pension", balance: ils(450_376), measured: true }],
    );

    const line = findLine(next, "pension");
    expect(line?.source).toBe("entered");
    expect(line?.measuredOn).toEqual(d(2025, 2, 28));
  });

  it("keeps a stale figure stale across several snapshots", () => {
    let snapshot = firstSnapshot();
    for (const date of [d(2025, 2, 28), d(2025, 3, 31), d(2025, 4, 30)]) {
      snapshot = seedSnapshot({
        id: `s-${dateKey(date)}`,
        takenOn: date,
        rates: [USD_ILS],
        accounts: accounts(),
        previous: snapshot,
      });
    }

    // Three months on, the pension still points at the January day it was measured.
    expect(findLine(snapshot, "pension")?.measuredOn).toEqual(d(2025, 1, 31));
    expect(findLine(snapshot, "pension")?.source).toBe("carried");
  });

  it("counts what was measured against what was carried", () => {
    const next = restate(
      seedSnapshot({
        id: "s2",
        takenOn: d(2025, 2, 28),
        rates: [USD_ILS],
        accounts: accounts(),
        previous: firstSnapshot(),
      }),
      [{ accountId: "current", balance: ils(61_400), measured: false }],
    );

    expect(completenessOf(next)).toEqual({ entered: 1, carried: 3, unmeasured: 0, total: 4 });
    expect(completenessOf(seedSnapshot({
      id: "s0",
      takenOn: d(2025, 1, 31),
      rates: [USD_ILS],
      accounts: accounts(),
      previous: null,
    }))).toEqual({ entered: 0, carried: 4, unmeasured: 4, total: 4 });
  });

  it("refuses a figure in a currency the account is not held in", () => {
    expect(() => restate(firstSnapshot(), [{ accountId: "rsu", balance: ils(365_000), measured: true }])).toThrow(
      MalformedSnapshotError,
    );
  });

  it("refuses a line whose entered flag and measurement date disagree", () => {
    expect(() =>
      buildSnapshot({
        id: "bad",
        takenOn: d(2025, 2, 28),
        rates: [USD_ILS],
        lines: [
          { accountId: "current", balance: ils(1), source: "entered", measuredOn: d(2025, 1, 31) },
        ],
      }),
    ).toThrow(MalformedSnapshotError);

    expect(() =>
      buildSnapshot({
        id: "bad",
        takenOn: d(2025, 2, 28),
        rates: [USD_ILS],
        lines: [
          { accountId: "current", balance: ils(1), source: "carried", measuredOn: d(2025, 2, 28) },
        ],
      }),
    ).toThrow(MalformedSnapshotError);
  });

  it("refuses the same account twice in one snapshot", () => {
    expect(() =>
      buildSnapshot({
        id: "bad",
        takenOn: d(2025, 2, 28),
        rates: [USD_ILS],
        lines: [
          { accountId: "current", balance: ils(1), source: "carried", measuredOn: null },
          { accountId: "current", balance: ils(2), source: "carried", measuredOn: null },
        ],
      }),
    ).toThrow(MalformedSnapshotError);
  });
});

// --- native currency and the snapshot's own rate -----------------------------

describe("currency inside a snapshot", () => {
  it("holds balances in the account's own currency, unconverted", () => {
    const snapshot = firstSnapshot();
    expect(findLine(snapshot, "rsu")?.balance).toEqual(usd(100_000));
    expect(findLine(snapshot, "current")?.balance).toEqual(ils(50_000));
  });

  it("converts at its own rate", () => {
    const snapshot = firstSnapshot();
    expect(convertWithin(snapshot, usd(100_000), "ILS")).toEqual(ils(365_000));
    expect(rateWithin(snapshot, "USD", "ILS").rate).toBe(3.65);
  });

  it("converts a currency to itself without needing a stored rate", () => {
    const snapshot = buildSnapshot({ id: "s", takenOn: d(2025, 1, 31), rates: [], lines: [] });
    expect(convertWithin(snapshot, ils(1_234.56), "ILS")).toEqual(ils(1_234.56));
  });

  it("refuses to convert a pair it does not carry, rather than reaching for another rate", () => {
    const snapshot = buildSnapshot({ id: "s", takenOn: d(2025, 1, 31), rates: [], lines: [] });
    expect(() => convertWithin(snapshot, usd(1), "ILS")).toThrow(MissingSnapshotRateError);
  });

  it("refuses more than one rate for a pair", () => {
    expect(() =>
      buildSnapshot({
        id: "s",
        takenOn: d(2025, 1, 31),
        rates: [USD_ILS, exchangeRate("USD", "ILS", 3.7)],
        lines: [],
      }),
    ).toThrow(MalformedSnapshotError);
  });

  it("uses one rate for every dollar figure in the snapshot", () => {
    const snapshot = firstSnapshot();
    const dollarReadings = convertedReadings(snapshot, accounts(), "ILS").filter(
      (reading) => reading.account.currency === "USD",
    );

    expect(dollarReadings.map((reading) => reading.converted)).toEqual([
      ils(365_000), // RSU, $100,000
      ils(299_300), // CGM 2, $82,000
    ]);
  });

  it("reads every account in its own currency without needing a rate at all", () => {
    const rateless = buildSnapshot({
      id: "s",
      takenOn: firstSnapshot().takenOn,
      rates: [],
      lines: firstSnapshot().lines,
    });

    expect(snapshotReadings(rateless, accounts()).map((reading) => reading.native)).toEqual([
      ils(50_000),
      usd(100_000),
      ils(450_376),
      usd(82_000),
    ]);
    expect(() => snapshotTotal(rateless, accounts(), "ILS")).toThrow(MissingSnapshotRateError);
  });

  it("re-reads a historical snapshot at the rate it was taken with, not a later one", () => {
    const january = firstSnapshot();
    const july = restate(
      seedSnapshot({
        id: "s2",
        takenOn: d(2025, 7, 31),
        rates: [exchangeRate("USD", "ILS", 3.2)],
        accounts: accounts(),
        previous: january,
      }),
      [{ accountId: "rsu", balance: usd(100_000), measured: true }],
    );

    // The same $100,000, read in each snapshot's own terms. Neither moves the other.
    expect(convertWithin(january, usd(100_000), "ILS")).toEqual(ils(365_000));
    expect(convertWithin(july, usd(100_000), "ILS")).toEqual(ils(320_000));
    expect(snapshotTotal(january, accounts(), "ILS")).toEqual(ils(1_164_676));
  });
});

// --- completeness after a late account definition ----------------------------

describe("an account defined after a snapshot was taken", () => {
  it("is reported as missing rather than silently absent", () => {
    const snapshot = firstSnapshot();
    const withNewAccount = [
      ...accounts(),
      buildAccount("kaspit", {
        personId: "eden",
        name: "קרן כספית",
        currency: "ILS",
        valueBasis: "market",
        category: "liquid",
        assetKind: "קרן כספית",
        openedOn: d(2024, 1, 1),
      }),
    ];

    expect(accountsMissingFrom(snapshot, withNewAccount).map((account) => account.id)).toEqual(["kaspit"]);

    const completed = addMissingLines(snapshot, withNewAccount);
    expect(accountsMissingFrom(completed, withNewAccount)).toEqual([]);
    expect(findLine(completed, "kaspit")?.measuredOn).toBeNull();
  });

  it("is not reported when it was not open on the snapshot's date", () => {
    const snapshot = firstSnapshot();
    const withLaterAccount = [
      ...accounts(),
      buildAccount("later", {
        personId: "eden",
        name: "חשבון חדש",
        currency: "ILS",
        valueBasis: "market",
        category: "liquid",
        assetKind: "עובר ושב",
        openedOn: d(2025, 6, 1),
      }),
    ];

    expect(accountsMissingFrom(snapshot, withLaterAccount)).toEqual([]);
  });
});

// --- rollups -----------------------------------------------------------------

describe("rollups", () => {
  it("rolls up by קטגוריה — נזילות, השקעות, פנסיה — in reading order", () => {
    const rollup = rollupBy(firstSnapshot(), accounts(), "ILS", "category");

    expect(rollup).toEqual([
      { key: "liquid", total: ils(50_000), accountCount: 1, carriedCount: 0 },
      { key: "investments", total: ils(365_000), accountCount: 1, carriedCount: 0 },
      { key: "pension", total: ils(450_376), accountCount: 1, carriedCount: 0 },
      { key: "property", total: ils(299_300), accountCount: 1, carriedCount: 0 },
    ]);
  });

  it("rolls up by סוג נכס", () => {
    const rollup = rollupBy(firstSnapshot(), accounts(), "ILS", "assetKind");
    expect(rollup.map((line) => line.key).sort()).toEqual(
      ["RSU", "עובר ושב", "פנסיה", "פרוייקט נדלן"].sort(),
    );
  });

  it("sums accounts that share a bucket, across currencies, at the snapshot's rate", () => {
    const withSecondLiquid = [
      ...accounts(),
      buildAccount("dollar-cash", {
        personId: "eden",
        name: "Dollar cash",
        currency: "USD",
        valueBasis: "market",
        category: "liquid",
        assetKind: "עובר ושב",
        openedOn: d(2020, 1, 1),
      }),
    ];

    const snapshot = restate(
      seedSnapshot({
        id: "s1",
        takenOn: d(2025, 1, 31),
        rates: [USD_ILS],
        accounts: withSecondLiquid,
        previous: null,
      }),
      [
        { accountId: "current", balance: ils(50_000), measured: true },
        { accountId: "dollar-cash", balance: usd(10_000), measured: true },
      ],
    );

    const liquid = rollupBy(snapshot, withSecondLiquid, "ILS", "category").find((line) => line.key === "liquid");
    expect(liquid?.total).toEqual(ils(86_500)); // 50,000 + 10,000 × 3.65
    expect(liquid?.accountCount).toBe(2);
  });

  it("states how many figures in a bucket were carried rather than measured", () => {
    const next = restate(
      seedSnapshot({
        id: "s2",
        takenOn: d(2025, 2, 28),
        rates: [USD_ILS],
        accounts: accounts(),
        previous: firstSnapshot(),
      }),
      [{ accountId: "current", balance: ils(61_400), measured: false }],
    );

    const byCategory = rollupBy(next, accounts(), "ILS", "category");
    expect(byCategory.find((line) => line.key === "liquid")?.carriedCount).toBe(0);
    expect(byCategory.find((line) => line.key === "pension")?.carriedCount).toBe(1);
  });

  it("opens a bucket onto the accounts that produced it", () => {
    const snapshot = firstSnapshot();
    const readings = readingsIn(convertedReadings(snapshot, accounts(), "ILS"), "category", "pension");

    expect(readings.map((reading) => reading.account.name)).toEqual(["פנסיה מנורה"]);
    expect(readings[0]?.native).toEqual(ils(450_376));
  });

  it("drills down to exactly the figures the bucket total was computed from", () => {
    const snapshot = firstSnapshot();
    const readings = convertedReadings(snapshot, accounts(), "ILS");

    for (const bucket of rollupBy(snapshot, accounts(), "ILS", "category")) {
      const inside = readingsIn(readings, "category", bucket.key);
      const summed = inside.reduce((running, reading) => running + reading.converted.minorUnits, 0);
      expect(summed).toBe(bucket.total.minorUnits);
      expect(inside).toHaveLength(bucket.accountCount);
    }
  });

  it("adds up to the snapshot total", () => {
    const snapshot = firstSnapshot();
    const byCategory = rollupBy(snapshot, accounts(), "ILS", "category");
    const summed = byCategory.reduce((running, line) => running + line.total.minorUnits, 0);
    expect(summed).toBe(snapshotTotal(snapshot, accounts(), "ILS").minorUnits);
  });
});
