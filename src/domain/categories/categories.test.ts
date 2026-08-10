import { describe, expect, it } from "vitest";

import { calendarMonth } from "@/domain/time/calendar-month";

import {
  type Categories,
  type CreatePersonalCategoryRequest,
  CategoryTypeMismatchError,
  DuplicateCategoryNameError,
  EMPTY_CATEGORIES,
  InvalidCategoryNameError,
  MalformedCategoriesError,
  UnassignedPersonalCategoryError,
  UnknownCategoryError,
  applyCreation,
  buildCategories,
  findPersonalCategory,
  householdCategoriesFor,
  householdCategoryOf,
  isRetired,
  normaliseCategoryName,
  personalCategoriesFor,
  personalCategoriesOf,
  planPersonalCategoryCreation,
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
});
