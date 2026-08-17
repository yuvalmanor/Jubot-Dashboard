import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  UnrecognisedDriveReadError,
  gridOf,
  isMaazanTable,
  maazanExportFrom,
  tablesOf,
} from "@/domain/import/drive-read";
import { parseSheetExport } from "@/domain/import/sheet-export";

/**
 * The fixture is the committed export itself, which is exactly what makes the
 * round-trip worth testing: the file is written in the shape the Drive connector
 * returns, so converting it again must reproduce it byte for byte. A refresh that
 * rewrote a file nothing about the sheet had changed would be indistinguishable
 * from the sheet having changed, and that is the one signal this whole path
 * exists to keep clean.
 */
const EXPORT = readFileSync("docs/source/maazan-sheet-export.md", "utf8");

describe("converting a Drive read", () => {
  it("reproduces the committed export from its own tables", () => {
    expect(maazanExportFrom(EXPORT).markdown).toBe(EXPORT);
  });

  it("is idempotent, so a second refresh over unchanged input writes nothing new", () => {
    const once = maazanExportFrom(EXPORT).markdown;
    expect(maazanExportFrom(once).markdown).toBe(once);
  });

  it("keeps every מאזן tab and nothing else", () => {
    const other = [
      "| שער הדולר | 2.959 |",
      "| :-: | :-: |",
      "| נדל\"ן CGM 1 | 100000 |",
    ].join("\n");
    const read = `${EXPORT}\n\n${other}\n`;

    const conversion = maazanExportFrom(read);
    expect(conversion.tablesRead).toBe(conversion.tables.length + 1);
    expect(conversion.markdown).toBe(EXPORT);
  });

  it("carries every block through unchanged", () => {
    const before = parseSheetExport(EXPORT, { currency: "ILS" });
    const after = parseSheetExport(maazanExportFrom(EXPORT).markdown, { currency: "ILS" });
    expect(after).toEqual(before);
  });

  it("refuses a reading with no מאזן banner rather than writing a short export", () => {
    const read = ["| a | b |", "| :-: | :-: |", "| 1 | 2 |"].join("\n");
    expect(() => maazanExportFrom(read)).toThrow(UnrecognisedDriveReadError);
  });

  it("refuses an empty reading", () => {
    expect(() => maazanExportFrom("")).toThrow(UnrecognisedDriveReadError);
  });
});

describe("splitting a Drive read into tables", () => {
  it("finds the four מאזן tabs and no others in the export", () => {
    const tables = tablesOf(EXPORT);
    expect(tables.length).toBe(4);
    expect(tables.every(isMaazanTable)).toBe(true);
  });

  it("passes over prose and any run with no alignment row", () => {
    const read = ["Some notes about the sheet.", "", "| a | b |", "| 1 | 2 |", "", EXPORT].join("\n");
    expect(tablesOf(read).length).toBe(4);
  });

  it("reads a file with Windows line endings the same as one without", () => {
    expect(gridOf(tablesOf(EXPORT.replace(/\n/g, "\r\n")))).toBe(gridOf(tablesOf(EXPORT)));
  });
});
