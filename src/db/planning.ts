import { type Currency, isCurrency, money } from "@/domain/money/money";
import {
  type FundingPlan,
  type FundingPlanDefinition,
  type PlannedSource,
  type PlannedSourceDefinition,
  type Scenario,
  type ScenarioDefinition,
  type SourceOrigin,
  buildFundingPlan,
  buildPlannedSource,
  buildScenario,
} from "@/domain/planning/scenarios";
import { dateKey, parseDateKey } from "@/domain/time/calendar-date";

import { query } from "./client";

/**
 * Reading and writing Scenarios, their Funding Plan and its planned sources. The
 * domain decides what a valid one is (src/domain/planning); this stores it.
 *
 * Three tables and nothing else. A scenario reads recorded data — the Ledger for the
 * saving pace, מיפוי for the figures it seeds from — and writes none of it: there is
 * no statement in this file against `entries`, a snapshot, an account or a project,
 * and `src/domain/planning/writes-nothing-recorded.test.ts` is the guard that keeps
 * it that way.
 *
 * Nothing here stores a gap or a month count. Both are computed on read out of the
 * plan, its sources and the Ledger, so a stored figure cannot disagree with the rows
 * it was made of — the same rule the project pot runs on.
 */

interface ScenarioRow extends Record<string, unknown> {
  id: string;
  name: string;
  note: string | null;
  created_on: string;
}

interface FundingPlanRow extends Record<string, unknown> {
  scenario_id: string;
  needs_amount_minor: string;
  needs_currency: string;
  needed_by: string;
}

interface PlannedSourceRow extends Record<string, unknown> {
  id: string;
  scenario_id: string;
  source: string;
  amount_minor: string;
  currency: string;
  origin: string;
  seed_figure: string | null;
  seeded_as_of: string | null;
}

export class MalformedScenarioRowError extends Error {
  constructor(id: string, detail: string) {
    super(`Planning row ${id} is malformed: ${detail}`);
    this.name = "MalformedScenarioRowError";
  }
}

function currencyOf(id: string, value: string): Currency {
  if (!isCurrency(value)) {
    throw new MalformedScenarioRowError(id, `unknown currency ${value}`);
  }
  return value;
}

function minorUnitsOf(id: string, value: string): number {
  const minorUnits = Number(value);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new MalformedScenarioRowError(id, `amount ${value} is not an integer`);
  }
  return minorUnits;
}

// --- the scenario ------------------------------------------------------------

function toScenario(row: ScenarioRow): Scenario {
  return buildScenario(row.id, {
    name: row.name,
    note: row.note,
    createdOn: parseDateKey(row.created_on),
  });
}

export async function loadScenarios(): Promise<readonly Scenario[]> {
  const rows = await query<ScenarioRow>(
    `select id, name, note, to_char(created_on, 'YYYY-MM-DD') as created_on
       from scenarios`,
  );
  return rows.map(toScenario);
}

export async function insertScenario(
  id: string,
  definition: ScenarioDefinition,
): Promise<Scenario> {
  const scenario = buildScenario(id, definition);
  await query(
    `insert into scenarios (id, name, note, created_on) values ($1, $2, $3, $4::date)`,
    [scenario.id, scenario.name, scenario.note, dateKey(scenario.createdOn)],
  );
  return scenario;
}

export async function updateScenario(scenario: Scenario): Promise<void> {
  await query(`update scenarios set name = $2, note = $3 where id = $1`, [
    scenario.id,
    scenario.name,
    scenario.note,
  ]);
}

/**
 * Drop a what-if. Deleting a thought loses nothing that happened: the cascade
 * removes only the plan and its planned sources, and nothing recorded is reachable
 * from here to be taken with it.
 */
export async function deleteScenario(id: string): Promise<void> {
  await query(`delete from scenarios where id = $1`, [id]);
}

// --- the funding plan --------------------------------------------------------

function toFundingPlan(row: FundingPlanRow): FundingPlan {
  return buildFundingPlan({
    scenarioId: row.scenario_id,
    needs: money(
      minorUnitsOf(row.scenario_id, row.needs_amount_minor),
      currencyOf(row.scenario_id, row.needs_currency),
    ),
    neededBy: parseDateKey(row.needed_by),
  });
}

export async function loadFundingPlans(): Promise<readonly FundingPlan[]> {
  const rows = await query<FundingPlanRow>(
    `select scenario_id, needs_amount_minor, needs_currency,
            to_char(needed_by, 'YYYY-MM-DD') as needed_by
       from funding_plans`,
  );
  return rows.map(toFundingPlan);
}

/** At most one per scenario: the requirement is one figure, not a series of them. */
export async function saveFundingPlan(definition: FundingPlanDefinition): Promise<FundingPlan> {
  const plan = buildFundingPlan(definition);
  await query(
    `insert into funding_plans (scenario_id, needs_amount_minor, needs_currency, needed_by)
     values ($1, $2, $3, $4::date)
     on conflict (scenario_id) do update
       set needs_amount_minor = excluded.needs_amount_minor,
           needs_currency     = excluded.needs_currency,
           needed_by          = excluded.needed_by`,
    [plan.scenarioId, plan.needs.minorUnits, plan.needs.currency, dateKey(plan.neededBy)],
  );
  return plan;
}

// --- the planned sources -----------------------------------------------------

function originOf(row: PlannedSourceRow): SourceOrigin {
  if (row.origin === "stated") return { kind: "stated" };
  if (row.origin !== "seeded") {
    throw new MalformedScenarioRowError(row.id, `unknown origin ${row.origin}`);
  }
  if (row.seed_figure !== "free-liquid" || row.seeded_as_of === null) {
    throw new MalformedScenarioRowError(
      row.id,
      "a seeded source must name the figure and the day it was read",
    );
  }
  return { kind: "seeded", figure: "free-liquid", asOf: parseDateKey(row.seeded_as_of) };
}

function toPlannedSource(row: PlannedSourceRow): PlannedSource {
  return buildPlannedSource(row.id, {
    scenarioId: row.scenario_id,
    source: row.source,
    amount: money(minorUnitsOf(row.id, row.amount_minor), currencyOf(row.id, row.currency)),
    origin: originOf(row),
  });
}

export async function loadPlannedSources(): Promise<readonly PlannedSource[]> {
  const rows = await query<PlannedSourceRow>(
    `select id, scenario_id, source, amount_minor, currency, origin, seed_figure,
            to_char(seeded_as_of, 'YYYY-MM-DD') as seeded_as_of
       from funding_plan_sources`,
  );
  return rows.map(toPlannedSource);
}

export async function insertPlannedSource(
  id: string,
  definition: PlannedSourceDefinition,
): Promise<PlannedSource> {
  const line = buildPlannedSource(id, definition);
  const seeded = line.origin.kind === "seeded" ? line.origin : null;

  await query(
    `insert into funding_plan_sources
       (id, scenario_id, source, amount_minor, currency, origin, seed_figure, seeded_as_of)
     values ($1, $2, $3, $4, $5, $6, $7, $8::date)`,
    [
      line.id,
      line.scenarioId,
      line.source,
      line.amount.minorUnits,
      line.amount.currency,
      line.origin.kind,
      seeded === null ? null : seeded.figure,
      seeded === null ? null : dateKey(seeded.asOf),
    ],
  );
  return line;
}

export async function deletePlannedSource(id: string): Promise<void> {
  await query(`delete from funding_plan_sources where id = $1`, [id]);
}
