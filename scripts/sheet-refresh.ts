/**
 * Refreshing `docs/source/maazan-sheet-export.md` from the household's Google Sheet.
 *
 * The export was first taken by hand, which made every later refresh an afternoon
 * and made "is this still what the sheet says?" a question nobody could answer
 * cheaply. This is the answer: the Drive connector reads the sheet, and this
 * script turns what it returns into the file `sheet-export.ts` parses.
 *
 *   Sheet: https://docs.google.com/spreadsheets/d/1tOw032pAwJSVOVv66wnILR1X5rxVVCI2paNAzDdJGLg/edit
 *
 * The conversion itself is `src/domain/import/drive-read.ts`, where it can be
 * tested without a network; this is the shell around it — fetch, report, write.
 *
 * It **proposes**, like the importer it feeds. Without `--write` it reports and
 * changes nothing.
 *
 *   npm run sheet:refresh -- <drive-read>              # report only
 *   npm run sheet:refresh -- <drive-read> --blocks     # and dump every cell
 *   npm run sheet:refresh -- <drive-read> --against-db # and say what an import would move
 *   npm run sheet:refresh -- <drive-read> --write      # rewrite the export
 *
 * `--against-db` is read-only too: it compares the plan against what `DATABASE_URL`
 * already holds and reports what an import *would* write, which is how "re-running
 * changes nothing that was already correct" is checked without writing anything.
 *
 * `<drive-read>` is whatever the Drive connector's `read_file_content` returned:
 * either its JSON result (`{"fileContent": "…"}`) or that string on its own.
 */

import { readFileSync, writeFileSync } from "node:fs";

import pg from "pg";

import { gridOf, isMaazanTable, maazanExportFrom, tablesOf } from "@/domain/import/drive-read";
import {
  type SheetBlock,
  type SheetCell,
  parseSheetExport,
} from "@/domain/import/sheet-export";
import {
  type ImportPlan,
  type ImportProposal,
  type ProposedEntry,
  defaultSelection,
  planSheetImport,
  planWrites,
} from "@/domain/import/sheet-importer";
import { toDecimalString } from "@/domain/money/money";
import { type CalendarMonth, compareMonths, monthKey } from "@/domain/time/calendar-month";

const EXPORT_PATH = "docs/source/maazan-sheet-export.md";
const CURRENCY = "ILS" as const;

const PEOPLE = [
  { id: "yuval", sheetName: "יובל" },
  { id: "eden", sheetName: "עדן" },
] as const;

// --- reading what Drive returned ---------------------------------------------

/** The connector's result, or the Markdown on its own. Both are ordinary files. */
function driveMarkdown(path: string): string {
  const raw = readFileSync(path, "utf8");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "fileContent" in parsed) {
      const content = (parsed as { fileContent: unknown }).fileContent;
      if (typeof content === "string") return content;
    }
  } catch {
    // Not JSON. The Markdown itself, then.
  }
  return raw;
}

// --- describing what was read ------------------------------------------------

function cellText(cell: SheetCell): string {
  switch (cell.kind) {
    case "blank":
      return "";
    case "amount":
      return toDecimalString(cell.amount);
    default:
      return cell.text;
  }
}

function describeMonths(months: readonly CalendarMonth[]): string {
  const first = months[0];
  const last = months[months.length - 1];
  if (first === undefined || last === undefined) return "no months";
  return `${monthKey(first)} – ${monthKey(last)} (${months.length})`;
}

function figuresIn(block: SheetBlock): number {
  return block.rows.reduce(
    (total, row) => total + row.cells.filter((cell) => cell.kind === "amount").length,
    0,
  );
}

// --- comparing two readings --------------------------------------------------

function entriesByKey(proposal: ImportProposal): Map<string, ProposedEntry> {
  return new Map(proposal.entries.map((entry) => [`${entry.categoryKey}@${monthKey(entry.month)}`, entry]));
}

interface MonthChange {
  readonly month: string;
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
}

function changesByMonth(before: ImportProposal, after: ImportProposal): MonthChange[] {
  const left = entriesByKey(before);
  const right = entriesByKey(after);
  const byMonth = new Map<string, { added: string[]; removed: string[]; changed: string[] }>();

  const slot = (month: string) => {
    const existing = byMonth.get(month);
    if (existing !== undefined) return existing;
    const fresh = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
    byMonth.set(month, fresh);
    return fresh;
  };

  for (const [key, entry] of right) {
    const month = monthKey(entry.month);
    const was = left.get(key);
    if (was === undefined) {
      slot(month).added.push(`${entry.categoryKey} = ${toDecimalString(entry.amount)}`);
    } else if (was.amount.minorUnits !== entry.amount.minorUnits) {
      slot(month).changed.push(
        `${entry.categoryKey}: ${toDecimalString(was.amount)} → ${toDecimalString(entry.amount)}`,
      );
    }
  }
  for (const [key, entry] of left) {
    if (right.has(key)) continue;
    slot(monthKey(entry.month)).removed.push(`${entry.categoryKey} = ${toDecimalString(entry.amount)}`);
  }

  return [...byMonth.entries()]
    .map(([month, change]) => ({ month, ...change }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// --- what an import would actually move --------------------------------------

interface StoredEntry extends Record<string, unknown> {
  readonly category_key: string;
  readonly month: string;
  readonly amount_minor: string;
}

/**
 * What the plan would write against what the database already holds. Every
 * statement here is a `select`: this answers "would re-running the import change
 * anything?" without being the thing that finds out by doing it.
 */
async function compareWithDatabase(plan: ImportPlan): Promise<string[]> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    return ["DATABASE_URL is not set, so there is nothing to compare against."];
  }

  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const client = new pg.Client({ connectionString, ssl: local ? false : { rejectUnauthorized: true } });
  await client.connect();

  try {
    const stored = new Map(
      (
        await client.query<StoredEntry>(`
          select c.person_id || ':' || c.name                        as category_key,
                 to_char(make_date(e.year, e.month, 1), 'YYYY-MM')   as month,
                 e.amount_minor::text                                as amount_minor
            from entries e
            join personal_categories c on c.id = e.personal_category_id
        `)
      ).rows.map((row) => [`${row.category_key}@${row.month}`, row.amount_minor]),
    );

    const known = new Set(
      (
        await client.query<{ key: string }>(
          `select person_id || ':' || name as key from personal_categories`,
        )
      ).rows.map((row) => row.key),
    );

    const lines: string[] = [];
    const inserts: string[] = [];
    const updates: string[] = [];
    let same = 0;

    for (const entry of plan.entries) {
      const key = `${entry.categoryKey}@${monthKey(entry.month)}`;
      const held = stored.get(key);
      if (held === undefined) {
        inserts.push(`${key} = ${toDecimalString(entry.amount)}`);
      } else if (held !== String(entry.amount.minorUnits)) {
        updates.push(`${key}: ${held} → ${entry.amount.minorUnits} (minor units)`);
      } else {
        same += 1;
      }
    }

    const plannedKeys = new Set(plan.entries.map((entry) => `${entry.categoryKey}@${monthKey(entry.month)}`));
    const untouched = [...stored.keys()].filter((key) => !plannedKeys.has(key));
    const newCategories = plan.categories.filter((category) => !known.has(category.key));

    lines.push(`Host: \`${new URL(connectionString).host}\``);
    lines.push("");
    lines.push(`- Already identical: ${same} of ${plan.entries.length} planned entries`);
    lines.push(`- Would be inserted: ${inserts.length}`);
    lines.push(`- **Would be changed: ${updates.length}**`);
    lines.push(`- Held but not in the plan, and therefore left alone: ${untouched.length}`);
    lines.push(`- Categories the plan would create: ${newCategories.length}`);

    for (const list of [
      { title: "Would be inserted", rows: inserts },
      { title: "Would be changed", rows: updates },
      { title: "Held but not in the plan", rows: untouched },
      { title: "Categories the plan would create", rows: newCategories.map((c) => c.key) },
    ]) {
      if (list.rows.length === 0) continue;
      lines.push("");
      lines.push(`### ${list.title}`);
      lines.push("");
      for (const row of [...list.rows].sort()) lines.push(`- ${row}`);
    }

    return lines;
  } finally {
    await client.end();
  }
}

// --- the report --------------------------------------------------------------

const out: string[] = [];
const say = (line = "") => out.push(line);

function proposalOf(markdown: string): ImportProposal {
  return planSheetImport(parseSheetExport(markdown, { currency: CURRENCY }), {
    currency: CURRENCY,
    people: [...PEOPLE],
  });
}

const [source, ...flags] = process.argv.slice(2);
const write = flags.includes("--write");
const detail = flags.includes("--blocks");
const againstDb = flags.includes("--against-db");

if (source === undefined) {
  throw new Error(
    "Usage: npm run sheet:refresh -- <drive-read> [--blocks] [--against-db] [--write]\n" +
      "  <drive-read> is what the Drive connector's read_file_content returned for the\n" +
      "  Mapping spreadsheet: its JSON result, or the Markdown on its own.",
  );
}

const markdown = driveMarkdown(source);
const conversion = maazanExportFrom(markdown);

const refreshed = conversion.markdown;
const current = readFileSync(EXPORT_PATH, "utf8");

const before = proposalOf(current);
const after = proposalOf(refreshed);

say(`# Sheet refresh`);
say();
say(`- Read: \`${source}\` (${markdown.length} characters)`);
say(`- Tables in the read: ${conversion.tablesRead}; מאזן tables kept: ${conversion.tables.length}`);
// The header and the grid are worth reporting apart: a reworded comment is not a
// figure moving, and only one of the two is a reason to look at the sheet again.
const gridBefore = gridOf(tablesOf(current).filter(isMaazanTable));
say(
  `- Export: \`${EXPORT_PATH}\` — grid ${gridBefore === gridOf(conversion.tables) ? "unchanged" : "CHANGED"}, ` +
    `file ${refreshed === current ? "unchanged" : "would be rewritten"}`,
);
say();

say(`## Blocks`);
say();
say(`Each one is a banner's worth of columns. Confirm these against the sheet's own tabs.`);
say();
say(`| # | Banner | Months | Rows | Figures |`);
say(`| --- | --- | --- | ---: | ---: |`);
const parsed = parseSheetExport(refreshed, { currency: CURRENCY });
parsed.blocks.forEach((block, index) => {
  say(
    `| ${index + 1} | ${block.banner} | ${describeMonths(block.months)} | ${block.rows.length} | ${figuresIn(block)} |`,
  );
});
say();

if (detail) {
  for (const block of parsed.blocks) {
    say(`### ${block.banner} — ${describeMonths(block.months)}`);
    say();
    say(`| שורה | ${block.months.map(monthKey).join(" | ")} |`);
    say(`| --- | ${block.months.map(() => "---:").join(" | ")} |`);
    for (const row of block.rows) {
      say(`| ${row.label} | ${row.cells.map((cell) => cellText(cell) || "—").join(" | ")} |`);
    }
    say();
  }
}

say(`## Months`);
say();
const changes = changesByMonth(before, after);
const monthsRead = new Set(after.entries.map((entry) => monthKey(entry.month)));
if (changes.length === 0) {
  say(
    `All ${monthsRead.size} months read the same as the committed export — ` +
      `${after.span === null ? "nothing" : `${monthKey(after.span.from)} – ${monthKey(after.span.to)}`}. ` +
      `Nothing that was already settled has been re-read differently.`,
  );
} else {
  say(`${monthsRead.size - changes.length} of ${monthsRead.size} months are unchanged. These are not:`);
  say();
  for (const change of changes) {
    say(`- **${change.month}**`);
    for (const line of change.added) say(`  - new: ${line}`);
    for (const line of change.changed) say(`  - changed: ${line}`);
    for (const line of change.removed) say(`  - gone: ${line}`);
  }
}
say();

say(`## Categories`);
say();
const beforeKeys = new Set(before.categories.map((category) => category.key));
const afterKeys = new Set(after.categories.map((category) => category.key));
const addedCategories = after.categories.filter((category) => !beforeKeys.has(category.key));
const goneCategories = before.categories.filter((category) => !afterKeys.has(category.key));
say(`${after.categories.length} proposed, ${after.categories.filter((c) => c.included).length} included.`);
if (addedCategories.length > 0) {
  say();
  for (const category of addedCategories) say(`- new: ${category.key} (${category.type})`);
}
if (goneCategories.length > 0) {
  say();
  for (const category of goneCategories) say(`- gone: ${category.key} (${category.type})`);
}
say();

say(`## Stated totals, month by month`);
say();
say(`The sheet's own \`סה"כ הוצאות\` against the same month recomputed from the rows that`);
say(`would be written. Reported per month, because one verdict over four years would hide`);
say(`which month is wrong.`);
say();
const disagreeing = after.totals.filter((total) => !total.agrees);
say(`${after.totals.length - disagreeing.length} of ${after.totals.length} agree to the agora.`);
if (disagreeing.length > 0) {
  say();
  say(`| חודש | מי | הגיליון | חושב מחדש | הפרש |`);
  say(`| --- | --- | ---: | ---: | ---: |`);
  for (const total of [...disagreeing].sort((a, b) => compareMonths(a.month, b.month))) {
    say(
      `| ${monthKey(total.month)} | ${total.personId} | ${toDecimalString(total.stated)} | ` +
        `${toDecimalString(total.recomputed)} | ${toDecimalString(total.difference)} |`,
    );
  }
}
say();

if (againstDb) {
  say(`## Against the database`);
  say();
  say(`What an import of this export would move. Nothing here writes.`);
  say();
  for (const line of await compareWithDatabase(planWrites(after, defaultSelection(after)))) say(line);
  say();
}

say(`## Flags`);
say();
const counts = new Map<string, number>();
for (const flag of after.flags) counts.set(flag.kind, (counts.get(flag.kind) ?? 0) + 1);
for (const [kind, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
  say(`- ${kind}: ${count}`);
}
say();

if (write) {
  if (refreshed === current) {
    say(`Nothing written: the refreshed export is byte-identical to the committed one.`);
  } else {
    writeFileSync(EXPORT_PATH, refreshed);
    say(`Written: ${EXPORT_PATH}`);
  }
} else {
  say(`Nothing written. Re-run with \`--write\` once the blocks above are confirmed.`);
}

process.stdout.write(`${out.join("\n")}\n`);
