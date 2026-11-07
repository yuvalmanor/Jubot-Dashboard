"use server";

import { revalidatePath } from "next/cache";

import {
  applyCategoryMerge,
  insertPersonalCategory,
  loadCategories,
  renameHouseholdCategory,
  renamePersonalCategory,
  setHouseholdCategoryGroup,
  setHouseholdCategoryWatched,
  setPersonalCategoryLifespan,
} from "@/db/categories";
import { findPersonByEmail, listPeople } from "@/db/people";
import {
  type CategoryType,
  CategoryTypeMismatchError,
  DuplicateCategoryNameError,
  InvalidCategoryNameError,
  InvalidGroupError,
  InvalidLifespanError,
  InvalidMergeError,
  UnknownCategoryError,
  applyHouseholdGroup,
  applyHouseholdRename,
  applyHouseholdWatch,
  applyLifespan,
  applyMerge,
  applyPersonalCategoryRename,
  findHouseholdCategory,
  findPersonalCategory,
  isCategoryType,
  householdCategoryOf,
  personalCategoriesOf,
  planCategoryMerge,
  planHouseholdGroup,
  planHouseholdRename,
  planHouseholdWatch,
  planLifespanChange,
  planPersonalCategoryCreation,
  planPersonalCategoryRename,
} from "@/domain/categories/categories";
import { monthKey, monthOf, tryParseMonthKey } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { type ReturnTo, backToGrid, returnToFrom } from "./return-to";

/**
 * The writes of the category panel beneath the grid: creating a personal
 * category, renaming one, renaming a household line, merging two, moving an
 * assignment, and opening or closing a lifespan.
 *
 * None of them touches `entries`. Every one is a change to the taxonomy over the
 * amounts, which is why running any of them over four years of history is safe:
 * the figures are the same rows before and after, read under a different heading.
 * The table above the panel is where that is visible, and `year-grid.test.ts`
 * pins it.
 *
 * **Both People administer both columns.** There is no ownership check here and
 * no `not-yours` outcome: a Personal Category is still one Person's own naming,
 * but administering the taxonomy is housekeeping the household does together —
 * the same rule Phase 21 applied to recording amounts.
 *
 * Two things none of these can do, because the domain has no shape for them:
 * change a category's **type**, and **delete** anything. Retirement is a
 * lifespan, and an emptied household line is a name with no amounts under it.
 */

export type CategoryErrorCode =
  | "no-person"
  | "bad-name"
  | "duplicate-name"
  | "type-mismatch"
  | "unknown-category"
  | "bad-lifespan"
  | "bad-merge"
  | "bad-group"
  | "failed";

interface Outcome {
  readonly code: CategoryErrorCode | null;
  readonly detail?: string;
  /** `<kind>:<subject>` — what the panel says happened, and to what. */
  readonly done?: string;
}

function readText(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}

/** The panel stays open across its own writes: shutting it would read as a reset. */
function backTo(returnTo: ReturnTo, outcome: Outcome): never {
  backToGrid(
    { ...returnTo, admin: "1" },
    { error: outcome.code ?? "", detail: outcome.detail ?? "", done: outcome.done ?? "" },
  );
}

function failureFor(error: unknown): Outcome {
  if (error instanceof DuplicateCategoryNameError) return { code: "duplicate-name", detail: error.categoryName };
  if (error instanceof InvalidCategoryNameError) return { code: "bad-name" };
  if (error instanceof CategoryTypeMismatchError) return { code: "type-mismatch" };
  if (error instanceof UnknownCategoryError) return { code: "unknown-category" };
  if (error instanceof InvalidLifespanError) return { code: "bad-lifespan" };
  if (error instanceof InvalidMergeError) return { code: "bad-merge" };
  if (error instanceof InvalidGroupError) return { code: "bad-group" };
  return { code: "failed" };
}

/**
 * The signed-in Person. Not the owner of what is being changed — either of them
 * administers either column — but the household is two named people, and a
 * session matching neither has no taxonomy to administer.
 */
async function requireSignedInPerson(returnTo: ReturnTo): Promise<{ id: string }> {
  const email = await requireHouseholdEmail();
  const person = await findPersonByEmail(email);
  if (person === null) {
    backTo(returnTo, { code: "no-person", detail: email });
  }
  return person;
}

/** Every screen that reads the taxonomy, and the two that read it beside amounts. */
function revalidateBalance(): void {
  revalidatePath("/balance");
  revalidatePath("/balance/month");
  revalidatePath("/balance/insights");
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

  revalidateBalance();
  backTo(returnTo, outcome);
}

/**
 * Creating a personal category, which until now existed only on the month form —
 * so making one always meant going somewhere you did not want to be.
 *
 * The creation is one indivisible result: the category, the household line it
 * joins or creates, and the assignment between them. There is no shape here that
 * leaves money recorded personally and missing from the household.
 */
export async function createPersonalCategory(form: FormData): Promise<void> {
  await run(form, async () => {
    const categories = await loadCategories();
    const rawType = readText(form, "type");
    const type: CategoryType = isCategoryType(rawType) ? rawType : "expense";
    const householdChoice = readText(form, "householdCategoryId");

    // Whose column it joins is the one the form named, not whoever is signed in.
    const people = await listPeople();
    const requested = readText(form, "personId");
    const personId = people.some((person) => person.id === requested) ? requested : people[0]?.id;
    if (personId === undefined) return { code: "no-person" };

    const creation = planPersonalCategoryCreation(
      categories,
      {
        personId,
        name: readText(form, "name"),
        type,
        // The lifespan starts where the form says, so a category invented today
        // can still cover the months it was actually being spent in.
        activeFrom: tryParseMonthKey(readText(form, "activeFrom")) ?? monthOf(new Date()),
        household:
          householdChoice === "" || householdChoice === "new"
            ? { kind: "new", name: readText(form, "newHouseholdName") }
            : { kind: "existing", id: householdChoice },
      },
      { personalCategoryId: crypto.randomUUID(), householdCategoryId: crypto.randomUUID() },
    );

    await insertPersonalCategory(creation);
    return { code: null, done: `created:${creation.personal.name}` };
  });
}

/**
 * Correcting a personal name — `הלווואות` with three ו's against `הלוואות` with
 * two, which the importer reported and no screen could reach.
 *
 * One column on one row: no household name, no assignment, no amount.
 */
export async function renamePersonal(form: FormData): Promise<void> {
  await run(form, async () => {
    const categories = await loadCategories();
    const rename = planPersonalCategoryRename(
      categories,
      readText(form, "personalCategoryId"),
      readText(form, "name"),
    );
    await renamePersonalCategory(rename);
    return { code: null, done: `personal-renamed:${rename.name}` };
  });
}

export async function renameHousehold(form: FormData): Promise<void> {
  await run(form, async () => {
    const rename = planHouseholdRename(
      await loadCategories(),
      readText(form, "householdCategoryId"),
      readText(form, "name"),
    );
    await renameHouseholdCategory(rename);
    return { code: null, done: `renamed:${rename.name}` };
  });
}

/**
 * Put a household line into מעקב תעריפים, or take it out.
 *
 * The form posts the state it wants rather than the word "toggle", so a stale
 * page cannot flip a flag somebody else has already flipped: pressing the button
 * on a screen drawn before the change lands on the state that screen was showing,
 * which is the state the person meant.
 *
 * It writes one boolean and reaches no amount, so the grid above the panel reads
 * identically before and after.
 */
export async function setWatched(form: FormData): Promise<void> {
  await run(form, async () => {
    const categories = await loadCategories();
    const watched = readText(form, "watched") === "1";
    const change = planHouseholdWatch(categories, readText(form, "householdCategoryId"), watched);
    const category = findHouseholdCategory(categories, change.householdCategoryId);
    await setHouseholdCategoryWatched(change);
    return { code: null, done: `${watched ? "watched" : "unwatched"}:${category?.name ?? ""}` };
  });
}

// --- saving a whole table of them at once ------------------------------------

/**
 * The two tables of the admin panel save the way a spreadsheet does: change as
 * many rows as you like, press once.
 *
 * It used to be a card per category with a button per field — six buttons on a
 * card, thirty-five cards — so renaming four lines cost four page loads, and
 * anything typed into another card was thrown away by the one that was saved.
 * That is the wrong shape for administering a taxonomy, where changes arrive in
 * batches: tagging eleven lines as חשבונות should be eleven selects and one
 * press.
 *
 * Each row is compared against what is stored and only the differences are
 * written, so a save with nothing changed writes nothing. Every write is still
 * one of the same planned, validated operations a single card used — there is no
 * bulk path into the database that goes round the domain — and the order is
 * fixed: names, then Groups, then מעקב, and **merges last**, because a merge is
 * the one operation that deletes a row the earlier ones may have been editing.
 *
 * `entries` is not mentioned here either. Thirty-five rows saved in one press
 * move exactly as much money as thirty-five cards did: none.
 */

function readIds(form: FormData, field: string): readonly string[] {
  return form.getAll(field).filter((value): value is string => typeof value === "string");
}

function readRow(form: FormData, field: string, id: string): string {
  return readText(form, `${field}:${id}`);
}

/** "Nothing to save" is a different answer from "saved", and the panel says which. */
function savedOutcome(changes: number): Outcome {
  return { code: null, done: changes === 0 ? "nothing" : `saved:${changes}` };
}

export async function saveHouseholdCategories(form: FormData): Promise<void> {
  await run(form, async () => {
    let categories = await loadCategories();
    const ids = readIds(form, "id");
    let changes = 0;

    for (const id of ids) {
      const current = findHouseholdCategory(categories, id);
      if (current === undefined) continue;

      const name = readRow(form, "name", id).trim();
      if (name.length > 0 && name !== current.name) {
        const rename = planHouseholdRename(categories, id, name);
        await renameHouseholdCategory(rename);
        categories = applyHouseholdRename(categories, rename);
        changes += 1;
      }

      const group = readRow(form, "group", id).trim();
      if ((group.length === 0 ? null : group) !== current.group) {
        const change = planHouseholdGroup(categories, id, group);
        await setHouseholdCategoryGroup(change);
        categories = applyHouseholdGroup(categories, change);
        changes += 1;
      }

      const watched = readRow(form, "watched", id) === "1";
      if (watched !== current.watched) {
        const change = planHouseholdWatch(categories, id, watched);
        await setHouseholdCategoryWatched(change);
        categories = applyHouseholdWatch(categories, change);
        changes += 1;
      }
    }

    // Last, and against the model as the merges leave it: a merge empties its
    // source and drops it, so a row an earlier merge already removed is skipped
    // rather than failed, and a target named by two merges still resolves.
    for (const id of ids) {
      const targetId = readRow(form, "merge", id);
      if (targetId.length === 0 || targetId === id) continue;
      if (findHouseholdCategory(categories, id) === undefined) continue;
      if (findHouseholdCategory(categories, targetId) === undefined) continue;

      const members = personalCategoriesOf(categories, id);
      if (members.length === 0) continue;

      const merge = planCategoryMerge(
        categories,
        {
          personalCategoryIds: members.map((category) => category.id),
          household: { kind: "existing", id: targetId },
        },
        { householdCategoryId: crypto.randomUUID() },
      );
      await applyCategoryMerge(merge);
      categories = applyMerge(categories, merge);
      changes += 1;
    }

    return savedOutcome(changes);
  });
}

export async function savePersonalCategories(form: FormData): Promise<void> {
  await run(form, async () => {
    let categories = await loadCategories();
    const ids = readIds(form, "id");
    let changes = 0;

    for (const id of ids) {
      const current = findPersonalCategory(categories, id);
      if (current === undefined) continue;

      const name = readRow(form, "name", id).trim();
      if (name.length > 0 && name !== current.name) {
        const rename = planPersonalCategoryRename(categories, id, name);
        await renamePersonalCategory(rename);
        categories = applyPersonalCategoryRename(categories, rename);
        changes += 1;
      }

      const from = tryParseMonthKey(readRow(form, "from", id));
      const untilText = readRow(form, "until", id);
      const until = untilText.length === 0 ? null : tryParseMonthKey(untilText);
      const movedFrom = from !== null && monthKey(from) !== monthKey(current.activeFrom);
      const movedUntil =
        (until === null ? "" : monthKey(until)) !==
        (current.activeUntil === null ? "" : monthKey(current.activeUntil));

      if (movedFrom || movedUntil) {
        const change = planLifespanChange(categories, id, {
          activeFrom: from ?? current.activeFrom,
          activeUntil: until,
        });
        await setPersonalCategoryLifespan(change);
        categories = applyLifespan(categories, change);
        changes += 1;
      }
    }

    // After the renames, for the same reason the household table merges last: a
    // reassignment can empty a household line, and emptying one drops it.
    for (const id of ids) {
      const current = findPersonalCategory(categories, id);
      if (current === undefined) continue;
      const choice = readRow(form, "household", id);
      if (choice.length === 0) continue;
      if (choice === householdCategoryOf(categories, id).id) continue;
      if (choice !== "new" && findHouseholdCategory(categories, choice) === undefined) continue;

      const merge = planCategoryMerge(
        categories,
        {
          personalCategoryIds: [id],
          household:
            choice === "new" ? { kind: "new", name: current.name } : { kind: "existing", id: choice },
        },
        { householdCategoryId: crypto.randomUUID() },
      );
      await applyCategoryMerge(merge);
      categories = applyMerge(categories, merge);
      changes += 1;
    }

    return savedOutcome(changes);
  });
}

/**
 * Mark a household line as part of a Group, or take it out of one.
 *
 * One nullable column on one row, and the same shape as `setWatched` because it
 * is the same kind of thing: a flag over the taxonomy that no total reads. A
 * blank field is how a line leaves its Group — there is no separate "remove"
 * action, because "no group" is a value and not an absence of one.
 */
export async function setGroup(form: FormData): Promise<void> {
  await run(form, async () => {
    const categories = await loadCategories();
    const change = planHouseholdGroup(
      categories,
      readText(form, "householdCategoryId"),
      readText(form, "group"),
    );
    const category = findHouseholdCategory(categories, change.householdCategoryId);
    await setHouseholdCategoryGroup(change);
    return {
      code: null,
      done: `${change.group === null ? "ungrouped" : "grouped"}:${category?.name ?? ""}`,
    };
  });
}

/**
 * Merge one household line into another: every personal category feeding the
 * source is routed to the target, and the emptied source is dropped. No personal
 * name changes and no amount moves.
 */
export async function mergeHouseholds(form: FormData): Promise<void> {
  await run(form, async () => {
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

/**
 * Move one personal category to another household line — or to a new one. The
 * target is never "none": the plan is a reassignment, so there is no moment at
 * which the category is unassigned.
 */
export async function reassignPersonalCategory(form: FormData): Promise<void> {
  await run(form, async () => {
    const categories = await loadCategories();
    const personalCategoryId = readText(form, "personalCategoryId");
    if (findPersonalCategory(categories, personalCategoryId) === undefined) {
      throw new UnknownCategoryError(personalCategoryId);
    }

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
 * earlier is what makes an older month enterable. Neither deletes anything, and
 * every month the category was recorded in keeps reading exactly as it did.
 */
export async function setLifespan(form: FormData): Promise<void> {
  await run(form, async () => {
    const categories = await loadCategories();
    const personalCategoryId = readText(form, "personalCategoryId");
    const category = findPersonalCategory(categories, personalCategoryId);
    if (category === undefined) {
      throw new UnknownCategoryError(personalCategoryId);
    }

    const change = planLifespanChange(categories, personalCategoryId, {
      activeFrom: tryParseMonthKey(readText(form, "activeFrom")) ?? category.activeFrom,
      activeUntil: tryParseMonthKey(readText(form, "activeUntil")),
    });
    await setPersonalCategoryLifespan(change);
    return { code: null, done: `lifespan:${category.name}` };
  });
}
