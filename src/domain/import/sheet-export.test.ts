import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MalformedSheetError, type SheetBlock, parseSheetExport } from "@/domain/import/sheet-export";
import { monthKey } from "@/domain/time/calendar-month";

/**
 * The parser, against the real export in docs/source and against small fixtures
 * in the same layout for the shapes the real file happens not to contain.
 *
 * Plain data in, plain data out: a string of Markdown and a currency, and rows of
 * cells back. No database, no browser, no network.
 */

const EXPORT = readFileSync("docs/source/maazan-sheet-export.md", "utf8");

function parse(markdown: string) {
  return parseSheetExport(markdown, { currency: "ILS" });
}

function rowOf(block: SheetBlock, label: string) {
  const row = block.rows.find((candidate) => candidate.label === label);
  if (row === undefined) throw new Error(`No row ${label} in ${block.banner}`);
  return row;
}

function blockOf(blocks: readonly SheetBlock[], owner: string, year: number): SheetBlock {
  const block = blocks.find(
    (candidate) => candidate.owner === owner && candidate.months[0]?.year === year,
  );
  if (block === undefined) throw new Error(`No ${owner} block for ${year}`);
  return block;
}

/** One block in the export's layout: banner, years, months, rows, blank terminator. */
function fixture(rows: readonly string[]): string {
  return [
    "|  |  |  |  |",
    "| :-: | :-: | :-: | :-: |",
    "| [merged] הוצאות חודשיות - יובל | [merged] הוצאות חודשיות - יובל | [merged] הוצאות חודשיות - יובל | [merged] הוצאות חודשיות - יובל |",
    "| קבועות | [merged] 2024 | [merged] 2024 | [merged] 2025 |",
    "|  | נובמבר | דצמבר | ינואר |",
    ...rows,
    "|  |  |  |  |",
  ].join("\n");
}

describe("parsing the real export", () => {
  const { blocks } = parse(EXPORT);

  it("finds one block per person per tab, and none for the 2023 tab", () => {
    expect(blocks.map((block) => `${block.owner} ${block.months[0]?.year}`)).toEqual([
      "יובל 2024",
      "עדן 2024",
      "משותף 2024",
      "יובל 2025",
      "עדן 2025",
      "משותף 2025",
      "יובל 2026",
      "עדן 2026",
      "משותף 2026",
    ]);
  });

  it("reads a July–June tab as real calendar months, not as a year", () => {
    const block = blockOf(blocks, "יובל", 2024);
    expect(block.months.map(monthKey)).toEqual([
      "2024-07",
      "2024-08",
      "2024-09",
      "2024-10",
      "2024-11",
      "2024-12",
      "2025-01",
      "2025-02",
      "2025-03",
      "2025-04",
      "2025-05",
      "2025-06",
    ]);
  });

  it("stops each block at its own end rather than reading the block beneath", () => {
    // The banner's columns continue down the page into the ביטוחים table; the
    // empty row between them is the boundary.
    expect(blockOf(blocks, "יובל", 2024).rows.at(-1)?.label).toBe("חיסכון");
    expect(blockOf(blocks, "עדן", 2026).rows.at(-1)?.label).toBe("חיסכון");
  });

  it("keeps the two people's columns apart", () => {
    const yuval = rowOf(blockOf(blocks, "יובל", 2026), "סופר");
    const eden = rowOf(blockOf(blocks, "עדן", 2026), "סופר");

    expect(yuval.cells[0]).toEqual({
      kind: "amount",
      text: "2756",
      amount: { minorUnits: 275_600, currency: "ILS" },
    });
    expect(eden.cells[0]).toEqual({
      kind: "amount",
      text: "528",
      amount: { minorUnits: 52_800, currency: "ILS" },
    });
  });

  it("reads amounts as exact minor units, including a negative one", () => {
    // יובל's רפואה was refunded in February 2026.
    const row = rowOf(blockOf(blocks, "יובל", 2026), "רפואה");
    expect(row.cells[1]).toEqual({
      kind: "amount",
      text: "-560",
      amount: { minorUnits: -56_000, currency: "ILS" },
    });
  });

  it("tells a blank cell apart from a recorded zero", () => {
    const row = rowOf(blockOf(blocks, "עדן", 2026), "אוכל בחוץ");
    expect(row.cells[0]).toEqual({ kind: "blank" });

    const zeroCell = rowOf(blockOf(blocks, "עדן", 2026), 'שכ"ד').cells[7];
    expect(zeroCell).toEqual({
      kind: "amount",
      text: "0",
      amount: { minorUnits: 0, currency: "ILS" },
    });
  });

  it("reads the #DIV/0! the sheet is known to carry as an error, never as a value", () => {
    // 2026 משותף, אוכל APPLE — recorded in the PRD as a known data-quality issue.
    const joint = blockOf(blocks, "משותף", 2026);
    const row = rowOf(joint, "אוכל APPLE");
    expect(row.cells.every((cell) => cell.kind !== "amount")).toBe(true);
  });
});

describe("parsing shapes the real file does not contain", () => {
  it("reads #REF! and #DIV/0! as errors rather than as amounts", () => {
    const { blocks } = parse(
      fixture([
        String.raw`| סופר | 100 | \#REF\! | 200 |`,
        String.raw`| רכב | \#DIV/0\! | 50 | \#N/A |`,
      ]),
    );

    const block = blocks[0];
    expect(block).toBeDefined();
    expect(rowOf(block!, "סופר").cells.map((cell) => cell.kind)).toEqual([
      "amount",
      "error",
      "amount",
    ]);
    expect(rowOf(block!, "רכב").cells.map((cell) => cell.kind)).toEqual(["error", "amount", "error"]);
  });

  it("reads text where an amount belongs as text, not as zero", () => {
    const { blocks } = parse(fixture(["| סופר | 100 | בערך | 200 |"]));
    expect(rowOf(blocks[0]!, "סופר").cells[1]).toEqual({ kind: "text", text: "בערך" });
  });

  it("ignores a table with no banner it recognises", () => {
    const markdown = ["|  |  |", "| :-: | :-: |", "| שער הדולר | 3.65 |"].join("\n");
    expect(parse(markdown).blocks).toEqual([]);
  });

  it("refuses a block whose months carry no year rather than guessing one", () => {
    const markdown = [
      "|  |  |  |",
      "| :-: | :-: | :-: |",
      "| [merged] הוצאות חודשיות - יובל | [merged] הוצאות חודשיות - יובל | [merged] הוצאות חודשיות - יובל |",
      "|  | ינואר | פברואר |",
      "| סופר | 1 | 2 |",
    ].join("\n");
    expect(() => parse(markdown)).toThrow(MalformedSheetError);
  });

  it("un-escapes the Markdown the export adds around a figure", () => {
    const { blocks } = parse(fixture([String.raw`| סופר | 1,250.40 | \-3 | 0 |`]));
    expect(rowOf(blocks[0]!, "סופר").cells.map((cell) => cell.kind === "amount" ? cell.amount.minorUnits : null)).toEqual([
      125_040,
      -300,
      0,
    ]);
  });
});
