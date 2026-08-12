import { type Currency, exchangeRate, isCurrency, money } from "@/domain/money/money";
import {
  type DealTerms,
  type DealTermsDefinition,
  type FundingLeg,
  type FundingLegDefinition,
  type Project,
  type ProjectDefinition,
  type ProjectExpense,
  type ProjectExpenseDefinition,
  buildDealTerms,
  buildFundingLeg,
  buildProject,
  buildProjectExpense,
} from "@/domain/projects/projects";
import { dateKey, parseDateKey } from "@/domain/time/calendar-date";

import { type TransactionQuery, query } from "./client";

/**
 * Reading and writing Projects, their Funding Legs, their expense ledger and their
 * Deal Terms. The domain decides what a valid one is (src/domain/projects); this
 * stores it.
 *
 * Nothing here stores a total. `יתרה` is `Σ(legs) − Σ(expenses)` computed on read,
 * and the effective rate is derived from the rows — a stored total is a total that
 * can disagree with what it is made of, which is the failure this replaces.
 */

interface ProjectRow extends Record<string, unknown> {
  id: string;
  name: string;
  currency: string;
  account_id: string | null;
  started_on: string;
}

interface MovementRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  amount_minor: string;
  currency: string;
  usd_ils_rate: string | null;
  paid_on: string;
}

interface FundingLegRow extends MovementRow {
  source: string;
}

interface ProjectExpenseRow extends MovementRow {
  description: string;
}

interface DealTermsRow extends Record<string, unknown> {
  project_id: string;
  target_return_bp: number | null;
  hold_months: number | null;
  distribution: string | null;
  source: string | null;
  recorded_on: string;
}

export class MalformedProjectRowError extends Error {
  constructor(id: string, detail: string) {
    super(`Project row ${id} is malformed: ${detail}`);
    this.name = "MalformedProjectRowError";
  }
}

function currencyOf(id: string, value: string): Currency {
  if (!isCurrency(value)) {
    throw new MalformedProjectRowError(id, `unknown currency ${value}`);
  }
  return value;
}

function amountOf(row: MovementRow) {
  const minorUnits = Number(row.amount_minor);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new MalformedProjectRowError(row.id, `amount_minor ${row.amount_minor} is not an integer`);
  }
  return money(minorUnits, currencyOf(row.id, row.currency));
}

/**
 * The rate is quoted `USD/ILS` in both directions, so one stored number can never
 * be read as two — the same rule the שקל and the דולר tables run on.
 */
function rateOf(row: MovementRow) {
  return row.usd_ils_rate === null ? null : exchangeRate("USD", "ILS", Number(row.usd_ils_rate));
}

function toProject(row: ProjectRow): Project {
  return buildProject(row.id, {
    name: row.name,
    currency: currencyOf(row.id, row.currency),
    accountId: row.account_id,
    startedOn: parseDateKey(row.started_on),
  });
}

export async function loadProjects(): Promise<readonly Project[]> {
  const rows = await query<ProjectRow>(
    `select id, name, currency, account_id, to_char(started_on, 'YYYY-MM-DD') as started_on
       from projects`,
  );
  return rows.map(toProject);
}

export async function insertProject(id: string, definition: ProjectDefinition): Promise<Project> {
  const project = buildProject(id, definition);
  await query(
    `insert into projects (id, name, currency, account_id, started_on)
     values ($1, $2, $3, $4, $5::date)`,
    [project.id, project.name, project.currency, project.accountId, dateKey(project.startedOn)],
  );
  return project;
}

/**
 * Correct a definition. The currency is not editable: it is what the pot *is*, and
 * changing it would re-denominate every leg and expense already recorded in it —
 * and turn the rate on each of them into a rate for the wrong pair.
 */
export async function updateProject(project: Project): Promise<void> {
  await query(
    `update projects set name = $2, account_id = $3, started_on = $4::date where id = $1`,
    [project.id, project.name, project.accountId, dateKey(project.startedOn)],
  );
}

// --- funding legs ------------------------------------------------------------

function toFundingLeg(row: FundingLegRow, projects: readonly Project[]): FundingLeg {
  const project = projects.find((candidate) => candidate.id === row.project_id);
  if (project === undefined) {
    throw new MalformedProjectRowError(row.id, `no project ${row.project_id}`);
  }
  return buildFundingLeg(
    row.id,
    {
      projectId: row.project_id,
      source: row.source,
      amount: amountOf(row),
      rate: rateOf(row),
      paidOn: parseDateKey(row.paid_on),
    },
    project,
  );
}

/**
 * Every leg, with the projects beside them: a leg is only valid against the pot it
 * fills, because whether it needed a rate is a question about the pot's currency.
 */
export async function loadFundingLegs(projects: readonly Project[]): Promise<readonly FundingLeg[]> {
  const rows = await query<FundingLegRow>(
    `select id, project_id, source, amount_minor, currency, usd_ils_rate,
            to_char(paid_on, 'YYYY-MM-DD') as paid_on
       from funding_legs`,
  );
  return rows.map((row) => toFundingLeg(row, projects));
}

/**
 * `run` is the runner to write through, and defaults to a statement of its own.
 * Executing a Funding Plan writes several legs and the record that it happened in
 * one transaction — half a plan in a pot is worse than none of it — and it does so
 * through here rather than through a second copy of this statement.
 */
export async function insertFundingLeg(
  id: string,
  definition: FundingLegDefinition,
  project: Project,
  run: TransactionQuery = query,
): Promise<FundingLeg> {
  const leg = buildFundingLeg(id, definition, project);
  await run(
    `insert into funding_legs (id, project_id, source, amount_minor, currency, usd_ils_rate, paid_on)
     values ($1, $2, $3, $4, $5, $6, $7::date)`,
    [
      leg.id,
      leg.projectId,
      leg.source,
      leg.amount.minorUnits,
      leg.amount.currency,
      leg.rate === null ? null : leg.rate.rate,
      dateKey(leg.paidOn),
    ],
  );
  return leg;
}

/**
 * Remove a leg. Correcting a mistyped row rather than taking money out — the
 * domain refuses it when the pot has already spent against it.
 */
export async function deleteFundingLeg(id: string): Promise<void> {
  await query(`delete from funding_legs where id = $1`, [id]);
}

// --- the expense ledger ------------------------------------------------------

function toProjectExpense(row: ProjectExpenseRow, projects: readonly Project[]): ProjectExpense {
  const project = projects.find((candidate) => candidate.id === row.project_id);
  if (project === undefined) {
    throw new MalformedProjectRowError(row.id, `no project ${row.project_id}`);
  }
  return buildProjectExpense(
    row.id,
    {
      projectId: row.project_id,
      description: row.description,
      amount: amountOf(row),
      rate: rateOf(row),
      paidOn: parseDateKey(row.paid_on),
    },
    project,
  );
}

export async function loadProjectExpenses(
  projects: readonly Project[],
): Promise<readonly ProjectExpense[]> {
  const rows = await query<ProjectExpenseRow>(
    `select id, project_id, description, amount_minor, currency, usd_ils_rate,
            to_char(paid_on, 'YYYY-MM-DD') as paid_on
       from project_expenses`,
  );
  return rows.map((row) => toProjectExpense(row, projects));
}

export async function insertProjectExpense(
  id: string,
  definition: ProjectExpenseDefinition,
  project: Project,
): Promise<ProjectExpense> {
  const expense = buildProjectExpense(id, definition, project);
  await query(
    `insert into project_expenses (id, project_id, description, amount_minor, currency, usd_ils_rate, paid_on)
     values ($1, $2, $3, $4, $5, $6, $7::date)`,
    [
      expense.id,
      expense.projectId,
      expense.description,
      expense.amount.minorUnits,
      expense.amount.currency,
      expense.rate === null ? null : expense.rate.rate,
      dateKey(expense.paidOn),
    ],
  );
  return expense;
}

/** Remove an expense. Always safe: taking one out can only leave the pot fuller. */
export async function deleteProjectExpense(id: string): Promise<void> {
  await query(`delete from project_expenses where id = $1`, [id]);
}

// --- deal terms --------------------------------------------------------------

function toDealTerms(row: DealTermsRow): DealTerms {
  return buildDealTerms({
    projectId: row.project_id,
    targetReturnBasisPoints: row.target_return_bp,
    holdMonths: row.hold_months,
    distribution: row.distribution,
    source: row.source,
    recordedOn: parseDateKey(row.recorded_on),
  });
}

export async function loadDealTerms(): Promise<readonly DealTerms[]> {
  const rows = await query<DealTermsRow>(
    `select project_id, target_return_bp, hold_months, distribution, source,
            to_char(recorded_on, 'YYYY-MM-DD') as recorded_on
       from deal_terms`,
  );
  return rows.map(toDealTerms);
}

/** At most one row per project: the terms are one document read once, not a series. */
export async function saveDealTerms(definition: DealTermsDefinition): Promise<DealTerms> {
  const terms = buildDealTerms(definition);
  await query(
    `insert into deal_terms (project_id, target_return_bp, hold_months, distribution, source, recorded_on)
     values ($1, $2, $3, $4, $5, $6::date)
     on conflict (project_id) do update
       set target_return_bp = excluded.target_return_bp,
           hold_months      = excluded.hold_months,
           distribution     = excluded.distribution,
           source           = excluded.source,
           recorded_on      = excluded.recorded_on`,
    [
      terms.projectId,
      terms.targetReturnBasisPoints,
      terms.holdMonths,
      terms.distribution,
      terms.source,
      dateKey(terms.recordedOn),
    ],
  );
  return terms;
}
