/**
 * RsuTax — what a sale costs under both of סעיף 102's treatments, and what
 * actually lands in the bank.
 *
 * Framework-free per ADR 0004.
 *
 * The spreadsheet this replaces could express one outcome: grant price as
 * ordinary income and the appreciation above it at the capital-gains rate, which
 * is correct *once the 24 months have run*. It had no way to say what selling
 * early costs, and that gap covers the larger half of the position. Both
 * treatments live here, and neither is ever chosen by hand:
 *
 * **The treatment comes from the lot's own clock.** `treatmentOn` asks the grant
 * date and the sale date and nothing else. A sale dated before the boundary is
 * priced as an early sale even if the lot has since crossed it, and one dated
 * after is priced as a Qualified sale even when the position was read before —
 * which is what makes "what is waiting worth" a question this module can answer
 * by asking itself twice.
 *
 * **A rate is a setting, not a constant.** 62.17% and 25% are what the household
 * believes today; a marginal rate that could only move by shipping a deploy would
 * stop reading as an assumption. They arrive as basis points, the same way every
 * other percentage in the system does.
 *
 * **Fees come off the net and never off the base.** A broker commission is money
 * that did not arrive; it is not income nobody earned. Subtracting it from the
 * taxable base would quietly reduce the tax on a figure the tax authority never
 * saw reduced, and would make the two questions — what was taxed, what arrived —
 * impossible to read apart. They are charged once over a whole sale rather than
 * per lot, because a flat commission on one sale is one commission however many
 * lots the shares came out of.
 *
 * **A sale arrives as an allocation.** Which lots the shares come out of, and how
 * many out of each, is decided elsewhere and handed in whole: `sellShares` is the
 * only way into the arithmetic below, and it never learns how the allocation was
 * arrived at. Drawing oldest-first is one strategy over it (`allocateInOrder`) and
 * `LotSelector` is another, and neither can disturb a figure here by changing.
 */

import {
  type Currency,
  type Money,
  add,
  isNegative,
  money,
  multiply,
  subtract,
  sum,
  zero,
} from "@/domain/money/money";
import {
  type GrantPrice,
  type Lot,
  type RsuPosition,
  type SharePrice,
  isQualifiedOn,
  qualifiesOn,
  valueOf,
} from "@/domain/rsu/rsu-position";
import { type CalendarDate, compareDates } from "@/domain/time/calendar-date";

// --- the rates ---------------------------------------------------------------

/**
 * The two rates a sale can meet. Whole basis points, for the same reason money is
 * whole minor units: 62.17% is 6,217 exactly and is a float any other way.
 */
export interface TaxRates {
  /** The marginal rate on employment income — 62.17% as the household reads it. */
  readonly ordinaryBasisPoints: number;
  /** סעיף 102's capital-gains rate on everything above GP — 25%. */
  readonly capitalGainsBasisPoints: number;
}

export class InvalidTaxRatesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaxRatesError";
  }
}

/** Where the system starts. Both figures are settings; these are only the defaults. */
export const SECTION_102_RATES: TaxRates = {
  ordinaryBasisPoints: 6_217,
  capitalGainsBasisPoints: 2_500,
};

function requireBasisPoints(value: number, what: string, fail: (message: string) => Error): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw fail(`${what} is a whole number of basis points between 0 and 10,000, received ${String(value)}`);
  }
  return value;
}

export function buildTaxRates(rates: TaxRates): TaxRates {
  return {
    ordinaryBasisPoints: requireBasisPoints(
      rates.ordinaryBasisPoints,
      "The ordinary-income rate",
      (message) => new InvalidTaxRatesError(message),
    ),
    capitalGainsBasisPoints: requireBasisPoints(
      rates.capitalGainsBasisPoints,
      "The capital-gains rate",
      (message) => new InvalidTaxRatesError(message),
    ),
  };
}

/** Exact: `6217e-4` is the fraction 6217/10000 and not the double nearest to it. */
function asFactor(basisPoints: number): string {
  return `${basisPoints}e-4`;
}

// --- the fees ----------------------------------------------------------------

/**
 * What the sale costs to make. Every field is a household input rather than a
 * constant here — a broker's commission is a fact about a broker, and the
 * household changes brokers without anybody changing code.
 *
 * A per-share commission is a price per share and carries the same four decimals
 * a price does: a cent a share is `0.0100`, and cents cannot hold half of one.
 */
export interface FeeSchedule {
  /** The broker's commission per share sold, or `null` where there is none. */
  readonly brokerPerShare: SharePrice | null;
  /** A flat charge per sale, whatever its size. */
  readonly brokerFlat: Money | null;
  /** The trustee's cut, as whole basis points of the gross proceeds. */
  readonly trusteeBasisPoints: number;
}

export class InvalidFeeScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFeeScheduleError";
  }
}

/** No fees at all — the position the system starts from, and a real one. */
export const NO_FEES: FeeSchedule = {
  brokerPerShare: null,
  brokerFlat: null,
  trusteeBasisPoints: 0,
};

export function buildFeeSchedule(fees: FeeSchedule): FeeSchedule {
  const { brokerPerShare, brokerFlat } = fees;
  if (brokerPerShare !== null && brokerFlat !== null && brokerPerShare.currency !== brokerFlat.currency) {
    throw new InvalidFeeScheduleError(
      `A ${brokerPerShare.currency} commission per share cannot sit beside a ${brokerFlat.currency} flat charge`,
    );
  }
  if (brokerFlat !== null && isNegative(brokerFlat)) {
    throw new InvalidFeeScheduleError("A flat charge cannot be negative");
  }
  return {
    brokerPerShare,
    brokerFlat,
    trusteeBasisPoints: requireBasisPoints(
      fees.trusteeBasisPoints,
      "The trustee's fee",
      (message) => new InvalidFeeScheduleError(message),
    ),
  };
}

export function hasFees(fees: FeeSchedule): boolean {
  return fees.brokerPerShare !== null || fees.brokerFlat !== null || fees.trusteeBasisPoints > 0;
}

/** What a schedule actually charges on one sale, each part named. */
export interface FeesCharged {
  readonly broker: Money;
  readonly trustee: Money;
  readonly total: Money;
}

/**
 * The fees on one sale. Charged against the whole sale rather than per lot: a
 * flat commission is one commission, and charging it once per lot would invent
 * money that never left.
 *
 * A fee quoted in a currency the sale is not in throws rather than converting —
 * a conversion here would need a rate nobody named.
 */
export function chargeFees(fees: FeeSchedule, grossProceeds: Money, shares: number): FeesCharged {
  const schedule = buildFeeSchedule(fees);
  const currency = grossProceeds.currency;

  const perShare =
    schedule.brokerPerShare === null ? zero(currency) : valueOf(schedule.brokerPerShare, shares);
  const flat = schedule.brokerFlat ?? zero(currency);
  const broker = shares === 0 ? zero(currency) : add(perShare, flat);
  const trustee =
    schedule.trusteeBasisPoints === 0
      ? zero(currency)
      : multiply(grossProceeds, asFactor(schedule.trusteeBasisPoints));

  return { broker, trustee, total: add(broker, trustee) };
}

// --- which treatment -----------------------------------------------------------

/**
 * `qualified` — סעיף 102's 24 months have run by the sale date: GP is ordinary
 * income and everything above it is a capital gain.
 * `unqualified` — they have not: the whole thing is ordinary income.
 */
export type Treatment = "qualified" | "unqualified";

export const TREATMENT_LABELS_HE: Record<Treatment, string> = {
  qualified: "אחרי התקופה",
  unqualified: "לפני התקופה",
};

/**
 * The treatment a lot's shares meet on a date. Derived from the grant date and
 * the sale date and from nothing else — never from the lot's own `qualified`,
 * which is a fact about the day the *position* was read. Selling in March and
 * reading in January are different questions, and answering the second with the
 * first is how an early sale gets priced as though the clock had finished.
 */
export function treatmentOn(lot: Lot, soldOn: CalendarDate): Treatment {
  return isQualifiedOn(lot.grant.grantedOn, soldOn) ? "qualified" : "unqualified";
}

export class MissingGrantPriceError extends Error {
  constructor(readonly grantId: string) {
    super(
      `Grant ${grantId} has no GP recorded, and a Qualified sale cannot be priced without one`,
    );
    this.name = "MissingGrantPriceError";
  }
}

export class InvalidSaleQuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSaleQuantityError";
  }
}

// --- one lot's part of a sale --------------------------------------------------

/**
 * The tax on the shares taken out of one lot. No fees here: a fee belongs to the
 * sale and not to a lot inside it, and putting it on both would double it.
 */
export interface LotSaleTax {
  readonly lot: Lot;
  readonly shares: number;
  readonly soldOn: CalendarDate;
  readonly treatment: Treatment;
  readonly salePrice: SharePrice;
  /** The GP the Qualified split rests on. `null` where the treatment does not use one. */
  readonly grantPrice: GrantPrice | null;
  readonly grossProceeds: Money;
  readonly ordinaryIncome: Money;
  readonly ordinaryTax: Money;
  readonly capitalGain: Money;
  readonly capitalGainsTax: Money;
  readonly totalTax: Money;
  /**
   * The sale price fell below GP, so there is no gain above it and the whole of
   * the proceeds is ordinary income. Not a capital loss to set against anything:
   * what that loss is worth depends on gains this system does not know about.
   */
  readonly belowGrantPrice: boolean;
  /** The figure rests on a GP nobody measured. True only where the treatment used one. */
  readonly restsOnEstimate: boolean;
}

/**
 * The tax on selling `shares` out of one lot on a date.
 *
 * Under the Qualified treatment the split is GP against everything above it; the
 * ordinary part is capped at the proceeds, because a work-income component
 * larger than the money received would tax income nobody got. Under the
 * Unqualified treatment the whole of the proceeds is ordinary income — an RSU
 * costs nothing to acquire, so the entire sale is the benefit.
 */
export function taxOnLotSale(input: {
  readonly lot: Lot;
  readonly shares: number;
  readonly salePrice: SharePrice;
  readonly soldOn: CalendarDate;
  readonly rates: TaxRates;
}): LotSaleTax {
  const { lot, shares, salePrice, soldOn } = input;
  const rates = buildTaxRates(input.rates);

  if (!Number.isSafeInteger(shares) || shares < 0) {
    throw new InvalidSaleQuantityError(`Shares are a whole count, received ${String(shares)}`);
  }
  if (shares > lot.remainingShares) {
    throw new InvalidSaleQuantityError(
      `Lot ${lot.vest.id} holds ${lot.remainingShares} shares and the sale claims ${shares}`,
    );
  }

  const treatment = treatmentOn(lot, soldOn);
  const grossProceeds = valueOf(salePrice, shares);
  const currency = grossProceeds.currency;

  const grantPrice = treatment === "qualified" ? lot.grant.grantPrice : null;
  if (treatment === "qualified" && grantPrice === null) {
    throw new MissingGrantPriceError(lot.grant.id);
  }

  const atGrantPrice =
    grantPrice === null ? zero(currency) : valueOf(grantPrice.price, shares);
  const belowGrantPrice =
    treatment === "qualified" && atGrantPrice.minorUnits > grossProceeds.minorUnits;

  const ordinaryIncome =
    treatment === "unqualified" || belowGrantPrice ? grossProceeds : atGrantPrice;
  const capitalGain = subtract(grossProceeds, ordinaryIncome);

  const ordinaryTax = multiply(ordinaryIncome, asFactor(rates.ordinaryBasisPoints));
  const capitalGainsTax = multiply(capitalGain, asFactor(rates.capitalGainsBasisPoints));

  return {
    lot,
    shares,
    soldOn,
    treatment,
    salePrice,
    grantPrice,
    grossProceeds,
    ordinaryIncome,
    ordinaryTax,
    capitalGain,
    capitalGainsTax,
    totalTax: add(ordinaryTax, capitalGainsTax),
    belowGrantPrice,
    restsOnEstimate: grantPrice !== null && grantPrice.source === "estimated",
  };
}

// --- a whole sale ---------------------------------------------------------------

/**
 * What a sale is made of and what arrives at the end of it. The three figures a
 * reader wants are `grossProceeds`, `totalTax` and `netProceeds`, and the middle
 * one is never a single rate applied to the first: it is the sum of what each lot
 * met on its own clock.
 */
export interface SaleProceeds {
  readonly soldOn: CalendarDate;
  readonly salePrice: SharePrice;
  /** What was asked for, which is not always what there was to sell. */
  readonly requestedShares: number;
  readonly shares: number;
  /** Shares asked for that no lot could supply. Reported rather than refused. */
  readonly shortfallShares: number;
  readonly lines: readonly LotSaleTax[];
  readonly grossProceeds: Money;
  readonly ordinaryIncome: Money;
  readonly capitalGain: Money;
  readonly ordinaryTax: Money;
  readonly capitalGainsTax: Money;
  readonly totalTax: Money;
  readonly fees: FeesCharged;
  /** `gross − tax − fees`. Negative rather than clamped: a cost is a fact. */
  readonly netProceeds: Money;
  readonly rates: TaxRates;
  readonly qualifiedShares: number;
  readonly unqualifiedShares: number;
  /** Any part of this figure rests on a GP nobody measured. */
  readonly restsOnEstimate: boolean;
}

/**
 * Lots oldest first — the order shares are drawn in unless something else says
 * otherwise. A stated convention and not an optimisation: which lots are the
 * cheapest to sell is Phase 14's question, and it answers it by handing a
 * different list to this same function.
 */
export function oldestFirst(position: RsuPosition): readonly Lot[] {
  return position.lots
    .filter((lot) => lot.remainingShares > 0)
    .slice()
    .sort(
      (left, right) =>
        compareDates(left.vest.vestedOn, right.vest.vestedOn) ||
        left.vest.id.localeCompare(right.vest.id),
    );
}

/**
 * A number of shares taken out of one named lot. An allocation is the whole of
 * what a selection strategy decides, and it is the only shape this module accepts
 * — so "which lots" and "what the sale costs" are two questions that cannot leak
 * into each other.
 */
export interface LotAllocation {
  readonly lot: Lot;
  readonly shares: number;
}

/**
 * The same lot allocated twice. Refused rather than summed: two lines against one
 * lot could each pass their own remaining-shares check and together take more than
 * the lot holds, which is the negative position `LotOversoldError` exists to stop.
 */
export class DuplicateLotAllocationError extends Error {
  constructor(readonly vestId: string) {
    super(`Lot ${vestId} appears twice in one allocation; a lot is allocated once or not at all`);
    this.name = "DuplicateLotAllocationError";
  }
}

/**
 * Draw shares from lots in the order given, filling each before moving on. The
 * order *is* the strategy — hand it `oldestFirst` and it draws oldest-first — and
 * it produces an allocation rather than a figure, so nothing about the tax below
 * depends on it.
 *
 * Asking for more than the lots hold fills what it can and reports the rest as a
 * shortfall. This is a planning question — "what would selling 500 bring" — and
 * refusing to answer it is less useful than answering the part that exists.
 */
export function allocateInOrder(
  lots: readonly Lot[],
  shares: number,
): { readonly allocations: readonly LotAllocation[]; readonly shortfallShares: number } {
  if (!Number.isSafeInteger(shares) || shares < 0) {
    throw new InvalidSaleQuantityError(`Shares are a whole count, received ${String(shares)}`);
  }

  const allocations: LotAllocation[] = [];
  let remaining = shares;

  for (const lot of lots) {
    if (remaining === 0) break;
    const take = Math.min(remaining, lot.remainingShares);
    if (take === 0) continue;
    allocations.push({ lot, shares: take });
    remaining -= take;
  }

  return { allocations, shortfallShares: remaining };
}

/**
 * What an allocation costs and what arrives at the end of it. The one entry point
 * into the arithmetic: every figure below is the sum of what each lot met on its
 * own clock, with the fees charged once over the whole sale.
 */
export function sellShares(input: {
  readonly allocations: readonly LotAllocation[];
  readonly salePrice: SharePrice;
  readonly soldOn: CalendarDate;
  readonly rates: TaxRates;
  readonly fees?: FeeSchedule;
  /** What was asked for, where that is more than the allocation could fill. */
  readonly requestedShares?: number;
}): SaleProceeds {
  const { salePrice, soldOn } = input;
  const rates = buildTaxRates(input.rates);
  const fees = buildFeeSchedule(input.fees ?? NO_FEES);
  const currency: Currency = salePrice.currency;

  const seen = new Set<string>();
  const lines: LotSaleTax[] = [];

  for (const allocation of input.allocations) {
    if (seen.has(allocation.lot.vest.id)) {
      throw new DuplicateLotAllocationError(allocation.lot.vest.id);
    }
    seen.add(allocation.lot.vest.id);
    if (allocation.shares === 0) continue;
    lines.push(taxOnLotSale({ lot: allocation.lot, shares: allocation.shares, salePrice, soldOn, rates }));
  }

  const filled = lines.reduce((running, line) => running + line.shares, 0);
  const requested = input.requestedShares ?? filled;
  if (!Number.isSafeInteger(requested) || requested < filled) {
    throw new InvalidSaleQuantityError(
      `A sale cannot fill ${filled} shares out of a request for ${String(requested)}`,
    );
  }

  const totals = (of: (line: LotSaleTax) => Money): Money => sum(lines.map(of), currency);

  const grossProceeds = totals((line) => line.grossProceeds);
  const ordinaryTax = totals((line) => line.ordinaryTax);
  const capitalGainsTax = totals((line) => line.capitalGainsTax);
  const totalTax = add(ordinaryTax, capitalGainsTax);
  const charged = chargeFees(fees, grossProceeds, filled);

  return {
    soldOn,
    salePrice,
    requestedShares: requested,
    shares: filled,
    shortfallShares: requested - filled,
    lines,
    grossProceeds,
    ordinaryIncome: totals((line) => line.ordinaryIncome),
    capitalGain: totals((line) => line.capitalGain),
    ordinaryTax,
    capitalGainsTax,
    totalTax,
    fees: charged,
    netProceeds: subtract(subtract(grossProceeds, totalTax), charged.total),
    rates,
    qualifiedShares: lines
      .filter((line) => line.treatment === "qualified")
      .reduce((running, line) => running + line.shares, 0),
    unqualifiedShares: lines
      .filter((line) => line.treatment === "unqualified")
      .reduce((running, line) => running + line.shares, 0),
    restsOnEstimate: lines.some((line) => line.restsOnEstimate),
  };
}

/**
 * Sell a number of shares, drawing on the given lots in the order given —
 * `allocateInOrder` followed by `sellShares`, which is the whole of what a
 * strategy is. Kept as one call because "draw oldest-first and price it" is the
 * stated convention every screen but the funding one reads by.
 */
export function sellFrom(input: {
  readonly lots: readonly Lot[];
  readonly shares: number;
  readonly salePrice: SharePrice;
  readonly soldOn: CalendarDate;
  readonly rates: TaxRates;
  readonly fees?: FeeSchedule;
}): SaleProceeds {
  const { allocations } = allocateInOrder(input.lots, input.shares);
  return sellShares({ ...input, allocations, requestedShares: input.shares });
}

/** Selling a number of shares out of a whole position, oldest lot first. */
export function sellFromPosition(input: {
  readonly position: RsuPosition;
  readonly shares: number;
  readonly salePrice: SharePrice;
  readonly soldOn: CalendarDate;
  readonly rates: TaxRates;
  readonly fees?: FeeSchedule;
}): SaleProceeds {
  return sellFrom({ ...input, lots: oldestFirst(input.position) });
}

// --- what waiting is worth -------------------------------------------------------

/**
 * One lot priced twice at the same price: sold today, and sold on the day it
 * becomes Qualified. The price is held flat between the two because a growth
 * assumption would answer a different question — this one is what the *clock* is
 * worth, and mixing a guess about the share price into it would hide that.
 */
export interface WaitingValue {
  readonly lot: Lot;
  readonly shares: number;
  readonly qualifiedFrom: CalendarDate;
  /** The clock has already run: there is nothing to wait for, and both sides agree. */
  readonly alreadyQualified: boolean;
  readonly today: SaleProceeds;
  readonly onceQualified: SaleProceeds;
  /** `onceQualified − today`, in the sale currency. What the waiting is worth. */
  readonly difference: Money;
}

export function waitingValue(input: {
  readonly lot: Lot;
  readonly salePrice: SharePrice;
  readonly asOf: CalendarDate;
  readonly rates: TaxRates;
  readonly fees?: FeeSchedule;
  /** Defaults to everything still in the lot. */
  readonly shares?: number;
}): WaitingValue {
  const { lot, salePrice, asOf } = input;
  const shares = input.shares ?? lot.remainingShares;
  const qualifiedFrom = qualifiesOn(lot.grant.grantedOn);
  const alreadyQualified = isQualifiedOn(lot.grant.grantedOn, asOf);

  const price = (soldOn: CalendarDate) =>
    sellFrom({ lots: [lot], shares, salePrice, soldOn, rates: input.rates, fees: input.fees });

  const today = price(asOf);
  const onceQualified = alreadyQualified ? today : price(qualifiedFrom);

  return {
    lot,
    shares,
    qualifiedFrom,
    alreadyQualified,
    today,
    onceQualified,
    difference: subtract(onceQualified.netProceeds, today.netProceeds),
  };
}

/**
 * Every held lot, priced both ways. Ordered by what the waiting is worth, largest
 * first, so the decision worth making is at the top; lots with nothing to wait for
 * sort below by having a difference of nothing.
 */
export function waitingValues(input: {
  readonly position: RsuPosition;
  readonly salePrice: SharePrice;
  readonly rates: TaxRates;
  readonly fees?: FeeSchedule;
}): readonly WaitingValue[] {
  return oldestFirst(input.position)
    .map((lot) =>
      waitingValue({
        lot,
        salePrice: input.salePrice,
        asOf: input.position.asOf,
        rates: input.rates,
        fees: input.fees,
      }),
    )
    .sort(
      (left, right) =>
        right.difference.minorUnits - left.difference.minorUnits ||
        compareDates(left.lot.vest.vestedOn, right.lot.vest.vestedOn) ||
        left.lot.vest.id.localeCompare(right.lot.vest.id),
    );
}

/** An empty sale, for a screen with nothing to price yet. */
export function noSale(input: {
  readonly salePrice: SharePrice;
  readonly soldOn: CalendarDate;
  readonly rates: TaxRates;
}): SaleProceeds {
  return sellFrom({ ...input, lots: [], shares: 0 });
}

/** The rate a set of basis points reads as — `6217` is `62.17`. For display only. */
export function asPercent(basisPoints: number): number {
  return basisPoints / 100;
}

/** A zero amount in the currency a price is quoted in. */
export function zeroOf(price: SharePrice): Money {
  return money(0, price.currency);
}
