/**
 * Projects (נכסים ופרוייקטים) — the closed pot.
 *
 * Framework-free per ADR 0004.
 *
 * A Project is a closed pot of capital with a name and a purpose — CGM 1, CGM 2,
 * Meteor. Three rules give it its shape, and each one exists because the
 * spreadsheet did without it:
 *
 * **Funding Legs fill it; nothing else does.** A leg records one source in the
 * currency it was actually paid in — CGM 1 was funded by 109,800₪ and by $69,000
 * of Apple RSU. Putting more money in is adding a leg, so the pot can never be
 * silently topped up: every shekel that went in is a row with a source on it.
 *
 * **Expenses are drawn out of it.** `יתרה = Σ(legs) − Σ(expenses)`, computed on
 * read and with nowhere to write it, so the invariant cannot be broken by any
 * sequence of operations. An expense that would take the pot below nothing is
 * refused rather than allowed to overdraw a closed pot.
 *
 * **A rate is recorded where a conversion happened, and nowhere else.** A leg paid
 * in the pot's own currency converted nothing, so it carries no rate — a rate
 * beside it would be a number nobody used. A leg paid in the other currency
 * carries the rate that was actually used, so the pot's cost is what it cost on
 * the day and does not move when today's rate does.
 *
 * From those, the effective rate: what the household actually paid, per unit,
 * across every conversion this project took. It is derived from the recorded
 * amounts rather than averaged out of the rate fields, so shekels ÷ dollars gives
 * back the shekels — and it is shown against today's rate, which is the whole of
 * "did we convert well".
 *
 * Per ADR 0003 nothing here re-values anything. A project's value in מיפוי is its
 * total cost and stays there as its expense ledger is spent down: converting cash
 * into property moves money inside the pot, and the pot cost what it cost.
 */

import {
  type Currency,
  type ExchangeRate,
  type Money,
  add,
  convert,
  convertBack,
  isNegative,
  subtract,
  sum,
  zero,
} from "@/domain/money/money";
import { type CalendarDate, compareDates } from "@/domain/time/calendar-date";

// --- the project -------------------------------------------------------------

export interface Project {
  readonly id: string;
  /** The household's own naming — `CGM 1`, `Meteor 6`. Left as written. */
  readonly name: string;
  /** What the pot is denominated in. A pot has one size, so it has one currency. */
  readonly currency: Currency;
  /**
   * The מיפוי account that carries this project's value, or `null` while nobody
   * has said which. Naming it is what lets the cost below be read against what the
   * snapshot actually records.
   */
  readonly accountId: string | null;
  readonly startedOn: CalendarDate;
}

export class InvalidProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectError";
  }
}

export class UnknownProjectError extends Error {
  constructor(readonly projectId: string) {
    super(`No such project: ${projectId}`);
    this.name = "UnknownProjectError";
  }
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function requireText(value: string, what: string, limit: number, fail: (message: string) => Error): string {
  const normalised = normalise(value);
  if (normalised.length === 0) throw fail(`${what} cannot be empty`);
  if (normalised.length > limit) {
    throw fail(`${what} cannot exceed ${limit} characters, received ${normalised.length}`);
  }
  return normalised;
}

function optionalText(value: string | null | undefined, what: string, limit: number, fail: (message: string) => Error): string | null {
  const normalised = normalise(value ?? "");
  if (normalised.length === 0) return null;
  if (normalised.length > limit) {
    throw fail(`${what} cannot exceed ${limit} characters, received ${normalised.length}`);
  }
  return normalised;
}

export interface ProjectDefinition {
  readonly name: string;
  readonly currency: Currency;
  readonly accountId?: string | null;
  readonly startedOn: CalendarDate;
}

export function buildProject(id: string, definition: ProjectDefinition): Project {
  const accountId = normalise(definition.accountId ?? "");
  return {
    id,
    name: requireText(definition.name, "A project name", 60, (message) => new InvalidProjectError(message)),
    currency: definition.currency,
    accountId: accountId.length === 0 ? null : accountId,
    startedOn: definition.startedOn,
  };
}

export function findProject(projects: readonly Project[], id: string): Project | undefined {
  return projects.find((project) => project.id === id);
}

export function requireProject(projects: readonly Project[], id: string): Project {
  const project = findProject(projects, id);
  if (project === undefined) {
    throw new UnknownProjectError(id);
  }
  return project;
}

/** Projects in reading order — oldest first, so the list reads as the household built it. */
export function projectsInReadingOrder(projects: readonly Project[]): readonly Project[] {
  return [...projects].sort(
    (left, right) =>
      compareDates(left.startedOn, right.startedOn) ||
      left.name.localeCompare(right.name, "he") ||
      left.id.localeCompare(right.id),
  );
}

// --- money moving in and out -------------------------------------------------

/**
 * One movement of money into or out of a pot, in the currency it was actually
 * paid in, with the rate that was actually used to bring it into the pot's
 * currency.
 *
 * `rate` is `null` exactly when the movement needed no conversion. That is not a
 * missing field: a rate recorded beside money that never changed currency is a
 * number nobody used, and a number nobody used has no business inside the average
 * that answers "what did we pay per dollar".
 */
export interface PotMovement {
  readonly amount: Money;
  readonly rate: ExchangeRate | null;
}

function convertAt(amount: Money, rate: ExchangeRate | null, to: Currency, fail: (message: string) => Error): Money {
  if (amount.currency === to) return amount;
  if (rate === null) {
    throw fail(`A ${amount.currency} amount in a ${to} pot needs the rate that was used to convert it`);
  }
  if (rate.from === amount.currency && rate.to === to) return convert(amount, rate);
  if (rate.from === to && rate.to === amount.currency) return convertBack(amount, rate);
  throw fail(
    `The rate quoted ${rate.from}/${rate.to} does not convert ${amount.currency} into ${to}`,
  );
}

/**
 * Validate the rate against the movement it belongs to. Required where a
 * conversion happened, refused where none did, and always naming the pair it
 * applies to — a rate that does not say which two currencies it is between is how
 * a figure ends up converted by the wrong number.
 */
function rateFor(
  amount: Money,
  potCurrency: Currency,
  rate: ExchangeRate | null | undefined,
  fail: (message: string) => Error,
): ExchangeRate | null {
  const supplied = rate ?? null;

  if (amount.currency === potCurrency) {
    if (supplied !== null) {
      throw fail(
        `This ${amount.currency} amount went into a ${potCurrency} pot, so nothing was converted; ` +
          "a rate recorded beside it would be a number nobody used",
      );
    }
    return null;
  }

  if (supplied === null) {
    throw fail(`A ${amount.currency} amount in a ${potCurrency} pot must record the rate that was used`);
  }
  const names =
    (supplied.from === amount.currency && supplied.to === potCurrency) ||
    (supplied.from === potCurrency && supplied.to === amount.currency);
  if (!names) {
    throw fail(
      `The rate quoted ${supplied.from}/${supplied.to} does not convert ${amount.currency} into ${potCurrency}`,
    );
  }
  return supplied;
}

function requirePositive(amount: Money, what: string, fail: (message: string) => Error): Money {
  if (amount.minorUnits <= 0) {
    throw fail(`${what} is an amount greater than zero, or it is nothing at all`);
  }
  return amount;
}

// --- funding legs ------------------------------------------------------------

/**
 * One source that funded a project, in the currency it was actually paid in. The
 * pot's cost is the sum of its legs, so adding money to a project is adding a leg
 * and never editing a total.
 */
export interface FundingLeg extends PotMovement {
  readonly id: string;
  readonly projectId: string;
  /** Where it came from — `Apple RSU`, `עו"ש דיסקונט`. The household's own words. */
  readonly source: string;
  readonly paidOn: CalendarDate;
}

export class InvalidFundingLegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFundingLegError";
  }
}

export interface FundingLegDefinition {
  readonly projectId: string;
  readonly source: string;
  readonly amount: Money;
  readonly rate?: ExchangeRate | null;
  readonly paidOn: CalendarDate;
}

const legFailure = (message: string) => new InvalidFundingLegError(message);

export function buildFundingLeg(id: string, definition: FundingLegDefinition, project: Project): FundingLeg {
  if (definition.projectId !== project.id) {
    throw legFailure(`This leg belongs to project ${definition.projectId}, not to ${project.id}`);
  }

  const amount = requirePositive(definition.amount, "A funding leg", legFailure);
  return {
    id,
    projectId: project.id,
    source: requireText(definition.source, "A funding source", 60, legFailure),
    amount,
    rate: rateFor(amount, project.currency, definition.rate, legFailure),
    paidOn: definition.paidOn,
  };
}

/** This leg, read in the pot's own currency at the rate it was actually converted at. */
export function legInPotCurrency(leg: FundingLeg, project: Project): Money {
  return convertAt(leg.amount, leg.rate, project.currency, legFailure);
}

/** One project's legs, oldest first — the order the money went in. */
export function legsOf(legs: readonly FundingLeg[], projectId: string): readonly FundingLeg[] {
  return legs
    .filter((leg) => leg.projectId === projectId)
    .sort(
      (left, right) =>
        compareDates(left.paidOn, right.paidOn) ||
        left.source.localeCompare(right.source, "he") ||
        left.id.localeCompare(right.id),
    );
}

// --- the expense ledger ------------------------------------------------------

/**
 * What the project spent, and on what. An expense is always paid *out of* the pot
 * — there is no shape in which recording one adds to the money available.
 */
export interface ProjectExpense extends PotMovement {
  readonly id: string;
  readonly projectId: string;
  /** What it was spent on. The running ledger is unreadable without it. */
  readonly description: string;
  readonly paidOn: CalendarDate;
}

export class InvalidProjectExpenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectExpenseError";
  }
}

export interface ProjectExpenseDefinition {
  readonly projectId: string;
  readonly description: string;
  readonly amount: Money;
  readonly rate?: ExchangeRate | null;
  readonly paidOn: CalendarDate;
}

const expenseFailure = (message: string) => new InvalidProjectExpenseError(message);

export function buildProjectExpense(
  id: string,
  definition: ProjectExpenseDefinition,
  project: Project,
): ProjectExpense {
  if (definition.projectId !== project.id) {
    throw expenseFailure(`This expense belongs to project ${definition.projectId}, not to ${project.id}`);
  }

  const amount = requirePositive(definition.amount, "A project expense", expenseFailure);
  return {
    id,
    projectId: project.id,
    description: requireText(definition.description, "An expense description", 120, expenseFailure),
    amount,
    rate: rateFor(amount, project.currency, definition.rate, expenseFailure),
    paidOn: definition.paidOn,
  };
}

export function expenseInPotCurrency(expense: ProjectExpense, project: Project): Money {
  return convertAt(expense.amount, expense.rate, project.currency, expenseFailure);
}

/** One project's expenses, oldest first — the running ledger. */
export function expensesOf(
  expenses: readonly ProjectExpense[],
  projectId: string,
): readonly ProjectExpense[] {
  return expenses
    .filter((expense) => expense.projectId === projectId)
    .sort(
      (left, right) =>
        compareDates(left.paidOn, right.paidOn) ||
        left.description.localeCompare(right.description, "he") ||
        left.id.localeCompare(right.id),
    );
}

// --- the pot -----------------------------------------------------------------

/**
 * The pot, read whole. `balance` is the יתרה and is computed here on every read;
 * nothing stores it, so no sequence of legs and expenses can leave it disagreeing
 * with the rows it is made of.
 */
export interface Pot {
  readonly currency: Currency;
  /** Σ(funding legs), in the pot's currency. What the project cost. */
  readonly funded: Money;
  /** Σ(expenses), in the pot's currency. What has been deployed out of it. */
  readonly spent: Money;
  /** `funded − spent` — the יתרה, the capital still undeployed. */
  readonly balance: Money;
  readonly legCount: number;
  readonly expenseCount: number;
}

export function potOf(
  project: Project,
  legs: readonly FundingLeg[],
  expenses: readonly ProjectExpense[],
): Pot {
  const own = legsOf(legs, project.id);
  const drawn = expensesOf(expenses, project.id);

  const funded = sum(
    own.map((leg) => legInPotCurrency(leg, project)),
    project.currency,
  );
  const spent = sum(
    drawn.map((expense) => expenseInPotCurrency(expense, project)),
    project.currency,
  );

  return {
    currency: project.currency,
    funded,
    spent,
    balance: subtract(funded, spent),
    legCount: own.length,
    expenseCount: drawn.length,
  };
}

/**
 * An expense the pot cannot pay for. Refused rather than recorded: a closed pot
 * that goes negative is not a closed pot, and the way to make room is to record
 * where the extra money came from — which is a Funding Leg.
 */
export class PotOverdrawnError extends Error {
  constructor(
    readonly projectId: string,
    readonly balance: Money,
    readonly attempted: Money,
    readonly shortfall: Money,
  ) {
    super(
      `Project ${projectId} holds ${balance.minorUnits} minor units and the expense claims ` +
        `${attempted.minorUnits}, which is ${shortfall.minorUnits} more than the pot has; ` +
        "putting more money in is a funding leg, not a larger expense",
    );
    this.name = "PotOverdrawnError";
  }
}

/**
 * Whether one more expense fits. The candidate is read in the pot's currency at
 * its own rate first, because an expense paid in dollars against a shekel pot is
 * only comparable once converted the way it was actually converted.
 */
export function requireWithinPot(input: {
  readonly project: Project;
  readonly legs: readonly FundingLeg[];
  readonly expenses: readonly ProjectExpense[];
  readonly candidate: PotMovement;
}): void {
  const { project, candidate } = input;
  const pot = potOf(project, input.legs, input.expenses);
  const amount = convertAt(candidate.amount, candidate.rate, project.currency, expenseFailure);
  const remaining = subtract(pot.balance, amount);

  if (isNegative(remaining)) {
    throw new PotOverdrawnError(project.id, pot.balance, amount, subtract(amount, pot.balance));
  }
}

/**
 * A leg the pot has already spent against. Removing it would leave more spent
 * than was ever put in, which is the same broken state as an overdrawing expense
 * reached from the other side.
 */
export class FundingLegRequiredError extends Error {
  constructor(
    readonly projectId: string,
    readonly legId: string,
    readonly shortfall: Money,
  ) {
    super(
      `Funding leg ${legId} cannot be taken out of project ${projectId}: without it the pot would be ` +
        `${shortfall.minorUnits} minor units short of what it has already spent`,
    );
    this.name = "FundingLegRequiredError";
  }
}

/**
 * Whether a leg can be taken back out. Removing one is correcting a mistyped row,
 * not withdrawing money — so it is refused whenever the pot could not have paid
 * for what it has already spent without it. The invariant holds in both
 * directions or it does not hold.
 */
export function requireLegRemovable(input: {
  readonly project: Project;
  readonly legs: readonly FundingLeg[];
  readonly expenses: readonly ProjectExpense[];
  readonly legId: string;
}): void {
  const { project } = input;
  const remaining = input.legs.filter((leg) => leg.id !== input.legId);
  const pot = potOf(project, remaining, input.expenses);

  if (isNegative(pot.balance)) {
    throw new FundingLegRequiredError(
      project.id,
      input.legId,
      subtract(zero(project.currency), pot.balance),
    );
  }
}

// --- what the household actually paid per unit -------------------------------

/**
 * The effective rate across every conversion this project took: the shekels on one
 * side of them and the dollars on the other, and the shekels-per-dollar those two
 * imply.
 *
 * Legs already in the pot's currency converted nothing and are not in it — the
 * question is "what did we pay per dollar when we bought dollars", and money that
 * was already dollars was never bought.
 *
 * The figure is derived from the recorded amounts rather than averaged out of the
 * rate fields, so `ils ÷ usd` reproduces the shekel total exactly. Where those two
 * differ in the last decimal it is the rounding that actually happened, and the
 * amounts are what the money did.
 */
export interface EffectiveRate {
  /** The shekel side of the conversions — what was paid, or what was received. */
  readonly ils: Money;
  /** The dollar side of the same conversions. */
  readonly usd: Money;
  /** Shekels per dollar, exactly `ils ÷ usd`. `null` when nothing was converted. */
  readonly rate: number | null;
  /** How many legs actually converted currency. */
  readonly legCount: number;
  /** Which way the money went, `null` when it never went either way. */
  readonly direction: { readonly from: Currency; readonly to: Currency } | null;
}

export function effectiveRate(project: Project, legs: readonly FundingLeg[]): EffectiveRate {
  const converting = legsOf(legs, project.id).filter((leg) => leg.amount.currency !== project.currency);

  let ils = zero("ILS");
  let usd = zero("USD");

  for (const leg of converting) {
    const received = legInPotCurrency(leg, project);
    for (const side of [leg.amount, received]) {
      if (side.currency === "ILS") ils = add(ils, side);
      else usd = add(usd, side);
    }
  }

  const first = converting[0];
  return {
    ils,
    usd,
    // Both currencies hold two minor digits, so agorot ÷ cents is already
    // shekels per dollar with nothing to scale.
    rate: usd.minorUnits === 0 ? null : ils.minorUnits / usd.minorUnits,
    legCount: converting.length,
    direction: first === undefined ? null : { from: first.amount.currency, to: project.currency },
  };
}

export type RateStanding = "above" | "below" | "same";

/**
 * The effective rate held against today's. Deliberately says only where the two
 * numbers sit relative to each other: whether that was a good conversion depends
 * on which way the money went, and the reader knows which way it went.
 */
export interface RateAgainstToday {
  readonly effective: number;
  readonly today: ExchangeRate;
  /** `effective − today`, in shekels per dollar. */
  readonly difference: number;
  readonly standing: RateStanding;
}

export class UnusableRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableRateError";
  }
}

export function againstToday(effective: EffectiveRate, today: ExchangeRate): RateAgainstToday | null {
  if (today.from !== "USD" || today.to !== "ILS") {
    throw new UnusableRateError(
      `Today's rate is quoted ${today.from}/${today.to}; the effective rate is shekels per dollar and the two must be the same question`,
    );
  }
  if (effective.rate === null) return null;

  const difference = effective.rate - today.rate;
  return {
    effective: effective.rate,
    today,
    difference,
    standing: difference > 0 ? "above" : difference < 0 ? "below" : "same",
  };
}

// --- what מיפוי reads --------------------------------------------------------

/**
 * What the project is worth in the מיפוי: its total cost, and not a penny of it is
 * the remaining balance.
 *
 * Per ADR 0003 an illiquid asset is held at cost and never re-valued. Spending the
 * expense ledger down converts cash inside the pot into property inside the same
 * pot; nothing left it. A value that fell as the ledger was spent would report
 * the household getting poorer every time it deployed its own capital.
 */
export function costForSnapshot(project: Project, legs: readonly FundingLeg[]): Money {
  return potOf(project, legs, []).funded;
}

// --- deal terms --------------------------------------------------------------

/**
 * What the sponsor's paperwork stated this project would return. Recorded as
 * data, entered by hand, and consumed by Scenarios later.
 *
 * It is a promise and not a measurement, which is why nothing here is derived from
 * anything and nothing else in the system reads it as a fact. `recordedOn` is the
 * day the paperwork was read, so a term that changed can be told from one that was
 * always so.
 */
export interface DealTerms {
  readonly projectId: string;
  /** The stated target return, in whole basis points. 1,200 is 12%. */
  readonly targetReturnBasisPoints: number | null;
  /** The stated hold period, in whole months. */
  readonly holdMonths: number | null;
  /** The distribution pattern, in the sponsor's own words. */
  readonly distribution: string | null;
  /** Which document it was read off — so the promise has a provenance. */
  readonly source: string | null;
  readonly recordedOn: CalendarDate;
}

export class InvalidDealTermsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDealTermsError";
  }
}

export interface DealTermsDefinition {
  readonly projectId: string;
  readonly targetReturnBasisPoints?: number | null;
  readonly holdMonths?: number | null;
  readonly distribution?: string | null;
  readonly source?: string | null;
  readonly recordedOn: CalendarDate;
}

const termsFailure = (message: string) => new InvalidDealTermsError(message);

function wholeNumber(value: number | null | undefined, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value)) {
    throw termsFailure(`${what} is recorded as a whole number, received ${String(value)}`);
  }
  return value;
}

export function buildDealTerms(definition: DealTermsDefinition): DealTerms {
  const holdMonths = wholeNumber(definition.holdMonths, "A hold period");
  if (holdMonths !== null && holdMonths <= 0) {
    throw termsFailure("A hold period is a number of months greater than zero");
  }

  return {
    projectId: definition.projectId,
    targetReturnBasisPoints: wholeNumber(definition.targetReturnBasisPoints, "A target return"),
    holdMonths,
    distribution: optionalText(definition.distribution, "A distribution pattern", 200, termsFailure),
    source: optionalText(definition.source, "A deal terms source", 120, termsFailure),
    recordedOn: definition.recordedOn,
  };
}

/** Whether anything at all was stated. A row of nulls is not a promise. */
export function statesAnything(terms: DealTerms): boolean {
  return (
    terms.targetReturnBasisPoints !== null ||
    terms.holdMonths !== null ||
    terms.distribution !== null ||
    terms.source !== null
  );
}

export function termsFor(terms: readonly DealTerms[], projectId: string): DealTerms | null {
  return terms.find((candidate) => candidate.projectId === projectId) ?? null;
}

// --- one project, read whole -------------------------------------------------

/**
 * Everything one project is, in one shape. Assembled here rather than in the
 * screen so a list of projects and a single project can never disagree about what
 * a pot holds.
 */
export interface ProjectReading {
  readonly project: Project;
  readonly legs: readonly FundingLeg[];
  readonly expenses: readonly ProjectExpense[];
  readonly pot: Pot;
  readonly effective: EffectiveRate;
  readonly terms: DealTerms | null;
  /** The cost מיפוי reads, which is the funded total and never the balance. */
  readonly cost: Money;
}

export function readProject(input: {
  readonly project: Project;
  readonly legs: readonly FundingLeg[];
  readonly expenses: readonly ProjectExpense[];
  readonly terms: readonly DealTerms[];
}): ProjectReading {
  const { project } = input;
  const pot = potOf(project, input.legs, input.expenses);

  return {
    project,
    legs: legsOf(input.legs, project.id),
    expenses: expensesOf(input.expenses, project.id),
    pot,
    effective: effectiveRate(project, input.legs),
    terms: termsFor(input.terms, project.id),
    // The same figure `potOf` produced, so the two cannot drift apart.
    cost: pot.funded,
  };
}

export function readProjects(input: {
  readonly projects: readonly Project[];
  readonly legs: readonly FundingLeg[];
  readonly expenses: readonly ProjectExpense[];
  readonly terms: readonly DealTerms[];
}): readonly ProjectReading[] {
  return projectsInReadingOrder(input.projects).map((project) =>
    readProject({ ...input, project }),
  );
}
