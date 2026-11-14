import { describe, expect, it } from "vitest";

import {
  type FoldedAmount,
  type HeldCategory,
  compareWithLedger,
} from "@/domain/import/riseup-compare";
import {
  approvalToken,
  categoryKey,
  offeredLines,
  planRiseUpWrite,
} from "@/domain/import/riseup-write";
import { fromMajorUnits, money, toDecimalString } from "@/domain/money/money";

/**
 * Plain data in, plain data out. Every figure below is **invented**: no real
 * RiseUp output and no real household amount is ever committed (ADR 0006).
 */

const ILS = "ILS" as const;
const shekels = (amount: number) => fromMajorUnits(amount, ILS);
const OCTOBER = { year: 2026, month: 10 };
const PERSON = "fixture";

const expense = (personalCategory: string, amount: number | null): FoldedAmount => ({
  personalCategory,
  type: "expense",
  amount: amount === null ? null : shekels(amount),
});

const held = (personalCategory: string, amount: number | null): HeldCategory => ({
  personalCategory,
  type: "expense",
  amount: amount === null ? null : shekels(amount),
});

const idsFor = (...names: string[]) =>
  new Map(names.map((name) => [categoryKey(name, "expense"), `id-${name}`]));

/**
 * One changed line (סופר), one new line (מנויים), one that already agrees
 * (משתנות), one the מאזן holds and RiseUp said nothing about (שכ"ד) and one blank
 * on both sides (מתנות).
 */
const COMPARISON = compareWithLedger(
  [expense("משתנות", 4_210), expense("סופר", 4_365), expense("מנויים", 318), expense("מתנות", null)],
  [
    held("משתנות", 4_210),
    held("סופר", 4_180),
    held("מנויים", null),
    held("מתנות", null),
    held('שכ"ד', 8_450),
  ],
  OCTOBER,
);

const IDS = idsFor("משתנות", "סופר", "מנויים", "מתנות", 'שכ"ד');

describe("the lines a run offers", () => {
  const offered = offeredLines(COMPARISON);

  it("offers the changed and the new line, numbered from 1", () => {
    expect(offered.map((line) => [line.index, line.personalCategory])).toEqual([
      [1, "סופר"],
      [2, "מנויים"],
    ]);
  });

  it("offers neither a row RiseUp was silent about nor one blank on both sides", () => {
    expect(offered.map((line) => line.personalCategory)).not.toContain('שכ"ד');
    expect(offered.map((line) => line.personalCategory)).not.toContain("מתנות");
  });

  it("carries both figures and the difference on a changed line", () => {
    const [sofer] = offered;
    expect(toDecimalString(sofer?.jubot ?? shekels(0))).toBe("4180.00");
    expect(toDecimalString(sofer?.riseUp ?? shekels(0))).toBe("4365.00");
    expect(toDecimalString(sofer?.difference ?? shekels(0))).toBe("185.00");
  });
});

describe("`--write` without a confirmation of the lines", () => {
  const plan = planRiseUpWrite(PERSON, COMPARISON, { ids: IDS });

  it("writes nothing", () => {
    expect(plan.approved).toEqual([]);
    expect(plan.writable).toBe(false);
  });

  it("names the token that would approve exactly these lines", () => {
    expect(plan.refusals.join("\n")).toContain(plan.token);
    expect(plan.token).toBe(approvalToken(PERSON, COMPARISON));
  });

  /**
   * The ordinary second run of a month: everything already agrees, so there is
   * nothing to approve, nothing to write and nothing to refuse either. A stale
   * token from the run before is beside the point when no line is on offer, and
   * reporting it as a mismatch would read as a failure where there is none.
   */
  it("neither asks for a confirmation nor refuses when no line is offered", () => {
    const agreeing = compareWithLedger([expense("משתנות", 4_210)], [held("משתנות", 4_210)], OCTOBER);
    for (const request of [{ ids: IDS }, { ids: IDS, approve: "a-token-from-before" }]) {
      const quiet = planRiseUpWrite(PERSON, agreeing, request);
      expect(quiet.offered).toEqual([]);
      expect(quiet.approved).toEqual([]);
      expect(quiet.refusals).toEqual([]);
      expect(quiet.writable).toBe(true);
      expect(quiet.awaitingApproval).toBe(false);
    }
  });

  it("still refuses an agreeing month that has an unresolved row above it", () => {
    const agreeing = compareWithLedger(
      [expense("משתנות", 4_210)],
      [held("משתנות", 4_210)],
      OCTOBER,
      { unresolved: 1 },
    );
    expect(planRiseUpWrite(PERSON, agreeing, { ids: IDS }).writable).toBe(false);
  });
});

describe("the approval is of the figures it was printed with", () => {
  it("writes the approved lines when the token comes back", () => {
    const plan = planRiseUpWrite(PERSON, COMPARISON, {
      ids: IDS,
      approve: approvalToken(PERSON, COMPARISON),
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.writable).toBe(true);
    expect(
      plan.approved.map((write) => [write.personalCategory, toDecimalString(write.amount)]),
    ).toEqual([
      ["סופר", "4365.00"],
      ["מנויים", "318.00"],
    ]);
  });

  it("points every write at the database's own id", () => {
    const plan = planRiseUpWrite(PERSON, COMPARISON, {
      ids: IDS,
      approve: approvalToken(PERSON, COMPARISON),
    });
    expect(plan.approved.map((write) => write.personalCategoryId)).toEqual(["id-סופר", "id-מנויים"]);
  });

  it("refuses a token printed for a month that has since moved", () => {
    const stale = approvalToken(PERSON, COMPARISON);
    const revised = compareWithLedger(
      [expense("משתנות", 4_210), expense("סופר", 4_412), expense("מנויים", 318)],
      [held("משתנות", 4_210), held("סופר", 4_180), held("מנויים", null)],
      OCTOBER,
    );
    const plan = planRiseUpWrite(PERSON, revised, { ids: IDS, approve: stale });
    expect(plan.approved).toEqual([]);
    expect(plan.writable).toBe(false);
    expect(plan.refusals.join("\n")).toContain(stale);
  });

  it("refuses a token minted for the other Person", () => {
    const plan = planRiseUpWrite(PERSON, COMPARISON, {
      ids: IDS,
      approve: approvalToken("somebody-else", COMPARISON),
    });
    expect(plan.writable).toBe(false);
  });

  it("changes when a line goes away", () => {
    const fewer = compareWithLedger(
      [expense("משתנות", 4_210), expense("סופר", 4_365)],
      [held("משתנות", 4_210), held("סופר", 4_180)],
      OCTOBER,
    );
    expect(approvalToken(PERSON, fewer)).not.toBe(approvalToken(PERSON, COMPARISON));
  });
});

describe("a line the household declines", () => {
  const plan = planRiseUpWrite(PERSON, COMPARISON, {
    ids: IDS,
    approve: approvalToken(PERSON, COMPARISON),
    declined: [2],
  });

  it("is not written", () => {
    expect(plan.approved.map((write) => write.personalCategory)).toEqual(["סופר"]);
  });

  it("is reported as skipped rather than dropped", () => {
    expect(plan.declined.map((line) => [line.index, line.personalCategory])).toEqual([
      [2, "מנויים"],
    ]);
  });

  it("leaves the token alone, because declining is not a different month", () => {
    expect(plan.token).toBe(approvalToken(PERSON, COMPARISON));
  });

  it("refuses a decline that names no offered line", () => {
    const confused = planRiseUpWrite(PERSON, COMPARISON, {
      ids: IDS,
      approve: approvalToken(PERSON, COMPARISON),
      declined: [7],
    });
    expect(confused.writable).toBe(false);
    expect(confused.approved).toEqual([]);
    expect(confused.refusals.join("\n")).toContain("1–2");
  });

  it("writes nothing at all when every line is declined, and refuses nothing", () => {
    const all = planRiseUpWrite(PERSON, COMPARISON, {
      ids: IDS,
      approve: approvalToken(PERSON, COMPARISON),
      declined: [1, 2],
    });
    expect(all.refusals).toEqual([]);
    expect(all.writable).toBe(true);
    expect(all.approved).toEqual([]);
    expect(all.declined).toHaveLength(2);
  });
});

describe("anything unresolved stops the whole write", () => {
  const withUnresolved = compareWithLedger(
    [expense("משתנות", 4_210), expense("סופר", 4_365)],
    [held("משתנות", 4_210), held("סופר", 4_180)],
    OCTOBER,
    { unresolved: 1 },
  );

  it("writes nothing, not even the line that is clear", () => {
    const plan = planRiseUpWrite(PERSON, withUnresolved, {
      ids: IDS,
      approve: approvalToken(PERSON, withUnresolved),
    });
    expect(plan.offered).toHaveLength(1);
    expect(plan.approved).toEqual([]);
    expect(plan.writable).toBe(false);
    expect(plan.refusals.join("\n")).toContain("1 unresolved row");
  });

  it("writes nothing when a figure has no Personal Category to land in", () => {
    const nowhere = compareWithLedger(
      [expense("משתנות", 4_210), expense("רפואי ופארם", 310)],
      [held("משתנות", 4_180)],
      OCTOBER,
    );
    const plan = planRiseUpWrite(PERSON, nowhere, {
      ids: idsFor("משתנות"),
      approve: approvalToken(PERSON, nowhere),
    });
    expect(plan.approved).toEqual([]);
    expect(plan.writable).toBe(false);
    expect(plan.refusals.join("\n")).toContain("no Personal Category to land in");
  });
});

describe("what a write may hold", () => {
  it("refuses an amount that is not a whole number of shekels", () => {
    const agorot = compareWithLedger(
      [{ personalCategory: "סופר", type: "expense", amount: money(436_512, ILS) }],
      [held("סופר", 4_180)],
      OCTOBER,
    );
    const plan = planRiseUpWrite(PERSON, agorot, {
      ids: IDS,
      approve: approvalToken(PERSON, agorot),
    });
    expect(plan.approved).toEqual([]);
    expect(plan.writable).toBe(false);
    expect(plan.refusals.join("\n")).toContain("whole number of shekels");
  });

  it("never produces a null amount, which would clear an Entry", () => {
    const plan = planRiseUpWrite(PERSON, COMPARISON, {
      ids: IDS,
      approve: approvalToken(PERSON, COMPARISON),
    });
    expect(plan.approved.every((write) => write.amount !== null)).toBe(true);
  });

  it("writes an income line into the income category and not into an expense of the same name", () => {
    const sameName = compareWithLedger(
      [
        { personalCategory: "הכנסות", type: "income", amount: shekels(21_308) },
        expense("הכנסות", 12),
      ],
      [
        { personalCategory: "הכנסות", type: "income", amount: shekels(21_307) },
        held("הכנסות", null),
      ],
      OCTOBER,
    );
    const plan = planRiseUpWrite(PERSON, sameName, {
      ids: new Map([
        [categoryKey("הכנסות", "income"), "id-income"],
        [categoryKey("הכנסות", "expense"), "id-expense"],
      ]),
      approve: approvalToken(PERSON, sameName),
    });
    expect(
      plan.approved.map((write) => [write.type, write.personalCategoryId]).sort(),
    ).toEqual([
      ["expense", "id-expense"],
      ["income", "id-income"],
    ]);
  });
});

describe("the cutover is a property of the write, not of the route to it", () => {
  it("refuses a month before 2026-10 even when the comparison is handed in directly", () => {
    // `compareWithLedger` refuses such a month, so the only way to reach the
    // write with one is to build the comparison by hand — which is exactly the
    // "by any flag combination" the criterion asks about.
    const september = {
      ...COMPARISON,
      month: { year: 2026, month: 9 },
    };
    const plan = planRiseUpWrite(PERSON, september, {
      ids: IDS,
      approve: approvalToken(PERSON, september),
    });
    expect(plan.approved).toEqual([]);
    expect(plan.writable).toBe(false);
    expect(plan.refusals.join("\n")).toContain("2026-09");
  });
});
