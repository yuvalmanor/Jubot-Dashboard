"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { loadAccounts } from "@/db/accounts";
import { loadEarmarks } from "@/db/holdings";
import { findPersonByEmail } from "@/db/people";
import {
  deletePlannedSource,
  deleteScenario,
  insertPlannedSource,
  insertScenario,
  loadScenarios,
  saveFundingPlan,
  updateScenario,
} from "@/db/planning";
import { loadSnapshots } from "@/db/snapshots";
import { type Currency, InvalidMoneyError, isCurrency, parseMoneyInput } from "@/domain/money/money";
import {
  type Scenario,
  InvalidFundingPlanError,
  InvalidPlannedSourceError,
  InvalidScenarioError,
  UnknownScenarioError,
  buildScenario,
  proposedFreeLiquid,
  requireScenario,
} from "@/domain/planning/scenarios";
import { freeLiquid } from "@/domain/snapshot/holdings";
import { dateOf, tryParseDateKey } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

/**
 * Writing the לוח תכנון — and nothing else.
 *
 * Every action here touches exactly three tables: `scenarios`, `funding_plans` and
 * `funding_plan_sources`. A scenario reads the מאזן and מיפוי freely, so it can be
 * seeded from real figures and measured against the real saving pace, but it has no
 * path back into them: no writer from another area is imported, and
 * `src/domain/planning/writes-nothing-recorded.test.ts` is the guard on that.
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
  if (error instanceof InvalidFundingPlanError) return { code: "bad-plan", detail: error.message };
  if (error instanceof InvalidPlannedSourceError) return { code: "bad-source", detail: error.message };
  if (error instanceof InvalidMoneyError) return { code: "bad-source", detail: error.message };
  if (isUniqueViolation(error)) return { code: uniqueCode };
  return { code: "failed" };
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
    await deleteScenario(scenario.id);
    return { code: null, done: `removed:${scenario.name}`, scenarioId: null };
  });
}

// --- the funding plan --------------------------------------------------------

/** What the future investment needs, and by when. One figure, corrected in place. */
export async function savePlan(form: FormData): Promise<void> {
  await requirePerson();
  const scenarioId = readText(form, "scenarioId");

  await run(scenarioId, "duplicate-name", async () => {
    const scenario = await scenarioFrom(form);
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
    await deletePlannedSource(readText(form, "sourceId"));
    return { code: null, done: "source-removed:" };
  });
}
