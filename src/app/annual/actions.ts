"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  deleteAnnualReview,
  deleteProjectValuation,
  findAnnualReviewFor,
  insertAnnualReview,
  saveAnnualReview,
  saveProjectValuation,
} from "@/db/annual";
import { findPersonByEmail } from "@/db/people";
import { loadProjects } from "@/db/projects";
import { findSnapshot, loadSnapshotHeaders } from "@/db/snapshots";
import {
  type AnnualReview,
  InvalidAnnualReviewError,
  UnknownAnnualReviewError,
  buildAnnualReview,
  closesOn,
} from "@/domain/annual/annual-review";
import {
  type Currency,
  type ExchangeRate,
  InvalidMoneyError,
  exchangeRate,
  isCurrency,
  parseMoneyInput,
} from "@/domain/money/money";
import { UnknownProjectError, requireProject } from "@/domain/projects/projects";
import {
  type SharePrice,
  InvalidSharePriceError,
  parseSharePriceInput,
} from "@/domain/rsu/rsu-position";
import { compareDates, dateOf } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

/**
 * Writing the סיכום שנתי — and it writes very little, on purpose.
 *
 * Per ADR 0002 the only things stored are the facts the closing day alone could
 * supply: which reading the year closed on, the rate, the share price, and the
 * valuations placed on the projects. There is no action here that writes a
 * הכנסות figure, a חיסכון figure or a net-worth total, because every one of them
 * is recomputed from records that still exist — a review that stored them would
 * be a second copy of the ledger, going stale behind the first correction.
 *
 * Nothing here writes a ledger entry, a snapshot, an account, a project or a
 * position either. A review is a reading of those, and the arrow points one way.
 */

export type AnnualErrorCode =
  | "no-person"
  | "bad-review"
  | "duplicate-year"
  | "unknown-review"
  | "bad-valuation"
  | "unknown-project"
  | "failed";

interface Outcome {
  readonly code: AnnualErrorCode | null;
  readonly detail?: string;
  readonly done?: string;
  /** The year's page to land back on; the list when there is none. */
  readonly year?: number | null;
}

function backTo(outcome: Outcome): never {
  const params = new URLSearchParams();
  if (outcome.code !== null) params.set("error", outcome.code);
  if (outcome.detail !== undefined) params.set("detail", outcome.detail);
  if (outcome.done !== undefined) params.set("done", outcome.done);

  const path =
    outcome.year === undefined || outcome.year === null ? "/annual" : `/annual/${outcome.year}`;
  const search = params.toString();
  redirect((search.length === 0 ? path : `${path}?${search}`) as Route);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function failureFor(error: unknown): Omit<Outcome, "year"> {
  if (error instanceof InvalidAnnualReviewError) return { code: "bad-review", detail: error.message };
  if (error instanceof UnknownAnnualReviewError) return { code: "unknown-review" };
  if (error instanceof UnknownProjectError) return { code: "unknown-project" };
  if (error instanceof InvalidSharePriceError) return { code: "bad-review", detail: error.message };
  if (error instanceof InvalidMoneyError) return { code: "bad-valuation", detail: error.message };
  if (isUniqueViolation(error)) return { code: "duplicate-year" };
  return { code: "failed" };
}

async function run(year: number | null, work: () => Promise<Outcome>): Promise<never> {
  let outcome: Outcome;
  try {
    outcome = await work();
  } catch (error) {
    outcome = { ...failureFor(error), year };
  }
  revalidatePath("/annual");
  if (year !== null) revalidatePath(`/annual/${year}`);
  revalidatePath("/annual/compare");
  backTo({ year, ...outcome });
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

function yearFrom(form: FormData, field = "year"): number {
  const year = Number(readText(form, field).trim());
  if (!Number.isInteger(year)) {
    throw new InvalidAnnualReviewError(`שנה לא תקינה: ${readText(form, field)}`);
  }
  return year;
}

function currencyFrom(form: FormData, field: string): Currency {
  const currency = readText(form, field);
  if (!isCurrency(currency)) {
    throw new InvalidAnnualReviewError(`מטבע לא מוכר: ${currency}`);
  }
  return currency;
}

/**
 * A rate typed into a field. Blank is `null` — "we do not know what the rate was"
 * is a legitimate state, and it reads as a named missing fact rather than as a
 * figure somebody invented.
 */
function rateFrom(form: FormData, field: string): ExchangeRate | null {
  const text = readText(form, field).trim().replace(/,/g, "");
  if (text.length === 0) return null;
  const rate = Number(text);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new InvalidAnnualReviewError(`שער לא תקין: ${text}`);
  }
  return exchangeRate("USD", "ILS", rate);
}

function sharePriceFrom(form: FormData, field: string, currencyField: string): SharePrice | null {
  const text = readText(form, field);
  if (text.trim().length === 0) return null;
  return parseSharePriceInput(text, currencyFrom(form, currencyField));
}

async function reviewFrom(form: FormData): Promise<AnnualReview> {
  const year = yearFrom(form);
  const review = await findAnnualReviewFor(year);
  if (review === null) throw new UnknownAnnualReviewError(year);
  return review;
}

// --- creating a review ---------------------------------------------------------

/**
 * The facts the closing day supplied, proposed from what the household already
 * recorded: the last מיפוי taken on or before 31 December, and the rate and share
 * price that reading was taken at.
 *
 * They are proposals and not derivations — every one of them stays editable, and
 * the review stores its own copy. A rate read off a reading two weeks before the
 * close is the household's best record of the closing rate, and it is far better
 * than a blank field somebody fills from memory a year later.
 */
async function seedFrom(year: number): Promise<{
  snapshotId: string | null;
  rate: ExchangeRate | null;
  price: SharePrice | null;
}> {
  try {
    const closing = closesOn(year);
    const headers = await loadSnapshotHeaders();
    // Newest first out of the database: the first one not after the close is the
    // reading the year ended on.
    const header = headers.find((candidate) => compareDates(candidate.takenOn, closing) <= 0);
    if (header === undefined) return { snapshotId: null, rate: null, price: null };

    const snapshot = await findSnapshot(header.id);
    const stored =
      snapshot?.rates.find((rate) => rate.from === "USD" && rate.to === "ILS") ?? null;

    return { snapshotId: header.id, rate: stored, price: header.rsuPrice };
  } catch {
    // A reading that cannot be loaded seeds nothing. The review is created either
    // way — a year is still a year with no מיפוי behind it.
    return { snapshotId: null, rate: null, price: null };
  }
}

export async function createAnnualReview(form: FormData): Promise<void> {
  await requirePerson();
  const year = Number(readText(form, "year").trim());

  await run(Number.isInteger(year) ? year : null, async () => {
    const seeded = await seedFrom(yearFrom(form));
    const review = await insertAnnualReview({
      year: yearFrom(form),
      note: readText(form, "note"),
      recordedOn: dateOf(new Date()),
      closingSnapshotId: seeded.snapshotId,
      closingRate: seeded.rate,
      closingSharePrice: seeded.price,
    });

    return { code: null, done: `created:${review.year}`, year: review.year };
  });
}

// --- the frozen facts ----------------------------------------------------------

/**
 * Correct what the review froze. Clearing a field is allowed and means exactly
 * what it says — the fact is not known — so the page names it as missing instead
 * of printing a figure nobody stated.
 */
export async function saveFrozenFacts(form: FormData): Promise<void> {
  await requirePerson();
  const year = Number(readText(form, "year").trim());

  await run(Number.isInteger(year) ? year : null, async () => {
    const existing = await reviewFrom(form);
    const snapshotId = readText(form, "closingSnapshotId").trim();

    await saveAnnualReview(
      buildAnnualReview({
        year: existing.year,
        recordedOn: existing.recordedOn,
        note: readText(form, "note"),
        closingSnapshotId: snapshotId.length === 0 ? null : snapshotId,
        closingRate: rateFrom(form, "closingRate"),
        closingSharePrice: sharePriceFrom(form, "closingSharePrice", "sharePriceCurrency"),
        valuations: existing.valuations,
      }),
    );

    return { code: null, done: `facts-saved:${existing.year}` };
  });
}

// --- the valuations ------------------------------------------------------------

/**
 * What a project was judged to be worth at the close. Per ADR 0003 this is not a
 * re-valuation of the asset: it is stored on the review, beside the cost the
 * funding legs still add up to, and nothing writes it into מיפוי.
 *
 * A blank amount withdraws the judgement rather than recording a worth of nothing.
 */
export async function saveValuation(form: FormData): Promise<void> {
  await requirePerson();
  const year = Number(readText(form, "year").trim());

  await run(Number.isInteger(year) ? year : null, async () => {
    const review = await reviewFrom(form);
    const project = requireProject(await loadProjects(), readText(form, "projectId"));
    const amount = parseMoneyInput(readText(form, "amount"), currencyFrom(form, "currency"));

    if (amount === null) {
      await deleteProjectValuation(review.year, project.id);
      return { code: null, done: `valuation-removed:${project.name}` };
    }
    if (amount.minorUnits < 0) {
      throw new InvalidAnnualReviewError("הערכת שווי אינה יכולה להיות שלילית");
    }

    await saveProjectValuation(review.year, { projectId: project.id, amount });
    return { code: null, done: `valuation-saved:${project.name}` };
  });
}

// --- removing a review ---------------------------------------------------------

/**
 * Drop a review. It takes its frozen facts with it and nothing else: every other
 * figure on the page was read out of records this cannot reach, and they are all
 * still there afterwards.
 */
export async function removeAnnualReview(form: FormData): Promise<void> {
  await requirePerson();

  await run(null, async () => {
    const review = await reviewFrom(form);
    await deleteAnnualReview(review.year);
    return { code: null, done: `removed:${review.year}`, year: null };
  });
}
