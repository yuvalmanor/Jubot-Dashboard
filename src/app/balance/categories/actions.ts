"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  applyCategoryMerge,
  loadCategories,
  renameHouseholdCategory,
  setPersonalCategoryLifespan,
} from "@/db/categories";
import { findPersonByEmail } from "@/db/people";
import {
  type Categories,
  CategoryTypeMismatchError,
  DuplicateCategoryNameError,
  InvalidCategoryNameError,
  InvalidLifespanError,
  InvalidMergeError,
  UnknownCategoryError,
  findPersonalCategory,
  personalCategoriesOf,
  planCategoryMerge,
  planHouseholdRename,
  planLifespanChange,
} from "@/domain/categories/categories";
import { tryParseMonthKey } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

/**
 * The lifecycle writes: renaming a household line, merging two of them, moving a
 * personal category to a different household line, and opening or closing a
 * lifespan.
 *
 * None of them touches `entries`. Every one is a change to the taxonomy over the
 * amounts, which is why running any of them over four years of history is safe:
 * the figures are the same rows before and after, read under a different heading.
 */

export type CategoriesErrorCode =
  | "no-person"
  | "not-yours"
  | "bad-name"
  | "duplicate-name"
  | "type-mismatch"
  | "unknown-category"
  | "bad-lifespan"
  | "bad-merge"
  | "failed";

interface Outcome {
  readonly code: CategoriesErrorCode | null;
  readonly detail?: string;
  readonly done?: string;
}

/** A Person edits their own categories. The household lines belong to both. */
class NotYoursError extends Error {
  constructor(readonly categoryName: string) {
    super(`${categoryName} belongs to the other person`);
    this.name = "NotYoursError";
  }
}

function backTo(outcome: Outcome): never {
  const params = new URLSearchParams();
  if (outcome.code !== null) params.set("error", outcome.code);
  if (outcome.detail !== undefined) params.set("detail", outcome.detail);
  if (outcome.done !== undefined) params.set("done", outcome.done);
  const query = params.toString();
  redirect(query.length === 0 ? "/balance/categories" : `/balance/categories?${query}`);
}

function failureFor(error: unknown): Outcome {
  if (error instanceof NotYoursError) return { code: "not-yours", detail: error.categoryName };
  if (error instanceof DuplicateCategoryNameError) return { code: "duplicate-name", detail: error.categoryName };
  if (error instanceof InvalidCategoryNameError) return { code: "bad-name" };
  if (error instanceof CategoryTypeMismatchError) return { code: "type-mismatch" };
  if (error instanceof UnknownCategoryError) return { code: "unknown-category" };
  if (error instanceof InvalidLifespanError) return { code: "bad-lifespan" };
  if (error instanceof InvalidMergeError) return { code: "bad-merge" };
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

/** A Person may move or retire only their own categories. */
function requireOwn(categories: Categories, personalCategoryId: string, personId: string) {
  const category = findPersonalCategory(categories, personalCategoryId);
  if (category === undefined) {
    throw new UnknownCategoryError(personalCategoryId);
  }
  if (category.personId !== personId) {
    throw new NotYoursError(category.name);
  }
  return category;
}

async function run(work: () => Promise<Outcome>): Promise<never> {
  let outcome: Outcome;
  try {
    outcome = await work();
  } catch (error) {
    outcome = failureFor(error);
  }
  revalidatePath("/balance/categories");
  revalidatePath("/balance");
  backTo(outcome);
}

export async function renameHousehold(form: FormData): Promise<void> {
  await requirePersonId();

  await run(async () => {
    const rename = planHouseholdRename(
      await loadCategories(),
      readText(form, "householdCategoryId"),
      readText(form, "householdName"),
    );
    await renameHouseholdCategory(rename);
    return { code: null, done: `renamed:${rename.name}` };
  });
}

/**
 * Merge one household line into another: every personal category feeding the
 * source is routed to the target, and the emptied source is dropped. No personal
 * name changes and no amount moves.
 */
export async function mergeHouseholds(form: FormData): Promise<void> {
  await requirePersonId();

  await run(async () => {
    const categories = await loadCategories();
    const sourceId = readText(form, "sourceHouseholdCategoryId");
    const targetId = readText(form, "targetHouseholdCategoryId");

    const members = personalCategoriesOf(categories, sourceId);
    if (members.length === 0) {
      throw new InvalidMergeError(`Household category ${sourceId} has nothing feeding it`);
    }

    const merge = planCategoryMerge(
      categories,
      {
        personalCategoryIds: members.map((category) => category.id),
        household: { kind: "existing", id: targetId },
      },
      { householdCategoryId: crypto.randomUUID() },
    );
    await applyCategoryMerge(merge);
    return { code: null, done: `merged:${merge.household.name}` };
  });
}

/** Move one personal category to another household line — or to a new one. */
export async function reassignPersonalCategory(form: FormData): Promise<void> {
  const personId = await requirePersonId();

  await run(async () => {
    const categories = await loadCategories();
    const personalCategoryId = readText(form, "personalCategoryId");
    requireOwn(categories, personalCategoryId, personId);

    const choice = readText(form, "householdCategoryId");
    const merge = planCategoryMerge(
      categories,
      {
        personalCategoryIds: [personalCategoryId],
        household:
          choice === "" || choice === "new"
            ? { kind: "new", name: readText(form, "newHouseholdName") }
            : { kind: "existing", id: choice },
      },
      { householdCategoryId: crypto.randomUUID() },
    );
    await applyCategoryMerge(merge);
    return { code: null, done: `merged:${merge.household.name}` };
  });
}

/**
 * Open or close a lifespan. Retiring is `activeUntil`; moving `activeFrom`
 * earlier is what makes an older month enterable. Neither deletes anything.
 */
export async function setLifespan(form: FormData): Promise<void> {
  const personId = await requirePersonId();

  await run(async () => {
    const categories = await loadCategories();
    const personalCategoryId = readText(form, "personalCategoryId");
    const category = requireOwn(categories, personalCategoryId, personId);

    const change = planLifespanChange(categories, personalCategoryId, {
      activeFrom: tryParseMonthKey(readText(form, "activeFrom")) ?? category.activeFrom,
      activeUntil: tryParseMonthKey(readText(form, "activeUntil")),
    });
    await setPersonalCategoryLifespan(change);
    return { code: null, done: `lifespan:${category.name}` };
  });
}
