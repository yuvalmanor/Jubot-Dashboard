import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import { isMaazanTable, tablesOf } from "@/domain/import/drive-read";
import {
  UnreadableWorkbookError,
  driveReadFrom,
  driveReadOf,
  workbookOf,
} from "@/domain/import/xlsx-read";

/**
 * The fixtures are workbooks built here rather than a committed `.xlsx`.
 *
 * The real sheet is a private household file and is deliberately not in the tree
 * (`.sheet-import/` is ignored), so a test reading it would pass on one machine.
 * What is worth pinning is the format, and the format can be written out: a
 * `.xlsx` is a zip of XML, and a zip whose entries are stored rather than
 * deflated is a header, a name and the bytes.
 *
 * The reader was checked against the real workbook once, by hand, and it
 * reproduced `docs/source/maazan-sheet-export.md` byte for byte — which is the
 * claim these tests cannot make and the reason that check is recorded in the
 * commit rather than inferred from here.
 */

// --- building a workbook ------------------------------------------------------

function storedEntry(name: string, content: string): { local: Buffer; central: (offset: number) => Buffer } {
  const nameBytes = Buffer.from(name, "utf8");
  const body = Buffer.from(content, "utf8");
  const sum = crc32(body);

  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);

  return {
    local: Buffer.concat([local, body]),
    central: (offset: number) => {
      const central = Buffer.alloc(46 + nameBytes.length);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(0, 10); // stored
      central.writeUInt32LE(sum, 16);
      central.writeUInt32LE(body.length, 20);
      central.writeUInt32LE(body.length, 24);
      central.writeUInt16LE(nameBytes.length, 28);
      central.writeUInt32LE(offset, 42);
      nameBytes.copy(central, 46);
      return central;
    },
  };
}

function zipOf(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const entry = storedEntry(name, content);
    centrals.push(entry.central(offset));
    locals.push(entry.local);
    offset += entry.local.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/** A workbook of one or more tabs, each given as its `<row>` XML. */
function workbookFile(tabs: readonly { name: string; sheet: string }[], strings: readonly string[] = []) {
  const files: Record<string, string> = {
    "xl/workbook.xml": `<workbook><sheets>${tabs
      .map((tab, index) => `<sheet state="visible" name="${tab.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships>${tabs
      .map((_, index) => `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`)
      .join("")}</Relationships>`,
  };

  if (strings.length > 0) {
    files["xl/sharedStrings.xml"] =
      `<sst>${strings.map((text) => `<si><t>${text}</t></si>`).join("")}</sst>`;
  }
  tabs.forEach((tab, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = `<worksheet>${tab.sheet}</worksheet>`;
  });

  return zipOf(files);
}

const ONE_TAB = (sheet: string, strings: readonly string[] = []) =>
  workbookFile([{ name: "גיליון", sheet }], strings);

/** The cells of the one table in a reading, with the blank header and rule dropped. */
function cellsOf(markdown: string): string[][] {
  const table = tablesOf(markdown)[0] ?? [];
  return table
    .filter((line) => !/^\|(\s*:?-+:?\s*\|)+$/.test(line.trim()))
    .slice(1)
    .map((line) =>
      line
        .slice(1, line.lastIndexOf("|"))
        .split("|")
        .map((cell) => cell.trim()),
    );
}

// --- the archive --------------------------------------------------------------

describe("reading the archive", () => {
  it("refuses a file that is not a zip at all", () => {
    expect(() => driveReadFrom(Buffer.from("just some text, not a workbook"))).toThrow(
      UnreadableWorkbookError,
    );
  });

  it("refuses a workbook listing no sheets", () => {
    const bytes = zipOf({
      "xl/workbook.xml": "<workbook><sheets></sheets></workbook>",
      "xl/_rels/workbook.xml.rels": "<Relationships></Relationships>",
    });
    expect(() => workbookOf(bytes)).toThrow(UnreadableWorkbookError);
  });

  it("keeps the tabs in the order the workbook lists them, not the order of their files", () => {
    const bytes = workbookFile([
      { name: "2024", sheet: `<sheetData><row r="1"><c r="A1" t="str"><v>first</v></c></row></sheetData>` },
      { name: "2025", sheet: `<sheetData><row r="1"><c r="A1" t="str"><v>second</v></c></row></sheetData>` },
    ]);
    expect(workbookOf(bytes).sheets.map((sheet) => sheet.name)).toEqual(["2024", "2025"]);
  });
});

// --- cells --------------------------------------------------------------------

describe("reading cells", () => {
  it("reads the cached value of a formula, never the formula", () => {
    const sheet = `<sheetData><row r="1"><c r="A1"><f>587+1491</f><v>2078</v></c></row></sheetData>`;
    expect(cellsOf(driveReadFrom(ONE_TAB(sheet)))).toEqual([["2078"]]);
  });

  it("prints a whole figure whole and keeps ten significant digits on one that is not", () => {
    const sheet = `<sheetData><row r="1"><c r="A1"><v>1896.0</v></c><c r="B1"><v>1281.8333333333333</v></c></row></sheetData>`;
    expect(cellsOf(driveReadFrom(ONE_TAB(sheet)))).toEqual([["1896", "1281.833333"]]);
  });

  it("reads a shared string by its index", () => {
    const sheet = `<sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row></sheetData>`;
    expect(cellsOf(driveReadFrom(ONE_TAB(sheet, ["סופר", "רכב"])))).toEqual([["רכב"]]);
  });

  it("carries a cell's error through as the cell's own words", () => {
    // The 2026 משותף אוכל APPLE row holds a #DIV/0!, recorded in the PRD as a known
    // data-quality issue. It has to arrive as an error, never as a figure.
    const sheet = `<sheetData><row r="1"><c r="A1" t="e"><v>#DIV/0!</v></c></row></sheetData>`;
    expect(cellsOf(driveReadFrom(ONE_TAB(sheet)))).toEqual([["\\#DIV/0\\!"]]);
  });

  it("tells a cell that is styled and empty from one that is not there", () => {
    const sheet = `<sheetData><row r="1"><c r="A1"><v>12</v></c><c r="B1" s="24"/><c r="C1"><v>34</v></c></row></sheetData>`;
    expect(cellsOf(driveReadFrom(ONE_TAB(sheet)))).toEqual([["12", "", "34"]]);
  });

  it("unescapes the XML's own entities", () => {
    const sheet = `<sheetData><row r="1"><c r="A1" t="str"><v>&#x5E9;&#x5DB;&quot;&#x5D3;</v></c></row></sheetData>`;
    expect(cellsOf(driveReadFrom(ONE_TAB(sheet)))).toEqual([['שכ"ד']]);
  });
});

// --- merges -------------------------------------------------------------------

describe("merged cells", () => {
  it("repeats the anchor's text across the range, behind the prefix the export uses", () => {
    const sheet = [
      `<sheetData><row r="1"><c r="A1" t="str"><v>הוצאות חודשיות - יובל</v></c></row></sheetData>`,
      `<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>`,
    ].join("");

    expect(cellsOf(driveReadFrom(ONE_TAB(sheet)))).toEqual([
      [
        "\\[merged\\] הוצאות חודשיות - יובל",
        "\\[merged\\] הוצאות חודשיות - יובל",
        "\\[merged\\] הוצאות חודשיות - יובל",
      ],
    ]);
  });

  it("leaves a merge whose anchor is empty empty, rather than labelling it blank", () => {
    // The second row is there only so the tab is not empty: a workbook holding
    // nothing is refused, and this is a test about a merge, not about that.
    const sheet = [
      `<sheetData><row r="1"><c r="A1"/></row>`,
      `<row r="2"><c r="A2"><v>7</v></c></row></sheetData>`,
      `<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>`,
    ].join("");
    expect(cellsOf(driveReadFrom(ONE_TAB(sheet)))).toEqual([
      ["", ""],
      ["7", ""],
    ]);
  });

  it("lets a merge widen the sheet past its last written cell", () => {
    const sheet = [
      `<sheetData><row r="1"><c r="A1" t="str"><v>כותרת</v></c></row></sheetData>`,
      `<mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells>`,
    ].join("");
    expect(cellsOf(driveReadFrom(ONE_TAB(sheet)))[0]).toHaveLength(4);
  });
});

// --- the Markdown -------------------------------------------------------------

describe("the reading it writes", () => {
  it("puts every sheet row below the alignment rule, where the parser starts reading", () => {
    // sheet-export.ts begins a table at the rule and discards what is above it, so
    // a header carrying the first row would lose the banner the parse hangs on.
    const sheet = `<sheetData><row r="1"><c r="A1" t="str"><v>הוצאות חודשיות - יובל</v></c></row></sheetData>`;
    const read = driveReadFrom(ONE_TAB(sheet));

    expect(isMaazanTable(tablesOf(read)[0] ?? [])).toBe(true);
    expect(cellsOf(read)).toEqual([["הוצאות חודשיות - יובל"]]);
  });

  it("escapes a pipe, which would otherwise end the cell it sits in", () => {
    // Read off the line itself rather than through `cellsOf`, which splits on
    // every pipe — the very thing the escaping exists to stop a parser doing.
    const sheet = `<sheetData><row r="1"><c r="A1" t="str"><v>a|b</v></c><c r="B1"><v>7</v></c></row></sheetData>`;
    const rows = (tablesOf(driveReadFrom(ONE_TAB(sheet)))[0] ?? []).filter(
      (line) => !/^\|(\s*:?-+:?\s*\|)+$/.test(line.trim()),
    );

    expect(rows[1]).toBe("| a\\|b | 7 |");
  });

  it("escapes a leading minus, as the export has always written a negative", () => {
    const sheet = `<sheetData><row r="1"><c r="A1"><v>-1560</v></c></row></sheetData>`;
    expect(cellsOf(driveReadFrom(ONE_TAB(sheet)))).toEqual([["\\-1560"]]);
  });

  it("writes every tab, leaving which ones are the מאזן to drive-read", () => {
    const bytes = workbookFile([
      { name: "הוצאות-הכנסות 2026", sheet: `<sheetData><row r="1"><c r="A1" t="str"><v>הוצאות חודשיות - יובל</v></c></row></sheetData>` },
      { name: "RSU_Grants", sheet: `<sheetData><row r="1"><c r="A1" t="str"><v>Vest Period</v></c></row></sheetData>` },
    ]);
    const read = driveReadFrom(bytes);

    expect(tablesOf(read)).toHaveLength(2);
    expect(tablesOf(read).filter(isMaazanTable)).toHaveLength(1);
    expect(read).toContain("### Sheet Name: RSU_Grants");
  });

  it("passes over a tab that holds nothing at all", () => {
    const bytes = workbookFile([
      { name: "ריק", sheet: `<sheetData><row r="1"><c r="A1" s="2"/></row></sheetData>` },
      { name: "מלא", sheet: `<sheetData><row r="1"><c r="A1" t="str"><v>כאן</v></c></row></sheetData>` },
    ]);
    const read = driveReadFrom(bytes);

    expect(tablesOf(read)).toHaveLength(1);
    expect(read).not.toContain("### Sheet Name: ריק");
  });

  it("refuses a workbook whose every tab is empty, rather than writing a file of nothing", () => {
    const bytes = workbookFile([{ name: "ריק", sheet: `<sheetData><row r="1"><c r="A1" s="2"/></row></sheetData>` }]);
    expect(() => driveReadFrom(bytes)).toThrow(UnreadableWorkbookError);
  });

  it("is idempotent over a workbook already read", () => {
    const sheet = `<sheetData><row r="1"><c r="A1" t="str"><v>הוצאות חודשיות - יובל</v></c><c r="B1"><v>12</v></c></row></sheetData>`;
    const workbook = workbookOf(ONE_TAB(sheet));
    expect(driveReadOf(workbook)).toBe(driveReadOf(workbook));
  });
});
