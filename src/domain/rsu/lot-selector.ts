/**
 * LotSelector — to raise a target amount by a target date, which lots should be
 * sold to incur the least tax?
 *
 * Framework-free per ADR 0004.
 *
 * It composes `RsuPosition` and `RsuTax` and produces one thing: a
 * `LotAllocation[]`. It never computes a tax figure of its own — `sellShares`
 * does that, from the allocation — so the strategy here can be replaced whole
 * without a number in the tax module moving. That separation is the point of the
 * module existing at all.
 *
 * Three rules give it its shape:
 *
 * **A lot that has not vested by the target date is not a candidate.** Shares
 * nobody holds on the day the money is needed cannot fund anything, whatever they
 * will be worth later. They are reported as excluded rather than silently absent,
 * because "we are 40 shares short until November" is the useful answer.
 *
 * **The answer is exact, not a heuristic.** Selling is per share, the fees depend
 * only on how many shares the sale is over, and the tax of a lot is a fact about
 * that lot — so the cheapest way to raise a target is found by working out, for
 * every possible total, the least tax that total can be assembled for, and taking
 * the smallest total that reaches the target. Rounding at the cent makes a
 * lot's per-share tax not quite constant, which is exactly why this does not sort
 * by a per-share rate and hope: a greedy order is right almost always, and
 * "almost always" is not something a household can check.
 *
 * **A lot that cannot be priced is excluded and said so.** A Qualified sale out of
 * a grant with no GP has no split between work income and gain, and Phase 13
 * refuses to invent one. Here that refusal would block the whole question, so the
 * lot leaves the candidate set carrying its reason.
 */

import { type Money, compare, isNegative, money, subtract } from "@/domain/money/money";
import {
  type Lot,
  type RsuPosition,
  type SharePrice,
  valueOf,
} from "@/domain/rsu/rsu-position";
import {
  type FeeSchedule,
  type LotAllocation,
  type SaleProceeds,
  type TaxRates,
  NO_FEES,
  buildFeeSchedule,
  buildTaxRates,
  chargeFees,
  sellShares,
  taxOnLotSale,
  treatmentOn,
} from "@/domain/rsu/rsu-tax";
import { type CalendarDate, compareDates } from "@/domain/time/calendar-date";

export class InvalidSelectionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSelectionTargetError";
  }
}

/** Why a held lot is not among the candidates. Reported, never merely omitted. */
export type ExclusionReason =
  /** Its vest date falls after the target date: nobody holds it on the day. */
  | "not-vested"
  /** It would be a Qualified sale out of a grant with no GP, which cannot be priced. */
  | "no-grant-price";

export interface ExcludedLot {
  readonly lot: Lot;
  readonly reason: ExclusionReason;
}

export interface LotSelection {
  readonly target: Money;
  readonly targetDate: CalendarDate;
  readonly salePrice: SharePrice;
  /** The lots the selection was allowed to draw on. */
  readonly candidates: readonly Lot[];
  readonly excluded: readonly ExcludedLot[];
  /** Which lots, and how many out of each. The whole of what the strategy decided. */
  readonly allocations: readonly LotAllocation[];
  /** The allocation priced by `RsuTax`. Nothing here computed any of it. */
  readonly sale: SaleProceeds;
  readonly reachesTarget: boolean;
  /** `target − net`, and `null` when the target is reached. */
  readonly shortfall: Money | null;
}

/**
 * The tax on taking `s` shares out of one lot, for every `s` from nought to what
 * the lot holds. One pass per lot rather than one per (lot, total) pair: the same
 * figures are read K times by the search below and computing them once is what
 * keeps an exact answer cheap.
 */
function taxLadder(input: {
  readonly lot: Lot;
  readonly salePrice: SharePrice;
  readonly soldOn: CalendarDate;
  readonly rates: TaxRates;
}): readonly number[] {
  const ladder: number[] = [0];
  for (let shares = 1; shares <= input.lot.remainingShares; shares += 1) {
    ladder.push(taxOnLotSale({ ...input, shares }).totalTax.minorUnits);
  }
  return ladder;
}

/**
 * Whether a lot can be priced at all on the target date. A Qualified lot needs a
 * GP; an early sale needs nothing but the sale price.
 */
function canBePriced(lot: Lot, soldOn: CalendarDate): boolean {
  return treatmentOn(lot, soldOn) === "unqualified" || lot.grant.grantPrice !== null;
}

/**
 * The lots a selection may draw on, and the ones it may not, with the reason.
 * Candidates are ordered oldest first, which decides nothing about the answer —
 * it only decides which of two equally cheap answers is given.
 */
export function candidateLots(input: {
  readonly position: RsuPosition;
  readonly targetDate: CalendarDate;
}): { readonly candidates: readonly Lot[]; readonly excluded: readonly ExcludedLot[] } {
  const candidates: Lot[] = [];
  const excluded: ExcludedLot[] = [];

  const held = [...input.position.lots, ...input.position.future.map(futureAsLot)]
    .filter((lot) => lot.remainingShares > 0)
    .sort(
      (left, right) =>
        compareDates(left.vest.vestedOn, right.vest.vestedOn) ||
        left.vest.id.localeCompare(right.vest.id),
    );

  for (const lot of held) {
    if (compareDates(lot.vest.vestedOn, input.targetDate) > 0) {
      excluded.push({ lot, reason: "not-vested" });
      continue;
    }
    if (!canBePriced(lot, input.targetDate)) {
      excluded.push({ lot, reason: "no-grant-price" });
      continue;
    }
    candidates.push(lot);
  }

  return { candidates, excluded };
}

/**
 * A vest whose date has not arrived on the day the position was read, as the lot
 * it will be. A position read as of the target date puts everything vesting by
 * then among its lots already, so in ordinary use these are all excluded — but
 * the date guard above is what decides that, not which list a vest arrived in, so
 * a position read as of some other day gives the same answer.
 */
function futureAsLot(entry: RsuPosition["future"][number]): Lot {
  return {
    vest: entry.vest,
    grant: entry.grant,
    soldShares: 0,
    remainingShares: entry.vest.shares,
    qualifiedFrom: entry.qualifiedFrom,
    qualified: false,
    remainingValueAtVest: valueOf(entry.vest.priceAtVest, entry.vest.shares),
  };
}

/**
 * The cheapest set of lots that raises at least the target by the target date.
 *
 * The search is over totals rather than over subsets. For a given total the gross
 * proceeds and the fees are fixed — the fees are charged over the sale, not per
 * lot — so all that varies is the tax, and the least tax a total can be assembled
 * for is a straight allocation problem over the candidate lots. Because that
 * least tax cannot fall as the total rises (drop a share from any allocation and
 * the smaller one costs no more), the cheapest answer is always the *smallest*
 * total that reaches the target.
 *
 * Reaching the target is measured on the **net**: what arrives after tax and
 * fees. Selling gross to a target would leave the household short by exactly the
 * tax, which is the thing this is for.
 */
export function selectLots(input: {
  readonly position: RsuPosition;
  readonly target: Money;
  readonly targetDate: CalendarDate;
  readonly salePrice: SharePrice;
  readonly rates: TaxRates;
  readonly fees?: FeeSchedule;
}): LotSelection {
  const { target, targetDate, salePrice } = input;
  const rates = buildTaxRates(input.rates);
  const fees = buildFeeSchedule(input.fees ?? NO_FEES);

  if (target.currency !== salePrice.currency) {
    throw new InvalidSelectionTargetError(
      `A ${target.currency} target cannot be raised at a ${salePrice.currency} price`,
    );
  }
  if (isNegative(target)) {
    throw new InvalidSelectionTargetError("A funding target cannot be negative");
  }

  const { candidates, excluded } = candidateLots({ position: input.position, targetDate });
  const ladders = candidates.map((lot) =>
    taxLadder({ lot, salePrice, soldOn: targetDate, rates }),
  );
  const total = candidates.reduce((running, lot) => running + lot.remainingShares, 0);

  const { leastTax, taken } = leastTaxPerTotal(ladders, total);

  // The smallest total whose net reaches the target. Least tax rises with the
  // total, so the first one that reaches it is also the cheapest one that does.
  let chosen = total;
  let reachesTarget = false;
  for (let shares = 0; shares <= total; shares += 1) {
    const tax = leastTax[shares];
    if (tax === undefined || !Number.isFinite(tax)) continue;
    if (compare(netOf({ shares, tax, salePrice, fees }), target) >= 0) {
      chosen = shares;
      reachesTarget = true;
      break;
    }
  }

  const allocations = reconstruct(candidates, taken, chosen);
  const sale = sellShares({ allocations, salePrice, soldOn: targetDate, rates, fees });
  const missing = subtract(target, sale.netProceeds);

  return {
    target,
    targetDate,
    salePrice,
    candidates,
    excluded,
    allocations,
    sale,
    reachesTarget,
    shortfall: reachesTarget ? null : missing,
  };
}

/** What arrives if `shares` are sold and the tax on them is `tax`. */
function netOf(input: {
  readonly shares: number;
  readonly tax: number;
  readonly salePrice: SharePrice;
  readonly fees: FeeSchedule;
}): Money {
  const currency = input.salePrice.currency;
  const gross = valueOf(input.salePrice, input.shares);
  const charged = chargeFees(input.fees, gross, input.shares);
  return subtract(subtract(gross, money(input.tax, currency)), charged.total);
}

/**
 * For every total from nought to everything, the least tax that total can be
 * assembled for out of the candidate lots — and, beside it, how many shares the
 * last lot contributed, which is what makes the answer reconstructible.
 *
 * A tie goes to the *earlier* lot, so two equally cheap answers resolve to the
 * older shares. That is the same oldest-first convention the rest of the RSU
 * screens state, applied where it costs nothing.
 */
function leastTaxPerTotal(
  ladders: readonly (readonly number[])[],
  total: number,
): { readonly leastTax: readonly number[]; readonly taken: readonly (readonly number[])[] } {
  let leastTax = new Array<number>(total + 1).fill(Number.POSITIVE_INFINITY);
  leastTax[0] = 0;
  const taken: number[][] = [];

  for (const ladder of ladders) {
    const next = new Array<number>(total + 1).fill(Number.POSITIVE_INFINITY);
    const from = new Array<number>(total + 1).fill(0);
    const cap = ladder.length - 1;

    for (let shares = 0; shares <= total; shares += 1) {
      for (let take = 0; take <= Math.min(cap, shares); take += 1) {
        const before = leastTax[shares - take];
        const cost = ladder[take];
        if (before === undefined || cost === undefined || !Number.isFinite(before)) continue;
        const candidate = before + cost;
        // `<=` rather than `<`: on a tie the larger `take` wins, which is the
        // share coming out of the lot being folded in now — the earlier one.
        if (candidate <= (next[shares] ?? Number.POSITIVE_INFINITY)) {
          next[shares] = candidate;
          from[shares] = take;
        }
      }
    }

    leastTax = next;
    taken.push(from);
  }

  return { leastTax, taken };
}

/** Walk the search back to the allocation it stands for. */
function reconstruct(
  candidates: readonly Lot[],
  taken: readonly (readonly number[])[],
  total: number,
): readonly LotAllocation[] {
  const allocations: LotAllocation[] = [];
  let remaining = total;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const shares = taken[index]?.[remaining] ?? 0;
    const lot = candidates[index];
    if (lot !== undefined && shares > 0) allocations.push({ lot, shares });
    remaining -= shares;
  }

  return allocations.reverse();
}

/** A selection over nothing, for a screen with no position and no target yet. */
export function noSelection(input: {
  readonly target: Money;
  readonly targetDate: CalendarDate;
  readonly salePrice: SharePrice;
  readonly rates: TaxRates;
}): LotSelection {
  return {
    ...input,
    candidates: [],
    excluded: [],
    allocations: [],
    sale: sellShares({ ...input, allocations: [], soldOn: input.targetDate }),
    reachesTarget: input.target.minorUnits === 0,
    shortfall: input.target.minorUnits === 0 ? null : input.target,
  };
}
