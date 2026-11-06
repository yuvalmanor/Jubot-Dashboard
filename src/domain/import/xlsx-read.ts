/**
 * Reading the household's spreadsheet from a `.xlsx` export of it.
 *
 * The Drive connector used to return a Google Sheet as full Markdown tables —
 * every row, merged cells written as `[merged] label` — which is the shape
 * `drive-read.ts` selects from and `sheet-export.ts` parses. On 2026-11-06 it
 * stopped: it now returns a per-tab summary carrying a range, two sample rows and
 * a list of columns, and the figures are not in it at all. The refresh refused
 * that reading rather than writing a file one tab short, so the whole import path
 * had nothing to stand on.
 *
 * This is the way back in. The sheet is exported by hand to `.xlsx` — File →
 * Download → Microsoft Excel — and this turns that file into the same Markdown
 * the connector used to produce, so everything downstream is untouched and still
 * tested against the real export.
 *
 * Framework-free per ADR 0004, and like the rest of `src/domain/import` it is
 * disposable once the history is in. It takes bytes and returns a string: no file
 * system, no network, nothing to mock. `node:zlib` is the one import, because a
 * `.xlsx` is a zip of XML and Node can already inflate; a library for this would
 * be a dependency for sixty lines of format.
 *
 * **It reads values, never formulas.** Every `<c>` carries its cached `<v>`, which
 * is what the sheet last computed. That is also the one place this reading differs
 * from the connector's: the connector returned what a cell *displayed*, and a
 * number formatted as `0` displays rounded. `=8032*3.38-1540` showed 25,608 and
 * holds 25,608.16. This reads the latter — the more faithful of the two, and a
 * difference of agorot on two cells of four years.
 */

import { inflateRawSync } from "node:zlib";

/** The export marks a merged cell by repeating its text with this prefix. */
const MERGED_PREFIX = "[merged] ";

/**
 * Significant digits on a figure that is not whole.
 *
 * Ten, because that is what the committed export carries — `106.5833333`, an
 * average the sheet holds to the limit of a double. Stating more would write
 * float noise into a file whose whole value is that it changes only when the
 * sheet does; stating fewer would round figures the sheet means exactly.
 */
const SIGNIFICANT_DIGITS = 10;

export class UnreadableWorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableWorkbookError";
  }
}

export interface XlsxSheet {
  readonly name: string;
  /** Every row padded to the sheet's width, merged cells already repeated. */
  readonly rows: readonly (readonly string[])[];
}

export interface XlsxWorkbook {
  readonly sheets: readonly XlsxSheet[];
}

// --- the zip ------------------------------------------------------------------

/**
 * The archive's entries, by path.
 *
 * Read through the central directory at the end of the file rather than by
 * walking local headers from the front: a local header may say the compressed
 * size is unknown and leave it in a trailing descriptor, and the central
 * directory never does.
 */
function zipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let end = view.length - 22;
  while (end >= 0 && view.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new UnreadableWorkbookError("This file is not a zip archive, so it is not a .xlsx.");

  const count = view.readUInt16LE(end + 10);
  const entries = new Map<string, Uint8Array>();
  let at = view.readUInt32LE(end + 16);

  for (let index = 0; index < count; index += 1) {
    if (view.readUInt32LE(at) !== 0x02014b50) {
      throw new UnreadableWorkbookError("The zip's central directory is not where its own index says.");
    }
    const method = view.readUInt16LE(at + 10);
    const compressed = view.readUInt32LE(at + 20);
    const nameLength = view.readUInt16LE(at + 28);
    const extraLength = view.readUInt16LE(at + 30);
    const commentLength = view.readUInt16LE(at + 32);
    const localHeader = view.readUInt32LE(at + 42);
    const name = view.toString("utf8", at + 46, at + 46 + nameLength);

    // The local header repeats the name and carries its own extra field, whose
    // length is its own: the central directory's cannot be used to skip it.
    const localNameLength = view.readUInt16LE(localHeader + 26);
    const localExtraLength = view.readUInt16LE(localHeader + 28);
    const from = localHeader + 30 + localNameLength + localExtraLength;

    entries.set(
      name,
      method === 0 ? view.subarray(from, from + compressed) : inflateRawSync(view.subarray(from)),
    );

    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function textOf(entries: Map<string, Uint8Array>, path: string): string {
  const entry = entries.get(path);
  if (entry === undefined) throw new UnreadableWorkbookError(`The workbook has no ${path}.`);
  return Buffer.from(entry).toString("utf8");
}

// --- the XML ------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(Number(body.slice(1)));
    return ENTITIES[body] ?? whole;
  });
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match === null ? null : unescapeXml(match[1] ?? "");
}

/**
 * The shared string table, in index order.
 *
 * A `<si>` may be split into `<r>` runs where the text was styled mid-cell, so
 * every `<t>` inside one belongs to the same string and they are joined rather
 * than counted separately.
 */
function sharedStrings(entries: Map<string, Uint8Array>): string[] {
  if (!entries.has("xl/sharedStrings.xml")) return [];
  const xml = textOf(entries, "xl/sharedStrings.xml");

  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((item) =>
    [...(item[1] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((part) => unescapeXml(part[1] ?? ""))
      .join(""),
  );
}

// --- cells --------------------------------------------------------------------

/** `BX` is column 76. */
function columnOf(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference)?.[1] ?? "";
  let column = 0;
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64);
  return column;
}

/**
 * A number as the export writes it.
 *
 * Whole figures print whole — `1896`, not `1896.0000000` — because almost every
 * cell in this sheet is a whole number of shekels and the file is read by people.
 */
function numberText(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  if (Number.isInteger(amount)) return String(amount);

  const stated = amount.toPrecision(SIGNIFICANT_DIGITS);
  return stated.includes("e") ? stated : stated.replace(/\.?0+$/, "");
}

/** One `<c>` as text. `t` says how to read its `<v>`; absent, it is a number. */
function cellText(tag: string, body: string, shared: readonly string[]): string {
  const value = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
  const kind = attribute(tag, "t");

  if (kind === "inlineStr") {
    return [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((part) => unescapeXml(part[1] ?? ""))
      .join("");
  }
  if (value === undefined) return "";

  switch (kind) {
    case "s":
      return shared[Number(unescapeXml(value))] ?? "";
    // A formula that returned text, and a formula that returned an error such as
    // #DIV/0!. Both are the cell's own words and are carried through unread.
    case "str":
    case "e":
      return unescapeXml(value);
    case "b":
      return value === "1" ? "TRUE" : "FALSE";
    default:
      return numberText(unescapeXml(value));
  }
}

// --- a sheet ------------------------------------------------------------------

interface Merge {
  readonly fromRow: number;
  readonly toRow: number;
  readonly fromColumn: number;
  readonly toColumn: number;
}

function merges(xml: string): Merge[] {
  return [...xml.matchAll(/<mergeCell ref="([A-Z]+\d+):([A-Z]+\d+)"/g)].map((match) => {
    const [start, finish] = [match[1] ?? "", match[2] ?? ""];
    return {
      fromRow: Number(/\d+/.exec(start)?.[0] ?? 0),
      toRow: Number(/\d+/.exec(finish)?.[0] ?? 0),
      fromColumn: columnOf(start),
      toColumn: columnOf(finish),
    };
  });
}

/**
 * One tab as a rectangle of text.
 *
 * Every cell of a merged range repeats the range's anchor text behind
 * `[merged] `, which is how the export has always marked them and what
 * `sheet-export.ts` strips back off. A merge whose anchor is empty stays empty:
 * a prefix with nothing after it would read as a label that is blank rather than
 * as a cell that is.
 */
function gridOf(xml: string, shared: readonly string[]): string[][] {
  const placed = new Map<string, string>();
  let width = 0;
  let height = 0;

  for (const row of xml.matchAll(/<row ([^>]*)>([\s\S]*?)<\/row>/g)) {
    const number = Number(attribute(`<row ${row[1] ?? ""}>`, "r") ?? 0);
    height = Math.max(height, number);

    for (const cell of (row[2] ?? "").matchAll(/<c ([^>/]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = `<c ${cell[1] ?? ""}>`;
      const reference = attribute(tag, "r");
      if (reference === null) continue;

      const column = columnOf(reference);
      width = Math.max(width, column);
      // A styled but empty cell still fixes the sheet's width, so it is placed
      // even when it says nothing.
      placed.set(`${number}:${column}`, cellText(tag, cell[2] ?? "", shared));
    }
  }

  // A row of the XML carrying no cells at all still exists in the sheet.
  for (const row of xml.matchAll(/<row ([^>]*)\/>/g)) {
    height = Math.max(height, Number(attribute(`<row ${row[1] ?? ""}>`, "r") ?? 0));
  }

  const covered = new Map<string, string>();
  for (const merge of merges(xml)) {
    const anchor = placed.get(`${merge.fromRow}:${merge.fromColumn}`) ?? "";
    width = Math.max(width, merge.toColumn);
    height = Math.max(height, merge.toRow);
    for (let row = merge.fromRow; row <= merge.toRow; row += 1) {
      for (let column = merge.fromColumn; column <= merge.toColumn; column += 1) {
        covered.set(`${row}:${column}`, anchor === "" ? "" : MERGED_PREFIX + anchor);
      }
    }
  }

  const rows: string[][] = [];
  for (let row = 1; row <= height; row += 1) {
    const line: string[] = [];
    for (let column = 1; column <= width; column += 1) {
      const key = `${row}:${column}`;
      line.push(covered.get(key) ?? placed.get(key) ?? "");
    }
    rows.push(line);
  }

  return rows;
}

// --- the workbook -------------------------------------------------------------

/**
 * The tabs, in the order the workbook lists them.
 *
 * Order matters: the export is four blocks "in sheet order", and a reading that
 * sorted them by file name would put the 2026 tab where the 2023 one belongs.
 */
export function workbookOf(bytes: Uint8Array): XlsxWorkbook {
  const entries = zipEntries(bytes);
  const shared = sharedStrings(entries);

  const targets = new Map<string, string>();
  for (const relationship of textOf(entries, "xl/_rels/workbook.xml.rels").matchAll(
    /<Relationship ([^>]*)\/>/g,
  )) {
    const tag = `<r ${relationship[1] ?? ""}>`;
    const id = attribute(tag, "Id");
    const target = attribute(tag, "Target");
    if (id !== null && target !== null) targets.set(id, target.replace(/^\/?xl\//, ""));
  }

  const sheets: XlsxSheet[] = [];
  for (const sheet of textOf(entries, "xl/workbook.xml").matchAll(/<sheet ([^>]*)\/>/g)) {
    const tag = `<sheet ${sheet[1] ?? ""}>`;
    const name = attribute(tag, "name");
    const target = targets.get(attribute(tag, "r:id") ?? "");
    if (name === null || target === undefined) continue;

    sheets.push({ name, rows: gridOf(textOf(entries, `xl/${target}`), shared) });
  }

  if (sheets.length === 0) {
    throw new UnreadableWorkbookError("This workbook lists no sheets, so there is nothing to read.");
  }

  return { sheets };
}

// --- the Markdown -------------------------------------------------------------

/**
 * Markdown escaping as the old Drive connector did it.
 *
 * `sheet-export.ts` strips a backslash before any character, so the parser cannot
 * tell one convention from another — but the export file can. Its point is that
 * an unchanged sheet produces a byte-identical file, so "nothing moved" is
 * something the refresh can say out loud. A reader escaping differently would
 * rewrite every line on its first run and drown the real changes.
 */
function escape(text: string): string {
  let escaped = text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  for (const character of "[]#!") escaped = escaped.split(character).join(`\\${character}`);
  return escaped.startsWith("-") ? `\\${escaped}` : escaped;
}

/**
 * One tab as a Markdown table, or null when it holds nothing.
 *
 * The header row is deliberately blank. `sheet-export.ts` starts a table at the
 * alignment row and discards everything above it, so a header carrying real cells
 * would lose the sheet's first row — which on the 2026 tab is the banner the whole
 * parse hangs on. The connector emitted an empty header for the same reason.
 */
function tableOf(sheet: XlsxSheet): string | null {
  const width = sheet.rows[0]?.length ?? 0;
  if (width === 0) return null;
  if (!sheet.rows.some((row) => row.some((cell) => cell !== ""))) return null;

  return [
    `|${"  |".repeat(width)}`,
    `|${" :-: |".repeat(width)}`,
    ...sheet.rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
}

/**
 * A whole workbook in the shape the Drive connector used to return, ready for
 * `maazanExportFrom` to select the מאזן tabs out of.
 *
 * Every tab is written, not only the מאזן ones. Which tabs belong in the export
 * is `drive-read.ts`'s decision and stays there — this is the reading, and a
 * reading that had already thrown tabs away could not be checked against the
 * sheet it came from.
 */
export function driveReadFrom(bytes: Uint8Array): string {
  return driveReadOf(workbookOf(bytes));
}

/**
 * The same, from a workbook already read.
 *
 * The seam is here so the Markdown half can be tested on plain sheets, without a
 * zip to build first — the two halves fail in different ways and a test that had
 * to construct an archive to check an escaping rule would be checking both.
 */
export function driveReadOf(workbook: XlsxWorkbook): string {
  const parts: string[] = [];

  for (const sheet of workbook.sheets) {
    const table = tableOf(sheet);
    if (table !== null) parts.push(`### Sheet Name: ${sheet.name}\n\n${table}`);
  }

  if (parts.length === 0) {
    throw new UnreadableWorkbookError("Every tab in this workbook is empty.");
  }

  return `${parts.join("\n\n")}\n`;
}
