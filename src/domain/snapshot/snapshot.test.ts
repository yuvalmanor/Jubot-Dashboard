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
  basisSplitOf,
  buildAccount,
  buildSnapshot,
  canConvertWithin,
  compareSnapshots,
  comparisonTotals,
  completenessOf,
  convertWithin,
  convertedReadings,
  currencyTable,
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

// --- the שקל and דולר tables -------------------------------------------------

describe("the שקל and דולר tables", () => {
  it("are the same function with a different currency, over the same lines", () => {
    const snapshot = firstSnapshot();
    const shekels = currencyTable(snapshot, accounts(), "ILS");
    const dollars = currencyTable(snapshot, accounts(), "USD");

    expect(shekels.rows.map((row) => row.account.id)).toEqual(["current", "rsu", "pension", "cgm2"]);
    expect(dollars.rows.map((row) => row.account.id)).toEqual(shekels.rows.map((row) => row.account.id));
  });

  it("reads the same account identically in both — one figure, two readings", () => {
    const snapshot = firstSnapshot();
    const shekels = currencyTable(snapshot, accounts(), "ILS");
    const dollars = currencyTable(snapshot, accounts(), "USD");

    for (const [index, shekelRow] of shekels.rows.entries()) {
      const dollarRow = dollars.rows[index]!;
      expect(dollarRow.account.id).toBe(shekelRow.account.id);
      // The recorded fact is one figure in one currency; the tables restate it.
      expect(dollarRow.native).toEqual(shekelRow.native);
      expect(shekelRow.converted).toEqual(convertWithin(snapshot, dollarRow.native, "ILS"));
      expect(dollarRow.converted).toEqual(convertWithin(snapshot, shekelRow.native, "USD"));
    }
  });

  it("cannot hold one figure for an account in one table and another in the other", () => {
    // The sheet's pension read 519,088 in one table and 450,376 in the other,
    // because each table was maintained by hand. Both of these are derived.
    const restated = restate(firstSnapshot(), [
      { accountId: "pension", balance: ils(519_088), measured: true },
    ]);
    const pensionIn = (currency: "ILS" | "USD") =>
      currencyTable(restated, accounts(), currency).rows.find((row) => row.account.id === "pension")!;

    expect(pensionIn("ILS").native).toEqual(ils(519_088));
    expect(pensionIn("USD").native).toEqual(ils(519_088));
    expect(pensionIn("ILS").converted).toEqual(ils(519_088));
    expect(pensionIn("USD").converted).toEqual(usd(142_215.89)); // 519,088 ÷ 3.65
  });

  it("reads the דולר table backwards through the snapshot's one rate", () => {
    const dollars = currencyTable(firstSnapshot(), accounts(), "USD");

    expect(dollars.rows.map((row) => row.converted)).toEqual([
      usd(13_698.63), // 50,000₪ ÷ 3.65
      usd(100_000), // held in dollars; nothing to convert
      usd(123_390.68), // 450,376₪ ÷ 3.65
      usd(82_000),
    ]);
    expect(dollars.total).toEqual(usd(319_089.31));
  });

  it("can read a pair the snapshot quotes the other way round, and nothing else", () => {
    const rateless = buildSnapshot({
      id: "s",
      takenOn: firstSnapshot().takenOn,
      rates: [],
      lines: firstSnapshot().lines,
    });

    expect(canConvertWithin(firstSnapshot(), "ILS", "USD")).toBe(true);
    expect(canConvertWithin(rateless, "ILS", "USD")).toBe(false);
    expect(() => currencyTable(rateless, accounts(), "USD")).toThrow(MissingSnapshotRateError);
  });

  it("keeps the two tables in step through a restatement, because neither is stored", () => {
    const before = currencyTable(firstSnapshot(), accounts(), "ILS").total;
    const after = restate(firstSnapshot(), [
      { accountId: "current", balance: ils(61_400), measured: true },
    ]);

    expect(before).toEqual(ils(1_164_676));
    expect(currencyTable(after, accounts(), "ILS").total).toEqual(ils(1_176_076));
    // The four rows, each read at the snapshot's own 3.65 and then added up.
    expect(currencyTable(after, accounts(), "USD").total).toEqual(usd(322_212.6));
  });
});

// --- what a total is made of -------------------------------------------------

describe("a total states how much of it is held at cost", () => {
  it("splits the whole table by Value Basis", () => {
    const table = currencyTable(firstSnapshot(), accounts(), "ILS");

    expect(table.total).toEqual(ils(1_164_676));
    expect(table.basis.total).toEqual(table.total);
    expect(table.basis.byBasis).toEqual({
      market: ils(415_000), // 50,000 + $100,000 at 3.65
      cost: ils(299_300), // CGM 2, held at cost per ADR 0003
      estimate: ils(450_376), // the pension, somebody's judgement
    });
    expect(table.basis.costShare).toBeCloseTo(0.257, 3);
  });

  it("splits a bucket the same way, from the readings its total was computed from", () => {
    const readings = convertedReadings(firstSnapshot(), accounts(), "ILS");

    const property = basisSplitOf(readingsIn(readings, "category", "property"), "ILS");
    expect(property.total).toEqual(ils(299_300));
    expect(property.byBasis.cost).toEqual(ils(299_300));
    expect(property.costShare).toBe(1);

    const liquid = basisSplitOf(readingsIn(readings, "category", "liquid"), "ILS");
    expect(liquid.byBasis.market).toEqual(ils(50_000));
    expect(liquid.costShare).toBe(0);
  });

  it("has no share to state when there is no total to be a share of", () => {
    const empty = buildSnapshot({ id: "s", takenOn: d(2025, 1, 31), rates: [USD_ILS], lines: [] });
    const table = currencyTable(empty, accounts(), "ILS");

    expect(table.total).toEqual(ils(0));
    expect(table.basis.costShare).toBeNull();
  });
});

// --- comparing two snapshots -------------------------------------------------

/** July, six months on, at a rate that has moved: two figures restated, two left carrying. */
function julySnapshot(previous: Snapshot = firstSnapshot()): Snapshot {
  return restate(
    seedSnapshot({
      id: "s-july",
      takenOn: d(2025, 7, 31),
      rates: [exchangeRate("USD", "ILS", 3.2)],
      accounts: accounts(),
      previous,
    }),
    [
      { accountId: "current", balance: ils(61_400), measured: true },
      { accountId: "rsu", balance: usd(112_500), measured: true },
    ],
  );
}

describe("comparing two snapshots", () => {
  it("shows the difference per account, in the account's own currency", () => {
    const comparison = compareSnapshots({
      earlier: firstSnapshot(),
      later: julySnapshot(),
      accounts: accounts(),
    });

    const changeOf = (id: string) => comparison.rows.find((row) => row.account.id === id)?.change;
    expect(changeOf("current")).toEqual(ils(11_400));
    expect(changeOf("rsu")).toEqual(usd(12_500));
    expect(changeOf("pension")).toEqual(ils(0));
    expect(changeOf("cgm2")).toEqual(usd(0));
  });

  it("does not care which way round the two are given", () => {
    const january = firstSnapshot();
    const july = julySnapshot();

    const backwards = compareSnapshots({ earlier: july, later: january, accounts: accounts() });
    expect(backwards.earlier.id).toBe("s1");
    expect(backwards.later.id).toBe("s-july");
    expect(backwards.rows.find((row) => row.account.id === "current")?.change).toEqual(ils(11_400));
  });

  it("distinguishes a row that was measured from one that was carried forward", () => {
    const comparison = compareSnapshots({
      earlier: firstSnapshot(),
      later: julySnapshot(),
      accounts: accounts(),
    });

    const kindOf = (id: string) => comparison.rows.find((row) => row.account.id === id)?.kind;
    expect(kindOf("current")).toBe("measured");
    expect(kindOf("rsu")).toBe("measured");
    // Nobody looked at these in July; their figures came forward from January.
    expect(kindOf("pension")).toBe("carried");
    expect(kindOf("cgm2")).toBe("carried");

    expect(comparison.counts).toEqual({
      measured: 2,
      carried: 2,
      unmeasured: 0,
      opened: 0,
      closed: 0,
      changed: 2,
    });
  });

  it("reports a figure that changed while carrying, and says when it was last measured", () => {
    // April restates the pension; July carries April's figure forward. Against
    // January the figure has moved, but nobody measured it in July.
    const april = restate(
      seedSnapshot({
        id: "s-april",
        takenOn: d(2025, 4, 30),
        rates: [USD_ILS],
        accounts: accounts(),
        previous: firstSnapshot(),
      }),
      [{ accountId: "pension", balance: ils(470_000), measured: true }],
    );

    const comparison = compareSnapshots({
      earlier: firstSnapshot(),
      later: julySnapshot(april),
      accounts: accounts(),
    });
    const pension = comparison.rows.find((row) => row.account.id === "pension")!;

    expect(pension.kind).toBe("carried");
    expect(pension.changed).toBe(true);
    expect(pension.change).toEqual(ils(19_624));
    expect(pension.after?.measuredOn).toEqual(d(2025, 4, 30));
  });

  it("reports an account that only one side holds rather than a change against nothing", () => {
    const withLater = [
      ...accounts(),
      buildAccount("kaspit", {
        personId: "eden",
        name: "קרן כספית",
        currency: "ILS",
        valueBasis: "market",
        category: "liquid",
        assetKind: "קרן כספית",
        openedOn: d(2025, 6, 1),
      }),
    ];
    const july = restate(
      seedSnapshot({
        id: "s-july",
        takenOn: d(2025, 7, 31),
        rates: [USD_ILS],
        accounts: withLater,
        previous: firstSnapshot(),
      }),
      [{ accountId: "kaspit", balance: ils(120_000), measured: true }],
    );

    const kaspit = compareSnapshots({
      earlier: firstSnapshot(),
      later: july,
      accounts: withLater,
    }).rows.find((row) => row.account.id === "kaspit")!;

    expect(kaspit.kind).toBe("opened");
    expect(kaspit.before).toBeNull();
    expect(kaspit.change).toBeNull();
    expect(kaspit.changed).toBe(false);
  });

  it("reports an account that closed between the two", () => {
    const withClosing = [
      ...accounts(),
      buildAccount("old", {
        personId: "eden",
        name: "חשבון ישן",
        currency: "ILS",
        valueBasis: "market",
        category: "liquid",
        assetKind: "עובר ושב",
        openedOn: d(2020, 1, 1),
        closedOn: d(2025, 3, 31),
      }),
    ];
    const january = restate(
      seedSnapshot({
        id: "s1",
        takenOn: d(2025, 1, 31),
        rates: [USD_ILS],
        accounts: withClosing,
        previous: null,
      }),
      [{ accountId: "old", balance: ils(8_000), measured: true }],
    );
    const july = seedSnapshot({
      id: "s-july",
      takenOn: d(2025, 7, 31),
      rates: [USD_ILS],
      accounts: withClosing,
      previous: january,
    });

    const old = compareSnapshots({ earlier: january, later: july, accounts: withClosing }).rows.find(
      (row) => row.account.id === "old",
    )!;

    expect(old.kind).toBe("closed");
    expect(old.before?.balance).toEqual(ils(8_000));
    expect(old.after).toBeNull();
    expect(old.change).toBeNull();
  });

  it("refuses to subtract a placeholder nobody ever measured", () => {
    const january = seedSnapshot({
      id: "s1",
      takenOn: d(2025, 1, 31),
      rates: [USD_ILS],
      accounts: accounts(),
      previous: null,
    });
    const july = restate(
      seedSnapshot({
        id: "s-july",
        takenOn: d(2025, 7, 31),
        rates: [USD_ILS],
        accounts: accounts(),
        previous: january,
      }),
      [{ accountId: "current", balance: ils(50_000), measured: true }],
    );

    const current = compareSnapshots({ earlier: january, later: july, accounts: accounts() }).rows.find(
      (row) => row.account.id === "current",
    )!;

    // January's zero was the absence of a measurement, not a balance of nothing.
    expect(current.kind).toBe("unmeasured");
    expect(current.change).toBeNull();
    expect(current.changed).toBe(false);
  });

  it("totals each side at its own snapshot's rate, and says when the rate moved", () => {
    const comparison = compareSnapshots({
      earlier: firstSnapshot(),
      later: julySnapshot(),
      accounts: accounts(),
    });
    const totals = comparisonTotals(comparison, accounts(), "ILS");

    expect(totals.before).toEqual(ils(1_164_676)); // at 3.65
    expect(totals.after).toEqual(ils(1_134_176)); // at 3.20
    expect(totals.change).toEqual(ils(-30_500));
    expect(totals.rateChanged).toBe(true);
  });

  it("says the rate held when both snapshots carry the same one", () => {
    const july = restate(
      seedSnapshot({
        id: "s-july",
        takenOn: d(2025, 7, 31),
        rates: [USD_ILS],
        accounts: accounts(),
        previous: firstSnapshot(),
      }),
      [{ accountId: "current", balance: ils(61_400), measured: true }],
    );
    const comparison = compareSnapshots({ earlier: firstSnapshot(), later: july, accounts: accounts() });

    expect(comparisonTotals(comparison, accounts(), "ILS").rateChanged).toBe(false);
    expect(comparisonTotals(comparison, accounts(), "ILS").change).toEqual(ils(11_400));
  });
});
