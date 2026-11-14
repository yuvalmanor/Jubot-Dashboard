import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type FoldedAmount,
  type HeldCategory,
  RISEUP_AUTHORITY_FROM,
  RiseUpCutoverError,
  compareWithLedger,
  isRiseUpAuthority,
} from "@/domain/import/riseup-compare";
import { fromMajorUnits, toDecimalString } from "@/domain/money/money";

/**
 * Plain data in, plain data out. Every figure below is invented: no real RiseUp
 * output and no real household amount is ever committed (ADR 0006).
 */

const ILS = "ILS" as const;
const shekels = (amount: number) => fromMajorUnits(amount, ILS);
const OCTOBER = { year: 2026, month: 10 };

const expense = (personalCategory: string, amount: number | null): FoldedAmount => ({
  personalCategory,
  type: "expense",
  amount: amount === null ? null : shekels(amount),
});

const heldExpense = (personalCategory: string, amount: number | null): HeldCategory => ({
  personalCategory,
  type: "expense",
  amount: amount === null ? null : shekels(amount),
});

const rowFor = (
  comparison: ReturnType<typeof compareWithLedger>,
  personalCategory: string,
) => comparison.rows.find((row) => row.personalCategory === personalCategory);

describe("one line per Personal Category, with both figures and the difference", () => {
  const comparison = compareWithLedger(
    [expense("משתנות", 1_800), expense("סופר", 1_900), expense("פנאי", null)],
    [heldExpense("משתנות", 1_800), heldExpense("סופר", 1_750), heldExpense("פנאי", null)],
    OCTOBER,
  );

  it("shows every category exactly once", () => {
    expect(comparison.rows.map((row) => row.personalCategory).sort()).toEqual(
      ["משתנות", "סופר", "פנאי"].sort(),
    );
  });

  it("states both figures and the difference on a line that moved", () => {
    const row = rowFor(comparison, "סופר");
    expect(row?.state).toBe("differs");
    expect(toDecimalString(row?.jubot ?? shekels(0))).toBe("1750.00");
    expect(toDecimalString(row?.riseUp ?? shekels(0))).toBe("1900.00");
    expect(toDecimalString(row?.difference ?? shekels(0))).toBe("150.00");
  });

  it("carries no difference where there is nothing to subtract", () => {
    expect(rowFor(comparison, "משתנות")?.difference).toBeNull();
    expect(rowFor(comparison, "פנאי")?.difference).toBeNull();
  });

  it("counts the line that moved as the one a write would touch", () => {
    expect(comparison.changes.map((row) => row.personalCategory)).toEqual(["סופר"]);
    expect(comparison.identical).toBe(false);
  });

  it("reports a negative difference as a negative difference", () => {
    const row = rowFor(
      compareWithLedger([expense('חו"ל', -1_560)], [heldExpense('חו"ל', 200)], OCTOBER),
      'חו"ל',
    );
    expect(toDecimalString(row?.difference ?? shekels(0))).toBe("-1760.00");
  });
});

describe("a month that already agrees", () => {
  const comparison = compareWithLedger(
    [expense("משתנות", 1_800), expense("סופר", 1_900), expense("שכ\"ד", null)],
    [heldExpense("משתנות", 1_800), heldExpense("סופר", 1_900), heldExpense("שכ\"ד", 7_000)],
    OCTOBER,
  );

  it("is identical even though one row is being left alone", () => {
    expect(comparison.identical).toBe(true);
    expect(comparison.changes).toEqual([]);
    expect(comparison.counts.same).toBe(2);
    expect(comparison.counts["left-alone"]).toBe(1);
  });
});

describe("a row Jubot holds and RiseUp says nothing about", () => {
  // Each Person's grid holds rows the other one actually pays, and the sheet
  // typed a literal 0 into three of Yuval's. Neither is this feature's business.
  const comparison = compareWithLedger(
    [expense("אוכל בחוץ", null), { personalCategory: "שכ\"ד", type: "expense", amount: null, handTyped: true }],
    [heldExpense("אוכל בחוץ", 0), heldExpense("שכ\"ד", 7_000)],
    OCTOBER,
  );

  it("is left alone, never a proposed zero", () => {
    expect(rowFor(comparison, "שכ\"ד")?.state).toBe("left-alone");
    expect(rowFor(comparison, "שכ\"ד")?.riseUp).toBeNull();
    expect(comparison.changes).toEqual([]);
  });

  it("leaves a sheet-typed 0 exactly as it is", () => {
    const row = rowFor(comparison, "אוכל בחוץ");
    expect(row?.state).toBe("left-alone");
    expect(toDecimalString(row?.jubot ?? shekels(1))).toBe("0.00");
    expect(row?.riseUp).toBeNull();
    expect(row?.difference).toBeNull();
  });

  it("keeps the mapping file's hand-typed mark on the row", () => {
    expect(rowFor(comparison, "שכ\"ד")?.handTyped).toBe(true);
  });
});

describe("a row RiseUp has and Jubot never recorded", () => {
  const comparison = compareWithLedger(
    [expense("בתי קפה", 413)],
    [heldExpense("בתי קפה", null)],
    OCTOBER,
  );

  it("is new", () => {
    expect(rowFor(comparison, "בתי קפה")?.state).toBe("new");
    expect(comparison.changes.map((row) => row.state)).toEqual(["new"]);
    expect(comparison.identical).toBe(false);
  });
});

describe("neither side has it", () => {
  const comparison = compareWithLedger(
    [expense("רפואה", null)],
    [heldExpense("רפואה", null)],
    OCTOBER,
  );

  it("is still a row, and still not a zero", () => {
    expect(rowFor(comparison, "רפואה")?.state).toBe("blank");
    expect(rowFor(comparison, "רפואה")?.jubot).toBeNull();
    expect(rowFor(comparison, "רפואה")?.riseUp).toBeNull();
    expect(comparison.identical).toBe(true);
  });
});

describe("a figure with no Personal Category to land in", () => {
  // `רפואי ופארם` is a live RiseUp category of Eden's with no row in her grid.
  const comparison = compareWithLedger(
    [expense("רפואי ופארם", 120)],
    [heldExpense("משתנות", 753)],
    OCTOBER,
  );

  it("blocks rather than being created", () => {
    expect(rowFor(comparison, "רפואי ופארם")?.state).toBe("no-such-category");
    expect(comparison.blocked.map((row) => row.personalCategory)).toEqual(["רפואי ופארם"]);
    expect(comparison.identical).toBe(false);
  });

  it("is not counted as new", () => {
    expect(comparison.counts.new).toBe(0);
  });

  it("does not block when the fold read nothing for it", () => {
    const silent = compareWithLedger([expense("רפואי ופארם", null)], [], OCTOBER);
    expect(silent.blocked).toEqual([]);
    expect(rowFor(silent, "רפואי ופארם")?.state).toBe("blank");
  });
});

describe("income and expense are separate rows even under one name", () => {
  const comparison = compareWithLedger(
    [
      { personalCategory: "הכנסות", type: "income", amount: shekels(17_735) },
      expense("משתנות", 1_846),
    ],
    [
      { personalCategory: "הכנסות", type: "income", amount: shekels(17_734) },
      heldExpense("משתנות", 1_846),
    ],
    OCTOBER,
  );

  it("puts income first and reports the shekel the rounding rule costs", () => {
    expect(comparison.rows[0]?.type).toBe("income");
    expect(toDecimalString(comparison.rows[0]?.difference ?? shekels(0))).toBe("1.00");
  });

  it("never nets one type against the other", () => {
    const sameName = compareWithLedger(
      [{ personalCategory: "משתנות", type: "income", amount: shekels(10) }],
      [heldExpense("משתנות", 10)],
      OCTOBER,
    );
    expect(sameName.rows).toHaveLength(2);
    // The הכנסה of that name is a different row from the הוצאה, and the database
    // holds only the הוצאה — so the income figure has nowhere to land and the
    // expense is left alone. Neither reads the other's amount.
    expect(sameName.counts["no-such-category"]).toBe(1);
    expect(sameName.counts["left-alone"]).toBe(1);
    expect(sameName.counts.same).toBe(0);
    expect(sameName.counts.differs).toBe(0);
  });
});

describe("a retired category is flagged rather than hidden", () => {
  const comparison = compareWithLedger(
    [expense("צביקה", 1_260)],
    [{ personalCategory: "צביקה", type: "expense", amount: null, retired: true }],
    OCTOBER,
  );

  it("still compares, and says it is retired", () => {
    expect(rowFor(comparison, "צביקה")?.state).toBe("new");
    expect(rowFor(comparison, "צביקה")?.retired).toBe(true);
  });
});

describe("the cutover of ADR 0006", () => {
  it("names 2026-10 as the month RiseUp becomes the authority", () => {
    expect(RISEUP_AUTHORITY_FROM).toEqual({ year: 2026, month: 10 });
    expect(isRiseUpAuthority({ year: 2026, month: 10 })).toBe(true);
    expect(isRiseUpAuthority({ year: 2026, month: 11 })).toBe(true);
    expect(isRiseUpAuthority({ year: 2026, month: 9 })).toBe(false);
    expect(isRiseUpAuthority({ year: 2025, month: 12 })).toBe(false);
  });

  it("refuses to compare a month the sheet importer owns", () => {
    expect(() => compareWithLedger([], [], { year: 2026, month: 9 })).toThrow(RiseUpCutoverError);
  });

  it("names the cutover in the refusal", () => {
    try {
      compareWithLedger([], [], { year: 2026, month: 9 });
      expect.unreachable("the comparison should have refused");
    } catch (error) {
      expect((error as Error).message).toContain("2026-09");
      expect((error as Error).message).toContain("2026-10");
    }
  });
});

describe("the script is still write-less", () => {
  /**
   * Phase 32 builds the side-by-side and nothing else: `--write` is Phase 33.
   * This guard is deliberately tied to that phase and goes when the write
   * arrives — which is the point, since it is what makes "no `update` or
   * `insert` statement exists anywhere in the script yet" checkable rather than
   * asserted.
   */
  const script = readFileSync(
    fileURLToPath(new URL("../../../scripts/riseup-fill.ts", import.meta.url)),
    "utf8",
  );

  it.each(["insert into", "insert ", "update ", "delete from", "saveMonthEntries"])(
    "has no `%s` in scripts/riseup-fill.ts",
    (statement) => {
      // Prose is not a statement. Only the code is checked, so a line of
      // commentary saying "last updated" does not fail this.
      const code = script
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n")
        .toLowerCase();
      expect(code).not.toContain(statement);
    },
  );
});
