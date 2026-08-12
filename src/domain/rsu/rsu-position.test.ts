import { describe, expect, it } from "vitest";

import { money } from "@/domain/money/money";
import { calendarDate } from "@/domain/time/calendar-date";

import {
  type DailyClose,
  type Grant,
  type Sale,
  type Vest,
  DEFAULT_GP_WINDOW,
  GrantOversubscribedError,
  InvalidDailyCloseError,
  InvalidGpWindowError,
  InvalidGrantError,
  InvalidSaleError,
  InvalidSharePriceError,
  InvalidVestError,
  LotOversoldError,
  QUALIFYING_MONTHS,
  SECTION_102_WINDOW,
  SHEET_WINDOW,
  UnknownGrantError,
  UnknownVestError,
  averagePrice,
  buildGpWindow,
  buildGrant,
  buildSale,
  buildVest,
  closesInWindow,
  emptyPosition,
  estimateGrantPrice,
  forwardSchedule,
  gpWindowKey,
  gpWindowsEqual,
  isEstimated,
  isQualifiedOn,
  isStaleEstimate,
  nextQualificationDate,
  parseDailyCloses,
  parseGpWindow,
  parseSharePriceInput,
  qualifiesOn,
  readPosition,
  requireGrant,
  requireVest,
  requireWithinGrant,
  requireWithinLot,
  rsuHolding,
  sharePrice,
  sharePriceFromMajorUnits,
  sharePriceToDecimalString,
  statedGrantPrice,
  valueOf,
} from "./rsu-position";

/**
 * Plain data in, plain data out: no database, no browser, no network. The clock is
 * always a parameter — a boundary that moves with time can only be tested by
 * naming the day either side of it, and that is the whole of this phase.
 */

const d = (year: number, month: number, day: number) => calendarDate(year, month, day);
const usd = (major: number) => money(Math.round(major * 100), "USD");
const price = (major: number | string) => sharePriceFromMajorUnits(major, "USD");

// --- a price per share -------------------------------------------------------

describe("a price per share", () => {
  it("holds four decimal places exactly, which cents cannot", () => {
    // The household's own GP figure. Rounded to the cent it would be 149.42, and
    // that difference multiplies through every share it prices.
    expect(price("149.4219").tenThousandths).toBe(1_494_219);
    expect(sharePriceToDecimalString(price("149.4219"))).toBe("149.4219");
  });

  it("round-trips what a person typed, untouched", () => {
    const typed = parseSharePriceInput(" $280.00 ", "USD");
    expect(typed).not.toBeNull();
    expect(sharePriceToDecimalString(typed as never)).toBe("280.0000");
  });

  it("reads a blank field as nothing stated rather than as zero", () => {
    expect(parseSharePriceInput("", "USD")).toBeNull();
    expect(parseSharePriceInput("   ", "USD")).toBeNull();
  });

  it("refuses anything that is not a price", () => {
    expect(() => parseSharePriceInput("about 280", "USD")).toThrow(InvalidSharePriceError);
    expect(() => sharePrice(-1, "USD")).toThrow(InvalidSharePriceError);
    expect(() => sharePrice(1.5, "USD")).toThrow(InvalidSharePriceError);
  });

  it("multiplies out to exact cents, rounding once at the end", () => {
    // 149.4219 × 19 = 2,839.0161, which is $2,839.02 and not a float near it.
    expect(valueOf(price("149.4219"), 19)).toEqual(usd(2_839.02));
    expect(valueOf(price("149.4219"), 19).minorUnits).toBe(283_902);
    expect(valueOf(price("280"), 19).minorUnits).toBe(532_000);
    expect(valueOf(price("280"), 0).minorUnits).toBe(0);
  });

  it("averages exactly, rounding half away from zero", () => {
    // (100.0000 + 101.0001) ÷ 2 = 100.50005, which rounds up to 100.5001.
    expect(averagePrice([price("100"), price("101.0001")])?.tenThousandths).toBe(1_005_001);
    expect(averagePrice([price("1"), price("2"), price("4")])?.tenThousandths).toBe(23_333);
  });

  it("has no average over nothing", () => {
    expect(averagePrice([])).toBeNull();
  });
});

// --- grants, vests and sales -------------------------------------------------

/** Apple's grant shape: one award, vesting in slices over the following years. */
function grantOf(overrides: Partial<Parameters<typeof buildGrant>[1]> = {}): Grant {
  return buildGrant("g1", {
    personId: "eden",
    reference: "RSU-2024-001",
    grantedOn: d(2024, 1, 15),
    totalShares: 400,
    ...overrides,
  });
}

describe("a grant", () => {
  it("records its ID, its date and its total shares", () => {
    const grant = grantOf();
    expect(grant.reference).toBe("RSU-2024-001");
    expect(grant.grantedOn).toEqual(d(2024, 1, 15));
    expect(grant.totalShares).toBe(400);
  });

  it("keeps the document's own ID as written, in English", () => {
    expect(grantOf({ reference: "  RSU-2024-001  " }).reference).toBe("RSU-2024-001");
  });

  it("refuses a grant with no ID or no shares", () => {
    expect(() => grantOf({ reference: "" })).toThrow(InvalidGrantError);
    expect(() => grantOf({ totalShares: 0 })).toThrow(InvalidGrantError);
    expect(() => grantOf({ totalShares: 12.5 })).toThrow(InvalidGrantError);
  });

  it("is resolved by id, and says so when there is no such grant", () => {
    expect(requireGrant([grantOf()], "g1").reference).toBe("RSU-2024-001");
    expect(() => requireGrant([grantOf()], "nope")).toThrow(UnknownGrantError);
  });
});

describe("a vest", () => {
  const grant = grantOf();

  it("records its date, its shares and the price on the day", () => {
    const vest = buildVest(
      "v1",
      { grantId: "g1", vestedOn: d(2024, 7, 15), shares: 100, priceAtVest: price("212.50") },
      grant,
    );
    expect(vest.vestedOn).toEqual(d(2024, 7, 15));
    expect(vest.shares).toBe(100);
    expect(sharePriceToDecimalString(vest.priceAtVest)).toBe("212.5000");
  });

  it("cannot vest before the grant that awarded it", () => {
    expect(() =>
      buildVest(
        "v1",
        { grantId: "g1", vestedOn: d(2023, 12, 31), shares: 100, priceAtVest: price("212.50") },
        grant,
      ),
    ).toThrow(InvalidVestError);
  });

  it("cannot belong to a grant other than the one it is built against", () => {
    expect(() =>
      buildVest(
        "v1",
        { grantId: "other", vestedOn: d(2024, 7, 15), shares: 100, priceAtVest: price("212.50") },
        grant,
      ),
    ).toThrow(InvalidVestError);
  });

  it("cannot claim more shares than the grant awarded", () => {
    const vests = [
      buildVest("v1", { grantId: "g1", vestedOn: d(2024, 7, 15), shares: 350, priceAtVest: price("212.50") }, grant),
    ];
    expect(() => requireWithinGrant({ grant, vests, additionalShares: 50 })).not.toThrow();
    expect(() => requireWithinGrant({ grant, vests, additionalShares: 51 })).toThrow(
      GrantOversubscribedError,
    );
  });

  it("does not count a vest being corrected against itself", () => {
    const vests = [
      buildVest("v1", { grantId: "g1", vestedOn: d(2024, 7, 15), shares: 400, priceAtVest: price("212.50") }, grant),
    ];
    expect(() =>
      requireWithinGrant({ grant, vests, additionalShares: 400, replacingVestId: "v1" }),
    ).not.toThrow();
  });
});

describe("a sale", () => {
  const grant = grantOf();
  const vest = buildVest(
    "v1",
    { grantId: "g1", vestedOn: d(2024, 7, 15), shares: 100, priceAtVest: price("212.50") },
    grant,
  );

  it("names the lot it came out of", () => {
    const sale = buildSale(
      "s1",
      { vestId: "v1", soldOn: d(2026, 3, 1), shares: 19, price: price("280") },
      vest,
    );
    expect(sale.vestId).toBe("v1");
    expect(sale.shares).toBe(19);
  });

  it("cannot be dated before the vest it sells", () => {
    expect(() =>
      buildSale("s1", { vestId: "v1", soldOn: d(2024, 7, 14), shares: 19, price: price("280") }, vest),
    ).toThrow(InvalidSaleError);
  });

  it("cannot take more shares than the lot holds", () => {
    const sales = [
      buildSale("s1", { vestId: "v1", soldOn: d(2026, 3, 1), shares: 60, price: price("280") }, vest),
    ];
    expect(() => requireWithinLot({ vest, sales, additionalShares: 40 })).not.toThrow();
    expect(() => requireWithinLot({ vest, sales, additionalShares: 41 })).toThrow(LotOversoldError);
  });

  it("reports the room it had when it refuses", () => {
    const sales = [
      buildSale("s1", { vestId: "v1", soldOn: d(2026, 3, 1), shares: 60, price: price("280") }, vest),
    ];
    try {
      requireWithinLot({ vest, sales, additionalShares: 41 });
      expect.unreachable("the lot holds 40");
    } catch (error) {
      expect(error).toBeInstanceOf(LotOversoldError);
      expect((error as LotOversoldError).remaining).toBe(40);
      expect((error as LotOversoldError).attempted).toBe(41);
    }
  });

  it("is resolved by lot, and says so when there is no such lot", () => {
    expect(requireVest([vest], "v1").shares).toBe(100);
    expect(() => requireVest([vest], "nope")).toThrow(UnknownVestError);
  });
});

// --- the 24-month clock ------------------------------------------------------

describe("סעיף 102's twenty-four months", () => {
  it("runs from the grant date, not the vest date", () => {
    expect(QUALIFYING_MONTHS).toBe(24);
    expect(qualifiesOn(d(2024, 1, 15))).toEqual(d(2026, 1, 15));
  });

  it("is correct on the day before, the day of, and the day after", () => {
    const granted = d(2024, 1, 15);
    expect(isQualifiedOn(granted, d(2026, 1, 14))).toBe(false);
    expect(isQualifiedOn(granted, d(2026, 1, 15))).toBe(true);
    expect(isQualifiedOn(granted, d(2026, 1, 16))).toBe(true);
  });

  it("clamps to the last day of a month that has no such date", () => {
    // 29 February 2024 plus twenty-four months. The 29th never arrives in 2026,
    // and the clock cannot simply keep running to March.
    expect(qualifiesOn(d(2024, 2, 29))).toEqual(d(2026, 2, 28));
    expect(isQualifiedOn(d(2024, 2, 29), d(2026, 2, 27))).toBe(false);
    expect(isQualifiedOn(d(2024, 2, 29), d(2026, 2, 28))).toBe(true);
  });

  it("crosses a year boundary the way a month count does, not a day count", () => {
    // Twenty-four months from 31 December is 31 December, whether or not a leap
    // day fell inside the span. 730 days would land a day out.
    expect(qualifiesOn(d(2023, 12, 31))).toEqual(d(2025, 12, 31));
  });

  it("is derived on every read, so the same lot gives two answers on two days", () => {
    const grant = grantOf();
    const vests = [
      buildVest("v1", { grantId: "g1", vestedOn: d(2024, 7, 15), shares: 100, priceAtVest: price("212.50") }, grant),
    ];

    const before = readPosition({ grants: [grant], vests, sales: [], asOf: d(2026, 1, 14) });
    const after = readPosition({ grants: [grant], vests, sales: [], asOf: d(2026, 1, 15) });

    expect(before.unqualifiedShares).toBe(100);
    expect(before.qualifiedShares).toBe(0);
    expect(after.qualifiedShares).toBe(100);
    expect(after.unqualifiedShares).toBe(0);
    // Nothing was written between the two reads. The inputs are identical.
    expect(vests[0]).toEqual(
      buildVest("v1", { grantId: "g1", vestedOn: d(2024, 7, 15), shares: 100, priceAtVest: price("212.50") }, grant),
    );
  });
});

// --- the position ------------------------------------------------------------

/**
 * Two grants, two years apart, so one side of the position is Qualified and the
 * other is not on the same day.
 */
function position(asOf: ReturnType<typeof d>, sales: readonly Sale[] = []) {
  const older = buildGrant("g-old", {
    personId: "eden",
    reference: "RSU-2023-A",
    grantedOn: d(2023, 5, 10),
    totalShares: 300,
  });
  const newer = buildGrant("g-new", {
    personId: "eden",
    reference: "RSU-2025-B",
    grantedOn: d(2025, 5, 10),
    totalShares: 200,
  });

  const vests: Vest[] = [
    buildVest("v-old", { grantId: "g-old", vestedOn: d(2024, 5, 10), shares: 120, priceAtVest: price("180") }, older),
    buildVest("v-new", { grantId: "g-new", vestedOn: d(2026, 5, 10), shares: 80, priceAtVest: price("240") }, newer),
    // Recorded ahead of its date so the forecast has something to work with.
    buildVest("v-future", { grantId: "g-new", vestedOn: d(2027, 5, 10), shares: 60, priceAtVest: price("250") }, newer),
  ];

  return {
    grants: [older, newer],
    vests,
    reading: readPosition({ grants: [older, newer], vests, sales, asOf }),
  };
}

const READ_ON = d(2026, 8, 11);

describe("the position", () => {
  it("splits held shares into Qualified and Unqualified", () => {
    const { reading } = position(READ_ON);
    // The 2023 grant's clock ran out in May 2025; the 2025 grant's runs to May 2027.
    expect(reading.qualifiedShares).toBe(120);
    expect(reading.unqualifiedShares).toBe(80);
    expect(reading.remainingShares).toBe(200);
  });

  it("excludes a vest whose date has not come, and reports it separately", () => {
    const { reading } = position(READ_ON);
    expect(reading.futureShares).toBe(60);
    expect(reading.future.map((entry) => entry.vest.id)).toEqual(["v-future"]);
    // 120 + 80 held, and not a share of the 60 ahead.
    expect(reading.remainingShares).toBe(200);
    expect(reading.lots.map((lot) => lot.vest.id)).toEqual(["v-old", "v-new"]);
  });

  it("brings a future vest into the position on the day it vests, and not before", () => {
    const dayBefore = position(d(2027, 5, 9)).reading;
    const dayOf = position(d(2027, 5, 10)).reading;
    expect(dayBefore.remainingShares).toBe(200);
    expect(dayBefore.futureShares).toBe(60);
    expect(dayOf.remainingShares).toBe(260);
    expect(dayOf.futureShares).toBe(0);
  });

  it("reduces the lot a sale names, and no other", () => {
    const { vests } = position(READ_ON);
    const lot = vests[0] as Vest;
    const sales = [
      buildSale("s1", { vestId: "v-old", soldOn: d(2026, 6, 1), shares: 45, price: price("280") }, lot),
    ];
    const { reading } = position(READ_ON, sales);

    expect(reading.qualifiedShares).toBe(75);
    expect(reading.unqualifiedShares).toBe(80);
    expect(reading.soldShares).toBe(45);

    const sold = reading.lots.find((entry) => entry.vest.id === "v-old");
    const untouched = reading.lots.find((entry) => entry.vest.id === "v-new");
    expect(sold?.remainingShares).toBe(75);
    expect(sold?.soldShares).toBe(45);
    expect(untouched?.remainingShares).toBe(80);
    expect(untouched?.soldShares).toBe(0);
  });

  it("does not count a sale that has not happened yet", () => {
    const { vests } = position(READ_ON);
    const lot = vests[0] as Vest;
    const sales = [
      buildSale("s1", { vestId: "v-old", soldOn: d(2026, 9, 1), shares: 45, price: price("280") }, lot),
    ];
    expect(position(READ_ON, sales).reading.qualifiedShares).toBe(120);
    expect(position(d(2026, 9, 1), sales).reading.qualifiedShares).toBe(75);
  });

  it("values held shares at what they were worth when they vested", () => {
    const { reading } = position(READ_ON);
    expect(reading.qualifiedValueAtVest).toEqual(usd(120 * 180));
    expect(reading.unqualifiedValueAtVest).toEqual(usd(80 * 240));
  });

  it("holds each grant against its own paperwork", () => {
    const { reading } = position(READ_ON);
    const older = reading.grants.find((entry) => entry.grant.id === "g-old");
    const newer = reading.grants.find((entry) => entry.grant.id === "g-new");

    expect(older?.totalShares).toBe(300);
    expect(older?.scheduledShares).toBe(120);
    // Awarded but with no vest row against it yet — visible rather than assumed.
    expect(older?.unscheduledShares).toBe(180);
    expect(newer?.scheduledShares).toBe(140);
    expect(newer?.vestedShares).toBe(80);
  });

  it("names the day the next Unqualified lot crosses", () => {
    expect(nextQualificationDate(position(READ_ON).reading)).toEqual(d(2027, 5, 10));
    // Once everything held has crossed there is nothing to wait for.
    expect(nextQualificationDate(position(d(2027, 6, 1)).reading)).toBeNull();
  });

  it("reads a household that has recorded nothing as nothing, not as a failure", () => {
    const empty = readPosition({ grants: [], vests: [], sales: [], asOf: READ_ON });
    expect(empty).toEqual(emptyPosition(READ_ON));
    expect(empty.remainingShares).toBe(0);
    expect(empty.qualifiedValueAtVest.minorUnits).toBe(0);
  });

  it("keeps a lot sold down to nothing out of the counts but in the record", () => {
    const { vests } = position(READ_ON);
    const lot = vests[0] as Vest;
    const sales = [
      buildSale("s1", { vestId: "v-old", soldOn: d(2026, 6, 1), shares: 120, price: price("280") }, lot),
    ];
    const { reading } = position(READ_ON, sales);
    expect(reading.qualifiedShares).toBe(0);
    expect(reading.lots.map((entry) => entry.vest.id)).toContain("v-old");
  });
});

// --- the GP window -----------------------------------------------------------

describe("the GP window", () => {
  it("starts at the סעיף 102 reading — the thirty trading days preceding the grant", () => {
    expect(DEFAULT_GP_WINDOW).toEqual(SECTION_102_WINDOW);
    expect(SECTION_102_WINDOW).toEqual({
      basis: "trading",
      before: 30,
      after: 0,
      includesGrantDay: false,
    });
  });

  it("can express what the sheet does instead, in the same shape", () => {
    expect(SHEET_WINDOW).toEqual({ basis: "calendar", before: 15, after: 15, includesGrantDay: true });
    expect(gpWindowsEqual(SHEET_WINDOW, SECTION_102_WINDOW)).toBe(false);
  });

  it("round-trips through the text it is stored as", () => {
    for (const window of [SECTION_102_WINDOW, SHEET_WINDOW]) {
      expect(parseGpWindow(gpWindowKey(window))).toEqual(window);
    }
    expect(gpWindowKey(SECTION_102_WINDOW)).toBe("trading:30:0:excl");
    expect(gpWindowKey(SHEET_WINDOW)).toBe("calendar:15:15:incl");
  });

  it("refuses a window that would average nothing", () => {
    expect(() => buildGpWindow({ basis: "trading", before: 0, after: 0, includesGrantDay: false })).toThrow(
      InvalidGpWindowError,
    );
  });

  it("refuses a basis or a span it does not know", () => {
    expect(() => parseGpWindow("weekly:30:0:excl")).toThrow(InvalidGpWindowError);
    expect(() => parseGpWindow("trading:30:0")).toThrow(InvalidGpWindowError);
    expect(() => parseGpWindow("trading:30:0:maybe")).toThrow(InvalidGpWindowError);
    expect(() => buildGpWindow({ basis: "trading", before: -1, after: 0, includesGrantDay: true })).toThrow(
      InvalidGpWindowError,
    );
  });
});

/**
 * A run of closes with the weekend missing, because the trading basis counts
 * sessions and the calendar basis counts days — and the difference between them
 * only shows up where the market was shut.
 */
function closesAround(): readonly DailyClose[] {
  const days: DailyClose[] = [];
  // 1–19 June 2026. The 6th, 7th, 13th and 14th are weekends and have no close.
  for (let day = 1; day <= 19; day += 1) {
    const date = d(2026, 6, day);
    const weekday = new Date(Date.UTC(2026, 5, day)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    days.push({ on: date, close: price(100 + day) });
  }
  return days;
}

describe("estimating GP from market data", () => {
  const grantedOn = d(2026, 6, 10);

  it("counts sessions on the trading basis, so weekends do not shorten the sample", () => {
    const sample = closesInWindow(closesAround(), grantedOn, {
      basis: "trading",
      before: 5,
      after: 0,
      includesGrantDay: false,
    });
    // The five sessions before the 10th are the 8th, 9th and — skipping the
    // weekend — the 3rd, 4th and 5th. Not "the five days before".
    expect(sample.map((close) => close.on.day)).toEqual([3, 4, 5, 8, 9]);
  });

  it("counts days on the calendar basis, so a weekend inside the span shortens it", () => {
    const sample = closesInWindow(closesAround(), grantedOn, {
      basis: "calendar",
      before: 5,
      after: 0,
      includesGrantDay: false,
    });
    // The 5th to the 9th as dates, of which the 6th and 7th did not trade.
    expect(sample.map((close) => close.on.day)).toEqual([5, 8, 9]);
  });

  it("leaves the grant's own day out when the window says to, and in when it does not", () => {
    const excluded = closesInWindow(closesAround(), grantedOn, {
      basis: "calendar",
      before: 2,
      after: 2,
      includesGrantDay: false,
    });
    const included = closesInWindow(closesAround(), grantedOn, {
      basis: "calendar",
      before: 2,
      after: 2,
      includesGrantDay: true,
    });
    expect(excluded.map((close) => close.on.day)).toEqual([8, 9, 11, 12]);
    expect(included.map((close) => close.on.day)).toEqual([8, 9, 10, 11, 12]);
  });

  it("produces an estimate that carries the window and the sample behind it", () => {
    const estimate = estimateGrantPrice({
      closes: closesAround(),
      grantedOn,
      window: { basis: "trading", before: 5, after: 0, includesGrantDay: false },
    });

    expect(estimate).not.toBeNull();
    expect(isEstimated(estimate as never)).toBe(true);
    expect(estimate?.sampleCount).toBe(5);
    expect(estimate?.window).toEqual({ basis: "trading", before: 5, after: 0, includesGrantDay: false });
    // (103 + 104 + 105 + 108 + 109) ÷ 5 = 105.80 exactly.
    expect(estimate?.price.tenThousandths).toBe(1_058_000);
  });

  it("has no estimate where no close falls inside the window", () => {
    const estimate = estimateGrantPrice({
      closes: closesAround(),
      grantedOn: d(2027, 6, 10),
      window: { basis: "calendar", before: 3, after: 3, includesGrantDay: true },
    });
    // An average over nothing is not an estimate, and a grant with no figure is a
    // better state than a grant with an invented one.
    expect(estimate).toBeNull();
  });

  it("changes the figure when the window changes, which is why the window is a setting", () => {
    const closes = closesAround();
    const underSheet = estimateGrantPrice({ closes, grantedOn, window: SHEET_WINDOW });
    const under102 = estimateGrantPrice({ closes, grantedOn, window: SECTION_102_WINDOW });

    expect(underSheet).not.toBeNull();
    expect(under102).not.toBeNull();
    expect(underSheet?.price.tenThousandths).not.toBe(under102?.price.tenThousandths);
  });

  it("tells a stated price from an estimated one", () => {
    const stated = statedGrantPrice(price("149.4219"));
    expect(isEstimated(stated)).toBe(false);
    expect(stated.window).toBeNull();
    expect(stated.sampleCount).toBeNull();
  });

  it("reads closes as they are pasted, and refuses a line it cannot read", () => {
    const closes = parseDailyCloses(
      ["2026-06-08  212.50", "", "2026-06-09,213.7500", "2026-06-10\t214"].join("\n"),
      "USD",
    );
    expect(closes.map((close) => close.on.day)).toEqual([8, 9, 10]);
    expect(closes[1]?.close.tenThousandths).toBe(2_137_500);

    // Dropping an unreadable line would leave an average nobody can check.
    expect(() => parseDailyCloses("2026-06-08 212.50\nlast week: 213", "USD")).toThrow(
      InvalidDailyCloseError,
    );
    expect(() => parseDailyCloses("2026-06-08 212.50\n2026-06-08 213.00", "USD")).toThrow(
      InvalidDailyCloseError,
    );
  });

  it("knows an estimate taken under a window the household has since changed", () => {
    const estimate = estimateGrantPrice({
      closes: closesAround(),
      grantedOn,
      window: SHEET_WINDOW,
    });

    expect(isStaleEstimate(estimate as never, SHEET_WINDOW)).toBe(false);
    expect(isStaleEstimate(estimate as never, SECTION_102_WINDOW)).toBe(true);
    // A stated price depends on no window, so no window can make it stale.
    expect(isStaleEstimate(statedGrantPrice(price("149.4219")), SECTION_102_WINDOW)).toBe(false);
  });
});

// --- the forward schedule ----------------------------------------------------

describe("the forward vest schedule", () => {
  it("lists the vests still ahead, at today's price", () => {
    const { reading } = position(READ_ON);
    const schedule = forwardSchedule(reading, price("300"));

    expect(schedule.rows.map((row) => row.vest.id)).toEqual(["v-future"]);
    // 60 shares at $300, and nothing about the vest's own recorded price of $250.
    expect(schedule.rows[0]?.value).toEqual(usd(18_000));
    expect(schedule.totalShares).toBe(60);
    expect(schedule.totalValue).toEqual(usd(18_000));
  });

  it("prices every row flat, with no growth between them", () => {
    const older = buildGrant("g-old", {
      personId: "eden",
      reference: "RSU-2024-A",
      grantedOn: d(2024, 1, 15),
      totalShares: 400,
    });
    const vests = [
      buildVest("v-1", { grantId: "g-old", vestedOn: d(2026, 11, 11), shares: 10, priceAtVest: price("100") }, older),
      buildVest("v-2", { grantId: "g-old", vestedOn: d(2027, 11, 11), shares: 10, priceAtVest: price("500") }, older),
    ];
    const reading = readPosition({ grants: [older], vests, sales: [], asOf: READ_ON });
    const schedule = forwardSchedule(reading, price("200"));

    // The two vests recorded wildly different prices; the forecast uses neither,
    // and uses one price for both. A schedule that grew would be a claim about
    // the share price rather than about what is already promised.
    expect(schedule.rows.map((row) => row.value)).toEqual([usd(2_000), usd(2_000)]);
    expect(schedule.price).toEqual(price("200"));
  });

  it("runs a cumulative total, soonest first", () => {
    const older = buildGrant("g-old", {
      personId: "eden",
      reference: "RSU-2024-A",
      grantedOn: d(2024, 1, 15),
      totalShares: 400,
    });
    const vests = [
      buildVest("v-2", { grantId: "g-old", vestedOn: d(2027, 11, 11), shares: 25, priceAtVest: price("100") }, older),
      buildVest("v-1", { grantId: "g-old", vestedOn: d(2026, 11, 11), shares: 15, priceAtVest: price("100") }, older),
    ];
    const reading = readPosition({ grants: [older], vests, sales: [], asOf: READ_ON });
    const schedule = forwardSchedule(reading, price("100"));

    expect(schedule.rows.map((row) => row.vest.id)).toEqual(["v-1", "v-2"]);
    expect(schedule.rows.map((row) => row.cumulativeShares)).toEqual([15, 40]);
    expect(schedule.rows.map((row) => row.cumulativeValue)).toEqual([usd(1_500), usd(4_000)]);
  });

  it("holds nothing for a position with no vests ahead of it", () => {
    const schedule = forwardSchedule(emptyPosition(READ_ON), price("300"));
    expect(schedule.rows).toEqual([]);
    expect(schedule.totalValue).toEqual(usd(0));
  });
});

// --- the position as a מיפוי figure ------------------------------------------

describe("the RSU holding", () => {
  it("is the held share count times a price, and the count comes from the records", () => {
    const { reading } = position(READ_ON);
    const holding = rsuHolding(reading, price("300"));

    // 120 Qualified + 80 Unqualified. The 60 shares vesting in 2027 are not held.
    expect(holding.shares).toBe(200);
    expect(holding.value).toEqual(usd(60_000));
    expect(holding.asOf).toEqual(READ_ON);
  });

  it("falls as shares are sold, with nothing to maintain beside it", () => {
    const before = position(READ_ON);
    const vest = before.vests.find((candidate) => candidate.id === "v-old");
    if (vest === undefined) throw new Error("fixture produced no lot");

    const after = position(READ_ON, [
      buildSale("s1", { vestId: "v-old", soldOn: d(2026, 6, 1), shares: 20, price: price("290") }, vest),
    ]);

    expect(rsuHolding(before.reading, price("300")).value).toEqual(usd(60_000));
    expect(rsuHolding(after.reading, price("300")).value).toEqual(usd(54_000));
  });

  it("is nothing for a position holding nothing, rather than an absent figure", () => {
    const holding = rsuHolding(emptyPosition(READ_ON), price("300"));
    expect(holding.shares).toBe(0);
    expect(holding.value).toEqual(usd(0));
  });

  it("rounds the product once, at the end", () => {
    const older = buildGrant("g-old", {
      personId: "eden",
      reference: "RSU-2024-A",
      grantedOn: d(2024, 1, 15),
      totalShares: 400,
    });
    const vests = [
      buildVest("v-1", { grantId: "g-old", vestedOn: d(2024, 2, 1), shares: 3, priceAtVest: price("100") }, older),
    ];
    const reading = readPosition({ grants: [older], vests, sales: [], asOf: READ_ON });

    // 3 × 149.4219 = 448.2657, one cent either way depending on where it rounds.
    expect(rsuHolding(reading, price("149.4219")).value).toEqual(money(44_827, "USD"));
  });
});
