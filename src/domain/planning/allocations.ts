/**
 * הקצאות חיסכון — where each month's saving is promised to go, played forward.
 *
 * Framework-free per ADR 0004.
 *
 * An **allocation** is one goal and a monthly amount: 5,000₪ to קרן חירום and
 * 10,000₪ to נדל"ן. It is an intention about money that has not arrived yet, so it
 * is typed rather than derived — which is exactly what makes it worth holding
 * against something. Two facts do that here, and both are stated rather than
 * assumed:
 *
 * **What is committed against what is saved.** The מאזן knows what the household
 * actually saves a month. Promising 15,000₪ out of a 12,000₪ pace is not a plan,
 * it is a wish, and the difference is reported in both directions — over-committed,
 * or with saving left unspoken for.
 *
 * **Where each goal gets to, month by month.** A goal may carry a target, and then
 * the projection says which month reaches it. A goal with no target is a complete
 * intention too: "10,000 a month into נדל"ן" has no finish line and does not need
 * one invented for it.
 *
 * Everything accumulates from nought. These are *future* contributions, and adding
 * whatever the goal already holds would silently mix a plan with a measurement —
 * the emergency fund's real balance is an Earmark against a real account, and it
 * lives in מיפוי where somebody measured it.
 */

import {
  type Currency,
  type ExchangeRate,
  type Money,
  add,
  compare,
  subtract,
  sum,
  zero,
} from "@/domain/money/money";
import { readInto } from "@/domain/planning/scenarios";
import { type CalendarMonth, addMonths } from "@/domain/time/calendar-month";

// --- one allocation ----------------------------------------------------------

export interface SavingAllocation {
  readonly id: string;
  readonly scenarioId: string;
  /** What the money is for — `קרן חירום`, `נדל"ן`. The household's own words. */
  readonly goal: string;
  /** How much of a month's saving goes here. */
  readonly monthly: Money;
  /** What the goal is aiming at, or `null` when it is aiming at no figure. */
  readonly target: Money | null;
}

export class InvalidAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAllocationError";
  }
}

const fail = (message: string) => new InvalidAllocationError(message);

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export interface SavingAllocationDefinition {
  readonly scenarioId: string;
  readonly goal: string;
  readonly monthly: Money;
  readonly target?: Money | null;
}

export function buildSavingAllocation(
  id: string,
  definition: SavingAllocationDefinition,
): SavingAllocation {
  const goal = normalise(definition.goal);
  if (goal.length === 0) throw fail("A saving goal cannot be empty");
  if (goal.length > 60) {
    throw fail(`A saving goal cannot exceed 60 characters, received ${goal.length}`);
  }
  if (definition.monthly.minorUnits <= 0) {
    throw fail("A monthly allocation is an amount greater than zero, or it is nothing at all");
  }

  const target = definition.target ?? null;
  if (target !== null) {
    if (target.minorUnits <= 0) {
      throw fail("A goal's target is an amount greater than zero, or there is no target");
    }
    if (target.currency !== definition.monthly.currency) {
      throw fail(
        `A goal saved in ${definition.monthly.currency} cannot be measured against a target in ${target.currency}`,
      );
    }
  }

  return { id, scenarioId: definition.scenarioId, goal, monthly: definition.monthly, target };
}

/** One scenario's allocations, largest first — the biggest promise reads first. */
export function allocationsOf(
  allocations: readonly SavingAllocation[],
  scenarioId: string,
): readonly SavingAllocation[] {
  return allocations
    .filter((allocation) => allocation.scenarioId === scenarioId)
    .sort(
      (left, right) =>
        right.monthly.minorUnits - left.monthly.minorUnits ||
        left.goal.localeCompare(right.goal, "he") ||
        left.id.localeCompare(right.id),
    );
}

// --- played forward ----------------------------------------------------------

/** One goal's line in one month. */
export interface GoalMonth {
  readonly goal: string;
  readonly contribution: Money;
  /** Everything put into this goal from the first projected month up to here. */
  readonly cumulative: Money;
}

export interface ProjectedMonth {
  readonly month: CalendarMonth;
  readonly goals: readonly GoalMonth[];
  /** Σ of this month's contributions across every goal. */
  readonly contributed: Money;
  /** Σ of everything contributed up to and including this month. */
  readonly cumulative: Money;
}

export interface GoalOutcome {
  readonly allocation: SavingAllocation;
  /** What the goal holds at the end of the horizon. */
  readonly ending: Money;
  /** The month the target is first reached, `null` when there is none or it is not. */
  readonly reachesIn: CalendarMonth | null;
  /** Months of saving to reach the target, counting the first projected month as one. */
  readonly monthsToTarget: number | null;
  /** What is still missing at the horizon, `null` when there is no target or it was met. */
  readonly shortOfTarget: Money | null;
}

/**
 * Why the commitment could not be held against what the household actually saves.
 * Each one is a real state, and none of them is a figure standing in for an answer.
 */
export type PaceStanding = "computed" | "no-pace" | "no-rate";

export interface AllocationPlan {
  readonly currency: Currency;
  /** Σ of the monthly allocations. What each month is promised out to. */
  readonly committed: Money;
  readonly months: readonly ProjectedMonth[];
  readonly goals: readonly GoalOutcome[];
  /** The מאזן's saving pace, read in the allocations' currency. */
  readonly pace: Money | null;
  readonly paceStanding: PaceStanding;
  /** `committed − pace`, when more is promised than is saved. */
  readonly over: Money | null;
  /** `pace − committed`, when saving is left unspoken for. */
  readonly unallocated: Money | null;
}

export interface AllocationProjectionInput {
  readonly allocations: readonly SavingAllocation[];
  readonly scenarioId: string;
  /** The first month of the projection. The clock is a parameter, never read inside. */
  readonly from: CalendarMonth;
  readonly months: number;
  /** What the מאזן says is saved a month, or `null` when nothing was recorded. */
  readonly pace?: Money | null;
  /** The rate to read the pace at, where it is in another currency. */
  readonly rate?: ExchangeRate | null;
  /**
   * The currency to project in when the scenario has no allocations at all. With
   * allocations it is theirs, and mixing two currencies inside one set is refused.
   */
  readonly currency?: Currency;
}

function currencyOf(
  allocations: readonly SavingAllocation[],
  fallback: Currency | undefined,
): Currency {
  const first = allocations[0];
  if (first === undefined) {
    if (fallback === undefined) {
      throw fail("A scenario with no allocations needs an explicit currency to project in");
    }
    return fallback;
  }

  const stranger = allocations.find(
    (allocation) => allocation.monthly.currency !== first.monthly.currency,
  );
  if (stranger !== undefined) {
    throw fail(
      `Allocations inside one scenario are all in one currency; ${first.goal} is in ` +
        `${first.monthly.currency} and ${stranger.goal} is in ${stranger.monthly.currency}`,
    );
  }
  return first.monthly.currency;
}

/**
 * The allocations played out month by month, and held against the pace.
 *
 * Every month contributes the same amounts, because that is what an allocation
 * says. It is deliberately not damped by the pace: a household that promises more
 * than it saves should see the promise it made and the gap beside it, not a
 * quietly reduced figure that hides which of the two is wrong.
 */
export function projectAllocations(input: AllocationProjectionInput): AllocationPlan {
  if (!Number.isInteger(input.months) || input.months <= 0) {
    throw fail(
      `A projection runs over a whole number of months greater than zero, received ${String(input.months)}`,
    );
  }

  const allocations = allocationsOf(input.allocations, input.scenarioId);
  const currency = currencyOf(allocations, input.currency);
  const committed = sum(
    allocations.map((allocation) => allocation.monthly),
    currency,
  );

  const running = new Map<string, Money>(
    allocations.map((allocation) => [allocation.id, zero(currency)]),
  );
  const reached = new Map<string, { month: CalendarMonth; index: number }>();
  const months: ProjectedMonth[] = [];

  for (let index = 0; index < input.months; index += 1) {
    const month = addMonths(input.from, index);
    const goals = allocations.map((allocation): GoalMonth => {
      const cumulative = add(running.get(allocation.id) ?? zero(currency), allocation.monthly);
      running.set(allocation.id, cumulative);

      if (
        allocation.target !== null &&
        !reached.has(allocation.id) &&
        compare(cumulative, allocation.target) >= 0
      ) {
        reached.set(allocation.id, { month, index });
      }

      return { goal: allocation.goal, contribution: allocation.monthly, cumulative };
    });

    months.push({
      month,
      goals,
      contributed: committed,
      cumulative: sum(
        goals.map((goal) => goal.cumulative),
        currency,
      ),
    });
  }

  const goals = allocations.map((allocation): GoalOutcome => {
    const ending = running.get(allocation.id) ?? zero(currency);
    const hit = reached.get(allocation.id);
    return {
      allocation,
      ending,
      reachesIn: hit?.month ?? null,
      // The first projected month is one month of saving, not nought.
      monthsToTarget: hit === undefined ? null : hit.index + 1,
      shortOfTarget:
        allocation.target === null || hit !== undefined
          ? null
          : subtract(allocation.target, ending),
    };
  });

  return {
    currency,
    committed,
    months,
    goals,
    ...standing(committed, currency, input.pace ?? null, input.rate ?? null),
  };
}

function standing(
  committed: Money,
  currency: Currency,
  paceIn: Money | null,
  rate: ExchangeRate | null,
): Pick<AllocationPlan, "pace" | "paceStanding" | "over" | "unallocated"> {
  if (paceIn === null) {
    return { pace: null, paceStanding: "no-pace", over: null, unallocated: null };
  }

  const pace = readInto(paceIn, currency, rate);
  if (pace === null) {
    return { pace: null, paceStanding: "no-rate", over: null, unallocated: null };
  }

  const difference = subtract(committed, pace);
  return {
    pace,
    paceStanding: "computed",
    over: difference.minorUnits > 0 ? difference : null,
    unallocated: difference.minorUnits < 0 ? subtract(pace, committed) : null,
  };
}
