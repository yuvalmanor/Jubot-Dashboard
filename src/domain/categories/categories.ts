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
  /** Retirement is a lifespan, never a delete. Always null until Phase 3 sets it. */
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

/** One Person's categories, income first then expense, each alphabetical in Hebrew. */
export function personalCategoriesFor(
  categories: Categories,
  personId: string,
  options: { readonly type?: CategoryType } = {},
): readonly PersonalCategory[] {
  const owned = categories.personal.filter(
    (category) => category.personId === personId && (options.type === undefined || category.type === options.type),
  );
  return sortByName(owned);
}

/** A category not yet retired. Retirement itself arrives in Phase 3. */
export function isRetired(category: PersonalCategory): boolean {
  return category.activeUntil !== null;
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
