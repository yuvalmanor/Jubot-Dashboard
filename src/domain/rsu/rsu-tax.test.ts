import { describe, expect, it } from "vitest";

import { CurrencyMismatchError, add, money, subtract } from "@/domain/money/money";
import {
  type Grant,
  type Lot,
  type RsuPosition,
  type Sale,
  type Vest,
  buildGrant,
  buildSale,
  buildVest,
  readPosition,
  sharePriceFromMajorUnits,
  statedGrantPrice,
} from "@/domain/rsu/rsu-position";
import { calendarDate } from "@/domain/time/calendar-date";

import {
  InvalidFeeScheduleError,
  InvalidSaleQuantityError,
  InvalidTaxRatesError,
  MissingGrantPriceError,
  NO_FEES,
  SECTION_102_RATES,
  buildFeeSchedule,
  buildTaxRates,
  chargeFees,
  oldestFirst,
  sellFrom,
  sellFromPosition,
  taxOnLotSale,
  treatmentOn,
  waitingValue,
  waitingValues,
} from "./rsu-tax";

/**
 * Plain data in, plain data out: no database, no browser, no network. Every
 * assertion is on exact minor-unit integers — a tax figure a cent out is a tax
 * figure that cannot be checked against a statement.
 *
 * The clock is always a parameter. The whole of this module turns on which side
 * of a boundary a sale date falls, so no test may ask the world what day it is.
 */

const d = (year: number, month: number, day: number) => calendarDate(year, month, day);
const usd = (major: number | string) => money(Math.round(Number(major) * 100), "USD");
const price = (major: number | string) => sharePriceFromMajorUnits(major, "USD");

/**
 * The household's own shape: one grant in January 2024, qualifying in January
 * 2026, with a lot that vested in between. GP 149.4219 is the figure off their
 * sheet.
 */
const GRANT: Grant = buildGrant("g1", {
  personId: "eden",
  reference: "RSU-2024-001",
  grantedOn: d(2024, 1, 15),
  totalShares: 400,
  grantPrice: statedGrantPrice(price("149.4219")),
});

function positionOf(input: {
  grants?: readonly Grant[];
  vests: readonly Vest[];
  sales?: readonly Sale[];
  asOf: ReturnType<typeof d>;
}): RsuPosition {
  return readPosition({
    grants: input.grants ?? [GRANT],
    vests: input.vests,
    sales: input.sales ?? [],
    asOf: input.asOf,
  });
}

function lotOf(shares: number, asOf = d(2026, 8, 11), grant: Grant = GRANT): Lot {
  const vest = buildVest(
    `v-${grant.id}-${shares}`,
    { grantId: grant.id, vestedOn: d(2024, 11, 11), shares, priceAtVest: price("220") },
    grant,
  );
  const position = readPosition({ grants: [grant], vests: [vest], sales: [], asOf });
  const lot = position.lots[0];
  if (lot === undefined) throw new Error("fixture produced no lot");
  return lot;
}

// --- the rates and the fees are settings ---------------------------------------

describe("the rates", () => {
  it("start at the household's reading of סעיף 102", () => {
    expect(SECTION_102_RATES.ordinaryBasisPoints).toBe(6_217);
    expect(SECTION_102_RATES.capitalGainsBasisPoints).toBe(2_500);
  });

  it("are whole basis points inside a percentage", () => {
    expect(() => buildTaxRates({ ordinaryBasisPoints: 6_217.5, capitalGainsBasisPoints: 2_500 })).toThrow(
      InvalidTaxRatesError,
    );
    expect(() => buildTaxRates({ ordinaryBasisPoints: 10_001, capitalGainsBasisPoints: 2_500 })).toThrow(
      InvalidTaxRatesError,
    );
    expect(() => buildTaxRates({ ordinaryBasisPoints: 6_217, capitalGainsBasisPoints: -1 })).toThrow(
      InvalidTaxRatesError,
    );
  });
});

describe("the fees", () => {
  it("start at none, which is a real position and not an unset one", () => {
    expect(NO_FEES.brokerPerShare).toBeNull();
    expect(NO_FEES.brokerFlat).toBeNull();
    expect(NO_FEES.trusteeBasisPoints).toBe(0);
  });

  it("charge a commission per share exactly, at four decimals", () => {
    // A cent a share is 0.0100, which is a price and not an amount of money.
    const charged = chargeFees(
      { brokerPerShare: price("0.01"), brokerFlat: null, trusteeBasisPoints: 0 },
      usd(5_320),
      19,
    );
    expect(charged.broker.minorUnits).toBe(19);
    expect(charged.total.minorUnits).toBe(19);
  });

  it("charge the trustee out of the gross proceeds", () => {
    const charged = chargeFees(
      { brokerPerShare: null, brokerFlat: null, trusteeBasisPoints: 50 },
      usd(5_320),
      19,
    );
    // 0.5% of $5,320.00 is $26.60 exactly.
    expect(charged.trustee.minorUnits).toBe(26_60);
  });

  it("charge nothing at all on a sale of nothing", () => {
    const fees = { brokerPerShare: price("0.01"), brokerFlat: usd(15), trusteeBasisPoints: 50 };
    expect(chargeFees(fees, usd(0), 0).total.minorUnits).toBe(0);
  });

  it("refuse a fee quoted in a currency the sale is not in", () => {
    // Converting here would need a rate nobody named, so it throws instead.
    expect(() =>
      chargeFees({ brokerPerShare: null, brokerFlat: money(15_00, "ILS"), trusteeBasisPoints: 0 }, usd(5_320), 19),
    ).toThrow(CurrencyMismatchError);
  });

  it("refuse two broker charges in two different currencies", () => {
    expect(() =>
      buildFeeSchedule({
        brokerPerShare: price("0.01"),
        brokerFlat: money(15_00, "ILS"),
        trusteeBasisPoints: 0,
      }),
    ).toThrow(InvalidFeeScheduleError);
  });
});

// --- the Qualified path, against the household's own sheet row -------------------

describe("the Qualified path", () => {
  const lot = lotOf(19);

  it("splits GP as ordinary income and the appreciation above it as a capital gain", () => {
    const tax = taxOnLotSale({
      lot,
      shares: 19,
      salePrice: price("280"),
      soldOn: d(2026, 8, 11),
      rates: SECTION_102_RATES,
    });

    expect(tax.treatment).toBe("qualified");
    // 19 × $280 = $5,320.00, of which 19 × 149.4219 = $2,839.02 is ordinary income.
    expect(tax.grossProceeds.minorUnits).toBe(532_000);
    expect(tax.ordinaryIncome.minorUnits).toBe(283_902);
    expect(tax.capitalGain.minorUnits).toBe(248_098);
    // 62.17% of $2,839.02 and 25% of $2,480.98.
    expect(tax.ordinaryTax.minorUnits).toBe(176_502);
    expect(tax.capitalGainsTax.minorUnits).toBe(62_025);
    expect(tax.totalTax.minorUnits).toBe(238_527);
  });

  it("nets the sale down to what arrives", () => {
    const sale = sellFrom({
      lots: [lot],
      shares: 19,
      salePrice: price("280"),
      soldOn: d(2026, 8, 11),
      rates: SECTION_102_RATES,
      fees: NO_FEES,
    });

    expect(sale.totalTax.minorUnits).toBe(238_527);
    expect(sale.netProceeds.minorUnits).toBe(293_473);
  });

  /**
   * The sheet's own row 1 states tax $2,385.14 and net $2,934.67 for exactly
   * these inputs, and this module produces $2,385.27 and $2,934.73. The gap is
   * not rounding, and it is reconstructible to the cent:
   *
   *   $5,320.00 − $2,385.14 − $2,934.67 = $0.19
   *
   * — a cent a share of selling cost. Taking that $0.19 off the *ordinary-income
   * base* before the 62.17% gives 0.6217 × (2,839.0161 − 0.19) + 0.25 ×
   * 2,480.9839 = 2,385.1442, the sheet's figure to the cent, and then
   * 5,320 − 2,385.14 − 0.19 = 2,934.67, its net to the cent. Nothing else fits
   * both figures at 62.17% and 25%.
   *
   * So the sheet deducted the selling cost from what it taxed. That is what the
   * PRD forbids in as many words, and this module does the other thing: the fee
   * comes off the net and the base is untouched. The remaining agora is genuine
   * rounding — each component is a real amount and is rounded to the cent once,
   * where the sheet carried unrounded floats through to one total.
   */
  it("differs from the sheet's row by the selling cost the sheet taxed away", () => {
    const withFee = sellFrom({
      lots: [lot],
      shares: 19,
      salePrice: price("280"),
      soldOn: d(2026, 8, 11),
      rates: SECTION_102_RATES,
      fees: { brokerPerShare: price("0.01"), brokerFlat: null, trusteeBasisPoints: 0 },
    });

    expect(withFee.fees.total.minorUnits).toBe(19);
    // The fee changed the net and left the tax exactly where it was.
    expect(withFee.totalTax.minorUnits).toBe(238_527);
    expect(withFee.netProceeds.minorUnits).toBe(293_454);
    expect(withFee.netProceeds.minorUnits).not.toBe(293_467);
  });

  it("taxes the whole of the proceeds where the price fell below GP", () => {
    const tax = taxOnLotSale({
      lot,
      shares: 19,
      salePrice: price("100"),
      soldOn: d(2026, 8, 11),
      rates: SECTION_102_RATES,
    });

    // There is no gain above GP, and a work-income component larger than the
    // money received would tax income nobody got.
    expect(tax.belowGrantPrice).toBe(true);
    expect(tax.ordinaryIncome.minorUnits).toBe(190_000);
    expect(tax.capitalGain.minorUnits).toBe(0);
    expect(tax.capitalGainsTax.minorUnits).toBe(0);
  });

  it("refuses to price a Qualified sale out of a grant with no GP", () => {
    const priceless = buildGrant("g-none", {
      personId: "eden",
      reference: "RSU-NO-GP",
      grantedOn: d(2024, 1, 15),
      totalShares: 100,
    });

    expect(() =>
      taxOnLotSale({
        lot: lotOf(19, d(2026, 8, 11), priceless),
        shares: 19,
        salePrice: price("280"),
        soldOn: d(2026, 8, 11),
        rates: SECTION_102_RATES,
      }),
    ).toThrow(MissingGrantPriceError);
  });
});

// --- the Unqualified path ---------------------------------------------------------

describe("the Unqualified path", () => {
  it("taxes the entire gain as ordinary income", () => {
    const tax = taxOnLotSale({
      lot: lotOf(19, d(2025, 6, 1)),
      shares: 19,
      salePrice: price("280"),
      soldOn: d(2025, 6, 1),
      rates: SECTION_102_RATES,
    });

    expect(tax.treatment).toBe("unqualified");
    // An RSU costs nothing to acquire, so the whole $5,320.00 is the benefit.
    expect(tax.ordinaryIncome.minorUnits).toBe(532_000);
    expect(tax.capitalGain.minorUnits).toBe(0);
    expect(tax.capitalGainsTax.minorUnits).toBe(0);
    expect(tax.totalTax.minorUnits).toBe(330_744);
  });

  it("does not rest on GP at all, estimated or otherwise", () => {
    const estimated = buildGrant("g-est", {
      personId: "eden",
      reference: "RSU-EST",
      grantedOn: d(2024, 1, 15),
      totalShares: 100,
      grantPrice: {
        price: price("149.4219"),
        source: "estimated",
        window: { basis: "trading", before: 30, after: 0, includesGrantDay: false },
        sampleCount: 30,
      },
    });

    const early = taxOnLotSale({
      lot: lotOf(19, d(2025, 6, 1), estimated),
      shares: 19,
      salePrice: price("280"),
      soldOn: d(2025, 6, 1),
      rates: SECTION_102_RATES,
    });
    const late = taxOnLotSale({
      lot: lotOf(19, d(2026, 8, 11), estimated),
      shares: 19,
      salePrice: price("280"),
      soldOn: d(2026, 8, 11),
      rates: SECTION_102_RATES,
    });

    expect(early.grantPrice).toBeNull();
    expect(early.restsOnEstimate).toBe(false);
    expect(late.restsOnEstimate).toBe(true);
  });
});

// --- the treatment is never chosen by hand -----------------------------------------

describe("choosing the treatment", () => {
  const lot = lotOf(19, d(2026, 8, 11));

  it("reads the lot's own clock on the day before, the day of, and the day after", () => {
    // Granted 2024-01-15, so the twenty-four months run out on 2026-01-15.
    expect(treatmentOn(lot, d(2026, 1, 14))).toBe("unqualified");
    expect(treatmentOn(lot, d(2026, 1, 15))).toBe("qualified");
    expect(treatmentOn(lot, d(2026, 1, 16))).toBe("qualified");
  });

  it("prices a sale by its own date and not by when the position was read", () => {
    // The lot is Qualified as the position stands today; a sale dated before the
    // boundary is still an early sale, and is priced as one.
    expect(lot.qualified).toBe(true);
    expect(
      taxOnLotSale({
        lot,
        shares: 19,
        salePrice: price("280"),
        soldOn: d(2025, 6, 1),
        rates: SECTION_102_RATES,
      }).treatment,
    ).toBe("unqualified");
  });

  it("gives two lots under two grants their own treatments inside one sale", () => {
    const older = buildGrant("g-old", {
      personId: "eden",
      reference: "RSU-2023",
      grantedOn: d(2023, 5, 1),
      totalShares: 100,
      grantPrice: statedGrantPrice(price("100")),
    });
    const newer = buildGrant("g-new", {
      personId: "eden",
      reference: "RSU-2025",
      grantedOn: d(2025, 5, 1),
      totalShares: 100,
      grantPrice: statedGrantPrice(price("200")),
    });

    const position = positionOf({
      grants: [older, newer],
      vests: [
        buildVest("v-old", { grantId: "g-old", vestedOn: d(2023, 6, 1), shares: 10, priceAtVest: price("120") }, older),
        buildVest("v-new", { grantId: "g-new", vestedOn: d(2025, 6, 1), shares: 10, priceAtVest: price("210") }, newer),
      ],
      asOf: d(2026, 8, 11),
    });

    const sale = sellFromPosition({
      position,
      shares: 20,
      salePrice: price("280"),
      soldOn: d(2026, 8, 11),
      rates: SECTION_102_RATES,
    });

    expect(sale.lines.map((line) => line.treatment)).toEqual(["qualified", "unqualified"]);
    expect(sale.qualifiedShares).toBe(10);
    expect(sale.unqualifiedShares).toBe(10);
  });
});

// --- selling a number of shares ------------------------------------------------------

describe("selling a number of shares", () => {
  const position = positionOf({
    vests: [
      buildVest("v1", { grantId: "g1", vestedOn: d(2024, 11, 11), shares: 19, priceAtVest: price("220") }, GRANT),
      buildVest("v2", { grantId: "g1", vestedOn: d(2025, 5, 11), shares: 30, priceAtVest: price("240") }, GRANT),
    ],
    asOf: d(2026, 8, 11),
  });

  it("draws on the lots in the order it was given, oldest first by default", () => {
    const sale = sellFromPosition({
      position,
      shares: 25,
      salePrice: price("280"),
      soldOn: d(2026, 8, 11),
      rates: SECTION_102_RATES,
    });

    expect(sale.lines.map((line) => [line.lot.vest.id, line.shares])).toEqual([
      ["v1", 19],
      ["v2", 6],
    ]);
    expect(sale.shares).toBe(25);
    expect(sale.shortfallShares).toBe(0);
    expect(oldestFirst(position).map((lot) => lot.vest.id)).toEqual(["v1", "v2"]);
  });

  it("reports what it could not fill rather than refusing the question", () => {
    const sale = sellFromPosition({
      position,
      shares: 500,
      salePrice: price("280"),
      soldOn: d(2026, 8, 11),
      rates: SECTION_102_RATES,
    });

    expect(sale.requestedShares).toBe(500);
    expect(sale.shares).toBe(49);
    expect(sale.shortfallShares).toBe(451);
  });

  it("sums its components to the total with nothing left over", () => {
    const sale = sellFromPosition({
      position,
      shares: 49,
      salePrice: price("287.77"),
      soldOn: d(2026, 8, 11),
      rates: SECTION_102_RATES,
      fees: { brokerPerShare: price("0.0133"), brokerFlat: usd(9.99), trusteeBasisPoints: 37 },
    });

    expect(add(sale.ordinaryIncome, sale.capitalGain)).toEqual(sale.grossProceeds);
    expect(add(sale.ordinaryTax, sale.capitalGainsTax)).toEqual(sale.totalTax);
    expect(add(sale.fees.broker, sale.fees.trustee)).toEqual(sale.fees.total);
    expect(subtract(subtract(sale.grossProceeds, sale.totalTax), sale.fees.total)).toEqual(
      sale.netProceeds,
    );
  });

  it("sells nothing out of a position holding nothing", () => {
    const empty = positionOf({ vests: [], asOf: d(2026, 8, 11) });
    const sale = sellFromPosition({
      position: empty,
      shares: 10,
      salePrice: price("280"),
      soldOn: d(2026, 8, 11),
      rates: SECTION_102_RATES,
    });

    expect(sale.shares).toBe(0);
    expect(sale.shortfallShares).toBe(10);
    expect(sale.grossProceeds.minorUnits).toBe(0);
    expect(sale.netProceeds.minorUnits).toBe(0);
  });

  it("refuses a share count that is not a whole count of shares", () => {
    expect(() =>
      sellFromPosition({
        position,
        shares: -1,
        salePrice: price("280"),
        soldOn: d(2026, 8, 11),
        rates: SECTION_102_RATES,
      }),
    ).toThrow(InvalidSaleQuantityError);
    expect(() =>
      taxOnLotSale({
        lot: lotOf(19),
        shares: 20,
        salePrice: price("280"),
        soldOn: d(2026, 8, 11),
        rates: SECTION_102_RATES,
      }),
    ).toThrow(InvalidSaleQuantityError);
  });
});

// --- fees come off the net, never off the base -----------------------------------------

describe("fees", () => {
  const position = positionOf({
    vests: [
      buildVest("v1", { grantId: "g1", vestedOn: d(2024, 11, 11), shares: 19, priceAtVest: price("220") }, GRANT),
      buildVest("v2", { grantId: "g1", vestedOn: d(2025, 5, 11), shares: 30, priceAtVest: price("240") }, GRANT),
    ],
    asOf: d(2026, 8, 11),
  });

  const sell = (fees: Parameters<typeof sellFromPosition>[0]["fees"]) =>
    sellFromPosition({
      position,
      shares: 49,
      salePrice: price("280"),
      soldOn: d(2026, 8, 11),
      rates: SECTION_102_RATES,
      fees,
    });

  it("leave the taxable base and the tax exactly where they were", () => {
    const free = sell(NO_FEES);
    const charged = sell({ brokerPerShare: price("0.01"), brokerFlat: usd(15), trusteeBasisPoints: 50 });

    expect(charged.ordinaryIncome).toEqual(free.ordinaryIncome);
    expect(charged.capitalGain).toEqual(free.capitalGain);
    expect(charged.totalTax).toEqual(free.totalTax);
  });

  it("come out of the net, to the cent", () => {
    const free = sell(NO_FEES);
    const charged = sell({ brokerPerShare: price("0.01"), brokerFlat: usd(15), trusteeBasisPoints: 50 });

    // 49¢ of commission, $15.00 flat, and 0.5% of 49 × $280 = $68.60.
    expect(charged.fees.broker.minorUnits).toBe(15_49);
    expect(charged.fees.trustee.minorUnits).toBe(68_60);
    expect(charged.fees.total.minorUnits).toBe(84_09);
    expect(subtract(free.netProceeds, charged.netProceeds).minorUnits).toBe(84_09);
  });

  it("charge a flat commission once over a sale, however many lots it drew on", () => {
    const flat = { brokerPerShare: null, brokerFlat: usd(15), trusteeBasisPoints: 0 };
    const oneLot = sellFromPosition({
      position,
      shares: 19,
      salePrice: price("280"),
      soldOn: d(2026, 8, 11),
      rates: SECTION_102_RATES,
      fees: flat,
    });
    const twoLots = sell(flat);

    expect(oneLot.lines).toHaveLength(1);
    expect(twoLots.lines).toHaveLength(2);
    expect(oneLot.fees.total.minorUnits).toBe(15_00);
    expect(twoLots.fees.total.minorUnits).toBe(15_00);
  });
});

// --- what waiting is worth ---------------------------------------------------------------

describe("what waiting is worth", () => {
  it("prices one lot today and again once Qualified, and states the difference", () => {
    // Read on 2025-06-01, four months short of nothing: the grant of 2024-01-15
    // qualifies on 2026-01-15.
    const lot = lotOf(19, d(2025, 6, 1));
    const worth = waitingValue({
      lot,
      salePrice: price("280"),
      asOf: d(2025, 6, 1),
      rates: SECTION_102_RATES,
    });

    expect(worth.alreadyQualified).toBe(false);
    expect(worth.qualifiedFrom).toEqual(d(2026, 1, 15));
    expect(worth.today.totalTax.minorUnits).toBe(330_744);
    expect(worth.onceQualified.totalTax.minorUnits).toBe(238_527);
    // $2,012.56 today against $2,934.73 once the clock has run.
    expect(worth.today.netProceeds.minorUnits).toBe(201_256);
    expect(worth.onceQualified.netProceeds.minorUnits).toBe(293_473);
    expect(worth.difference.minorUnits).toBe(92_217);
  });

  it("holds the price flat between the two, so the clock is what is measured", () => {
    const lot = lotOf(19, d(2025, 6, 1));
    const worth = waitingValue({
      lot,
      salePrice: price("280"),
      asOf: d(2025, 6, 1),
      rates: SECTION_102_RATES,
    });

    expect(worth.onceQualified.grossProceeds).toEqual(worth.today.grossProceeds);
    expect(worth.onceQualified.salePrice).toEqual(worth.today.salePrice);
  });

  it("says outright that a Qualified lot has nothing to wait for", () => {
    const worth = waitingValue({
      lot: lotOf(19, d(2026, 8, 11)),
      salePrice: price("280"),
      asOf: d(2026, 8, 11),
      rates: SECTION_102_RATES,
    });

    expect(worth.alreadyQualified).toBe(true);
    expect(worth.difference.minorUnits).toBe(0);
  });

  it("ranks the lots by what the waiting is worth, largest first", () => {
    const newer = buildGrant("g-new", {
      personId: "eden",
      reference: "RSU-2025",
      grantedOn: d(2025, 5, 1),
      totalShares: 100,
      grantPrice: statedGrantPrice(price("200")),
    });
    const position = positionOf({
      grants: [GRANT, newer],
      vests: [
        buildVest("v1", { grantId: "g1", vestedOn: d(2024, 11, 11), shares: 19, priceAtVest: price("220") }, GRANT),
        buildVest("v2", { grantId: "g-new", vestedOn: d(2025, 6, 1), shares: 40, priceAtVest: price("210") }, newer),
      ],
      asOf: d(2026, 8, 11),
    });

    const ranked = waitingValues({ position, salePrice: price("280"), rates: SECTION_102_RATES });

    expect(ranked.map((entry) => entry.lot.vest.id)).toEqual(["v2", "v1"]);
    expect(ranked[0]?.alreadyQualified).toBe(false);
    expect(ranked[1]?.difference.minorUnits).toBe(0);
  });

  it("charges the fees on both sides, so the difference is the clock and not the broker", () => {
    const fees = { brokerPerShare: price("0.01"), brokerFlat: usd(15), trusteeBasisPoints: 50 };
    const free = waitingValue({
      lot: lotOf(19, d(2025, 6, 1)),
      salePrice: price("280"),
      asOf: d(2025, 6, 1),
      rates: SECTION_102_RATES,
    });
    const charged = waitingValue({
      lot: lotOf(19, d(2025, 6, 1)),
      salePrice: price("280"),
      asOf: d(2025, 6, 1),
      rates: SECTION_102_RATES,
      fees,
    });

    expect(charged.today.fees.total.minorUnits).toBe(charged.onceQualified.fees.total.minorUnits);
    expect(charged.difference).toEqual(free.difference);
  });
});

// --- the rates are the household's, not the code's -----------------------------------------

describe("the rates are settings", () => {
  it("change the figure when the household changes them", () => {
    const lot = lotOf(19);
    const asRead = taxOnLotSale({
      lot,
      shares: 19,
      salePrice: price("280"),
      soldOn: d(2026, 8, 11),
      rates: SECTION_102_RATES,
    });
    const corrected = taxOnLotSale({
      lot,
      shares: 19,
      salePrice: price("280"),
      soldOn: d(2026, 8, 11),
      rates: { ordinaryBasisPoints: 5_000, capitalGainsBasisPoints: 2_500 },
    });

    expect(asRead.ordinaryTax.minorUnits).toBe(176_502);
    expect(corrected.ordinaryTax.minorUnits).toBe(141_951);
    expect(corrected.capitalGainsTax).toEqual(asRead.capitalGainsTax);
  });
});
