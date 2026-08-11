"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { findPersonByEmail } from "@/db/people";
import {
  deleteFundingLeg,
  deleteProjectExpense,
  insertFundingLeg,
  insertProject,
  insertProjectExpense,
  loadFundingLegs,
  loadProjectExpenses,
  loadProjects,
  saveDealTerms,
  updateProject,
} from "@/db/projects";
import {
  type Currency,
  type ExchangeRate,
  InvalidMoneyError,
  exchangeRate,
  format,
  isCurrency,
  parseMoneyInput,
} from "@/domain/money/money";
import {
  type Project,
  FundingLegRequiredError,
  InvalidDealTermsError,
  InvalidFundingLegError,
  InvalidProjectError,
  InvalidProjectExpenseError,
  PotOverdrawnError,
  UnknownProjectError,
  buildProject,
  requireLegRemovable,
  requireProject,
  requireWithinPot,
} from "@/domain/projects/projects";
import { dateOf, tryParseDateKey } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

/**
 * Writing the closed pot. Two rules run through everything here:
 *
 * **Money goes in as a Funding Leg and comes out as an expense.** There is no
 * action that adjusts a total, because there is no total: `יתרה` is computed on
 * read from the rows below it.
 *
 * **An expense the pot cannot pay for is refused.** The domain does the refusing —
 * `requireWithinPot` runs before the insert, so the overdrawn state never exists,
 * not even for the length of a transaction.
 *
 * Either Person may record any of it: a project is a fact about the household's
 * money, not one Person's own naming.
 */

export type ProjectsErrorCode =
  | "no-person"
  | "bad-project"
  | "duplicate-name"
  | "unknown-project"
  | "bad-leg"
  | "bad-expense"
  | "bad-rate"
  | "overdrawn"
  | "leg-required"
  | "bad-terms"
  | "failed";

interface Outcome {
  readonly code: ProjectsErrorCode | null;
  readonly detail?: string;
  readonly done?: string;
  /** The project screen to land back on; the list when there is none. */
  readonly projectId?: string | null;
}

function backTo(outcome: Outcome): never {
  const params = new URLSearchParams();
  if (outcome.code !== null) params.set("error", outcome.code);
  if (outcome.detail !== undefined) params.set("detail", outcome.detail);
  if (outcome.done !== undefined) params.set("done", outcome.done);

  const path =
    outcome.projectId === undefined || outcome.projectId === null
      ? "/projects"
      : `/projects/${outcome.projectId}`;
  const search = params.toString();
  redirect((search.length === 0 ? path : `${path}?${search}`) as Route);
}

/** The unique index on the project name is the one clash the form cannot pre-empt. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function failureFor(error: unknown): Omit<Outcome, "projectId"> {
  if (error instanceof PotOverdrawnError) {
    // The one failure a person will meet in ordinary use, so it says the figures
    // in the language the screen is in rather than the domain's own words.
    return {
      code: "overdrawn",
      detail:
        `בפוט יש ${format(error.balance)}, וההוצאה מבקשת ${format(error.attempted)} — ` +
        `חסרים ${format(error.shortfall)}.`,
    };
  }
  if (error instanceof FundingLegRequiredError) {
    return { code: "leg-required", detail: `בלעדיה יחסרו בפוט ${format(error.shortfall)}.` };
  }
  if (error instanceof InvalidProjectError) return { code: "bad-project", detail: error.message };
  if (error instanceof UnknownProjectError) return { code: "unknown-project" };
  if (error instanceof InvalidFundingLegError) return { code: "bad-leg", detail: error.message };
  if (error instanceof InvalidProjectExpenseError) return { code: "bad-expense", detail: error.message };
  if (error instanceof InvalidDealTermsError) return { code: "bad-terms", detail: error.message };
  if (error instanceof InvalidMoneyError) return { code: "bad-rate", detail: error.message };
  if (isUniqueViolation(error)) return { code: "duplicate-name" };
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

async function run(projectId: string | null, work: () => Promise<Outcome>): Promise<never> {
  let outcome: Outcome;
  try {
    outcome = await work();
  } catch (error) {
    outcome = { ...failureFor(error), projectId };
  }
  revalidatePath("/projects");
  if (projectId !== null) revalidatePath(`/projects/${projectId}`);
  backTo({ projectId, ...outcome });
}

// --- reading the form --------------------------------------------------------

function currencyFrom(form: FormData, field: string): Currency {
  const currency = readText(form, field);
  if (!isCurrency(currency)) {
    throw new InvalidProjectError(`מטבע לא מוכר: ${currency}`);
  }
  return currency;
}

/**
 * The rate as it was actually used, quoted USD/ILS. Blank is `null` — which the
 * domain reads as "nothing was converted" and refuses where something was.
 */
function rateFrom(form: FormData, field: string): ExchangeRate | null {
  const text = readText(form, field).trim().replace(/[,\s]/g, "");
  if (text.length === 0) return null;

  const rate = Number(text);
  if (!Number.isFinite(rate)) {
    throw new InvalidMoneyError(`שער לא תקין: ${readText(form, field)}`);
  }
  return exchangeRate("USD", "ILS", rate);
}

/** A project resolved from the form, so every action below writes against a real pot. */
async function projectFrom(form: FormData): Promise<Project> {
  const projects = await loadProjects();
  return requireProject(projects, readText(form, "projectId"));
}

/**
 * The project and the rows the pot is made of. Every project is loaded, not only
 * this one: a leg is read against the pot it fills, so the whole set has to be
 * present for any of them to resolve.
 */
async function potFrom(form: FormData) {
  const projects = await loadProjects();
  const project = requireProject(projects, readText(form, "projectId"));
  const [legs, expenses] = await Promise.all([
    loadFundingLegs(projects),
    loadProjectExpenses(projects),
  ]);
  return { project, legs, expenses };
}

// --- the project -------------------------------------------------------------

export async function createProject(form: FormData): Promise<void> {
  await requirePerson();

  await run(null, async () => {
    const created = await insertProject(crypto.randomUUID(), {
      name: readText(form, "name"),
      currency: currencyFrom(form, "currency"),
      accountId: readText(form, "accountId"),
      startedOn: tryParseDateKey(readText(form, "startedOn")) ?? dateOf(new Date()),
    });
    return { code: null, done: `created:${created.name}`, projectId: created.id };
  });
}

/**
 * Correct a definition. The currency is not among the fields: it is what the pot
 * *is*, and changing it would re-denominate every leg and expense already in it.
 */
export async function editProject(form: FormData): Promise<void> {
  await requirePerson();
  const projectId = readText(form, "projectId");

  await run(projectId, async () => {
    const existing = await projectFrom(form);
    const project = buildProject(existing.id, {
      name: readText(form, "name"),
      currency: existing.currency,
      accountId: readText(form, "accountId"),
      startedOn: tryParseDateKey(readText(form, "startedOn")) ?? existing.startedOn,
    });
    await updateProject(project);
    return { code: null, done: `saved:${project.name}` };
  });
}

// --- funding legs ------------------------------------------------------------

/** Money going in. The only way it does. */
export async function addFundingLeg(form: FormData): Promise<void> {
  await requirePerson();
  const projectId = readText(form, "projectId");

  await run(projectId, async () => {
    const project = await projectFrom(form);
    const currency = currencyFrom(form, "currency");
    const amount = parseMoneyInput(readText(form, "amount"), currency);
    if (amount === null) {
      throw new InvalidFundingLegError("יש להזין סכום לרגל המימון");
    }

    const leg = await insertFundingLeg(
      crypto.randomUUID(),
      {
        projectId: project.id,
        source: readText(form, "source"),
        amount,
        rate: rateFrom(form, "rate"),
        paidOn: tryParseDateKey(readText(form, "paidOn")) ?? dateOf(new Date()),
      },
      project,
    );
    return { code: null, done: `leg-added:${leg.source}` };
  });
}

/**
 * Take a leg back out. Correcting a mistyped row, never withdrawing money — so it
 * is refused whenever the pot could not have paid for what it has already spent
 * without it.
 */
export async function removeFundingLeg(form: FormData): Promise<void> {
  await requirePerson();
  const projectId = readText(form, "projectId");

  await run(projectId, async () => {
    const { project, legs, expenses } = await potFrom(form);

    const legId = readText(form, "legId");
    requireLegRemovable({ project, legs, expenses, legId });
    await deleteFundingLeg(legId);
    return { code: null, done: "leg-removed:" };
  });
}

// --- the expense ledger ------------------------------------------------------

/**
 * Money coming out. Checked against the pot before it is written, so the state
 * where more has been spent than was ever put in never exists.
 */
export async function addExpense(form: FormData): Promise<void> {
  await requirePerson();
  const projectId = readText(form, "projectId");

  await run(projectId, async () => {
    const { project, legs, expenses } = await potFrom(form);
    const currency = currencyFrom(form, "currency");
    const amount = parseMoneyInput(readText(form, "amount"), currency);
    if (amount === null) {
      throw new InvalidProjectExpenseError("יש להזין סכום להוצאה");
    }
    const rate = rateFrom(form, "rate");

    requireWithinPot({ project, legs, expenses, candidate: { amount, rate } });

    const expense = await insertProjectExpense(
      crypto.randomUUID(),
      {
        projectId: project.id,
        description: readText(form, "description"),
        amount,
        rate,
        paidOn: tryParseDateKey(readText(form, "paidOn")) ?? dateOf(new Date()),
      },
      project,
    );
    return { code: null, done: `expense-added:${expense.description}` };
  });
}

/** Remove an expense. Always safe: taking one out can only leave the pot fuller. */
export async function removeExpense(form: FormData): Promise<void> {
  await requirePerson();
  const projectId = readText(form, "projectId");

  await run(projectId, async () => {
    await deleteProjectExpense(readText(form, "expenseId"));
    return { code: null, done: "expense-removed:" };
  });
}

// --- deal terms --------------------------------------------------------------

function wholeNumberFrom(form: FormData, field: string): number | null {
  const text = readText(form, field).trim().replace(/[,\s]/g, "");
  if (text.length === 0) return null;

  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new InvalidDealTermsError(`ערך לא תקין: ${readText(form, field)}`);
  }
  return value;
}

/**
 * What the sponsor's paperwork stated, entered by hand. A promise and not a
 * measurement: nothing here is derived from anything, and nothing else reads it
 * as a fact.
 */
export async function saveTerms(form: FormData): Promise<void> {
  await requirePerson();
  const projectId = readText(form, "projectId");

  await run(projectId, async () => {
    const project = await projectFrom(form);
    const percent = wholeNumberFrom(form, "targetReturnPercent");

    await saveDealTerms({
      projectId: project.id,
      // Entered as a percentage and stored in whole basis points, the way every
      // other rate in the system is. 18.25% is 1,825 and not a float near it.
      targetReturnBasisPoints: percent === null ? null : Math.round(percent * 100),
      holdMonths: wholeNumberFrom(form, "holdMonths"),
      distribution: readText(form, "distribution"),
      source: readText(form, "source"),
      recordedOn: tryParseDateKey(readText(form, "recordedOn")) ?? dateOf(new Date()),
    });
    return { code: null, done: `terms-saved:${project.name}` };
  });
}
