import { describe, expect, it } from "vitest";

import { type Money, compare, money, subtract } from "@/domain/money/money";
import {
  type Grant,
  type Lot,
  type RsuPosition,
  type SharePrice,
  type Vest,
  buildGrant,
  buildSale,
  buildVest,
  readPosition,
  sharePriceFromMajorUnits,
  statedGrantPrice,
} from "@/domain/rsu/rsu-position";
import {
  type FeeSchedule,
  type LotAllocation,
  type TaxRates,
  NO_FEES,
  SECTION_102_RATES,
  sellShares,
} from "@/domain/rsu/rsu-tax";
import { type CalendarDate, calendarDate } from "@/domain/time/calendar-date";

import { InvalidSelectionTargetError, candidateLots, noSelection, selectLots } from "./lot-selector";

/**
 * Plain data in, plain data out: no database, no browser, no network.
 *
 * The load-bearing test here is `noCheaperSelectionExists`: it enumerates every
 * way of splitting a sale across the candidate lots and asserts that nothing
 * reaching the target costs less tax than what the selector returned. That is the
 * only honest way to make the claim — a test that re-implements the same greedy
 * rule the code uses proves the code agrees with itself.
 */

const d = (year: number, month: number, day: number) => calendarDate(year, month, day);
const usd = (major: number | string) => money(Math.round(Number(major) * 100), "USD");
const price = (major: number | string) => sharePriceFromMajorUnits(major, "USD");

/**
 * Two grants whose clocks land on either side of the dates below, so a selection
 * always has a genuinely cheaper option and a genuinely dearer one to choose
 * between: `OLD` qualified in January 2026, `NEW` not until August 2027.
 */
const OLD: Grant = buildGrant("g-old", {
  personId: "eden",
  reference: "RSU-2024-001",
  grantedOn: d(2024, 1, 15),
  totalShares: 400,
  grantPrice: statedGrantPrice(price("149.4219")),
});

const NEW: Grant = buildGrant("g-new", {
  personId: "eden",
  reference: "RSU-2025-002",
  grantedOn: d(2025, 8, 20),
  totalShares: 400,
  grantPrice: statedGrantPrice(price("205.0000")),
});

interface VestSpec {
  readonly id: string;
  readonly grant: Grant;
  readonly on: CalendarDate;
  readonly shares: number;
}

function positionOf(specs: readonly VestSpec[], asOf: CalendarDate): RsuPosition {
  const vests = specs.map((spec) =>
    buildVest(
      spec.id,
      { grantId: spec.grant.id, vestedOn: spec.on, shares: spec.shares, priceAtVest: price("220") },
      spec.grant,
    ),
  );
  return readPosition({ grants: [OLD, NEW], vests, sales: [], asOf });
}

const RATES: TaxRates = SECTION_102_RATES;

/** What an allocation actually nets, priced by the tax module and nothing else. */
function netOf(
  allocations: readonly LotAllocation[],
  salePrice: SharePrice,
  soldOn: CalendarDate,
  fees: FeeSchedule = NO_FEES,
): { net: Money; tax: Money } {
  const sale = sellShares({ allocations, salePrice, soldOn, rates: RATES, fees });
  return { net: sale.netProceeds, tax: sale.totalTax };
}

/**
 * Every way of drawing shares out of the candidate lots — 0..cap from each, in
 * every combination. Exhaustive by construction, which is why the fixtures it is
 * used on are small.
 */
function everyAllocation(lots: readonly Lot[]): LotAllocation[][] {
  const first = lots[0];
  if (first === undefined) return [[]];

  const rest = everyAllocation(lots.slice(1));
  const all: LotAllocation[][] = [];
  for (let shares = 0; shares <= first.remainingShares; shares += 1) {
    for (const tail of rest) {
      all.push(shares === 0 ? tail : [{ lot: first, shares }, ...tail]);
    }
  }
  return all;
}

/** No allocation reaching the target costs less tax than the one chosen. */
function noCheaperSelectionExists(input: {
  readonly position: RsuPosition;
  readonly target: Money;
  readonly targetDate: CalendarDate;
  readonly salePrice: SharePrice;
  readonly fees?: FeeSchedule;
}): void {
  const fees = input.fees ?? NO_FEES;
  const selection = selectLots({ ...input, rates: RATES, fees });
  expect(selection.reachesTarget).toBe(true);

  const chosen = netOf(selection.allocations, input.salePrice, input.targetDate, fees);
  expect(compare(chosen.net, input.target)).toBeGreaterThanOrEqual(0);

  for (const allocation of everyAllocation(selection.candidates)) {
    const priced = netOf(allocation, input.salePrice, input.targetDate, fees);
    if (compare(priced.net, input.target) < 0) continue;
    expect(priced.tax.minorUnits).toBeGreaterThanOrEqual(chosen.tax.minorUnits);
  }
}

// --- reaching the target -------------------------------------------------------

describe("selectLots reaches the target", () => {
  const asOf = d(2026, 8, 12);
  const position = positionOf(
    [
      { id: "v-old", grant: OLD, on: d(2024, 11, 11), shares: 40 },
      { id: "v-new", grant: NEW, on: d(2025, 11, 11), shares: 40 },
    ],
    asOf,
  );

  it("selects enough shares that the net proceeds reach the target", () => {
    const selection = selectLots({
      position,
      target: usd(5_000),
      targetDate: asOf,
      salePrice: price("280"),
      rates: RATES,
    });

    expect(selection.reachesTarget).toBe(true);
    expect(selection.shortfall).toBeNull();
    expect(compare(selection.sale.netProceeds, usd(5_000))).toBeGreaterThanOrEqual(0);
  });

  it("measures the target against the net, not the gross", () => {
    const target = usd(5_000);
    const selection = selectLots({
      position,
      target,
      targetDate: asOf,
      salePrice: price("280"),
      rates: RATES,
    });

    // Enough gross to cover the target would be 18 shares. The tax is more than
    // half of it, so a selection that stopped there would leave the household
    // thousands short of the money it said it needed.
    expect(selection.sale.shares).toBeGreaterThan(18);
    expect(compare(subtract(selection.sale.netProceeds, target), usd(0))).toBeGreaterThanOrEqual(0);
  });

  it("draws no more than it has to: one share fewer falls short", () => {
    const target = usd(5_000);
    const selection = selectLots({
      position,
      target,
      targetDate: asOf,
      salePrice: price("280"),
      rates: RATES,
    });

    const trimmed = selection.allocations.map((allocation, index) =>
      index === selection.allocations.length - 1
        ? { ...allocation, shares: allocation.shares - 1 }
        : allocation,
    );
    expect(compare(netOf(trimmed, price("280"), asOf).net, target)).toBeLessThan(0);
  });

  it("prefers the Qualified lot, which is the cheaper one to sell", () => {
    const selection = selectLots({
      position,
      target: usd(3_000),
      targetDate: asOf,
      salePrice: price("280"),
      rates: RATES,
    });

    expect(selection.allocations).toHaveLength(1);
    expect(selection.allocations[0]?.lot.vest.id).toBe("v-old");
  });

  it("reports a target larger than the position as a shortfall rather than refusing", () => {
    const selection = selectLots({
      position,
      target: usd(1_000_000),
      targetDate: asOf,
      salePrice: price("280"),
      rates: RATES,
    });

    expect(selection.reachesTarget).toBe(false);
    expect(selection.sale.shares).toBe(80);
    expect(selection.shortfall).not.toBeNull();
    expect(selection.shortfall?.minorUnits).toBe(
      subtract(usd(1_000_000), selection.sale.netProceeds).minorUnits,
    );
  });

  it("a target of nothing selects nothing", () => {
    const selection = selectLots({
      position,
      target: usd(0),
      targetDate: asOf,
      salePrice: price("280"),
      rates: RATES,
    });

    expect(selection.allocations).toEqual([]);
    expect(selection.reachesTarget).toBe(true);
    expect(selection.sale.shares).toBe(0);
  });

  it("refuses a target in a currency the sale is not in", () => {
    expect(() =>
      selectLots({
        position,
        target: money(500_000, "ILS"),
        targetDate: asOf,
        salePrice: price("280"),
        rates: RATES,
      }),
    ).toThrow(InvalidSelectionTargetError);
  });
});

// --- no cheaper valid selection exists -----------------------------------------

describe("no cheaper valid selection exists", () => {
  const asOf = d(2026, 8, 12);

  it("holds against exhaustive search across two lots on different clocks", () => {
    noCheaperSelectionExists({
      position: positionOf(
        [
          { id: "v-old", grant: OLD, on: d(2024, 11, 11), shares: 6 },
          { id: "v-new", grant: NEW, on: d(2025, 11, 11), shares: 6 },
        ],
        asOf,
      ),
      target: usd(1_500),
      targetDate: asOf,
      salePrice: price("280"),
    });
  });

  it("holds when the cheap lot alone cannot reach the target", () => {
    noCheaperSelectionExists({
      position: positionOf(
        [
          { id: "v-old", grant: OLD, on: d(2024, 11, 11), shares: 3 },
          { id: "v-new", grant: NEW, on: d(2025, 11, 11), shares: 8 },
        ],
        asOf,
      ),
      target: usd(1_200),
      targetDate: asOf,
      salePrice: price("280"),
    });
  });

  it("holds with fees charged over the sale", () => {
    noCheaperSelectionExists({
      position: positionOf(
        [
          { id: "v-old", grant: OLD, on: d(2024, 11, 11), shares: 5 },
          { id: "v-new", grant: NEW, on: d(2025, 11, 11), shares: 5 },
        ],
        asOf,
      ),
      target: usd(900),
      targetDate: asOf,
      salePrice: price("280"),
      fees: { brokerPerShare: price("0.01"), brokerFlat: usd(15), trusteeBasisPoints: 50 },
    });
  });

  it("holds across four lots and three clocks", () => {
    noCheaperSelectionExists({
      position: positionOf(
        [
          { id: "v-a", grant: OLD, on: d(2024, 11, 11), shares: 4 },
          { id: "v-b", grant: OLD, on: d(2025, 2, 11), shares: 3 },
          { id: "v-c", grant: NEW, on: d(2025, 11, 11), shares: 4 },
          { id: "v-d", grant: NEW, on: d(2026, 2, 11), shares: 3 },
        ],
        asOf,
      ),
      target: usd(1_600),
      targetDate: asOf,
      salePrice: price("280"),
    });
  });

  it("holds at a price below GP, where the whole of a Qualified sale is ordinary income", () => {
    noCheaperSelectionExists({
      position: positionOf(
        [
          { id: "v-old", grant: OLD, on: d(2024, 11, 11), shares: 5 },
          { id: "v-new", grant: NEW, on: d(2025, 11, 11), shares: 5 },
        ],
        asOf,
      ),
      target: usd(300),
      targetDate: asOf,
      salePrice: price("120"),
    });
  });

  it("holds at every target from a dollar up to the whole position", () => {
    const position = positionOf(
      [
        { id: "v-old", grant: OLD, on: d(2024, 11, 11), shares: 4 },
        { id: "v-new", grant: NEW, on: d(2025, 11, 11), shares: 4 },
      ],
      asOf,
    );

    for (let target = 50; target <= 1_000; target += 50) {
      noCheaperSelectionExists({
        position,
        target: usd(target),
        targetDate: asOf,
        salePrice: price("280"),
      });
    }
  });
});

// --- lots not yet vested at the target date ------------------------------------

describe("lots not yet vested at the target date", () => {
  const asOf = d(2026, 8, 12);
  const targetDate = d(2026, 10, 1);

  /** Read as of the target date, which is how the funding question is asked. */
  const position = positionOf(
    [
      { id: "v-held", grant: OLD, on: d(2024, 11, 11), shares: 20 },
      { id: "v-later", grant: OLD, on: d(2026, 11, 11), shares: 20 },
    ],
    targetDate,
  );

  it("excludes them from the candidates and says why", () => {
    const { candidates, excluded } = candidateLots({ position, targetDate });

    expect(candidates.map((lot) => lot.vest.id)).toEqual(["v-held"]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]?.lot.vest.id).toBe("v-later");
    expect(excluded[0]?.reason).toBe("not-vested");
  });

  it("never allocates them, even when the target cannot be reached without them", () => {
    const selection = selectLots({
      position,
      target: usd(50_000),
      targetDate,
      salePrice: price("280"),
      rates: RATES,
    });

    expect(selection.sale.shares).toBe(20);
    expect(selection.reachesTarget).toBe(false);
    expect(selection.allocations.map((allocation) => allocation.lot.vest.id)).toEqual(["v-held"]);
    expect(selection.excluded.map((entry) => entry.lot.vest.id)).toEqual(["v-later"]);
  });

  it("includes a lot that vests between today and the target date", () => {
    const soon = positionOf(
      [
        { id: "v-held", grant: OLD, on: d(2024, 11, 11), shares: 20 },
        { id: "v-soon", grant: OLD, on: d(2026, 9, 15), shares: 20 },
      ],
      targetDate,
    );

    expect(candidateLots({ position: soon, targetDate }).candidates.map((lot) => lot.vest.id)).toEqual([
      "v-held",
      "v-soon",
    ]);
    // The same lot is not a candidate for money needed before it vests.
    expect(
      candidateLots({ position: soon, targetDate: asOf }).candidates.map((lot) => lot.vest.id),
    ).toEqual(["v-held"]);
  });

  it("excludes a lot already sold down to nothing", () => {
    const vest = buildVest(
      "v-gone",
      { grantId: OLD.id, vestedOn: d(2024, 11, 11), shares: 10, priceAtVest: price("220") },
      OLD,
    );
    const sold = readPosition({
      grants: [OLD],
      vests: [vest],
      sales: [
        buildSale("s1", { vestId: "v-gone", soldOn: d(2026, 1, 5), shares: 10, price: price("250") }, vest),
      ],
      asOf: targetDate,
    });

    expect(candidateLots({ position: sold, targetDate }).candidates).toEqual([]);
  });
});

// --- a lot that cannot be priced -----------------------------------------------

describe("a Qualified lot out of a grant with no GP", () => {
  const targetDate = d(2026, 8, 12);

  const NO_GP: Grant = buildGrant("g-nogp", {
    personId: "eden",
    reference: "RSU-2024-999",
    grantedOn: d(2024, 1, 15),
    totalShares: 100,
    grantPrice: null,
  });

  it("is excluded with its reason rather than blocking the whole question", () => {
    const vests = [
      buildVest(
        "v-nogp",
        { grantId: NO_GP.id, vestedOn: d(2024, 11, 11), shares: 20, priceAtVest: price("220") },
        NO_GP,
      ),
      buildVest(
        "v-ok",
        { grantId: OLD.id, vestedOn: d(2024, 11, 11), shares: 20, priceAtVest: price("220") },
        OLD,
      ),
    ];
    const position = readPosition({ grants: [OLD, NO_GP], vests, sales: [], asOf: targetDate });

    const selection = selectLots({
      position,
      target: usd(1_000),
      targetDate,
      salePrice: price("280"),
      rates: RATES,
    });

    expect(selection.excluded.map((entry) => [entry.lot.vest.id, entry.reason])).toEqual([
      ["v-nogp", "no-grant-price"],
    ]);
    expect(selection.reachesTarget).toBe(true);
    expect(selection.allocations.every((allocation) => allocation.lot.grant.id === OLD.id)).toBe(true);
  });

  it("is a candidate when the sale date falls before its own boundary", () => {
    const vest = buildVest(
      "v-nogp",
      { grantId: NO_GP.id, vestedOn: d(2024, 11, 11), shares: 20, priceAtVest: price("220") },
      NO_GP,
    );
    const early = d(2025, 6, 1);
    const position = readPosition({ grants: [NO_GP], vests: [vest], sales: [], asOf: early });

    // An early sale is the whole of the proceeds as ordinary income and consults
    // no GP at all, so nothing about it is missing.
    expect(candidateLots({ position, targetDate: early }).candidates.map((lot) => lot.vest.id)).toEqual([
      "v-nogp",
    ]);
  });
});

// --- the strategy is isolated from the tax calculation -------------------------

describe("the selection strategy is isolated from the tax calculation", () => {
  const asOf = d(2026, 8, 12);
  const position = positionOf(
    [
      { id: "v-old", grant: OLD, on: d(2024, 11, 11), shares: 10 },
      { id: "v-new", grant: NEW, on: d(2025, 11, 11), shares: 10 },
    ],
    asOf,
  );

  it("produces an allocation the tax module prices to the same figures", () => {
    const selection = selectLots({
      position,
      target: usd(2_000),
      targetDate: asOf,
      salePrice: price("280"),
      rates: RATES,
    });

    // The selector holds no arithmetic of its own: pricing its allocation again
    // from outside gives the identical sale, to the cent.
    const again = sellShares({
      allocations: selection.allocations,
      salePrice: price("280"),
      soldOn: asOf,
      rates: RATES,
    });

    expect(again.totalTax).toEqual(selection.sale.totalTax);
    expect(again.netProceeds).toEqual(selection.sale.netProceeds);
    expect(again.grossProceeds).toEqual(selection.sale.grossProceeds);
  });

  it("hands the same allocation shape the oldest-first convention produces", () => {
    // Not the same allocation — that is the point of a strategy — but the same
    // type, so one can be swapped for the other with no change to the pricing.
    const selection = selectLots({
      position,
      target: usd(2_000),
      targetDate: asOf,
      salePrice: price("280"),
      rates: RATES,
    });

    for (const allocation of selection.allocations) {
      expect(allocation.shares).toBeGreaterThan(0);
      expect(allocation.shares).toBeLessThanOrEqual(allocation.lot.remainingShares);
    }
  });

  it("allocates each lot at most once", () => {
    const selection = selectLots({
      position,
      target: usd(4_000),
      targetDate: asOf,
      salePrice: price("280"),
      rates: RATES,
    });

    const ids = selection.allocations.map((allocation) => allocation.lot.vest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is stable across repeated computation", () => {
    const ask = () =>
      selectLots({
        position,
        target: usd(2_500),
        targetDate: asOf,
        salePrice: price("280"),
        rates: RATES,
      }).allocations.map((allocation) => [allocation.lot.vest.id, allocation.shares]);

    expect(ask()).toEqual(ask());
  });
});

// --- nothing to select ---------------------------------------------------------

describe("noSelection", () => {
  it("is an empty selection that still states the target it could not reach", () => {
    const selection = noSelection({
      target: usd(5_000),
      targetDate: d(2026, 8, 12),
      salePrice: price("280"),
      rates: RATES,
    });

    expect(selection.candidates).toEqual([]);
    expect(selection.allocations).toEqual([]);
    expect(selection.reachesTarget).toBe(false);
    expect(selection.shortfall).toEqual(usd(5_000));
    expect(selection.sale.shares).toBe(0);
  });
});
