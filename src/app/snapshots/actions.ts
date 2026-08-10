"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { loadAccounts } from "@/db/accounts";
import { findPersonByEmail } from "@/db/people";
import {
  findSnapshot,
  findSnapshotBefore,
  insertSnapshot,
  saveSnapshotLines,
} from "@/db/snapshots";
import { type Money, InvalidMoneyError, exchangeRate, parseMoneyInput } from "@/domain/money/money";
import {
  type AccountStatement,
  MalformedSnapshotError,
  MissingSnapshotRateError,
  SnapshotOrderError,
  UnknownAccountError,
  accountsOpenOn,
  addMissingLines,
  requireAccount,
  restate,
  seedSnapshot,
} from "@/domain/snapshot/snapshot";
import { InvalidCalendarDateError, tryParseDateKey } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

/**
 * The two writes of the מיפוי: taking a snapshot, and restating one.
 *
 * Taking one is a single operation that seeds a line for every open account —
 * there is no path here that writes a snapshot with some accounts in it and some
 * left out. Restating one writes only balances: the date and the rate are fixed
 * when the snapshot is taken, because a snapshot restated at a later rate would
 * no longer be the reading it was.
 */

const AMOUNT_FIELD_PREFIX = "amount:";
const MEASURED_FIELD_PREFIX = "measured:";

export type SnapshotsErrorCode =
  | "no-person"
  | "no-accounts"
  | "bad-date"
  | "bad-rate"
  | "bad-amount"
  | "out-of-order"
  | "duplicate-date"
  | "unknown-snapshot"
  | "failed";

interface Outcome {
  readonly code: SnapshotsErrorCode | null;
  readonly detail?: string;
  readonly done?: string;
  /** Where to land. The list, or the snapshot just written. */
  readonly snapshotId?: string;
}

/** An amount that could not be read, named by the account it was typed against. */
class BadAmountError extends Error {
  constructor(readonly accountName: string) {
    super(`Amount for ${accountName} is not a number`);
    this.name = "BadAmountError";
  }
}

class NoAccountsError extends Error {
  constructor() {
    super("There are no accounts open on that date to snapshot");
    this.name = "NoAccountsError";
  }
}

class UnknownSnapshotError extends Error {
  constructor(readonly snapshotId: string) {
    super(`No such snapshot: ${snapshotId}`);
    this.name = "UnknownSnapshotError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function failureFor(error: unknown): Outcome {
  if (error instanceof BadAmountError) return { code: "bad-amount", detail: error.accountName };
  if (error instanceof NoAccountsError) return { code: "no-accounts" };
  if (error instanceof InvalidMoneyError) return { code: "bad-rate", detail: error.message };
  if (error instanceof InvalidCalendarDateError) return { code: "bad-date" };
  if (error instanceof SnapshotOrderError) return { code: "out-of-order", detail: error.message };
  if (error instanceof MissingSnapshotRateError) return { code: "bad-rate", detail: error.message };
  if (error instanceof MalformedSnapshotError) return { code: "failed", detail: error.message };
  if (error instanceof UnknownSnapshotError) return { code: "unknown-snapshot" };
  if (error instanceof UnknownAccountError) return { code: "failed", detail: error.accountId };
  if (isUniqueViolation(error)) return { code: "duplicate-date" };
  return { code: "failed" };
}

function backTo(outcome: Outcome): never {
  const params = new URLSearchParams();
  if (outcome.code !== null) params.set("error", outcome.code);
  if (outcome.detail !== undefined) params.set("detail", outcome.detail);
  if (outcome.done !== undefined) params.set("done", outcome.done);
  const search = params.toString();
  const path = outcome.snapshotId === undefined ? "/snapshots" : `/snapshots/${outcome.snapshotId}`;
  // A snapshot id makes the path dynamic, which typed routes cannot infer from a
  // template literal. The segment is a uuid this action just wrote.
  redirect((search.length === 0 ? path : `${path}?${search}`) as Route);
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

async function run(landOn: string | undefined, work: () => Promise<Outcome>): Promise<never> {
  let outcome: Outcome;
  try {
    outcome = await work();
  } catch (error) {
    outcome = { ...failureFor(error), snapshotId: landOn };
  }
  revalidatePath("/snapshots");
  if (outcome.snapshotId !== undefined) revalidatePath(`/snapshots/${outcome.snapshotId}`);
  backTo(outcome);
}

/**
 * Take a snapshot. Seeded from the previous one, so restating means correcting
 * what changed; every account open on the date is in it, so the total is never
 * quietly short.
 */
export async function takeSnapshot(form: FormData): Promise<void> {
  await requirePersonId();

  await run(undefined, async () => {
    const takenOn = tryParseDateKey(readText(form, "takenOn"));
    if (takenOn === null) {
      throw new InvalidCalendarDateError("A snapshot needs a date");
    }

    const rate = Number(readText(form, "usdIls"));
    const accounts = await loadAccounts();
    if (accountsOpenOn(accounts, takenOn).length === 0) {
      throw new NoAccountsError();
    }

    const snapshot = seedSnapshot({
      id: crypto.randomUUID(),
      takenOn,
      // One rate, stored on the snapshot. Every dollar figure inside it converts
      // at this and at nothing else, today and in five years.
      rates: [exchangeRate("USD", "ILS", rate)],
      accounts,
      previous: await findSnapshotBefore(takenOn),
    });

    const note = readText(form, "note").trim();
    await insertSnapshot(snapshot, note.length === 0 ? null : note);
    return { code: null, done: "taken", snapshotId: snapshot.id };
  });
}

/**
 * Restate a snapshot. A figure that changed is a measurement; one resubmitted
 * unchanged is not, unless the reader ticked נמדד to say they looked at it.
 */
export async function restateSnapshot(form: FormData): Promise<void> {
  await requirePersonId();
  const snapshotId = readText(form, "snapshotId");

  await run(snapshotId, async () => {
    const snapshot = await findSnapshot(snapshotId);
    if (snapshot === null) {
      throw new UnknownSnapshotError(snapshotId);
    }
    const accounts = await loadAccounts();

    const statements: AccountStatement[] = [];
    for (const line of snapshot.lines) {
      const field = `${AMOUNT_FIELD_PREFIX}${line.accountId}`;
      if (!form.has(field)) continue;

      const account = requireAccount(accounts, line.accountId);
      let balance: Money | null;
      try {
        balance = parseMoneyInput(readText(form, field), account.currency);
      } catch {
        throw new BadAmountError(account.name);
      }
      // A blank field is not a balance of nothing — it is the row left alone.
      if (balance === null) continue;

      statements.push({
        accountId: line.accountId,
        balance,
        measured: form.get(`${MEASURED_FIELD_PREFIX}${line.accountId}`) !== null,
      });
    }

    await saveSnapshotLines(restate(snapshot, statements));
    return { code: null, done: "restated", snapshotId };
  });
}

/**
 * Fill in accounts that were defined after this snapshot was taken. They enter as
 * never-measured rather than as zeros anybody stated, so the snapshot becomes
 * complete without becoming wrong.
 */
export async function fillMissingAccounts(form: FormData): Promise<void> {
  await requirePersonId();
  const snapshotId = readText(form, "snapshotId");

  await run(snapshotId, async () => {
    const snapshot = await findSnapshot(snapshotId);
    if (snapshot === null) {
      throw new UnknownSnapshotError(snapshotId);
    }
    const completed = addMissingLines(snapshot, await loadAccounts());
    // Only the added lines are new; the rest upsert to the values they already hold.
    await saveSnapshotLines(completed);
    return { code: null, done: "filled", snapshotId };
  });
}
