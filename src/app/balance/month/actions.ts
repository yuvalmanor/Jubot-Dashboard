"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { insertPersonalCategory, loadCategories } from "@/db/categories";
import { type EntryWrite, saveMonthEntries } from "@/db/ledger";
import { findPersonByEmail } from "@/db/people";
import {
  type CategoryType,
  CategoryTypeMismatchError,
  DuplicateCategoryNameError,
  InvalidCategoryNameError,
  UnknownCategoryError,
  isCategoryType,
  personalCategoriesFor,
  planPersonalCategoryCreation,
} from "@/domain/categories/categories";
import { InvalidMoneyError, parseMoneyInput } from "@/domain/money/money";
import { type CalendarMonth, monthKey, monthOf, tryParseMonthKey } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

/**
 * The two writes of the מאזן: saving a month, and creating a category while in
 * the middle of saving one.
 *
 * Both actions receive the whole form, so creating a category also persists the
 * amounts already typed. Entry is never interrupted to do taxonomy admin, and
 * nothing typed is lost to the round trip.
 *
 * חיסכון is not among the fields either action reads. There is nothing to write:
 * it is הכנסות − הוצאות, computed on read.
 */

/** The ledger is kept in shekels. Explicit, never assumed from context. */
const LEDGER_CURRENCY = "ILS" as const;

const AMOUNT_FIELD_PREFIX = "amount:";

export type BalanceErrorCode =
  | "no-person"
  | "bad-amount"
  | "bad-name"
  | "duplicate-name"
  | "type-mismatch"
  | "unknown-household"
  | "failed";

/** An amount that could not be read, named by the category it was typed against. */
class BadAmountError extends Error {
  constructor(readonly categoryName: string) {
    super(`Amount for ${categoryName} is not a number`);
    this.name = "BadAmountError";
  }
}

interface Outcome {
  readonly code: BalanceErrorCode | null;
  readonly detail?: string;
  readonly saved?: boolean;
  readonly created?: string;
}

function backTo(month: CalendarMonth, outcome: Outcome): never {
  const params = new URLSearchParams({ month: monthKey(month) });
  if (outcome.code !== null) params.set("error", outcome.code);
  if (outcome.detail !== undefined) params.set("detail", outcome.detail);
  if (outcome.saved === true) params.set("saved", "1");
  if (outcome.created !== undefined) params.set("created", outcome.created);
  redirect(`/balance/month?${params.toString()}`);
}

function failureFor(error: unknown): Outcome {
  if (error instanceof BadAmountError) return { code: "bad-amount", detail: error.categoryName };
  if (error instanceof InvalidMoneyError) return { code: "bad-amount" };
  if (error instanceof DuplicateCategoryNameError) return { code: "duplicate-name", detail: error.categoryName };
  if (error instanceof InvalidCategoryNameError) return { code: "bad-name" };
  if (error instanceof CategoryTypeMismatchError) return { code: "type-mismatch" };
  if (error instanceof UnknownCategoryError) return { code: "unknown-household" };
  return { code: "failed" };
}

function readText(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}

function monthFrom(form: FormData): CalendarMonth {
  return tryParseMonthKey(readText(form, "month")) ?? monthOf(new Date());
}

/**
 * Collect the typed amounts for the categories this Person actually owns. A field
 * naming someone else's category is ignored rather than trusted — the form is
 * client input, and a Person writes only their own ledger.
 */
async function collectWrites(form: FormData, personId: string): Promise<EntryWrite[]> {
  const categories = await loadCategories();

  const writes: EntryWrite[] = [];
  for (const category of personalCategoriesFor(categories, personId)) {
    const field = `${AMOUNT_FIELD_PREFIX}${category.id}`;
    if (!form.has(field)) continue;
    try {
      // Blank clears the figure back to *not recorded*, which is not zero.
      writes.push({
        personalCategoryId: category.id,
        amount: parseMoneyInput(readText(form, field), LEDGER_CURRENCY),
      });
    } catch {
      throw new BadAmountError(category.name);
    }
  }
  return writes;
}

async function requirePerson(month: CalendarMonth): Promise<{ id: string }> {
  const email = await requireHouseholdEmail();
  const person = await findPersonByEmail(email);
  if (person === null) {
    backTo(month, { code: "no-person", detail: email });
  }
  return person;
}

export async function saveMonth(form: FormData): Promise<void> {
  const month = monthFrom(form);
  const person = await requirePerson(month);

  let outcome: Outcome;
  try {
    await saveMonthEntries(month, await collectWrites(form, person.id));
    outcome = { code: null, saved: true };
  } catch (error) {
    outcome = failureFor(error);
  }

  // Both screens read these entries: the month that was written, and the year
  // grid that now shows it.
  revalidatePath("/balance/month");
  revalidatePath("/balance");
  backTo(month, outcome);
}

export async function createCategoryAndSaveMonth(form: FormData): Promise<void> {
  const month = monthFrom(form);
  const person = await requirePerson(month);

  const rawType = readText(form, "newCategoryType");
  const type: CategoryType = isCategoryType(rawType) ? rawType : "expense";
  const householdChoice = readText(form, "newCategoryHousehold");

  let outcome: Outcome;
  try {
    // The amounts already typed are saved first, so creating a category never
    // costs the entry that prompted it.
    await saveMonthEntries(month, await collectWrites(form, person.id));

    const creation = planPersonalCategoryCreation(
      await loadCategories(),
      {
        personId: person.id,
        name: readText(form, "newCategoryName"),
        type,
        activeFrom: month,
        household:
          householdChoice === "" || householdChoice === "new"
            ? { kind: "new", name: readText(form, "newHouseholdName") }
            : { kind: "existing", id: householdChoice },
      },
      { personalCategoryId: crypto.randomUUID(), householdCategoryId: crypto.randomUUID() },
    );

    await insertPersonalCategory(creation);
    outcome = { code: null, created: creation.personal.name };
  } catch (error) {
    outcome = failureFor(error);
  }

  // Both screens read these entries: the month that was written, and the year
  // grid that now shows it.
  revalidatePath("/balance/month");
  revalidatePath("/balance");
  backTo(month, outcome);
}
