import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { type ImportPlan } from "@/domain/import/sheet-importer";
import { type CalendarMonth, monthKey } from "@/domain/time/calendar-month";

import { type TransactionQuery, query, withTransaction } from "./client";

/**
 * Reading the sheet export from disk, and writing a confirmed import.
 *
 * The domain plans in its own keys (src/domain/import); real ids are allocated
 * here. Everything lands in one transaction, so an import either happened or did
 * not — a half-written history with entries pointing at categories that were
 * never created is the one outcome worth ruling out entirely.
 *
 * Every statement is an upsert, which makes running the import twice safe. That
 * matters more than it sounds: the first run is the one that surfaces what the
 * sheet actually contains, and being able to correct the review and run it again
 * is the difference between a reviewable import and a one-shot gamble.
 */

/** Where the export lives. Committed, so the import is reproducible. */
const EXPORT_PATH = join("docs", "source", "maazan-sheet-export.md");

export class SheetExportMissingError extends Error {
  constructor(readonly path: string) {
    super(`The sheet export was not found at ${path}`);
    this.name = "SheetExportMissingError";
  }
}

export async function readSheetExport(): Promise<string> {
  try {
    return await readFile(join(process.cwd(), EXPORT_PATH), "utf8");
  } catch {
    throw new SheetExportMissingError(EXPORT_PATH);
  }
}

export interface ImportOutcome {
  readonly households: number;
  readonly categories: number;
  readonly entries: number;
}

function firstOfMonth(month: CalendarMonth): string {
  return `${monthKey(month)}-01`;
}

interface IdRow extends Record<string, unknown> {
  id: string;
}

async function upsertHouseholds(run: TransactionQuery, plan: ImportPlan): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const household of plan.households) {
    // `do update` rather than `do nothing` so the row is returned either way; the
    // name it sets is the name that is already there.
    const rows = await run<IdRow>(
      `insert into household_categories (name, type)
       values ($1, $2)
       on conflict (name, type) do update set name = excluded.name
       returning id`,
      [household.name, household.type],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error(`Household category ${household.name} was neither inserted nor found`);
    }
    ids.set(household.key, id);
  }

  return ids;
}

async function upsertCategories(
  run: TransactionQuery,
  plan: ImportPlan,
  householdIds: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const category of plan.categories) {
    // On an existing category the import may only widen the lifespan backwards,
    // which is what makes an older month enterable. It never closes one: a
    // retirement the household set by hand is their decision, not the sheet's.
    const rows = await run<IdRow>(
      `insert into personal_categories (person_id, name, type, active_from, active_until)
       values ($1, $2, $3, $4::date, $5::date)
       on conflict (person_id, name) do update
         set active_from = least(personal_categories.active_from, excluded.active_from)
       returning id`,
      [
        category.personId,
        category.name,
        category.type,
        firstOfMonth(category.activeFrom),
        category.activeUntil === null ? null : firstOfMonth(category.activeUntil),
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error(`Personal category ${category.personId}:${category.name} was neither inserted nor found`);
    }
    ids.set(category.key, id);

    const householdId = householdIds.get(category.householdKey);
    if (householdId === undefined) {
      throw new Error(`Category ${category.key} names household ${category.householdKey}, which was not written`);
    }

    // `do nothing`, so re-importing never undoes a merge or a reassignment the
    // household made afterwards. A category created by this run still gets its
    // assignment, which is what the deferred constraint checks at commit.
    await run(
      `insert into category_assignments (personal_category_id, household_category_id, type)
       values ($1, $2, $3)
       on conflict (personal_category_id) do nothing`,
      [id, householdId, category.type],
    );
  }

  return ids;
}

/** Postgres caps a statement at 65535 parameters; five per entry leaves ample room. */
const ENTRY_CHUNK = 500;

async function upsertEntries(
  run: TransactionQuery,
  plan: ImportPlan,
  categoryIds: ReadonlyMap<string, string>,
): Promise<number> {
  let written = 0;

  for (let offset = 0; offset < plan.entries.length; offset += ENTRY_CHUNK) {
    const chunk = plan.entries.slice(offset, offset + ENTRY_CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];

    for (const entry of chunk) {
      const categoryId = categoryIds.get(entry.categoryKey);
      if (categoryId === undefined) {
        throw new Error(`Entry names category ${entry.categoryKey}, which was not written`);
      }
      const base = values.length;
      values.push(categoryId, entry.month.year, entry.month.month, entry.amount.minorUnits, entry.amount.currency);
      tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    }

    if (tuples.length === 0) continue;

    await run(
      `insert into entries (personal_category_id, year, month, amount_minor, currency)
       values ${tuples.join(", ")}
       on conflict (personal_category_id, year, month) do update
         set amount_minor = excluded.amount_minor,
             currency     = excluded.currency,
             updated_at   = now()`,
      values,
    );
    written += tuples.length;
  }

  return written;
}

export async function applyImportPlan(plan: ImportPlan): Promise<ImportOutcome> {
  return withTransaction(async (run) => {
    const householdIds = await upsertHouseholds(run, plan);
    const categoryIds = await upsertCategories(run, plan, householdIds);
    const entries = await upsertEntries(run, plan, categoryIds);

    return { households: householdIds.size, categories: categoryIds.size, entries };
  });
}

/**
 * What is already recorded. The review screen states this before writing, so an
 * import over an existing ledger is a decision rather than a surprise.
 */
export async function countRecorded(): Promise<{ categories: number; entries: number }> {
  const rows = await query<{ categories: string; entries: string }>(
    `select (select count(*) from personal_categories) as categories,
            (select count(*) from entries)             as entries`,
  );
  const row = rows[0];
  return {
    categories: Number(row?.categories ?? 0),
    entries: Number(row?.entries ?? 0),
  };
}
