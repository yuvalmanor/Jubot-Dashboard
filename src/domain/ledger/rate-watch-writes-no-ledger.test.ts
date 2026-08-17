import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * מעקב תעריפים writes its own two tables and nothing else.
 *
 * This is the plan's load-bearing decision, and it cannot be tested by reading a
 * figure: the annual money is *already counted in the מאזן* — when the car
 * insurance is paid, that shekel is typed into a Personal Category — so a panel
 * that also wrote it to `entries` would double-count it, and the double count
 * would look like an ordinary rise in spending.
 *
 * The domain module cannot write anything: it holds no database client (ADR 0004)
 * and returns no Entry. But the *area* is what the criterion is about, so this
 * reads the area off disk — its persistence, its server actions and its panel —
 * and asserts that no statement in it writes a recorded table, and that no file in
 * it imports another area's writer to reach one through somebody else's function.
 *
 * The same shape as `writes-nothing-recorded.test.ts` in לוח תכנון, and for the
 * same reason: a rule worth stating is worth a guard that keeps it from eroding
 * one query at a time.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const path = (...parts: string[]) => join(REPOSITORY_ROOT, ...parts);

/** Every file מעקב תעריפים is made of, outside the pure domain. */
const RATE_WATCH_SOURCES = [
  path("src", "db", "rate-watch.ts"),
  path("src", "app", "balance", "rate-actions.ts"),
  path("src", "app", "balance", "rate-watch-panel.tsx"),
];

/** The tables that hold what actually happened. The panel may read them; it writes none. */
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
  "annual_reviews",
];

/** `insert into entries`, `update accounts set`, `delete from projects` — any of them. */
function writesTo(source: string, table: string): boolean {
  return [
    new RegExp(`insert\\s+into\\s+${table}\\b`, "i"),
    new RegExp(`update\\s+${table}\\b`, "i"),
    new RegExp(`delete\\s+from\\s+${table}\\b`, "i"),
    new RegExp(`truncate\\s+(table\\s+)?${table}\\b`, "i"),
  ].some((pattern) => pattern.test(source));
}

function importsIn(source: string): readonly { specifier: string; bindings: readonly string[] }[] {
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

/** The area's own writers are what it is for; anybody else's are a way round the rule. */
const OWN = ["@/db/rate-watch", "./rate-actions"];
const WRITER_NAME = /^(insert|update|save|delete|set|apply|execute)[A-Z]/;

function foreignWriters(source: string): readonly string[] {
  return importsIn(source)
    .filter((line) => !OWN.includes(line.specifier))
    .flatMap((line) => line.bindings)
    .filter((binding) => WRITER_NAME.test(binding))
    // `applyRenewal` and its siblings are the domain's pure in-memory functions,
    // not writers. They return a model; nothing they touch is a table.
    .filter((binding) => !binding.startsWith("apply"));
}

const named = (file: string) => relative(REPOSITORY_ROOT, file).split(sep).join("/");

describe("מעקב תעריפים writes nothing the מאזן counts", () => {
  it("finds the area on disk", () => {
    expect(RATE_WATCH_SOURCES.every((file) => readFileSync(file, "utf8").length > 0)).toBe(true);
  });

  it.each(RATE_WATCH_SOURCES.map(named))("%s writes to no recorded table", (file) => {
    const source = readFileSync(path(...file.split("/")), "utf8");
    expect(RECORDED_TABLES.filter((table) => writesTo(source, table))).toEqual([]);
  });

  it.each(RATE_WATCH_SOURCES.map(named))("%s reaches no other area's writer", (file) => {
    expect(foreignWriters(readFileSync(path(...file.split("/")), "utf8"))).toEqual([]);
  });

  it("writes its own two tables and only from its own persistence", () => {
    const writers = RATE_WATCH_SOURCES.filter((file) => {
      const source = readFileSync(file, "utf8");
      return writesTo(source, "rate_watch_items") || writesTo(source, "rate_watch_renewals");
    });
    expect(writers.map(named)).toEqual([named(path("src", "db", "rate-watch.ts"))]);
  });
});

describe("the database holds the same rules the domain does", () => {
  const schema = readFileSync(path("db", "schema.sql"), "utf8");

  it("stores an amount as integer minor units with an explicit currency", () => {
    expect(schema).toMatch(/amount_minor\s+bigint\s+not null check \(amount_minor > 0\)/);
    expect(schema).toMatch(/currency\s+text\s+not null check \(char_length\(currency\) = 3\)/);
  });

  it("keys a renewal by its item and its day, so two in one year both survive", () => {
    expect(schema).toMatch(/primary key \(item_id, renewed_on\)/);
  });

  it("stores no year column anywhere in the two tables", () => {
    const section = schema.slice(
      schema.indexOf("create table if not exists rate_watch_items"),
      schema.indexOf("-- מיפוי"),
    );
    expect(section.length).toBeGreaterThan(0);
    expect(section).not.toMatch(/^\s*year\s+/m);
  });
});
