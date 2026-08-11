"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { findPersonByEmail } from "@/db/people";
import {
  deleteGrant,
  deleteSale,
  deleteVest,
  insertGrant,
  insertSale,
  insertVest,
  loadGrants,
  loadRsuRecords,
  updateGrant,
} from "@/db/rsu";
import { loadHouseholdSettings } from "@/db/settings";
import { type Currency, isCurrency } from "@/domain/money/money";
import {
  type Grant,
  GrantOversubscribedError,
  InvalidDailyCloseError,
  InvalidGpWindowError,
  InvalidGrantError,
  InvalidSaleError,
  InvalidSharePriceError,
  InvalidVestError,
  LotOversoldError,
  UnknownGrantError,
  UnknownVestError,
  buildGrant,
  estimateGrantPrice,
  parseDailyCloses,
  parseSharePriceInput,
  requireGrant,
  requireVest,
  requireWithinGrant,
  requireWithinLot,
  statedGrantPrice,
} from "@/domain/rsu/rsu-position";
import { dateOf, tryParseDateKey } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

/**
 * Writing the RSU position. Three rules run through everything here:
 *
 * **Nothing writes a qualification.** There is no action that marks a lot as
 * Qualified, because there is no such field: it is derived from the grant date on
 * every read, and the only thing that changes it is the calendar.
 *
 * **A sale names its lot.** Which lot shares left decides how they are taxed, so
 * every sale carries a vest id and the domain refuses one that would take more
 * than the lot holds — checked before the insert, so the negative lot never exists.
 *
 * **A stated GP and an estimated one are written by different actions.** They are
 * different kinds of fact and the system never lets them read alike: an estimate
 * is stored with the window and the sample that produced it.
 *
 * Either Person may record any of it. The position belongs to whoever the grant
 * names, and recording it is not the same as owning it.
 */

export type RsuErrorCode =
  | "no-person"
  | "bad-grant"
  | "duplicate-reference"
  | "unknown-grant"
  | "bad-vest"
  | "oversubscribed"
  | "bad-sale"
  | "oversold"
  | "bad-price"
  | "bad-closes"
  | "no-closes"
  | "bad-window"
  | "failed";

interface Outcome {
  readonly code: RsuErrorCode | null;
  readonly detail?: string;
  readonly done?: string;
}

function backTo(outcome: Outcome): never {
  const params = new URLSearchParams();
  if (outcome.code !== null) params.set("error", outcome.code);
  if (outcome.detail !== undefined) params.set("detail", outcome.detail);
  if (outcome.done !== undefined) params.set("done", outcome.done);
  const search = params.toString();
  redirect((search.length === 0 ? "/rsu" : `/rsu?${search}`) as Route);
}

/** The unique index on the grant's document ID is the one clash a form cannot pre-empt. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function failureFor(error: unknown): Outcome {
  if (error instanceof LotOversoldError) {
    // The one refusal a person will meet in ordinary use, so it states the figures
    // rather than the domain's own words.
    return {
      code: "oversold",
      detail: `במנה יש ${error.remaining} מניות, והמכירה מבקשת ${error.attempted}.`,
    };
  }
  if (error instanceof GrantOversubscribedError) {
    return {
      code: "oversubscribed",
      detail: `ההקצאה היא על ${error.totalShares} מניות, וההבשלות כבר תובעות ${error.vestedShares}.`,
    };
  }
  if (error instanceof InvalidGrantError) return { code: "bad-grant", detail: error.message };
  if (error instanceof UnknownGrantError) return { code: "unknown-grant" };
  if (error instanceof UnknownVestError) return { code: "bad-sale", detail: error.message };
  if (error instanceof InvalidVestError) return { code: "bad-vest", detail: error.message };
  if (error instanceof InvalidSaleError) return { code: "bad-sale", detail: error.message };
  if (error instanceof InvalidSharePriceError) return { code: "bad-price", detail: error.message };
  if (error instanceof InvalidDailyCloseError) return { code: "bad-closes", detail: error.message };
  if (error instanceof InvalidGpWindowError) return { code: "bad-window", detail: error.message };
  if (isUniqueViolation(error)) return { code: "duplicate-reference" };
  return { code: "failed" };
}

function readText(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}

function currencyFrom(form: FormData, field: string, fallback: Currency = "USD"): Currency {
  const currency = readText(form, field);
  return isCurrency(currency) ? currency : fallback;
}

function sharesFrom(form: FormData, field: string, fail: (message: string) => Error): number {
  const text = readText(form, field).trim().replace(/[,\s]/g, "");
  const shares = Number(text);
  if (text.length === 0 || !Number.isFinite(shares)) {
    throw fail(`מספר מניות לא תקין: ${JSON.stringify(readText(form, field))}`);
  }
  return shares;
}

async function requirePerson(): Promise<void> {
  const email = await requireHouseholdEmail();
  const person = await findPersonByEmail(email);
  if (person === null) {
    backTo({ code: "no-person", detail: email });
  }
}

async function run(work: () => Promise<Outcome>): Promise<never> {
  let outcome: Outcome;
  try {
    outcome = await work();
  } catch (error) {
    outcome = failureFor(error);
  }
  revalidatePath("/rsu");
  backTo(outcome);
}

async function grantFrom(form: FormData): Promise<Grant> {
  const grants = await loadGrants();
  return requireGrant(grants, readText(form, "grantId"));
}

// --- grants ------------------------------------------------------------------

/**
 * A grant as the document states it: an ID, a date, a number of shares. The GP may
 * be stated here too when the ESOP statement gives it — that is a fact, and it is
 * recorded as one.
 */
export async function createGrant(form: FormData): Promise<void> {
  await requirePerson();

  await run(async () => {
    const stated = parseSharePriceInput(readText(form, "grantPrice"), currencyFrom(form, "currency"));

    const grant = await insertGrant(crypto.randomUUID(), {
      personId: readText(form, "personId"),
      reference: readText(form, "reference"),
      grantedOn: tryParseDateKey(readText(form, "grantedOn")) ?? dateOf(new Date()),
      totalShares: sharesFrom(form, "totalShares", (message) => new InvalidGrantError(message)),
      grantPrice: stated === null ? null : statedGrantPrice(stated),
    });
    return { code: null, done: `grant-added:${grant.reference}` };
  });
}

export async function removeGrant(form: FormData): Promise<void> {
  await requirePerson();

  await run(async () => {
    await deleteGrant(readText(form, "grantId"));
    return { code: null, done: "grant-removed:" };
  });
}

/** GP read off an ESOP document. A fact, and recorded as one — no window, no sample. */
export async function stateGrantPrice(form: FormData): Promise<void> {
  await requirePerson();

  await run(async () => {
    const grant = await grantFrom(form);
    const stated = parseSharePriceInput(readText(form, "grantPrice"), currencyFrom(form, "currency"));

    await updateGrant(
      buildGrant(grant.id, {
        ...grant,
        grantPrice: stated === null ? null : statedGrantPrice(stated),
      }),
    );
    return { code: null, done: stated === null ? `gp-cleared:${grant.reference}` : `gp-stated:${grant.reference}` };
  });
}

/**
 * GP estimated from closes over the household's window. Not a fact, and it is
 * stored saying so: the window and the sample size travel with the figure, so
 * nothing downstream can print it as though somebody had measured it.
 */
export async function estimateGrantPriceFromCloses(form: FormData): Promise<void> {
  await requirePerson();

  await run(async () => {
    const grant = await grantFrom(form);
    const settings = await loadHouseholdSettings();
    const currency = currencyFrom(form, "currency");

    const closes = parseDailyCloses(readText(form, "closes"), currency);
    const estimate = estimateGrantPrice({
      closes,
      grantedOn: grant.grantedOn,
      window: settings.gpWindow,
    });

    if (estimate === null) {
      // An average over nothing is not an estimate. Better no figure than one
      // nothing was behind.
      return {
        code: "no-closes",
        detail: `הודבקו ${closes.length} סגירות, ואף אחת מהן אינה בתוך החלון.`,
      };
    }

    await updateGrant(buildGrant(grant.id, { ...grant, grantPrice: estimate }));
    return { code: null, done: `gp-estimated:${grant.reference}` };
  });
}

// --- vests -------------------------------------------------------------------

/**
 * A vest, recorded ahead of its date as readily as after it. Nothing marks it as
 * future: the position holds it out of itself by comparing its date to the day it
 * is read on.
 */
export async function addVest(form: FormData): Promise<void> {
  await requirePerson();

  await run(async () => {
    const { grants, vests } = await loadRsuRecords();
    const grant = requireGrant(grants, readText(form, "grantId"));

    const priceAtVest = parseSharePriceInput(readText(form, "price"), currencyFrom(form, "currency"));
    if (priceAtVest === null) {
      throw new InvalidVestError("יש להזין את מחיר המניה ביום ההבשלה");
    }
    const shares = sharesFrom(form, "shares", (message) => new InvalidVestError(message));

    requireWithinGrant({ grant, vests, additionalShares: shares });

    const vest = await insertVest(
      crypto.randomUUID(),
      {
        grantId: grant.id,
        vestedOn: tryParseDateKey(readText(form, "vestedOn")) ?? dateOf(new Date()),
        shares,
        priceAtVest,
      },
      grant,
    );
    return { code: null, done: `vest-added:${vest.shares}` };
  });
}

/** Removing a lot takes the sales against it too: they were sales of that lot. */
export async function removeVest(form: FormData): Promise<void> {
  await requirePerson();

  await run(async () => {
    await deleteVest(readText(form, "vestId"));
    return { code: null, done: "vest-removed:" };
  });
}

// --- sales -------------------------------------------------------------------

/**
 * Shares leaving one named lot. Checked against that lot before it is written, so
 * the state where more left a lot than was ever in it never exists.
 */
export async function recordSale(form: FormData): Promise<void> {
  await requirePerson();

  await run(async () => {
    const { vests, sales } = await loadRsuRecords();
    const vest = requireVest(vests, readText(form, "vestId"));

    const price = parseSharePriceInput(readText(form, "price"), currencyFrom(form, "currency"));
    if (price === null) {
      throw new InvalidSaleError("יש להזין את מחיר המכירה למניה");
    }
    const shares = sharesFrom(form, "shares", (message) => new InvalidSaleError(message));

    requireWithinLot({ vest, sales, additionalShares: shares });

    const sale = await insertSale(
      crypto.randomUUID(),
      {
        vestId: vest.id,
        soldOn: tryParseDateKey(readText(form, "soldOn")) ?? dateOf(new Date()),
        shares,
        price,
      },
      vest,
    );
    return { code: null, done: `sale-recorded:${sale.shares}` };
  });
}

/** Remove a sale. Always safe: taking one out can only put shares back in the lot. */
export async function removeSale(form: FormData): Promise<void> {
  await requirePerson();

  await run(async () => {
    await deleteSale(readText(form, "saleId"));
    return { code: null, done: "sale-removed:" };
  });
}
