import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  type Categories,
  EMPTY_CATEGORIES,
  applyCreation,
  applyHouseholdWatch,
  buildCategories,
  planHouseholdWatch,
  planPersonalCategoryCreation,
} from "@/domain/categories/categories";
import { parseSheetExport } from "@/domain/import/sheet-export";
import { defaultSelection, planSheetImport, planWrites } from "@/domain/import/sheet-importer";
import {
  type AnnualItems,
  EMPTY_ANNUAL_ITEMS,
  applyAnnualItemCreation,
  applyRenewal,
  applyRenewalCorrection,
  applyRenewalRemoval,
  buildAnnualItems,
  planAnnualItemCreation,
  planRenewal,
  planRenewalCorrection,
  planRenewalRemoval,
} from "@/domain/ledger/annual-items";
import { type EnteredEntry, type Ledger, buildLedger, recordedSpan } from "@/domain/ledger/ledger";
import {
  HOUSEHOLD_SCOPE,
  averageOverMonths,
  categoryGroups,
  denominatorMonths,
  yearPeriod,
} from "@/domain/ledger/ledger-analytics";
import { yearGrid } from "@/domain/ledger/year-grid";
import { type Money, money } from "@/domain/money/money";
import { type CalendarDate, calendarDate } from "@/domain/time/calendar-date";
import { type CalendarMonth, calendarMonth, monthRange } from "@/domain/time/calendar-month";

import { type RateWatchItemRow, type RateWatchRow, rateWatch } from "./rate-watch";

/**
 * The מעקב תעריפים reading, tested against nothing but plain data — no database
 * is imported here and none is needed, because the ledger, the categories and the
 * clock are all parameters.
 *
 * The last block is different: it is the **calibration** of the 10% / 300₪ bars
 * against the household's own 2024–2026 subscription history, read out of the
 * committed sheet export. The plan asks for the calibration to be *recorded*
 * rather than asserted, and a test is the only form of that which cannot rot.
 */

const ILS = "ILS" as const;
const ils = (major: number) => money(Math.round(major * 100), ILS);
const m = (year: number, month: number) => calendarMonth(year, month);

/** August 2026, so 2026 counts ינואר–יולי and 2025 counts all twelve. */
const TODAY = m(2026, 8);

interface Spec {
  readonly key: string;
  readonly person: string;
  readonly name: string;
  readonly household: string;
  readonly householdName: string;
}

/**
 * Two subscriptions each of the People pays half of, and one line only יובל has.
 * Every one is a Household Category, which is what a Watched Category is.
 */
const SPECS: readonly Spec[] = [
  { key: "y-net", person: "yuval", name: "אינטרנט", household: "h-net", householdName: "אינטרנט" },
  { key: "e-net", person: "eden", name: "אינטרנט עדן", household: "h-net", householdName: "אינטרנט" },
  { key: "y-music", person: "yuval", name: "אפל מיוזיק", household: "h-music", householdName: "אפל מיוזיק" },
  { key: "y-food", person: "yuval", name: "סופר", household: "h-food", householdName: "סופר" },
];

function categories(watched: readonly string[] = []): Categories {
  const created = new Set<string>();
  const base = SPECS.reduce<Categories>((model, spec) => {
    const isNew = !created.has(spec.household);
    created.add(spec.household);
    return applyCreation(
      model,
      planPersonalCategoryCreation(
        model,
        {
          personId: spec.person,
          name: spec.name,
          type: "expense",
          activeFrom: m(2024, 1),
          household: isNew
            ? { kind: "new", name: spec.householdName }
            : { kind: "existing", id: spec.household },
        },
        { personalCategoryId: spec.key, householdCategoryId: spec.household },
      ),
    );
  }, EMPTY_CATEGORIES);

  return watched.reduce(
    (model, id) => applyHouseholdWatch(model, planHouseholdWatch(model, id, true)),
    base,
  );
}

/** One figure a month across an inclusive range. */
function every(categoryId: string, from: CalendarMonth, to: CalendarMonth, amount: Money): EnteredEntry[] {
  return monthRange(from, to).map((month) => ({ personalCategoryId: categoryId, month, amount }));
}

function rowOf(rows: readonly RateWatchRow[], key: string): RateWatchRow {
  const found = rows.find((row) => row.key === key);
  if (found === undefined) throw new Error(`No rate watch row ${key}`);
  return found;
}

/** The derived band alone — every reading below the typed band's own block. */
function monthlyRows(ledger: Ledger, model: Categories, year: number): readonly RateWatchRow[] {
  return rateWatch(ledger, model, EMPTY_ANNUAL_ITEMS, year, ILS, TODAY).monthly.rows;
}

const d = (year: number, month: number, day: number) => calendarDate(year, month, day);

/** One Annual Item and its price history, added the way the household would type it. */
function withItem(
  model: AnnualItems,
  id: string,
  name: string,
  history: readonly (readonly [CalendarDate, number])[],
): AnnualItems {
  const [first, ...rest] = history;
  if (first === undefined) throw new Error("An annual item is created with its first renewal");

  const created = applyAnnualItemCreation(
    model,
    planAnnualItemCreation(model, { name, renewedOn: first[0], amount: ils(first[1]) }, { itemId: id }),
  );

  return rest.reduce(
    (running, [renewedOn, amount]) =>
      applyRenewal(running, planRenewal(running, id, { renewedOn, amount: ils(amount) })),
    created,
  );
}

/** The car policy the plan is written around: 5,139 → 5,900, renewed each September. */
function insured(): AnnualItems {
  return withItem(EMPTY_ANNUAL_ITEMS, "car", "ביטוח רכב מקיף", [
    [d(2024, 9, 1), 5_139],
    [d(2025, 9, 1), 5_900],
  ]);
}

function itemRowOf(rows: readonly RateWatchItemRow[], key: string): RateWatchItemRow {
  const found = rows.find((row) => row.key === key);
  if (found === undefined) throw new Error(`No annual item row ${key}`);
  return found;
}

// --- what the band lists ------------------------------------------------------

describe("which rows the band holds", () => {
  const ledger = buildLedger({
    entered: [
      ...every("y-net", m(2025, 1), m(2026, 7), ils(50)),
      ...every("e-net", m(2025, 1), m(2026, 7), ils(30)),
      ...every("y-music", m(2025, 1), m(2026, 7), ils(22)),
      ...every("y-food", m(2025, 1), m(2026, 7), ils(2000)),
    ],
  });

  it("lists exactly the watched household categories and nothing else", () => {
    const watch = rateWatch(ledger, categories(["h-net", "h-music"]), EMPTY_ANNUAL_ITEMS, 2026, ILS, TODAY);
    expect(watch.monthly.rows.map((row) => row.key).sort()).toEqual(["h-music", "h-net"]);
  });

  it("renders as an empty band when nothing is watched, rather than as every category", () => {
    expect(monthlyRows(ledger, categories(), 2026)).toEqual([]);
  });

  it("sums both People's contributions into the one household line", () => {
    const watch = rateWatch(ledger, categories(["h-net"]), EMPTY_ANNUAL_ITEMS, 2026, ILS, TODAY);
    const net = rowOf(watch.monthly.rows, "h-net");

    // 50 + 30 a month, seven counted months of 2026.
    expect(net.rate).toEqual({
      kind: "fixed",
      amount: ils(80),
      months: [m(2026, 5), m(2026, 6), m(2026, 7)],
    });
    expect(net.current.total).toEqual(ils(560));
  });

  it("reads at household level whatever the grid above is showing", () => {
    // There is no scope parameter to get wrong: a rate paid half by each Person
    // is one rate, and the flag lives on the household line.
    const watch = rateWatch(ledger, categories(["h-net"]), EMPTY_ANNUAL_ITEMS, 2026, ILS, TODAY);
    expect(rowOf(watch.monthly.rows, "h-net").personId).toBeNull();
  });

  it("orders by the selected year, largest first, and the order is total", () => {
    const watched = categories(["h-net", "h-music", "h-food"]);
    const watch = rateWatch(ledger, watched, EMPTY_ANNUAL_ITEMS, 2026, ILS, TODAY);
    expect(watch.monthly.rows.map((row) => row.key)).toEqual(["h-food", "h-net", "h-music"]);
  });
});

// --- the rate, which is worked out rather than asked for ----------------------

describe("the current rate", () => {
  it("is the figure the last three recorded months agree on", () => {
    const ledger = buildLedger({ entered: every("y-music", m(2025, 1), m(2026, 7), ils(22)) });
    const watch = rateWatch(ledger, categories(["h-music"]), EMPTY_ANNUAL_ITEMS, 2026, ILS, TODAY);

    expect(rowOf(watch.monthly.rows, "h-music").rate).toEqual({
      kind: "fixed",
      amount: ils(22),
      months: [m(2026, 5), m(2026, 6), m(2026, 7)],
    });
  });

  it("is משתנה when those three months do not agree", () => {
    const ledger = buildLedger({
      entered: [
        ...every("y-music", m(2025, 1), m(2026, 6), ils(22)),
        { personalCategoryId: "y-music", month: m(2026, 7), amount: ils(25) },
      ],
    });
    const row = rowOf(monthlyRows(ledger, categories(["h-music"]), 2026), "h-music");

    // The year's own monthly average travels with it — 22 × 6 + 25, over seven.
    expect(row.rate).toEqual({ kind: "variable", average: ils(22.43) });
    expect(row.current.average.amount).toEqual(ils(22.43));
  });

  it("is משתנה on fewer than three recorded months, because two is a coincidence", () => {
    const ledger = buildLedger({
      entered: [
        { personalCategoryId: "y-music", month: m(2026, 6), amount: ils(22) },
        { personalCategoryId: "y-music", month: m(2026, 7), amount: ils(22) },
      ],
    });
    const row = rowOf(monthlyRows(ledger, categories(["h-music"]), 2026), "h-music");
    expect(row.rate.kind).toBe("variable");
  });

  it("skips the months nothing was recorded in rather than treating them as a change", () => {
    const ledger = buildLedger({
      entered: [
        { personalCategoryId: "y-music", month: m(2026, 1), amount: ils(22) },
        { personalCategoryId: "y-music", month: m(2026, 3), amount: ils(22) },
        { personalCategoryId: "y-music", month: m(2026, 5), amount: ils(22) },
      ],
    });
    expect(
      rowOf(monthlyRows(ledger, categories(["h-music"]), 2026), "h-music").rate,
    ).toEqual({ kind: "fixed", amount: ils(22), months: [m(2026, 1), m(2026, 3), m(2026, 5)] });
  });

  it("says what the household pays now even when an older year is being read", () => {
    // 45 through 2025, 55 from 2026. Opening 2025 still answers "עכשיו", because
    // that is what the word means.
    const ledger = buildLedger({
      entered: [
        ...every("y-music", m(2025, 1), m(2025, 12), ils(45)),
        ...every("y-music", m(2026, 1), m(2026, 7), ils(55)),
      ],
    });
    const row = rowOf(monthlyRows(ledger, categories(["h-music"]), 2025), "h-music");
    expect(row.rate).toEqual({
      kind: "fixed",
      amount: ils(55),
      months: [m(2026, 5), m(2026, 6), m(2026, 7)],
    });
  });
});

// --- the two years, and the change between them --------------------------------

describe("the two years", () => {
  /** 45 a month through 2025 and 55 from 2026 — the plan's own רייזאפ. */
  const ledger = buildLedger({
    entered: [
      ...every("y-music", m(2025, 1), m(2025, 10), ils(45)),
      ...every("y-music", m(2025, 11), m(2026, 7), ils(55)),
    ],
  });

  it("sums what was actually recorded rather than annualising the rate", () => {
    const row = rowOf(monthlyRows(ledger, categories(["h-music"]), 2025), "h-music");
    // Ten months at 45 and two at 55 is 560, not 55 × 12.
    expect(row.current.total).toEqual(ils(560));
    expect(row.rate).toEqual({
      kind: "fixed",
      amount: ils(55),
      months: [m(2026, 5), m(2026, 6), m(2026, 7)],
    });
  });

  it("states the change in ₪ and in %", () => {
    const row = rowOf(monthlyRows(ledger, categories(["h-music"]), 2026), "h-music");
    // ינואר–יולי on both sides: 7 × 55 against 7 × 45.
    expect(row.current.total).toEqual(ils(385));
    expect(row.previous.total).toEqual(ils(315));
    expect(row.change).toEqual({
      kind: "compared",
      amount: ils(70),
      ratio: 70 / 315,
      mark: null,
    });
  });

  it("matches the earlier year to the same months, so nothing collapses every January", () => {
    const row = rowOf(monthlyRows(ledger, categories(["h-music"]), 2026), "h-music");
    expect(row.current.average.months).toEqual(monthRange(m(2026, 1), m(2026, 7)));
    expect(row.previous.average.months).toEqual(monthRange(m(2025, 1), m(2025, 7)));
  });

  it("refuses a comparison when the two sides rest on different numbers of months", () => {
    // 2025 holds twelve; 2024 holds only the six the history reaches.
    const half = buildLedger({
      entered: [
        ...every("y-music", m(2024, 7), m(2024, 12), ils(22)),
        ...every("y-music", m(2025, 1), m(2025, 12), ils(22)),
      ],
    });
    expect(
      rowOf(monthlyRows(half, categories(["h-music"]), 2025), "h-music").change,
    ).toEqual({ kind: "uneven", current: 12, previous: 6 });
  });

  it("shows a first year as its own figures and no change, never as a rise from nothing", () => {
    const fresh = buildLedger({ entered: every("y-music", m(2026, 1), m(2026, 7), ils(22)) });
    const row = rowOf(monthlyRows(fresh, categories(["h-music"]), 2026), "h-music");
    expect(row.previous.total).toBeNull();
    expect(row.change).toEqual({ kind: "first-year" });
  });

  it("leaves a year nobody recorded blank rather than reporting it as nought", () => {
    const row = rowOf(monthlyRows(ledger, categories(["h-food"]), 2026), "h-food");
    expect(row.current.total).toBeNull();
    expect(row.previous.total).toBeNull();
    expect(row.change).toEqual({ kind: "not-recorded" });
    // And the blank is not a zero hiding behind a helper: the Average's own total
    // is zero, and the reading refuses to present it as a figure.
    expect(row.current.average.recordedMonths).toBe(0);
  });

  it("gives a year that holds nothing no average either, rather than a divided zero", () => {
    // The rate column is the same rule as the year column: nothing recorded is
    // nothing to state, and 0 ÷ 12 is not a rate anybody pays.
    const row = rowOf(monthlyRows(ledger, categories(["h-food"]), 2026), "h-food");
    expect(row.rate).toEqual({ kind: "variable", average: null });
  });
});

// --- what gets marked ---------------------------------------------------------

describe("the 10% / 300₪ bars", () => {
  /** A row at `before` a month through 2025 and `after` a month through 2026. */
  function moved(before: number, after: number) {
    const ledger = buildLedger({
      entered: [
        ...every("y-music", m(2025, 1), m(2025, 12), ils(before)),
        ...every("y-music", m(2026, 1), m(2026, 7), ils(after)),
      ],
    });
    return rowOf(monthlyRows(ledger, categories(["h-music"]), 2026), "h-music");
  }

  it.each([
    // Both bars cleared: a 500₪ line up by 15% is +525₪ over seven months.
    ["clears both", 500, 575, "up"],
    ["clears both, downwards", 500, 425, "down"],
    // A big move in money on a line that barely changed as a share of itself.
    ["clears money but not the share", 5_000, 5_400, null],
    // A big move as a share of a small line: +40% and only 154₪.
    ["clears the share but not money", 55, 77, null],
  ])("%s", (_label, before, after, mark) => {
    expect(moved(before, after).change).toMatchObject({ kind: "compared", mark });
  });

  it("never marks a משתנה row, however far it moved", () => {
    const ledger = buildLedger({
      entered: [
        ...every("y-food", m(2025, 1), m(2025, 12), ils(500)),
        ...every("y-food", m(2026, 1), m(2026, 6), ils(2_000)),
        { personalCategoryId: "y-food", month: m(2026, 7), amount: ils(2_500) },
      ],
    });
    const row = rowOf(monthlyRows(ledger, categories(["h-food"]), 2026), "h-food");

    expect(row.rate.kind).toBe("variable");
    expect(row.change).toMatchObject({ kind: "compared", mark: null });
  });
});

// --- the subtotal --------------------------------------------------------------

describe("the band's own subtotal", () => {
  const ledger = buildLedger({
    entered: [
      ...every("y-net", m(2026, 1), m(2026, 7), ils(80)),
      ...every("y-music", m(2026, 1), m(2026, 7), ils(22)),
      ...every("y-food", m(2026, 1), m(2026, 6), ils(2_000)),
      { personalCategoryId: "y-food", month: m(2026, 7), amount: ils(2_500) },
    ],
  });

  it("adds the rates and leaves the משתנה rows out, because they have none", () => {
    const watched = categories(["h-net", "h-music", "h-food"]);
    const band = rateWatch(ledger, watched, EMPTY_ANNUAL_ITEMS, 2026, ILS, TODAY).monthly;
    expect(band.subtotal).toEqual(ils(102));
    expect(band.ratedRows).toBe(2);
    expect(band.unratedRows).toBe(1);
  });

  it("is a sum of rates and never of the years beside them", () => {
    const watched = categories(["h-net", "h-music"]);
    const band = rateWatch(ledger, watched, EMPTY_ANNUAL_ITEMS, 2026, ILS, TODAY).monthly;
    const years = band.rows.map((row) => row.current.total?.minorUnits ?? 0);
    expect(years.reduce((total, next) => total + next, 0)).not.toBe(band.subtotal.minorUnits);
  });

  it("has a currency even when the band is empty", () => {
    const watch = rateWatch(ledger, categories(), EMPTY_ANNUAL_ITEMS, 2026, ILS, TODAY);
    expect(watch.monthly.subtotal).toEqual(ils(0));
  });
});

// --- the typed band -------------------------------------------------------------

/**
 * פריטים שנתיים — the half the ledger cannot supply. The ledger below is empty
 * throughout: an Annual Item is typed, and nothing about it is read out of
 * `entries`.
 */
describe("the typed band", () => {
  const EMPTY_LEDGER = buildLedger({ entered: [] });

  const typed = (items: AnnualItems, year: number) =>
    rateWatch(EMPTY_LEDGER, categories(), items, year, ILS, TODAY).annual;

  it("shows the current rate as the newest policy total over twelve", () => {
    const row = itemRowOf(typed(insured(), 2026).rows, "car");
    expect(row.rate).toEqual({
      kind: "renewed",
      total: ils(5_900),
      monthly: ils(491.67),
      renewedOn: d(2025, 9, 1),
    });
  });

  it("derives each figure's year from its date, with no year stored anywhere", () => {
    const row = itemRowOf(typed(insured(), 2025).rows, "car");
    expect(row.current).toEqual({
      year: 2025,
      reading: { kind: "renewed", total: ils(5_900), renewals: 1 },
    });
    expect(row.previous).toEqual({
      year: 2024,
      reading: { kind: "renewed", total: ils(5_139), renewals: 1 },
    });
  });

  it("states the change in ₪ and in %, and marks the move the bars were chosen for", () => {
    // The plan's own case: 5,139 → 5,900 is +761₪ and +15%, which the grid's own
    // 50% / 1,000₪ bar would have missed entirely.
    const row = itemRowOf(typed(insured(), 2025).rows, "car");
    expect(row.change).toEqual({
      kind: "compared",
      amount: ils(761),
      ratio: 761 / 5_139,
      mark: "up",
    });
  });

  it("uses the identical marking the derived band uses — one implementation", () => {
    // A 15% rise on a 500₪-a-month subscription is +525₪ over seven months and is
    // marked in the band below; the same pair of bars decides this row.
    const cheap = withItem(EMPTY_ANNUAL_ITEMS, "small", "לובי99", [
      [d(2024, 3, 1), 300],
      [d(2025, 3, 1), 360],
    ]);
    // +20% but only +60₪: over the money bar's head, exactly as רייזאפ is below.
    expect(itemRowOf(typed(cheap, 2025).rows, "small").change).toMatchObject({
      kind: "compared",
      mark: null,
    });
  });

  it("reads a year with no renewal as לא חודש, never as nought", () => {
    // Renewed each September, read in 2026 before September has come round.
    const row = itemRowOf(typed(insured(), 2026).rows, "car");
    expect(row.current.reading).toEqual({ kind: "not-renewed" });
    expect(row.change).toEqual({ kind: "not-recorded" });
  });

  it("reads a year before the item existed as outside its life, not as לא חודש", () => {
    const row = itemRowOf(typed(insured(), 2024).rows, "car");
    expect(row.current.reading).toEqual({ kind: "renewed", total: ils(5_139), renewals: 1 });
    expect(row.previous.reading).toEqual({ kind: "outside" });
  });

  it("shows a first year as its own figures and no comparison", () => {
    const fresh = withItem(EMPTY_ANNUAL_ITEMS, "fee", "רו\"ח", [[d(2026, 3, 1), 3_346]]);
    const row = itemRowOf(typed(fresh, 2026).rows, "fee");
    expect(row.current.reading).toEqual({ kind: "renewed", total: ils(3_346), renewals: 1 });
    expect(row.change).toEqual({ kind: "first-year" });
  });

  it("keeps both renewals of a year that holds two, and refuses to compare it against one", () => {
    // A policy that slipped from December to January: 2025 holds two prices, and
    // subtracting them from 2024's one would report the slip as a doubling.
    const slipped = withItem(EMPTY_ANNUAL_ITEMS, "car", "ביטוח רכב מקיף", [
      [d(2024, 9, 1), 5_139],
      [d(2025, 1, 5), 5_400],
      [d(2025, 12, 20), 5_900],
    ]);
    const row = itemRowOf(typed(slipped, 2025).rows, "car");

    expect(row.current.reading).toEqual({ kind: "renewed", total: ils(11_300), renewals: 2 });
    expect(row.change).toEqual({ kind: "uneven", current: 2, previous: 1 });
  });

  it("has no rate, and is not marked, once every price is removed", () => {
    const emptied = buildAnnualItems({ items: insured().items, renewals: [] });
    const row = itemRowOf(typed(emptied, 2026).rows, "car");
    expect(row.rate).toEqual({ kind: "never" });
    expect(row.change).toEqual({ kind: "not-recorded" });
  });

  it("prints its own subtotal of monthly rates, and no total across the two bands", () => {
    const both = withItem(insured(), "fee", "רו\"ח", [[d(2026, 3, 1), 3_600]]);
    const band = typed(both, 2026);

    // 5,900 ÷ 12 and 3,600 ÷ 12 — the rates, and nothing about the years beside them.
    expect(band.subtotal).toEqual(ils(791.67));
    expect(band.ratedRows).toBe(2);
    expect(band.unratedRows).toBe(0);

    // And the reading offers no field that adds the two bands together.
    const watch = rateWatch(EMPTY_LEDGER, categories(["h-net"]), both, 2026, ILS, TODAY);
    expect(Object.keys(watch).sort()).toEqual([
      "annual",
      "currentMonths",
      "monthly",
      "previousMonths",
      "previousYear",
      "year",
    ]);
  });

  it("orders by what each item costs now, most expensive first", () => {
    const many = withItem(withItem(insured(), "fee", "רו\"ח", [[d(2026, 3, 1), 3_346]]), "lic", "רישוי", [
      [d(2026, 2, 1), 1_154],
    ]);
    expect(typed(many, 2026).rows.map((row) => row.name)).toEqual(["ביטוח רכב מקיף", "רו\"ח", "רישוי"]);
  });

  it("renders as an empty band when nothing has been typed", () => {
    expect(typed(EMPTY_ANNUAL_ITEMS, 2026)).toEqual({
      rows: [],
      subtotal: ils(0),
      ratedRows: 0,
      unratedRows: 0,
    });
  });
});

// --- what the typed band leaves alone --------------------------------------------

describe("a Rate Watch write moves nothing in the מאזן", () => {
  const model = categories(["h-net"]);
  const ledger = buildLedger({
    entered: [
      ...every("y-net", m(2025, 1), m(2026, 7), ils(50)),
      ...every("e-net", m(2025, 1), m(2026, 7), ils(30)),
    ],
  });

  /** Creating an item, renewing it, correcting that renewal and removing one. */
  function everyWrite(): AnnualItems {
    const created = insured();
    const renewed = applyRenewal(
      created,
      planRenewal(created, "car", { renewedOn: d(2026, 9, 1), amount: ils(6_400) }),
    );
    const corrected = applyRenewalCorrection(
      renewed,
      planRenewalCorrection(renewed, "car", d(2026, 9, 1), {
        renewedOn: d(2026, 9, 1),
        amount: ils(6_300),
      }),
    );
    return applyRenewalRemoval(corrected, planRenewalRemoval(corrected, "car", d(2024, 9, 1)));
  }

  it("leaves the grid byte-identical", () => {
    const before = yearGrid(ledger, model, HOUSEHOLD_SCOPE, 2026, ILS, TODAY);
    everyWrite();
    const after = yearGrid(ledger, model, HOUSEHOLD_SCOPE, 2026, ILS, TODAY);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("leaves the derived band byte-identical, so the two bands are independent", () => {
    const before = rateWatch(ledger, model, EMPTY_ANNUAL_ITEMS, 2026, ILS, TODAY).monthly;
    const after = rateWatch(ledger, model, everyWrite(), 2026, ILS, TODAY).monthly;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

// --- one figure, one computation ----------------------------------------------

describe("against the grid directly above it", () => {
  const model = categories(["h-net", "h-music"]);
  const ledger = buildLedger({
    entered: [
      ...every("y-net", m(2025, 1), m(2026, 7), ils(50)),
      ...every("e-net", m(2025, 1), m(2026, 7), ils(30)),
      ...every("y-music", m(2025, 1), m(2026, 7), ils(22)),
    ],
  });

  it("divides by exactly the months the grid's aggregate column divides by", () => {
    const watch = rateWatch(ledger, model, EMPTY_ANNUAL_ITEMS, 2026, ILS, TODAY);
    const months = denominatorMonths(yearPeriod(2026), TODAY, recordedSpan(ledger));

    for (const row of watch.monthly.rows) {
      const group = categoryGroups(model, HOUSEHOLD_SCOPE).find((candidate) => candidate.key === row.key);
      expect(group).toBeDefined();
      if (group === undefined) continue;
      expect(row.current.average).toEqual(averageOverMonths(ledger, group, months, ILS));
    }
  });

  it("prints the same figure the grid's own row prints for that year", () => {
    const grid = yearGrid(ledger, model, HOUSEHOLD_SCOPE, 2026, ILS, TODAY);
    const watch = rateWatch(ledger, model, EMPTY_ANNUAL_ITEMS, 2026, ILS, TODAY);

    for (const row of watch.monthly.rows) {
      const gridRow = grid.expenses.rows.find((candidate) => candidate.key === row.key);
      expect(gridRow?.aggregate.total).toEqual(row.current.average.total);
      expect(gridRow?.aggregate.amount).toEqual(row.current.average.amount);
    }
  });

  it("moves no figure on the grid when a category is flagged or unflagged", () => {
    const before = yearGrid(ledger, categories(), HOUSEHOLD_SCOPE, 2026, ILS, TODAY);
    const flagged = yearGrid(ledger, model, HOUSEHOLD_SCOPE, 2026, ILS, TODAY);
    const unflagged = yearGrid(
      ledger,
      applyHouseholdWatch(model, planHouseholdWatch(model, "h-net", false)),
      HOUSEHOLD_SCOPE,
      2026,
      ILS,
      TODAY,
    );

    expect(flagged).toEqual(before);
    expect(unflagged).toEqual(before);
  });
});

// --- the calibration ------------------------------------------------------------

/**
 * The 10% / 300₪ pair against the household's real 2024–2026 history, read out of
 * the committed sheet export rather than out of a fixture invented to agree with
 * it. This is the calibration the plan asks to be *recorded*: what the bars mark,
 * and — the part that matters — what they leave alone.
 */
describe("calibrated against the real subscription history", () => {
  const EXPORT = readFileSync("docs/source/maazan-sheet-export.md", "utf8");

  const PROPOSAL = planSheetImport(parseSheetExport(EXPORT, { currency: ILS }), {
    currency: ILS,
    people: [
      { id: "yuval", sheetName: "יובל" },
      { id: "eden", sheetName: "עדן" },
    ],
  });

  const PLAN = planWrites(PROPOSAL, defaultSelection(PROPOSAL));

  /** Every household line watched at once, which is the harshest reading of the bars. */
  const REAL = buildCategories({
    personal: PLAN.categories.map((category) => ({
      id: category.key,
      personId: category.personId,
      name: category.name,
      type: category.type,
      activeFrom: category.activeFrom,
      activeUntil: category.activeUntil,
    })),
    household: PLAN.households.map((household) => ({
      id: household.key,
      name: household.name,
      type: household.type,
      watched: true,
    })),
    assignments: PLAN.categories.map((category) => ({
      personalCategoryId: category.key,
      householdCategoryId: category.householdKey,
    })),
  });

  const REAL_LEDGER = buildLedger({
    entered: PLAN.entries.map((entry) => ({
      personalCategoryId: entry.categoryKey,
      month: entry.month,
      amount: entry.amount,
    })),
  });

  const WATCH_2026 = rateWatch(REAL_LEDGER, REAL, EMPTY_ANNUAL_ITEMS, 2026, ILS, TODAY);

  function named(name: string): RateWatchRow {
    const found = WATCH_2026.monthly.rows.find((row) => row.name === name);
    if (found === undefined) throw new Error(`No household line named ${name}`);
    return found;
  }

  it("reads the household's own subscriptions, ינואר–יולי against ינואר–יולי", () => {
    // Every figure below is the sheet's, summed across both People by the same
    // reading the grid uses. If the export changes, these change with it.
    expect(named("אפל מיוזיק").current.total).toEqual(ils(154));
    expect(named("לובי99").current.total).toEqual(ils(175));
    expect(named("רייזאפ").current.total).toEqual(ils(770));
    expect(named("מכבי").current.total).toEqual(ils(800));
    expect(named("אינטרנט").current.total).toEqual(ils(571));
  });

  it("marks nothing in the derived band, and that is the calibration", () => {
    // Every fixed-rate subscription the household holds is between 22₪ and 110₪ a
    // month, so none of them can move by 300₪ over seven months. The panel's marks
    // are for the typed band's annual bills — car insurance at 5,139 → 5,900 is
    // +15% and +761₪ — and for the creep the full history shows in Phase 26.
    const marked = WATCH_2026.monthly.rows.filter(
      (row) => row.change.kind === "compared" && row.change.mark !== null,
    );
    expect(marked).toEqual([]);
  });

  it("leaves the flat subscriptions entirely alone", () => {
    for (const name of ["אפל מיוזיק", "לובי99", "אינטרנט"]) {
      expect(named(name).change).toMatchObject({ kind: "compared", mark: null });
    }
    // Flat to the agora over both years, so there is nothing for either bar to see.
    expect(named("אפל מיוזיק").change).toMatchObject({ amount: ils(0) });
    expect(named("לובי99").change).toMatchObject({ amount: ils(0) });
  });

  it("is the money bar that keeps רייזאפ off the screen, not the share bar", () => {
    // 45 → 55 a month for each of them is +140₪ over seven months and +22%. A
    // percentage bar on its own would report a twenty-shekel-a-month subscription
    // as a finding; 300₪ is what makes the mark mean *worth a phone call*.
    const change = named("רייזאפ").change;
    expect(change).toMatchObject({ kind: "compared", amount: ils(140), mark: null });
    if (change.kind !== "compared" || change.ratio === null) throw new Error("expected a comparison");
    expect(change.ratio).toBeGreaterThan(0.1);
  });

  it("leaves מכבי's creep to the full history rather than to one year", () => {
    // 96 → 207 across three years, but ינואר–יולי 2026 against ינואר–יולי 2025 is
    // +104₪ and +15%. No single year jumps enough, which is exactly why Phase 26
    // opens the panel to every recorded year.
    expect(named("מכבי").change).toMatchObject({ kind: "compared", amount: ils(104), mark: null });
  });

  it("refuses 2025 against 2024, where the history reaches only half the year", () => {
    const watch2025 = rateWatch(REAL_LEDGER, REAL, EMPTY_ANNUAL_ITEMS, 2025, ILS, TODAY);
    const rate = watch2025.monthly.rows.find((row) => row.name === "רייזאפ");
    expect(rate?.change).toEqual({ kind: "uneven", current: 12, previous: 6 });
  });

  it("marks the annual bill the bars were chosen for", () => {
    // The plan's own case, on the same machinery: 5,139 → 5,900 is +761₪ and +15%,
    // and it is the thing the grid's 50% / 1,000₪ bar would have missed entirely.
    const ledger = buildLedger({
      entered: [
        ...every("y-music", m(2025, 1), m(2025, 12), ils(5_139 / 12)),
        ...every("y-music", m(2026, 1), m(2026, 7), ils(5_900 / 12)),
      ],
    });
    const row = rowOf(monthlyRows(ledger, categories(["h-music"]), 2026), "h-music");
    expect(row.change).toMatchObject({ kind: "compared", mark: "up" });
  });
});
