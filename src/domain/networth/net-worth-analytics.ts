/**
 * NetWorthAnalytics — the derived view over the snapshot history (שווי נטו).
 *
 * Framework-free per ADR 0004. Every function here takes readings that were
 * already restated by the snapshot's own rate and returns plain data; nothing
 * fetches, and no figure produced here is stored.
 *
 * מיפוי answers "where is our money". This module answers the questions that are
 * only askable across it:
 *
 * - **A trajectory, not today's number.** Every snapshot's total at its own rate,
 *   in date order. A snapshot that cannot be restated into the reading currency
 *   reads as unreadable rather than as a total with the dollar accounts quietly
 *   dropped out of it.
 * - **Exposure is what an asset *is*.** It is grouped by each Account's own
 *   currency and never by how the money that bought it was funded — a $104,000
 *   stake is fully exposed even if two thirds of it began as shekels.
 * - **An allocation states its target.** A bucket the household never targeted
 *   reads as untargeted rather than as a target of nothing, and the drift is a
 *   Money as well as a percentage, because "9% under" is not actionable until it
 *   says how much money that is.
 * - **Growth is an assumption or it is absent.** Per ADR 0003 a cost-held asset is
 *   never re-valued, so the only two honest readings are the recorded total, which
 *   holds cost at cost, and a total that names the assumption it grew cost by.
 *   `appreciationRange` produces both at once and carries the assumption on the
 *   result, so no caller can print the second while implying the first.
 */

import {
  type Currency,
  type Money,
  add,
  isZero,
  multiply,
  ratio,
  subtract,
  sum,
  zero,
} from "@/domain/money/money";
import {
  type Account,
  type BasisSplit,
  type ConvertedReading,
  type Snapshot,
  ASSET_CATEGORIES,
  type AssetCategory,
  basisSplitOf,
  canConvertWithin,
  completenessOf,
  convertedReadings,
  snapshotReadings,
} from "@/domain/snapshot/snapshot";
import { type CalendarDate, compareDates, wholeYearsBetween } from "@/domain/time/calendar-date";

// --- net worth over time -----------------------------------------------------

/**
 * One snapshot as a point on the trajectory. `total` is `null` when the snapshot
 * holds an account in a currency it carries no rate for: a total that silently
 * dropped those accounts, or reached outside the snapshot for a rate, would be a
 * point on the line that never happened.
 */
export interface NetWorthPoint {
  readonly snapshotId: string;
  readonly takenOn: CalendarDate;
  readonly total: Money | null;
  readonly basis: BasisSplit | null;
  /** How many of the snapshot's lines were stated on its own date. */
  readonly measured: number;
  readonly carried: number;
  readonly accountCount: number;
  /**
   * Against the previous *readable* point. `null` at the first one, and at any
   * point either side of an unreadable snapshot — there is nothing to subtract.
   */
  readonly change: Money | null;
  /**
   * Whether the two snapshots behind `change` were read at the same rate. When
   * they were not, the change mixes what the money did with what the shekel did;
   * separating the two is Phase 10's work and nothing here pretends to have done it.
   */
  readonly sameRate: boolean;
}

/** Whether every currency in the snapshot can be restated into one currency by its own rate. */
function canRestate(
  snapshot: Snapshot,
  readings: readonly { readonly account: Account }[],
  currency: Currency,
): boolean {
  return readings.every((reading) => canConvertWithin(snapshot, reading.account.currency, currency));
}

function ratesMatch(earlier: Snapshot, later: Snapshot): boolean {
  return later.rates.every((rate) => {
    const before = earlier.rates.find(
      (candidate) => candidate.from === rate.from && candidate.to === rate.to,
    );
    return before !== undefined && before.rate === rate.rate;
  });
}

/**
 * Net worth over time, oldest first. Each total is computed at its own snapshot's
 * rate, so a point from 2024 reads today exactly as it read in 2024 — the line
 * does not redraw itself when today's rate moves.
 */
export function netWorthTrajectory(input: {
  readonly snapshots: readonly Snapshot[];
  readonly accounts: readonly Account[];
  readonly currency: Currency;
}): readonly NetWorthPoint[] {
  const ordered = [...input.snapshots].sort((left, right) => compareDates(left.takenOn, right.takenOn));

  let previous: { snapshot: Snapshot; total: Money } | null = null;

  return ordered.map((snapshot) => {
    const native = snapshotReadings(snapshot, input.accounts);
    const completeness = completenessOf(snapshot);

    if (!canRestate(snapshot, native, input.currency)) {
      // The gap stays a gap: the next readable point compares against the last
      // readable one rather than across a total nobody could compute.
      return {
        snapshotId: snapshot.id,
        takenOn: snapshot.takenOn,
        total: null,
        basis: null,
        measured: completeness.entered,
        carried: completeness.carried,
        accountCount: native.length,
        change: null,
        sameRate: false,
      };
    }

    const rows = convertedReadings(snapshot, input.accounts, input.currency);
    const basis = basisSplitOf(rows, input.currency);
    const point: NetWorthPoint = {
      snapshotId: snapshot.id,
      takenOn: snapshot.takenOn,
      total: basis.total,
      basis,
      measured: completeness.entered,
      carried: completeness.carried,
      accountCount: rows.length,
      change: previous === null ? null : subtract(basis.total, previous.total),
      sameRate: previous !== null && ratesMatch(previous.snapshot, snapshot),
    };

    previous = { snapshot, total: basis.total };
    return point;
  });
}

// --- חשיפה למט"ח --------------------------------------------------------------

/**
 * Everything held in one currency. `native` is the sum as it is actually held;
 * `amount` is the same money restated for comparison. Both come from the Account's
 * own currency — the funding history of an asset is not consulted and could not be:
 * nothing in a Snapshot records it.
 */
export interface ExposureLine {
  readonly currency: Currency;
  readonly native: Money;
  readonly amount: Money;
  readonly share: number | null;
  readonly accountCount: number;
}

export interface CurrencyExposure {
  /** The currency everything is being read in. */
  readonly currency: Currency;
  readonly total: Money;
  /** The reading currency first, then the rest by size. */
  readonly lines: readonly ExposureLine[];
  /** Everything not denominated in the reading currency. */
  readonly foreign: Money;
  readonly foreignShare: number | null;
}

/**
 * Currency exposure, derived from what each asset *is*. A dollar-denominated stake
 * counts as fully exposed however the money that bought it started out, which is
 * the whole point: exposure is a property of the holding, not of its history.
 */
export function currencyExposure(
  readings: readonly ConvertedReading[],
  currency: Currency,
): CurrencyExposure {
  const buckets = new Map<Currency, { native: Money; amount: Money; accountCount: number }>();

  for (const reading of readings) {
    const key = reading.account.currency;
    const bucket = buckets.get(key) ?? {
      native: zero(key),
      amount: zero(currency),
      accountCount: 0,
    };
    buckets.set(key, {
      native: add(bucket.native, reading.native),
      amount: add(bucket.amount, reading.converted),
      accountCount: bucket.accountCount + 1,
    });
  }

  const total = sum(
    [...buckets.values()].map((bucket) => bucket.amount),
    currency,
  );

  const lines = [...buckets]
    .map(([held, bucket]) => ({
      currency: held,
      native: bucket.native,
      amount: bucket.amount,
      share: ratio(bucket.amount, total),
      accountCount: bucket.accountCount,
    }))
    .sort((left, right) => {
      if (left.currency === currency) return -1;
      if (right.currency === currency) return 1;
      return right.amount.minorUnits - left.amount.minorUnits;
    });

  const foreign = sum(
    lines.filter((line) => line.currency !== currency).map((line) => line.amount),
    currency,
  );

  return { currency, total, lines, foreign, foreignShare: ratio(foreign, total) };
}

// --- הקצאה רצויה --------------------------------------------------------------

export class InvalidAllocationTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAllocationTargetError";
  }
}

/**
 * One רצוי target. Held in basis points rather than a fraction for the same reason
 * money is held in minor units: 12.5% is 1250 exactly, and a target that drifts in
 * the third decimal is a target nobody set.
 */
export interface AllocationTarget {
  readonly category: AssetCategory;
  readonly basisPoints: number;
}

export type AllocationTargets = readonly AllocationTarget[];

const FULL = 10_000;

export function buildAllocationTargets(
  input: readonly { readonly category: AssetCategory; readonly basisPoints: number }[],
): AllocationTargets {
  const seen = new Set<AssetCategory>();

  for (const target of input) {
    if (!ASSET_CATEGORIES.includes(target.category)) {
      throw new InvalidAllocationTargetError(`Unknown קטגוריה ${String(target.category)}`);
    }
    if (seen.has(target.category)) {
      throw new InvalidAllocationTargetError(`More than one target for ${target.category}`);
    }
    seen.add(target.category);

    if (!Number.isInteger(target.basisPoints) || target.basisPoints < 0 || target.basisPoints > FULL) {
      throw new InvalidAllocationTargetError(
        `A target is a whole number of basis points between 0 and ${FULL}, received ${String(target.basisPoints)}`,
      );
    }
  }

  // A bucket with no target is left out rather than stored as zero: "we never set
  // one" and "we want none of it" are different statements about the same bucket.
  return input
    .filter((target) => target.basisPoints > 0)
    .sort(
      (left, right) =>
        ASSET_CATEGORIES.indexOf(left.category) - ASSET_CATEGORIES.indexOf(right.category),
    )
    .map((target) => ({ category: target.category, basisPoints: target.basisPoints }));
}

export function targetFor(targets: AllocationTargets, category: AssetCategory): number | null {
  return targets.find((target) => target.category === category)?.basisPoints ?? null;
}

/** Where a bucket stands against its own target. `untargeted` is not "on target". */
export type AllocationStance = "over" | "under" | "on-target" | "untargeted";

export interface AllocationLine {
  readonly category: AssetCategory;
  readonly actual: Money;
  readonly actualShare: number | null;
  /** `null` where the household set no target for this bucket. */
  readonly targetBasisPoints: number | null;
  readonly targetAmount: Money | null;
  /** `actual − target`. Positive is over-weight. `null` where there is no target. */
  readonly drift: Money | null;
  readonly stance: AllocationStance;
  readonly accountCount: number;
  /** How much of the bucket is held at cost rather than measured (ADR 0003). */
  readonly basis: BasisSplit;
}

export interface Allocation {
  readonly currency: Currency;
  readonly total: Money;
  /** One line per קטגוריה, in the household's reading order, targeted or not. */
  readonly lines: readonly AllocationLine[];
  /** The targets' own sum in basis points, so a set that does not add to 100% says so. */
  readonly targetsTotal: number;
}

/**
 * Current allocation against the household's רצוי targets.
 *
 * Every קטגוריה gets a line even when nothing is in it: a bucket targeted at 20%
 * and holding nothing is the most under-weight the portfolio can be, and dropping
 * the row would hide exactly that.
 */
export function allocation(input: {
  readonly readings: readonly ConvertedReading[];
  readonly targets: AllocationTargets;
  readonly currency: Currency;
}): Allocation {
  const { currency } = input;
  const total = sum(
    input.readings.map((reading) => reading.converted),
    currency,
  );

  const lines = ASSET_CATEGORIES.map((category): AllocationLine => {
    const inBucket = input.readings.filter((reading) => reading.account.category === category);
    const actual = sum(
      inBucket.map((reading) => reading.converted),
      currency,
    );
    const basisPoints = targetFor(input.targets, category);

    if (basisPoints === null) {
      return {
        category,
        actual,
        actualShare: ratio(actual, total),
        targetBasisPoints: null,
        targetAmount: null,
        drift: null,
        stance: "untargeted",
        accountCount: inBucket.length,
        basis: basisSplitOf(inBucket, currency),
      };
    }

    const targetAmount = multiply(total, exactShare(basisPoints));
    const drift = subtract(actual, targetAmount);

    return {
      category,
      actual,
      actualShare: ratio(actual, total),
      targetBasisPoints: basisPoints,
      targetAmount,
      drift,
      stance: isZero(drift) ? "on-target" : drift.minorUnits > 0 ? "over" : "under",
      accountCount: inBucket.length,
      basis: basisSplitOf(inBucket, currency),
    };
  });

  return {
    currency,
    total,
    lines,
    targetsTotal: input.targets.reduce((running, target) => running + target.basisPoints, 0),
  };
}

/** Basis points as an exact decimal — 1250 is `0.1250`, never 0.125000000000001. */
function exactShare(basisPoints: number): string {
  return `${Math.trunc(basisPoints / FULL)}.${String(basisPoints % FULL).padStart(4, "0")}`;
}

// --- the appreciation assumption ---------------------------------------------

export class InvalidAppreciationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAppreciationError";
  }
}

/**
 * What the household assumes property appreciates at. A setting and never a
 * constant: the number is a guess, and a guess that cannot be changed without a
 * deploy becomes a fact by accident.
 */
export interface AppreciationAssumption {
  /** Basis points a year. 300 is 3%. Zero is a legitimate assumption — it states one. */
  readonly annualBasisPoints: number;
}

export const NO_APPRECIATION: AppreciationAssumption = { annualBasisPoints: 0 };

export function buildAppreciationAssumption(annualBasisPoints: number): AppreciationAssumption {
  if (!Number.isInteger(annualBasisPoints) || annualBasisPoints < 0 || annualBasisPoints > FULL) {
    throw new InvalidAppreciationError(
      `The appreciation assumption is a whole number of basis points between 0 and ${FULL} a year, ` +
        `received ${String(annualBasisPoints)}`,
    );
  }
  return { annualBasisPoints };
}

/**
 * The multiplier for a rate held for a number of whole years, as an exact decimal
 * string. `(10000 + bp)^years / 10000^years` is a power of ten in the denominator,
 * so it is exact in decimal and there is no float anywhere in the chain: 3% for two
 * years is `1.06090000` and not 1.0608999999999999.
 */
export function growthFactor(assumption: AppreciationAssumption, years: number): string {
  if (!Number.isInteger(years) || years < 0) {
    throw new InvalidAppreciationError(`Years must be a whole number of years, received ${String(years)}`);
  }
  const numerator = (10_000n + BigInt(assumption.annualBasisPoints)) ** BigInt(years);
  const digits = 4 * years;
  const text = numerator.toString().padStart(digits + 1, "0");
  return digits === 0
    ? text
    : `${text.slice(0, text.length - digits)}.${text.slice(text.length - digits)}`;
}

/** One cost-held asset with the assumption applied to it, and the working shown. */
export interface AppreciatedAsset {
  readonly account: Account;
  readonly recorded: Money;
  /** Whole years from the account's own `openedOn` to the reading date. */
  readonly years: number;
  readonly factor: string;
  readonly appreciated: Money;
  readonly uplift: Money;
}

/**
 * Net worth read twice: as recorded, and with the assumption applied. Both figures
 * travel together and the assumption travels with them, so per ADR 0003 there is no
 * way to show the grown figure while implying it is a measurement.
 */
export interface AppreciationRange {
  readonly currency: Currency;
  readonly asOf: CalendarDate;
  readonly assumption: AppreciationAssumption;
  /** מיפוי's own total. Cost is held at cost; no assumption is in this number. */
  readonly recorded: Money;
  /** The recorded total less every cost-held asset — the part that needs no assumption at all. */
  readonly excludingCostHeld: Money;
  readonly costHeld: Money;
  readonly appreciatedCostHeld: Money;
  /** `excludingCostHeld + appreciatedCostHeld`. The upper end of the range. */
  readonly withAssumption: Money;
  readonly uplift: Money;
  /** Every cost-held asset the assumption touched, so the figure opens onto its parts. */
  readonly assets: readonly AppreciatedAsset[];
}

/**
 * Apply the assumption to the cost-held part of a snapshot.
 *
 * Only cost-held assets are touched: a market figure is a measurement and growing
 * it would overwrite what somebody actually read off a screen. Each asset grows
 * from its own `openedOn`, in whole years, so an asset acquired eleven months ago
 * grows by nothing rather than by a fraction nobody can check.
 */
export function appreciationRange(input: {
  readonly readings: readonly ConvertedReading[];
  readonly assumption: AppreciationAssumption;
  readonly asOf: CalendarDate;
  readonly currency: Currency;
}): AppreciationRange {
  const { currency } = input;
  const recorded = sum(
    input.readings.map((reading) => reading.converted),
    currency,
  );
  const costReadings = input.readings.filter((reading) => reading.account.valueBasis === "cost");
  const costHeld = sum(
    costReadings.map((reading) => reading.converted),
    currency,
  );

  const assets = costReadings.map((reading): AppreciatedAsset => {
    const years = wholeYearsBetween(reading.account.openedOn, input.asOf);
    const factor = growthFactor(input.assumption, years);
    const appreciated = multiply(reading.converted, factor);
    return {
      account: reading.account,
      recorded: reading.converted,
      years,
      factor,
      appreciated,
      uplift: subtract(appreciated, reading.converted),
    };
  });

  const appreciatedCostHeld = sum(
    assets.map((asset) => asset.appreciated),
    currency,
  );
  const excludingCostHeld = subtract(recorded, costHeld);

  return {
    currency,
    asOf: input.asOf,
    assumption: input.assumption,
    recorded,
    excludingCostHeld,
    costHeld,
    appreciatedCostHeld,
    withAssumption: add(excludingCostHeld, appreciatedCostHeld),
    uplift: subtract(appreciatedCostHeld, costHeld),
    assets,
  };
}

// --- concentration ------------------------------------------------------------

/**
 * How much of the household's wealth sits in one named set of accounts — the Apple
 * RSU holding, above all, because a concentration nobody states is a concentration
 * nobody manages.
 *
 * The accounts are named by id rather than matched on a name: a rollup over free
 * text is one rename away from silently reporting zero.
 */
export interface Concentration {
  readonly currency: Currency;
  readonly holding: Money;
  readonly total: Money;
  readonly share: number | null;
  readonly readings: readonly ConvertedReading[];
  /** Named accounts with no line in this snapshot — reported, not quietly counted as nothing. */
  readonly missing: readonly string[];
}

export function concentrationOf(input: {
  readonly readings: readonly ConvertedReading[];
  readonly accountIds: readonly string[];
  readonly currency: Currency;
}): Concentration {
  const { currency } = input;
  const named = new Set(input.accountIds);

  const readings = input.readings.filter((reading) => named.has(reading.account.id));
  const holding = sum(
    readings.map((reading) => reading.converted),
    currency,
  );
  const total = sum(
    input.readings.map((reading) => reading.converted),
    currency,
  );

  const present = new Set(readings.map((reading) => reading.account.id));

  return {
    currency,
    holding,
    total,
    share: ratio(holding, total),
    readings,
    missing: input.accountIds.filter((id) => !present.has(id)),
  };
}
