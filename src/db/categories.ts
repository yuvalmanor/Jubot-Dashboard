import {
  type Categories,
  type CategoryAssignment,
  type CategoryLifespan,
  type CategoryMerge,
  type HouseholdCategory,
  type HouseholdCategoryRename,
  type PersonalCategory,
  type PersonalCategoryCreation,
  type PersonalCategoryRename,
  buildCategories,
  isCategoryType,
} from "@/domain/categories/categories";
import { type CalendarMonth, monthKey, parseMonthKey } from "@/domain/time/calendar-month";

import { query, withTransaction } from "./client";

/**
 * Reading and writing Categories. The domain decides what a creation consists of
 * (src/domain/categories); this writes it.
 *
 * Lifespan columns are `date` in Postgres but a month in the domain, so they are
 * read as `YYYY-MM` text rather than as a Date — a timestamp crossing a timezone
 * is one of the few ways a calendar month can silently become the wrong one.
 */

interface PersonalCategoryRow extends Record<string, unknown> {
  id: string;
  person_id: string;
  name: string;
  type: string;
  active_from: string;
  active_until: string | null;
}

interface HouseholdCategoryRow extends Record<string, unknown> {
  id: string;
  name: string;
  type: string;
}

interface AssignmentRow extends Record<string, unknown> {
  personal_category_id: string;
  household_category_id: string;
}

export class MalformedCategoryRowError extends Error {
  constructor(id: string, detail: string) {
    super(`Category row ${id} is malformed: ${detail}`);
    this.name = "MalformedCategoryRowError";
  }
}

function toPersonalCategory(row: PersonalCategoryRow): PersonalCategory {
  if (!isCategoryType(row.type)) {
    throw new MalformedCategoryRowError(row.id, `unknown category type ${row.type}`);
  }
  return {
    id: row.id,
    personId: row.person_id,
    name: row.name,
    type: row.type,
    activeFrom: parseMonthKey(row.active_from),
    activeUntil: row.active_until === null ? null : parseMonthKey(row.active_until),
  };
}

function toHouseholdCategory(row: HouseholdCategoryRow): HouseholdCategory {
  if (!isCategoryType(row.type)) {
    throw new MalformedCategoryRowError(row.id, `unknown category type ${row.type}`);
  }
  return { id: row.id, name: row.name, type: row.type };
}

function toAssignment(row: AssignmentRow): CategoryAssignment {
  return { personalCategoryId: row.personal_category_id, householdCategoryId: row.household_category_id };
}

/**
 * The whole set. Both people together hold a few dozen categories, so there is no
 * paging to design and no partial view to keep consistent — and the household
 * level cannot be derived from one person's half.
 */
export async function loadCategories(): Promise<Categories> {
  const [personal, household, assignments] = await Promise.all([
    query<PersonalCategoryRow>(
      `select id, person_id, name, type,
              to_char(active_from, 'YYYY-MM')  as active_from,
              to_char(active_until, 'YYYY-MM') as active_until
         from personal_categories`,
    ),
    query<HouseholdCategoryRow>(`select id, name, type from household_categories`),
    query<AssignmentRow>(`select personal_category_id, household_category_id from category_assignments`),
  ]);

  return buildCategories({
    personal: personal.map(toPersonalCategory),
    household: household.map(toHouseholdCategory),
    assignments: assignments.map(toAssignment),
  });
}

function firstOfMonth(month: CalendarMonth): string {
  return `${monthKey(month)}-01`;
}

/**
 * Write a creation. All three rows in one transaction: the deferred constraint in
 * db/schema.sql checks at commit that the personal category has an assignment, so
 * a partial write cannot be committed even by a caller that tried.
 */
export async function insertPersonalCategory(creation: PersonalCategoryCreation): Promise<void> {
  await withTransaction(async (run) => {
    if (creation.householdIsNew) {
      await run(
        `insert into household_categories (id, name, type) values ($1, $2, $3)`,
        [creation.household.id, creation.household.name, creation.household.type],
      );
    }

    await run(
      `insert into personal_categories (id, person_id, name, type, active_from, active_until)
       values ($1, $2, $3, $4, $5::date, null)`,
      [
        creation.personal.id,
        creation.personal.personId,
        creation.personal.name,
        creation.personal.type,
        firstOfMonth(creation.personal.activeFrom),
      ],
    );

    await run(
      `insert into category_assignments (personal_category_id, household_category_id, type)
       values ($1, $2, $3)`,
      [creation.assignment.personalCategoryId, creation.assignment.householdCategoryId, creation.personal.type],
    );
  });
}

/**
 * One column on one row. The assignment is a pair of ids and an entry points at
 * the category by id, so correcting a spelling reaches neither.
 */
export async function renamePersonalCategory(rename: PersonalCategoryRename): Promise<void> {
  await query(`update personal_categories set name = $2 where id = $1`, [
    rename.personalCategoryId,
    rename.name,
  ]);
}

/** One column on one row. No personal category and no entry is touched. */
export async function renameHouseholdCategory(rename: HouseholdCategoryRename): Promise<void> {
  await query(`update household_categories set name = $2 where id = $1`, [
    rename.householdCategoryId,
    rename.name,
  ]);
}

/**
 * Write a merge. The assignments are *updated* rather than deleted and reinserted:
 * an assignment row that briefly does not exist would trip the deferred constraint
 * that says every personal category has one, and — more to the point — there is no
 * moment in this operation at which a personal category is unassigned.
 *
 * `entries` is not mentioned here. A merge moves which household line a category
 * feeds; the amounts underneath are the same rows before and after.
 */
export async function applyCategoryMerge(merge: CategoryMerge): Promise<void> {
  await withTransaction(async (run) => {
    if (merge.householdIsNew) {
      await run(
        `insert into household_categories (id, name, type) values ($1, $2, $3)`,
        [merge.household.id, merge.household.name, merge.household.type],
      );
    }

    for (const assignment of merge.assignments) {
      await run(
        `update category_assignments
            set household_category_id = $2
          where personal_category_id = $1`,
        [assignment.personalCategoryId, assignment.householdCategoryId],
      );
    }

    // Deleted last, once nothing points at them. A household category holds no
    // amounts, so an emptied one is a name and nothing else.
    for (const id of merge.emptiedHouseholdCategoryIds) {
      await run(`delete from household_categories where id = $1`, [id]);
    }
  });
}

/** Retire, reopen, or move the start of a lifespan. The row itself stays forever. */
export async function setPersonalCategoryLifespan(change: CategoryLifespan): Promise<void> {
  await query(
    `update personal_categories
        set active_from  = $2::date,
            active_until = $3::date
      where id = $1`,
    [
      change.personalCategoryId,
      firstOfMonth(change.activeFrom),
      change.activeUntil === null ? null : firstOfMonth(change.activeUntil),
    ],
  );
}
