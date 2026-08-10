/**
 * Snapshot (מיפוי) — Accounts, and a complete dated restatement of every one of
 * them.
 *
 * Framework-free per ADR 0004.
 *
 * A Snapshot answers "where is our money and how much of it", not "what are we
 * worth". Two rules make it answerable:
 *
 * **Complete by construction.** A snapshot is not a set of rows someone chose to
 * fill in; it is seeded with one line for every Account active on its date, taken
 * forward from the previous snapshot. There is no shape in which an account is
 * silently absent and the total is quietly short.
 *
 * **Every figure says whether it was measured.** A line is `entered` — someone
 * stated it for this snapshot's date — or `carried`, meaning nobody did and the
 * figure came forward. `measuredOn` names the date the figure was last stated, so
 * a pension untouched for five months cannot masquerade as a measured flat line.
 *
 * **One rate per snapshot.** A snapshot carries its own exchange rates, and every
 * conversion inside it uses them. Re-reading a snapshot from 2024 converts at the
 * rate that applied in 2024, forever — the spreadsheet's hardcoded 3.602 drifting
 * from מיפוי's live rate is exactly the failure this shape prevents.
 *
 * Per ADR 0003 nothing here re-values anything: a cost-held account reads at its
 * cost, and the Value Basis travels with every figure so the reader knows which
 * is which.
 */

import {
  type Currency,
  type ExchangeRate,
  type Money,
  add,
  convert,
  sum,
  zero,
} from "@/domain/money/money";
import { type CalendarDate, compareDates, dateKey, datesEqual } from "@/domain/time/calendar-date";

// --- accounts ----------------------------------------------------------------

/**
 * How an Account's value was arrived at. Required on every Account: a figure
 * whose provenance is unknown is the thing this system exists to stop producing.
 */
export type ValueBasis = "market" | "cost" | "estimate";

export const VALUE_BASES: readonly ValueBasis[] = ["market", "cost", "estimate"];

export const VALUE_BASIS_LABELS: Record<ValueBasis, string> = {
  market: "שווי שוק",
  cost: "עלות",
  estimate: "הערכה",
};

export function isValueBasis(value: unknown): value is ValueBasis {
  return typeof value === "string" && (VALUE_BASES as string[]).includes(value);
}

/** קטגוריה — the rollup bucket. Closed, because a rollup over free text is a typo away from being wrong. */
export type AssetCategory = "liquid" | "investments" | "pension" | "property";

export const ASSET_CATEGORIES: readonly AssetCategory[] = ["liquid", "investments", "pension", "property"];

export const ASSET_CATEGORY_LABELS: Record<AssetCategory, string> = {
  liquid: "נזילות",
  investments: "השקעות",
  pension: "פנסיה",
  property: 'נדל"ן',
};

export function isAssetCategory(value: unknown): value is AssetCategory {
  return typeof value === "string" && (ASSET_CATEGORIES as string[]).includes(value);
}

export interface Account {
  readonly id: string;
  readonly personId: string;
  /** The household's own naming — `עו"ש דיסקונט`, `איילון קרן כספית`. */
  readonly name: string;
  /** What the account *is* held in. Balances are never pre-converted. */
  readonly currency: Currency;
  readonly valueBasis: ValueBasis;
  readonly category: AssetCategory;
  /** סוג נכס — the finer grouping under קטגוריה. Free text; the household's own words. */
  readonly assetKind: string;
  readonly openedOn: CalendarDate;
  /** Closing is a lifespan, never a delete: every snapshot the account appears in keeps resolving. */
  readonly closedOn: CalendarDate | null;
}

export class InvalidAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAccountError";
  }
}

export class UnknownAccountError extends Error {
  constructor(readonly accountId: string) {
    super(`No such account: ${accountId}`);
    this.name = "UnknownAccountError";
  }
}

/** Trim and collapse inner whitespace, as category names are. */
export function normaliseAccountName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function requireText(value: string, what: string): string {
  const normalised = normaliseAccountName(value);
  if (normalised.length === 0) {
    throw new InvalidAccountError(`${what} cannot be empty`);
  }
  if (normalised.length > 60) {
    throw new InvalidAccountError(`${what} cannot exceed 60 characters, received ${normalised.length}`);
  }
  return normalised;
}

export interface AccountDefinition {
  readonly personId: string;
  readonly name: string;
  readonly currency: Currency;
  readonly valueBasis: ValueBasis;
  readonly category: AssetCategory;
  readonly assetKind: string;
  readonly openedOn: CalendarDate;
  readonly closedOn?: CalendarDate | null;
}

/**
 * Build and validate. Every field an Account must carry is checked here rather
 * than only in the form, because the database and the tests both hand data
 * straight to the domain.
 */
export function buildAccount(id: string, definition: AccountDefinition): Account {
  if (!isValueBasis(definition.valueBasis)) {
    throw new InvalidAccountError(`Value Basis is required and must be one of ${VALUE_BASES.join(", ")}`);
  }
  if (!isAssetCategory(definition.category)) {
    throw new InvalidAccountError(`קטגוריה must be one of ${ASSET_CATEGORIES.join(", ")}`);
  }
  const closedOn = definition.closedOn ?? null;
  if (closedOn !== null && compareDates(closedOn, definition.openedOn) < 0) {
    throw new InvalidAccountError("An account cannot be closed before it was opened");
  }

  return {
    id,
    personId: definition.personId,
    name: requireText(definition.name, "An account name"),
    currency: definition.currency,
    valueBasis: definition.valueBasis,
    category: definition.category,
    assetKind: requireText(definition.assetKind, "סוג נכס"),
    openedOn: definition.openedOn,
    closedOn,
  };
}

/** Whether the account's lifespan covers a date. `closedOn` is inclusive. */
export function isOpenOn(account: Account, date: CalendarDate): boolean {
  if (compareDates(date, account.openedOn) < 0) return false;
  return account.closedOn === null || compareDates(date, account.closedOn) <= 0;
}

function sortAccounts(accounts: readonly Account[]): Account[] {
  return [...accounts].sort((left, right) => {
    const byCategory = ASSET_CATEGORIES.indexOf(left.category) - ASSET_CATEGORIES.indexOf(right.category);
    if (byCategory !== 0) return byCategory;
    const byKind = left.assetKind.localeCompare(right.assetKind, "he");
    if (byKind !== 0) return byKind;
    return left.name.localeCompare(right.name, "he");
  });
}

/** Every Account open on a date, in reading order. What a snapshot of that date must cover. */
export function accountsOpenOn(accounts: readonly Account[], date: CalendarDate): readonly Account[] {
  return sortAccounts(accounts.filter((account) => isOpenOn(account, date)));
}

export function findAccount(accounts: readonly Account[], id: string): Account | undefined {
  return accounts.find((account) => account.id === id);
}

export function requireAccount(accounts: readonly Account[], id: string): Account {
  const account = findAccount(accounts, id);
  if (account === undefined) {
    throw new UnknownAccountError(id);
  }
  return account;
}

// --- the snapshot ------------------------------------------------------------

/**
 * `entered` — someone stated this figure for this snapshot's date.
 * `carried` — nobody did; it came forward from an earlier snapshot, or from
 * nowhere at all if the account has never been valued.
 */
export type LineSource = "entered" | "carried";

export interface SnapshotLine {
  readonly accountId: string;
  /** In the account's own currency. Never pre-converted. */
  readonly balance: Money;
  readonly source: LineSource;
  /**
   * The date this figure was last stated by a human. Equal to the snapshot's own
   * date when `entered`; earlier when `carried`; `null` when the account has
   * never been valued and the balance is a placeholder rather than a measurement.
   */
  readonly measuredOn: CalendarDate | null;
}

export interface Snapshot {
  readonly id: string;
  readonly takenOn: CalendarDate;
  /** At most one per ordered currency pair. Every conversion inside this snapshot uses these. */
  readonly rates: readonly ExchangeRate[];
  /** One per Account open on `takenOn`. Complete by construction. */
  readonly lines: readonly SnapshotLine[];
}

export class MalformedSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedSnapshotError";
  }
}

export class MissingSnapshotRateError extends Error {
  constructor(
    readonly from: Currency,
    readonly to: Currency,
    readonly takenOn: CalendarDate,
  ) {
    super(
      `The snapshot of ${dateKey(takenOn)} carries no ${from}/${to} rate; ` +
        "a snapshot converts only at its own rate, never at today's",
    );
    this.name = "MissingSnapshotRateError";
  }
}

/**
 * Build and validate. The two rules checked here are the two that make a snapshot
 * readable years later: one line per account, and a `source` that provably agrees
 * with `measuredOn` rather than merely sitting beside it.
 */
export function buildSnapshot(input: {
  readonly id: string;
  readonly takenOn: CalendarDate;
  readonly rates: readonly ExchangeRate[];
  readonly lines: readonly SnapshotLine[];
}): Snapshot {
  const pairs = new Set<string>();
  for (const rate of input.rates) {
    if (rate.from === rate.to) {
      throw new MalformedSnapshotError(`A snapshot rate cannot convert ${rate.from} to itself`);
    }
    const pair = `${rate.from}/${rate.to}`;
    if (pairs.has(pair)) {
      throw new MalformedSnapshotError(`The snapshot carries more than one ${pair} rate`);
    }
    pairs.add(pair);
  }

  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.accountId)) {
      throw new MalformedSnapshotError(`Account ${line.accountId} appears more than once in the snapshot`);
    }
    seen.add(line.accountId);

    if (line.source === "entered") {
      if (line.measuredOn === null || !datesEqual(line.measuredOn, input.takenOn)) {
        throw new MalformedSnapshotError(
          `Account ${line.accountId} is marked entered but was not measured on ${dateKey(input.takenOn)}`,
        );
      }
    } else if (line.measuredOn !== null && compareDates(line.measuredOn, input.takenOn) >= 0) {
      throw new MalformedSnapshotError(
        `Account ${line.accountId} is marked carried but claims to have been measured on ` +
          `${dateKey(line.measuredOn)}, which is not earlier than ${dateKey(input.takenOn)}`,
      );
    }
  }

  return { id: input.id, takenOn: input.takenOn, rates: [...input.rates], lines: [...input.lines] };
}

export function findLine(snapshot: Snapshot, accountId: string): SnapshotLine | undefined {
  return snapshot.lines.find((line) => line.accountId === accountId);
}

/** True when a line is a placeholder rather than a figure anyone has ever stated. */
export function isUnmeasured(line: SnapshotLine): boolean {
  return line.measuredOn === null;
}

// --- taking one -------------------------------------------------------------

export class SnapshotOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotOrderError";
  }
}

/**
 * Seed a new snapshot. Every Account open on the date gets a line, carried
 * forward from the previous snapshot's value — so restating means correcting what
 * changed rather than re-typing everything, and no account can be left out by
 * being forgotten.
 *
 * An account the previous snapshot did not hold — a newly defined one, or the
 * very first snapshot ever — gets a zero line with no `measuredOn`. That is not a
 * balance of nothing; it is the absence of a measurement, and it reads as such.
 *
 * No cadence is imposed: any date after the previous snapshot's is acceptable.
 */
export function seedSnapshot(input: {
  readonly id: string;
  readonly takenOn: CalendarDate;
  readonly rates: readonly ExchangeRate[];
  readonly accounts: readonly Account[];
  readonly previous: Snapshot | null;
}): Snapshot {
  if (input.previous !== null && compareDates(input.takenOn, input.previous.takenOn) <= 0) {
    throw new SnapshotOrderError(
      `A snapshot taken on ${dateKey(input.takenOn)} would not follow the previous one of ` +
        `${dateKey(input.previous.takenOn)}`,
    );
  }

  const lines = accountsOpenOn(input.accounts, input.takenOn).map((account) =>
    carryForward(account, input.previous),
  );

  return buildSnapshot({ id: input.id, takenOn: input.takenOn, rates: input.rates, lines });
}

function carryForward(account: Account, previous: Snapshot | null): SnapshotLine {
  const before = previous === null ? undefined : findLine(previous, account.id);
  if (before === undefined) {
    return { accountId: account.id, balance: zero(account.currency), source: "carried", measuredOn: null };
  }
  return {
    accountId: account.id,
    balance: before.balance,
    source: "carried",
    // A figure entered on the previous snapshot's date was measured then; one
    // already carried keeps pointing at whenever it was actually stated.
    measuredOn: before.source === "entered" ? previous?.takenOn ?? null : before.measuredOn,
  };
}

/**
 * Accounts that are open on the snapshot's date but hold no line — the case where
 * an account was defined after the snapshot was taken. A snapshot is complete when
 * this is empty, and the screen offers to fill the gap rather than pretending it
 * is not there.
 */
export function accountsMissingFrom(snapshot: Snapshot, accounts: readonly Account[]): readonly Account[] {
  return accountsOpenOn(accounts, snapshot.takenOn).filter(
    (account) => findLine(snapshot, account.id) === undefined,
  );
}

export function addMissingLines(snapshot: Snapshot, accounts: readonly Account[]): Snapshot {
  const added = accountsMissingFrom(snapshot, accounts).map((account) => carryForward(account, null));
  if (added.length === 0) return snapshot;
  return buildSnapshot({ ...snapshot, lines: [...snapshot.lines, ...added] });
}

// --- restating --------------------------------------------------------------

/**
 * One figure as a human submitted it. `measured` is the reader saying "I looked
 * at this today" — without it, a resubmitted identical figure is still a carried
 * one, because re-sending a form is not a measurement.
 */
export interface AccountStatement {
  readonly accountId: string;
  readonly balance: Money;
  readonly measured: boolean;
}

/**
 * Apply a restatement. A line becomes `entered` when its figure changed or when
 * it was explicitly confirmed; otherwise it keeps carrying, with the date it was
 * last actually measured untouched.
 */
export function restate(snapshot: Snapshot, statements: readonly AccountStatement[]): Snapshot {
  const byAccount = new Map(statements.map((statement) => [statement.accountId, statement]));

  const lines = snapshot.lines.map((line) => {
    const statement = byAccount.get(line.accountId);
    if (statement === undefined) return line;

    if (statement.balance.currency !== line.balance.currency) {
      throw new MalformedSnapshotError(
        `Account ${line.accountId} is held in ${line.balance.currency}; ` +
          `a ${statement.balance.currency} figure would silently re-denominate it`,
      );
    }

    const changed = statement.balance.minorUnits !== line.balance.minorUnits;
    if (!changed && !statement.measured) return line;

    return {
      accountId: line.accountId,
      balance: statement.balance,
      source: "entered" as const,
      measuredOn: snapshot.takenOn,
    };
  });

  return buildSnapshot({ ...snapshot, lines });
}

// --- reading ----------------------------------------------------------------

/**
 * The rate this snapshot converts a pair at. Converting a currency to itself is
 * the identity and needs no stored rate; anything else throws rather than falling
 * back to a rate from elsewhere, which is the whole point of the rate living on
 * the snapshot.
 */
export function rateWithin(snapshot: Snapshot, from: Currency, to: Currency): ExchangeRate {
  if (from === to) return { from, to, rate: 1 };
  const rate = snapshot.rates.find((candidate) => candidate.from === from && candidate.to === to);
  if (rate === undefined) {
    throw new MissingSnapshotRateError(from, to, snapshot.takenOn);
  }
  return rate;
}

export function hasRateWithin(snapshot: Snapshot, from: Currency, to: Currency): boolean {
  if (from === to) return true;
  return snapshot.rates.some((candidate) => candidate.from === from && candidate.to === to);
}

/**
 * Convert inside a snapshot. The only conversion path for a snapshot figure: it
 * cannot reach today's rate, so re-reading a historical snapshot produces the
 * figures it produced when it was taken.
 */
export function convertWithin(snapshot: Snapshot, amount: Money, to: Currency): Money {
  if (amount.currency === to) return amount;
  return convert(amount, rateWithin(snapshot, amount.currency, to));
}

/** One account's line, read with the account beside it. Nothing is converted here. */
export interface SnapshotReading {
  readonly account: Account;
  readonly line: SnapshotLine;
  /** The recorded figure, in the account's own currency. The stored fact. */
  readonly native: Money;
}

/** The same reading, restated in one currency at this snapshot's own rate. */
export interface ConvertedReading extends SnapshotReading {
  readonly converted: Money;
}

/**
 * Every account this snapshot holds, in the currency each is held in. This is the
 * read path that always works: it needs no rate, because nothing here is
 * converted.
 */
export function snapshotReadings(
  snapshot: Snapshot,
  accounts: readonly Account[],
): readonly SnapshotReading[] {
  return accountsOpenOn(accounts, snapshot.takenOn).flatMap((account) => {
    const line = findLine(snapshot, account.id);
    if (line === undefined) return [];
    return [{ account, line, native: line.balance }];
  });
}

/**
 * The same readings restated in one currency. Throws when the snapshot carries no
 * rate for a pair it would need: a total that quietly dropped the dollar accounts,
 * or reached for today's rate to include them, is worse than no total.
 */
export function convertedReadings(
  snapshot: Snapshot,
  accounts: readonly Account[],
  currency: Currency,
): readonly ConvertedReading[] {
  return snapshotReadings(snapshot, accounts).map((reading) => ({
    ...reading,
    converted: convertWithin(snapshot, reading.native, currency),
  }));
}

export function snapshotTotal(
  snapshot: Snapshot,
  accounts: readonly Account[],
  currency: Currency,
): Money {
  return sum(
    convertedReadings(snapshot, accounts, currency).map((reading) => reading.converted),
    currency,
  );
}

/** How much of a snapshot was actually measured on its own date. */
export interface SnapshotCompleteness {
  readonly entered: number;
  readonly carried: number;
  /** Lines for accounts nobody has ever valued. */
  readonly unmeasured: number;
  readonly total: number;
}

export function completenessOf(snapshot: Snapshot): SnapshotCompleteness {
  let entered = 0;
  let carried = 0;
  let unmeasured = 0;

  for (const line of snapshot.lines) {
    if (line.source === "entered") entered += 1;
    else carried += 1;
    if (isUnmeasured(line)) unmeasured += 1;
  }

  return { entered, carried, unmeasured, total: snapshot.lines.length };
}

// --- rollups ----------------------------------------------------------------

/** Which grouping a rollup is over. Both are fields of the Account, never of the line. */
export type RollupDimension = "category" | "assetKind";

export interface RollupLine {
  /** The `AssetCategory` value, or the סוג נכס text. */
  readonly key: string;
  readonly total: Money;
  readonly accountCount: number;
  /** How many of the accounts in this bucket carry a figure nobody stated at this date. */
  readonly carriedCount: number;
}

function bucketOf(account: Account, dimension: RollupDimension): string {
  return dimension === "category" ? account.category : account.assetKind;
}

/**
 * Roll a snapshot up by קטגוריה or by סוג נכס — נזילות, השקעות, פנסיה, נדל"ן.
 * The buckets come from the Account, so a rollup and the account list can never
 * disagree about which bucket a figure is in.
 *
 * Every bucket also reports how many of its figures were carried rather than
 * measured, because a rollup that hides that is the flat line ADR 0003 warns
 * about wearing a different hat.
 */
export function rollupBy(
  snapshot: Snapshot,
  accounts: readonly Account[],
  currency: Currency,
  dimension: RollupDimension,
): readonly RollupLine[] {
  const buckets = new Map<string, { total: Money; accountCount: number; carriedCount: number }>();

  for (const reading of convertedReadings(snapshot, accounts, currency)) {
    const key = bucketOf(reading.account, dimension);
    const bucket = buckets.get(key) ?? { total: zero(currency), accountCount: 0, carriedCount: 0 };
    buckets.set(key, {
      total: add(bucket.total, reading.converted),
      accountCount: bucket.accountCount + 1,
      carriedCount: bucket.carriedCount + (reading.line.source === "carried" ? 1 : 0),
    });
  }

  const lines = [...buckets].map(([key, bucket]) => ({ key, ...bucket }));

  // קטגוריה has an order the household reads in; סוג נכס is their own words, so alphabetical.
  return dimension === "category"
    ? lines.sort(
        (left, right) =>
          ASSET_CATEGORIES.indexOf(left.key as AssetCategory) -
          ASSET_CATEGORIES.indexOf(right.key as AssetCategory),
      )
    : lines.sort((left, right) => left.key.localeCompare(right.key, "he"));
}

/**
 * The readings behind one bucket — what a total opens onto. Takes the readings
 * rather than the snapshot, so a drill-down is always a filter of the very list
 * the total was computed from and cannot disagree with it.
 */
export function readingsIn<Reading extends { readonly account: Account }>(
  readings: readonly Reading[],
  dimension: RollupDimension,
  key: string,
): readonly Reading[] {
  return readings.filter((reading) => bucketOf(reading.account, dimension) === key);
}

/** The snapshot immediately before a date, or `null`. What a new one seeds from. */
export function previousSnapshot(
  snapshots: readonly Snapshot[],
  date: CalendarDate,
): Snapshot | null {
  const earlier = snapshots
    .filter((snapshot) => compareDates(snapshot.takenOn, date) < 0)
    .sort((left, right) => compareDates(left.takenOn, right.takenOn));
  return earlier[earlier.length - 1] ?? null;
}
