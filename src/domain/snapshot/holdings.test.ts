import { describe, expect, it } from "vitest";

import { type Money, exchangeRate, money } from "@/domain/money/money";
import {
  type Account,
  type Snapshot,
  buildAccount,
  restate,
  seedSnapshot,
} from "@/domain/snapshot/snapshot";
import { calendarDate } from "@/domain/time/calendar-date";

import {
  type Earmark,
  InvalidEarmarkError,
  InvalidPositionError,
  PositionsNotApplicableError,
  buildEarmark,
  buildPosition,
  canHoldPositions,
  claimRows,
  earmarkFunding,
  earmarksActiveOn,
  earmarksOn,
  freeLiquid,
  isEarmarkActiveOn,
  positionsIn,
  requirePositionsAllowed,
} from "./holdings";

/**
 * Plain data in, plain data out: no database, no browser, no network. Every money
 * assertion is on exact minor units, because a shortfall that is out by an agora
 * is a shortfall nobody can act on.
 */

const ils = (major: number): Money => money(Math.round(major * 100), "ILS");
const usd = (major: number): Money => money(Math.round(major * 100), "USD");
const d = (year: number, month: number, day: number) => calendarDate(year, month, day);

const USD_ILS = exchangeRate("USD", "ILS", 3.65);

/** The household's real shape: two liquid accounts, an investment one, and CGM 2 at cost. */
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
    buildAccount("ayalon", {
      personId: "eden",
      name: "איילון קרן כספית",
      currency: "ILS",
      valueBasis: "market",
      category: "liquid",
      assetKind: "קרן כספית",
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

function snapshotOf(
  balances: readonly { accountId: string; balance: Money }[],
  takenOn = d(2025, 1, 31),
): Snapshot {
  const seeded = seedSnapshot({
    id: `s-${takenOn.month}`,
    takenOn,
    rates: [USD_ILS],
    accounts: accounts(),
    previous: null,
  });
  return restate(
    seeded,
    balances.map((balance) => ({ ...balance, measured: true })),
  );
}

/** Every account measured: 50,000₪ current, 150,000₪ איילון, $40,000 brokerage. */
function fullSnapshot(takenOn = d(2025, 1, 31)): Snapshot {
  return snapshotOf(
    [
      { accountId: "current", balance: ils(50_000) },
      { accountId: "ayalon", balance: ils(150_000) },
      { accountId: "brokerage", balance: usd(40_000) },
      { accountId: "cgm2", balance: usd(82_000) },
    ],
    takenOn,
  );
}

const emergencyFund: Earmark = buildEarmark("emergency", {
  accountId: "ayalon",
  name: "קרן חירום",
  claim: ils(120_000),
  declaredOn: d(2024, 1, 1),
});

// --- positions ---------------------------------------------------------------

describe("a position", () => {
  it("records what an account is invested in, and reads back per account", () => {
    const positions = [
      buildPosition("p1", { accountId: "brokerage", securityId: "1209220", name: "FTSE" }),
      buildPosition("p2", { accountId: "brokerage", securityId: "1159235", name: "ACWI" }),
      buildPosition("p3", { accountId: "ayalon", name: "קרן כספית שקלית" }),
    ];

    expect(positionsIn(positions, "brokerage").map((position) => position.name)).toEqual([
      "ACWI",
      "FTSE",
    ]);
    expect(positionsIn(positions, "brokerage")[0]?.securityId).toBe("1159235");
    expect(positionsIn(positions, "ayalon").map((position) => position.name)).toEqual([
      "קרן כספית שקלית",
    ]);
    expect(positionsIn(positions, "current")).toEqual([]);
  });

  it("keeps the security id as written, and holds none when there is none to hold", () => {
    expect(buildPosition("p", { accountId: "a", securityId: " 1159235 ", name: " ACWI " })).toEqual({
      id: "p",
      accountId: "a",
      securityId: "1159235",
      name: "ACWI",
    });
    expect(buildPosition("p", { accountId: "a", securityId: "  ", name: "ACWI" }).securityId).toBeNull();
    expect(buildPosition("p", { accountId: "a", name: "ACWI" }).securityId).toBeNull();
  });

  it("refuses a nameless position", () => {
    expect(() => buildPosition("p", { accountId: "a", name: "   " })).toThrow(InvalidPositionError);
  });

  it("carries no amount — how much an account holds is the snapshot's fact, with a date on it", () => {
    const position = buildPosition("p", { accountId: "brokerage", securityId: "1159235", name: "ACWI" });
    expect(Object.keys(position).sort()).toEqual(["accountId", "id", "name", "securityId"]);
  });

  it("cannot be recorded against an account held at cost (ADR 0003)", () => {
    const [current, , brokerage, cgm2] = accounts();

    expect(canHoldPositions(brokerage as Account)).toBe(true);
    expect(canHoldPositions(current as Account)).toBe(true);
    expect(canHoldPositions(cgm2 as Account)).toBe(false);
    expect(() => requirePositionsAllowed(cgm2 as Account)).toThrow(PositionsNotApplicableError);
    expect(() => requirePositionsAllowed(brokerage as Account)).not.toThrow();
  });
});

// --- earmarks ----------------------------------------------------------------

describe("an earmark", () => {
  it("claims a named amount against one account", () => {
    expect(emergencyFund.name).toBe("קרן חירום");
    expect(emergencyFund.claim).toEqual({ minorUnits: 12_000_000, currency: "ILS" });
    expect(emergencyFund.accountId).toBe("ayalon");
  });

  it("refuses a claim of nothing, or of less than nothing", () => {
    const base = { accountId: "ayalon", name: "קרן חירום", declaredOn: d(2024, 1, 1) };
    expect(() => buildEarmark("e", { ...base, claim: ils(0) })).toThrow(InvalidEarmarkError);
    expect(() => buildEarmark("e", { ...base, claim: ils(-1) })).toThrow(InvalidEarmarkError);
    expect(() => buildEarmark("e", { ...base, name: " ", claim: ils(1) })).toThrow(InvalidEarmarkError);
  });

  it("is a lifespan, not a delete — it stands from the day it was declared to the day it was released", () => {
    const released = buildEarmark("e", {
      accountId: "ayalon",
      name: "שיפוץ",
      claim: ils(30_000),
      declaredOn: d(2025, 3, 1),
      releasedOn: d(2025, 6, 30),
    });

    expect(isEarmarkActiveOn(released, d(2025, 2, 28))).toBe(false);
    expect(isEarmarkActiveOn(released, d(2025, 3, 1))).toBe(true);
    expect(isEarmarkActiveOn(released, d(2025, 6, 30))).toBe(true);
    expect(isEarmarkActiveOn(released, d(2025, 7, 1))).toBe(false);
    expect(earmarksActiveOn([emergencyFund, released], d(2025, 1, 31))).toEqual([emergencyFund]);
    expect(() =>
      buildEarmark("e", {
        accountId: "ayalon",
        name: "שיפוץ",
        claim: ils(1),
        declaredOn: d(2025, 6, 30),
        releasedOn: d(2025, 3, 1),
      }),
    ).toThrow(InvalidEarmarkError);
  });

  it("orders the claims on an account by size, and the order is stable across reads", () => {
    const claims = [
      buildEarmark("small", { accountId: "ayalon", name: "חופשה", claim: ils(20_000), declaredOn: d(2024, 1, 1) }),
      emergencyFund,
      buildEarmark("mid", { accountId: "ayalon", name: "רכב", claim: ils(60_000), declaredOn: d(2024, 1, 1) }),
      buildEarmark("other", { accountId: "current", name: "מסים", claim: ils(9_000), declaredOn: d(2024, 1, 1) }),
    ];

    const names = () => earmarksOn(claims, "ayalon").map((earmark) => earmark.name);
    expect(names()).toEqual(["קרן חירום", "רכב", "חופשה"]);
    expect(names()).toEqual(earmarksOn([...claims].reverse(), "ayalon").map((earmark) => earmark.name));
  });
});

// --- funding -----------------------------------------------------------------

describe("how well a claim is backed", () => {
  it("reads as funded when the account holds at least what is claimed, and says what is left free", () => {
    const funding = earmarkFunding({
      snapshot: fullSnapshot(),
      accounts: accounts(),
      earmarks: [emergencyFund],
    });

    expect(funding).toHaveLength(1);
    expect(funding[0]?.account.id).toBe("ayalon");
    expect(funding[0]?.status).toBe("funded");
    expect(funding[0]?.claimed).toEqual({ minorUnits: 12_000_000, currency: "ILS" });
    expect(funding[0]?.backing).toEqual({ minorUnits: 15_000_000, currency: "ILS" });
    expect(funding[0]?.free).toEqual({ minorUnits: 3_000_000, currency: "ILS" });
    expect(funding[0]?.shortfall).toBeNull();
  });

  it("leaves out the accounts nobody has claimed anything against", () => {
    const funding = earmarkFunding({
      snapshot: fullSnapshot(),
      accounts: accounts(),
      earmarks: [emergencyFund],
    });
    expect(funding.map((entry) => entry.account.id)).toEqual(["ayalon"]);
  });

  it("shows a shortfall when the backing has fallen below the claim — and the claim does not move", () => {
    // The emergency fund spent down from 150,000₪ to 95,000₪.
    const spent = snapshotOf([
      { accountId: "current", balance: ils(50_000) },
      { accountId: "ayalon", balance: ils(95_000) },
      { accountId: "brokerage", balance: usd(40_000) },
      { accountId: "cgm2", balance: usd(82_000) },
    ]);

    const funding = earmarkFunding({ snapshot: spent, accounts: accounts(), earmarks: [emergencyFund] });

    expect(funding[0]?.status).toBe("underfunded");
    expect(funding[0]?.shortfall).toEqual({ minorUnits: 2_500_000, currency: "ILS" });
    expect(funding[0]?.free).toBeNull();
    // The promise is untouched by the spending: 120,000₪ was claimed and 120,000₪
    // is still claimed. Nothing reduced it quietly.
    expect(funding[0]?.claimed).toEqual({ minorUnits: 12_000_000, currency: "ILS" });
    expect(funding[0]?.earmarks[0]?.claim).toEqual(emergencyFund.claim);
  });

  it("is exact at the boundary: holding precisely the claim is funded, an agora less is not", () => {
    const exact = earmarkFunding({
      snapshot: snapshotOf([{ accountId: "ayalon", balance: ils(120_000) }]),
      accounts: accounts(),
      earmarks: [emergencyFund],
    });
    expect(exact[0]?.status).toBe("funded");
    expect(exact[0]?.free).toEqual({ minorUnits: 0, currency: "ILS" });

    const short = earmarkFunding({
      snapshot: snapshotOf([{ accountId: "ayalon", balance: money(11_999_999, "ILS") }]),
      accounts: accounts(),
      earmarks: [emergencyFund],
    });
    expect(short[0]?.status).toBe("underfunded");
    expect(short[0]?.shortfall).toEqual({ minorUnits: 1, currency: "ILS" });
  });

  it("assesses claims on the same account together, because they compete for the same money", () => {
    const car = buildEarmark("car", {
      accountId: "ayalon",
      name: "רכב",
      claim: ils(60_000),
      declaredOn: d(2024, 1, 1),
    });

    const funding = earmarkFunding({
      snapshot: fullSnapshot(),
      accounts: accounts(),
      earmarks: [emergencyFund, car],
    });

    // 150,000₪ backing 180,000₪ of promises. Each claim alone would look funded;
    // together they are 30,000₪ short, and no invented priority makes one whole.
    expect(funding).toHaveLength(1);
    expect(funding[0]?.claimed).toEqual({ minorUnits: 18_000_000, currency: "ILS" });
    expect(funding[0]?.status).toBe("underfunded");
    expect(funding[0]?.shortfall).toEqual({ minorUnits: 3_000_000, currency: "ILS" });
    expect(claimRows(funding).map((row) => row.earmark.name)).toEqual(["קרן חירום", "רכב"]);
    expect(claimRows(funding).every((row) => row.account.status === "underfunded")).toBe(true);
  });

  it("reports an account nobody has ever measured as unmeasured, never as underfunded", () => {
    // Seeded and never restated: the balance is a placeholder, not a measurement.
    const untouched = seedSnapshot({
      id: "s0",
      takenOn: d(2025, 1, 31),
      rates: [USD_ILS],
      accounts: accounts(),
      previous: null,
    });

    const funding = earmarkFunding({
      snapshot: untouched,
      accounts: accounts(),
      earmarks: [emergencyFund],
    });

    expect(funding[0]?.status).toBe("unmeasured");
    expect(funding[0]?.shortfall).toBeNull();
    expect(funding[0]?.free).toBeNull();
    expect(funding[0]?.measuredOn).toBeNull();
  });

  it("says when the backing was carried rather than measured on the snapshot's own date", () => {
    const january = fullSnapshot(d(2025, 1, 31));
    const july = seedSnapshot({
      id: "s7",
      takenOn: d(2025, 7, 31),
      rates: [USD_ILS],
      accounts: accounts(),
      previous: january,
    });

    const funding = earmarkFunding({ snapshot: july, accounts: accounts(), earmarks: [emergencyFund] });

    expect(funding[0]?.carried).toBe(true);
    expect(funding[0]?.measuredOn).toEqual(d(2025, 1, 31));
    expect(funding[0]?.status).toBe("funded");
  });

  it("reads only the claims that stood on the snapshot's own date", () => {
    const later = buildEarmark("later", {
      accountId: "ayalon",
      name: "שיפוץ",
      claim: ils(90_000),
      declaredOn: d(2025, 6, 1),
    });

    const january = earmarkFunding({
      snapshot: fullSnapshot(d(2025, 1, 31)),
      accounts: accounts(),
      earmarks: [emergencyFund, later],
    });
    expect(january[0]?.claimed).toEqual({ minorUnits: 12_000_000, currency: "ILS" });
    expect(january[0]?.status).toBe("funded");

    const july = earmarkFunding({
      snapshot: fullSnapshot(d(2025, 7, 31)),
      accounts: accounts(),
      earmarks: [emergencyFund, later],
    });
    expect(july[0]?.claimed).toEqual({ minorUnits: 21_000_000, currency: "ILS" });
    expect(july[0]?.status).toBe("underfunded");
  });

  it("refuses a claim quoted in a currency the account is not held in", () => {
    const wrong = buildEarmark("wrong", {
      accountId: "ayalon",
      name: "קרן חירום",
      claim: usd(30_000),
      declaredOn: d(2024, 1, 1),
    });

    expect(() =>
      earmarkFunding({ snapshot: fullSnapshot(), accounts: accounts(), earmarks: [wrong] }),
    ).toThrow(InvalidEarmarkError);
  });

  it("measures a foreign account's claim in that account's own currency, with no rate involved", () => {
    const deposit = buildEarmark("deposit", {
      accountId: "brokerage",
      name: "מקדמה",
      claim: usd(45_000),
      declaredOn: d(2024, 1, 1),
    });

    const funding = earmarkFunding({
      snapshot: fullSnapshot(),
      accounts: accounts(),
      earmarks: [deposit],
    });

    expect(funding[0]?.shortfall).toEqual({ minorUnits: 500_000, currency: "USD" });
  });
});

// --- free liquid money -------------------------------------------------------

describe("free liquid money", () => {
  it("is liquid holdings less what is earmarked against them", () => {
    const free = freeLiquid({
      snapshot: fullSnapshot(),
      accounts: accounts(),
      earmarks: [emergencyFund],
      currency: "ILS",
    });

    // 50,000 + 150,000 liquid, 120,000 promised.
    expect(free.holdings).toEqual({ minorUnits: 20_000_000, currency: "ILS" });
    expect(free.earmarked).toEqual({ minorUnits: 12_000_000, currency: "ILS" });
    expect(free.free).toEqual({ minorUnits: 8_000_000, currency: "ILS" });
    expect(free.shortfall).toEqual({ minorUnits: 0, currency: "ILS" });
    expect(free.claimed.map((entry) => entry.account.id)).toEqual(["ayalon"]);
  });

  it("counts only the נזילות bucket — a claim on an investment account is spoken for out of that bucket", () => {
    const deposit = buildEarmark("deposit", {
      accountId: "brokerage",
      name: "מקדמה",
      claim: usd(10_000),
      declaredOn: d(2024, 1, 1),
    });

    const free = freeLiquid({
      snapshot: fullSnapshot(),
      accounts: accounts(),
      earmarks: [emergencyFund, deposit],
      currency: "ILS",
    });

    // The $40,000 brokerage account and its claim are both outside נזילות.
    expect(free.holdings).toEqual({ minorUnits: 20_000_000, currency: "ILS" });
    expect(free.earmarked).toEqual({ minorUnits: 12_000_000, currency: "ILS" });
  });

  it("subtracts the whole claim and reports the unbacked part separately", () => {
    const spent = snapshotOf([
      { accountId: "current", balance: ils(50_000) },
      { accountId: "ayalon", balance: ils(95_000) },
    ]);

    const free = freeLiquid({
      snapshot: spent,
      accounts: accounts(),
      earmarks: [emergencyFund],
      currency: "ILS",
    });

    expect(free.holdings).toEqual({ minorUnits: 14_500_000, currency: "ILS" });
    expect(free.earmarked).toEqual({ minorUnits: 12_000_000, currency: "ILS" });
    expect(free.free).toEqual({ minorUnits: 2_500_000, currency: "ILS" });
    // 25,000₪ of the promise has nothing behind it. It is stated, not written off.
    expect(free.shortfall).toEqual({ minorUnits: 2_500_000, currency: "ILS" });
  });

  it("goes negative rather than clamping when more is promised than is held", () => {
    const big = buildEarmark("big", {
      accountId: "ayalon",
      name: "מקדמה CGM 3",
      claim: ils(400_000),
      declaredOn: d(2024, 1, 1),
    });

    const free = freeLiquid({
      snapshot: fullSnapshot(),
      accounts: accounts(),
      earmarks: [big],
      currency: "ILS",
    });

    expect(free.free).toEqual({ minorUnits: -20_000_000, currency: "ILS" });
  });

  it("converts at the snapshot's own rate, so it reads the same in either currency", () => {
    const dollarCash = buildAccount("usd-cash", {
      personId: "yuval",
      name: "עו״ש דולרי",
      currency: "USD",
      valueBasis: "market",
      category: "liquid",
      assetKind: "עובר ושב",
      openedOn: d(2020, 1, 1),
    });
    const withDollars = [...accounts(), dollarCash];

    const snapshot = restate(
      seedSnapshot({
        id: "s1",
        takenOn: d(2025, 1, 31),
        rates: [USD_ILS],
        accounts: withDollars,
        previous: null,
      }),
      [
        { accountId: "current", balance: ils(50_000), measured: true },
        { accountId: "ayalon", balance: ils(150_000), measured: true },
        { accountId: "usd-cash", balance: usd(10_000), measured: true },
      ],
    );

    const shekels = freeLiquid({
      snapshot,
      accounts: withDollars,
      earmarks: [emergencyFund],
      currency: "ILS",
    });
    // 200,000₪ plus $10,000 at 3.65.
    expect(shekels.holdings).toEqual({ minorUnits: 23_650_000, currency: "ILS" });
    expect(shekels.free).toEqual({ minorUnits: 11_650_000, currency: "ILS" });

    const dollars = freeLiquid({
      snapshot,
      accounts: withDollars,
      earmarks: [emergencyFund],
      currency: "USD",
    });
    // The same money read back through the same rate: 236,500 / 3.65.
    expect(dollars.holdings).toEqual({ minorUnits: 6_479_452, currency: "USD" });
  });

  it("says how many liquid accounts rest on a figure nobody has ever measured", () => {
    const untouched = seedSnapshot({
      id: "s0",
      takenOn: d(2025, 1, 31),
      rates: [USD_ILS],
      accounts: accounts(),
      previous: null,
    });

    const free = freeLiquid({
      snapshot: untouched,
      accounts: accounts(),
      earmarks: [emergencyFund],
      currency: "ILS",
    });

    expect(free.unmeasuredAccounts).toBe(2);
    expect(free.holdings).toEqual({ minorUnits: 0, currency: "ILS" });
    expect(free.earmarked).toEqual({ minorUnits: 12_000_000, currency: "ILS" });
    // Nobody measured it, so nothing is called a shortfall.
    expect(free.shortfall).toEqual({ minorUnits: 0, currency: "ILS" });
  });
});
