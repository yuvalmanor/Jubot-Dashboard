/**
 * דפוס חוזר — "a CGM every year for ten years", followed to where it leads.
 *
 * Framework-free per ADR 0004.
 *
 * A strategy the household can say in one sentence is not a strategy it can check.
 * A **pattern** is that sentence as data — an amount, how often, how many times,
 * starting when — and the projection is what happens if it is actually attempted:
 * saving accumulates, each occurrence is paid for out of what has accumulated, and
 * the money each one returns comes back and helps pay for the next.
 *
 * What comes back, and when, is **Deal Terms** — what the sponsor's paperwork said
 * this kind of project returns. Three things about that are deliberate:
 *
 * **The recorded terms are the default.** A projection that made up its own return
 * would be a guess wearing a document's clothes.
 *
 * **A scenario may override them, and never edits them.** A promise is worth
 * stress-testing — "and what if it returns 8% instead of 18%" — and the answer to
 * that question must not overwrite what the paperwork actually said. An override
 * lives on the scenario, states only the fields it disagrees with, and disappears
 * with it.
 *
 * **A stated return is read as the total over the hold period, not per year.** It
 * sits beside a hold period on the same document and says nothing about compounding,
 * so nothing here invents any. Every figure this produces names the terms and the
 * reading behind it, and the household corrects either without a deploy.
 *
 * Nothing here is a measurement. A pattern is what the household would like to do
 * and the terms are what somebody promised; the projection is honest arithmetic over
 * two opinions, and it says so.
 */

import {
  type Currency,
  type Money,
  add,
  fromScaledInteger,
  multiply,
  subtract,
  sum,
  zero,
} from "@/domain/money/money";
import { type DealTerms, statesAnything } from "@/domain/projects/projects";
import { type CalendarDate, addMonths as addMonthsToDate, monthContaining } from "@/domain/time/calendar-date";
import {
  type CalendarMonth,
  addMonths,
  compareMonths,
  monthKey,
  monthsBetween,
} from "@/domain/time/calendar-month";

// --- the pattern -------------------------------------------------------------

export interface InvestmentPattern {
  readonly scenarioId: string;
  /** What each occurrence needs. Every occurrence is the same size. */
  readonly amount: Money;
  /** The gap between occurrences. 12 is "every year". */
  readonly everyMonths: number;
  /** How many times. Ten years of a yearly CGM is ten. */
  readonly occurrences: number;
  readonly firstOn: CalendarDate;
  /**
   * The project whose Deal Terms the projection reads — what comes back and after
   * how long. `null` is a legitimate position: a pattern nobody has priced returns
   * nothing inside the projection, and the projection says that rather than
   * assuming a return.
   */
  readonly modelledOn: string | null;
}

export class InvalidPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPatternError";
  }
}

const fail = (message: string) => new InvalidPatternError(message);

/** Bounds that keep a mistyped field from projecting past the end of the calendar. */
const MAX_OCCURRENCES = 100;
const MAX_EVERY_MONTHS = 120;
/** Fifty years of a repeating pattern. Past that it is a typo, not a strategy. */
const MAX_SPAN_MONTHS = 600;
/** The span plus the longest hold anybody would state against it. */
const MAX_HORIZON_MONTHS = 1_200;
/** A total loss is the worst a promise can turn out to be. Below that is not a return. */
const WORST_RETURN_BASIS_POINTS = -10_000;

export interface InvestmentPatternDefinition {
  readonly scenarioId: string;
  readonly amount: Money;
  readonly everyMonths: number;
  readonly occurrences: number;
  readonly firstOn: CalendarDate;
  readonly modelledOn?: string | null;
}

function count(value: number, what: string, limit: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw fail(`${what} is a whole number greater than zero, received ${String(value)}`);
  }
  if (value > limit) {
    throw fail(`${what} cannot exceed ${limit}, received ${value}`);
  }
  return value;
}

export function buildInvestmentPattern(
  definition: InvestmentPatternDefinition,
): InvestmentPattern {
  if (definition.amount.minorUnits <= 0) {
    throw fail("A repeating investment is an amount greater than zero, or it is nothing at all");
  }

  const everyMonths = count(
    definition.everyMonths,
    "The gap between occurrences",
    MAX_EVERY_MONTHS,
  );
  const occurrences = count(definition.occurrences, "The number of occurrences", MAX_OCCURRENCES);
  const span = (occurrences - 1) * everyMonths;
  if (span > MAX_SPAN_MONTHS) {
    throw fail(
      `A pattern spanning ${span} months reaches further than a household plans; ` +
        `${MAX_SPAN_MONTHS} is the limit`,
    );
  }

  return {
    scenarioId: definition.scenarioId,
    amount: definition.amount,
    everyMonths,
    occurrences,
    firstOn: definition.firstOn,
    modelledOn: definition.modelledOn ?? null,
  };
}

export function patternFor(
  patterns: readonly InvestmentPattern[],
  scenarioId: string,
): InvestmentPattern | null {
  return patterns.find((pattern) => pattern.scenarioId === scenarioId) ?? null;
}

/** Every date the pattern lands on, in order. */
export function occurrenceDates(pattern: InvestmentPattern): readonly CalendarDate[] {
  return Array.from({ length: pattern.occurrences }, (_unused, index) =>
    addMonthsToDate(pattern.firstOn, index * pattern.everyMonths),
  );
}

// --- the terms a scenario projects on ----------------------------------------

/**
 * What one scenario says instead of what a project's paperwork says. A null field
 * is *not* an override — it means this scenario has no opinion about that term and
 * the recorded one still stands, so disagreeing about the return without touching
 * the hold period is one field and not a copy of the document.
 */
export interface ScenarioTerms {
  readonly scenarioId: string;
  readonly projectId: string;
  readonly targetReturnBasisPoints: number | null;
  readonly holdMonths: number | null;
}

export interface ScenarioTermsDefinition {
  readonly scenarioId: string;
  readonly projectId: string;
  readonly targetReturnBasisPoints?: number | null;
  readonly holdMonths?: number | null;
}

function wholeOrNull(value: number | null | undefined, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value)) {
    throw fail(`${what} is a whole number, received ${String(value)}`);
  }
  return value;
}

export function buildScenarioTerms(definition: ScenarioTermsDefinition): ScenarioTerms {
  const holdMonths = wholeOrNull(definition.holdMonths, "A hold period");
  if (holdMonths !== null && holdMonths <= 0) {
    throw fail("A hold period is a number of months greater than zero");
  }

  // A negative return is a legitimate stress test — "and what if it goes badly" is
  // the question an override exists for. Losing more than went in is not: the
  // household's exposure to one of these is what it put into it.
  const targetReturnBasisPoints = wholeOrNull(
    definition.targetReturnBasisPoints,
    "A target return",
  );
  if (targetReturnBasisPoints !== null && targetReturnBasisPoints < WORST_RETURN_BASIS_POINTS) {
    throw fail(
      `A return below ${WORST_RETURN_BASIS_POINTS} basis points loses more than was invested, ` +
        `received ${targetReturnBasisPoints}`,
    );
  }

  return {
    scenarioId: definition.scenarioId,
    projectId: definition.projectId,
    targetReturnBasisPoints,
    holdMonths,
  };
}

export type TermField = "target-return" | "hold-period";

/**
 * Where each figure came from. `recorded` is the paperwork, `overridden` is this
 * scenario disagreeing with it, and `none` is nobody having stated anything —
 * which is a real state and reads as one rather than as a promise of nothing.
 */
export type TermsBasis = "recorded" | "overridden" | "none";

export interface EffectiveTerms {
  readonly projectId: string;
  /** Read as the total return over the hold period, never as a rate per year. */
  readonly targetReturnBasisPoints: number | null;
  readonly holdMonths: number | null;
  readonly basis: TermsBasis;
  /** Which fields this scenario states for itself. Named on screen, beside the figure. */
  readonly overridden: readonly TermField[];
  /** What the paperwork says, kept beside the override so both are readable. */
  readonly recorded: DealTerms | null;
}

export function scenarioTermsFor(
  overrides: readonly ScenarioTerms[],
  scenarioId: string,
  projectId: string,
): ScenarioTerms | null {
  return (
    overrides.find(
      (override) => override.scenarioId === scenarioId && override.projectId === projectId,
    ) ?? null
  );
}

/**
 * The terms a projection actually runs on: the recorded ones, with whatever this
 * scenario states for itself laid over them.
 */
export function effectiveTerms(input: {
  readonly scenarioId: string;
  readonly projectId: string;
  readonly recorded: readonly DealTerms[];
  readonly overrides: readonly ScenarioTerms[];
}): EffectiveTerms {
  const recorded = input.recorded.find((terms) => terms.projectId === input.projectId) ?? null;
  const override = scenarioTermsFor(input.overrides, input.scenarioId, input.projectId);

  const overridden: TermField[] = [];
  if (override?.targetReturnBasisPoints !== null && override?.targetReturnBasisPoints !== undefined) {
    overridden.push("target-return");
  }
  if (override?.holdMonths !== null && override?.holdMonths !== undefined) {
    overridden.push("hold-period");
  }

  const targetReturnBasisPoints =
    override?.targetReturnBasisPoints ?? recorded?.targetReturnBasisPoints ?? null;
  const holdMonths = override?.holdMonths ?? recorded?.holdMonths ?? null;

  const basis: TermsBasis =
    overridden.length > 0
      ? "overridden"
      : recorded !== null && statesAnything(recorded)
        ? "recorded"
        : "none";

  return {
    projectId: input.projectId,
    targetReturnBasisPoints,
    holdMonths,
    basis,
    overridden,
    recorded,
  };
}

/** What one investment comes back as, `null` when the terms promise no return of it. */
export function distributionOf(amount: Money, terms: EffectiveTerms | null): Money | null {
  if (terms === null || terms.holdMonths === null) return null;
  const basisPoints = terms.targetReturnBasisPoints ?? 0;
  // 1825 basis points reads as the exact decimal 1.1825 — never a float divide.
  return multiply(amount, fromScaledInteger(10_000 + basisPoints, 4));
}

// --- the pattern, played forward ---------------------------------------------

export interface PlannedInvestment {
  /** 1 for the first. The household counts "the third CGM", not "index 2". */
  readonly index: number;
  readonly on: CalendarDate;
  readonly month: CalendarMonth;
  readonly amount: Money;
  /** What had accumulated by the time this one was due. */
  readonly available: Money;
  readonly funded: boolean;
  /** What was missing, `null` when it was funded. */
  readonly shortfall: Money | null;
  /** The month the money comes back, `null` when it was not funded or nothing comes back. */
  readonly returnsIn: CalendarMonth | null;
  /** Capital and the promised return together, `null` for the same two reasons. */
  readonly returns: Money | null;
}

export interface PatternMonth {
  readonly month: CalendarMonth;
  /** What saving put in this month. */
  readonly saved: Money;
  /** What came back from earlier investments this month. */
  readonly distributed: Money;
  /** What went out into an investment this month. */
  readonly invested: Money;
  /** What is left over after all three. */
  readonly balance: Money;
}

export interface PatternProjection {
  readonly currency: Currency;
  readonly terms: EffectiveTerms | null;
  readonly months: readonly PatternMonth[];
  readonly investments: readonly PlannedInvestment[];
  /** Σ of the occurrences that were actually paid for. */
  readonly invested: Money;
  /** Σ of what came back inside the horizon. */
  readonly distributed: Money;
  /** Capital paid out that has not come back by the end of the horizon. */
  readonly outstanding: Money;
  /** Cash left at the end — saved, plus returned, less invested. */
  readonly ending: Money;
  readonly fundedCount: number;
  /** The first occurrence the money did not reach, `null` when all of them did. */
  readonly firstMissed: number | null;
  /** True when the terms promise nothing back, so the projection is outflow only. */
  readonly returnsNothing: boolean;
  readonly from: CalendarMonth;
  readonly to: CalendarMonth;
}

export interface PatternProjectionInput {
  readonly pattern: InvestmentPattern;
  readonly terms?: EffectiveTerms | null;
  /** The first month of the projection. */
  readonly from: CalendarMonth;
  /** What the household saves a month, already read into the pattern's currency. */
  readonly monthly?: Money | null;
  /** What is already in hand at the start — the plan's covered sources, usually. */
  readonly opening?: Money | null;
  /** How far to run. Defaults to the last occurrence plus its hold period. */
  readonly months?: number;
}

function requireCurrency(amount: Money | null | undefined, currency: Currency, what: string): void {
  if (amount !== null && amount !== undefined && amount.currency !== currency) {
    throw fail(
      `${what} is in ${amount.currency} and the pattern is in ${currency}; ` +
        "one of them has to be read into the other at a rate somebody quoted",
    );
  }
}

/**
 * The pattern, month by month.
 *
 * Money arriving in a month is available at the end of it, and an occurrence due in
 * a month is paid at the end of it. So a month's own saving and any distribution
 * landing in it can pay for that month's investment, and nothing is paid for out of
 * money that has not arrived.
 *
 * An occurrence the balance cannot cover is **missed**, not delayed. Sliding it
 * forward would invent a schedule the household never chose, and the useful answer
 * is "the fourth one is where this runs out" — which is what `firstMissed` says. A
 * missed occurrence pays nothing and therefore returns nothing, and the pattern
 * carries on, because a later one may well be affordable.
 */
export function projectPattern(input: PatternProjectionInput): PatternProjection {
  const { pattern } = input;
  const currency = pattern.amount.currency;
  const terms = input.terms ?? null;

  requireCurrency(input.monthly, currency, "The saving pace");
  requireCurrency(input.opening, currency, "The opening balance");
  if (terms !== null && terms.projectId !== pattern.modelledOn) {
    throw fail(
      `The pattern is modelled on ${String(pattern.modelledOn)} and the terms are for ${terms.projectId}`,
    );
  }

  const monthly = input.monthly ?? zero(currency);
  const dates = occurrenceDates(pattern);
  const holdMonths = terms?.holdMonths ?? null;

  const lastOccurrence = monthContaining(dates[dates.length - 1] ?? pattern.firstOn);
  const naturalEnd = addMonths(lastOccurrence, holdMonths ?? 0);
  const length =
    input.months ?? Math.max(1, monthsBetween(input.from, naturalEnd) + 1);
  if (!Number.isInteger(length) || length <= 0) {
    throw fail(
      `A projection runs over a whole number of months greater than zero, received ${String(length)}`,
    );
  }
  if (length > MAX_HORIZON_MONTHS) {
    throw fail(
      `A projection of ${length} months runs past anything a household is planning for; ` +
        `${MAX_HORIZON_MONTHS} is the limit`,
    );
  }

  // Occurrences and distributions, indexed by the month they land in.
  const due = new Map<string, number[]>();
  dates.forEach((date, index) => {
    const key = monthKey(monthContaining(date));
    due.set(key, [...(due.get(key) ?? []), index]);
  });

  const incoming = new Map<string, Money>();
  const investments: PlannedInvestment[] = [];
  const months: PatternMonth[] = [];

  let balance = input.opening ?? zero(currency);

  for (let step = 0; step < length; step += 1) {
    const month = addMonths(input.from, step);
    const key = monthKey(month);

    const distributed = incoming.get(key) ?? zero(currency);
    balance = add(add(balance, monthly), distributed);

    let invested = zero(currency);
    for (const index of due.get(key) ?? []) {
      const date = dates[index];
      if (date === undefined) continue;

      const available = balance;
      const funded = balance.minorUnits >= pattern.amount.minorUnits;
      const returns = funded ? distributionOf(pattern.amount, terms) : null;
      const returnsIn = returns === null ? null : addMonths(month, holdMonths ?? 0);

      if (funded) {
        balance = subtract(balance, pattern.amount);
        invested = add(invested, pattern.amount);
        if (returns !== null && returnsIn !== null) {
          const at = monthKey(returnsIn);
          incoming.set(at, add(incoming.get(at) ?? zero(currency), returns));
        }
      }

      investments.push({
        index: index + 1,
        on: date,
        month,
        amount: pattern.amount,
        available,
        funded,
        shortfall: funded ? null : subtract(pattern.amount, available),
        returnsIn,
        returns,
      });
    }

    months.push({ month, saved: monthly, distributed, invested, balance });
  }

  // An occurrence dated before the projection starts never gets a month to be paid
  // in. It is reported as missed rather than silently dropped, because a pattern
  // whose first date is in the past is a real thing to have typed.
  dates.forEach((date, index) => {
    if (investments.some((investment) => investment.index === index + 1)) return;
    const month = monthContaining(date);
    investments.push({
      index: index + 1,
      on: date,
      month,
      amount: pattern.amount,
      available: zero(currency),
      funded: false,
      shortfall: pattern.amount,
      returnsIn: null,
      returns: null,
    });
  });
  investments.sort((left, right) => left.index - right.index);

  const funded = investments.filter((investment) => investment.funded);
  const invested = sum(
    funded.map((investment) => investment.amount),
    currency,
  );
  const to = addMonths(input.from, length - 1);
  const returned = funded.filter(
    (investment) => investment.returnsIn !== null && compareMonths(investment.returnsIn, to) <= 0,
  );

  return {
    currency,
    terms,
    months,
    investments,
    invested,
    distributed: sum(
      returned.flatMap((investment) => (investment.returns === null ? [] : [investment.returns])),
      currency,
    ),
    outstanding: subtract(
      invested,
      sum(
        returned.map((investment) => investment.amount),
        currency,
      ),
    ),
    ending: balance,
    fundedCount: funded.length,
    firstMissed:
      investments.find((investment) => !investment.funded)?.index ?? null,
    returnsNothing: holdMonths === null,
    from: input.from,
    to,
  };
}
