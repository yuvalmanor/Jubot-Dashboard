import { type Currency, exchangeRate, isCurrency, money } from "@/domain/money/money";
import {
  type SavingAllocation,
  type SavingAllocationDefinition,
  buildSavingAllocation,
} from "@/domain/planning/allocations";
import {
  type PlanExecution,
  buildPlanExecution,
} from "@/domain/planning/execution";
import {
  type InvestmentPattern,
  type InvestmentPatternDefinition,
  type ScenarioTerms,
  type ScenarioTermsDefinition,
  buildInvestmentPattern,
  buildScenarioTerms,
} from "@/domain/planning/patterns";
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

import { query, withTransaction } from "./client";

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
  is_active: boolean;
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
    active: row.is_active,
  });
}

export async function loadScenarios(): Promise<readonly Scenario[]> {
  const rows = await query<ScenarioRow>(
    `select id, name, note, to_char(created_on, 'YYYY-MM-DD') as created_on, is_active
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
 * removes only the plan, its planned sources, its allocations, its pattern and the
 * terms it overrode, and nothing recorded is reachable from here to be taken with
 * it. A scenario that was *executed* is no longer only a thought, and the foreign
 * key from `funding_plan_executions` — which deliberately does not cascade —
 * refuses to let it go.
 */
export async function deleteScenario(id: string): Promise<void> {
  await query(`delete from scenarios where id = $1`, [id]);
}

/**
 * Mark the one plan the household says it is following, or mark none.
 *
 * Cleared first and set second, in one transaction. Doing it in a single statement
 * would ask the one-active index to hold while two rows are half-written; doing it
 * in two without a transaction would leave a moment with no plan at all.
 */
export async function setActivePlan(scenarioId: string | null): Promise<void> {
  await withTransaction(async (run) => {
    await run(`update scenarios set is_active = false where is_active`);
    if (scenarioId !== null) {
      await run(`update scenarios set is_active = true where id = $1`, [scenarioId]);
    }
  });
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

// --- the saving allocations --------------------------------------------------

interface AllocationRow extends Record<string, unknown> {
  id: string;
  scenario_id: string;
  goal: string;
  monthly_amount_minor: string;
  target_minor: string | null;
  currency: string;
}

function toAllocation(row: AllocationRow): SavingAllocation {
  const currency = currencyOf(row.id, row.currency);
  return buildSavingAllocation(row.id, {
    scenarioId: row.scenario_id,
    goal: row.goal,
    monthly: money(minorUnitsOf(row.id, row.monthly_amount_minor), currency),
    target:
      row.target_minor === null ? null : money(minorUnitsOf(row.id, row.target_minor), currency),
  });
}

export async function loadAllocations(): Promise<readonly SavingAllocation[]> {
  const rows = await query<AllocationRow>(
    `select id, scenario_id, goal, monthly_amount_minor, target_minor, currency
       from scenario_allocations`,
  );
  return rows.map(toAllocation);
}

export async function insertAllocation(
  id: string,
  definition: SavingAllocationDefinition,
): Promise<SavingAllocation> {
  const allocation = buildSavingAllocation(id, definition);
  await query(
    `insert into scenario_allocations
       (id, scenario_id, goal, monthly_amount_minor, target_minor, currency)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      allocation.id,
      allocation.scenarioId,
      allocation.goal,
      allocation.monthly.minorUnits,
      allocation.target === null ? null : allocation.target.minorUnits,
      allocation.monthly.currency,
    ],
  );
  return allocation;
}

export async function deleteAllocation(id: string): Promise<void> {
  await query(`delete from scenario_allocations where id = $1`, [id]);
}

// --- the repeating pattern ---------------------------------------------------

interface PatternRow extends Record<string, unknown> {
  scenario_id: string;
  amount_minor: string;
  currency: string;
  every_months: number;
  occurrences: number;
  first_on: string;
  modelled_on: string | null;
}

function toPattern(row: PatternRow): InvestmentPattern {
  return buildInvestmentPattern({
    scenarioId: row.scenario_id,
    amount: money(
      minorUnitsOf(row.scenario_id, row.amount_minor),
      currencyOf(row.scenario_id, row.currency),
    ),
    everyMonths: row.every_months,
    occurrences: row.occurrences,
    firstOn: parseDateKey(row.first_on),
    modelledOn: row.modelled_on,
  });
}

export async function loadPatterns(): Promise<readonly InvestmentPattern[]> {
  const rows = await query<PatternRow>(
    `select scenario_id, amount_minor, currency, every_months, occurrences,
            to_char(first_on, 'YYYY-MM-DD') as first_on, modelled_on
       from scenario_patterns`,
  );
  return rows.map(toPattern);
}

/** At most one per scenario: a pattern is the shape of one strategy. */
export async function savePattern(
  definition: InvestmentPatternDefinition,
): Promise<InvestmentPattern> {
  const pattern = buildInvestmentPattern(definition);
  await query(
    `insert into scenario_patterns
       (scenario_id, amount_minor, currency, every_months, occurrences, first_on, modelled_on)
     values ($1, $2, $3, $4, $5, $6::date, $7)
     on conflict (scenario_id) do update
       set amount_minor = excluded.amount_minor,
           currency     = excluded.currency,
           every_months = excluded.every_months,
           occurrences  = excluded.occurrences,
           first_on     = excluded.first_on,
           modelled_on  = excluded.modelled_on`,
    [
      pattern.scenarioId,
      pattern.amount.minorUnits,
      pattern.amount.currency,
      pattern.everyMonths,
      pattern.occurrences,
      dateKey(pattern.firstOn),
      pattern.modelledOn,
    ],
  );
  return pattern;
}

export async function deletePattern(scenarioId: string): Promise<void> {
  await query(`delete from scenario_patterns where scenario_id = $1`, [scenarioId]);
}

// --- the deal terms a scenario overrides -------------------------------------

interface ScenarioTermsRow extends Record<string, unknown> {
  scenario_id: string;
  project_id: string;
  target_return_bp: number | null;
  hold_months: number | null;
}

function toScenarioTerms(row: ScenarioTermsRow): ScenarioTerms {
  return buildScenarioTerms({
    scenarioId: row.scenario_id,
    projectId: row.project_id,
    targetReturnBasisPoints: row.target_return_bp,
    holdMonths: row.hold_months,
  });
}

export async function loadScenarioTerms(): Promise<readonly ScenarioTerms[]> {
  const rows = await query<ScenarioTermsRow>(
    `select scenario_id, project_id, target_return_bp, hold_months from scenario_deal_terms`,
  );
  return rows.map(toScenarioTerms);
}

/**
 * What this scenario says instead of the paperwork. An override stating nothing at
 * all is deleted rather than stored: "this scenario has no opinion" is exactly the
 * absence of a row, and a row of nulls would make it look like an opinion.
 */
export async function saveScenarioTerms(
  definition: ScenarioTermsDefinition,
): Promise<ScenarioTerms | null> {
  const terms = buildScenarioTerms(definition);
  if (terms.targetReturnBasisPoints === null && terms.holdMonths === null) {
    await deleteScenarioTerms(terms.scenarioId, terms.projectId);
    return null;
  }

  await query(
    `insert into scenario_deal_terms (scenario_id, project_id, target_return_bp, hold_months)
     values ($1, $2, $3, $4)
     on conflict (scenario_id, project_id) do update
       set target_return_bp = excluded.target_return_bp,
           hold_months      = excluded.hold_months`,
    [terms.scenarioId, terms.projectId, terms.targetReturnBasisPoints, terms.holdMonths],
  );
  return terms;
}

export async function deleteScenarioTerms(
  scenarioId: string,
  projectId: string,
): Promise<void> {
  await query(`delete from scenario_deal_terms where scenario_id = $1 and project_id = $2`, [
    scenarioId,
    projectId,
  ]);
}

// --- the record that a plan was executed -------------------------------------

interface ExecutionRow extends Record<string, unknown> {
  scenario_id: string;
  project_id: string;
  executed_on: string;
  usd_ils_rate: string | null;
  leg_count: number;
}

function toExecution(row: ExecutionRow): PlanExecution {
  return buildPlanExecution({
    scenarioId: row.scenario_id,
    projectId: row.project_id,
    executedOn: parseDateKey(row.executed_on),
    rate: row.usd_ils_rate === null ? null : exchangeRate("USD", "ILS", Number(row.usd_ils_rate)),
    legCount: row.leg_count,
  });
}

/**
 * Reading only. Writing one of these is what turns a plan into funding legs, and
 * that happens in exactly one place — `src/db/plan-execution.ts` — because it is
 * the one planning operation that writes something recorded.
 */
export async function loadPlanExecutions(): Promise<readonly PlanExecution[]> {
  const rows = await query<ExecutionRow>(
    `select scenario_id, project_id, to_char(executed_on, 'YYYY-MM-DD') as executed_on,
            usd_ils_rate, leg_count
       from funding_plan_executions`,
  );
  return rows.map(toExecution);
}
