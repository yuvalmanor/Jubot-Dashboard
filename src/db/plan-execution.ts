import {
  type ExecutionPreview,
  type PlanExecution,
  buildPlanExecution,
  requireExecutable,
} from "@/domain/planning/execution";
import { dateKey } from "@/domain/time/calendar-date";

import { withTransaction } from "./client";
import { insertFundingLeg } from "./projects";

/**
 * The one place לוח תכנון writes something recorded.
 *
 * Every other planning operation touches its own tables and nothing else — that is
 * what makes a scenario safe to think in, and `writes-nothing-recorded.test.ts` is
 * the guard on it. Executing a Funding Plan is the deliberate exception: the whole
 * point of a plan is that one day it stops being a what-if, and the money it
 * described actually goes into a project.
 *
 * Three properties this file exists to hold:
 *
 * **It is the only exception, and it is findable.** One file, one function, named
 * for what it does. A recorded write reached from anywhere else in the area is a
 * bug the guard fails on.
 *
 * **It writes the legs through the project area's own writer.** `insertFundingLeg`
 * validates against the pot it fills, so a leg created here is a leg created the
 * same way the project screen creates one — there is no second, laxer path into
 * `funding_legs`.
 *
 * **It is atomic.** Legs and the record that it happened land together or not at
 * all. A pot funded by three of five planned sources, with nothing saying the plan
 * ran, is the state this transaction exists to make unreachable.
 */

export interface ExecutionOutcome {
  readonly execution: PlanExecution;
  readonly legIds: readonly string[];
}

/**
 * Turn a previewed plan into the project's funding legs.
 *
 * The preview is the argument, not the raw plan: what the household confirmed is
 * exactly what gets written, and the domain has already refused everything that
 * could not be trusted — a conversion with no rate, a second execution, a plan with
 * nothing in it. `requireExecutable` is checked again here rather than assumed,
 * because the confirmation travelled through a form.
 */
export async function executeFundingPlan(preview: ExecutionPreview): Promise<ExecutionOutcome> {
  requireExecutable(preview);

  const execution = buildPlanExecution({
    scenarioId: preview.scenarioId,
    projectId: preview.project.id,
    executedOn: preview.paidOn,
    rate: preview.rate,
    legCount: preview.lines.length,
  });

  return withTransaction(async (run) => {
    const legIds: string[] = [];

    for (const line of preview.lines) {
      // A fresh id per leg. The preview validated each line under the planned
      // source's own id, which was only ever a placeholder for this one.
      const id = crypto.randomUUID();
      await insertFundingLeg(id, line.definition, preview.project, run);
      legIds.push(id);
    }

    // The primary key is the scenario, so a second execution of the same plan is
    // refused by the database as well as by the domain. Two guards, because this
    // one cannot be undone by editing a row.
    await run(
      `insert into funding_plan_executions
         (scenario_id, project_id, executed_on, usd_ils_rate, leg_count)
       values ($1, $2, $3::date, $4, $5)`,
      [
        execution.scenarioId,
        execution.projectId,
        dateKey(execution.executedOn),
        execution.rate === null ? null : execution.rate.rate,
        execution.legCount,
      ],
    );

    return { execution, legIds };
  });
}
