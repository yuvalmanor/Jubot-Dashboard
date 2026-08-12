import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `Scenarios` reads recorded data and writes none of it.
 *
 * The domain module cannot write anything: it holds no database client (ADR 0004)
 * and returns no Entry, Snapshot line, Account or Project. But the *area* is what
 * the criterion is about, and the area includes its persistence and its server
 * actions — so this reads them off disk and asserts that no statement in לוח תכנון
 * writes to a recorded table. A planning screen that quietly corrected a ledger
 * entry would be exactly the failure the household is protected from by never
 * planning in the same place it records.
 *
 * The same shape as `architecture.test.ts`: a rule worth stating is worth a guard
 * that keeps it from eroding one query at a time.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Every file the planning area is made of, plus its persistence. */
const PLANNING_SOURCES = [
  join(REPOSITORY_ROOT, "src", "db", "planning.ts"),
  ...sourceFiles(join(REPOSITORY_ROOT, "src", "app", "planning")),
];

/** The tables that hold what actually happened. A scenario may read all of them. */
const RECORDED_TABLES = [
  "entries",
  "personal_categories",
  "household_categories",
  "category_assignments",
  "snapshots",
  "snapshot_lines",
  "snapshot_rates",
  "accounts",
  "positions",
  "earmarks",
  "projects",
  "funding_legs",
  "project_expenses",
  "deal_terms",
  "rsu_grants",
  "rsu_vests",
  "rsu_sales",
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

/** `insert into entries`, `update accounts set`, `delete from projects` — any of them. */
function writesTo(source: string, table: string): boolean {
  return [
    new RegExp(`insert\\s+into\\s+${table}\\b`, "i"),
    new RegExp(`update\\s+${table}\\b`, "i"),
    new RegExp(`delete\\s+from\\s+${table}\\b`, "i"),
    new RegExp(`truncate\\s+(table\\s+)?${table}\\b`, "i"),
  ].some((pattern) => pattern.test(source));
}

describe("no scenario operation writes recorded data", () => {
  it("finds the planning area on disk", () => {
    expect(PLANNING_SOURCES.length).toBeGreaterThan(1);
  });

  it.each(PLANNING_SOURCES)("%s writes to no recorded table", (file) => {
    const source = readFileSync(file, "utf8");
    expect(RECORDED_TABLES.filter((table) => writesTo(source, table))).toEqual([]);
  });

  it.each(PLANNING_SOURCES)("%s imports no other area's write path", (file) => {
    const source = readFileSync(file, "utf8");

    // The area reads other areas freely — the pace comes out of the Ledger and the
    // seeded figures out of מיפוי. What it must not import is a *writer*, because a
    // write reached through somebody else's function reaches the same table.
    // The area's own writers are what it is for. `../projects/actions` is not one of
    // these, and neither is any other area's `@/db/…`.
    const OWN = ["@/db/planning", "./planning", "./actions", "../actions"];

    const offenders = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)]
      .filter(([, , specifier = ""]) => !OWN.includes(specifier))
      .flatMap(([, bindings = ""]) => bindings.split(","))
      .map((binding) => (binding.split(" as ")[0] ?? "").trim())
      .filter((binding) => /^(insert|update|save|delete|set|apply)[A-Z]/.test(binding));

    expect(offenders).toEqual([]);
  });
});
