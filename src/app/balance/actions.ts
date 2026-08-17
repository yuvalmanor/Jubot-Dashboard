"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { loadCategories } from "@/db/categories";
import { saveMonthEntries } from "@/db/ledger";
import { findPersonByEmail } from "@/db/people";
import { findPersonalCategory } from "@/domain/categories/categories";
import { InvalidMoneyError, parseMoneyInput } from "@/domain/money/money";
import { type CalendarMonth, monthKey, tryParseMonthKey } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { closeOneMonth } from "./close-month";

/**
 * The grid's two writes: one cell, and one month's closing.
 *
 * Both are deliberately small. The grid is where the holes are visible, so filling
 * one should not cost a form of twenty-two fields — and closing a month should
 * cost exactly the month it names and nothing either side of it.
 *
 * Either Person may write into either Person's categories. The household needs a
 * complete ledger more than it needs to know whose hand typed a figure, and both
 * of them administer both columns.
 *
 * Every action returns to the exact view it was called from, so a save never
 * costs the reader the year, the tab, the order or the opened rows.
 */

/** The ledger is kept in shekels. Explicit, never assumed from context. */
const LEDGER_CURRENCY = "ILS" as const;

export type GridErrorCode = "no-person" | "bad-amount" | "unknown-category" | "failed";

interface Outcome {
  readonly code: GridErrorCode | null;
  readonly detail?: string;
  readonly closed?: string;
  readonly zeros?: number;
}

/** Everything the reader had chosen about the table, carried through the write. */
interface ReturnTo {
  readonly year: string;
  readonly view: string;
  readonly sort: string;
  readonly expand: string;
}

function readText(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}

function returnToFrom(form: FormData): ReturnTo {
  return {
    year: readText(form, "year"),
    view: readText(form, "view"),
    sort: readText(form, "sort"),
    expand: readText(form, "expand"),
  };
}

function backTo(returnTo: ReturnTo, outcome: Outcome): never {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(returnTo)) {
    if (value.length > 0) params.set(key, value);
  }
  if (outcome.code !== null) params.set("error", outcome.code);
  if (outcome.detail !== undefined) params.set("detail", outcome.detail);
  if (outcome.closed !== undefined) params.set("closed", outcome.closed);
  if (outcome.zeros !== undefined) params.set("zeros", String(outcome.zeros));
  const query = params.toString();
  redirect(query.length === 0 ? "/balance" : `/balance?${query}`);
}

function failureFor(error: unknown): Outcome {
  if (error instanceof InvalidMoneyError) return { code: "bad-amount" };
  return { code: "failed" };
}

/** Both screens read these entries: the grid, and the month form beneath it. */
function revalidateBalance(): void {
  revalidatePath("/balance");
  revalidatePath("/balance/month");
}

/**
 * The signed-in Person. Not the owner of what is being written — either of them may
 * write either column — but the household is still two named people and a session
 * that matches neither has no business writing into the ledger.
 */
async function requireSignedInPerson(returnTo: ReturnTo): Promise<void> {
  const email = await requireHouseholdEmail();
  const person = await findPersonByEmail(email);
  if (person === null) {
    backTo(returnTo, { code: "no-person", detail: email });
  }
}

/**
 * One cell of the grid. A blank clears the figure back to *not recorded*, which is
 * not a zero — the same rule the month form's fields follow, because it is the
 * same write.
 */
export async function saveCell(form: FormData): Promise<void> {
  const returnTo = returnToFrom(form);
  await requireSignedInPerson(returnTo);

  const month = tryParseMonthKey(readText(form, "month"));
  const categoryId = readText(form, "cell");

  let outcome: Outcome;
  try {
    outcome = await writeCell(month, categoryId, readText(form, "amount"));
  } catch (error) {
    outcome = failureFor(error);
  }

  revalidateBalance();
  backTo(returnTo, outcome);
}

async function writeCell(
  month: CalendarMonth | null,
  categoryId: string,
  typed: string,
): Promise<Outcome> {
  if (month === null) return { code: "failed" };

  // The field names a category, and the form is client input: it is looked up
  // rather than trusted. Whose it is does not matter — both People administer both
  // columns — but it has to be a category that exists.
  const category = findPersonalCategory(await loadCategories(), categoryId);
  if (category === undefined) return { code: "unknown-category" };

  await saveMonthEntries(month, [
    { personalCategoryId: category.id, amount: parseMoneyInput(typed, LEDGER_CURRENCY) },
  ]);
  return { code: null };
}

/**
 * Closing one month from the grid: the blanks named on the panel above the table
 * are written as real zeros, and nothing already recorded moves.
 *
 * The month is a single key on the form and the write is `closeOneMonth`, which
 * takes one month. There is no shape here that could reach two.
 */
export async function closeMonthFromGrid(form: FormData): Promise<void> {
  const returnTo = returnToFrom(form);
  await requireSignedInPerson(returnTo);

  const month = tryParseMonthKey(readText(form, "month"));

  let outcome: Outcome;
  try {
    if (month === null) {
      outcome = { code: "failed" };
    } else {
      const named = form.getAll("blank").filter((value): value is string => typeof value === "string");
      outcome = { code: null, closed: monthKey(month), zeros: await closeOneMonth(month, named) };
    }
  } catch (error) {
    outcome = failureFor(error);
  }

  revalidateBalance();
  backTo(returnTo, outcome);
}
