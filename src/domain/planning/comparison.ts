/**
 * Two scenarios, side by side — "Meteor or another CGM" as a comparison rather
 * than a feeling.
 *
 * Framework-free per ADR 0004.
 *
 * Every row here is a figure both scenarios already produce on their own screens.
 * Nothing is recomputed differently for the comparison, so a scenario cannot read
 * one way on its own page and another way beside its rival — which is the whole
 * failure a side-by-side is supposed to prevent.
 *
 * Two rules make the difference column trustworthy:
 *
 * **A difference is only stated where the two are the same question.** A dollar
 * plan against a shekel plan has no difference to state, and the row says so rather
 * than subtracting two numbers that are not comparable. This is the same refusal
 * the funding gap makes about a source in another currency.
 *
 * **The row says which is smaller and never which is better.** Fewer months to
 * close is good and a smaller requirement is neither good nor bad; a comparison
 * that ranked them would be answering a question the household did not ask.
 */

import { type Currency, type Money, subtract, sum } from "@/domain/money/money";
import { type AllocationPlan } from "@/domain/planning/allocations";
import { type PatternProjection } from "@/domain/planning/patterns";
import { type ScenarioReading } from "@/domain/planning/scenarios";
import { type CalendarMonth, compareMonths, monthsBetween } from "@/domain/time/calendar-month";

/** Everything one side of the comparison is, assembled by whoever reads it. */
export interface ComparableScenario {
  readonly reading: ScenarioReading;
  readonly allocations?: AllocationPlan | null;
  readonly pattern?: PatternProjection | null;
}

export type ComparisonKey =
  | "needs"
  | "covered"
  | "gap"
  | "months-to-close"
  | "closes-in"
  | "allocated-monthly"
  | "pattern-commitment"
  | "pattern-funded";

export type Side = "left" | "right";

interface Row<Value> {
  readonly key: ComparisonKey;
  readonly left: Value | null;
  readonly right: Value | null;
  /** Which side holds the smaller figure. A fact, never a verdict. */
  readonly smaller: Side | "equal" | null;
}

export interface MoneyRow extends Row<Money> {
  readonly kind: "money";
  /** `right − left`, `null` where the two are not the same question. */
  readonly difference: Money | null;
  /** False when the two sides are in different currencies, or one is missing. */
  readonly comparable: boolean;
}

export interface CountRow extends Row<number> {
  readonly kind: "count";
  readonly difference: number | null;
}

export interface MonthRow extends Row<CalendarMonth> {
  readonly kind: "month";
  /** Whole months from the left one to the right one. */
  readonly difference: number | null;
}

export type ComparisonRow = MoneyRow | CountRow | MonthRow;

export interface ScenarioComparison {
  readonly left: ComparableScenario;
  readonly right: ComparableScenario;
  readonly rows: readonly ComparisonRow[];
  /**
   * The currency each side's plan is denominated in. Where the two differ, every
   * money row states both figures and no difference, and the screen says why.
   */
  readonly currencies: { readonly left: Currency | null; readonly right: Currency | null };
  readonly sameCurrency: boolean;
}

export class InvalidComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidComparisonError";
  }
}

function moneyRow(key: ComparisonKey, left: Money | null, right: Money | null): MoneyRow {
  const comparable = left !== null && right !== null && left.currency === right.currency;
  return {
    kind: "money",
    key,
    left,
    right,
    difference: comparable && left !== null && right !== null ? subtract(right, left) : null,
    comparable,
    smaller:
      !comparable || left === null || right === null
        ? null
        : left.minorUnits < right.minorUnits
          ? "left"
          : left.minorUnits > right.minorUnits
            ? "right"
            : "equal",
  };
}

function countRow(key: ComparisonKey, left: number | null, right: number | null): CountRow {
  const both = left !== null && right !== null;
  return {
    kind: "count",
    key,
    left,
    right,
    difference: both ? right - left : null,
    smaller: !both ? null : left < right ? "left" : left > right ? "right" : "equal",
  };
}

function earlier(order: -1 | 0 | 1): Side | "equal" {
  if (order < 0) return "left";
  if (order > 0) return "right";
  return "equal";
}

function monthRow(
  key: ComparisonKey,
  left: CalendarMonth | null,
  right: CalendarMonth | null,
): MonthRow {
  const both = left !== null && right !== null;
  return {
    kind: "month",
    key,
    left,
    right,
    difference: both ? monthsBetween(left, right) : null,
    // The earlier month is the smaller one, the way an earlier date is.
    smaller: !both ? null : earlier(compareMonths(left, right)),
  };
}

/** Whether a row says anything at all. A row with two blanks is not a comparison. */
function stated(row: ComparisonRow): boolean {
  return row.left !== null || row.right !== null;
}

/** What one side commits every month across its goals, `null` when it allocates none. */
function committed(side: ComparableScenario): Money | null {
  const plan = side.allocations ?? null;
  if (plan === null || plan.goals.length === 0) return null;
  return plan.committed;
}

/** What a repeating pattern asks for in total, over every occurrence in it. */
function patternCommitment(side: ComparableScenario): Money | null {
  const projection = side.pattern ?? null;
  if (projection === null || projection.investments.length === 0) return null;
  return sum(
    projection.investments.map((investment) => investment.amount),
    projection.currency,
  );
}

export function compareScenarios(
  left: ComparableScenario,
  right: ComparableScenario,
): ScenarioComparison {
  if (left.reading.scenario.id === right.reading.scenario.id) {
    throw new InvalidComparisonError(
      "A scenario compared against itself answers nothing; two different ones are needed",
    );
  }

  const currencies = {
    left: left.reading.gap?.currency ?? null,
    right: right.reading.gap?.currency ?? null,
  };

  const rows: ComparisonRow[] = [
    moneyRow("needs", left.reading.gap?.needs ?? null, right.reading.gap?.needs ?? null),
    moneyRow("covered", left.reading.gap?.covered ?? null, right.reading.gap?.covered ?? null),
    moneyRow("gap", left.reading.gap?.gap ?? null, right.reading.gap?.gap ?? null),
    countRow(
      "months-to-close",
      left.reading.closure?.months ?? null,
      right.reading.closure?.months ?? null,
    ),
    monthRow(
      "closes-in",
      left.reading.closure?.closesIn ?? null,
      right.reading.closure?.closesIn ?? null,
    ),
    moneyRow("allocated-monthly", committed(left), committed(right)),
    moneyRow("pattern-commitment", patternCommitment(left), patternCommitment(right)),
    countRow(
      "pattern-funded",
      left.pattern?.fundedCount ?? null,
      right.pattern?.fundedCount ?? null,
    ),
  ];

  return {
    left,
    right,
    rows: rows.filter(stated),
    currencies,
    sameCurrency:
      currencies.left !== null && currencies.right !== null && currencies.left === currencies.right,
  };
}
