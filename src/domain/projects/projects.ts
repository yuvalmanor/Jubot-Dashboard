/**
 * Projects (נכסים ופרוייקטים) — the closed קופה.
 *
 * Framework-free per ADR 0004.
 *
 * A Project is a closed קופה of capital with a name and a purpose — CGM 1, CGM 2,
 * Meteor. Four rules give it its shape, and each one exists because the
 * spreadsheet did without it:
 *
 * **Funding Legs fill it with outside money; nothing else does.** A leg records one
 * source in the currency it was actually paid in — CGM 1 was funded by 109,800₪ and
 * by $69,000 of Apple RSU. Putting more money in is adding a leg, so the pot can
 * never be silently topped up: every shekel that went in is a row with a source.
 *
 * **Distributions are the project paying back, and the row says where it went.**
 * Taken, it lands in an Account מיפוי already counts and the balance does not move.
 * Rolled, it stays in and can be deployed again. A rolled one is deliberately not a
 * leg: a leg is capital from outside and sets the effective rate, and profit the
 * project made is neither.
 *
 * **Expenses are drawn out of it.** `יתרה = Σ(legs) + Σ(rolled) − Σ(expenses)`,
 * computed on read and with nowhere to write it, so the invariant cannot be broken
 * by any sequence of operations. An expense that would take the pot below nothing
 * is refused rather than allowed to overdraw a closed pot, and so is removing a
 * leg or a rolled distribution the pot has already spent against.
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
 * **A project is held at cost until something is stated about it.** `costForSnapshot`
 * is that floor: the capital in it that has not left it, unmoved by its expense
 * ledger being spent down. Per ADR 0005 a recorded עדכון שווי takes its place —
 * one figure, one date, one source, and nothing extrapolated between two of them.
 */

import {
  type Currency,
  type ExchangeRate,
  type Money,
  add,
  convert,
  convertBack,
  isNegative,
  negate,
  ratio,
  subtract,
  sum,
  zero,
} from "@/domain/money/money";
// The one type this module borrows from מיפוי: a valuation's basis and an
// Account's basis are the same three words, and two spellings of them would
// eventually disagree on a screen that shows both.
import { type ValueBasis } from "@/domain/snapshot/snapshot";
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
/**
 * Which of the three ways a rate can be wrong against the movement it belongs to.
 *
 * Carried on the error rather than inferred from its words. These are the
 * failures a person actually meets — the first one every time a dollar leg goes
 * into a dollar קופה — and the screen has to be able to say each of them in
 * Hebrew without matching on an English sentence that may be reworded.
 */
export type RateProblem = "unwanted" | "missing" | "wrong-pair";

/** An error from `rateFor`, tagged with which of the three it was. */
export function rateProblemOf(error: unknown): RateProblem | null {
  if (typeof error !== "object" || error === null || !("rateProblem" in error)) return null;
  const problem = (error as { rateProblem: unknown }).rateProblem;
  return problem === "unwanted" || problem === "missing" || problem === "wrong-pair"
    ? problem
    : null;
}

function tagged(error: Error, problem: RateProblem): Error {
  return Object.assign(error, { rateProblem: problem });
}

function rateFor(
  amount: Money,
  potCurrency: Currency,
  rate: ExchangeRate | null | undefined,
  fail: (message: string) => Error,
): ExchangeRate | null {
  const supplied = rate ?? null;

  if (amount.currency === potCurrency) {
    if (supplied !== null) {
      throw tagged(
        fail(
          `This ${amount.currency} amount went into a ${potCurrency} pot, so nothing was converted; ` +
            "a rate recorded beside it would be a number nobody used",
        ),
        "unwanted",
      );
    }
    return null;
  }

  if (supplied === null) {
    throw tagged(
      fail(`A ${amount.currency} amount in a ${potCurrency} pot must record the rate that was used`),
      "missing",
    );
  }
  const names =
    (supplied.from === amount.currency && supplied.to === potCurrency) ||
    (supplied.from === potCurrency && supplied.to === amount.currency);
  if (!names) {
    throw tagged(
      fail(
        `The rate quoted ${supplied.from}/${supplied.to} does not convert ${amount.currency} into ${potCurrency}`,
      ),
      "wrong-pair",
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

// --- distributions -----------------------------------------------------------

/**
 * What the project paid back, and where it went.
 *
 * A distribution is neither a leg nor an expense. It is the project returning
 * money, and the household does one of two things with it: takes it, or leaves it
 * in. Both are recorded here and the row says which, because the two are different
 * facts about the same event and no later reading can tell them apart otherwise.
 *
 * **Taken** (`out`) lands in an Account that מיפוי already counts, so the balance
 * is untouched — that money is no longer this project's to deploy, and counting it
 * both inside the pot and inside the account it landed in would be the same shekel
 * twice. The Account is named but never credited from here: a Snapshot is taken by
 * hand, and one entry writing a figure into two places is exactly the double-count
 * this records its destination to avoid.
 *
 * **Rolled** (`rolled`) stays in and can be deployed again, so the balance rises by
 * it. It is deliberately not a Funding Leg: a leg is external capital and sets the
 * effective rate, and profit the project made is neither. Counting it as one would
 * inflate what the household put in and would put a number nobody converted into
 * the average that answers "what did we pay per dollar".
 */
export type DistributionDestination =
  | { readonly kind: "out"; readonly accountId: string }
  | { readonly kind: "rolled" };

export interface ProjectDistribution extends PotMovement {
  readonly id: string;
  readonly projectId: string;
  /** What it was — `חלוקה רבעונית`, `החזר הון`. The household's own words. */
  readonly description: string;
  readonly destination: DistributionDestination;
  readonly paidOn: CalendarDate;
}

export class InvalidProjectDistributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectDistributionError";
  }
}

export interface ProjectDistributionDefinition {
  readonly projectId: string;
  readonly description: string;
  readonly amount: Money;
  readonly rate?: ExchangeRate | null;
  readonly destination: DistributionDestination;
  readonly paidOn: CalendarDate;
}

const distributionFailure = (message: string) => new InvalidProjectDistributionError(message);

export function buildProjectDistribution(
  id: string,
  definition: ProjectDistributionDefinition,
  project: Project,
): ProjectDistribution {
  if (definition.projectId !== project.id) {
    throw distributionFailure(
      `This distribution belongs to project ${definition.projectId}, not to ${project.id}`,
    );
  }
  if (definition.destination.kind === "out" && definition.destination.accountId.trim() === "") {
    throw distributionFailure(
      "A distribution that left the project names the account it landed in, or it is a rolled one",
    );
  }

  const amount = requirePositive(definition.amount, "A distribution", distributionFailure);
  return {
    id,
    projectId: project.id,
    description: requireText(definition.description, "A distribution description", 120, distributionFailure),
    amount,
    rate: rateFor(amount, project.currency, definition.rate, distributionFailure),
    destination: definition.destination,
    paidOn: definition.paidOn,
  };
}

export function distributionInPotCurrency(
  distribution: ProjectDistribution,
  project: Project,
): Money {
  return convertAt(distribution.amount, distribution.rate, project.currency, distributionFailure);
}

/** Whether this one stayed in the pot. */
export function isRolled(distribution: ProjectDistribution): boolean {
  return distribution.destination.kind === "rolled";
}

/** One project's distributions, oldest first. */
export function distributionsOf(
  distributions: readonly ProjectDistribution[],
  projectId: string,
): readonly ProjectDistribution[] {
  return distributions
    .filter((distribution) => distribution.projectId === projectId)
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
 * nothing stores it, so no sequence of legs, expenses and distributions can leave
 * it disagreeing with the rows it is made of.
 *
 * Five figures, and each one answers a different question. `funded` is what was put
 * in from outside and is the only one the effective rate is drawn from. `balance`
 * is what is left to deploy. `paidOut` is what the household actually received, and
 * `distributed` is what the project produced whether it was taken or not — a
 * project that rolls everything back has paid out nothing and produced plenty.
 */
export interface Pot {
  readonly currency: Currency;
  /** Σ(funding legs), in the pot's currency. External capital, and nothing else. */
  readonly funded: Money;
  /** Σ(distributions left in). Available to deploy, but never a funding leg. */
  readonly rolled: Money;
  /** Σ(expenses), in the pot's currency. What has been deployed out of it. */
  readonly spent: Money;
  /** `funded + rolled − spent` — the יתרה, the capital still undeployed. */
  readonly balance: Money;
  /** Σ(distributions taken out). What reached the household. */
  readonly paidOut: Money;
  /** `paidOut + rolled`. What the project returned, taken or not. */
  readonly distributed: Money;
  readonly legCount: number;
  readonly expenseCount: number;
  readonly distributionCount: number;
}

export function potOf(
  project: Project,
  legs: readonly FundingLeg[],
  expenses: readonly ProjectExpense[],
  distributions: readonly ProjectDistribution[] = [],
): Pot {
  const own = legsOf(legs, project.id);
  const drawn = expensesOf(expenses, project.id);
  const returned = distributionsOf(distributions, project.id);

  const funded = sum(
    own.map((leg) => legInPotCurrency(leg, project)),
    project.currency,
  );
  const spent = sum(
    drawn.map((expense) => expenseInPotCurrency(expense, project)),
    project.currency,
  );
  const rolled = sum(
    returned.filter(isRolled).map((one) => distributionInPotCurrency(one, project)),
    project.currency,
  );
  const paidOut = sum(
    returned.filter((one) => !isRolled(one)).map((one) => distributionInPotCurrency(one, project)),
    project.currency,
  );

  return {
    currency: project.currency,
    funded,
    rolled,
    spent,
    balance: subtract(add(funded, rolled), spent),
    paidOut,
    distributed: add(paidOut, rolled),
    legCount: own.length,
    expenseCount: drawn.length,
    distributionCount: returned.length,
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
  readonly distributions?: readonly ProjectDistribution[];
  readonly candidate: PotMovement;
}): void {
  const { project, candidate } = input;
  const pot = potOf(project, input.legs, input.expenses, input.distributions);
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
  readonly distributions?: readonly ProjectDistribution[];
  readonly legId: string;
}): void {
  const { project } = input;
  const remaining = input.legs.filter((leg) => leg.id !== input.legId);
  const pot = potOf(project, remaining, input.expenses, input.distributions);

  if (isNegative(pot.balance)) {
    throw new FundingLegRequiredError(
      project.id,
      input.legId,
      subtract(zero(project.currency), pot.balance),
    );
  }
}

/**
 * A rolled distribution the pot has already spent against.
 *
 * The same rule as a funding leg's, reached from the other side: a rolled row made
 * room in the balance, and taking it back out would leave more spent than the pot
 * ever held. One that went out never entered the balance, so removing it is always
 * allowed — it is a correction to the record of where the money went, not to what
 * the project has.
 */
export class DistributionRequiredError extends Error {
  constructor(
    readonly projectId: string,
    readonly distributionId: string,
    readonly shortfall: Money,
  ) {
    super(
      `Distribution ${distributionId} cannot be taken out of project ${projectId}: without it the ` +
        `pot would be ${shortfall.minorUnits} minor units short of what it has already spent`,
    );
    this.name = "DistributionRequiredError";
  }
}

export function requireDistributionRemovable(input: {
  readonly project: Project;
  readonly legs: readonly FundingLeg[];
  readonly expenses: readonly ProjectExpense[];
  readonly distributions: readonly ProjectDistribution[];
  readonly distributionId: string;
}): void {
  const { project } = input;
  const remaining = input.distributions.filter((one) => one.id !== input.distributionId);
  const pot = potOf(project, input.legs, input.expenses, remaining);

  if (isNegative(pot.balance)) {
    throw new DistributionRequiredError(
      project.id,
      input.distributionId,
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
 * What the project reads at עלות in the מיפוי: the capital that is in it and has
 * not left it, and not a penny of that is the remaining balance.
 *
 * Spending the expense ledger down converts cash inside the pot into property
 * inside the same pot; nothing left it. A value that fell as the ledger was spent
 * would report the household getting poorer every time it deployed its own
 * capital.
 *
 * Rolled distributions are in it and taken ones are not. A dividend left inside
 * the project is money the household owns and chose to keep deployed there, so
 * excluding it would make the project read as less than it holds; a dividend taken
 * is already counted in the Account it landed in. This keeps
 * `cost = spent + balance` true, which is the identity that makes the מיפוי line
 * explainable at all.
 *
 * Per ADR 0005 this is the floor rather than the whole story: a project reads its
 * latest stated valuation where one exists, and this where none does.
 */
export function costForSnapshot(
  project: Project,
  legs: readonly FundingLeg[],
  distributions: readonly ProjectDistribution[] = [],
): Money {
  const pot = potOf(project, legs, [], distributions);
  return add(pot.funded, pot.rolled);
}

// --- the three ledgers, read as one ------------------------------------------

/**
 * Which of the three a row is. The screen shows them in one table, so the kind is
 * a column rather than a heading — and every rule about what each kind does to the
 * balance stays exactly where it was.
 */
export type MovementKind = "leg" | "expense" | "distribution";

/**
 * One row of a project's history, whichever ledger it came out of.
 *
 * `effect` is the whole point of merging them: a leg adds to the balance, an
 * expense takes from it, a rolled distribution adds, and one that was taken did
 * nothing to it at all — which is `null` and not zero. Zero would say the row
 * moved nothing; `null` says the balance is not where that money is.
 */
export interface ProjectMovement {
  readonly kind: MovementKind;
  readonly id: string;
  /** Its own words: a leg's source, an expense's or a distribution's description. */
  readonly description: string;
  readonly paidOn: CalendarDate;
  readonly amount: Money;
  readonly rate: ExchangeRate | null;
  /** What it did to the balance, signed and in the pot's currency. */
  readonly effect: Money | null;
  /** Where a distribution went. `null` for the other two kinds. */
  readonly destination: DistributionDestination | null;
}

const KIND_ORDER: Record<MovementKind, number> = { leg: 0, expense: 1, distribution: 2 };

/**
 * The three ledgers in one list, oldest first — the order a project happened in.
 *
 * Rows on one day are ordered money-in before money-out before money-back, which
 * is the order they can legally have occurred in: an expense on the day the pot
 * was filled was paid for by that leg.
 */
export function movementsOf(input: {
  readonly project: Project;
  readonly legs: readonly FundingLeg[];
  readonly expenses: readonly ProjectExpense[];
  readonly distributions?: readonly ProjectDistribution[];
}): readonly ProjectMovement[] {
  const { project } = input;

  const rows: ProjectMovement[] = [
    ...legsOf(input.legs, project.id).map(
      (leg): ProjectMovement => ({
        kind: "leg",
        id: leg.id,
        description: leg.source,
        paidOn: leg.paidOn,
        amount: leg.amount,
        rate: leg.rate,
        effect: legInPotCurrency(leg, project),
        destination: null,
      }),
    ),
    ...expensesOf(input.expenses, project.id).map(
      (expense): ProjectMovement => ({
        kind: "expense",
        id: expense.id,
        description: expense.description,
        paidOn: expense.paidOn,
        amount: expense.amount,
        rate: expense.rate,
        effect: negate(expenseInPotCurrency(expense, project)),
        destination: null,
      }),
    ),
    ...distributionsOf(input.distributions ?? [], project.id).map(
      (distribution): ProjectMovement => ({
        kind: "distribution",
        id: distribution.id,
        description: distribution.description,
        paidOn: distribution.paidOn,
        amount: distribution.amount,
        rate: distribution.rate,
        // One that was taken never entered the balance, so it did nothing to it.
        effect: isRolled(distribution) ? distributionInPotCurrency(distribution, project) : null,
        destination: distribution.destination,
      }),
    ),
  ];

  return rows.sort(
    (left, right) =>
      compareDates(left.paidOn, right.paidOn) ||
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      left.description.localeCompare(right.description, "he") ||
      left.id.localeCompare(right.id),
  );
}

// --- what it is said to be worth ---------------------------------------------

/**
 * The two bases a stated valuation can carry. `cost` is the third `ValueBasis`
 * and is deliberately not among them: it is what a project reads when nothing
 * has been stated, which is not a statement anybody made.
 */
export type ValuationBasis = Extract<ValueBasis, "market" | "estimate">;

export const VALUATION_BASES: readonly ValuationBasis[] = ["market", "estimate"];

export function isValuationBasis(value: unknown): value is ValuationBasis {
  return typeof value === "string" && (VALUATION_BASES as string[]).includes(value);
}

/**
 * עדכון שווי — one figure somebody stated about this project, on a date, from a
 * source. Per ADR 0005, which supersedes 0003.
 *
 * Three rules keep a series of these from becoming a forecast:
 *
 * **It is an event, not a rate.** Nothing interpolates between two of them and
 * nothing projects one forward. Meteor's sponsor reporting 20% growth over the
 * last year is one figure dated to that report — not a function this system
 * applies again next year.
 *
 * **The basis grades it.** A re-appraisal of a CGM house is שווי שוק; a sponsor's
 * own report of its own performance is הערכה. The two are not averaged together
 * and the weaker one is never printed as the stronger.
 *
 * **No source, no valuation.** מיפוי moves when one of these is recorded, so the
 * safeguard is provenance and not refusal: whatever moved can be traced back to
 * who said so.
 */
export interface ProjectValuation {
  readonly id: string;
  readonly projectId: string;
  /** The figure stated, in the pot's own currency. */
  readonly amount: Money;
  readonly basis: ValuationBasis;
  /** The document or party it was read off — an appraisal, a sponsor's report. */
  readonly source: string;
  /** The day it speaks for, which is not the day it was typed in. */
  readonly statedOn: CalendarDate;
}

export class InvalidProjectValuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectValuationError";
  }
}

export interface ProjectValuationDefinition {
  readonly projectId: string;
  readonly amount: Money;
  readonly basis: ValuationBasis;
  readonly source: string;
  readonly statedOn: CalendarDate;
}

const valuationFailure = (message: string) => new InvalidProjectValuationError(message);

export function buildProjectValuation(
  id: string,
  definition: ProjectValuationDefinition,
  project: Project,
): ProjectValuation {
  if (definition.projectId !== project.id) {
    throw valuationFailure(
      `This valuation belongs to project ${definition.projectId}, not to ${project.id}`,
    );
  }
  // A valuation carries no rate, because nothing was converted: it is a statement
  // about what the pot is worth, and the pot is denominated in one currency.
  if (definition.amount.currency !== project.currency) {
    throw valuationFailure(
      `A valuation is stated in the pot's own currency: this one is in ` +
        `${definition.amount.currency} against a ${project.currency} pot`,
    );
  }
  if (isNegative(definition.amount)) {
    throw valuationFailure("A valuation is not a negative figure");
  }
  if (!isValuationBasis(definition.basis)) {
    throw valuationFailure(
      `A valuation is stated on a market or an estimate basis, not on ${String(definition.basis)}`,
    );
  }

  return {
    id,
    projectId: project.id,
    amount: definition.amount,
    basis: definition.basis,
    source: requireText(definition.source, "A valuation source", 160, valuationFailure),
    statedOn: definition.statedOn,
  };
}

/**
 * One project's valuations, **newest first** — the opposite of the three ledgers,
 * and on purpose: a ledger is read forwards because every row of it still counts,
 * and this band is read backwards because only its first row does.
 */
export function valuationsOf(
  valuations: readonly ProjectValuation[],
  projectId: string,
): readonly ProjectValuation[] {
  return valuations
    .filter((valuation) => valuation.projectId === projectId)
    .sort(
      (left, right) =>
        compareDates(right.statedOn, left.statedOn) || left.id.localeCompare(right.id),
    );
}

/**
 * The last thing stated about this project as at a date, or `null` where nothing
 * has been. `asOf` is what keeps an old Snapshot reading what it read at the time:
 * a valuation stated in June does not reach back into a March Snapshot.
 */
export function latestValuation(
  valuations: readonly ProjectValuation[],
  projectId: string,
  asOf?: CalendarDate,
): ProjectValuation | null {
  const stated = valuationsOf(valuations, projectId).filter(
    (valuation) => asOf === undefined || compareDates(valuation.statedOn, asOf) <= 0,
  );
  return stated[0] ?? null;
}

/**
 * What a project is worth, and on whose word. `cost` sits beside it always,
 * because "what we put in" and "what it is said to be worth" are two questions
 * and the first cannot be argued with.
 */
export interface ProjectValue {
  /** The figure to read: the latest stated valuation, or the cost where none is. */
  readonly amount: Money;
  readonly basis: ValueBasis;
  /** The valuation this read, or `null` when it is reading cost. */
  readonly valuation: ProjectValuation | null;
  /** `Σ legs + Σ rolled` — the capital in it that has not left it. */
  readonly cost: Money;
}

export function valueOf(input: {
  readonly project: Project;
  readonly legs: readonly FundingLeg[];
  readonly distributions?: readonly ProjectDistribution[];
  readonly valuations?: readonly ProjectValuation[];
  readonly asOf?: CalendarDate;
}): ProjectValue {
  const cost = costForSnapshot(input.project, input.legs, input.distributions ?? []);
  const valuation = latestValuation(input.valuations ?? [], input.project.id, input.asOf);

  return valuation === null
    ? { amount: cost, basis: "cost", valuation: null, cost }
    : { amount: valuation.amount, basis: valuation.basis, valuation, cost };
}

/**
 * What the project has come to, against what is in it:
 * `(שווי אחרון + חולק החוצה) − עלות`.
 *
 * Measured against `cost` and not against `funded`, because a rolled distribution
 * is capital sitting in the project and the valuation values it. Against גויס the
 * same shekel would read as profit while also being part of what is being valued.
 *
 * `null` where nothing has been stated: with no valuation the figure reads 0%,
 * which is a measurement of nothing rather than a finding.
 */
export interface ProjectGrowth {
  readonly valuation: ProjectValuation;
  readonly cost: Money;
  readonly value: Money;
  readonly paidOut: Money;
  /** `value + paidOut − cost`. Unrealised and realised in one figure. */
  readonly gain: Money;
  /** `gain / cost`, or `null` when nothing was put in to measure against. */
  readonly ratio: number | null;
}

export function growthOf(value: ProjectValue, pot: Pot): ProjectGrowth | null {
  if (value.valuation === null) return null;

  const gain = subtract(add(value.amount, pot.paidOut), value.cost);
  return {
    valuation: value.valuation,
    cost: value.cost,
    value: value.amount,
    paidOut: pot.paidOut,
    gain,
    ratio: ratio(gain, value.cost),
  };
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
  readonly distributions: readonly ProjectDistribution[];
  /** The three ledgers above as one list, oldest first. What the screen shows. */
  readonly movements: readonly ProjectMovement[];
  /** Newest first: only the first one is read, and the rest are its history. */
  readonly valuations: readonly ProjectValuation[];
  readonly pot: Pot;
  readonly effective: EffectiveRate;
  readonly terms: DealTerms | null;
  /** What it is worth and on whose word, with the cost beside it. */
  readonly value: ProjectValue;
  /** The performance line, or `null` where nothing has been stated about it. */
  readonly growth: ProjectGrowth | null;
  /** The cost מיפוי reads at עלות: the capital in it that has not left it. */
  readonly cost: Money;
}

export function readProject(input: {
  readonly project: Project;
  readonly legs: readonly FundingLeg[];
  readonly expenses: readonly ProjectExpense[];
  readonly distributions?: readonly ProjectDistribution[];
  readonly valuations?: readonly ProjectValuation[];
  readonly terms: readonly DealTerms[];
  /** Read it as at a date, so an old Snapshot keeps reading what it read then. */
  readonly asOf?: CalendarDate;
}): ProjectReading {
  const { project } = input;
  const distributions = input.distributions ?? [];
  const valuations = input.valuations ?? [];
  const pot = potOf(project, input.legs, input.expenses, distributions);
  const value = valueOf({
    project,
    legs: input.legs,
    distributions,
    valuations,
    asOf: input.asOf,
  });

  return {
    project,
    legs: legsOf(input.legs, project.id),
    expenses: expensesOf(input.expenses, project.id),
    distributions: distributionsOf(distributions, project.id),
    movements: movementsOf({ project, legs: input.legs, expenses: input.expenses, distributions }),
    valuations: valuationsOf(valuations, project.id),
    pot,
    effective: effectiveRate(project, input.legs),
    terms: termsFor(input.terms, project.id),
    value,
    growth: growthOf(value, pot),
    // The same figures `potOf` produced, so the two cannot drift apart.
    cost: add(pot.funded, pot.rolled),
  };
}

export function readProjects(input: {
  readonly projects: readonly Project[];
  readonly legs: readonly FundingLeg[];
  readonly expenses: readonly ProjectExpense[];
  readonly distributions?: readonly ProjectDistribution[];
  readonly valuations?: readonly ProjectValuation[];
  readonly terms: readonly DealTerms[];
  readonly asOf?: CalendarDate;
}): readonly ProjectReading[] {
  return projectsInReadingOrder(input.projects).map((project) =>
    readProject({ ...input, project }),
  );
}
