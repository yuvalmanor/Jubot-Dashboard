"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { insertPersonalCategory, loadCategories } from "@/db/categories";
import { type EntryWrite, saveMonthEntries } from "@/db/ledger";
import { findPersonByEmail, listPeople } from "@/db/people";
import {
  type CategoryType,
  CategoryTypeMismatchError,
  DuplicateCategoryNameError,
  InvalidCategoryNameError,
  UnknownCategoryError,
  allPersonalCategories,
  isCategoryType,
  planPersonalCategoryCreation,
} from "@/domain/categories/categories";
import { InvalidMoneyError, parseMoneyInput } from "@/domain/money/money";
import { type CalendarMonth, monthKey, monthOf, tryParseMonthKey } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { closeOneMonth } from "../close-month";

/**
 * The writes of the מאזן's month: saving a month, creating a category while in
 * the middle of saving one, and recording the month's remaining blanks as zero.
 *
 * The first two receive the whole form, so creating a category also persists the
 * amounts already typed. Entry is never interrupted to do taxonomy admin, and
 * nothing typed is lost to the round trip.
 *
 * Either Person may write into either Person's categories. A Personal Category is
 * still one Person's own naming — that is what the name is for — but recording an
 * amount against it is administration, and the household needs a complete ledger
 * more than it needs to know whose hand typed a figure.
 *
 * חיסכון is not among the fields any of them reads. There is nothing to write: it
 * is הכנסות − הוצאות, computed on read.
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
  readonly zeros?: number;
}

/**
 * Back to the month, on the tab it was written from. The view travels with the
 * write now that both tabs accept one: landing on your own categories after
 * saving the other person's would look exactly like the save going somewhere else.
 */
function backTo(month: CalendarMonth, view: string, outcome: Outcome): never {
  const params = new URLSearchParams({ month: monthKey(month) });
  if (view.length > 0) params.set("view", view);
  if (outcome.code !== null) params.set("error", outcome.code);
  if (outcome.detail !== undefined) params.set("detail", outcome.detail);
  if (outcome.saved === true) params.set("saved", "1");
  if (outcome.created !== undefined) params.set("created", outcome.created);
  if (outcome.zeros !== undefined) params.set("zeros", String(outcome.zeros));
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
 * Collect the typed amounts, for whichever Person's categories the form carried.
 * The fields are matched against the categories that exist rather than trusted —
 * the form is client input — but not against who is signed in: both People
 * administer both columns.
 */
async function collectWrites(form: FormData): Promise<EntryWrite[]> {
  const categories = await loadCategories();

  const writes: EntryWrite[] = [];
  for (const category of allPersonalCategories(categories)) {
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

/**
 * The signed-in Person. Not the owner of what is written — either of them may
 * write either column — but the household is two named people, and a session
 * matching neither has no ledger to write into.
 */
async function requireSignedInPerson(month: CalendarMonth, view: string): Promise<{ id: string }> {
  const email = await requireHouseholdEmail();
  const person = await findPersonByEmail(email);
  if (person === null) {
    backTo(month, view, { code: "no-person", detail: email });
  }
  return person;
}

/**
 * Whose column a new category joins: the tab it was created from, not whoever
 * happens to be signed in. Creating עדן's category into יובל's column because
 * יובל pressed the button would be a wrong answer that nothing on the screen
 * would show.
 */
async function ownerFrom(form: FormData, signedInPersonId: string): Promise<string> {
  const requested = readText(form, "owner");
  const people = await listPeople();
  return people.some((person) => person.id === requested) ? requested : signedInPersonId;
}

export async function saveMonth(form: FormData): Promise<void> {
  const month = monthFrom(form);
  const view = readText(form, "view");
  await requireSignedInPerson(month, view);

  let outcome: Outcome;
  try {
    await saveMonthEntries(month, await collectWrites(form));
    outcome = { code: null, saved: true };
  } catch (error) {
    outcome = failureFor(error);
  }

  // Both screens read these entries: the month that was written, and the year
  // grid that now shows it.
  revalidatePath("/balance/month");
  revalidatePath("/balance");
  backTo(month, view, outcome);
}

/**
 * Accepting the offer: the blanks named on the screen become real zeros, and the
 * month is closed. Nothing already recorded is touched, and nothing that was not
 * on the screen is written.
 */
export async function recordBlanksAsZero(form: FormData): Promise<void> {
  const month = monthFrom(form);
  const view = readText(form, "view");
  await requireSignedInPerson(month, view);

  let outcome: Outcome;
  try {
    const named = form.getAll("blank").filter((value): value is string => typeof value === "string");
    outcome = { code: null, zeros: await closeOneMonth(month, named) };
  } catch (error) {
    outcome = failureFor(error);
  }

  revalidatePath("/balance/month");
  revalidatePath("/balance");
  backTo(month, view, outcome);
}

export async function createCategoryAndSaveMonth(form: FormData): Promise<void> {
  const month = monthFrom(form);
  const view = readText(form, "view");
  const person = await requireSignedInPerson(month, view);

  const rawType = readText(form, "newCategoryType");
  const type: CategoryType = isCategoryType(rawType) ? rawType : "expense";
  const householdChoice = readText(form, "newCategoryHousehold");

  let outcome: Outcome;
  try {
    // The amounts already typed are saved first, so creating a category never
    // costs the entry that prompted it.
    await saveMonthEntries(month, await collectWrites(form));

    const creation = planPersonalCategoryCreation(
      await loadCategories(),
      {
        personId: await ownerFrom(form, person.id),
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
  backTo(month, view, outcome);
}
