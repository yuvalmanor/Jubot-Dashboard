/**
 * Turning what the Drive connector returns into the file `sheet-export.ts` parses.
 *
 * Framework-free per ADR 0004, and disposable alongside the rest of `src/domain/
 * import` once the history is in. `scripts/sheet-refresh.ts` is the shell that
 * fetches and writes; everything that decides anything is here, so the decisions
 * can be tested without a network.
 *
 * The conversion is thin, and that is a finding rather than a convenience. The
 * connector already returns Markdown tables with merged cells written as
 * `[merged] label` — the very shape `sheet-export.ts` knows — so nothing here
 * reads a figure, moves a column or rewrites a cell. What it does is **select**:
 * a Drive read carries every tab of the household's spreadsheet, and only the
 * מאזן tabs belong in the export.
 *
 * The selection is by banner rather than by position. `הוצאות חודשיות` is what
 * makes a tab a מאזן tab, so adding a 2027 tab needs no change here, and a
 * spreadsheet reorganised around this file's assumptions produces a refusal
 * rather than a plausible file with a tab missing.
 */

/** What makes a tab a מאזן tab. `הוצאות חודשיות - יובל`, and the 2023 tab's bare form. */
const MAAZAN_BANNER = "הוצאות חודשיות";

/**
 * The header the export is written with.
 *
 * Static on purpose. A stamp that moved on every run would make an unchanged
 * sheet produce a changed export, and "did anything change?" is the question the
 * refresh exists to be able to answer. What a given read found is reported by the
 * script instead, where it is read once and not committed.
 */
const PREAMBLE = `<!--
  The מאזן portion of the household Google Sheet ("Mapping"), as the Drive
  connector reads it. Written by scripts/sheet-refresh.ts, which selects the tabs
  and edits no cell: the #DIV/0! in the 2026 משותף אוכל APPLE row is the sheet's
  own. src/domain/import/sheet-importer.ts parses this file; its tests read it
  directly, which is what makes them tests against the real export rather than
  against a mock of it.

  Four blocks are present, in sheet order:
    1. the 2023 tab      — a different layout, out of scope (docs/prd/jubot.md, Out of Scope)
    2. the 2024 tab      — Jul 2024 – Jun 2025, per person
    3. the 2025 tab      — Jan – Dec 2025, per person
    4. the 2026 tab      — Jan – Dec 2026, per person, plus the derived משותף block

  The non-מאזן tabs (מיפוי, allocation, projects, RSU) are not here; they belong to
  later phases. Refreshing this file is README.md, "Refreshing the sheet export".
-->

# מאזן — Google Sheet export
`;

export class UnrecognisedDriveReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrecognisedDriveReadError";
  }
}

/** The `| :-: | :-: |` row. Its presence is what makes a run of lines a table. */
function isAlignmentRow(line: string): boolean {
  return /^\|(\s*:?-+:?\s*\|)+$/.test(line.trim());
}

/**
 * The read's tables, each as its own run of lines, in the order they appear.
 *
 * A blank line ends one. The read carries prose and single-column oddities
 * between the grids, and a run with no alignment row is not a grid this can
 * reason about, so it is passed over rather than guessed at.
 */
export function tablesOf(markdown: string): string[][] {
  const tables: string[][] = [];
  let current: string[] = [];

  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.trim().length === 0) {
      if (current.some(isAlignmentRow)) tables.push(current);
      current = [];
      continue;
    }
    if (raw.trim().startsWith("|")) current.push(raw);
  }
  if (current.some(isAlignmentRow)) tables.push(current);

  return tables;
}

export function isMaazanTable(table: readonly string[]): boolean {
  return table.some((line) => line.includes(MAAZAN_BANNER));
}

/** The grid alone, with no header — what two reads are compared on. */
export function gridOf(tables: readonly (readonly string[])[]): string {
  return tables.map((table) => table.join("\n")).join("\n\n");
}

export interface DriveConversion {
  /** The whole file, ready to be written to `docs/source/maazan-sheet-export.md`. */
  readonly markdown: string;
  /** The מאזן tables that went into it, in sheet order. */
  readonly tables: readonly (readonly string[])[];
  /** How many tables the read held in total, מאזן or not. */
  readonly tablesRead: number;
}

/**
 * Select the מאזן tabs out of a Drive read and compose the export.
 *
 * A read holding no מאזן banner at all is refused. It is either the wrong file or
 * a shape this does not know, and in both cases a file written from it would look
 * like an export and be one tab short — which is the failure the whole review
 * screen downstream exists to avoid, arriving here where nobody would look for it.
 */
export function maazanExportFrom(markdown: string): DriveConversion {
  const tables = tablesOf(markdown);
  const kept = tables.filter(isMaazanTable);

  if (kept.length === 0) {
    throw new UnrecognisedDriveReadError(
      `No table in this reading carries a "${MAAZAN_BANNER}" banner. That is either the ` +
        "wrong file or a Drive reading in a shape this does not know; either way nothing " +
        "in it can be trusted to be the מאזן.",
    );
  }

  return { markdown: `${PREAMBLE}${gridOf(kept)}\n`, tables: kept, tablesRead: tables.length };
}
