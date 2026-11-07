"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { findPersonByEmail } from "@/db/people";
import {
  deleteFundingLeg,
  deleteProjectDistribution,
  deleteProjectExpense,
  deleteProjectValuation,
  insertFundingLeg,
  insertProject,
  insertProjectDistribution,
  insertProjectExpense,
  insertProjectValuation,
  loadFundingLegs,
  loadProjectDistributions,
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
  type DistributionDestination,
  type Project,
  DistributionRequiredError,
  FundingLegRequiredError,
  InvalidDealTermsError,
  InvalidFundingLegError,
  InvalidProjectDistributionError,
  InvalidProjectError,
  InvalidProjectExpenseError,
  InvalidProjectValuationError,
  PotOverdrawnError,
  UnknownProjectError,
  buildProject,
  isValuationBasis,
  rateProblemOf,
  requireDistributionRemovable,
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
  | "bad-distribution"
  | "distribution-required"
  | "bad-valuation"
  | "rate-unwanted"
  | "rate-missing"
  | "rate-wrong-pair"
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

const RATE_CODES = {
  unwanted: "rate-unwanted",
  missing: "rate-missing",
  "wrong-pair": "rate-wrong-pair",
} as const;

function failureFor(error: unknown): Omit<Outcome, "projectId"> {
  // Ahead of everything else: a rate against the wrong currency is the failure a
  // person meets in ordinary use, and the domain says it in English.
  const rateProblem = rateProblemOf(error);
  if (rateProblem !== null) return { code: RATE_CODES[rateProblem] };

  if (error instanceof PotOverdrawnError) {
    // The one failure a person will meet in ordinary use, so it says the figures
    // in the language the screen is in rather than the domain's own words.
    return {
      code: "overdrawn",
      detail:
        `בקופה יש ${format(error.balance)}, וההוצאה מבקשת ${format(error.attempted)} — ` +
        `חסרים ${format(error.shortfall)}.`,
    };
  }
  if (error instanceof FundingLegRequiredError) {
    return { code: "leg-required", detail: `בלעדיה יחסרו בקופה ${format(error.shortfall)}.` };
  }
  if (error instanceof DistributionRequiredError) {
    return { code: "distribution-required", detail: `בלעדיה יחסרו בקופה ${format(error.shortfall)}.` };
  }
  if (error instanceof InvalidProjectDistributionError) {
    return { code: "bad-distribution", detail: error.message };
  }
  if (error instanceof InvalidProjectValuationError) {
    return { code: "bad-valuation", detail: error.message };
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
  const [legs, expenses, distributions] = await Promise.all([
    loadFundingLegs(projects),
    loadProjectExpenses(projects),
    loadProjectDistributions(projects),
  ]);
  return { project, legs, expenses, distributions };
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

// --- one row, whichever of the three it is -----------------------------------

/**
 * What the one entry row asked for. The destination travels inside the kind
 * rather than beside it — `distribution:out:<accountId>` — because "a חלוקה" is
 * not a complete answer: where it went decides whether the balance moves, and a
 * separate field for it would sit dead on the screen two choices out of three.
 */
type Chosen =
  | { kind: "leg" }
  | { kind: "expense" }
  | { kind: "distribution"; destination: DistributionDestination };

function chosenFrom(form: FormData): Chosen {
  const value = readText(form, "kind");
  if (value === "leg") return { kind: "leg" };
  if (value === "expense") return { kind: "expense" };
  if (value === "distribution:rolled") {
    return { kind: "distribution", destination: { kind: "rolled" } };
  }

  const accountId = value.startsWith("distribution:out:")
    ? value.slice("distribution:out:".length)
    : "";
  if (accountId !== "") {
    return { kind: "distribution", destination: { kind: "out", accountId } };
  }
  throw new InvalidProjectError(`סוג תנועה לא מוכר: ${value}`);
}

/**
 * Record one movement: a Funding Leg, an expense, or a distribution.
 *
 * One action because the screen has one entry row, and the three are the same
 * four facts — what it was, how much, in which currency, at which rate — pointing
 * in different directions. Nothing about the three rules is merged with it: an
 * expense is still checked against the pot before it is written, a leg is still
 * the only way money enters from outside, and a distribution still writes nothing
 * into the Account it names.
 */
export async function addMovement(form: FormData): Promise<void> {
  await requirePerson();
  const projectId = readText(form, "projectId");

  await run(projectId, async () => {
    const chosen = chosenFrom(form);
    const { project, legs, expenses, distributions } = await potFrom(form);
    const currency = currencyFrom(form, "currency");
    const amount = parseMoneyInput(readText(form, "amount"), currency);
    const rate = rateFrom(form, "rate");
    const description = readText(form, "description");
    const paidOn = tryParseDateKey(readText(form, "paidOn")) ?? dateOf(new Date());

    if (chosen.kind === "leg") {
      if (amount === null) throw new InvalidFundingLegError("יש להזין סכום לרגל המימון");
      const leg = await insertFundingLeg(
        crypto.randomUUID(),
        { projectId: project.id, source: description, amount, rate, paidOn },
        project,
      );
      return { code: null, done: `leg-added:${leg.source}` };
    }

    if (chosen.kind === "expense") {
      if (amount === null) throw new InvalidProjectExpenseError("יש להזין סכום להוצאה");
      // Before the insert, so the overdrawn state never exists — not even for the
      // length of a transaction.
      requireWithinPot({ project, legs, expenses, distributions, candidate: { amount, rate } });
      const expense = await insertProjectExpense(
        crypto.randomUUID(),
        { projectId: project.id, description, amount, rate, paidOn },
        project,
      );
      return { code: null, done: `expense-added:${expense.description}` };
    }

    if (amount === null) throw new InvalidProjectDistributionError("יש להזין סכום לחלוקה");
    // No pot check: a distribution never takes money out of the balance. One that
    // went out never entered it, and one that was rolled only adds. Nothing is
    // written to the Account it names either — a Snapshot is taken by hand, and
    // one form writing a figure into two places is the double count the
    // destination is recorded to make visible.
    const distribution = await insertProjectDistribution(
      crypto.randomUUID(),
      {
        projectId: project.id,
        description,
        amount,
        rate,
        destination: chosen.destination,
        paidOn,
      },
      project,
    );
    return { code: null, done: `distribution-added:${distribution.description}` };
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
    const { project, legs, expenses, distributions } = await potFrom(form);

    const legId = readText(form, "legId");
    requireLegRemovable({ project, legs, expenses, distributions, legId });
    await deleteFundingLeg(legId);
    return { code: null, done: "leg-removed:" };
  });
}

// --- the expense ledger ------------------------------------------------------

/** Remove an expense. Always safe: taking one out can only leave the pot fuller. */
export async function removeExpense(form: FormData): Promise<void> {
  await requirePerson();
  const projectId = readText(form, "projectId");

  await run(projectId, async () => {
    await deleteProjectExpense(readText(form, "expenseId"));
    return { code: null, done: "expense-removed:" };
  });
}

// --- distributions -----------------------------------------------------------

/**
 * Take a distribution back out. Unlike an expense this is not always safe: a
 * rolled one made room in the balance, and removing it is refused whenever the
 * pot could not have paid for what it has since spent without it.
 */
export async function removeDistribution(form: FormData): Promise<void> {
  await requirePerson();
  const projectId = readText(form, "projectId");

  await run(projectId, async () => {
    const { project, legs, expenses, distributions } = await potFrom(form);

    const distributionId = readText(form, "distributionId");
    requireDistributionRemovable({ project, legs, expenses, distributions, distributionId });
    await deleteProjectDistribution(distributionId);
    return { code: null, done: "distribution-removed:" };
  });
}

// --- valuations --------------------------------------------------------------

/**
 * Record what somebody said this project is worth.
 *
 * One figure, one date, one basis, one source. Nothing is converted, so there is
 * no rate field: a valuation states what the pot is worth and the pot has one
 * currency. Per ADR 0005 מיפוי reads the latest of these, which is why a blank
 * source is refused rather than stored — the figure moves other screens, and the
 * safeguard on that is being able to ask who said so.
 */
export async function addValuation(form: FormData): Promise<void> {
  await requirePerson();
  const projectId = readText(form, "projectId");

  await run(projectId, async () => {
    const project = await projectFrom(form);
    const amount = parseMoneyInput(readText(form, "amount"), project.currency);
    if (amount === null) {
      throw new InvalidProjectValuationError("יש להזין את השווי שנקבע");
    }

    const basis = readText(form, "basis");
    if (!isValuationBasis(basis)) {
      throw new InvalidProjectValuationError(`בסיס שווי לא מוכר: ${basis}`);
    }

    const valuation = await insertProjectValuation(
      crypto.randomUUID(),
      {
        projectId: project.id,
        amount,
        basis,
        source: readText(form, "source"),
        statedOn: tryParseDateKey(readText(form, "statedOn")) ?? dateOf(new Date()),
      },
      project,
    );
    return { code: null, done: `valuation-added:${format(valuation.amount)}` };
  });
}

/**
 * Remove a valuation. Always safe: the project falls back to the one stated
 * before it, or to its cost when that was the only one.
 */
export async function removeValuation(form: FormData): Promise<void> {
  await requirePerson();
  const projectId = readText(form, "projectId");

  await run(projectId, async () => {
    await deleteProjectValuation(readText(form, "valuationId"));
    return { code: null, done: "valuation-removed:" };
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
