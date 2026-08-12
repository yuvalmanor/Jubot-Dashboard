/**
 * Executing a Funding Plan — the one moment planning writes something recorded.
 *
 * Framework-free per ADR 0004.
 *
 * A planned source is the *before* of a Funding Leg: same facts, future tense, with
 * the rate and the payment date deliberately missing because neither exists yet.
 * Executing is what supplies them. The lines the household already wrote become the
 * project's legs — so the transition from "we will fund it like this" to "this is
 * how it was funded" is not somebody re-typing five rows into another screen and
 * getting one of them slightly wrong.
 *
 * Four rules hold it in place:
 *
 * **It is explicit.** Nothing executes as a side effect of editing a plan. The
 * household names the project, the day the money moved and the rate it moved at,
 * reads back exactly which legs that produces, and confirms.
 *
 * **It is all or nothing.** A refusal on any line refuses the whole execution. Half
 * a plan in a pot is worse than none of it, because the pot would then read as
 * funded by an amount nobody decided on.
 *
 * **It happens once.** An executed plan is no longer a what-if; it is how a project
 * came to be funded. Executing again would double every leg, so it is refused, and
 * so is editing or deleting the scenario afterwards.
 *
 * **Nothing is converted at a rate nobody named.** A source in the pot's own
 * currency converted nothing and carries no rate; one in the other currency carries
 * the rate that was actually used. That is the Funding Leg's own rule, enforced by
 * the Funding Leg's own builder — this module supplies the inputs and never
 * re-implements the arithmetic.
 */

import {
  type ExchangeRate,
  type Money,
  subtract,
  sum,
} from "@/domain/money/money";
import { type FundingPlan, type PlannedSource, readInto, sourcesOf } from "@/domain/planning/scenarios";
import {
  type FundingLeg,
  type FundingLegDefinition,
  type Project,
  buildFundingLeg,
  legInPotCurrency,
} from "@/domain/projects/projects";
import { type CalendarDate } from "@/domain/time/calendar-date";

// --- the record that it happened ---------------------------------------------

export interface PlanExecution {
  readonly scenarioId: string;
  /** The pot the plan's lines went into. */
  readonly projectId: string;
  readonly executedOn: CalendarDate;
  /** The rate the conversions used, `null` where nothing was converted. */
  readonly rate: ExchangeRate | null;
  readonly legCount: number;
}

export class InvalidExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExecutionError";
  }
}

export interface PlanExecutionDefinition {
  readonly scenarioId: string;
  readonly projectId: string;
  readonly executedOn: CalendarDate;
  readonly rate?: ExchangeRate | null;
  readonly legCount: number;
}

export function buildPlanExecution(definition: PlanExecutionDefinition): PlanExecution {
  if (!Number.isInteger(definition.legCount) || definition.legCount <= 0) {
    throw new InvalidExecutionError(
      `An execution creates at least one funding leg, received ${String(definition.legCount)}`,
    );
  }
  return {
    scenarioId: definition.scenarioId,
    projectId: definition.projectId,
    executedOn: definition.executedOn,
    rate: definition.rate ?? null,
    legCount: definition.legCount,
  };
}

export function executionFor(
  executions: readonly PlanExecution[],
  scenarioId: string,
): PlanExecution | null {
  return executions.find((execution) => execution.scenarioId === scenarioId) ?? null;
}

/**
 * An executed scenario is a record of how a project was funded, so what can still
 * be done to it changes: its plan, its sources and the scenario itself are frozen.
 * Correcting a leg is a job for the project screen, where the leg actually lives.
 */
export class PlanAlreadyExecutedError extends Error {
  constructor(readonly execution: PlanExecution) {
    super(
      `Scenario ${execution.scenarioId} was executed on ${execution.executedOn.year}-` +
        `${execution.executedOn.month}-${execution.executedOn.day} into project ${execution.projectId}; ` +
        "its plan is now a record of what happened and does not change",
    );
    this.name = "PlanAlreadyExecutedError";
  }
}

export function requireNotExecuted(execution: PlanExecution | null): void {
  if (execution !== null) throw new PlanAlreadyExecutedError(execution);
}

// --- what executing would produce ---------------------------------------------

/** Why a plan cannot be executed. Every one of them is a real state of the data. */
export type ExecutionRefusalCode =
  | "no-plan"
  | "no-sources"
  | "already-executed"
  | "unusable-line";

export interface ExecutionRefusal {
  readonly code: ExecutionRefusalCode;
  /** What the domain said, in its own words. Shown beside the refusal. */
  readonly detail: string;
}

/** One planned source, as the funding leg it would become. */
export interface ExecutableLine {
  readonly source: PlannedSource;
  /** Everything the leg needs but its id, which the writer mints. */
  readonly definition: FundingLegDefinition;
  /** The leg as the domain validates it — built here so the preview is the truth. */
  readonly leg: FundingLeg;
  /** What it is worth inside the pot, at the rate stated. */
  readonly inPotCurrency: Money;
}

export interface ExecutionPreview {
  readonly scenarioId: string;
  readonly project: Project;
  readonly paidOn: CalendarDate;
  /** The rate the lines actually convert at, `null` when none of them converts. */
  readonly rate: ExchangeRate | null;
  readonly lines: readonly ExecutableLine[];
  /** Σ of the lines in the pot's currency. What the project would be funded by. */
  readonly total: Money;
  /** What the plan said it needed, read into the pot's currency. */
  readonly needs: Money | null;
  /** `total − needs`. Negative where the sources fall short of the requirement. */
  readonly difference: Money | null;
  readonly executable: boolean;
  readonly refusal: ExecutionRefusal | null;
  /** The execution already on record, when there is one. */
  readonly executed: PlanExecution | null;
}

export interface ExecutionPreviewInput {
  readonly scenarioId: string;
  readonly plan: FundingPlan | null;
  readonly sources: readonly PlannedSource[];
  readonly project: Project;
  readonly paidOn: CalendarDate;
  readonly rate?: ExchangeRate | null;
  readonly executed?: PlanExecution | null;
}

/**
 * Exactly what executing this plan would write, computed before anything is
 * written. The lines are built through the Funding Leg's own builder, so a preview
 * that reads clean is a preview the writer cannot fail on for a reason the reader
 * never saw.
 */
export function previewExecution(input: ExecutionPreviewInput): ExecutionPreview {
  const { project, scenarioId } = input;
  const supplied = input.rate ?? null;
  const executed = input.executed ?? null;
  const sources = sourcesOf(input.sources, scenarioId);

  const base = {
    scenarioId,
    project,
    paidOn: input.paidOn,
    lines: [] as readonly ExecutableLine[],
    total: sum([], project.currency),
    needs: input.plan === null ? null : readInto(input.plan.needs, project.currency, supplied),
    difference: null,
    executed,
  } as const;

  if (executed !== null) {
    return {
      ...base,
      rate: executed.rate,
      executable: false,
      refusal: { code: "already-executed", detail: new PlanAlreadyExecutedError(executed).message },
    };
  }
  if (input.plan === null) {
    return {
      ...base,
      rate: null,
      executable: false,
      refusal: {
        code: "no-plan",
        detail: "There is no funding plan to execute — nobody has said what the investment needs",
      },
    };
  }
  if (sources.length === 0) {
    return {
      ...base,
      rate: null,
      executable: false,
      refusal: {
        code: "no-sources",
        detail: "A plan with no planned sources produces no funding legs",
      },
    };
  }

  const lines: ExecutableLine[] = [];
  for (const source of sources) {
    // A leg in the pot's own currency converted nothing and must carry no rate.
    // The rule is the Funding Leg's, and so is the enforcement.
    const definition: FundingLegDefinition = {
      projectId: project.id,
      source: source.source,
      amount: source.amount,
      rate: source.amount.currency === project.currency ? null : supplied,
      paidOn: input.paidOn,
    };

    try {
      const leg = buildFundingLeg(source.id, definition, project);
      lines.push({ source, definition, leg, inPotCurrency: legInPotCurrency(leg, project) });
    } catch (error) {
      return {
        ...base,
        rate: null,
        executable: false,
        refusal: {
          code: "unusable-line",
          detail: `${source.source}: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  const total = sum(
    lines.map((line) => line.inPotCurrency),
    project.currency,
  );
  const converts = lines.some((line) => line.leg.rate !== null);
  const needs = readInto(input.plan.needs, project.currency, supplied);

  return {
    scenarioId,
    project,
    paidOn: input.paidOn,
    rate: converts ? supplied : null,
    lines,
    total,
    needs,
    difference: needs === null ? null : subtract(total, needs),
    executable: true,
    refusal: null,
    executed: null,
  };
}

/** The preview, insisted upon. Whoever writes calls this before writing anything. */
export function requireExecutable(preview: ExecutionPreview): void {
  if (!preview.executable || preview.refusal !== null) {
    throw new InvalidExecutionError(
      preview.refusal?.detail ?? "This funding plan cannot be executed",
    );
  }
}
