import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type Categories,
  type CategoryType,
  applyCreation,
  buildCategories,
  normaliseCategoryName,
  planPersonalCategoryCreation,
} from "@/domain/categories/categories";
import { type RiseUpMapping, type Unresolved } from "@/domain/import/riseup-fold";
import { RISEUP_AUTHORITY_FROM } from "@/domain/import/riseup-cutover";
import {
  type MappedMonth,
  nearReason,
  planRiseUpMapping,
  serialiseMapping,
  skeletonMapping,
} from "@/domain/import/riseup-map";
import { fromMajorUnits } from "@/domain/money/money";

/**
 * Plain data in, plain data out. Every **figure** below is invented and every id
 * is made up: no real RiseUp output and no real household amount is ever
 * committed (ADR 0006). The row *names* are the household's own vocabulary,
 * which is what the proposal is about — RiseUp's `חו״ל` against the grid's
 * `חו"ל` is the case criterion 2 asks for, and it cannot be shown with invented
 * names.
 *
 * The grid below is a small stand-in for one Person's: an income row, the bucket,
 * three rows a RiseUp category feeds, two rows only a fixed item could feed, one
 * row nothing feeds at all, and one retired row.
 */

const ILS = "ILS" as const;
const shekels = (amount: number) => fromMajorUnits(amount, ILS);
const PERSON = "fixture";
const SERVER = "riseup-fixture";
const SEPTEMBER = { year: 2026, month: 9 };
const OCTOBER = { year: 2026, month: 10 };

interface Row {
  readonly name: string;
  readonly type?: CategoryType;
  readonly retired?: boolean;
  readonly household?: string;
}

const GRID: readonly Row[] = [
  { name: "הכנסות", type: "income", household: "הכנסות" },
  { name: "משתנות" },
  { name: "סופר" },
  { name: 'חו"ל' },
  { name: "AliExpress" },
  { name: "אינטרנט" },
  { name: "טלפון 012" },
  { name: "מכבי" },
  { name: "ביגוד והנעלה" },
  { name: "פנאי", retired: true },
];

function grid(rows: readonly Row[] = GRID): Categories {
  const personal = rows.map((row, position) => ({
    id: `pc-${position + 1}`,
    personId: PERSON,
    name: row.name,
    type: row.type ?? ("expense" as CategoryType),
    activeFrom: { year: 2024, month: 1 },
    activeUntil: row.retired === true ? { year: 2025, month: 12 } : null,
  }));
  const householdNames = [...new Set(rows.map((row) => row.household ?? row.name))];
  const household = householdNames.map((name, position) => ({
    id: `hc-${position + 1}`,
    name,
    type: (rows.find((row) => (row.household ?? row.name) === name)?.type ??
      "expense") as CategoryType,
    watched: false,
    group: null,
  }));
  const assignments = personal.map((category, position) => ({
    personalCategoryId: category.id,
    householdCategoryId:
      household.find(
        (line) => line.name === (rows[position]?.household ?? (rows[position] as Row).name),
      )?.id ?? "hc-1",
  }));
  return buildCategories({ personal, household, assignments });
}

/** A file that already places everything the grid above has a source for. */
const MAPPING: RiseUpMapping = {
  person: PERSON,
  server: SERVER,
  incomeCategory: "הכנסות",
  variableCategory: "משתנות",
  categoryRules: [
    { riseupCategory: "כלכלה", personalCategory: "סופר" },
    { riseupCategory: "ביגוד והנעלה", personalCategory: "ביגוד והנעלה" },
  ],
  fixedItemRules: [{ sequenceId: "seq-health", merchant: "קרן בריאות", personalCategory: "מכבי" }],
  labelRules: [],
  dispositions: [
    { action: "never-write", riseupCategory: "__saving-hidden-category__" },
    { action: "never-write", riseupGoals: true },
  ],
  transactionDispositions: [],
};

const category = (name: string, amount: number, detail?: string): Unresolved => ({
  kind: "unmapped-category",
  label: name,
  riseupCategory: name,
  amount: shekels(amount),
  side: "expense",
  ...(detail === undefined ? {} : { detail }),
});

const fixedItem = (sequenceId: string, merchant: string, amount: number): Unresolved => ({
  kind: "unmapped-fixed-item",
  label: merchant,
  merchant,
  sequenceId,
  envelopeId: `env-${sequenceId}-${amount}`,
  amount: shekels(amount),
  side: "expense",
});

const month = (at: { year: number; month: number }, unresolved: readonly Unresolved[]): MappedMonth => ({
  month: at,
  unresolved,
});

/**
 * The numbers `--assign` and `--join` take are the proposal's own, and the grid
 * is printed in Hebrew alphabetical order rather than in the order a fixture
 * lists it. So every answer below is written by name and resolved here — a test
 * that hard-coded 6 and 7 would be testing the sort.
 */
const numberOf = (from: { readonly personalCategory?: string; readonly name?: string; readonly number: number }[], name: string) => {
  const found = from.find((row) => (row.personalCategory ?? row.name) === name);
  if (found === undefined) throw new Error(`no numbered row named ${name}`);
  return found.number;
};

const plan = (
  months: readonly MappedMonth[],
  options: {
    readonly mapping?: RiseUpMapping | null;
    readonly categories?: Categories;
    readonly assign?: readonly [number, number][];
    readonly create?: readonly [number, number | null][];
    readonly declined?: readonly number[];
  } = {},
) =>
  planRiseUpMapping({
    person: PERSON,
    server: SERVER,
    months,
    mapping: options.mapping === undefined ? MAPPING : options.mapping,
    categories: options.categories ?? grid(),
    answers: {
      assign: new Map(options.assign ?? []),
      create: new Map(options.create ?? []),
      declined: options.declined ?? [],
    },
  });

// --- the four piles ----------------------------------------------------------

describe("the four piles", () => {
  /**
   * One RiseUp category named exactly as a row of the grid, one named almost as
   * another, two fixed items sharing a merchant, and one category the grid has
   * no row for at all.
   */
  const everything = plan([
    month(OCTOBER, [
      category("AliExpress", 42.5),
      category("חו״ל", 1_317.25),
      fixedItem("seq-line-a", "חברת תקשורת", 51.9),
      fixedItem("seq-line-b", "חברת תקשורת", 64.4),
      category("רפואי ופארם", 268.4),
    ]),
  ]);

  it("sorts an exact name match into the first pile", () => {
    expect(everything.piles.exact.map((row) => [row.riseupRow, row.personalCategory])).toEqual([
      ["AliExpress", "AliExpress"],
    ]);
  });

  it("sorts a near-match into the second, and states why", () => {
    const near = everything.piles.near;
    expect(near).toHaveLength(1);
    expect(near[0]?.riseupRow).toBe("חו״ל");
    expect(near[0]?.personalCategory).toBe('חו"ל');
    expect(near[0]?.reason).toContain("quote");
  });

  it("the near-match is a real one: the two names are not equal to the domain", () => {
    // Criterion 2 rests on this. A `normaliseCategoryName` that started folding
    // quote characters would make the proposal unnecessary — and would also make
    // this pile untestable, so the dependency is stated rather than assumed.
    expect(normaliseCategoryName("חו״ל")).not.toBe(normaliseCategoryName('חו"ל'));
  });

  it("sorts every fixed item into the third, each undecided", () => {
    expect(
      everything.piles["fixed-item"].map((row) => [row.sequenceId, row.state, row.personalCategory]),
    ).toEqual([
      ["seq-line-a", "undecided", null],
      ["seq-line-b", "undecided", null],
    ]);
  });

  it("holds the rows with no RiseUp source while anything is undecided", () => {
    expect(everything.piles.sourceless).toEqual([]);
    expect(everything.heldSourceless).toContain("אינטרנט");
    expect(everything.heldSourceless).toContain("טלפון 012");
  });

  it("proposes a new Personal Category for a RiseUp category the grid lacks", () => {
    const proposed = everything.piles["new-category"];
    expect(proposed.map((row) => row.personalCategory)).toEqual(["רפואי ופארם"]);
    expect(proposed[0]?.household).toEqual({ kind: "new", name: "רפואי ופארם" });
  });

  it("writes nothing while a fixed item is undecided, not even the clear rules", () => {
    expect(everything.writable).toBe(false);
    expect(everything.refusals.join(" ")).toContain("undecided");
    expect(everything.mapping.categoryRules).toEqual(MAPPING.categoryRules);
    expect(everything.mapping.dispositions).toEqual(MAPPING.dispositions);
  });

  it("names a retired row as retired and never proposes a rule into it", () => {
    const retired = everything.candidates.find((row) => row.personalCategory === "פנאי");
    expect(retired?.retired).toBe(true);
    expect(
      everything.proposals.some((row) => row.personalCategory === "פנאי"),
    ).toBe(false);
  });
});

// --- a near-match says why ---------------------------------------------------

describe("why a near-match is proposed", () => {
  it("names the quote characters, and calls it the same name", () => {
    expect(nearReason("חו״ל", 'חו"ל')).toEqual({
      reason: expect.stringContaining("U+05F4"),
      weak: false,
    });
  });

  it("names letter case", () => {
    expect(nearReason("Aliexpress", "AliExpress")?.reason).toContain("letter case");
    expect(nearReason("Aliexpress", "AliExpress")?.weak).toBe(false);
  });

  it("names punctuation", () => {
    expect(nearReason("תחבצ + ליים", "תחבצ+ליים")?.reason).toContain("punctuation");
  });

  it("calls one name inside another a weaker claim, and leaves it undecided", () => {
    // Eden's `אוכל בחוץ - קפה` contains `אוכל בחוץ`, and her file sends it to
    // `בתי קפה`. Containment is a suggestion, never a destination.
    const nearness = nearReason("אוכל בחוץ - קפה", "אוכל בחוץ");
    expect(nearness?.weak).toBe(true);
    const suggested = plan([month(OCTOBER, [category("אוכל בחוץ - קפה", 182.9)])], {
      categories: grid([
        { name: "הכנסות", type: "income" },
        { name: "משתנות" },
        { name: "אוכל בחוץ" },
        { name: "בתי קפה" },
      ]),
      mapping: { ...MAPPING, categoryRules: [], fixedItemRules: [], dispositions: [] },
    });
    const row = suggested.piles.near[0];
    expect(row?.state).toBe("undecided");
    expect(row?.personalCategory).toBeNull();
    expect(row?.plausible.map((candidate) => candidate.personalCategory)).toContain("בתי קפה");
    expect(suggested.writable).toBe(false);
  });

  it("says nothing about two names that are simply different", () => {
    expect(nearReason("נגאנו", "סופר")).toBeNull();
  });

  it("says nothing where the names are equal — that is the first pile's business", () => {
    expect(nearReason("סופר", "סופר")).toBeNull();
  });

  it("leaves a name near two rows undecided rather than choosing", () => {
    const twoWays = plan([month(OCTOBER, [category("מכבי ", 91.4)])], {
      categories: grid([{ name: "מכבי" }, { name: "מכבי זהב" }, { name: "הכנסות", type: "income" }]),
      mapping: { ...MAPPING, categoryRules: [], fixedItemRules: [] },
    });
    // `מכבי ` normalises to `מכבי`, which is exactly one of them — so this is
    // the exact pile, not the near one. The near pile is for the other case.
    expect(twoWays.piles.exact).toHaveLength(1);

    const ambiguous = plan([month(OCTOBER, [category("מכבי-", 91.4)])], {
      categories: grid([{ name: "מכבי" }, { name: "מכבי זהב" }, { name: "הכנסות", type: "income" }]),
      mapping: { ...MAPPING, categoryRules: [], fixedItemRules: [] },
    });
    const row = ambiguous.piles.near[0];
    expect(row?.state).toBe("undecided");
    expect(row?.personalCategory).toBeNull();
    expect(row?.plausible.map((candidate) => candidate.personalCategory)).toEqual([
      "מכבי",
      "מכבי זהב",
    ]);
  });
});

// --- a fixed item is never matched by merchant -------------------------------

describe("a fixed item", () => {
  const twoLines = [
    month(SEPTEMBER, [fixedItem("seq-line-a", "חברת תקשורת", 64.4), fixedItem("seq-line-b", "חברת תקשורת", 51.9)]),
    month(OCTOBER, [fixedItem("seq-line-a", "חברת תקשורת", 51.9), fixedItem("seq-line-b", "חברת תקשורת", 64.4)]),
  ];

  it("is offered with its merchant, its id and every month's charge", () => {
    const proposals = plan(twoLines).piles["fixed-item"];
    expect(proposals).toHaveLength(2);
    expect(proposals[0]?.merchant).toBe("חברת תקשורת");
    expect(proposals[0]?.sequenceId).toBe("seq-line-a");
    // The two months imply opposite answers, which is the shape of the real
    // question and the reason nothing here may decide it.
    expect(proposals[0]?.charges.map((charge) => [charge.month, charge.amount.minorUnits])).toEqual([
      ["2026-09", 6_440],
      ["2026-10", 5_190],
    ]);
    expect(proposals[1]?.charges.map((charge) => [charge.month, charge.amount.minorUnits])).toEqual([
      ["2026-09", 5_190],
      ["2026-10", 6_440],
    ]);
  });

  it("is never auto-matched, even when its merchant is a row of the grid", () => {
    const named = plan([month(OCTOBER, [fixedItem("seq-health", "מכבי", 91.4)])], {
      mapping: { ...MAPPING, fixedItemRules: [] },
    });
    const proposal = named.piles["fixed-item"][0];
    expect(proposal?.personalCategory).toBeNull();
    expect(proposal?.state).toBe("undecided");
    expect(named.mapping.fixedItemRules).toEqual([]);
  });

  it("is written by id once a Person answers, with the merchant only as a label", () => {
    const grid_ = plan(twoLines).candidates;
    const answered = plan(twoLines, {
      assign: [
        [1, numberOf([...grid_], "אינטרנט")],
        [2, numberOf([...grid_], "טלפון 012")],
      ],
    });
    expect(answered.writable).toBe(true);
    expect(
      answered.mapping.fixedItemRules.map((rule) => [rule.sequenceId, rule.personalCategory]),
    ).toEqual([
      ["seq-health", "מכבי"],
      ["seq-line-a", "אינטרנט"],
      ["seq-line-b", "טלפון 012"],
    ]);
    expect(answered.mapping.fixedItemRules[1]?.merchant).toBe("חברת תקשורת");
  });

  it("declined, stays unplaced rather than becoming a decision", () => {
    const grid_ = plan(twoLines).candidates;
    const declined = plan(twoLines, {
      declined: [1],
      assign: [[2, numberOf([...grid_], "טלפון 012")]],
    });
    expect(declined.writable).toBe(false);
    expect(declined.piles["fixed-item"][0]?.state).toBe("declined");
    expect(declined.piles["fixed-item"][0]?.why).toContain("still unplaced");
    expect(declined.mapping.fixedItemRules).toEqual(MAPPING.fixedItemRules);
  });

  it("with no sequenceId at all is reported, never proposed", () => {
    const unkeyable = plan([
      month(OCTOBER, [
        {
          kind: "unmapped-fixed-item",
          label: "חברת תקשורת",
          merchant: "חברת תקשורת",
          envelopeId: "env-no-sequence",
          amount: shekels(61.3),
          side: "expense",
          detail: "the charge carries no sequenceId, so this item cannot be identified",
        },
      ]),
    ]);
    expect(unkeyable.piles["fixed-item"]).toEqual([]);
    expect(unkeyable.notMappable.map((row) => row.label)).toEqual(["חברת תקשורת"]);
  });
});

// --- the rows with no RiseUp source -----------------------------------------

describe("the rows of the grid with no RiseUp source", () => {
  const lines = [
    month(OCTOBER, [
      fixedItem("seq-line-a", "חברת תקשורת", 51.9),
      fixedItem("seq-line-b", "חברת תקשורת", 64.4),
    ]),
  ];
  const rows = plan(lines).candidates;
  const both: readonly [number, number][] = [
    [1, numberOf([...rows], "אינטרנט")],
    [2, numberOf([...rows], "טלפון 012")],
  ];
  const answered = plan(lines, { assign: both });

  it("are computed only once every RiseUp row has a destination", () => {
    expect(answered.heldSourceless).toEqual([]);
    expect(answered.piles.sourceless.map((row) => row.personalCategory)).toEqual([
      'חו"ל',
      "AliExpress",
    ]);
  });

  it("are written as `hand-typed`, which is what stops them being flagged again", () => {
    expect(answered.mapping.dispositions).toEqual([
      ...(MAPPING.dispositions ?? []),
      {
        action: "hand-typed",
        personalCategory: 'חו"ל',
        note: "no RiseUp row feeds it: this row of the grid is typed by hand",
      },
      {
        action: "hand-typed",
        personalCategory: "AliExpress",
        note: "no RiseUp row feeds it: this row of the grid is typed by hand",
      },
    ]);

    const again = plan([month(OCTOBER, [])], { mapping: answered.mapping });
    expect(again.piles.sourceless).toEqual([]);
    expect(again.heldSourceless).toEqual([]);
    expect(again.changed).toBe(false);
  });

  it("never include a retired row", () => {
    expect(answered.piles.sourceless.map((row) => row.personalCategory)).not.toContain("פנאי");
  });

  it("declined, keep no disposition and are proposed again", () => {
    const aliExpress = answered.piles.sourceless.find(
      (row) => row.personalCategory === "AliExpress",
    );
    expect(aliExpress).toBeDefined();
    const declined = plan(lines, {
      assign: both,
      declined: [(aliExpress as { index: number }).index],
    });
    expect(
      declined.piles.sourceless.find((row) => row.personalCategory === "AliExpress")?.state,
    ).toBe("declined");
    expect(
      (declined.mapping.dispositions ?? []).map((row) => row.personalCategory),
    ).not.toContain("AliExpress");
  });
});

// --- a new Personal Category -------------------------------------------------

describe("a Personal Category the grid lacks", () => {
  const unanswered = plan([month(OCTOBER, [category("רפואי ופארם", 268.4)])]);
  const proposal = plan([month(OCTOBER, [category("רפואי ופארם", 268.4)])], { create: [[1, null]] });

  it("is never created without `--create`, however plainly it reads", () => {
    // Eden's `חשבונות` is the reason: it turns up here the moment one charge in it
    // carries a label no rule claims, and a new row is the wrong answer there.
    expect(unanswered.piles["new-category"][0]?.state).toBe("undecided");
    expect(unanswered.piles["new-category"][0]?.why).toContain("--create 1");
    expect(unanswered.creations).toEqual([]);
    expect(unanswered.writable).toBe(false);
  });

  it("is proposed with the Household Category it would join", () => {
    expect(proposal.creations).toEqual([
      {
        personId: PERSON,
        name: "רפואי ופארם",
        type: "expense",
        activeFrom: OCTOBER,
        household: { kind: "new", name: "רפואי ופארם" },
      },
    ]);
  });

  it("joins an existing Household Category of the same name rather than making a second", () => {
    const sharing = plan([month(OCTOBER, [category("רפואה", 268.4)])], {
      categories: buildCategories({
        personal: [
          {
            id: "pc-1",
            personId: PERSON,
            name: "משתנות",
            type: "expense",
            activeFrom: { year: 2024, month: 1 },
            activeUntil: null,
          },
        ],
        household: [{ id: "hc-1", name: "משתנות", type: "expense", watched: false, group: null }, { id: "hc-2", name: "רפואה", type: "expense", watched: false, group: null }],
        assignments: [{ personalCategoryId: "pc-1", householdCategoryId: "hc-1" }],
      }),
      mapping: { ...MAPPING, categoryRules: [], fixedItemRules: [], dispositions: [] },
      create: [[1, null]],
    });
    expect(sharing.piles["new-category"][0]?.household).toEqual({
      kind: "existing",
      id: "hc-2",
      name: "רפואה",
    });
  });

  it("is redirected to another Household Category by `--create <n>:<h>`", () => {
    const health = numberOf([...proposal.households], "מכבי");
    const joined = plan([month(OCTOBER, [category("רפואי ופארם", 268.4)])], {
      create: [[1, health]],
    });
    expect(joined.creations[0]?.household).toEqual({
      kind: "existing",
      id: proposal.households.find((option) => option.number === health)?.id,
    });
    expect(joined.piles["new-category"][0]?.reason).toContain("chosen by the Person");
  });

  it("is turned into a row the grid already has by `--assign`", () => {
    const instead = plan([month(OCTOBER, [category("רפואי ופארם", 268.4)])], {
      assign: [[1, numberOf([...proposal.candidates], "מכבי")]],
    });
    expect(instead.creations).toEqual([]);
    expect(
      instead.mapping.categoryRules.map((rule) => [rule.riseupCategory, rule.personalCategory]),
    ).toEqual([
      ["כלכלה", "סופר"],
      ["ביגוד והנעלה", "ביגוד והנעלה"],
      ["רפואי ופארם", "מכבי"],
    ]);
  });

  it("lands with its Household Category and its assignment in one creation", () => {
    // The transaction is `insertPersonalCategory`'s; what is checked here is that
    // the plan it is handed is whole — a personal category, a household category
    // and the assignment between them — so a caller cannot write part of it.
    const request = proposal.creations[0];
    expect(request).toBeDefined();
    const creation = planPersonalCategoryCreation(grid(), request as never, {
      personalCategoryId: "new-pc",
      householdCategoryId: "new-hc",
    });
    expect(creation.assignment).toEqual({
      personalCategoryId: "new-pc",
      householdCategoryId: "new-hc",
    });
    expect(creation.householdIsNew).toBe(true);
    const after = applyCreation(grid(), creation);
    expect(after.personal.some((row) => row.name === "רפואי ופארם")).toBe(true);
    expect(after.assignments.some((row) => row.personalCategoryId === "new-pc")).toBe(true);
  });

  it("is refused where the grid holds a retired row of that very name", () => {
    const retired = plan([month(OCTOBER, [category("פנאי", 268.4)])]);
    expect(retired.creations).toEqual([]);
    expect(retired.piles.near[0]?.state).toBe("undecided");
    expect(retired.piles.near[0]?.reason).toContain("retired");
    expect(retired.writable).toBe(false);
  });

  it("refuses an `--assign` into a retired row", () => {
    const into = plan([month(OCTOBER, [category("רפואי ופארם", 268.4)])], {
      assign: [[1, numberOf([...proposal.candidates], "פנאי")]],
    });
    expect(into.refusals.join(" ")).toContain("retired");
    expect(into.writable).toBe(false);
  });

  it("refuses an `--assign` that crosses הכנסה and הוצאה", () => {
    const crossed = plan([month(OCTOBER, [category("רפואי ופארם", 268.4)])], {
      assign: [[1, numberOf([...proposal.candidates], "הכנסות")]],
    });
    expect(crossed.refusals.join(" ")).toContain("route one into the other");
    expect(crossed.writable).toBe(false);
  });

  it("refuses an `--assign` naming no row at all", () => {
    const nowhere = plan([month(OCTOBER, [category("רפואי ופארם", 268.4)])], { assign: [[1, 99]] });
    expect(nowhere.refusals.join(" ")).toContain("names no row");
    expect(nowhere.writable).toBe(false);
  });
});

// --- an unchanged account ----------------------------------------------------

describe("an unchanged account", () => {
  /** Everything placed, every sourceless row already marked `hand-typed`. */
  const settled: RiseUpMapping = {
    ...MAPPING,
    categoryRules: [
      ...MAPPING.categoryRules,
      { riseupCategory: "AliExpress", personalCategory: "AliExpress" },
      { riseupCategory: "חו״ל", personalCategory: 'חו"ל' },
    ],
    fixedItemRules: [
      ...MAPPING.fixedItemRules,
      { sequenceId: "seq-line-a", personalCategory: "אינטרנט" },
      { sequenceId: "seq-line-b", personalCategory: "טלפון 012" },
    ],
  };

  it("proposes no change to the file", () => {
    const quiet = plan([month(OCTOBER, []), month(SEPTEMBER, [])], { mapping: settled });
    expect(quiet.proposals).toEqual([]);
    expect(quiet.changed).toBe(false);
    expect(quiet.writable).toBe(false);
    expect(quiet.refusals).toEqual([]);
    expect(serialiseMapping(quiet.mapping)).toBe(serialiseMapping(settled));
  });

  it("re-reads the same months without proposing them twice", () => {
    const first = plan([month(OCTOBER, [category("AliExpress", 42.5)])], {
      mapping: { ...MAPPING, categoryRules: MAPPING.categoryRules },
    });
    const second = plan([month(OCTOBER, [category("AliExpress", 42.5)])], {
      mapping: first.mapping,
    });
    expect(first.changed).toBe(true);
    // The fold is what stops a mapped row coming back unresolved, so the second
    // run is handed nothing about AliExpress at all. What is checked here is the
    // other half: the proposal does not re-add a rule the file already carries.
    expect(second.mapping.categoryRules.filter((rule) => rule.riseupCategory === "AliExpress"))
      .toHaveLength(1);
  });
});

// --- the token ---------------------------------------------------------------

describe("the approval token", () => {
  const rows = [month(OCTOBER, [category("AliExpress", 42.5), fixedItem("seq-line-a", "חברת תקשורת", 51.9)])];

  it("moves when an answer changes the proposal", () => {
    const a = plan(rows, { assign: [[2, 6]] });
    const b = plan(rows, { assign: [[2, 7]] });
    expect(a.token).not.toBe(b.token);
  });

  it("moves when a RiseUp row appears", () => {
    const a = plan(rows, { assign: [[2, 6]] });
    const b = plan(
      [month(OCTOBER, [category("AliExpress", 42.5), category("נגאנו", 12.9), fixedItem("seq-line-a", "חברת תקשורת", 51.9)])],
      { assign: [[3, 6]] },
    );
    expect(a.token).not.toBe(b.token);
  });

  it("stands still for the same proposal read twice", () => {
    expect(plan(rows, { assign: [[2, 6]] }).token).toBe(plan(rows, { assign: [[2, 6]] }).token);
  });
});

// --- the file as text --------------------------------------------------------

describe("the file as it is written", () => {
  it("keeps the `_note` the file explains itself with", () => {
    const base = { ...MAPPING, _note: ["why this file exists"] } as RiseUpMapping;
    const written = plan([month(OCTOBER, [category("AliExpress", 42.5)])], { mapping: base });
    expect(JSON.parse(serialiseMapping(written.mapping))._note).toEqual(["why this file exists"]);
  });

  it("is canonical two-space JSON with one trailing newline and no CR", () => {
    const text = serialiseMapping(MAPPING);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).not.toContain("\r");
    expect(text).toContain('\n  "person": "fixture",');
  });

  it("carries no amount", () => {
    const written = plan(
      [month(OCTOBER, [category("AliExpress", 42.5), fixedItem("seq-line-a", "חברת תקשורת", 51.9)])],
      { assign: [[2, 6]] },
    );
    expect(serialiseMapping(written.mapping)).not.toMatch(/42|64|51/);
  });
});

// --- a file being born -------------------------------------------------------

describe("a mapping file being born", () => {
  /** A salary charge is money in, so it is the income row this one may land in. */
  const salary: Unresolved = {
    kind: "unmapped-fixed-item",
    label: "משכורת",
    merchant: "משכורת",
    sequenceId: "seq-salary",
    amount: fromMajorUnits(18_200, ILS),
    side: "income",
  };
  const birth = [month(OCTOBER, [category("AliExpress", 42.5), salary])];
  const asked = plan(birth, { mapping: null });
  const born = plan(birth, {
    mapping: null,
    assign: [
      [
        asked.piles["fixed-item"][0]?.index ?? 0,
        numberOf([...asked.candidates], "הכנסות"),
      ],
    ],
  });

  it("asks which fixed item is the salary rather than assuming one", () => {
    expect(asked.piles["fixed-item"].map((row) => [row.sequenceId, row.state])).toEqual([
      ["seq-salary", "undecided"],
    ]);
    expect(asked.writable).toBe(false);
    // Refused, the file handed back is the one there was: an empty skeleton.
    expect(asked.mapping.categoryRules).toEqual([]);
  });

  it("names the Person's single income row and the bucket", () => {
    expect(born.mapping.incomeCategory).toBe("הכנסות");
    expect(born.mapping.variableCategory).toBe("משתנות");
    expect(born.mapping.person).toBe(PERSON);
    expect(born.mapping.server).toBe(SERVER);
  });

  it("refuses where there is no row for the salary to land in", () => {
    const noIncome = plan([month(OCTOBER, [category("AliExpress", 42.5)])], {
      mapping: null,
      categories: grid([{ name: "משתנות" }]),
    });
    expect(noIncome.refusals.join(" ")).toContain("no single הכנסה row");
    expect(noIncome.writable).toBe(false);
  });

  it("refuses where there is no row for the other-spending bucket", () => {
    const noBucket = plan([month(OCTOBER, [category("AliExpress", 42.5)])], {
      mapping: null,
      categories: grid([{ name: "הכנסות", type: "income" }]),
    });
    expect(noBucket.refusals.join(" ")).toContain("other-spending");
    expect(noBucket.writable).toBe(false);
  });

  it("folds with a skeleton that places nothing, so every row is proposable", () => {
    const skeleton = skeletonMapping(PERSON, SERVER);
    expect(skeleton.categoryRules).toEqual([]);
    expect(skeleton.fixedItemRules).toEqual([]);
    expect(skeleton.dispositions).toEqual([]);
  });
});

// --- what is not a row's mapping --------------------------------------------

describe("money in", () => {
  it("is reported and never proposed as a rule", () => {
    const credits = plan([
      month(OCTOBER, [
        {
          kind: "credit-without-disposition",
          label: "העברת כסף",
          transactionId: "tx-made-up",
          amount: shekels(311.4),
          side: "income",
          date: "2026-10-04",
          detail: "money in, within the other-spending bucket",
        },
      ]),
    ]);
    expect(credits.piles.exact).toEqual([]);
    expect(credits.piles.near).toEqual([]);
    expect(credits.piles["fixed-item"]).toEqual([]);
    expect(credits.piles["new-category"]).toEqual([]);
    expect(credits.notMappable[0]?.detail).toContain("transactionId");
    expect(credits.mapping.categoryRules).toEqual(MAPPING.categoryRules);
    expect(credits.mapping.fixedItemRules).toEqual(MAPPING.fixedItemRules);
  });
});

// --- the monthly run creates nothing ----------------------------------------

describe("the monthly run never creates a Personal Category", () => {
  /**
   * Criterion 8, guarded rather than read: `insertPersonalCategory` is the one
   * door into `personal_categories`, and the script must reach it only from
   * `--map`. A convenience call inside the monthly run is exactly the thing that
   * would make "the run never creates a category" quietly untrue.
   */
  const script = readFileSync(
    fileURLToPath(new URL("../../../scripts/riseup-fill.ts", import.meta.url)),
    "utf8",
  );

  const code = script
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");

  it("creates a category in one place only", () => {
    expect(code.split("insertPersonalCategory(")).toHaveLength(2);
  });

  it("creates it inside `runMap` and nowhere after it", () => {
    const mapAt = code.indexOf("async function runMap(");
    const monthAt = code.indexOf("async function runMonth(");
    const createAt = code.indexOf("insertPersonalCategory(", code.indexOf("async function runMap("));
    expect(mapAt).toBeGreaterThan(-1);
    expect(monthAt).toBeGreaterThan(mapAt);
    expect(createAt).toBeGreaterThan(mapAt);
    expect(createAt).toBeLessThan(monthAt);
  });

  it("writes the mapping file only from `runMap`", () => {
    const monthAt = code.indexOf("async function runMonth(");
    expect(code.slice(monthAt)).not.toContain("serialiseMapping");
  });

  it("refuses `--map` and `--write` in one run", () => {
    expect(code).toContain("writing && mappingMode");
  });
});

// --- an answer that names nothing -------------------------------------------

describe("an answer naming a proposal this run did not make", () => {
  /**
   * The token covers the proposals, not the answers, so nothing else would catch
   * a number that is one out. Silently ignoring one is how a `--decline 8` meant
   * for row 7 writes row 7 anyway; Phase 33's audit found the same class in the
   * write's own `--decline`.
   */
  const rows = [month(OCTOBER, [category("AliExpress", 42.5)])];

  it("refuses a `--decline` that is one out", () => {
    const settled = plan(rows);
    const last = settled.proposals[settled.proposals.length - 1];
    expect(last).toBeDefined();
    const off = plan(rows, { declined: [(last as { index: number }).index + 1] });
    expect(off.refusals.join(" ")).toContain("did not make");
    expect(off.writable).toBe(false);
    expect(off.mapping).toEqual(MAPPING);
  });

  it("refuses an `--assign` and a `--create` that name nothing", () => {
    expect(plan(rows, { assign: [[99, 1]] }).refusals.join(" ")).toContain("did not make");
    expect(plan(rows, { create: [[99, null]] }).refusals.join(" ")).toContain("did not make");
  });

  it("refuses a `--create` on a proposal that is not a new Personal Category", () => {
    const wrong = plan(rows, { create: [[1, null]] });
    expect(wrong.refusals.join(" ")).toContain("not a new Personal Category");
    expect(wrong.writable).toBe(false);
  });

  it("refuses an `--assign` on a row the grid holds that nothing feeds", () => {
    const settled = plan(rows);
    const sourceless = settled.piles.sourceless[0];
    expect(sourceless).toBeDefined();
    const wrong = plan(rows, {
      assign: [[(sourceless as { index: number }).index, 1]],
    });
    expect(wrong.refusals.join(" ")).toContain("nothing to assign");
    expect(wrong.writable).toBe(false);
  });
});

// --- a created row never re-opens a month the importer owns -----------------

describe("what a new Personal Category is active from", () => {
  /**
   * A category active in a month is a **blank** in it until something is
   * recorded, and a month with a blank reads `open` in `month-closure.ts`. So a
   * row created active from 2026-09 would re-open a month the sheet importer
   * owns, just by existing (ADR 0006).
   */
  it("is never earlier than the cutover, however early the months surveyed", () => {
    const early = plan([month(SEPTEMBER, [category("רפואי ופארם", 268.4)])], {
      create: [[1, null]],
    });
    expect(early.months).toEqual(["2026-09"]);
    expect(early.activeFrom).toEqual(RISEUP_AUTHORITY_FROM);
    expect(early.creations[0]?.activeFrom).toEqual(RISEUP_AUTHORITY_FROM);
  });

  it("is the earliest month surveyed once that month is RiseUp's", () => {
    const later = plan(
      [month(OCTOBER, [category("רפואי ופארם", 268.4)]), month({ year: 2026, month: 11 }, [])],
      { create: [[1, null]] },
    );
    expect(later.activeFrom).toEqual(OCTOBER);
  });
});

// --- a row that is live but starts later ------------------------------------

describe("a row of the grid that starts later", () => {
  it("is offered like any other, and is not called retired", () => {
    const future = buildCategories({
      personal: [
        {
          id: "pc-1",
          personId: PERSON,
          name: "משתנות",
          type: "expense",
          activeFrom: { year: 2024, month: 1 },
          activeUntil: null,
        },
        {
          id: "pc-2",
          personId: PERSON,
          name: "הכנסות",
          type: "income",
          activeFrom: { year: 2024, month: 1 },
          activeUntil: null,
        },
        {
          id: "pc-3",
          personId: PERSON,
          name: "מנויים",
          type: "expense",
          activeFrom: { year: 2027, month: 1 },
          activeUntil: null,
        },
      ],
      household: [
        { id: "hc-1", name: "משתנות", type: "expense", watched: false, group: null },
        { id: "hc-2", name: "הכנסות", type: "income", watched: false, group: null },
        { id: "hc-3", name: "מנויים", type: "expense", watched: false, group: null },
      ],
      assignments: [
        { personalCategoryId: "pc-1", householdCategoryId: "hc-1" },
        { personalCategoryId: "pc-2", householdCategoryId: "hc-2" },
        { personalCategoryId: "pc-3", householdCategoryId: "hc-3" },
      ],
    });
    const run = plan([month(OCTOBER, [category("מנויים", 37.4)])], {
      categories: future,
      mapping: { ...MAPPING, categoryRules: [], fixedItemRules: [], dispositions: [] },
    });
    expect(run.candidates.find((row) => row.personalCategory === "מנויים")?.retired).toBe(false);
    expect(run.piles.exact.map((row) => row.personalCategory)).toEqual(["מנויים"]);
    expect(run.refusals).toEqual([]);
  });
});
