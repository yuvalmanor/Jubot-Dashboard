/**
 * AnnualReview — סיכום שנתי, where a year ended, across every feature at once.
 *
 * Framework-free per ADR 0004.
 *
 * ADR 0002 is the whole design: a review freezes **only what cannot be
 * recomputed**. The state of the world on the closing day — the USD/ILS rate, the
 * share price, and the valuations somebody placed on the real-estate projects —
 * is gone the moment the day passes, so it is stored here. Everything else is a
 * pure function of records that still exist, and freezing it would only create a
 * second copy that goes stale the moment a typo from that year is corrected.
 *
 * So the מאזן bottom line is recomputed from the Ledger on every read, through the
 * same `categoryBreakdown` the insights screens use. Correcting a 2025 entry moves
 * the 2025 review, which is the point rather than a defect.
 *
 * The consequence ADR 0002 names — two prints of one review disagreeing — is only
 * safe if the reader can tell which figures move. That is what `Stated` is for:
 * **every figure here travels with the basis it rests on**, and there is no shape
 * in this module that yields a bare `Money`. A screen cannot print a frozen figure
 * as live, or a live one as frozen, because it never holds one without the other.
 *
 * Three bases, because a mixture is neither of the two:
 *
 * - `live` — recomputed from records on every read.
 * - `frozen` — stated on the review; nothing can reconstruct it afterwards.
 * - `live-at-frozen` — a live quantity read at a frozen fact. The RSU holding is
 *   the household's own share count, which moves, priced at the share price the
 *   year closed at, which does not.
 *
 * Per ADR 0003 a frozen valuation never becomes a project's מיפוי value. It sits
 * beside the cost the funding legs still add up to, and the difference between the
 * two is stated — a judgement recorded once is not a re-valuation of an illiquid
 * asset.
 */

import {
  type Categories,
} from "@/domain/categories/categories";
import { type Ledger } from "@/domain/ledger/ledger";
import {
  HOUSEHOLD_SCOPE,
  categoryBreakdown,
  yearPeriod,
} from "@/domain/ledger/ledger-analytics";
import {
  type Currency,
  type ExchangeRate,
  type Money,
  add,
  convert,
  convertBack,
  subtract,
  sum,
  zero,
} from "@/domain/money/money";
import {
  type FundingLeg,
  type Pot,
  type Project,
  type ProjectExpense,
  potOf,
  projectsInReadingOrder,
} from "@/domain/projects/projects";
import {
  type RsuPosition,
  type SharePrice,
  valueOf,
} from "@/domain/rsu/rsu-position";
import {
  type Account,
  type BasisSplit,
  type Snapshot,
  basisSplitOf,
  canConvertWithin,
  convertedReadings,
  snapshotReadings,
} from "@/domain/snapshot/snapshot";
import {
  type CalendarDate,
  dateKey,
  datesEqual,
  lastDayOf,
} from "@/domain/time/calendar-date";
import { type CalendarMonth, calendarMonth } from "@/domain/time/calendar-month";

// --- what a figure rests on ---------------------------------------------------

export type FigureBasis = "live" | "frozen" | "live-at-frozen";

/**
 * A figure and the basis it rests on, together. Nothing here returns a value
 * without one, so "is this number recomputed or is it a fact I recorded" is
 * never a question the reader has to answer from context.
 */
export interface Stated<Value> {
  readonly value: Value;
  readonly basis: FigureBasis;
}

export function live<Value>(value: Value): Stated<Value> {
  return { value, basis: "live" };
}

export function frozen<Value>(value: Value): Stated<Value> {
  return { value, basis: "frozen" };
}

/** A live quantity read at a frozen fact — held shares at the closing price. */
export function atFrozen<Value>(value: Value): Stated<Value> {
  return { value, basis: "live-at-frozen" };
}

// --- the review itself --------------------------------------------------------

/**
 * What somebody judged a project to be worth at the close. A promise of a figure
 * nothing else records: the project's *cost* is recomputable from its funding legs
 * forever, but what it was thought to be worth on 31 December is not.
 */
export interface ProjectValuation {
  readonly projectId: string;
  readonly amount: Money;
}

export interface AnnualReview {
  readonly year: number;
  /** When the review was written down. Not the year's closing date — that is derived. */
  readonly recordedOn: CalendarDate;
  readonly note: string | null;
  /** The reading the household says the year closed on, or `null` while none is chosen. */
  readonly closingSnapshotId: string | null;
  /** Frozen: quoted USD/ILS in both directions, so one number can never read as two. */
  readonly closingRate: ExchangeRate | null;
  /** Frozen: what a share was worth at the close. */
  readonly closingSharePrice: SharePrice | null;
  /** Frozen: one per project at most. */
  readonly valuations: readonly ProjectValuation[];
}

export interface AnnualReviewDefinition {
  readonly year: number;
  readonly recordedOn: CalendarDate;
  readonly note?: string | null;
  readonly closingSnapshotId?: string | null;
  readonly closingRate?: ExchangeRate | null;
  readonly closingSharePrice?: SharePrice | null;
  readonly valuations?: readonly ProjectValuation[];
}

export class InvalidAnnualReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAnnualReviewError";
  }
}

export class UnknownAnnualReviewError extends Error {
  constructor(readonly year: number) {
    super(`No annual review for ${year}`);
    this.name = "UnknownAnnualReviewError";
  }
}

const EARLIEST_YEAR = 2000;
const LATEST_YEAR = 2100;

function normaliseNote(note: string | null | undefined): string | null {
  const text = (note ?? "").trim();
  return text.length === 0 ? null : text;
}

export function buildAnnualReview(definition: AnnualReviewDefinition): AnnualReview {
  const { year } = definition;
  if (!Number.isInteger(year) || year < EARLIEST_YEAR || year > LATEST_YEAR) {
    throw new InvalidAnnualReviewError(
      `A review is for one calendar year between ${EARLIEST_YEAR} and ${LATEST_YEAR}, received ${String(year)}`,
    );
  }

  const closingRate = definition.closingRate ?? null;
  if (closingRate !== null && (closingRate.from !== "USD" || closingRate.to !== "ILS")) {
    // The same rule the funding legs and the snapshot rates hold: one stored
    // number, quoted one way, read in both directions.
    throw new InvalidAnnualReviewError(
      `The closing rate is quoted USD/ILS, received ${closingRate.from}/${closingRate.to}`,
    );
  }

  const valuations = definition.valuations ?? [];
  const seen = new Set<string>();
  for (const valuation of valuations) {
    if (seen.has(valuation.projectId)) {
      throw new InvalidAnnualReviewError(
        `Project ${valuation.projectId} is valued more than once on the ${year} review`,
      );
    }
    seen.add(valuation.projectId);
    if (valuation.amount.minorUnits < 0) {
      throw new InvalidAnnualReviewError(
        `A valuation cannot be negative, received ${valuation.amount.minorUnits} for project ${valuation.projectId}`,
      );
    }
  }

  const snapshotId = (definition.closingSnapshotId ?? "").trim();

  return {
    year,
    recordedOn: definition.recordedOn,
    note: normaliseNote(definition.note),
    closingSnapshotId: snapshotId.length === 0 ? null : snapshotId,
    closingRate,
    closingSharePrice: definition.closingSharePrice ?? null,
    valuations: [...valuations],
  };
}

/** The last day of the year — the day everything on the review is read as of. */
export function closesOn(year: number): CalendarDate {
  return lastDayOf(calendarMonth(year, 12));
}

/** The last month of the year, for the ledger figures' own denominator. */
export function closingMonth(year: number): CalendarMonth {
  return calendarMonth(year, 12);
}

export function findAnnualReview(
  reviews: readonly AnnualReview[],
  year: number,
): AnnualReview | undefined {
  return reviews.find((review) => review.year === year);
}

export function requireAnnualReview(
  reviews: readonly AnnualReview[],
  year: number,
): AnnualReview {
  const review = findAnnualReview(reviews, year);
  if (review === undefined) throw new UnknownAnnualReviewError(year);
  return review;
}

/** Newest year first — the year just closed is the one being read. */
export function reviewsInReadingOrder(
  reviews: readonly AnnualReview[],
): readonly AnnualReview[] {
  return [...reviews].sort((left, right) => right.year - left.year);
}

export function valuationFor(review: AnnualReview, projectId: string): Money | null {
  return review.valuations.find((valuation) => valuation.projectId === projectId)?.amount ?? null;
}

/** A fact only the day itself could have supplied. Missing ones are named, never guessed. */
export type FrozenFact = "closing-snapshot" | "closing-rate" | "closing-share-price";

export function missingFacts(review: AnnualReview): readonly FrozenFact[] {
  const missing: FrozenFact[] = [];
  if (review.closingSnapshotId === null) missing.push("closing-snapshot");
  if (review.closingRate === null) missing.push("closing-rate");
  if (review.closingSharePrice === null) missing.push("closing-share-price");
  return missing;
}

// --- the מאזן bottom line, recomputed on every read ---------------------------

/**
 * הכנסות, הוצאות and חיסכון for the year, live.
 *
 * Read through the same `categoryBreakdown` the מאזן screens use, so the review
 * cannot state one bottom line while the insights page states another. Nothing
 * here is stored, which is exactly why correcting an old entry moves it.
 */
export interface BalanceLine {
  readonly year: number;
  readonly income: Stated<Money>;
  readonly expenses: Stated<Money>;
  readonly saving: Stated<Money>;
  /**
   * What an average over this year would divide by: the year's closed months, as
   * far as the ledger's history reaches. Twelve for a year the ledger covers end
   * to end, fewer for one it only reaches into — which is why the months
   * themselves travel beside the count.
   */
  readonly denominator: number;
  /** Which months that was. A count without them cannot be argued with. */
  readonly months: readonly CalendarMonth[];
  /** How many of those months hold anything. A year recorded in part says so. */
  readonly recordedMonths: number;
}

function readBalance(input: {
  readonly review: AnnualReview;
  readonly ledger: Ledger;
  readonly categories: Categories;
  readonly currency: Currency;
  readonly today: CalendarMonth;
}): BalanceLine {
  const breakdown = categoryBreakdown(
    input.ledger,
    input.categories,
    HOUSEHOLD_SCOPE,
    yearPeriod(input.review.year),
    input.currency,
    input.today,
  );

  return {
    year: input.review.year,
    income: live(breakdown.totals.income.total),
    expenses: live(breakdown.totals.expenses.total),
    saving: live(breakdown.totals.saving.total),
    denominator: breakdown.totals.income.denominator,
    months: breakdown.totals.income.months,
    recordedMonths: breakdown.totals.income.recordedMonths,
  };
}

// --- the closing snapshot ------------------------------------------------------

/**
 * The reading the year closed on, totalled at *its own* rate — never at the
 * review's. A snapshot keeps reading as it read on the day it was taken, and the
 * review's frozen rate is for the figures the review computes itself.
 *
 * The total is live: restating a line moves it, and it should.
 */
export interface NetWorthLine {
  readonly snapshotId: string;
  readonly takenOn: CalendarDate;
  /** `null` when the snapshot carries no rate for a currency it holds. */
  readonly total: Stated<Money> | null;
  readonly split: BasisSplit | null;
  readonly accountCount: number;
  /** Whether the reading was actually taken inside the year it is closing. */
  readonly withinYear: boolean;
}

function readNetWorth(input: {
  readonly review: AnnualReview;
  readonly snapshot: Snapshot;
  readonly accounts: readonly Account[];
  readonly currency: Currency;
}): NetWorthLine {
  const { snapshot } = input;
  const readings = snapshotReadings(snapshot, input.accounts);
  const convertible = readings.every((reading) =>
    canConvertWithin(snapshot, reading.account.currency, input.currency),
  );

  const converted = convertible ? convertedReadings(snapshot, input.accounts, input.currency) : null;
  const split = converted === null ? null : basisSplitOf(converted, input.currency);

  return {
    snapshotId: snapshot.id,
    takenOn: snapshot.takenOn,
    // The split's own total, not a second sum of the same rows.
    total: split === null ? null : live(split.total),
    split,
    accountCount: readings.length,
    withinYear: snapshot.takenOn.year === input.review.year,
  };
}

// --- the projects --------------------------------------------------------------

/**
 * One project at the close: what it still costs, and what somebody judged it to be
 * worth. The two are deliberately separate figures — per ADR 0003 the valuation is
 * never written back into מיפוי, and the difference between them is stated rather
 * than resolved.
 */
export interface ProjectLine {
  readonly project: Project;
  readonly pot: Pot;
  /** Σ(funding legs) in the pot's currency. Live: a leg recorded later moves it. */
  readonly cost: Stated<Money>;
  /** Σ(expenses) out of the pot, live. */
  readonly spent: Stated<Money>;
  /** `cost − spent`, live. */
  readonly balance: Stated<Money>;
  /** What the review froze, or `null` where nobody placed a valuation. */
  readonly valuation: Stated<Money> | null;
  /** `valuation − cost`, in the pot's currency. `null` where one of them is missing. */
  readonly aboveCost: Money | null;
}

export interface ProjectsSection {
  readonly lines: readonly ProjectLine[];
  /** Every project's cost in one currency. `null` where a conversion had no rate. */
  readonly cost: Stated<Money> | null;
  /** Every frozen valuation in one currency, `null` under the same rule. */
  readonly valuation: Stated<Money> | null;
  /** Projects whose figures could not be read into the review's currency. */
  readonly unreadable: readonly string[];
  /** Projects nobody placed a valuation on. Not an error — an absence of judgement. */
  readonly unvalued: readonly string[];
}

/**
 * Read an amount into the review's currency at the rate the review froze. Where no
 * conversion is needed the rate is not consulted at all; where one is needed and no
 * rate was frozen, the answer is `null` and the caller says so — nothing here
 * reaches for today's rate, which would make a closed year re-price itself.
 */
function atClosingRate(
  amount: Money,
  currency: Currency,
  rate: ExchangeRate | null,
): Money | null {
  if (amount.currency === currency) return amount;
  if (rate === null) return null;
  if (amount.currency === rate.from && currency === rate.to) return convert(amount, rate);
  if (amount.currency === rate.to && currency === rate.from) return convertBack(amount, rate);
  return null;
}

function readProjects(input: {
  readonly review: AnnualReview;
  readonly projects: readonly Project[];
  readonly legs: readonly FundingLeg[];
  readonly expenses: readonly ProjectExpense[];
  readonly currency: Currency;
}): ProjectsSection {
  const { review, currency } = input;

  const lines = projectsInReadingOrder(input.projects).map<ProjectLine>((project) => {
    const pot = potOf(project, input.legs, input.expenses);
    const valuation = valuationFor(review, project.id);
    const comparable = valuation !== null && valuation.currency === pot.funded.currency;

    return {
      project,
      pot,
      cost: live(pot.funded),
      spent: live(pot.spent),
      balance: live(pot.balance),
      valuation: valuation === null ? null : frozen(valuation),
      aboveCost: comparable && valuation !== null ? subtract(valuation, pot.funded) : null,
    };
  });

  const unreadable: string[] = [];
  let cost = zero(currency);
  let converted = false;

  for (const line of lines) {
    const readable = atClosingRate(line.pot.funded, currency, review.closingRate);
    if (readable === null) {
      unreadable.push(line.project.id);
      continue;
    }
    if (line.pot.funded.currency !== currency) converted = true;
    cost = add(cost, readable);
  }

  const valued = lines.flatMap((line) =>
    line.valuation === null
      ? []
      : [{ id: line.project.id, amount: atClosingRate(line.valuation.value, currency, review.closingRate) }],
  );
  const readableValuations = valued.flatMap((entry) => (entry.amount === null ? [] : [entry.amount]));
  const valuationUnreadable = valued.some((entry) => entry.amount === null);

  return {
    lines,
    // A total that dropped a project it could not read would be a smaller number
    // presented as the whole. Where anything is unreadable there is no total.
    cost: unreadable.length > 0 ? null : converted ? atFrozen(cost) : live(cost),
    valuation:
      valued.length === 0 || valuationUnreadable
        ? null
        : frozen(sum(readableValuations, currency)),
    unreadable,
    unvalued: lines.flatMap((line) => (line.valuation === null ? [line.project.id] : [])),
  };
}

// --- the RSU position ----------------------------------------------------------

/**
 * The position as the year closed: the household's own share count, derived from
 * the grants, vests and sales as of 31 December, at the price the review froze.
 *
 * The count is live and the price is not, so the value is neither — it is
 * `live-at-frozen`, and it says so. Selling a lot in the following March moves
 * nothing here, because the position is read as of the closing date; correcting a
 * 2025 sale does, because the count was never copied.
 */
export interface RsuLine {
  readonly asOf: CalendarDate;
  readonly shares: Stated<number>;
  readonly qualifiedShares: Stated<number>;
  readonly unqualifiedShares: Stated<number>;
  readonly price: Stated<SharePrice> | null;
  /** `shares × price`, `null` while no closing price is frozen. */
  readonly value: Stated<Money> | null;
  /** The same value at the frozen closing rate, `null` where no rate was frozen. */
  readonly valueInCurrency: Stated<Money> | null;
}

function readRsu(input: {
  readonly review: AnnualReview;
  readonly position: RsuPosition;
  readonly currency: Currency;
}): RsuLine {
  const { review, position } = input;
  const price = review.closingSharePrice;
  const value = price === null ? null : valueOf(price, position.remainingShares);
  const inCurrency = value === null ? null : atClosingRate(value, input.currency, review.closingRate);

  return {
    asOf: position.asOf,
    shares: live(position.remainingShares),
    qualifiedShares: live(position.qualifiedShares),
    unqualifiedShares: live(position.unqualifiedShares),
    price: price === null ? null : frozen(price),
    value: value === null ? null : atFrozen(value),
    valueInCurrency: inCurrency === null ? null : atFrozen(inCurrency),
  };
}

// --- the whole page in one reading --------------------------------------------

export interface AnnualReviewReading {
  readonly review: AnnualReview;
  readonly currency: Currency;
  readonly closesOn: CalendarDate;
  readonly balance: BalanceLine;
  /** `null` while no closing snapshot is named, or none could be loaded. */
  readonly netWorth: NetWorthLine | null;
  readonly projects: ProjectsSection;
  /** `null` while nothing was handed in — a household with no RSU records. */
  readonly rsu: RsuLine | null;
  readonly missing: readonly FrozenFact[];
}

export function readAnnualReview(input: {
  readonly review: AnnualReview;
  readonly ledger: Ledger;
  readonly categories: Categories;
  readonly currency: Currency;
  readonly today: CalendarMonth;
  readonly snapshot?: Snapshot | null;
  readonly accounts?: readonly Account[];
  readonly projects?: readonly Project[];
  readonly legs?: readonly FundingLeg[];
  readonly expenses?: readonly ProjectExpense[];
  /** Read as of the closing date by the caller. A position read on any other day is refused. */
  readonly position?: RsuPosition | null;
}): AnnualReviewReading {
  const { review, currency } = input;
  const closing = closesOn(review.year);

  const snapshot = input.snapshot ?? null;
  const position = input.position ?? null;

  if (position !== null && !datesEqual(position.asOf, closing)) {
    throw new InvalidAnnualReviewError(
      `The ${review.year} review reads the position as of ${dateKey(closing)}, ` +
        `and was handed one read on ${dateKey(position.asOf)}`,
    );
  }

  return {
    review,
    currency,
    closesOn: closing,
    balance: readBalance({
      review,
      ledger: input.ledger,
      categories: input.categories,
      currency,
      today: input.today,
    }),
    netWorth:
      snapshot === null
        ? null
        : readNetWorth({ review, snapshot, accounts: input.accounts ?? [], currency }),
    projects: readProjects({
      review,
      projects: input.projects ?? [],
      legs: input.legs ?? [],
      expenses: input.expenses ?? [],
      currency,
    }),
    rsu: position === null ? null : readRsu({ review, position, currency }),
    missing: missingFacts(review),
  };
}

// --- two reviews, side by side -------------------------------------------------

export type ReviewComparisonKey =
  | "income"
  | "expenses"
  | "saving"
  | "net-worth"
  | "project-cost"
  | "project-valuation"
  | "rsu-shares"
  | "rsu-value";

interface ComparisonRowBase {
  readonly key: ReviewComparisonKey;
  /** What both sides rest on. Identical on both, because it is a property of the row. */
  readonly basis: FigureBasis;
}

export interface MoneyComparisonRow extends ComparisonRowBase {
  readonly kind: "money";
  readonly earlier: Money | null;
  readonly later: Money | null;
  /** `later − earlier` — progress reads forwards. `null` where the two are not comparable. */
  readonly difference: Money | null;
  readonly comparable: boolean;
}

export interface CountComparisonRow extends ComparisonRowBase {
  readonly kind: "count";
  readonly earlier: number | null;
  readonly later: number | null;
  readonly difference: number | null;
}

export type ReviewComparisonRow = MoneyComparisonRow | CountComparisonRow;

export interface AnnualReviewComparison {
  readonly earlier: AnnualReviewReading;
  readonly later: AnnualReviewReading;
  readonly rows: readonly ReviewComparisonRow[];
  /** The rate each year froze. A `live-at-frozen` row was read at its own year's. */
  readonly rates: {
    readonly earlier: ExchangeRate | null;
    readonly later: ExchangeRate | null;
  };
  /**
   * Whether both sides converted at the same rate. Where they did not, part of the
   * difference on every converted row is the rate moving rather than money moving,
   * and the screen must say so — the same rule two snapshots at two rates hold.
   */
  readonly sameRate: boolean;
}

export class InvalidReviewComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReviewComparisonError";
  }
}

function moneyRow(
  key: ReviewComparisonKey,
  basis: FigureBasis,
  earlier: Money | null,
  later: Money | null,
): MoneyComparisonRow {
  const comparable = earlier !== null && later !== null && earlier.currency === later.currency;
  return {
    kind: "money",
    key,
    basis,
    earlier,
    later,
    difference: comparable && earlier !== null && later !== null ? subtract(later, earlier) : null,
    comparable,
  };
}

function countRow(
  key: ReviewComparisonKey,
  basis: FigureBasis,
  earlier: number | null,
  later: number | null,
): CountComparisonRow {
  const both = earlier !== null && later !== null;
  return {
    kind: "count",
    key,
    basis,
    earlier,
    later,
    difference: both ? later - earlier : null,
  };
}

function stated(row: ReviewComparisonRow): boolean {
  return row.earlier !== null || row.later !== null;
}

/**
 * Two years side by side, always in calendar order: the earlier year on one side
 * and the later on the other, whichever way round they were handed in. That is
 * what makes `later − earlier` mean progress rather than depend on which one the
 * household happened to pick first.
 *
 * Every figure is one each review already shows on its own page, read out of the
 * same reading — so a year cannot say one thing alone and another beside its
 * neighbour. And each row carries its basis, because "net worth rose" means
 * something different when the figure is a live recomputation than when it is a
 * frozen judgement.
 */
export function compareAnnualReviews(
  left: AnnualReviewReading,
  right: AnnualReviewReading,
): AnnualReviewComparison {
  if (left.review.year === right.review.year) {
    throw new InvalidReviewComparisonError(
      `A review compared against itself answers nothing; ${left.review.year} was given twice`,
    );
  }

  const [earlier, later] =
    left.review.year < right.review.year ? [left, right] : [right, left];

  const rows: ReviewComparisonRow[] = [
    moneyRow("income", "live", earlier.balance.income.value, later.balance.income.value),
    moneyRow("expenses", "live", earlier.balance.expenses.value, later.balance.expenses.value),
    moneyRow("saving", "live", earlier.balance.saving.value, later.balance.saving.value),
    moneyRow(
      "net-worth",
      "live",
      earlier.netWorth?.total?.value ?? null,
      later.netWorth?.total?.value ?? null,
    ),
    moneyRow(
      "project-cost",
      earlier.projects.cost?.basis ?? later.projects.cost?.basis ?? "live",
      earlier.projects.cost?.value ?? null,
      later.projects.cost?.value ?? null,
    ),
    moneyRow(
      "project-valuation",
      "frozen",
      earlier.projects.valuation?.value ?? null,
      later.projects.valuation?.value ?? null,
    ),
    countRow("rsu-shares", "live", earlier.rsu?.shares.value ?? null, later.rsu?.shares.value ?? null),
    moneyRow(
      "rsu-value",
      "live-at-frozen",
      earlier.rsu?.value?.value ?? null,
      later.rsu?.value?.value ?? null,
    ),
  ];

  const rates = {
    earlier: earlier.review.closingRate,
    later: later.review.closingRate,
  };

  return {
    earlier,
    later,
    rows: rows.filter(stated),
    rates,
    // Two years that froze nothing converted nothing, so there is no rate for a
    // difference to be hiding in.
    sameRate:
      rates.earlier === null && rates.later === null
        ? true
        : rates.earlier !== null && rates.later !== null && rates.earlier.rate === rates.later.rate,
  };
}
