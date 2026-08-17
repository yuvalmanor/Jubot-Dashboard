/**
 * Categories — Personal Categories, Household Categories, and the Assignment
 * between them.
 *
 * Framework-free per ADR 0004.
 *
 * The spreadsheet's central failure was that whether a personal row reached the
 * household total was expressed by where a SUM range happened to stop. Here the
 * household level is not maintained at all: a Household Category is *defined* as
 * the sum of the Personal Categories assigned to it, and the assignment is a row
 * anyone can look at.
 *
 * The invariant this module exists to hold: **no Personal Category is ever
 * unassigned.** Creating one is not "insert a category, then remember to file
 * it" — `planPersonalCategoryCreation` returns the category, the household
 * category it joins, and the assignment as one indivisible result. There is no
 * shape this module can produce that leaves money recorded personally and
 * missing from the household.
 *
 * The lifecycle operations obey the same rule. A merge moves an assignment from
 * one Household Category to another and never removes it; retirement closes a
 * lifespan and never deletes a row; a rename — of either level — changes one name
 * column and nothing else. Nothing here can make a recorded amount unreachable,
 * which is why every one of them is safe to run over four years of history.
 *
 * Two things this module deliberately cannot do: change a category's **type**,
 * which is fixed at creation because a category does not change direction from
 * month to month, and **delete** anything. There is no `plan…Deletion` and no
 * shape that drops a Personal Category, because the amounts recorded against one
 * are still money that happened.
 */

import { type CalendarMonth, compareMonths } from "@/domain/time/calendar-month";

export type CategoryType = "income" | "expense";

export const CATEGORY_TYPES: readonly CategoryType[] = ["income", "expense"];

export function isCategoryType(value: unknown): value is CategoryType {
  return value === "income" || value === "expense";
}

export interface PersonalCategory {
  readonly id: string;
  readonly personId: string;
  /** Named by the Person who owns it. Yuval's בריאות and Eden's רפואה are two of these. */
  readonly name: string;
  /** Fixed at creation. A category does not change direction from month to month. */
  readonly type: CategoryType;
  readonly activeFrom: CalendarMonth;
  /**
   * Retirement is a lifespan, never a delete: the last month the category is
   * offered for entry, inclusive. `null` means it is still in use. A retired
   * category keeps resolving for every month it appears in.
   */
  readonly activeUntil: CalendarMonth | null;
}

export interface HouseholdCategory {
  readonly id: string;
  /** Its own name. Renaming it changes no personal name. */
  readonly name: string;
  readonly type: CategoryType;
}

export interface CategoryAssignment {
  readonly personalCategoryId: string;
  readonly householdCategoryId: string;
}

export interface Categories {
  readonly personal: readonly PersonalCategory[];
  readonly household: readonly HouseholdCategory[];
  readonly assignments: readonly CategoryAssignment[];
}

export class UnassignedPersonalCategoryError extends Error {
  constructor(readonly personalCategoryId: string) {
    super(`Personal category ${personalCategoryId} is not assigned to a household category`);
    this.name = "UnassignedPersonalCategoryError";
  }
}

export class UnknownCategoryError extends Error {
  constructor(readonly categoryId: string) {
    super(`No such category: ${categoryId}`);
    this.name = "UnknownCategoryError";
  }
}

export class CategoryTypeMismatchError extends Error {
  constructor(
    readonly personalType: CategoryType,
    readonly householdType: CategoryType,
  ) {
    super(`A ${personalType} category cannot be assigned to a ${householdType} household category`);
    this.name = "CategoryTypeMismatchError";
  }
}

export class DuplicateCategoryNameError extends Error {
  // Deliberately not called `name`: that is Error's own field, and shadowing it
  // would leave the class unable to say which name clashed.
  constructor(readonly categoryName: string) {
    super(`A category named "${categoryName}" already exists`);
    this.name = "DuplicateCategoryNameError";
  }
}

export class InvalidCategoryNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCategoryNameError";
  }
}

export class InvalidLifespanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLifespanError";
  }
}

export class InvalidMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMergeError";
  }
}

/** The supplied set of categories is not a valid model — a bug or corrupt data, not user error. */
export class MalformedCategoriesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedCategoriesError";
  }
}

/** Trim and collapse inner whitespace. `"  אוכל   APPLE "` and `"אוכל APPLE"` are one name. */
export function normaliseCategoryName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function sameName(left: string, right: string): boolean {
  return normaliseCategoryName(left).toLocaleLowerCase() === normaliseCategoryName(right).toLocaleLowerCase();
}

function requireName(name: string): string {
  const normalised = normaliseCategoryName(name);
  if (normalised.length === 0) {
    throw new InvalidCategoryNameError("A category name cannot be empty");
  }
  if (normalised.length > 60) {
    throw new InvalidCategoryNameError(`A category name cannot exceed 60 characters, received ${normalised.length}`);
  }
  return normalised;
}

export const EMPTY_CATEGORIES: Categories = { personal: [], household: [], assignments: [] };

/**
 * Build and validate. Every rule the database enforces is re-checked here, because
 * the domain is also handed data by tests and by the importer, neither of which
 * goes through Postgres.
 */
export function buildCategories(input: {
  readonly personal: readonly PersonalCategory[];
  readonly household: readonly HouseholdCategory[];
  readonly assignments: readonly CategoryAssignment[];
}): Categories {
  const householdById = new Map(input.household.map((category) => [category.id, category]));

  const seen = new Set<string>();
  for (const assignment of input.assignments) {
    if (seen.has(assignment.personalCategoryId)) {
      throw new MalformedCategoriesError(
        `Personal category ${assignment.personalCategoryId} is assigned to more than one household category`,
      );
    }
    seen.add(assignment.personalCategoryId);
  }

  for (const category of input.personal) {
    const assignment = input.assignments.find((row) => row.personalCategoryId === category.id);
    if (assignment === undefined) {
      throw new UnassignedPersonalCategoryError(category.id);
    }
    const household = householdById.get(assignment.householdCategoryId);
    if (household === undefined) {
      throw new UnknownCategoryError(assignment.householdCategoryId);
    }
    if (household.type !== category.type) {
      throw new CategoryTypeMismatchError(category.type, household.type);
    }
    if (category.activeUntil !== null && compareMonths(category.activeUntil, category.activeFrom) < 0) {
      throw new MalformedCategoriesError(`Personal category ${category.id} is retired before it started`);
    }
  }

  return {
    personal: [...input.personal],
    household: [...input.household],
    assignments: [...input.assignments],
  };
}

export function findPersonalCategory(categories: Categories, id: string): PersonalCategory | undefined {
  return categories.personal.find((category) => category.id === id);
}

export function findHouseholdCategory(categories: Categories, id: string): HouseholdCategory | undefined {
  return categories.household.find((category) => category.id === id);
}

/**
 * The Household Category a Personal Category feeds. Total, not partial: reaching
 * this and finding nothing would mean the invariant had been broken, so it throws
 * rather than returning undefined and letting the money quietly disappear.
 */
export function householdCategoryOf(categories: Categories, personalCategoryId: string): HouseholdCategory {
  const assignment = categories.assignments.find((row) => row.personalCategoryId === personalCategoryId);
  if (assignment === undefined) {
    throw new UnassignedPersonalCategoryError(personalCategoryId);
  }
  const household = findHouseholdCategory(categories, assignment.householdCategoryId);
  if (household === undefined) {
    throw new UnknownCategoryError(assignment.householdCategoryId);
  }
  return household;
}

/** The Personal Categories feeding one Household Category. */
export function personalCategoriesOf(
  categories: Categories,
  householdCategoryId: string,
): readonly PersonalCategory[] {
  const ids = new Set(
    categories.assignments
      .filter((row) => row.householdCategoryId === householdCategoryId)
      .map((row) => row.personalCategoryId),
  );
  return sortByName(categories.personal.filter((category) => ids.has(category.id)));
}

function sortByName<T extends { readonly name: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.name.localeCompare(right.name, "he"));
}

export interface CategoryFilter {
  readonly type?: CategoryType;
  /** Keep only categories whose lifespan covers this month. */
  readonly activeIn?: CalendarMonth;
}

function matches(category: PersonalCategory, filter: CategoryFilter): boolean {
  if (filter.type !== undefined && category.type !== filter.type) return false;
  if (filter.activeIn !== undefined && !isActiveIn(category, filter.activeIn)) return false;
  return true;
}

/** Both People's categories, alphabetical in Hebrew. The household level reads from here. */
export function allPersonalCategories(
  categories: Categories,
  filter: CategoryFilter = {},
): readonly PersonalCategory[] {
  return sortByName(categories.personal.filter((category) => matches(category, filter)));
}

/** One Person's categories, alphabetical in Hebrew. */
export function personalCategoriesFor(
  categories: Categories,
  personId: string,
  filter: CategoryFilter = {},
): readonly PersonalCategory[] {
  return sortByName(
    categories.personal.filter((category) => category.personId === personId && matches(category, filter)),
  );
}

/** A category with a retirement month set, whether or not that month has arrived. */
export function isRetired(category: PersonalCategory): boolean {
  return category.activeUntil !== null;
}

/**
 * Whether the category's lifespan covers a month. `activeUntil` is inclusive: a
 * category retired at 2025-06 is active in June and not in July.
 *
 * This decides what is offered for *entry*. It deliberately does not decide what
 * is readable — a month that already holds a figure always shows it, or retiring
 * a category would hide money (see the ledger's `personMonthLines`).
 */
export function isActiveIn(category: PersonalCategory, month: CalendarMonth): boolean {
  if (compareMonths(month, category.activeFrom) < 0) return false;
  return category.activeUntil === null || compareMonths(month, category.activeUntil) <= 0;
}

export function householdCategoriesFor(
  categories: Categories,
  options: { readonly type?: CategoryType } = {},
): readonly HouseholdCategory[] {
  return sortByName(
    categories.household.filter((category) => options.type === undefined || category.type === options.type),
  );
}

/** Where a new Personal Category's money goes at the household level. */
export type HouseholdTarget =
  | { readonly kind: "new"; readonly name: string }
  | { readonly kind: "existing"; readonly id: string };

export interface CreatePersonalCategoryRequest {
  readonly personId: string;
  readonly name: string;
  readonly type: CategoryType;
  readonly activeFrom: CalendarMonth;
  readonly household: HouseholdTarget;
}

/**
 * Everything one creation writes. The assignment is not optional and not deferred:
 * a caller cannot hold this value and write only part of it without noticing.
 */
export interface PersonalCategoryCreation {
  readonly personal: PersonalCategory;
  readonly household: HouseholdCategory;
  /** True when the household category is created by this operation rather than joined. */
  readonly householdIsNew: boolean;
  readonly assignment: CategoryAssignment;
}

export interface NewCategoryIds {
  readonly personalCategoryId: string;
  readonly householdCategoryId: string;
}

/**
 * Plan a creation. Pure: it allocates nothing and asks nothing for an id, so the
 * same request with the same ids always yields the same result.
 */
export function planPersonalCategoryCreation(
  categories: Categories,
  request: CreatePersonalCategoryRequest,
  ids: NewCategoryIds,
): PersonalCategoryCreation {
  const name = requireName(request.name);

  const clash = categories.personal.find(
    (category) => category.personId === request.personId && sameName(category.name, name),
  );
  if (clash !== undefined) {
    throw new DuplicateCategoryNameError(name);
  }

  const { household, householdIsNew } = resolveHousehold(categories, request, name, ids.householdCategoryId);

  if (household.type !== request.type) {
    throw new CategoryTypeMismatchError(request.type, household.type);
  }

  return {
    personal: {
      id: ids.personalCategoryId,
      personId: request.personId,
      name,
      type: request.type,
      activeFrom: request.activeFrom,
      activeUntil: null,
    },
    household,
    householdIsNew,
    assignment: {
      personalCategoryId: ids.personalCategoryId,
      householdCategoryId: household.id,
    },
  };
}

function resolveHousehold(
  categories: Categories,
  request: CreatePersonalCategoryRequest,
  personalName: string,
  newHouseholdId: string,
): { household: HouseholdCategory; householdIsNew: boolean } {
  if (request.household.kind === "existing") {
    const existing = findHouseholdCategory(categories, request.household.id);
    if (existing === undefined) {
      throw new UnknownCategoryError(request.household.id);
    }
    return { household: existing, householdIsNew: false };
  }

  const requested = request.household.name.trim().length === 0 ? personalName : request.household.name;
  const name = requireName(requested);

  // A household name is unique per type, so "the same name already exists" is a
  // question the caller must answer — joining silently would hide a real choice.
  const clash = categories.household.find(
    (category) => category.type === request.type && sameName(category.name, name),
  );
  if (clash !== undefined) {
    throw new DuplicateCategoryNameError(name);
  }

  return {
    household: { id: newHouseholdId, name, type: request.type },
    householdIsNew: true,
  };
}

/** Apply a creation to an in-memory model. Used by tests and by anything holding a snapshot. */
export function applyCreation(categories: Categories, creation: PersonalCategoryCreation): Categories {
  return buildCategories({
    personal: [...categories.personal, creation.personal],
    household: creation.householdIsNew ? [...categories.household, creation.household] : categories.household,
    assignments: [...categories.assignments, creation.assignment],
  });
}

// --- renaming a household category -------------------------------------------

export interface HouseholdCategoryRename {
  readonly householdCategoryId: string;
  readonly name: string;
}

/**
 * The Household Category owns its name. Renaming it touches no Personal Category
 * and no Entry: it is one column on one row, which is the whole point of the
 * household name being its own field rather than borrowed from whichever personal
 * category happened to come first.
 */
export function planHouseholdRename(
  categories: Categories,
  householdCategoryId: string,
  name: string,
): HouseholdCategoryRename {
  const target = findHouseholdCategory(categories, householdCategoryId);
  if (target === undefined) {
    throw new UnknownCategoryError(householdCategoryId);
  }
  const next = requireName(name);

  const clash = categories.household.find(
    (category) => category.id !== target.id && category.type === target.type && sameName(category.name, next),
  );
  if (clash !== undefined) {
    throw new DuplicateCategoryNameError(next);
  }

  return { householdCategoryId: target.id, name: next };
}

export function applyHouseholdRename(categories: Categories, rename: HouseholdCategoryRename): Categories {
  return buildCategories({
    ...categories,
    household: categories.household.map((category) =>
      category.id === rename.householdCategoryId ? { ...category, name: rename.name } : category,
    ),
  });
}

// --- renaming a personal category --------------------------------------------

export interface PersonalCategoryRename {
  readonly personalCategoryId: string;
  readonly name: string;
}

/**
 * A Personal Category's name is the Person's own wording, and until now there was
 * no way to correct it. That gap was not hypothetical: the sheet carried
 * `הלווואות` with three ו's in one column against `הלוואות` in the other, and the
 * importer reported the near-miss to a screen that could do nothing about it.
 *
 * It changes one column on one row. The Household Category has its own name, the
 * assignment is a row of ids, and an Entry points at the category by id — so no
 * household line is renamed, nothing is re-routed and no amount moves. Uniqueness
 * is per Person, exactly as at creation: יובל's בריאות and עדן's רפואה are two
 * categories, and so would be two categories both named בריאות.
 */
export function planPersonalCategoryRename(
  categories: Categories,
  personalCategoryId: string,
  name: string,
): PersonalCategoryRename {
  const target = findPersonalCategory(categories, personalCategoryId);
  if (target === undefined) {
    throw new UnknownCategoryError(personalCategoryId);
  }
  const next = requireName(name);

  const clash = categories.personal.find(
    (category) =>
      category.id !== target.id && category.personId === target.personId && sameName(category.name, next),
  );
  if (clash !== undefined) {
    throw new DuplicateCategoryNameError(next);
  }

  return { personalCategoryId: target.id, name: next };
}

export function applyPersonalCategoryRename(
  categories: Categories,
  rename: PersonalCategoryRename,
): Categories {
  return buildCategories({
    ...categories,
    personal: categories.personal.map((category) =>
      category.id === rename.personalCategoryId ? { ...category, name: rename.name } : category,
    ),
  });
}

// --- merging personal categories under one household line --------------------

export interface CategoryMergeRequest {
  /** The Personal Categories to route into one Household Category. */
  readonly personalCategoryIds: readonly string[];
  readonly household: HouseholdTarget;
}

export interface CategoryMerge {
  readonly household: HouseholdCategory;
  readonly householdIsNew: boolean;
  /** One per requested personal category, all pointing at `household`. */
  readonly assignments: readonly CategoryAssignment[];
  /**
   * Household Categories the merge leaves with nothing feeding them. A Household
   * Category holds no amounts of its own, so an empty one is a name and nothing
   * else — keeping it would clutter every picker and reserve a name for no data.
   */
  readonly emptiedHouseholdCategoryIds: readonly string[];
}

/**
 * Route several Personal Categories into one Household Category — the operation
 * behind "`אוכל APPLE` and `העברות EPP` are the same spend, show them as one line".
 *
 * It moves assignments and nothing else. No Entry is read, written or considered,
 * so no historical personal figure can change: the household breakdown is
 * recomputed from the new assignments at read time, and the household totals are
 * the same money counted under a different heading.
 */
export function planCategoryMerge(
  categories: Categories,
  request: CategoryMergeRequest,
  ids: { readonly householdCategoryId: string },
): CategoryMerge {
  const requested = [...new Set(request.personalCategoryIds)];
  if (requested.length === 0) {
    throw new InvalidMergeError("A merge needs at least one personal category");
  }

  const members = requested.map((id) => {
    const category = findPersonalCategory(categories, id);
    if (category === undefined) {
      throw new UnknownCategoryError(id);
    }
    return category;
  });

  const { household, householdIsNew } = resolveMergeTarget(categories, request, members, ids.householdCategoryId);

  for (const member of members) {
    if (member.type !== household.type) {
      throw new CategoryTypeMismatchError(member.type, household.type);
    }
  }

  const moved = new Set(requested);
  const sources = new Set(members.map((member) => householdCategoryOf(categories, member.id).id));
  sources.delete(household.id);

  // A source is emptied when every assignment still pointing at it is one this
  // merge moves away.
  const emptiedHouseholdCategoryIds = [...sources].filter((sourceId) =>
    categories.assignments.every(
      (assignment) => assignment.householdCategoryId !== sourceId || moved.has(assignment.personalCategoryId),
    ),
  );

  return {
    household,
    householdIsNew,
    assignments: members.map((member) => ({
      personalCategoryId: member.id,
      householdCategoryId: household.id,
    })),
    emptiedHouseholdCategoryIds,
  };
}

function resolveMergeTarget(
  categories: Categories,
  request: CategoryMergeRequest,
  members: readonly PersonalCategory[],
  newHouseholdId: string,
): { household: HouseholdCategory; householdIsNew: boolean } {
  if (request.household.kind === "existing") {
    const existing = findHouseholdCategory(categories, request.household.id);
    if (existing === undefined) {
      throw new UnknownCategoryError(request.household.id);
    }
    return { household: existing, householdIsNew: false };
  }

  const first = members[0];
  if (first === undefined) {
    throw new InvalidMergeError("A merge needs at least one personal category");
  }

  const requested = request.household.name.trim().length === 0 ? first.name : request.household.name;
  const name = requireName(requested);

  const clash = categories.household.find(
    (category) => category.type === first.type && sameName(category.name, name),
  );
  if (clash !== undefined) {
    throw new DuplicateCategoryNameError(name);
  }

  return { household: { id: newHouseholdId, name, type: first.type }, householdIsNew: true };
}

export function applyMerge(categories: Categories, merge: CategoryMerge): Categories {
  const moved = new Map(
    merge.assignments.map((assignment) => [assignment.personalCategoryId, assignment.householdCategoryId]),
  );
  const emptied = new Set(merge.emptiedHouseholdCategoryIds);
  const household = merge.householdIsNew ? [...categories.household, merge.household] : categories.household;

  return buildCategories({
    personal: categories.personal,
    household: household.filter((category) => !emptied.has(category.id)),
    assignments: categories.assignments.map((assignment) => {
      const target = moved.get(assignment.personalCategoryId);
      return target === undefined ? assignment : { ...assignment, householdCategoryId: target };
    }),
  });
}

// --- retiring, and reopening, a personal category ----------------------------

export interface CategoryLifespan {
  readonly personalCategoryId: string;
  readonly activeFrom: CalendarMonth;
  /** Inclusive last month, or `null` to put the category back in use. */
  readonly activeUntil: CalendarMonth | null;
}

/**
 * Move a Personal Category's lifespan. Retirement is `activeUntil`; a start
 * earlier than the month of creation is what makes backfilling an old month
 * possible. Neither end deletes anything, so every month the category appears in
 * keeps reading exactly as it did.
 */
export function planLifespanChange(
  categories: Categories,
  personalCategoryId: string,
  lifespan: { readonly activeFrom?: CalendarMonth; readonly activeUntil: CalendarMonth | null },
): CategoryLifespan {
  const category = findPersonalCategory(categories, personalCategoryId);
  if (category === undefined) {
    throw new UnknownCategoryError(personalCategoryId);
  }

  const activeFrom = lifespan.activeFrom ?? category.activeFrom;
  if (lifespan.activeUntil !== null && compareMonths(lifespan.activeUntil, activeFrom) < 0) {
    throw new InvalidLifespanError("A category cannot be retired before the month it starts in");
  }

  return { personalCategoryId, activeFrom, activeUntil: lifespan.activeUntil };
}

export function applyLifespan(categories: Categories, change: CategoryLifespan): Categories {
  return buildCategories({
    ...categories,
    personal: categories.personal.map((category) =>
      category.id === change.personalCategoryId
        ? { ...category, activeFrom: change.activeFrom, activeUntil: change.activeUntil }
        : category,
    ),
  });
}
