/**
 * Reading the Google Sheet export — the shape of the source, and nothing about
 * what it means.
 *
 * Framework-free per ADR 0004. It takes the exported Markdown as a string and
 * returns blocks of labelled rows over calendar months. It does not know what a
 * category is, which rows are totals, or that two tabs overlap; that is
 * `sheet-importer.ts`, and keeping the two apart is what lets the shape of the
 * source change without the meaning being rewritten.
 *
 * The one interpretation that lives here is the calendar. The sheet's tabs run
 * July–June, but every month column carries its own year in the row above it, so
 * a month column is (year, month) directly from the source — the tab boundary is
 * presentational and never has to be stitched across.
 */

import { type Currency, type Money, InvalidMoneyError, parseMoneyInput } from "@/domain/money/money";
import { type CalendarMonth, calendarMonth } from "@/domain/time/calendar-month";

/** A block's banner names who its columns belong to: `הוצאות חודשיות - יובל`. */
const BANNER_PATTERN = /^הוצאות\s+חודשיות\s*-\s*(.+)$/;

/** The export marks a merged cell by repeating its text with this prefix. */
const MERGED_PREFIX = "[merged]";

const HEBREW_MONTHS: readonly string[] = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
];

/** `#REF!`, `#DIV/0!`, `#N/A` — a formula that did not survive, never a value. */
const ERROR_CELL_PATTERN = /^#[A-Z][A-Z/0-9]*!?$/;

const YEAR_PATTERN = /^\d{4}$/;

export class MalformedSheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedSheetError";
  }
}

/** What one cell of one month column holds. */
export type SheetCell =
  /** Nothing was written. Not a zero — the two are different facts. */
  | { readonly kind: "blank" }
  | { readonly kind: "amount"; readonly text: string; readonly amount: Money }
  /** A spreadsheet error. Carries no value and must never be read as one. */
  | { readonly kind: "error"; readonly text: string }
  /** Text where an amount belongs. Neither a value nor a known error. */
  | { readonly kind: "text"; readonly text: string };

export interface SheetRow {
  readonly label: string;
  /** One per month in the block's `months`, same order, same length. */
  readonly cells: readonly SheetCell[];
}

export interface SheetBlock {
  /** The banner text, e.g. `הוצאות חודשיות - יובל`. */
  readonly banner: string;
  /** Whose columns these are, as the sheet writes it: `יובל`, `עדן`, `משותף`. */
  readonly owner: string;
  readonly months: readonly CalendarMonth[];
  readonly rows: readonly SheetRow[];
}

export interface SheetExport {
  readonly blocks: readonly SheetBlock[];
}

/** Strip the Markdown escaping the export adds: `\-560` is −560, `\#REF\!` is #REF!. */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

function stripMerged(text: string): string {
  return text.startsWith(MERGED_PREFIX) ? text.slice(MERGED_PREFIX.length).trim() : text;
}

function splitRow(line: string): string[] {
  return line
    .slice(1, line.lastIndexOf("|"))
    .split("|")
    .map((cell) => stripMerged(unescapeMarkdown(cell).trim()));
}

/** The `| :-: | :-: |` row Markdown puts under a header. Not data, and not blank. */
function isAlignmentRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/**
 * The export's tables, one array of rows each.
 *
 * Splitting first matters: the eleven tabs have different column counts and sit
 * one after another in the same file, so a row index that walked across a table
 * boundary would read one tab's months against another tab's years. Each table
 * is parsed only against itself.
 *
 * A row of empty cells is kept — inside a table it is what separates one block
 * from the next, so dropping it as noise would run a person's rows into the
 * rows underneath.
 */
function splitTables(markdown: string): string[][][] {
  const tables: string[][][] = [];
  let current: string[][] | null = null;

  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|") || line.lastIndexOf("|") <= 0) continue;

    const cells = splitRow(line);
    if (isAlignmentRow(cells)) {
      current = [];
      tables.push(current);
      continue;
    }
    current?.push(cells);
  }

  return tables;
}

function cellAt(row: readonly string[] | undefined, column: number): string {
  return row?.[column] ?? "";
}

function monthIndexOf(text: string): number {
  return HEBREW_MONTHS.indexOf(text);
}

/** The contiguous run of columns carrying one merged banner. */
function bannerSpan(row: readonly string[], start: number): { from: number; to: number } {
  const banner = cellAt(row, start);
  let to = start;
  while (cellAt(row, to + 1) === banner) to += 1;
  return { from: start, to };
}

interface BannerSite {
  readonly banner: string;
  readonly owner: string;
  readonly rowIndex: number;
  readonly from: number;
  readonly to: number;
}

function findBanners(rows: readonly string[][]): BannerSite[] {
  const sites: BannerSite[] = [];

  rows.forEach((row, rowIndex) => {
    let column = 0;
    while (column < row.length) {
      const match = BANNER_PATTERN.exec(cellAt(row, column));
      if (match === null) {
        column += 1;
        continue;
      }
      const span = bannerSpan(row, column);
      sites.push({
        banner: cellAt(row, column),
        owner: (match[1] ?? "").trim(),
        rowIndex,
        from: span.from,
        to: span.to,
      });
      column = span.to + 1;
    }
  });

  return sites;
}

interface MonthColumn {
  readonly column: number;
  readonly month: CalendarMonth;
}

/**
 * The month columns under a banner, each with the year written above it. A column
 * whose month name has no year over it is a header the export widened, not a
 * month, and is left out rather than guessed at.
 */
function monthColumns(
  rows: readonly string[][],
  site: BannerSite,
): { columns: MonthColumn[]; monthRowIndex: number } {
  for (let rowIndex = site.rowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row === undefined) continue;

    const found: MonthColumn[] = [];
    for (let column = site.from; column <= site.to; column += 1) {
      const monthIndex = monthIndexOf(cellAt(row, column));
      if (monthIndex < 0) continue;

      const yearText = cellAt(rows[rowIndex - 1], column);
      if (!YEAR_PATTERN.test(yearText)) continue;

      found.push({ column, month: calendarMonth(Number(yearText), monthIndex + 1) });
    }

    if (found.length > 0) return { columns: found, monthRowIndex: rowIndex };
  }

  throw new MalformedSheetError(`Block "${site.banner}" has no month row with years above it`);
}

function readCell(text: string, currency: Currency): SheetCell {
  if (text.length === 0) return { kind: "blank" };
  if (ERROR_CELL_PATTERN.test(text)) return { kind: "error", text };

  try {
    const amount = parseMoneyInput(text, currency);
    return amount === null ? { kind: "blank" } : { kind: "amount", text, amount };
  } catch (error) {
    if (error instanceof InvalidMoneyError) return { kind: "text", text };
    throw error;
  }
}

function isEmptyRow(row: readonly SheetCell[]): boolean {
  return row.every((cell) => cell.kind === "blank");
}

/**
 * Rows under one banner, from below the month row to the first row that is
 * entirely empty inside this block's columns. Blocks sit side by side, so the
 * neighbour's rows continue past the end of this one — the empty row is the
 * boundary, and reading past it would pull the other person's figures in.
 */
function blockRows(
  rows: readonly string[][],
  site: BannerSite,
  columns: readonly MonthColumn[],
  monthRowIndex: number,
  currency: Currency,
): SheetRow[] {
  const firstColumn = columns[0];
  if (firstColumn === undefined) {
    throw new MalformedSheetError(`Block "${site.banner}" has no month columns`);
  }
  const labelColumn = firstColumn.column - 1;

  const collected: SheetRow[] = [];
  for (let rowIndex = monthRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row === undefined) break;

    const label = cellAt(row, labelColumn);
    const cells = columns.map((column) => readCell(cellAt(row, column.column), currency));

    if (label.length === 0 && isEmptyRow(cells)) break;
    if (label.length === 0) continue;

    collected.push({ label, cells });
  }

  return collected;
}

export interface ParseOptions {
  /** The currency the sheet's figures are in. The מאזן is kept in shekels. */
  readonly currency: Currency;
}

/**
 * Parse the export. Every block it recognises is one banner's worth of columns;
 * anything else in the file — prose, the מיפוי tables, a tab in a layout this
 * does not know — is passed over rather than guessed at, so an unfamiliar shape
 * shows up as a block that is missing and never as figures that are wrong.
 */
export function parseSheetExport(markdown: string, options: ParseOptions): SheetExport {
  const blocks = splitTables(markdown).flatMap((rows) =>
    findBanners(rows).map((site) => {
      const { columns, monthRowIndex } = monthColumns(rows, site);
      return {
        banner: site.banner,
        owner: site.owner,
        months: columns.map((column) => column.month),
        rows: blockRows(rows, site, columns, monthRowIndex, options.currency),
      };
    }),
  );

  return { blocks };
}
