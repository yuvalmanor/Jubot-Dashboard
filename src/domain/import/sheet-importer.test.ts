import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildCategories } from "@/domain/categories/categories";
import { parseSheetExport } from "@/domain/import/sheet-export";
import {
  type ImportPlan,
  type ImportProposal,
  type ProposedCategory,
  conflictKey,
  defaultSelection,
  planSheetImport,
  planWrites,
} from "@/domain/import/sheet-importer";
import { buildLedger, householdMonthSummary } from "@/domain/ledger/ledger";
import { type Money } from "@/domain/money/money";
import { type CalendarMonth, calendarMonth, monthKey, monthsEqual } from "@/domain/time/calendar-month";

/**
 * SheetImporter against the household's real export.
 *
 * The fixture is `docs/source/maazan-sheet-export.md` — the sheet itself, not a
 * hand-written imitation of it. Every figure asserted below was read off the
 * spreadsheet, which is what makes these tests capable of catching a
 * misunderstanding of the source rather than only a regression against a mock.
 *
 * Plain data in, plain data out. Nothing here touches a database or a browser.
 */

const EXPORT = readFileSync("docs/source/maazan-sheet-export.md", "utf8");

const PEOPLE = [
  { id: "yuval", sheetName: "יובל" },
  { id: "eden", sheetName: "עדן" },
];

function proposalOf(markdown = EXPORT): ImportProposal {
  return planSheetImport(parseSheetExport(markdown, { currency: "ILS" }), {
    currency: "ILS",
    people: PEOPLE,
  });
}

const PROPOSAL = proposalOf();

function categoryOf(personId: string, name: string): ProposedCategory {
  const found = PROPOSAL.categories.find(
    (category) => category.personId === personId && category.name === name,
  );
  if (found === undefined) throw new Error(`No proposed category ${personId}:${name}`);
  return found;
}

function shekels(minorUnits: number): Money {
  return { minorUnits, currency: "ILS" };
}

function entriesFor(personId: string, name: string, month: CalendarMonth) {
  const key = `${personId}:${name}`;
  return PROPOSAL.entries.filter(
    (entry) => entry.categoryKey === key && monthsEqual(entry.month, month),
  );
}

function totalFor(personId: string, month: CalendarMonth) {
  return PROPOSAL.totals.filter(
    (total) => total.personId === personId && monthsEqual(total.month, month),
  );
}

describe("what the import covers", () => {
  it("reads the tabs in the supported layout as one continuous span", () => {
    expect(PROPOSAL.span).toEqual({
      from: calendarMonth(2024, 7),
      to: calendarMonth(2026, 7),
    });
  });

  it("stops at the last month the sheet has a figure for, not at the tab's last column", () => {
    // The 2026 tab carries formula zeros for months that have not happened. A zero
    // is a recorded fact, so these cannot be imported and cannot be told from real
    // ones by their value — the boundary is where the tab stops saying anything.
    expect(PROPOSAL.entries.some((entry) => entry.month.year === 2026 && entry.month.month > 7)).toBe(
      false,
    );
    expect(PROPOSAL.flags).toContainEqual({
      kind: "unrecorded-tail",
      banner: "הוצאות חודשיות - יובל (2026)",
      from: calendarMonth(2026, 8),
    });
  });

  it("derives the household rather than importing the sheet's משותף block", () => {
    const skipped = PROPOSAL.flags.filter((flag) => flag.kind === "derived-block-skipped");
    expect(skipped).toHaveLength(3);
    expect(PROPOSAL.categories.every((category) => category.personId !== "משותף")).toBe(true);
  });
});

describe("per-person categories", () => {
  it("lands each person's categories under that person", () => {
    // רפואה is only ever a row in יובל's columns; נגאנו only in עדן's.
    expect(categoryOf("yuval", "רפואה").personId).toBe("yuval");
    expect(categoryOf("eden", "נגאנו").personId).toBe("eden");

    expect(
      PROPOSAL.categories.some((category) => category.personId === "eden" && category.name === "רפואה"),
    ).toBe(false);
    expect(
      PROPOSAL.categories.some((category) => category.personId === "yuval" && category.name === "נגאנו"),
    ).toBe(false);
  });

  it("keeps each person's own naming for the same real-world spend", () => {
    // Both people keep a סופר and a רכב. They are two categories, not one.
    expect(categoryOf("yuval", "סופר").key).not.toBe(categoryOf("eden", "סופר").key);
  });

  it("never turns a row the sheet computes into a category", () => {
    const names = PROPOSAL.categories.map((category) => category.name);
    expect(names).not.toContain("חיסכון");
    expect(names).not.toContain('סה"כ הוצאות');
    expect(names).not.toContain("הוצאות ללא EPP");
  });

  it("imports the sheet's income total as one income category per person", () => {
    // The sheet has no per-category income rows. This is the granularity the
    // history actually has, and inventing more would be inventing data.
    expect(categoryOf("yuval", "הכנסות").type).toBe("income");
    expect(categoryOf("eden", "הכנסות").type).toBe("income");
  });

  it("retires a row that stopped appearing rather than deleting its history", () => {
    // ClubRRRR is on the 2024 and 2025 tabs and gone from 2026 — PRD story 10.
    expect(categoryOf("yuval", "ClubRRRR").activeUntil).toEqual(calendarMonth(2025, 12));
    expect(categoryOf("eden", "ClubRRRR").activeUntil).toEqual(calendarMonth(2025, 6));

    // Its 2024 figure survives the retirement.
    expect(entriesFor("yuval", "ClubRRRR", calendarMonth(2024, 11))[0]?.amount).toEqual(
      shekels(945_100),
    );
  });

  it("opens a lifespan at the first tab the row appears on", () => {
    expect(categoryOf("yuval", "רפואה").activeFrom).toEqual(calendarMonth(2026, 1));
    expect(categoryOf("yuval", "סופר").activeFrom).toEqual(calendarMonth(2024, 7));
  });
});

describe("proposed household assignments", () => {
  it("pairs EPP with אוכל APPLE under one household category", () => {
    // EPP is Apple's employee food benefit, not ESPP — an ordinary expense that
    // pairs with אוכל APPLE (docs/prd/jubot.md, Further Notes). In the current
    // sheet both rows sit in עדן's columns rather than one each.
    expect(categoryOf("eden", "העברות EPP").householdName).toBe("אוכל APPLE");
    expect(categoryOf("eden", "אוכל APPLE").householdName).toBe("אוכל APPLE");
  });

  it("proposes one household line where both people use the same name", () => {
    expect(categoryOf("yuval", "סופר").householdName).toBe("סופר");
    expect(categoryOf("eden", "סופר").householdName).toBe("סופר");
  });

  it("reports two near-identical names instead of quietly merging them", () => {
    // עדן's row is spelled with a third ו. Whether that is one category or two is
    // a person's judgement, so it is reported and left alone.
    expect(PROPOSAL.flags).toContainEqual({
      kind: "similar-names",
      left: "הלווואות",
      right: "הלוואות",
    });
    expect(categoryOf("eden", "הלווואות").householdName).not.toBe(
      categoryOf("yuval", "הלוואות").householdName,
    );
  });
});

describe("the overlapping Jan–Jun 2025 months", () => {
  const overlapping = [1, 2, 3, 4, 5, 6].map((month) => calendarMonth(2025, month));

  it("resolves every overlapping category-month to exactly one entry", () => {
    const seen = new Map<string, number>();
    for (const entry of PROPOSAL.entries) {
      const key = `${entry.categoryKey}@${monthKey(entry.month)}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect([...seen.values()].filter((count) => count !== 1)).toEqual([]);

    for (const month of overlapping) {
      expect(entriesFor("yuval", "סופר", month)).toHaveLength(1);
      expect(entriesFor("eden", "סופר", month)).toHaveLength(1);
    }
  });

  it("collapses agreeing figures silently", () => {
    // Both tabs give יובל 414 for January 2025. One entry, and nothing to report.
    expect(entriesFor("yuval", "סופר", calendarMonth(2025, 1))[0]?.amount).toEqual(shekels(41_400));
    expect(
      PROPOSAL.flags.some(
        (flag) => flag.kind === "overlap-conflict" && flag.categoryKey === "yuval:סופר",
      ),
    ).toBe(false);
  });

  it("reports a disagreement with both figures and the tab each came from", () => {
    // עדן's income row on the 2025 tab repeats the previous half-year's figures.
    const conflict = PROPOSAL.flags.find(
      (flag) =>
        flag.kind === "overlap-conflict" &&
        flag.categoryKey === "eden:הכנסות" &&
        monthsEqual(flag.month, calendarMonth(2025, 1)),
    );

    expect(conflict).toEqual({
      kind: "overlap-conflict",
      categoryKey: "eden:הכנסות",
      personId: "eden",
      label: "הכנסות",
      month: calendarMonth(2025, 1),
      kept: shekels(2_364_900),
      keptFrom: "הוצאות חודשיות - עדן (2025)",
      discarded: shekels(1_964_600),
      discardedFrom: "הוצאות חודשיות - עדן (2024)",
    });
  });

  it("lets a person overturn the importer's choice", () => {
    const key = conflictKey("eden:הכנסות", calendarMonth(2025, 1));
    const base = defaultSelection(PROPOSAL);
    const plan = planWrites(PROPOSAL, {
      ...base,
      conflictChoices: new Map([[key, 1_964_600]]),
    });

    const entry = plan.entries.find(
      (candidate) =>
        candidate.categoryKey === "eden:הכנסות" && monthsEqual(candidate.month, calendarMonth(2025, 1)),
    );
    expect(entry?.amount).toEqual(shekels(1_964_600));
  });
});

describe("totals recomputed against the sheet's own", () => {
  it.each([
    ["yuval", calendarMonth(2024, 7), 1_084_600],
    ["yuval", calendarMonth(2026, 1), 1_060_500],
    ["eden", calendarMonth(2026, 1), 1_376_400],
    ["eden", calendarMonth(2025, 2), 989_500],
    ["yuval", calendarMonth(2025, 9), 2_607_800],
  ])("matches %s for %s to the agora", (personId, month, minorUnits) => {
    const checks = totalFor(personId as string, month as CalendarMonth);
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) {
      expect(check.stated).toEqual(shekels(minorUnits as number));
      expect(check.recomputed).toEqual(shekels(minorUnits as number));
      expect(check.agrees).toBe(true);
    }
  });

  it("agrees with every stated monthly total but the one the sheet disagrees with itself about", () => {
    const disagreeing = PROPOSAL.totals.filter((total) => !total.agrees);

    // עדן's ארנונה for June 2025 is 477 on the 2024 tab and blank on the 2025 tab,
    // so the two tabs state different totals for the same month. A blank is the
    // absence of a statement rather than a statement of absence, so the recorded
    // figure is kept — and the resulting gap is reported instead of absorbed.
    expect(disagreeing).toHaveLength(1);
    expect(disagreeing[0]).toMatchObject({
      personId: "eden",
      month: calendarMonth(2025, 6),
      stated: shekels(1_481_400),
      recomputed: shekels(1_529_100),
      difference: shekels(47_700),
    });
  });
});

describe("error cells", () => {
  /** One block in the export's layout, for shapes the real file does not contain. */
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

  // The stated totals are what the sheet computed before the formulas broke, so
  // December is short by the 100 that #REF! swallowed.
  const broken = proposalOf(
    fixture([
      String.raw`| סופר | 100 | \#REF\! | 200 |`,
      String.raw`| רכב | \#DIV/0\! | 50 | 60 |`,
      String.raw`| סה"כ הוצאות | 100 | 150 | 260 |`,
    ]),
  );

  it("flags an error cell for correction rather than importing it as a value", () => {
    expect(broken.flags).toContainEqual({
      kind: "error-cell",
      owner: "יובל",
      label: "סופר",
      month: calendarMonth(2024, 12),
      text: "#REF!",
    });
    expect(broken.flags).toContainEqual({
      kind: "error-cell",
      owner: "יובל",
      label: "רכב",
      month: calendarMonth(2024, 11),
      text: "#DIV/0!",
    });
  });

  it("leaves the broken category-month unrecorded, which is not the same as zero", () => {
    expect(
      broken.entries.some(
        (entry) => entry.categoryKey === "yuval:סופר" && monthsEqual(entry.month, calendarMonth(2024, 12)),
      ),
    ).toBe(false);
  });

  it("shows up as a total that no longer agrees, rather than as a silent shortfall", () => {
    const december = broken.totals.find((total) => monthsEqual(total.month, calendarMonth(2024, 12)));
    expect(december?.agrees).toBe(false);
    expect(december?.recomputed).toEqual(shekels(5_000));
    expect(december?.stated).toEqual(shekels(15_000));
    expect(december?.difference).toEqual(shekels(-10_000));
  });
});

describe("nothing is written without confirmation", () => {
  it("proposes leaving out the rows the sheet itself leaves out of its totals", () => {
    const transfer = categoryOf("yuval", "הפקדות לחיסכון");
    expect(transfer.included).toBe(false);
    expect(transfer.excludedReason).not.toBeNull();

    const memo = categoryOf("eden", "מילואים");
    expect(memo.included).toBe(false);
    expect(memo.excludedReason).not.toBeNull();
  });

  it("proposes leaving out a row that has no figure anywhere", () => {
    expect(categoryOf("yuval", "מים").entryCount).toBe(0);
    expect(categoryOf("yuval", "מים").included).toBe(false);
  });

  it("writes nothing at all for an empty selection", () => {
    const plan = planWrites(PROPOSAL, { includedKeys: new Set(), householdNames: new Map() });
    expect(plan).toEqual({ households: [], categories: [], entries: [] });
  });

  it("drops a category's entries with the category when it is left out", () => {
    const base = defaultSelection(PROPOSAL);
    const without = new Set(base.includedKeys);
    without.delete("yuval:סופר");

    const plan = planWrites(PROPOSAL, { ...base, includedKeys: without });
    expect(plan.categories.some((category) => category.key === "yuval:סופר")).toBe(false);
    expect(plan.entries.some((entry) => entry.categoryKey === "yuval:סופר")).toBe(false);
  });

  it("takes a corrected household name over the proposed one", () => {
    const base = defaultSelection(PROPOSAL);
    const corrected = new Map(base.householdNames);
    corrected.set("yuval:סופר", "קניות בית");
    corrected.set("eden:סופר", "קניות בית");

    const plan = planWrites(PROPOSAL, { ...base, householdNames: corrected });
    const household = plan.households.find((candidate) => candidate.name === "קניות בית");
    expect(household).toBeDefined();

    const members = plan.categories.filter((category) => category.householdKey === household?.key);
    expect(members.map((member) => member.key).sort()).toEqual(["eden:סופר", "yuval:סופר"]);
    expect(plan.households.some((candidate) => candidate.name === "סופר")).toBe(false);
  });

  it("gives every written category a household category, as the invariant requires", () => {
    const plan = planWrites(PROPOSAL, defaultSelection(PROPOSAL));
    const keys = new Set(plan.households.map((household) => household.key));

    expect(plan.categories.length).toBeGreaterThan(0);
    for (const category of plan.categories) {
      expect(keys.has(category.householdKey)).toBe(true);
    }
  });
});

describe("what the import hands to the מאזן screens", () => {
  const plan: ImportPlan = planWrites(PROPOSAL, defaultSelection(PROPOSAL));

  /** The plan read through the Phase 2/3 domain, keys standing in for real ids. */
  function readMonth(month: CalendarMonth) {
    const categories = buildCategories({
      personal: plan.categories.map((category) => ({
        id: category.key,
        personId: category.personId,
        name: category.name,
        type: category.type,
        activeFrom: category.activeFrom,
        activeUntil: category.activeUntil,
      })),
      household: plan.households.map((household) => ({
        id: household.key,
        name: household.name,
        type: household.type,
        watched: false,
      })),
      assignments: plan.categories.map((category) => ({
        personalCategoryId: category.key,
        householdCategoryId: category.householdKey,
      })),
    });

    const ledger = buildLedger({
      entered: plan.entries.map((entry) => ({
        personalCategoryId: entry.categoryKey,
        month: entry.month,
        amount: entry.amount,
      })),
    });

    return householdMonthSummary(ledger, categories, month, "ILS");
  }

  it("builds a valid Categories and Ledger, so the months are readable as they stand", () => {
    expect(() => readMonth(calendarMonth(2026, 1))).not.toThrow();
  });

  it.each([
    [calendarMonth(2026, 1), 1_466_800],
    [calendarMonth(2026, 2), 2_761_700],
    [calendarMonth(2025, 10), 2_225_700],
  ])("derives the household's חיסכון for %s as the sheet does", (month, minorUnits) => {
    // The sheet's own משותף block nets EPP out of both its expense and its income
    // total, so its חיסכון is comparable even though its expense figure is not.
    expect(readMonth(month as CalendarMonth).saving).toEqual(shekels(minorUnits as number));
  });
});
