"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { loadAccounts } from "@/db/accounts";
import { findPersonByEmail } from "@/db/people";
import { loadRsuRecords } from "@/db/rsu";
import { loadHouseholdSettings } from "@/db/settings";
import {
  findSnapshot,
  findSnapshotHeader,
  findSnapshotBefore,
  insertSnapshot,
  saveSnapshotLines,
  saveSnapshotRsuPrice,
} from "@/db/snapshots";
import { type Money, InvalidMoneyError, exchangeRate, parseMoneyInput } from "@/domain/money/money";
import {
  type SharePrice,
  InvalidSharePriceError,
  parseSharePriceInput,
  readPosition,
} from "@/domain/rsu/rsu-position";
import { readRsuLine, rsuStatement } from "@/domain/snapshot/rsu-line";
import {
  type AccountStatement,
  type Snapshot,
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
  | "bad-share-price"
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
  if (error instanceof InvalidSharePriceError) return { code: "bad-share-price", detail: error.message };
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

/**
 * The RSU account's restatement for a snapshot, worked out rather than read off
 * the form — there is no field for it.
 *
 * The position is read as of the snapshot's own date, so a snapshot of January
 * holds January's shares however many sales have been recorded since; the price is
 * the one stored on that snapshot, so its dollar figure is what a share cost that
 * day; and the conversion into the account's currency is `convertWithin`, which
 * can only reach the snapshot's own rate. Nothing about the figure can be typed,
 * and nothing about it can drift.
 */
async function derivedRsuStatement(
  snapshot: Snapshot,
  price: SharePrice | null,
): Promise<AccountStatement | null> {
  if (price === null) return null;

  const [settings, records, accounts] = await Promise.all([
    loadHouseholdSettings(),
    loadRsuRecords(),
    loadAccounts(),
  ]);
  if (settings.rsuAccountId === null) return null;

  return rsuStatement(
    readRsuLine({
      snapshot,
      accounts,
      accountId: settings.rsuAccountId,
      position: readPosition({ ...records, asOf: snapshot.takenOn }),
      price,
    }),
  );
}

/** The share price a reading was taken at. Blank is nothing stated, never nought. */
function sharePriceFrom(form: FormData, field: string): SharePrice | null {
  return parseSharePriceInput(readText(form, field), "USD");
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

    const seeded = seedSnapshot({
      id: crypto.randomUUID(),
      takenOn,
      // One rate, stored on the snapshot. Every dollar figure inside it converts
      // at this and at nothing else, today and in five years.
      rates: [exchangeRate("USD", "ILS", rate)],
      accounts,
      previous: await findSnapshotBefore(takenOn),
    });

    // The share price is stored beside the rate for the same reason, and the RSU
    // line is derived from it before the snapshot is written — so the holding is
    // never once in a state where somebody could have typed it.
    const rsuPrice = sharePriceFrom(form, "sharePrice");
    const statement = await derivedRsuStatement(seeded, rsuPrice);
    const snapshot = statement === null ? seeded : restate(seeded, [statement]);

    const note = readText(form, "note").trim();
    await insertSnapshot(snapshot, { note: note.length === 0 ? null : note, rsuPrice });
    return { code: null, done: "taken", snapshotId: snapshot.id };
  });
}

/**
 * Restate a snapshot. A figure that changed is a measurement; one resubmitted
 * unchanged is not, unless the reader ticked נמדד to say they looked at it.
 *
 * The RSU account is the one row with no amount on this form. Its figure is
 * derived from the position and the share price below, so submitting the form is
 * also what brings it back into agreement after a vest or a sale was recorded.
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

    // Read before the lines, so an unreadable price refuses the whole submission
    // rather than writing half of it. A form that carries no price field at all —
    // there is no RSU account named — leaves whatever the snapshot already holds.
    const rsuPrice = form.has("sharePrice")
      ? sharePriceFrom(form, "sharePrice")
      : (await findSnapshotHeader(snapshotId))?.rsuPrice ?? null;

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

    if (form.has("sharePrice")) {
      await saveSnapshotRsuPrice(snapshotId, rsuPrice);
    }
    const derived = await derivedRsuStatement(snapshot, rsuPrice);
    if (derived !== null) statements.push(derived);

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
