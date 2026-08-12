/**
 * Scenarios (לוח תכנון) — a named what-if, and the funding plan inside it.
 *
 * Framework-free per ADR 0004.
 *
 * A **Scenario** is a thought the household wants to hold onto — "CGM 3 in 2027",
 * "Meteor vs CGM 1" — and the whole point of it is that thinking it disturbs
 * nothing. Everything here reads recorded data and writes none of it: there is no
 * function in this module that returns an Entry, a Snapshot line, an Account or a
 * Project, and no shape it could return one in.
 *
 * A **Funding Plan** is what a future investment needs and which sources would
 * cover it. It is the *before* of a Project's Funding Legs — the same facts in the
 * future tense — with one field deliberately missing: a planned source carries no
 * rate. Nobody knows what a future conversion will cost, and a rate written down
 * before the money moved would be a number nobody used. Supplying the real rates is
 * what *executing* a plan does, and that is Phase 16's work.
 *
 * From those two come the answers this area exists for:
 *
 * **The gap** — `needs − Σ(sources)`. A source in another currency is read at a
 * rate that is handed in and named, or it is left out of the total and reported.
 * Converting at a rate nobody quoted is the one thing this must not do, because a
 * gap is a figure somebody will decide against.
 *
 * **Months to close it** — the gap over what the household actually saves a month,
 * read out of the מאזן through the Ledger, so it is the same חיסכון the מאזן screens
 * show. Rounded *up*: saving arrives in monthly lumps, and eleven months of it does
 * not close a gap that needs eleven and a bit.
 */

import { type Categories } from "@/domain/categories/categories";
import {
  type Ledger,
  type MonthCompleteness,
  completenessOf,
  householdMonthSummary,
} from "@/domain/ledger/ledger";
import { DEFAULT_TRAILING_WINDOW } from "@/domain/ledger/ledger-analytics";
import {
  type Currency,
  type ExchangeRate,
  type Money,
  convert,
  convertBack,
  divide,
  isNegative,
  negate,
  subtract,
  sum,
} from "@/domain/money/money";
import { type CalendarDate, compareDates } from "@/domain/time/calendar-date";
import { type CalendarMonth, addMonths, monthRange } from "@/domain/time/calendar-month";

// --- the scenario ------------------------------------------------------------

export interface Scenario {
  readonly id: string;
  /** The household's own naming — `CGM 3 ב־2027`. Left as written. */
  readonly name: string;
  /** What the thought is, in the household's own words. `null` when it needs none. */
  readonly note: string | null;
  readonly createdOn: CalendarDate;
}

export class InvalidScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScenarioError";
  }
}

export class UnknownScenarioError extends Error {
  constructor(readonly scenarioId: string) {
    super(`No such scenario: ${scenarioId}`);
    this.name = "UnknownScenarioError";
  }
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function requireText(
  value: string,
  what: string,
  limit: number,
  fail: (message: string) => Error,
): string {
  const normalised = normalise(value);
  if (normalised.length === 0) throw fail(`${what} cannot be empty`);
  if (normalised.length > limit) {
    throw fail(`${what} cannot exceed ${limit} characters, received ${normalised.length}`);
  }
  return normalised;
}

function optionalText(
  value: string | null | undefined,
  what: string,
  limit: number,
  fail: (message: string) => Error,
): string | null {
  const normalised = normalise(value ?? "");
  if (normalised.length === 0) return null;
  if (normalised.length > limit) {
    throw fail(`${what} cannot exceed ${limit} characters, received ${normalised.length}`);
  }
  return normalised;
}

function requirePositive(amount: Money, what: string, fail: (message: string) => Error): Money {
  if (amount.minorUnits <= 0) {
    throw fail(`${what} is an amount greater than zero, or it is nothing at all`);
  }
  return amount;
}

export interface ScenarioDefinition {
  readonly name: string;
  readonly note?: string | null;
  readonly createdOn: CalendarDate;
}

const scenarioFailure = (message: string) => new InvalidScenarioError(message);

export function buildScenario(id: string, definition: ScenarioDefinition): Scenario {
  return {
    id,
    name: requireText(definition.name, "A scenario name", 80, scenarioFailure),
    note: optionalText(definition.note, "A scenario note", 400, scenarioFailure),
    createdOn: definition.createdOn,
  };
}

export function findScenario(scenarios: readonly Scenario[], id: string): Scenario | undefined {
  return scenarios.find((scenario) => scenario.id === id);
}

export function requireScenario(scenarios: readonly Scenario[], id: string): Scenario {
  const scenario = findScenario(scenarios, id);
  if (scenario === undefined) throw new UnknownScenarioError(id);
  return scenario;
}

/** Newest first: a what-if is usually read while it is still being thought about. */
export function scenariosInReadingOrder(scenarios: readonly Scenario[]): readonly Scenario[] {
  return [...scenarios].sort(
    (left, right) =>
      compareDates(right.createdOn, left.createdOn) ||
      left.name.localeCompare(right.name, "he") ||
      left.id.localeCompare(right.id),
  );
}

// --- the funding plan --------------------------------------------------------

/**
 * What a future investment needs, and by when. At most one per Scenario: a
 * scenario is one what-if about one investment, and two requirements inside it
 * would be two scenarios.
 *
 * A Scenario with no plan is a legitimate state — a name and a thought, before
 * anybody has priced it.
 */
export interface FundingPlan {
  readonly scenarioId: string;
  /** What the investment needs. The currency of the plan, and of its gap. */
  readonly needs: Money;
  readonly neededBy: CalendarDate;
}

export class InvalidFundingPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFundingPlanError";
  }
}

export interface FundingPlanDefinition {
  readonly scenarioId: string;
  readonly needs: Money;
  readonly neededBy: CalendarDate;
}

const planFailure = (message: string) => new InvalidFundingPlanError(message);

export function buildFundingPlan(definition: FundingPlanDefinition): FundingPlan {
  return {
    scenarioId: definition.scenarioId,
    needs: requirePositive(definition.needs, "A funding plan requirement", planFailure),
    neededBy: definition.neededBy,
  };
}

export function planFor(plans: readonly FundingPlan[], scenarioId: string): FundingPlan | null {
  return plans.find((plan) => plan.scenarioId === scenarioId) ?? null;
}

// --- the planned sources -----------------------------------------------------

/**
 * Which recorded figure a seeded source came out of. There is one today, and it is
 * named rather than left implicit so a seeded line can always be held against the
 * figure it was taken from.
 */
export type SeededFigure = "free-liquid";

/**
 * Where a planned source's amount came from.
 *
 * `stated` — a person typed it: what we intend to put in.
 * `seeded` — the system read it out of recorded data on a day, and says which
 * figure and which day. A seeded amount is still editable, because a plan is a
 * what-if and not a measurement; what it is not is a figure of unknown provenance.
 */
export type SourceOrigin =
  | { readonly kind: "stated" }
  | { readonly kind: "seeded"; readonly figure: SeededFigure; readonly asOf: CalendarDate };

export const STATED: SourceOrigin = { kind: "stated" };

/**
 * One source that would cover part of a plan — the *before* of a Funding Leg.
 *
 * There is deliberately no rate and no date. A future conversion has no rate yet,
 * and the day the money moves is not knowable either; both arrive when the plan is
 * executed and its lines become real legs.
 */
export interface PlannedSource {
  readonly id: string;
  readonly scenarioId: string;
  /** Where it would come from — `כסף נזיל פנוי`, `Apple RSU`. The household's words. */
  readonly source: string;
  readonly amount: Money;
  readonly origin: SourceOrigin;
}

export class InvalidPlannedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPlannedSourceError";
  }
}

export interface PlannedSourceDefinition {
  readonly scenarioId: string;
  readonly source: string;
  readonly amount: Money;
  readonly origin?: SourceOrigin;
}

const sourceFailure = (message: string) => new InvalidPlannedSourceError(message);

export function buildPlannedSource(
  id: string,
  definition: PlannedSourceDefinition,
): PlannedSource {
  return {
    id,
    scenarioId: definition.scenarioId,
    source: requireText(definition.source, "A planned source", 60, sourceFailure),
    amount: requirePositive(definition.amount, "A planned source", sourceFailure),
    origin: definition.origin ?? STATED,
  };
}

/** One scenario's sources, largest first — the biggest part of the answer reads first. */
export function sourcesOf(
  sources: readonly PlannedSource[],
  scenarioId: string,
): readonly PlannedSource[] {
  return sources
    .filter((source) => source.scenarioId === scenarioId)
    .sort(
      (left, right) =>
        right.amount.minorUnits - left.amount.minorUnits ||
        left.source.localeCompare(right.source, "he") ||
        left.id.localeCompare(right.id),
    );
}

/**
 * What recorded data proposes as a source when a scenario is created, so planning
 * never starts from a figure somebody typed out of memory.
 *
 * A figure that is nought or negative is *not* a source and yields nothing: free
 * liquid money of −15,000₪ is a shortfall, and offering it as money to invest would
 * be the one lie this whole area is built to avoid.
 */
export function proposedFreeLiquid(input: {
  readonly scenarioId: string;
  readonly source: string;
  readonly free: Money;
  readonly asOf: CalendarDate;
}): PlannedSourceDefinition | null {
  if (input.free.minorUnits <= 0) return null;
  return {
    scenarioId: input.scenarioId,
    source: input.source,
    amount: input.free,
    origin: { kind: "seeded", figure: "free-liquid", asOf: input.asOf },
  };
}

// --- the gap -----------------------------------------------------------------

/** One planned source, read in the plan's own currency — or not readable there at all. */
export interface CoveringSource {
  readonly source: PlannedSource;
  /**
   * The amount in the plan's currency. `null` when the source is in another
   * currency and no rate was supplied for the pair, in which case it is reported
   * beside the gap rather than counted into it.
   */
  readonly inPlanCurrency: Money | null;
}

export interface FundingGap {
  readonly currency: Currency;
  readonly needs: Money;
  /** Σ of the sources that could be read in the plan's currency. */
  readonly covered: Money;
  /** `needs − covered`. Negative when the sources come to more than the plan needs. */
  readonly gap: Money;
  /** How much the plan is over-covered by, `null` when it is not. */
  readonly surplus: Money | null;
  /** True when the sources already reach the requirement. */
  readonly closed: boolean;
  readonly sources: readonly CoveringSource[];
  /** The rate any conversion used, `null` when none was needed. Named on screen. */
  readonly rate: ExchangeRate | null;
  /**
   * Sources in another currency with no rate to read them at. They are named and
   * left out, so the gap above is the *most* that is covered and never a figure
   * converted at a rate nobody quoted.
   */
  readonly unreadable: readonly PlannedSource[];
}

/**
 * Read an amount into the plan's currency at the rate handed in. The rate may be
 * quoted in either direction — one stored `USD/ILS` number, never two — and a rate
 * for the wrong pair is no rate at all.
 */
function readInto(amount: Money, to: Currency, rate: ExchangeRate | null): Money | null {
  if (amount.currency === to) return amount;
  if (rate === null) return null;
  if (rate.from === amount.currency && rate.to === to) return convert(amount, rate);
  if (rate.from === to && rate.to === amount.currency) return convertBack(amount, rate);
  return null;
}

export function fundingGap(input: {
  readonly plan: FundingPlan;
  readonly sources: readonly PlannedSource[];
  readonly rate?: ExchangeRate | null;
}): FundingGap {
  const { plan } = input;
  const currency = plan.needs.currency;
  const rate = input.rate ?? null;

  const own = sourcesOf(input.sources, plan.scenarioId);
  const read = own.map((source): CoveringSource => ({
    source,
    inPlanCurrency: readInto(source.amount, currency, rate),
  }));

  const covered = sum(
    read.flatMap((line) => (line.inPlanCurrency === null ? [] : [line.inPlanCurrency])),
    currency,
  );
  const gap = subtract(plan.needs, covered);
  const converted = read.some(
    (line) => line.inPlanCurrency !== null && line.source.amount.currency !== currency,
  );

  return {
    currency,
    needs: plan.needs,
    covered,
    gap,
    surplus: isNegative(gap) ? negate(gap) : null,
    closed: gap.minorUnits <= 0,
    sources: read,
    rate: converted ? rate : null,
    unreadable: read.flatMap((line) => (line.inPlanCurrency === null ? [line.source] : [])),
  };
}

// --- what the household actually saves a month -------------------------------

/** One month of the מאזן as the pace reads it. */
export interface PaceMonth {
  readonly month: CalendarMonth;
  /** `הכנסות − הוצאות`, derived by the Ledger exactly as every מאזן screen derives it. */
  readonly saving: Money;
  readonly completeness: MonthCompleteness;
}

/**
 * What the household saves a month at the rate it is currently saving.
 *
 * The window is the trailing months ending with the month asked for, and the
 * denominator is the months in it that actually hold a figure — not the length of
 * the window. The ledger says an absent month was never recorded rather than
 * recorded as nought, and dividing by months nobody wrote down would report a pace
 * the household never ran at.
 *
 * Months that are only half recorded are counted and *named*: an unfinished month
 * understates its own חיסכון, so a pace resting on one is understated too, and the
 * reader is told rather than left to wonder.
 */
export interface SavingPace {
  readonly currency: Currency;
  /** The whole window that was looked at, ascending. */
  readonly window: readonly PaceMonth[];
  /** Σ חיסכון over the months holding a figure. */
  readonly total: Money;
  /** `total ÷ denominator` — the monthly pace. `null` when nothing was recorded. */
  readonly monthly: Money | null;
  /** What the total was divided by. Displayed with the pace; never implied. */
  readonly denominator: number;
  /** Months in the window with some categories filled and some not. */
  readonly incomplete: readonly CalendarMonth[];
  /** Months in the window nobody recorded at all. */
  readonly missing: readonly CalendarMonth[];
}

export class InvalidSavingPaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSavingPaceError";
  }
}

export function savingPace(input: {
  readonly ledger: Ledger;
  readonly categories: Categories;
  /** The last month of the window. The clock is a parameter, never read inside. */
  readonly endingWith: CalendarMonth;
  readonly months?: number;
  readonly currency: Currency;
}): SavingPace {
  const length = input.months ?? DEFAULT_TRAILING_WINDOW;
  if (!Number.isInteger(length) || length <= 0) {
    throw new InvalidSavingPaceError(
      `A saving pace is measured over a whole number of months greater than zero, received ${String(length)}`,
    );
  }

  const { currency } = input;
  const window = monthRange(addMonths(input.endingWith, -(length - 1)), input.endingWith).map(
    (month): PaceMonth => {
      const summary = householdMonthSummary(input.ledger, input.categories, month, currency);
      return { month, saving: summary.saving, completeness: completenessOf(summary) };
    },
  );

  const recorded = window.filter((month) => month.completeness !== "empty");
  const total = sum(
    recorded.map((month) => month.saving),
    currency,
  );

  return {
    currency,
    window,
    total,
    monthly: recorded.length === 0 ? null : divide(total, recorded.length),
    denominator: recorded.length,
    incomplete: window
      .filter((month) => month.completeness === "partial")
      .map((month) => month.month),
    missing: window.filter((month) => month.completeness === "empty").map((month) => month.month),
  };
}

// --- how long the gap takes to close -----------------------------------------

/**
 * Why the answer is what it is. Every one of these is a real state of the
 * household's data, and none of them is a number pretending to be an answer:
 *
 * `already-covered` — the sources reach the requirement; nothing has to be saved.
 * `computed` — a gap, a positive pace, and one rate between them where needed.
 * `no-pace` — nothing in the window was recorded, so there is no rate to divide by.
 * `not-saving` — the pace is nought or negative: at this rate the gap never closes,
 *   and any month count would be an invention.
 * `no-rate` — the gap and the pace are in different currencies and nobody quoted
 *   one, so the two are not comparable.
 */
export type ClosureBasis = "already-covered" | "computed" | "no-pace" | "not-saving" | "no-rate";

export interface MonthsToClose {
  readonly gap: Money;
  /** The monthly pace read in the gap's own currency, `null` when it could not be. */
  readonly monthly: Money | null;
  /** The rate that reading needed, `null` when none was needed. */
  readonly rate: ExchangeRate | null;
  /** Whole months of saving, rounded up. `null` when the gap has no answer. */
  readonly months: number | null;
  /** The month the gap closes in, counting from the end of the pace's window. */
  readonly closesIn: CalendarMonth | null;
  readonly basis: ClosureBasis;
  readonly denominator: number;
}

/** Whole months, rounded up: saving arrives monthly, so a part-month closes nothing. */
function monthsFor(gap: Money, monthly: Money): number {
  return Math.ceil(gap.minorUnits / monthly.minorUnits);
}

export function monthsToClose(input: {
  readonly gap: FundingGap;
  readonly pace: SavingPace;
  readonly rate?: ExchangeRate | null;
}): MonthsToClose {
  const { gap, pace } = input;
  const last = pace.window[pace.window.length - 1]?.month ?? null;
  const base = {
    gap: gap.gap,
    denominator: pace.denominator,
    closesIn: null,
  } as const;

  if (gap.closed) {
    return { ...base, monthly: pace.monthly, rate: null, months: 0, basis: "already-covered" };
  }
  if (pace.monthly === null) {
    return { ...base, monthly: null, rate: null, months: null, basis: "no-pace" };
  }

  const monthly = readInto(pace.monthly, gap.currency, input.rate ?? null);
  if (monthly === null) {
    return { ...base, monthly: null, rate: null, months: null, basis: "no-rate" };
  }
  const rate = pace.monthly.currency === gap.currency ? null : (input.rate ?? null);

  if (monthly.minorUnits <= 0) {
    return { ...base, monthly, rate, months: null, basis: "not-saving" };
  }

  const months = monthsFor(gap.gap, monthly);
  return {
    ...base,
    monthly,
    rate,
    months,
    closesIn: last === null ? null : addMonths(last, months),
    basis: "computed",
  };
}

// --- one scenario, read whole ------------------------------------------------

/**
 * Everything one scenario is, in one shape. Assembled here rather than in the
 * screen so the list and the scenario's own page can never disagree about its gap.
 *
 * Nothing in it is stored: the gap and the months are computed on every read out of
 * the plan, its sources and the Ledger. A scenario that reads differently tomorrow
 * is a scenario whose household saved differently, which is the correct behaviour
 * for a question about the future.
 */
export interface ScenarioReading {
  readonly scenario: Scenario;
  readonly plan: FundingPlan | null;
  readonly sources: readonly PlannedSource[];
  /** `null` exactly when there is no plan to be short of. */
  readonly gap: FundingGap | null;
  readonly closure: MonthsToClose | null;
}

export function readScenario(input: {
  readonly scenario: Scenario;
  readonly plans: readonly FundingPlan[];
  readonly sources: readonly PlannedSource[];
  readonly pace: SavingPace;
  readonly rate?: ExchangeRate | null;
}): ScenarioReading {
  const { scenario, pace } = input;
  const plan = planFor(input.plans, scenario.id);
  const sources = sourcesOf(input.sources, scenario.id);
  const rate = input.rate ?? null;
  const gap = plan === null ? null : fundingGap({ plan, sources, rate });

  return {
    scenario,
    plan,
    sources,
    gap,
    closure: gap === null ? null : monthsToClose({ gap, pace, rate }),
  };
}

export function readScenarios(input: {
  readonly scenarios: readonly Scenario[];
  readonly plans: readonly FundingPlan[];
  readonly sources: readonly PlannedSource[];
  readonly pace: SavingPace;
  readonly rate?: ExchangeRate | null;
}): readonly ScenarioReading[] {
  return scenariosInReadingOrder(input.scenarios).map((scenario) =>
    readScenario({ ...input, scenario }),
  );
}
