import { describe, expect, it } from "vitest";

import { calendarMonth } from "@/domain/time/calendar-month";

import {
  type Categories,
  type CreatePersonalCategoryRequest,
  CategoryTypeMismatchError,
  DuplicateCategoryNameError,
  EMPTY_CATEGORIES,
  InvalidCategoryNameError,
  InvalidLifespanError,
  InvalidMergeError,
  MalformedCategoriesError,
  UnassignedPersonalCategoryError,
  UnknownCategoryError,
  allPersonalCategories,
  applyCreation,
  applyHouseholdRename,
  applyLifespan,
  applyMerge,
  applyPersonalCategoryRename,
  buildCategories,
  findHouseholdCategory,
  findPersonalCategory,
  householdCategoriesFor,
  householdCategoryOf,
  isActiveIn,
  isRetired,
  normaliseCategoryName,
  personalCategoriesFor,
  personalCategoriesOf,
  planCategoryMerge,
  planHouseholdRename,
  planLifespanChange,
  planPersonalCategoryCreation,
  planPersonalCategoryRename,
} from "./categories";

const JANUARY_2025 = calendarMonth(2025, 1);

function ids(suffix: string) {
  return { personalCategoryId: `p-${suffix}`, householdCategoryId: `h-${suffix}` };
}

function request(overrides: Partial<CreatePersonalCategoryRequest> = {}): CreatePersonalCategoryRequest {
  return {
    personId: "yuval",
    name: "בריאות",
    type: "expense",
    activeFrom: JANUARY_2025,
    household: { kind: "new", name: "" },
    ...overrides,
  };
}

/** The household's own example: two personal names, one household line. */
function healthHousehold(): Categories {
  const yuval = planPersonalCategoryCreation(
    EMPTY_CATEGORIES,
    request({ personId: "yuval", name: "בריאות", household: { kind: "new", name: "בריאות" } }),
    ids("yuval-health"),
  );
  const afterYuval = applyCreation(EMPTY_CATEGORIES, yuval);
  const eden = planPersonalCategoryCreation(
    afterYuval,
    request({ personId: "eden", name: "רפואה", household: { kind: "existing", id: yuval.household.id } }),
    ids("eden-health"),
  );
  return applyCreation(afterYuval, eden);
}

describe("creating a personal category", () => {
  it("always produces a household category and an assignment in one result", () => {
    const creation = planPersonalCategoryCreation(EMPTY_CATEGORIES, request(), ids("a"));

    expect(creation.personal.id).toBe("p-a");
    expect(creation.household.id).toBe("h-a");
    expect(creation.householdIsNew).toBe(true);
    expect(creation.assignment).toEqual({ personalCategoryId: "p-a", householdCategoryId: "h-a" });
  });

  it("names the new household category after the personal one when none is given", () => {
    const creation = planPersonalCategoryCreation(EMPTY_CATEGORIES, request({ name: "חשמל" }), ids("a"));
    expect(creation.household.name).toBe("חשמל");
  });

  it("lets the household category carry a clearer name than the personal one", () => {
    const creation = planPersonalCategoryCreation(
      EMPTY_CATEGORIES,
      request({ name: "אוכל APPLE", household: { kind: "new", name: "הטבת אוכל" } }),
      ids("a"),
    );
    expect(creation.personal.name).toBe("אוכל APPLE");
    expect(creation.household.name).toBe("הטבת אוכל");
  });

  it("joins an existing household category instead of creating one", () => {
    const first = applyCreation(
      EMPTY_CATEGORIES,
      planPersonalCategoryCreation(EMPTY_CATEGORIES, request({ name: "בריאות" }), ids("a")),
    );

    const second = planPersonalCategoryCreation(
      first,
      request({ personId: "eden", name: "רפואה", household: { kind: "existing", id: "h-a" } }),
      ids("b"),
    );

    expect(second.householdIsNew).toBe(false);
    expect(second.household.id).toBe("h-a");
    expect(second.assignment.householdCategoryId).toBe("h-a");
  });

  it("fixes the category type at creation", () => {
    const creation = planPersonalCategoryCreation(EMPTY_CATEGORIES, request({ type: "income" }), ids("a"));
    expect(creation.personal.type).toBe("income");
    expect(creation.household.type).toBe("income");
  });

  it("refuses to assign an expense category to an income household category", () => {
    const income = applyCreation(
      EMPTY_CATEGORIES,
      planPersonalCategoryCreation(EMPTY_CATEGORIES, request({ name: "משכורת", type: "income" }), ids("a")),
    );

    expect(() =>
      planPersonalCategoryCreation(
        income,
        request({ name: "חשמל", type: "expense", household: { kind: "existing", id: "h-a" } }),
        ids("b"),
      ),
    ).toThrow(CategoryTypeMismatchError);
  });

  it("starts the category's lifespan at the requested month and never retired", () => {
    const creation = planPersonalCategoryCreation(
      EMPTY_CATEGORIES,
      request({ activeFrom: calendarMonth(2022, 7) }),
      ids("a"),
    );
    expect(creation.personal.activeFrom).toEqual(calendarMonth(2022, 7));
    expect(creation.personal.activeUntil).toBeNull();
    expect(isRetired(creation.personal)).toBe(false);
  });

  it("is pure — the same request and ids give the same result and change nothing", () => {
    const before = EMPTY_CATEGORIES;
    const one = planPersonalCategoryCreation(before, request(), ids("a"));
    const two = planPersonalCategoryCreation(before, request(), ids("a"));
    expect(one).toEqual(two);
    expect(before.personal).toEqual([]);
  });
});

describe("category names", () => {
  it("collapses whitespace so one name is one name", () => {
    expect(normaliseCategoryName("  אוכל   APPLE ")).toBe("אוכל APPLE");
    const creation = planPersonalCategoryCreation(EMPTY_CATEGORIES, request({ name: "  חשמל  " }), ids("a"));
    expect(creation.personal.name).toBe("חשמל");
  });

  it("refuses an empty name", () => {
    expect(() => planPersonalCategoryCreation(EMPTY_CATEGORIES, request({ name: "   " }), ids("a"))).toThrow(
      InvalidCategoryNameError,
    );
  });

  it("refuses a second category with the same name for the same person", () => {
    const existing = applyCreation(
      EMPTY_CATEGORIES,
      planPersonalCategoryCreation(EMPTY_CATEGORIES, request({ name: "חשמל" }), ids("a")),
    );

    expect(() =>
      planPersonalCategoryCreation(existing, request({ name: " חשמל " }), ids("b")),
    ).toThrow(DuplicateCategoryNameError);
  });

  it("allows the other person to use a name already taken by the first", () => {
    const existing = applyCreation(
      EMPTY_CATEGORIES,
      planPersonalCategoryCreation(EMPTY_CATEGORIES, request({ personId: "yuval", name: "חשמל" }), ids("a")),
    );

    const creation = planPersonalCategoryCreation(
      existing,
      request({ personId: "eden", name: "חשמל", household: { kind: "existing", id: "h-a" } }),
      ids("b"),
    );
    expect(creation.personal.personId).toBe("eden");
  });

  it("refuses a new household category whose name is already taken for that type", () => {
    const existing = applyCreation(
      EMPTY_CATEGORIES,
      planPersonalCategoryCreation(EMPTY_CATEGORIES, request({ name: "בריאות" }), ids("a")),
    );

    expect(() =>
      planPersonalCategoryCreation(
        existing,
        request({ personId: "eden", name: "רפואה", household: { kind: "new", name: "בריאות" } }),
        ids("b"),
      ),
    ).toThrow(DuplicateCategoryNameError);
  });

  it("refuses an unknown household category", () => {
    expect(() =>
      planPersonalCategoryCreation(
        EMPTY_CATEGORIES,
        request({ household: { kind: "existing", id: "missing" } }),
        ids("a"),
      ),
    ).toThrow(UnknownCategoryError);
  });
});

describe("no personal category is ever unassigned", () => {
  it("rejects a model containing a personal category with no assignment", () => {
    expect(() =>
      buildCategories({
        personal: [
          {
            id: "p-1",
            personId: "yuval",
            name: "חשמל",
            type: "expense",
            activeFrom: JANUARY_2025,
            activeUntil: null,
          },
        ],
        household: [{ id: "h-1", name: "חשמל", type: "expense" }],
        assignments: [],
      }),
    ).toThrow(UnassignedPersonalCategoryError);
  });

  it("rejects an assignment pointing at a household category that does not exist", () => {
    expect(() =>
      buildCategories({
        personal: [
          {
            id: "p-1",
            personId: "yuval",
            name: "חשמל",
            type: "expense",
            activeFrom: JANUARY_2025,
            activeUntil: null,
          },
        ],
        household: [],
        assignments: [{ personalCategoryId: "p-1", householdCategoryId: "h-1" }],
      }),
    ).toThrow(UnknownCategoryError);
  });

  it("rejects an assignment across category types", () => {
    expect(() =>
      buildCategories({
        personal: [
          {
            id: "p-1",
            personId: "yuval",
            name: "חשמל",
            type: "expense",
            activeFrom: JANUARY_2025,
            activeUntil: null,
          },
        ],
        household: [{ id: "h-1", name: "משכורת", type: "income" }],
        assignments: [{ personalCategoryId: "p-1", householdCategoryId: "h-1" }],
      }),
    ).toThrow(CategoryTypeMismatchError);
  });

  it("rejects a personal category assigned to two household categories", () => {
    expect(() =>
      buildCategories({
        personal: [
          {
            id: "p-1",
            personId: "yuval",
            name: "חשמל",
            type: "expense",
            activeFrom: JANUARY_2025,
            activeUntil: null,
          },
        ],
        household: [
          { id: "h-1", name: "חשמל", type: "expense" },
          { id: "h-2", name: "בית", type: "expense" },
        ],
        assignments: [
          { personalCategoryId: "p-1", householdCategoryId: "h-1" },
          { personalCategoryId: "p-1", householdCategoryId: "h-2" },
        ],
      }),
    ).toThrow(MalformedCategoriesError);
  });

  it("rejects a category retired before it started", () => {
    expect(() =>
      buildCategories({
        personal: [
          {
            id: "p-1",
            personId: "yuval",
            name: "חשמל",
            type: "expense",
            activeFrom: calendarMonth(2025, 6),
            activeUntil: calendarMonth(2025, 5),
          },
        ],
        household: [{ id: "h-1", name: "חשמל", type: "expense" }],
        assignments: [{ personalCategoryId: "p-1", householdCategoryId: "h-1" }],
      }),
    ).toThrow(MalformedCategoriesError);
  });

  it("every applied creation leaves a model that still validates", () => {
    const categories = healthHousehold();
    expect(() => buildCategories(categories)).not.toThrow();
    for (const personal of categories.personal) {
      expect(householdCategoryOf(categories, personal.id).id).toBe("h-yuval-health");
    }
  });
});

describe("reading the model", () => {
  it("keeps two personal names under one household line", () => {
    const categories = healthHousehold();

    expect(personalCategoriesOf(categories, "h-yuval-health").map((category) => category.name)).toEqual([
      "בריאות",
      "רפואה",
    ]);
    expect(householdCategoriesFor(categories).map((category) => category.name)).toEqual(["בריאות"]);
  });

  it("lists a person's own categories only", () => {
    const categories = healthHousehold();

    expect(personalCategoriesFor(categories, "yuval").map((category) => category.name)).toEqual(["בריאות"]);
    expect(personalCategoriesFor(categories, "eden").map((category) => category.name)).toEqual(["רפואה"]);
  });

  it("filters by category type", () => {
    const withIncome = applyCreation(
      healthHousehold(),
      planPersonalCategoryCreation(
        healthHousehold(),
        request({ personId: "yuval", name: "משכורת", type: "income" }),
        ids("salary"),
      ),
    );

    expect(personalCategoriesFor(withIncome, "yuval", { type: "income" }).map((c) => c.name)).toEqual(["משכורת"]);
    expect(personalCategoriesFor(withIncome, "yuval", { type: "expense" }).map((c) => c.name)).toEqual(["בריאות"]);
    expect(householdCategoriesFor(withIncome, { type: "income" }).map((c) => c.name)).toEqual(["משכורת"]);
  });

  it("finds a personal category by id and reports nothing for an unknown one", () => {
    const categories = healthHousehold();
    expect(findPersonalCategory(categories, "p-eden-health")?.name).toBe("רפואה");
    expect(findPersonalCategory(categories, "nope")).toBeUndefined();
  });

  it("throws rather than losing money when asked for an unassigned category's household", () => {
    expect(() => householdCategoryOf(EMPTY_CATEGORIES, "p-1")).toThrow(UnassignedPersonalCategoryError);
  });

  it("lists both people's categories together for the household level", () => {
    expect(allPersonalCategories(healthHousehold()).map((category) => category.name)).toEqual([
      "בריאות",
      "רפואה",
    ]);
  });
});

/** The state before a merge: one real spend, two personal names, two household lines. */
function separateHealth(): Categories {
  const yuval = planPersonalCategoryCreation(
    EMPTY_CATEGORIES,
    request({ personId: "yuval", name: "אוכל APPLE", household: { kind: "new", name: "אוכל APPLE" } }),
    ids("yuval-food"),
  );
  const afterYuval = applyCreation(EMPTY_CATEGORIES, yuval);
  const eden = planPersonalCategoryCreation(
    afterYuval,
    request({ personId: "eden", name: "העברות EPP", household: { kind: "new", name: "העברות EPP" } }),
    ids("eden-food"),
  );
  return applyCreation(afterYuval, eden);
}

describe("merging personal categories under one household line", () => {
  it("puts both personal categories under the same household category", () => {
    const before = separateHealth();

    const merge = planCategoryMerge(
      before,
      { personalCategoryIds: ["p-eden-food"], household: { kind: "existing", id: "h-yuval-food" } },
      { householdCategoryId: "unused" },
    );
    const after = applyMerge(before, merge);

    expect(householdCategoryOf(after, "p-yuval-food").id).toBe("h-yuval-food");
    expect(householdCategoryOf(after, "p-eden-food").id).toBe("h-yuval-food");
    expect(personalCategoriesOf(after, "h-yuval-food").map((category) => category.name)).toEqual([
      "אוכל APPLE",
      "העברות EPP",
    ]);
  });

  it("changes no personal name and retires nothing", () => {
    const before = separateHealth();
    const after = applyMerge(
      before,
      planCategoryMerge(
        before,
        { personalCategoryIds: ["p-eden-food"], household: { kind: "existing", id: "h-yuval-food" } },
        { householdCategoryId: "unused" },
      ),
    );

    expect(after.personal).toEqual(before.personal);
  });

  it("drops the household category the merge leaves empty", () => {
    const before = separateHealth();
    const merge = planCategoryMerge(
      before,
      { personalCategoryIds: ["p-eden-food"], household: { kind: "existing", id: "h-yuval-food" } },
      { householdCategoryId: "unused" },
    );

    expect(merge.emptiedHouseholdCategoryIds).toEqual(["h-eden-food"]);
    expect(householdCategoriesFor(applyMerge(before, merge)).map((category) => category.name)).toEqual([
      "אוכל APPLE",
    ]);
  });

  it("keeps a source household category that still has another personal category feeding it", () => {
    const before = applyCreation(
      separateHealth(),
      planPersonalCategoryCreation(
        separateHealth(),
        request({ personId: "yuval", name: "אוכל בחוץ", household: { kind: "existing", id: "h-eden-food" } }),
        ids("yuval-eating-out"),
      ),
    );

    const merge = planCategoryMerge(
      before,
      { personalCategoryIds: ["p-eden-food"], household: { kind: "existing", id: "h-yuval-food" } },
      { householdCategoryId: "unused" },
    );

    expect(merge.emptiedHouseholdCategoryIds).toEqual([]);
    expect(householdCategoriesFor(applyMerge(before, merge))).toHaveLength(2);
  });

  it("can merge into a household category named after neither personal one", () => {
    const before = separateHealth();
    const merge = planCategoryMerge(
      before,
      {
        personalCategoryIds: ["p-yuval-food", "p-eden-food"],
        household: { kind: "new", name: "הטבת אוכל" },
      },
      { householdCategoryId: "h-food" },
    );
    const after = applyMerge(before, merge);

    expect(merge.householdIsNew).toBe(true);
    expect(householdCategoriesFor(after).map((category) => category.name)).toEqual(["הטבת אוכל"]);
    expect(personalCategoriesOf(after, "h-food")).toHaveLength(2);
  });

  it("refuses to merge across category types", () => {
    const before = applyCreation(
      separateHealth(),
      planPersonalCategoryCreation(
        separateHealth(),
        request({ personId: "yuval", name: "משכורת", type: "income" }),
        ids("salary"),
      ),
    );

    expect(() =>
      planCategoryMerge(
        before,
        { personalCategoryIds: ["p-salary"], household: { kind: "existing", id: "h-yuval-food" } },
        { householdCategoryId: "unused" },
      ),
    ).toThrow(CategoryTypeMismatchError);
  });

  it("refuses an unknown personal category, an unknown target, and an empty merge", () => {
    const before = separateHealth();

    expect(() =>
      planCategoryMerge(
        before,
        { personalCategoryIds: ["nope"], household: { kind: "existing", id: "h-yuval-food" } },
        { householdCategoryId: "unused" },
      ),
    ).toThrow(UnknownCategoryError);

    expect(() =>
      planCategoryMerge(
        before,
        { personalCategoryIds: ["p-eden-food"], household: { kind: "existing", id: "nope" } },
        { householdCategoryId: "unused" },
      ),
    ).toThrow(UnknownCategoryError);

    expect(() =>
      planCategoryMerge(before, { personalCategoryIds: [], household: { kind: "new", name: "x" } }, {
        householdCategoryId: "unused",
      }),
    ).toThrow(InvalidMergeError);
  });

  it("leaves a model that still validates, with nobody unassigned", () => {
    const before = separateHealth();
    const after = applyMerge(
      before,
      planCategoryMerge(
        before,
        { personalCategoryIds: ["p-eden-food"], household: { kind: "existing", id: "h-yuval-food" } },
        { householdCategoryId: "unused" },
      ),
    );

    expect(() => buildCategories(after)).not.toThrow();
    expect(after.assignments).toHaveLength(after.personal.length);
  });

  it("is pure — planning changes nothing", () => {
    const before = separateHealth();
    planCategoryMerge(
      before,
      { personalCategoryIds: ["p-eden-food"], household: { kind: "existing", id: "h-yuval-food" } },
      { householdCategoryId: "unused" },
    );
    expect(householdCategoryOf(before, "p-eden-food").id).toBe("h-eden-food");
  });
});

describe("renaming a household category", () => {
  it("changes the household name and no personal name", () => {
    const before = healthHousehold();
    const after = applyHouseholdRename(before, planHouseholdRename(before, "h-yuval-health", "  בריאות ורפואה "));

    expect(findHouseholdCategory(after, "h-yuval-health")?.name).toBe("בריאות ורפואה");
    expect(after.personal.map((category) => category.name)).toEqual(
      before.personal.map((category) => category.name),
    );
  });

  it("keeps every assignment pointing where it did", () => {
    const before = healthHousehold();
    const after = applyHouseholdRename(before, planHouseholdRename(before, "h-yuval-health", "בריאות ורפואה"));

    expect(after.assignments).toEqual(before.assignments);
  });

  it("refuses a name already used by another household category of the same type", () => {
    const before = separateHealth();
    expect(() => planHouseholdRename(before, "h-eden-food", "אוכל APPLE")).toThrow(DuplicateCategoryNameError);
  });

  it("allows a household category to be renamed to what it already is", () => {
    const before = separateHealth();
    expect(planHouseholdRename(before, "h-eden-food", "העברות EPP").name).toBe("העברות EPP");
  });

  it("refuses an empty name and an unknown category", () => {
    const before = healthHousehold();
    expect(() => planHouseholdRename(before, "h-yuval-health", "  ")).toThrow(InvalidCategoryNameError);
    expect(() => planHouseholdRename(before, "nope", "בריאות")).toThrow(UnknownCategoryError);
  });
});

describe("renaming a personal category", () => {
  /** The sheet's own near-miss: three ו's in one column against two in the other. */
  function misspelledLoans(): Categories {
    const yuval = planPersonalCategoryCreation(
      EMPTY_CATEGORIES,
      request({ personId: "yuval", name: "הלווואות", household: { kind: "new", name: "הלוואות" } }),
      ids("yuval-loans"),
    );
    const afterYuval = applyCreation(EMPTY_CATEGORIES, yuval);
    const eden = planPersonalCategoryCreation(
      afterYuval,
      request({ personId: "eden", name: "הלוואות", household: { kind: "existing", id: "h-yuval-loans" } }),
      ids("eden-loans"),
    );
    return applyCreation(afterYuval, eden);
  }

  it("corrects הלווואות, which no screen could reach before", () => {
    const before = misspelledLoans();
    const after = applyPersonalCategoryRename(
      before,
      planPersonalCategoryRename(before, "p-yuval-loans", "  הלוואות "),
    );

    expect(findPersonalCategory(after, "p-yuval-loans")?.name).toBe("הלוואות");
  });

  it("changes no household name, no assignment and no other personal category", () => {
    const before = misspelledLoans();
    const after = applyPersonalCategoryRename(
      before,
      planPersonalCategoryRename(before, "p-yuval-loans", "הלוואות"),
    );

    expect(after.household).toEqual(before.household);
    expect(after.assignments).toEqual(before.assignments);
    expect(findPersonalCategory(after, "p-eden-loans")).toEqual(findPersonalCategory(before, "p-eden-loans"));
  });

  it("changes neither the type nor the lifespan of the category it renames", () => {
    const before = misspelledLoans();
    const renamed = applyPersonalCategoryRename(
      before,
      planPersonalCategoryRename(before, "p-yuval-loans", "הלוואות"),
    );

    const was = findPersonalCategory(before, "p-yuval-loans")!;
    const now = findPersonalCategory(renamed, "p-yuval-loans")!;
    expect(now).toEqual({ ...was, name: "הלוואות" });
  });

  it("lets the other person keep a name this one is renaming to", () => {
    // Both People may call a category הלוואות; uniqueness is per Person, exactly
    // as at creation.
    const before = misspelledLoans();
    expect(planPersonalCategoryRename(before, "p-yuval-loans", "הלוואות").name).toBe("הלוואות");
  });

  it("refuses a name the same Person already uses", () => {
    const before = healthHousehold();
    const after = applyCreation(
      before,
      planPersonalCategoryCreation(
        before,
        request({ personId: "yuval", name: "כושר", household: { kind: "new", name: "כושר" } }),
        ids("yuval-fitness"),
      ),
    );

    expect(() => planPersonalCategoryRename(after, "p-yuval-fitness", "בריאות")).toThrow(
      DuplicateCategoryNameError,
    );
  });

  it("allows a category to be renamed to what it already is", () => {
    const before = healthHousehold();
    expect(planPersonalCategoryRename(before, "p-yuval-health", "בריאות").name).toBe("בריאות");
  });

  it("refuses an empty name and an unknown category", () => {
    const before = healthHousehold();
    expect(() => planPersonalCategoryRename(before, "p-yuval-health", "  ")).toThrow(InvalidCategoryNameError);
    expect(() => planPersonalCategoryRename(before, "nope", "בריאות")).toThrow(UnknownCategoryError);
  });

  it("leaves a model that still validates, with nobody unassigned", () => {
    const before = misspelledLoans();
    const after = applyPersonalCategoryRename(
      before,
      planPersonalCategoryRename(before, "p-yuval-loans", "הלוואות"),
    );

    expect(() => buildCategories(after)).not.toThrow();
    expect(after.assignments).toHaveLength(after.personal.length);
  });

  it("is pure — planning changes nothing", () => {
    const before = misspelledLoans();
    planPersonalCategoryRename(before, "p-yuval-loans", "הלוואות");
    expect(findPersonalCategory(before, "p-yuval-loans")?.name).toBe("הלווואות");
  });
});

/**
 * Type is fixed at creation and nothing is ever deleted. Both are load-bearing
 * rather than unimplemented: a category that changed direction would make every
 * month before the change unreadable, and a deleted one would take its recorded
 * amounts with it. This pins the absence, so adding either becomes a deliberate
 * act with a failing test in front of it.
 */
describe("what the lifecycle deliberately cannot do", () => {
  const lifecycle = (before: Categories) => [
    applyPersonalCategoryRename(before, planPersonalCategoryRename(before, "p-yuval-health", "בריאות ושיניים")),
    applyHouseholdRename(before, planHouseholdRename(before, "h-yuval-health", "בריאות המשק")),
    applyMerge(
      before,
      planCategoryMerge(
        before,
        { personalCategoryIds: ["p-eden-health"], household: { kind: "new", name: "רפואה בלבד" } },
        { householdCategoryId: "h-fresh" },
      ),
    ),
    applyLifespan(before, planLifespanChange(before, "p-yuval-health", { activeUntil: JANUARY_2025 })),
  ];

  it("changes no category's type", () => {
    const before = healthHousehold();
    const typesOf = (model: Categories) =>
      model.personal.map((category) => `${category.id}:${category.type}`).sort();

    for (const after of lifecycle(before)) {
      expect(typesOf(after)).toEqual(typesOf(before));
    }
  });

  it("deletes no personal category and drops no recorded amount's home", () => {
    const before = healthHousehold();
    const idsOf = (model: Categories) => model.personal.map((category) => category.id).sort();

    for (const after of lifecycle(before)) {
      expect(idsOf(after)).toEqual(idsOf(before));
      expect(after.assignments).toHaveLength(after.personal.length);
    }
  });
});

describe("a lifespan, never a delete", () => {
  const category = () => healthHousehold().personal[0]!;

  it("covers the months from activeFrom onwards while not retired", () => {
    const open = { ...category(), activeFrom: calendarMonth(2025, 1), activeUntil: null };

    expect(isActiveIn(open, calendarMonth(2024, 12))).toBe(false);
    expect(isActiveIn(open, calendarMonth(2025, 1))).toBe(true);
    expect(isActiveIn(open, calendarMonth(2030, 8))).toBe(true);
  });

  it("treats the retirement month as the last active one", () => {
    const retired = { ...category(), activeFrom: calendarMonth(2025, 1), activeUntil: calendarMonth(2025, 6) };

    expect(isActiveIn(retired, calendarMonth(2025, 5))).toBe(true);
    expect(isActiveIn(retired, calendarMonth(2025, 6))).toBe(true);
    expect(isActiveIn(retired, calendarMonth(2025, 7))).toBe(false);
  });

  it("removes a retired category from a later month and keeps it in the months it covered", () => {
    const before = healthHousehold();
    const after = applyLifespan(
      before,
      planLifespanChange(before, "p-yuval-health", { activeUntil: calendarMonth(2025, 6) }),
    );

    expect(
      personalCategoriesFor(after, "yuval", { activeIn: calendarMonth(2025, 7) }).map((c) => c.name),
    ).toEqual([]);
    expect(
      personalCategoriesFor(after, "yuval", { activeIn: calendarMonth(2025, 6) }).map((c) => c.name),
    ).toEqual(["בריאות"]);
  });

  it("keeps the retired category's row, its name and its assignment", () => {
    const before = healthHousehold();
    const after = applyLifespan(
      before,
      planLifespanChange(before, "p-yuval-health", { activeUntil: calendarMonth(2025, 6) }),
    );

    expect(findPersonalCategory(after, "p-yuval-health")?.name).toBe("בריאות");
    expect(householdCategoryOf(after, "p-yuval-health").id).toBe("h-yuval-health");
    expect(isRetired(findPersonalCategory(after, "p-yuval-health")!)).toBe(true);
  });

  it("puts a retired category back in use", () => {
    const before = healthHousehold();
    const retired = applyLifespan(
      before,
      planLifespanChange(before, "p-yuval-health", { activeUntil: calendarMonth(2025, 6) }),
    );
    const reopened = applyLifespan(retired, planLifespanChange(retired, "p-yuval-health", { activeUntil: null }));

    expect(findPersonalCategory(reopened, "p-yuval-health")?.activeUntil).toBeNull();
  });

  it("moves the start earlier so an older month can be backfilled", () => {
    const before = healthHousehold();
    const after = applyLifespan(
      before,
      planLifespanChange(before, "p-yuval-health", {
        activeFrom: calendarMonth(2022, 1),
        activeUntil: null,
      }),
    );

    expect(isActiveIn(findPersonalCategory(after, "p-yuval-health")!, calendarMonth(2022, 3))).toBe(true);
  });

  it("refuses a retirement before the start and an unknown category", () => {
    const before = healthHousehold();

    expect(() =>
      planLifespanChange(before, "p-yuval-health", {
        activeFrom: calendarMonth(2025, 6),
        activeUntil: calendarMonth(2025, 5),
      }),
    ).toThrow(InvalidLifespanError);
    expect(() => planLifespanChange(before, "nope", { activeUntil: null })).toThrow(UnknownCategoryError);
  });
});
