import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Execution is the only scenario operation that writes recorded data, and it is
 * explicit.
 *
 * The domain module cannot write anything: it holds no database client (ADR 0004)
 * and returns no Entry, Snapshot line, Account or Project. But the *area* is what
 * the criterion is about, and the area includes its persistence and its server
 * actions — so this reads them off disk and asserts two things.
 *
 * **Everything but execution writes nothing recorded.** A planning screen that
 * quietly corrected a ledger entry would be exactly the failure the household is
 * protected from by never planning in the same place it records. No statement in
 * the area writes a recorded table, and no file imports another area's writer to
 * reach one through somebody else's function.
 *
 * **Execution is one named function in one file.** `src/db/plan-execution.ts` is
 * allowed to import exactly one writer — the project area's own `insertFundingLeg`,
 * so a leg created by executing a plan is validated the same way a leg typed into
 * the project screen is — and it is the only file in the area allowed to import
 * anything at all. One exception, findable by name, or the guard fails.
 *
 * The same shape as `architecture.test.ts`: a rule worth stating is worth a guard
 * that keeps it from eroding one query at a time.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const path = (...parts: string[]) => join(REPOSITORY_ROOT, ...parts);

/** The one file where planning writes something recorded, and the one way in. */
const EXECUTION_FILE = path("src", "db", "plan-execution.ts");
const EXECUTION_ENTRY_POINT = "executeFundingPlan";
/** The only writer from another area the exception may reach for. */
const EXECUTION_WRITER = "insertFundingLeg";
/** The only file allowed to call the exception at all. */
const EXECUTION_CALLER = path("src", "app", "planning", "actions.ts");

/** Every file the planning area is made of, plus its persistence. */
const PLANNING_SOURCES = [
  path("src", "db", "planning.ts"),
  EXECUTION_FILE,
  ...sourceFiles(path("src", "app", "planning")),
];

/** Everything but the one deliberate exception. */
const PLANNING_SOURCES_BUT_EXECUTION = PLANNING_SOURCES.filter((file) => file !== EXECUTION_FILE);

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
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [file];
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

interface Import {
  readonly specifier: string;
  readonly bindings: readonly string[];
}

function importsIn(source: string): readonly Import[] {
  return [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)].map(
    ([, bindings = "", specifier = ""]) => ({
      specifier,
      bindings: bindings
        .split(",")
        .map((binding) => (binding.split(" as ")[0] ?? "").trim().replace(/^type\s+/, ""))
        .filter((binding) => binding.length > 0),
    }),
  );
}

/**
 * The area reads other areas freely — the pace comes out of the Ledger, the seeded
 * figures out of מיפוי, the Deal Terms off the projects. What it must not import is
 * a *writer*, because a write reached through somebody else's function reaches the
 * same table. The area's own writers are what it is for.
 */
const OWN = ["@/db/planning", "./planning", "./actions", "../actions"];
const WRITER_NAME = /^(insert|update|save|delete|set|apply|execute)[A-Z]/;

function foreignWriters(source: string): readonly string[] {
  return importsIn(source)
    .filter((line) => !OWN.includes(line.specifier))
    .flatMap((line) => line.bindings)
    .filter((binding) => WRITER_NAME.test(binding));
}

const named = (file: string) => relative(REPOSITORY_ROOT, file).split(sep).join("/");

/**
 * The whole exception, in one place: two files, one binding each, and nothing
 * anywhere else. `plan-execution.ts` may reach the project area's own leg writer;
 * `actions.ts` may reach `plan-execution.ts`'s single entry point. Every other file
 * in לוח תכנון may reach neither.
 */
const ALLOWED_FOREIGN_WRITERS = new Map<string, readonly string[]>([
  [EXECUTION_FILE, [EXECUTION_WRITER]],
  [EXECUTION_CALLER, [EXECUTION_ENTRY_POINT]],
]);

describe("no scenario operation writes recorded data, except executing a plan", () => {
  it("finds the planning area on disk, including the one exception", () => {
    expect(PLANNING_SOURCES.length).toBeGreaterThan(1);
    expect(PLANNING_SOURCES).toContain(EXECUTION_FILE);
    expect(PLANNING_SOURCES_BUT_EXECUTION).not.toContain(EXECUTION_FILE);
  });

  it.each(PLANNING_SOURCES)("%s writes to no recorded table", (file) => {
    const source = readFileSync(file, "utf8");
    expect(RECORDED_TABLES.filter((table) => writesTo(source, table))).toEqual([]);
  });

  it.each(PLANNING_SOURCES)("%s imports only the write paths it is allowed", (file) => {
    expect(foreignWriters(readFileSync(file, "utf8"))).toEqual(
      ALLOWED_FOREIGN_WRITERS.get(file) ?? [],
    );
  });

  it("allows exactly two files to reach a writer at all", () => {
    const reaching = PLANNING_SOURCES.filter(
      (file) => foreignWriters(readFileSync(file, "utf8")).length > 0,
    );
    expect(reaching.map(named).sort()).toEqual([named(EXECUTION_CALLER), named(EXECUTION_FILE)].sort());
  });
});

describe("executing a plan is one named function in one file", () => {
  it("reaches exactly one writer from another area, and it is the funding leg's own", () => {
    expect(foreignWriters(readFileSync(EXECUTION_FILE, "utf8"))).toEqual([EXECUTION_WRITER]);
  });

  it("is called from one place, by name, and nothing else is taken from it", () => {
    const callers = PLANNING_SOURCES.filter((file) =>
      importsIn(readFileSync(file, "utf8")).some(
        (line) => line.specifier === "@/db/plan-execution",
      ),
    );

    expect(callers.map(named)).toEqual([named(EXECUTION_CALLER)]);
    expect(
      importsIn(readFileSync(EXECUTION_CALLER, "utf8"))
        .filter((line) => line.specifier === "@/db/plan-execution")
        .flatMap((line) => line.bindings),
    ).toEqual([EXECUTION_ENTRY_POINT]);
  });

  it("records that it happened only where it happens", () => {
    const writers = PLANNING_SOURCES.filter((file) =>
      writesTo(readFileSync(file, "utf8"), "funding_plan_executions"),
    );
    expect(writers.map(named)).toEqual([named(EXECUTION_FILE)]);
  });

  it("is refused a second time by the domain and by the database alike", () => {
    const schema = readFileSync(path("db", "schema.sql"), "utf8");
    // The scenario is the primary key, so the row cannot be written twice; and the
    // reference to `scenarios` does not cascade, so an executed scenario cannot be
    // deleted out from under the legs it created.
    expect(schema).toMatch(/scenario_id\s+uuid\s+primary key references scenarios \(id\)\s*,/);
  });
});
