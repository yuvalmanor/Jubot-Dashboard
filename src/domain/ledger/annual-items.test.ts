import { describe, expect, it } from "vitest";

import {
  type AnnualItems,
  DuplicateAnnualItemNameError,
  DuplicateRenewalError,
  EMPTY_ANNUAL_ITEMS,
  InvalidAnnualItemError,
  InvalidRenewalError,
  MalformedAnnualItemsError,
  UnknownAnnualItemError,
  UnknownRenewalError,
  UnsupportedRenewalCurrencyError,
  applyAnnualItemCreation,
  applyRenewal,
  applyRenewalCorrection,
  applyRenewalRemoval,
  buildAnnualItems,
  latestRenewal,
  planAnnualItemCreation,
  planRenewal,
  planRenewalCorrection,
  planRenewalRemoval,
  renewalsOf,
} from "./annual-items";
import { money } from "@/domain/money/money";
import { calendarDate } from "@/domain/time/calendar-date";

/**
 * The typed half of מעקב תעריפים, against plain data. No database is imported
 * here and none is needed: the model is handed in and handed back.
 */

const ils = (major: number) => money(Math.round(major * 100), "ILS");
const d = (year: number, month: number, day: number) => calendarDate(year, month, day);

/** ביטוח רכב מקיף, renewed each September at the plan's own figures. */
function insured(): AnnualItems {
  const created = applyAnnualItemCreation(
    EMPTY_ANNUAL_ITEMS,
    planAnnualItemCreation(
      EMPTY_ANNUAL_ITEMS,
      { name: "ביטוח רכב מקיף", renewedOn: d(2024, 9, 1), amount: ils(5_139) },
      { itemId: "car" },
    ),
  );
  return applyRenewal(created, planRenewal(created, "car", { renewedOn: d(2025, 9, 1), amount: ils(5_900) }));
}

describe("creating an annual item", () => {
  it("writes the item and its first renewal as one result", () => {
    const creation = planAnnualItemCreation(
      EMPTY_ANNUAL_ITEMS,
      { name: "רו\"ח", renewedOn: d(2025, 3, 15), amount: ils(3_346) },
      { itemId: "accountant" },
    );

    expect(creation.item).toEqual({
      id: "accountant",
      name: "רו\"ח",
      // The life begins where the price history begins — no separate field to get wrong.
      startedOn: d(2025, 3, 15),
      endedOn: null,
    });
    expect(creation.renewal).toEqual({
      itemId: "accountant",
      renewedOn: d(2025, 3, 15),
      amount: ils(3_346),
    });
  });

  it("normalises the name and refuses an empty or over-long one", () => {
    const creation = planAnnualItemCreation(
      EMPTY_ANNUAL_ITEMS,
      { name: "  ביטוח   דירה ", renewedOn: d(2025, 1, 1), amount: ils(590) },
      { itemId: "home" },
    );
    expect(creation.item.name).toBe("ביטוח דירה");

    expect(() =>
      planAnnualItemCreation(
        EMPTY_ANNUAL_ITEMS,
        { name: "   ", renewedOn: d(2025, 1, 1), amount: ils(590) },
        { itemId: "blank" },
      ),
    ).toThrow(InvalidAnnualItemError);
  });

  it("refuses a second item under the same name", () => {
    const model = insured();
    expect(() =>
      planAnnualItemCreation(
        model,
        { name: "ביטוח רכב מקיף", renewedOn: d(2026, 9, 1), amount: ils(6_000) },
        { itemId: "other" },
      ),
    ).toThrow(DuplicateAnnualItemNameError);
  });

  it("refuses a currency the panel does not hold, rather than coercing it to shekels", () => {
    expect(() =>
      planAnnualItemCreation(
        EMPTY_ANNUAL_ITEMS,
        { name: "iCloud", renewedOn: d(2026, 1, 1), amount: money(2_000, "USD") },
        { itemId: "icloud" },
      ),
    ).toThrow(UnsupportedRenewalCurrencyError);
  });

  it("refuses an amount of nought, because a policy that cost nothing was not renewed", () => {
    expect(() =>
      planAnnualItemCreation(
        EMPTY_ANNUAL_ITEMS,
        { name: "רישוי", renewedOn: d(2026, 1, 1), amount: ils(0) },
        { itemId: "licence" },
      ),
    ).toThrow(InvalidRenewalError);
  });
});

describe("recording a renewal", () => {
  it("keeps every price, newest last", () => {
    const model = insured();
    expect(renewalsOf(model, "car").map((renewal) => renewal.amount)).toEqual([ils(5_139), ils(5_900)]);
    expect(latestRenewal(model, "car")?.amount).toEqual(ils(5_900));
  });

  it("keeps two renewals inside one calendar year, and neither overwrites the other", () => {
    // A policy that slipped from December to January leaves one year holding both.
    const model = insured();
    const slipped = applyRenewal(
      model,
      planRenewal(model, "car", { renewedOn: d(2025, 12, 20), amount: ils(6_100) }),
    );

    const inTwentyFive = renewalsOf(slipped, "car").filter((renewal) => renewal.renewedOn.year === 2025);
    expect(inTwentyFive.map((renewal) => renewal.amount)).toEqual([ils(5_900), ils(6_100)]);
  });

  it("refuses two prices on the same day, which would be one figure written twice", () => {
    const model = insured();
    expect(() =>
      planRenewal(model, "car", { renewedOn: d(2025, 9, 1), amount: ils(6_000) }),
    ).toThrow(DuplicateRenewalError);
  });

  it("moves the item's life back when the price recorded predates it", () => {
    // Backfilling last year's quote is an ordinary act, not a refusal: an item's
    // life begins where its price history begins.
    const model = insured();
    const recording = planRenewal(model, "car", { renewedOn: d(2023, 9, 1), amount: ils(4_800) });
    expect(recording.startedOn).toEqual(d(2023, 9, 1));

    const backfilled = applyRenewal(model, recording);
    expect(backfilled.items[0]?.startedOn).toEqual(d(2023, 9, 1));
  });

  it("leaves the life alone for a price inside it", () => {
    const model = insured();
    expect(planRenewal(model, "car", { renewedOn: d(2026, 9, 1), amount: ils(6_200) }).startedOn).toBeNull();
  });

  it("refuses a renewal against an item that does not exist", () => {
    expect(() =>
      planRenewal(insured(), "nothing", { renewedOn: d(2026, 1, 1), amount: ils(100) }),
    ).toThrow(UnknownAnnualItemError);
  });
});

describe("correcting a renewal", () => {
  it("changes the amount in place", () => {
    const model = insured();
    const corrected = applyRenewalCorrection(
      model,
      planRenewalCorrection(model, "car", d(2025, 9, 1), {
        renewedOn: d(2025, 9, 1),
        amount: ils(5_950),
      }),
    );

    expect(renewalsOf(corrected, "car").map((renewal) => renewal.amount)).toEqual([ils(5_139), ils(5_950)]);
  });

  it("moves the date, which moves which year the figure belongs to", () => {
    const model = insured();
    const moved = applyRenewalCorrection(
      model,
      planRenewalCorrection(model, "car", d(2025, 9, 1), {
        renewedOn: d(2026, 1, 5),
        amount: ils(5_900),
      }),
    );

    expect(renewalsOf(moved, "car").map((renewal) => renewal.renewedOn.year)).toEqual([2024, 2026]);
  });

  it("refuses to move one onto a day the item already holds", () => {
    const model = insured();
    expect(() =>
      planRenewalCorrection(model, "car", d(2025, 9, 1), {
        renewedOn: d(2024, 9, 1),
        amount: ils(5_900),
      }),
    ).toThrow(DuplicateRenewalError);
  });

  it("refuses to correct a renewal that is not there", () => {
    expect(() =>
      planRenewalCorrection(insured(), "car", d(2020, 9, 1), {
        renewedOn: d(2020, 9, 1),
        amount: ils(100),
      }),
    ).toThrow(UnknownRenewalError);
  });
});

describe("removing a renewal", () => {
  it("removes the price and keeps the item", () => {
    const model = insured();
    const removed = applyRenewalRemoval(model, planRenewalRemoval(model, "car", d(2025, 9, 1)));

    expect(removed.items).toEqual(model.items);
    expect(renewalsOf(removed, "car").map((renewal) => renewal.amount)).toEqual([ils(5_139)]);
  });

  it("leaves an item with no prices rather than deleting it", () => {
    const model = insured();
    const emptied = renewalsOf(model, "car").reduce(
      (running, renewal) =>
        applyRenewalRemoval(running, planRenewalRemoval(running, "car", renewal.renewedOn)),
      model,
    );

    expect(emptied.items).toHaveLength(1);
    expect(latestRenewal(emptied, "car")).toBeUndefined();
  });

  it("refuses to remove one that is not there", () => {
    expect(() => planRenewalRemoval(insured(), "car", d(2019, 9, 1))).toThrow(UnknownRenewalError);
  });
});

describe("building a model", () => {
  it("refuses a renewal pointing at no item", () => {
    expect(() =>
      buildAnnualItems({
        items: [],
        renewals: [{ itemId: "ghost", renewedOn: d(2025, 1, 1), amount: ils(10) }],
      }),
    ).toThrow(UnknownAnnualItemError);
  });

  it("refuses a renewal older than the item's own life", () => {
    expect(() =>
      buildAnnualItems({
        items: [{ id: "car", name: "ביטוח", startedOn: d(2025, 1, 1), endedOn: null }],
        renewals: [{ itemId: "car", renewedOn: d(2024, 1, 1), amount: ils(10) }],
      }),
    ).toThrow(MalformedAnnualItemsError);
  });

  it("refuses an item that ends before it starts", () => {
    expect(() =>
      buildAnnualItems({
        items: [{ id: "car", name: "ביטוח", startedOn: d(2025, 1, 1), endedOn: d(2024, 1, 1) }],
        renewals: [],
      }),
    ).toThrow(MalformedAnnualItemsError);
  });
});
