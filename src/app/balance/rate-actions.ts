"use server";

import { revalidatePath } from "next/cache";

import { findPersonByEmail } from "@/db/people";
import {
  deleteRenewal,
  insertAnnualItem,
  insertRenewal,
  loadAnnualItems,
  updateRenewal,
} from "@/db/rate-watch";
import {
  DuplicateAnnualItemNameError,
  DuplicateRenewalError,
  InvalidAnnualItemError,
  InvalidRenewalError,
  RATE_WATCH_CURRENCY,
  UnknownAnnualItemError,
  UnknownRenewalError,
  UnsupportedRenewalCurrencyError,
  findAnnualItem,
  planAnnualItemCreation,
  planRenewal,
  planRenewalCorrection,
  planRenewalRemoval,
} from "@/domain/ledger/annual-items";
import { InvalidMoneyError, parseMoneyInput } from "@/domain/money/money";
import { type CalendarDate, tryParseDateKey } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

import { type ReturnTo, backToGrid, returnToFrom } from "./return-to";

/**
 * The writes of מעקב תעריפים's typed band: creating an Annual Item with its first
 * price, recording a renewal against one, correcting a renewal and removing one.
 *
 * **None of them touches `entries`.** The money these figures describe is already
 * in the ledger — the car insurance shekel was typed into a Personal Category the
 * day it was paid — so every one of these writes leaves the grid above the panel
 * reading exactly as it did. That is the plan's load-bearing decision, and it is
 * why the panel prints no total across itself and the table.
 *
 * **Both People write everything here.** There is no ownership check and no
 * `not-yours` outcome: an Annual Item belongs to the Household and to no Person,
 * and Phases 21 and 22 removed the ownership check from the rest of the מאזן.
 *
 * **Correction ships with entry.** A form used about six times a year that can
 * produce a typo and cannot fix it is a trap — by the time the mistake is noticed
 * nobody remembers making it. So a renewal can be corrected and removed. An
 * Annual Item cannot be deleted: ending one is a lifespan, which Phase 26 puts on
 * screen.
 */

export type RateErrorCode =
  | "no-person"
  | "bad-item-name"
  | "duplicate-item"
  | "bad-amount"
  | "bad-date"
  | "duplicate-renewal"
  | "unknown-item"
  | "unknown-renewal"
  | "rate-failed";

interface Outcome {
  readonly code: RateErrorCode | null;
  readonly detail?: string;
  /** `<kind>:<subject>` — what the panel says happened, and to what. */
  readonly done?: string;
}

function readText(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}

/** The forms stay open across their own writes: shutting them would read as a reset. */
function backTo(returnTo: ReturnTo, outcome: Outcome): never {
  backToGrid(
    { ...returnTo, rateEdit: "1" },
    { error: outcome.code ?? "", detail: outcome.detail ?? "", done: outcome.done ?? "" },
  );
}

function failureFor(error: unknown): Outcome {
  if (error instanceof DuplicateAnnualItemNameError) {
    return { code: "duplicate-item", detail: error.itemName };
  }
  if (error instanceof InvalidAnnualItemError) return { code: "bad-item-name" };
  if (error instanceof DuplicateRenewalError) return { code: "duplicate-renewal" };
  if (error instanceof UnknownAnnualItemError) return { code: "unknown-item" };
  if (error instanceof UnknownRenewalError) return { code: "unknown-renewal" };
  if (error instanceof UnsupportedRenewalCurrencyError) {
    return { code: "bad-amount", detail: error.currency };
  }
  if (error instanceof InvalidRenewalError) return { code: "bad-amount" };
  if (error instanceof InvalidMoneyError) return { code: "bad-amount" };
  return { code: "rate-failed" };
}

/**
 * The signed-in Person. Not the owner of anything here — an Annual Item belongs
 * to the Household — but a session matching neither of the two has no household
 * to administer.
 */
async function requireSignedInPerson(returnTo: ReturnTo): Promise<void> {
  const email = await requireHouseholdEmail();
  const person = await findPersonByEmail(email);
  if (person === null) {
    backTo(returnTo, { code: "no-person", detail: email });
  }
}

async function run(form: FormData, work: () => Promise<Outcome>): Promise<never> {
  const returnTo = returnToFrom(form);
  await requireSignedInPerson(returnTo);

  let outcome: Outcome;
  try {
    outcome = await work();
  } catch (error) {
    outcome = failureFor(error);
  }

  // The panel is on `/balance` and nowhere else, and it reads no figure the other
  // two screens show — but the categories they share are read from the same page.
  revalidatePath("/balance");
  backTo(returnTo, outcome);
}

/** The amount typed into a field, as the policy total. Blank is an error, not nought. */
function readAmount(form: FormData, field: string) {
  const amount = parseMoneyInput(readText(form, field), RATE_WATCH_CURRENCY);
  if (amount === null) {
    throw new InvalidRenewalError("A renewal must state what the policy cost");
  }
  return amount;
}

/** The date typed into a field. The year is derived from it and never typed. */
function readDate(form: FormData, field: string): CalendarDate {
  const date = tryParseDateKey(readText(form, field));
  if (date === null) {
    throw new InvalidRenewalError(`Expected a date in ${field}`);
  }
  return date;
}

/**
 * A new Annual Item, with the price that starts its history. The two arrive
 * together: an item exists to hold prices, and its life begins at the first one.
 */
export async function createAnnualItem(form: FormData): Promise<void> {
  await run(form, async () => {
    const model = await loadAnnualItems();
    const creation = planAnnualItemCreation(
      model,
      {
        name: readText(form, "name"),
        renewedOn: readDate(form, "renewedOn"),
        amount: readAmount(form, "amount"),
      },
      { itemId: crypto.randomUUID() },
    );

    await insertAnnualItem(creation);
    return { code: null, done: `item-created:${creation.item.name}` };
  });
}

/** This year's quote against an item that already exists — or last year's, backfilled. */
export async function recordRenewal(form: FormData): Promise<void> {
  await run(form, async () => {
    const model = await loadAnnualItems();
    const itemId = readText(form, "itemId");
    const recording = planRenewal(model, itemId, {
      renewedOn: readDate(form, "renewedOn"),
      amount: readAmount(form, "amount"),
    });

    await insertRenewal(recording);
    return { code: null, done: `renewed:${findAnnualItem(model, itemId)?.name ?? ""}` };
  });
}

/**
 * Correct a price, or the date it was renewed on — which is what decides the year
 * the figure belongs to, so a renewal filed under the wrong year is fixed by
 * moving its date and never by editing a year.
 */
export async function correctRenewal(form: FormData): Promise<void> {
  await run(form, async () => {
    const model = await loadAnnualItems();
    const itemId = readText(form, "itemId");
    const correction = planRenewalCorrection(model, itemId, readDate(form, "originalOn"), {
      renewedOn: readDate(form, "renewedOn"),
      amount: readAmount(form, "amount"),
    });

    await updateRenewal(correction);
    return { code: null, done: `renewal-corrected:${findAnnualItem(model, itemId)?.name ?? ""}` };
  });
}

/** Remove one price. The item survives with the rest of its history. */
export async function removeRenewal(form: FormData): Promise<void> {
  await run(form, async () => {
    const model = await loadAnnualItems();
    const itemId = readText(form, "itemId");
    const removal = planRenewalRemoval(model, itemId, readDate(form, "renewedOn"));

    await deleteRenewal(removal);
    return { code: null, done: `renewal-removed:${findAnnualItem(model, itemId)?.name ?? ""}` };
  });
}
