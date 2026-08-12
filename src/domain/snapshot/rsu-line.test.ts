import { describe, expect, it } from "vitest";

import { type ExchangeRate, exchangeRate, money } from "@/domain/money/money";
import {
  type Grant,
  type Sale,
  type Vest,
  buildGrant,
  buildSale,
  buildVest,
  readPosition,
  sharePriceFromMajorUnits,
} from "@/domain/rsu/rsu-position";
import { calendarDate } from "@/domain/time/calendar-date";

import { readRsuLine, rsuStatement } from "./rsu-line";
import {
  type Account,
  type Snapshot,
  buildAccount,
  buildSnapshot,
  restate,
} from "./snapshot";

/**
 * Plain data in, plain data out. The question every test here asks is the same
 * one: can the RSU holding in מיפוי ever disagree with the position it is made
 * of, or with the snapshot's own rate?
 */

const d = (year: number, month: number, day: number) => calendarDate(year, month, day);
const usd = (major: number) => money(Math.round(major * 100), "USD");
const ils = (major: number) => money(Math.round(major * 100), "ILS");
const price = (major: number | string) => sharePriceFromMajorUnits(major, "USD");

const TAKEN_ON = d(2026, 8, 12);

const GRANT: Grant = buildGrant("g1", {
  personId: "eden",
  reference: "RSU-2024-001",
  grantedOn: d(2024, 1, 15),
  totalShares: 400,
});

const VEST: Vest = buildVest(
  "v1",
  { grantId: "g1", vestedOn: d(2024, 11, 11), shares: 100, priceAtVest: price("220") },
  GRANT,
);

/** A vest still ahead of the snapshot's date. Recorded, and deliberately not held. */
const FUTURE: Vest = buildVest(
  "v2",
  { grantId: "g1", vestedOn: d(2027, 11, 11), shares: 60, priceAtVest: price("250") },
  GRANT,
);

const RSU_ACCOUNT: Account = buildAccount("a-rsu", {
  personId: "eden",
  name: "Apple RSU",
  currency: "USD",
  valueBasis: "market",
  category: "investments",
  assetKind: "מניות",
  openedOn: d(2024, 1, 1),
});

function positionAt(asOf: ReturnType<typeof d>, sales: readonly Sale[] = []) {
  return readPosition({ grants: [GRANT], vests: [VEST, FUTURE], sales, asOf });
}

function snapshotWith(input: {
  rates?: readonly ExchangeRate[];
  balance?: ReturnType<typeof usd>;
  takenOn?: ReturnType<typeof d>;
  account?: Account;
} = {}): Snapshot {
  const account = input.account ?? RSU_ACCOUNT;
  const takenOn = input.takenOn ?? TAKEN_ON;
  return buildSnapshot({
    id: "s1",
    takenOn,
    rates: input.rates ?? [exchangeRate("USD", "ILS", 3.65)],
    lines: [
      {
        accountId: account.id,
        balance: input.balance ?? money(0, account.currency),
        source: "carried",
        measuredOn: null,
      },
    ],
  });
}

// --- the derived figure --------------------------------------------------------

describe("the RSU line is derived, never entered", () => {
  it("is the position's own share count at the snapshot's date, times the stated price", () => {
    const reading = readRsuLine({
      snapshot: snapshotWith(),
      accounts: [RSU_ACCOUNT],
      accountId: RSU_ACCOUNT.id,
      position: positionAt(TAKEN_ON),
      price: price("300"),
    });

    expect(reading.kind).toBe("derived");
    if (reading.kind !== "derived") return;
    // 100 held. The 60 shares vesting in 2027 are recorded and are not a holding.
    expect(reading.holding.shares).toBe(100);
    expect(reading.balance).toEqual(usd(30_000));
  });

  it("moves when the records move, with nothing to update beside it", () => {
    const sold = readRsuLine({
      snapshot: snapshotWith(),
      accounts: [RSU_ACCOUNT],
      accountId: RSU_ACCOUNT.id,
      position: positionAt(TAKEN_ON, [
        buildSale("s1", { vestId: "v1", soldOn: d(2026, 6, 1), shares: 40, price: price("290") }, VEST),
      ]),
      price: price("300"),
    });

    expect(sold.kind === "derived" && sold.holding.shares).toBe(60);
    expect(sold.kind === "derived" && sold.balance).toEqual(usd(18_000));
  });

  it("holds an earlier snapshot at the shares that were held then", () => {
    // The sale happens in June; a snapshot taken in March cannot know about it.
    const sales = [
      buildSale("s1", { vestId: "v1", soldOn: d(2026, 6, 1), shares: 40, price: price("290") }, VEST),
    ];
    const march = d(2026, 3, 1);

    const earlier = readRsuLine({
      snapshot: snapshotWith({ takenOn: march }),
      accounts: [RSU_ACCOUNT],
      accountId: RSU_ACCOUNT.id,
      position: positionAt(march, sales),
      price: price("300"),
    });

    expect(earlier.kind === "derived" && earlier.holding.shares).toBe(100);
  });

  it("reports a recorded figure that no longer matches, rather than hiding it", () => {
    const reading = readRsuLine({
      snapshot: snapshotWith({ balance: usd(21_000) }),
      accounts: [RSU_ACCOUNT],
      accountId: RSU_ACCOUNT.id,
      position: positionAt(TAKEN_ON),
      price: price("300"),
    });

    expect(reading.kind).toBe("derived");
    if (reading.kind !== "derived") return;
    expect(reading.agrees).toBe(false);
    expect(reading.recorded).toEqual(usd(21_000));
    expect(reading.difference).toEqual(usd(-9_000));
  });

  it("agrees once the restatement it stands for has been applied", () => {
    const snapshot = snapshotWith({ balance: usd(21_000) });
    const before = readRsuLine({
      snapshot,
      accounts: [RSU_ACCOUNT],
      accountId: RSU_ACCOUNT.id,
      position: positionAt(TAKEN_ON),
      price: price("300"),
    });

    const statement = rsuStatement(before);
    expect(statement).not.toBeNull();
    const restated = restate(snapshot, [statement as never]);

    const after = readRsuLine({
      snapshot: restated,
      accounts: [RSU_ACCOUNT],
      accountId: RSU_ACCOUNT.id,
      position: positionAt(TAKEN_ON),
      price: price("300"),
    });

    expect(after.kind === "derived" && after.agrees).toBe(true);
    expect(after.kind === "derived" && after.difference).toEqual(usd(0));
    // A derived figure is a measurement of this date, not one carried forward.
    expect(restated.lines[0]?.source).toBe("entered");
    expect(restated.lines[0]?.measuredOn).toEqual(TAKEN_ON);
  });
});

// --- the snapshot's own rate ---------------------------------------------------

describe("the shekel figure goes through the snapshot's own rate", () => {
  const shekelAccount = buildAccount("a-rsu", {
    personId: "eden",
    name: "Apple RSU",
    currency: "ILS",
    valueBasis: "market",
    category: "investments",
    assetKind: "מניות",
    openedOn: d(2024, 1, 1),
  });

  it("converts a dollar price into a shekel account at the rate stored on the snapshot", () => {
    const reading = readRsuLine({
      snapshot: snapshotWith({
        account: shekelAccount,
        balance: ils(0),
        rates: [exchangeRate("USD", "ILS", 3.65)],
      }),
      accounts: [shekelAccount],
      accountId: shekelAccount.id,
      position: positionAt(TAKEN_ON),
      price: price("300"),
    });

    // 100 × $300 = $30,000, at the snapshot's 3.65 and at no other rate.
    expect(reading.kind === "derived" && reading.balance).toEqual(ils(109_500));
  });

  it("gives two snapshots two figures for the same shares, each at its own rate", () => {
    const at = (rate: number) => {
      const reading = readRsuLine({
        snapshot: snapshotWith({
          account: shekelAccount,
          balance: ils(0),
          rates: [exchangeRate("USD", "ILS", rate)],
        }),
        accounts: [shekelAccount],
        accountId: shekelAccount.id,
        position: positionAt(TAKEN_ON),
        price: price("300"),
      });
      return reading.kind === "derived" ? reading.balance : null;
    };

    // One position, one price, two rates: the difference is the snapshot's, and
    // nothing here can reach past it to today's.
    expect(at(3.65)).toEqual(ils(109_500));
    expect(at(3.2)).toEqual(ils(96_000));
  });

  it("yields no figure at all where the snapshot carries no rate for the pair", () => {
    const reading = readRsuLine({
      snapshot: snapshotWith({ account: shekelAccount, balance: ils(0), rates: [] }),
      accounts: [shekelAccount],
      accountId: shekelAccount.id,
      position: positionAt(TAKEN_ON),
      price: price("300"),
    });

    expect(reading.kind).toBe("unconvertible");
    expect(rsuStatement(reading)).toBeNull();
  });

  it("needs no rate at all when the account is held in the price's own currency", () => {
    const reading = readRsuLine({
      snapshot: snapshotWith({ rates: [] }),
      accounts: [RSU_ACCOUNT],
      accountId: RSU_ACCOUNT.id,
      position: positionAt(TAKEN_ON),
      price: price("300"),
    });

    expect(reading.kind === "derived" && reading.balance).toEqual(usd(30_000));
  });
});

// --- what cannot be derived ----------------------------------------------------

describe("what cannot be derived is said rather than guessed", () => {
  it("says so when no account has been named", () => {
    const reading = readRsuLine({
      snapshot: snapshotWith(),
      accounts: [RSU_ACCOUNT],
      accountId: null,
      position: positionAt(TAKEN_ON),
      price: price("300"),
    });

    expect(reading.kind).toBe("unnamed");
    expect(rsuStatement(reading)).toBeNull();
  });

  it("surfaces an account that was named and no longer exists", () => {
    const reading = readRsuLine({
      snapshot: snapshotWith(),
      accounts: [],
      accountId: "a-rsu",
      position: positionAt(TAKEN_ON),
      price: price("300"),
    });

    expect(reading).toEqual({ kind: "unknown", accountId: "a-rsu" });
  });

  it("derives nothing into a snapshot taken before the account opened", () => {
    const later = buildAccount("a-rsu", {
      personId: "eden",
      name: "Apple RSU",
      currency: "USD",
      valueBasis: "market",
      category: "investments",
      assetKind: "מניות",
      openedOn: d(2026, 9, 1),
    });

    const reading = readRsuLine({
      snapshot: snapshotWith(),
      accounts: [later],
      accountId: later.id,
      position: positionAt(TAKEN_ON),
      price: price("300"),
    });

    expect(reading.kind).toBe("not-open");
    expect(rsuStatement(reading)).toBeNull();
  });

  it("derives nothing where nobody stated a price, and says how many shares wait on one", () => {
    const reading = readRsuLine({
      snapshot: snapshotWith({ balance: usd(21_000) }),
      accounts: [RSU_ACCOUNT],
      accountId: RSU_ACCOUNT.id,
      position: positionAt(TAKEN_ON),
      price: null,
    });

    expect(reading).toEqual({ kind: "unpriced", account: RSU_ACCOUNT, shares: 100 });
    // The figure already recorded is left standing rather than zeroed.
    expect(rsuStatement(reading)).toBeNull();
  });

  it("derives nothing rather than nothing-at-all for a position holding no shares", () => {
    const empty = readPosition({ grants: [GRANT], vests: [FUTURE], sales: [], asOf: TAKEN_ON });
    const reading = readRsuLine({
      snapshot: snapshotWith(),
      accounts: [RSU_ACCOUNT],
      accountId: RSU_ACCOUNT.id,
      position: empty,
      price: price("300"),
    });

    // Nought shares is a holding of nothing, which is a fact and reads as one.
    expect(reading.kind === "derived" && reading.balance).toEqual(usd(0));
    expect(reading.kind === "derived" && reading.agrees).toBe(true);
  });
});
