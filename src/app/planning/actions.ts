"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { loadAccounts } from "@/db/accounts";
import { loadEarmarks } from "@/db/holdings";
import { findPersonByEmail } from "@/db/people";
import { executeFundingPlan } from "@/db/plan-execution";
import {
  deleteAllocation,
  deletePattern,
  deletePlannedSource,
  deleteScenario,
  insertAllocation,
  insertPlannedSource,
  insertScenario,
  loadFundingPlans,
  loadPlanExecutions,
  loadPlannedSources,
  loadScenarios,
  savePattern,
  saveFundingPlan,
  saveScenarioTerms,
  setActivePlan,
  updateScenario,
} from "@/db/planning";
import { loadProjects } from "@/db/projects";
import { loadSnapshots } from "@/db/snapshots";
import {
  type Currency,
  type ExchangeRate,
  InvalidMoneyError,
  exchangeRate,
  isCurrency,
  parseMoneyInput,
} from "@/domain/money/money";
import { InvalidAllocationError } from "@/domain/planning/allocations";
import {
  InvalidExecutionError,
  PlanAlreadyExecutedError,
  executionFor,
  previewExecution,
  requireNotExecuted,
} from "@/domain/planning/execution";
import { InvalidPatternError } from "@/domain/planning/patterns";
import {
  type Scenario,
  InvalidFundingPlanError,
  InvalidPlannedSourceError,
  InvalidScenarioError,
  UnknownScenarioError,
  buildScenario,
  planFor,
  proposedFreeLiquid,
  requireScenario,
} from "@/domain/planning/scenarios";
import { UnknownProjectError, requireProject } from "@/domain/projects/projects";
import { freeLiquid } from "@/domain/snapshot/holdings";
import { dateOf, tryParseDateKey } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

/**
 * Writing the לוח תכנון — its own tables, and one deliberate exception.
 *
 * Almost every action here touches only the planning tables: `scenarios`,
 * `funding_plans`, `funding_plan_sources`, `scenario_allocations`,
 * `scenario_patterns` and `scenario_deal_terms`. A scenario reads the מאזן, מיפוי
 * and the projects freely — it is seeded from real figures, measured against the
 * real saving pace, and projected on real Deal Terms — but it has no path back into
 * any of them.
 *
 * The exception is `executePlan`, and it is the point of the whole area: a plan
 * that can never become a project is a plan nobody ever acts on. It writes Funding
 * Legs, through one named function in one file (`@/db/plan-execution`), only after
 * the household has read back exactly which legs it would create. Everything about
 * it is deliberate — `src/domain/planning/writes-nothing-recorded.test.ts` asserts
 * that it is the only one and that no other file in the area acquires the habit.
 *
 * Either Person may write any of it: a what-if about the household's money is not
 * one Person's own naming.
 */

export type PlanningErrorCode =
  | "no-person"
  | "bad-scenario"
  | "duplicate-name"
  | "unknown-scenario"
  | "bad-plan"
  | "bad-source"
  | "duplicate-source"
  | "bad-allocation"
  | "duplicate-allocation"
  | "bad-pattern"
  | "bad-terms"
  | "unknown-project"
  | "already-executed"
  | "bad-execution"
  | "failed";

interface Outcome {
  readonly code: PlanningErrorCode | null;
  readonly detail?: string;
  readonly done?: string;
  /** The scenario screen to land back on; the list when there is none. */
  readonly scenarioId?: string | null;
}

function backTo(outcome: Outcome): never {
  const params = new URLSearchParams();
  if (outcome.code !== null) params.set("error", outcome.code);
  if (outcome.detail !== undefined) params.set("detail", outcome.detail);
  if (outcome.done !== undefined) params.set("done", outcome.done);

  const path =
    outcome.scenarioId === undefined || outcome.scenarioId === null
      ? "/planning"
      : `/planning/${outcome.scenarioId}`;
  const search = params.toString();
  redirect((search.length === 0 ? path : `${path}?${search}`) as Route);
}

/** The unique indexes on a scenario name and on a source name within a scenario. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function failureFor(error: unknown, uniqueCode: PlanningErrorCode): Omit<Outcome, "scenarioId"> {
  if (error instanceof InvalidScenarioError) return { code: "bad-scenario", detail: error.message };
  if (error instanceof UnknownScenarioError) return { code: "unknown-scenario" };
  if (error instanceof UnknownProjectError) return { code: "unknown-project" };
  if (error instanceof InvalidFundingPlanError) return { code: "bad-plan", detail: error.message };
  if (error instanceof InvalidPlannedSourceError) return { code: "bad-source", detail: error.message };
  if (error instanceof InvalidAllocationError) return { code: "bad-allocation", detail: error.message };
  if (error instanceof InvalidPatternError) return { code: "bad-pattern", detail: error.message };
  if (error instanceof PlanAlreadyExecutedError) {
    return { code: "already-executed", detail: error.message };
  }
  if (error instanceof InvalidExecutionError) return { code: "bad-execution", detail: error.message };
  if (error instanceof InvalidMoneyError) return { code: "bad-source", detail: error.message };
  if (isUniqueViolation(error)) return { code: uniqueCode };
  // The execution record's foreign key, which deliberately does not cascade: a
  // scenario that funded a project is not a thought anybody may drop.
  if (isForeignKeyViolation(error)) return { code: "already-executed" };
  return { code: "failed" };
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23503";
}

/**
 * The plan and its lines, frozen once the money has actually moved. Correcting a
 * leg afterwards is the project screen's job, where the leg lives — editing the
 * what-if behind it would leave the two saying different things about the same
 * event.
 */
async function requireStillAWhatIf(scenarioId: string): Promise<void> {
  requireNotExecuted(executionFor(await loadPlanExecutions(), scenarioId));
}

function readText(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}

async function requirePerson(): Promise<void> {
  const email = await requireHouseholdEmail();
  const person = await findPersonByEmail(email);
  if (person === null) {
    backTo({ code: "no-person", detail: email });
  }
}

async function run(
  scenarioId: string | null,
  uniqueCode: PlanningErrorCode,
  work: () => Promise<Outcome>,
): Promise<never> {
  let outcome: Outcome;
  try {
    outcome = await work();
  } catch (error) {
    outcome = { ...failureFor(error, uniqueCode), scenarioId };
  }
  revalidatePath("/planning");
  if (scenarioId !== null) revalidatePath(`/planning/${scenarioId}`);
  // The dashboard measures against the active plan and the projects carry the legs
  // an execution creates, so both can go stale from in here.
  revalidatePath("/");
  revalidatePath("/projects");
  backTo({ scenarioId, ...outcome });
}

function currencyFrom(form: FormData, field: string): Currency {
  const currency = readText(form, field);
  if (!isCurrency(currency)) {
    throw new InvalidFundingPlanError(`מטבע לא מוכר: ${currency}`);
  }
  return currency;
}

async function scenarioFrom(form: FormData): Promise<Scenario> {
  const scenarios = await loadScenarios();
  return requireScenario(scenarios, readText(form, "scenarioId"));
}

// --- the scenario ------------------------------------------------------------

/** What the seeded source is called. The household's own words for it. */
const FREE_LIQUID_SOURCE = "כסף נזיל פנוי";

/**
 * Seed the new scenario from figures the household actually has, so planning never
 * starts from a number somebody typed out of memory.
 *
 * The one figure available today is free liquid money — the נזילות bucket of the
 * latest מיפוי less what is already promised out of it — and it is written as a
 * *seeded* source, stamped with the reading's own date. It stays editable, because a
 * plan is a what-if; what it is not is a figure of unknown vintage.
 *
 * Anything missing is silence: no snapshot, no liquid accounts, a snapshot with no
 * rate for a currency it holds, or free liquid money of nought or less all seed
 * nothing. A scenario with no seeded source is still a scenario.
 */
async function seedFrom(scenarioId: string): Promise<boolean> {
  try {
    const [snapshots, accounts, earmarks] = await Promise.all([
      loadSnapshots(),
      loadAccounts(),
      loadEarmarks(),
    ]);

    // Newest first out of the database: the current position is the latest reading.
    const snapshot = snapshots[0];
    if (snapshot === undefined) return false;

    const free = freeLiquid({ snapshot, accounts, earmarks, currency: "ILS" });
    const proposed = proposedFreeLiquid({
      scenarioId,
      source: FREE_LIQUID_SOURCE,
      free: free.free,
      asOf: snapshot.takenOn,
    });
    if (proposed === null) return false;

    await insertPlannedSource(crypto.randomUUID(), proposed);
    return true;
  } catch {
    // A figure that cannot be read is not seeded. The scenario is created either
    // way — refusing to hold a thought because מיפוי is incomplete would be the
    // planning board refusing to plan.
    return false;
  }
}

export async function createScenario(form: FormData): Promise<void> {
  await requirePerson();

  await run(null, "duplicate-name", async () => {
    const created = await insertScenario(crypto.randomUUID(), {
      name: readText(form, "name"),
      note: readText(form, "note"),
      createdOn: dateOf(new Date()),
    });
    const seeded = await seedFrom(created.id);

    return {
      code: null,
      done: `${seeded ? "created-seeded" : "created"}:${created.name}`,
      scenarioId: created.id,
    };
  });
}

export async function editScenario(form: FormData): Promise<void> {
  await requirePerson();
  const scenarioId = readText(form, "scenarioId");

  await run(scenarioId, "duplicate-name", async () => {
    const existing = await scenarioFrom(form);
    const scenario = buildScenario(existing.id, {
      name: readText(form, "name"),
      note: readText(form, "note"),
      createdOn: existing.createdOn,
      active: existing.active,
    });
    await updateScenario(scenario);
    return { code: null, done: `saved:${scenario.name}` };
  });
}

/** Drop a what-if. Nothing recorded is reachable from here to be taken with it. */
export async function removeScenario(form: FormData): Promise<void> {
  await requirePerson();

  await run(null, "duplicate-name", async () => {
    const scenario = await scenarioFrom(form);
    await requireStillAWhatIf(scenario.id);
    await deleteScenario(scenario.id);
    return { code: null, done: `removed:${scenario.name}`, scenarioId: null };
  });
}

/**
 * Mark the one plan the household is actually following, or unmark it.
 *
 * At most one, held by the database. Marking a second is not an error to report —
 * it is what the household meant, so the first is unmarked and the new one takes
 * its place.
 */
export async function markActivePlan(form: FormData): Promise<void> {
  await requirePerson();
  const scenarioId = readText(form, "scenarioId");

  await run(scenarioId, "duplicate-name", async () => {
    const scenario = await scenarioFrom(form);
    const following = readText(form, "active") === "yes";
    await setActivePlan(following ? scenario.id : null);
    return {
      code: null,
      done: `${following ? "plan-marked" : "plan-unmarked"}:${scenario.name}`,
    };
  });
}

// --- the funding plan --------------------------------------------------------

/** What the future investment needs, and by when. One figure, corrected in place. */
export async function savePlan(form: FormData): Promise<void> {
  await requirePerson();
  const scenarioId = readText(form, "scenarioId");

  await run(scenarioId, "duplicate-name", async () => {
    const scenario = await scenarioFrom(form);
    await requireStillAWhatIf(scenario.id);
    const currency = currencyFrom(form, "currency");
    const needs = parseMoneyInput(readText(form, "needs"), currency);
    if (needs === null) {
      throw new InvalidFundingPlanError("יש להזין את הסכום שההשקעה דורשת");
    }

    await saveFundingPlan({
      scenarioId: scenario.id,
      needs,
      neededBy: tryParseDateKey(readText(form, "neededBy")) ?? dateOf(new Date()),
    });
    return { code: null, done: `plan-saved:${scenario.name}` };
  });
}

// --- the planned sources -----------------------------------------------------

/** A source the household intends to draw on. No rate: none has been paid yet. */
export async function addSource(form: FormData): Promise<void> {
  await requirePerson();
  const scenarioId = readText(form, "scenarioId");

  await run(scenarioId, "duplicate-source", async () => {
    const scenario = await scenarioFrom(form);
    await requireStillAWhatIf(scenario.id);
    const currency = currencyFrom(form, "currency");
    const amount = parseMoneyInput(readText(form, "amount"), currency);
    if (amount === null) {
      throw new InvalidPlannedSourceError("יש להזין סכום למקור");
    }

    const line = await insertPlannedSource(crypto.randomUUID(), {
      scenarioId: scenario.id,
      source: readText(form, "source"),
      amount,
    });
    return { code: null, done: `source-added:${line.source}` };
  });
}

export async function removeSource(form: FormData): Promise<void> {
  await requirePerson();
  const scenarioId = readText(form, "scenarioId");

  await run(scenarioId, "duplicate-source", async () => {
    await requireStillAWhatIf(scenarioId);
    await deletePlannedSource(readText(form, "sourceId"));
    return { code: null, done: "source-removed:" };
  });
}

// --- the saving allocations --------------------------------------------------

/** One goal and what goes into it every month. An intention, so it is typed. */
export async function addAllocation(form: FormData): Promise<void> {
  await requirePerson();
  const scenarioId = readText(form, "scenarioId");

  await run(scenarioId, "duplicate-allocation", async () => {
    const scenario = await scenarioFrom(form);
    const currency = currencyFrom(form, "currency");
    const monthly = parseMoneyInput(readText(form, "monthly"), currency);
    if (monthly === null) {
      throw new InvalidAllocationError("יש להזין כמה נחסך לייעוד הזה בכל חודש");
    }

    const line = await insertAllocation(crypto.randomUUID(), {
      scenarioId: scenario.id,
      goal: readText(form, "goal"),
      monthly,
      // A goal with no finish line is a complete intention, so a blank target is
      // no target rather than a target of nothing.
      target: parseMoneyInput(readText(form, "target"), currency),
    });
    return { code: null, done: `allocation-added:${line.goal}` };
  });
}

export async function removeAllocation(form: FormData): Promise<void> {
  await requirePerson();
  const scenarioId = readText(form, "scenarioId");

  await run(scenarioId, "duplicate-allocation", async () => {
    await deleteAllocation(readText(form, "allocationId"));
    return { code: null, done: "allocation-removed:" };
  });
}

// --- the repeating pattern ---------------------------------------------------

function wholeNumberFrom(form: FormData, field: string, what: string): number {
  const value = Number(readText(form, field).trim());
  if (!Number.isInteger(value)) {
    throw new InvalidPatternError(`${what} הוא מספר שלם`);
  }
  return value;
}

/** "A CGM every year for ten years", written down so it can be followed forward. */
export async function saveInvestmentPattern(form: FormData): Promise<void> {
  await requirePerson();
  const scenarioId = readText(form, "scenarioId");

  await run(scenarioId, "duplicate-name", async () => {
    const scenario = await scenarioFrom(form);
    const currency = currencyFrom(form, "currency");
    const amount = parseMoneyInput(readText(form, "amount"), currency);
    if (amount === null) {
      throw new InvalidPatternError("יש להזין כמה כל השקעה בדפוס דורשת");
    }

    const modelledOn = readText(form, "modelledOn").trim();
    await savePattern({
      scenarioId: scenario.id,
      amount,
      everyMonths: wholeNumberFrom(form, "everyMonths", "המרווח בין השקעות"),
      occurrences: wholeNumberFrom(form, "occurrences", "מספר הפעמים"),
      firstOn: tryParseDateKey(readText(form, "firstOn")) ?? dateOf(new Date()),
      modelledOn: modelledOn.length === 0 ? null : modelledOn,
    });
    return { code: null, done: `pattern-saved:${scenario.name}` };
  });
}

export async function removeInvestmentPattern(form: FormData): Promise<void> {
  await requirePerson();
  const scenarioId = readText(form, "scenarioId");

  await run(scenarioId, "duplicate-name", async () => {
    await deletePattern(scenarioId);
    return { code: null, done: "pattern-removed:" };
  });
}

// --- the deal terms this scenario disagrees with -----------------------------

function optionalWholeNumber(form: FormData, field: string, what: string): number | null {
  const text = readText(form, field).trim();
  if (text.length === 0) return null;
  const value = Number(text);
  if (!Number.isInteger(value)) {
    throw new InvalidPatternError(`${what} הוא מספר שלם`);
  }
  return value;
}

/**
 * What this scenario says instead of what the paperwork says. It writes to the
 * scenario's own table and never to `deal_terms`: stress-testing a promise must not
 * edit the promise.
 */
export async function saveTermsOverride(form: FormData): Promise<void> {
  await requirePerson();
  const scenarioId = readText(form, "scenarioId");

  await run(scenarioId, "duplicate-name", async () => {
    const scenario = await scenarioFrom(form);
    const projectId = readText(form, "projectId").trim();
    requireProject(await loadProjects(), projectId);

    // Stored in whole basis points, the way the recorded terms are: 8.5% is 850.
    const percent = readText(form, "targetReturnPercent").trim();
    const targetReturnBasisPoints =
      percent.length === 0 ? null : Math.round(Number(percent) * 100);
    if (targetReturnBasisPoints !== null && !Number.isFinite(targetReturnBasisPoints)) {
      throw new InvalidPatternError("התשואה נרשמת כאחוז");
    }

    const saved = await saveScenarioTerms({
      scenarioId: scenario.id,
      projectId,
      targetReturnBasisPoints,
      holdMonths: optionalWholeNumber(form, "holdMonths", "תקופת ההחזקה"),
    });
    return { code: null, done: `${saved === null ? "terms-cleared" : "terms-saved"}:` };
  });
}

// --- executing the plan ------------------------------------------------------

function rateFrom(form: FormData): ExchangeRate | null {
  const text = readText(form, "rate").trim();
  if (text.length === 0) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvalidExecutionError("השער חייב להיות מספר חיובי");
  }
  return exchangeRate("USD", "ILS", value);
}

/**
 * The one planning operation that writes something recorded: the plan's lines
 * become the project's Funding Legs, at the rate actually used.
 *
 * Nothing here trusts the form. The preview the household confirmed is rebuilt from
 * the stored plan, the stored sources and the named project, and the domain refuses
 * it again before a single row is written — a confirmation travelled through a
 * query string, and what is written is what the data says, not what the form said.
 */
export async function executePlan(form: FormData): Promise<void> {
  await requirePerson();
  const scenarioId = readText(form, "scenarioId");

  await run(scenarioId, "duplicate-name", async () => {
    const scenario = await scenarioFrom(form);
    const [plans, sources, projects, executions] = await Promise.all([
      loadFundingPlans(),
      loadPlannedSources(),
      loadProjects(),
      loadPlanExecutions(),
    ]);

    const project = requireProject(projects, readText(form, "projectId").trim());
    const preview = previewExecution({
      scenarioId: scenario.id,
      plan: planFor(plans, scenario.id),
      sources,
      project,
      paidOn: tryParseDateKey(readText(form, "paidOn")) ?? dateOf(new Date()),
      rate: rateFrom(form),
      executed: executionFor(executions, scenario.id),
    });

    const outcome = await executeFundingPlan(preview);
    return { code: null, done: `executed:${project.name} (${outcome.legIds.length})` };
  });
}
