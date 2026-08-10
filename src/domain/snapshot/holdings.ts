/**
 * Positions (החזקות) and Earmarks (ייעודים) — the two different claims on what is
 * inside an Account.
 *
 * Framework-free per ADR 0004.
 *
 * They look alike and are opposites:
 *
 * A **Position** says what the money is invested in — `1159235 ACWI`,
 * `1209220 FTSE`. It answers "what did we buy". It carries no amount, and that is
 * deliberate: what an account is worth is a fact with a date on it, and the
 * Snapshot is where dated facts live. A second figure stored beside it would drift
 * from the snapshot exactly the way the sheet's שקל table drifted from its דולר
 * table. Positions move with the market and nothing is wrong when they do.
 *
 * An **Earmark** says what the money is promised to — קרן חירום's 120,000₪ inside
 * the איילון fund. It answers "what is this money spoken for". It *is* an amount,
 * and it is fixed: nobody's spending changes what was promised. So unlike a
 * position an earmark can be **underfunded**, and that state is the point — money
 * taken out of the emergency fund surfaces as a shortfall rather than quietly
 * shrinking the claim.
 *
 * Two rules keep the reading honest:
 *
 * - **A claim is measured against a dated backing.** Funding is always computed
 *   against one snapshot, in the account's own currency, so no rate can turn a
 *   shortfall into a surplus. An account nobody has ever measured is reported as
 *   unmeasured rather than as underfunded — a placeholder is not a shortfall.
 * - **Claims on one account are assessed together.** Two earmarks against the same
 *   money compete for it. Nothing here invents a priority between them, so the
 *   shortfall belongs to the account and every claim on it reads as short.
 */

import {
  type Currency,
  type Money,
  add,
  isNegative,
  subtract,
  sum,
  zero,
} from "@/domain/money/money";
import {
  type Account,
  type Snapshot,
  type SnapshotReading,
  convertWithin,
  isUnmeasured,
  snapshotReadings,
} from "@/domain/snapshot/snapshot";
import { type CalendarDate, compareDates } from "@/domain/time/calendar-date";

// --- positions ---------------------------------------------------------------

/**
 * What an Account is invested in. `securityId` is the number the fund or the
 * exchange states — `1159235` — kept as written and left in English, and `null`
 * when the household only knows the instrument by name.
 */
export interface Position {
  readonly id: string;
  readonly accountId: string;
  readonly securityId: string | null;
  readonly name: string;
}

export class InvalidPositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPositionError";
  }
}

/**
 * An account held at cost has no composition to state: per ADR 0003 nothing in it
 * is priced and none of it will be re-assessed, so a list of what it is "invested
 * in" would imply a market reading that does not exist.
 */
export class PositionsNotApplicableError extends Error {
  constructor(readonly accountId: string) {
    super(`Account ${accountId} is held at cost, and a cost-held account holds no positions`);
    this.name = "PositionsNotApplicableError";
  }
}

export interface PositionDefinition {
  readonly accountId: string;
  readonly securityId?: string | null;
  readonly name: string;
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function requireText(value: string, what: string, limit: number, fail: (message: string) => Error): string {
  const normalised = normalise(value);
  if (normalised.length === 0) throw fail(`${what} cannot be empty`);
  if (normalised.length > limit) {
    throw fail(`${what} cannot exceed ${limit} characters, received ${normalised.length}`);
  }
  return normalised;
}

export function buildPosition(id: string, definition: PositionDefinition): Position {
  const securityId = normalise(definition.securityId ?? "");
  if (securityId.length > 30) {
    throw new InvalidPositionError(`A security id cannot exceed 30 characters, received ${securityId.length}`);
  }

  return {
    id,
    accountId: definition.accountId,
    securityId: securityId.length === 0 ? null : securityId,
    name: requireText(
      definition.name,
      "A position name",
      60,
      (message) => new InvalidPositionError(message),
    ),
  };
}

/** Whether this account is one positions can be recorded inside. */
export function canHoldPositions(account: Account): boolean {
  return account.valueBasis !== "cost";
}

export function requirePositionsAllowed(account: Account): void {
  if (!canHoldPositions(account)) {
    throw new PositionsNotApplicableError(account.id);
  }
}

/** One account's positions, in reading order. What "read back per account" means. */
export function positionsIn(positions: readonly Position[], accountId: string): readonly Position[] {
  return positions
    .filter((position) => position.accountId === accountId)
    .sort((left, right) => left.name.localeCompare(right.name, "he") || left.id.localeCompare(right.id));
}

// --- earmarks ----------------------------------------------------------------

/**
 * A claim on money inside an Account. The claim is held in the account's own
 * currency — a claim quoted in another one would need a rate to compare against
 * its backing, and a rate moving is not money being spent.
 *
 * `releasedOn` is a lifespan rather than a delete, so a snapshot taken while the
 * claim stood keeps reading as it did: an earmark declared in June must not appear
 * as a shortfall on January's reading, and one released in June must not vanish
 * from May's.
 */
export interface Earmark {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly claim: Money;
  readonly declaredOn: CalendarDate;
  readonly releasedOn: CalendarDate | null;
}

export class InvalidEarmarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEarmarkError";
  }
}

export interface EarmarkDefinition {
  readonly accountId: string;
  readonly name: string;
  readonly claim: Money;
  readonly declaredOn: CalendarDate;
  readonly releasedOn?: CalendarDate | null;
}

export function buildEarmark(id: string, definition: EarmarkDefinition): Earmark {
  if (definition.claim.minorUnits <= 0) {
    throw new InvalidEarmarkError("An earmark claims an amount greater than zero, or it claims nothing");
  }
  const releasedOn = definition.releasedOn ?? null;
  if (releasedOn !== null && compareDates(releasedOn, definition.declaredOn) < 0) {
    throw new InvalidEarmarkError("An earmark cannot be released before it was declared");
  }

  return {
    id,
    accountId: definition.accountId,
    name: requireText(
      definition.name,
      "An earmark name",
      60,
      (message) => new InvalidEarmarkError(message),
    ),
    claim: definition.claim,
    declaredOn: definition.declaredOn,
    releasedOn,
  };
}

/** Whether the claim stood on a date. `releasedOn` is inclusive — it stood that day. */
export function isEarmarkActiveOn(earmark: Earmark, date: CalendarDate): boolean {
  if (compareDates(date, earmark.declaredOn) < 0) return false;
  return earmark.releasedOn === null || compareDates(date, earmark.releasedOn) <= 0;
}

export function earmarksActiveOn(
  earmarks: readonly Earmark[],
  date: CalendarDate,
): readonly Earmark[] {
  return earmarks.filter((earmark) => isEarmarkActiveOn(earmark, date));
}

/** One account's claims, in reading order. Largest first — the biggest promise reads first. */
export function earmarksOn(earmarks: readonly Earmark[], accountId: string): readonly Earmark[] {
  return earmarks
    .filter((earmark) => earmark.accountId === accountId)
    .sort(
      (left, right) =>
        right.claim.minorUnits - left.claim.minorUnits ||
        left.name.localeCompare(right.name, "he") ||
        left.id.localeCompare(right.id),
    );
}

// --- how well a claim is backed ----------------------------------------------

/**
 * `funded` — the account holds at least what is claimed against it.
 * `underfunded` — it holds less, and the difference is a real shortfall.
 * `unmeasured` — nobody has ever stated what the account holds, so there is
 * nothing to compare the claim against and nothing is asserted about it.
 */
export type EarmarkStatus = "funded" | "underfunded" | "unmeasured";

/**
 * Every claim on one account, read against one snapshot. The unit is the account
 * rather than the earmark because claims on the same money compete for it: an
 * account holding 100,000₪ against two 80,000₪ promises is short whichever one you
 * look at, and nothing here invents an order that would make one of them whole.
 */
export interface AccountEarmarks {
  readonly account: Account;
  /** The claims that stood on the snapshot's date, largest first. */
  readonly earmarks: readonly Earmark[];
  /** Their sum, in the account's own currency. */
  readonly claimed: Money;
  /** What the snapshot says the account held, in the same currency. */
  readonly backing: Money;
  readonly status: EarmarkStatus;
  /** `claimed − backing` when short; `null` otherwise, never a negative shortfall. */
  readonly shortfall: Money | null;
  /** `backing − claimed` when funded — money in this account nobody has spoken for. */
  readonly free: Money | null;
  /** Whether the backing figure was carried rather than stated on this snapshot's date. */
  readonly carried: boolean;
  /** The day the backing was last actually measured, `null` when it never was. */
  readonly measuredOn: CalendarDate | null;
}

function fundingFor(reading: SnapshotReading, earmarks: readonly Earmark[]): AccountEarmarks {
  const currency = reading.account.currency;
  const claims = earmarksOn(earmarks, reading.account.id);

  for (const earmark of claims) {
    if (earmark.claim.currency !== currency) {
      throw new InvalidEarmarkError(
        `Earmark ${earmark.name} claims ${earmark.claim.currency} against an account held in ${currency}; ` +
          "a claim is measured against its backing directly, so the two are one currency or neither",
      );
    }
  }

  const claimed = sum(
    claims.map((earmark) => earmark.claim),
    currency,
  );
  const backing = reading.native;
  const difference = subtract(backing, claimed);

  // A placeholder is not a measurement, so it is not a shortfall either. Saying
  // "underfunded" about an account nobody ever valued would invent the very
  // number this system exists to keep out of the totals.
  const status: EarmarkStatus = isUnmeasured(reading.line)
    ? "unmeasured"
    : isNegative(difference)
      ? "underfunded"
      : "funded";

  return {
    account: reading.account,
    earmarks: claims,
    claimed,
    backing,
    status,
    shortfall: status === "underfunded" ? subtract(claimed, backing) : null,
    free: status === "funded" ? difference : null,
    carried: reading.line.source === "carried",
    measuredOn: reading.line.measuredOn,
  };
}

/**
 * Every account with a claim against it, read against one snapshot. Accounts with
 * no earmark are left out: this answers "what is spoken for", not "what is there".
 *
 * Only claims that stood on the snapshot's own date are read, so restating an old
 * snapshot never shows it a promise nobody had made yet.
 */
export function earmarkFunding(input: {
  readonly snapshot: Snapshot;
  readonly accounts: readonly Account[];
  readonly earmarks: readonly Earmark[];
}): readonly AccountEarmarks[] {
  const standing = earmarksActiveOn(input.earmarks, input.snapshot.takenOn);

  return snapshotReadings(input.snapshot, input.accounts).flatMap((reading) => {
    const funding = fundingFor(reading, standing);
    return funding.earmarks.length === 0 ? [] : [funding];
  });
}

/** Every claim, one row each, flattened out of the accounts they sit on. */
export function claimRows(
  funding: readonly AccountEarmarks[],
): readonly { readonly earmark: Earmark; readonly account: AccountEarmarks }[] {
  return funding.flatMap((account) =>
    account.earmarks.map((earmark) => ({ earmark, account })),
  );
}

// --- what is actually free ---------------------------------------------------

/**
 * How much liquid money is genuinely available. נזילות is the קטגוריה the
 * household reads as "money we can reach"; a claim against an account in another
 * bucket is spoken for out of *that* bucket, so it does not reduce this figure.
 *
 * The claim is subtracted whole, even where the account backing it is short: what
 * was promised is what was promised, and the part of it with nothing behind it is
 * reported separately as a shortfall rather than quietly written off.
 */
export interface FreeLiquid {
  readonly currency: Currency;
  /** Everything in the נזילות bucket, at this snapshot's own rate. */
  readonly holdings: Money;
  /** The claims standing against those accounts. */
  readonly earmarked: Money;
  /** `holdings − earmarked`. Negative when more is promised than is held. */
  readonly free: Money;
  /** How much of the claims has nothing behind it, summed over the accounts that are short. */
  readonly shortfall: Money;
  /** Liquid accounts nobody has ever measured — the figure above rests on their placeholders. */
  readonly unmeasuredAccounts: number;
  /** The accounts that carry a claim, so the total opens onto exactly what it is made of. */
  readonly claimed: readonly AccountEarmarks[];
}

const LIQUID = "liquid" as const;

export function freeLiquid(input: {
  readonly snapshot: Snapshot;
  readonly accounts: readonly Account[];
  readonly earmarks: readonly Earmark[];
  readonly currency: Currency;
}): FreeLiquid {
  const { snapshot, currency } = input;
  const liquid = snapshotReadings(snapshot, input.accounts).filter(
    (reading) => reading.account.category === LIQUID,
  );
  const standing = earmarksActiveOn(input.earmarks, snapshot.takenOn);

  const holdings = sum(
    liquid.map((reading) => convertWithin(snapshot, reading.native, currency)),
    currency,
  );

  let earmarked = zero(currency);
  let shortfall = zero(currency);
  const claimed: AccountEarmarks[] = [];

  for (const reading of liquid) {
    const funding = fundingFor(reading, standing);
    if (funding.earmarks.length === 0) continue;

    claimed.push(funding);
    earmarked = add(earmarked, convertWithin(snapshot, funding.claimed, currency));
    if (funding.shortfall !== null) {
      shortfall = add(shortfall, convertWithin(snapshot, funding.shortfall, currency));
    }
  }

  return {
    currency,
    holdings,
    earmarked,
    free: subtract(holdings, earmarked),
    shortfall,
    unmeasuredAccounts: liquid.filter((reading) => isUnmeasured(reading.line)).length,
    claimed,
  };
}
