"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { insertAccount, loadAccounts, updateAccount } from "@/db/accounts";
import {
  deletePosition,
  insertEarmark,
  insertPosition,
  loadEarmarks,
  updateEarmark,
} from "@/db/holdings";
import { findPersonByEmail } from "@/db/people";
import { type Currency, InvalidMoneyError, isCurrency, parseMoneyInput } from "@/domain/money/money";
import {
  type Earmark,
  InvalidEarmarkError,
  InvalidPositionError,
  PositionsNotApplicableError,
  buildEarmark,
  requirePositionsAllowed,
} from "@/domain/snapshot/holdings";
import {
  InvalidAccountError,
  UnknownAccountError,
  buildAccount,
  isAssetCategory,
  isValueBasis,
  requireAccount,
} from "@/domain/snapshot/snapshot";
import { dateOf, tryParseDateKey } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

/**
 * Defining Accounts, and the two claims recorded inside them — what the money is
 * invested in (החזקה) and what it is promised to (ייעוד). Nothing here writes a
 * balance: an account is *where* value is held, and *how much* is a question only
 * a Snapshot answers.
 *
 * Either Person may define any account. An account is a fact about where the
 * household's money sits, not one Person's own naming the way a Personal Category
 * is — and both of them take the snapshots that read from it.
 */

export type AccountsErrorCode =
  | "no-person"
  | "bad-account"
  | "duplicate-name"
  | "unknown-account"
  | "bad-position"
  | "no-positions-here"
  | "bad-earmark"
  | "unknown-earmark"
  | "failed";

interface Outcome {
  readonly code: AccountsErrorCode | null;
  readonly detail?: string;
  readonly done?: string;
}

function backTo(outcome: Outcome): never {
  const params = new URLSearchParams();
  if (outcome.code !== null) params.set("error", outcome.code);
  if (outcome.detail !== undefined) params.set("detail", outcome.detail);
  if (outcome.done !== undefined) params.set("done", outcome.done);
  const search = params.toString();
  redirect(search.length === 0 ? "/accounts" : `/accounts?${search}`);
}

/** The unique index on (person_id, name) is the one clash the form cannot pre-empt. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

class UnknownEarmarkError extends Error {
  constructor(readonly earmarkId: string) {
    super(`No such earmark: ${earmarkId}`);
    this.name = "UnknownEarmarkError";
  }
}

function failureFor(error: unknown): Outcome {
  if (error instanceof InvalidAccountError) return { code: "bad-account", detail: error.message };
  if (error instanceof UnknownAccountError) return { code: "unknown-account" };
  if (error instanceof PositionsNotApplicableError) return { code: "no-positions-here" };
  if (error instanceof InvalidPositionError) return { code: "bad-position", detail: error.message };
  if (error instanceof InvalidEarmarkError) return { code: "bad-earmark", detail: error.message };
  if (error instanceof InvalidMoneyError) return { code: "bad-earmark", detail: error.message };
  if (error instanceof UnknownEarmarkError) return { code: "unknown-earmark" };
  if (isUniqueViolation(error)) return { code: "duplicate-name" };
  return { code: "failed" };
}

function readText(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}

async function requirePersonId(): Promise<string> {
  const email = await requireHouseholdEmail();
  const person = await findPersonByEmail(email);
  if (person === null) {
    backTo({ code: "no-person", detail: email });
  }
  return person.id;
}

async function run(work: () => Promise<Outcome>): Promise<never> {
  let outcome: Outcome;
  try {
    outcome = await work();
  } catch (error) {
    outcome = failureFor(error);
  }
  revalidatePath("/accounts");
  revalidatePath("/snapshots");
  backTo(outcome);
}

/**
 * Read the five fields that make an account an account. Each one is validated
 * rather than defaulted — a Value Basis nobody chose is exactly the placeholder
 * ADR 0003 exists to keep out of the totals.
 */
function definitionFrom(form: FormData, fallbackPersonId: string) {
  const currency = readText(form, "currency");
  if (!isCurrency(currency)) {
    throw new InvalidAccountError(`מטבע לא מוכר: ${currency}`);
  }
  const valueBasis = readText(form, "valueBasis");
  if (!isValueBasis(valueBasis)) {
    throw new InvalidAccountError("יש לבחור בסיס שווי");
  }
  const category = readText(form, "category");
  if (!isAssetCategory(category)) {
    throw new InvalidAccountError("יש לבחור קטגוריה");
  }
  const openedOn = tryParseDateKey(readText(form, "openedOn"));
  if (openedOn === null) {
    throw new InvalidAccountError("תאריך פתיחה אינו תקין");
  }

  const personId = readText(form, "personId");
  return {
    personId: personId.length === 0 ? fallbackPersonId : personId,
    name: readText(form, "name"),
    currency,
    valueBasis,
    category,
    assetKind: readText(form, "assetKind"),
    openedOn,
    closedOn: tryParseDateKey(readText(form, "closedOn")),
  };
}

export async function createAccount(form: FormData): Promise<void> {
  const personId = await requirePersonId();

  await run(async () => {
    const definition = definitionFrom(form, personId);
    const account = buildAccount(crypto.randomUUID(), definition);
    await insertAccount(account.id, definition);
    return { code: null, done: `created:${account.name}` };
  });
}

/**
 * Correct a definition. The currency is not editable: it is what the account *is*,
 * and changing it would re-denominate every figure already recorded against it.
 */
export async function editAccount(form: FormData): Promise<void> {
  await requirePersonId();

  await run(async () => {
    const accounts = await loadAccounts();
    const existing = requireAccount(accounts, readText(form, "accountId"));

    const account = buildAccount(existing.id, {
      ...definitionFrom(form, existing.personId),
      personId: existing.personId,
      currency: existing.currency,
    });
    await updateAccount(account);
    return { code: null, done: `saved:${account.name}` };
  });
}

// --- החזקות ------------------------------------------------------------------

/**
 * Record what an account is invested in. No amount is taken: the position says
 * *what*, and how much the account holds on a given day is the snapshot's fact.
 * An account held at cost is refused outright — per ADR 0003 nothing in it is
 * priced, so there is no composition to state.
 */
export async function createPosition(form: FormData): Promise<void> {
  await requirePersonId();

  await run(async () => {
    const accounts = await loadAccounts();
    const account = requireAccount(accounts, readText(form, "accountId"));
    requirePositionsAllowed(account);

    await insertPosition(crypto.randomUUID(), {
      accountId: account.id,
      securityId: readText(form, "securityId"),
      name: readText(form, "name"),
    });
    return { code: null, done: `position-added:${account.name}` };
  });
}

/**
 * Remove a position. A delete rather than a lifespan: a position is what the
 * account holds now, nothing dated is recorded against it, and no past reading
 * changes when one goes.
 */
export async function removePosition(form: FormData): Promise<void> {
  await requirePersonId();

  await run(async () => {
    await deletePosition(readText(form, "positionId"));
    return { code: null, done: "position-removed:" };
  });
}

// --- ייעודים -----------------------------------------------------------------

/**
 * Read the claim in the account's own currency. A claim quoted in another one
 * would need a rate to compare against its backing, and a rate moving is not
 * money being spent.
 */
function claimFrom(form: FormData, field: string, currency: Currency) {
  const claim = parseMoneyInput(readText(form, field), currency);
  if (claim === null) {
    throw new InvalidEarmarkError("יש להזין סכום לייעוד");
  }
  return claim;
}

/** Promise money inside an account. The amount is fixed; spending makes it short, not smaller. */
export async function createEarmark(form: FormData): Promise<void> {
  await requirePersonId();

  await run(async () => {
    const accounts = await loadAccounts();
    const account = requireAccount(accounts, readText(form, "accountId"));

    const earmark = buildEarmark(crypto.randomUUID(), {
      accountId: account.id,
      name: readText(form, "name"),
      claim: claimFrom(form, "claim", account.currency),
      declaredOn: tryParseDateKey(readText(form, "declaredOn")) ?? dateOf(new Date()),
    });
    await insertEarmark(earmark.id, earmark);
    return { code: null, done: `earmark-added:${earmark.name}` };
  });
}

/**
 * Correct a claim. Changing the amount here is the household deciding to promise
 * something different — which is the only way a claim moves. Spending the money
 * never touches it.
 */
export async function editEarmark(form: FormData): Promise<void> {
  await requirePersonId();

  await run(async () => {
    const existing = await requireEarmark(readText(form, "earmarkId"));
    const accounts = await loadAccounts();
    const account = requireAccount(accounts, existing.accountId);

    const earmark = buildEarmark(existing.id, {
      ...existing,
      name: readText(form, "name"),
      claim: claimFrom(form, "claim", account.currency),
    });
    await updateEarmark(earmark);
    return { code: null, done: `earmark-saved:${earmark.name}` };
  });
}

/**
 * Release a claim, or reinstate it. A lifespan and never a delete: a snapshot
 * taken while the promise stood must keep reading as it did.
 */
export async function setEarmarkLifespan(form: FormData): Promise<void> {
  await requirePersonId();

  await run(async () => {
    const existing = await requireEarmark(readText(form, "earmarkId"));
    const reinstate = readText(form, "intent") === "reinstate";
    const releasedOn = reinstate
      ? null
      : (tryParseDateKey(readText(form, "releasedOn")) ?? dateOf(new Date()));

    await updateEarmark(buildEarmark(existing.id, { ...existing, releasedOn }));
    return { code: null, done: `${reinstate ? "earmark-reinstated" : "earmark-released"}:${existing.name}` };
  });
}

async function requireEarmark(id: string): Promise<Earmark> {
  const earmark = (await loadEarmarks()).find((candidate) => candidate.id === id);
  if (earmark === undefined) {
    throw new UnknownEarmarkError(id);
  }
  return earmark;
}

/** Close an account, or put it back in use. Closing is a lifespan, never a delete. */
export async function setAccountLifespan(form: FormData): Promise<void> {
  await requirePersonId();

  await run(async () => {
    const accounts = await loadAccounts();
    const existing = requireAccount(accounts, readText(form, "accountId"));

    const reopen = readText(form, "intent") === "reopen";
    const closedOn = reopen ? null : (tryParseDateKey(readText(form, "closedOn")) ?? dateOf(new Date()));

    await updateAccount(buildAccount(existing.id, { ...existing, closedOn }));
    return { code: null, done: `${reopen ? "reopened" : "closed"}:${existing.name}` };
  });
}
