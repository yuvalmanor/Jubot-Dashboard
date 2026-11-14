import { describe, expect, it } from "vitest";

import {
  type FoldedTotal,
  type RiseUpActual,
  type RiseUpFold,
  type RiseUpMapping,
  type RiseUpMonth,
  type TransactionDisposition,
  expenseTotals,
  foldRiseUpMonth,
  roundToShekel,
} from "@/domain/import/riseup-fold";
import { fromMajorUnits, toDecimalString } from "@/domain/money/money";
import { monthKey } from "@/domain/time/calendar-month";

/**
 * The fixture is **invented**, not a trimmed response: no real RiseUp output is
 * ever committed (ADR 0006), and a hand-written month is the only one whose every
 * figure is known in advance. It carries its own mapping file too, so these tests
 * never read `docs/source/riseup-yuval.json` — a rule changed there must not be
 * able to turn a rule's test green.
 *
 * What it is built to exercise, case by case:
 *
 * - three weekly envelopes of one category, which must be summed and then rounded
 *   **once** (600.10 + 700.22 + 575.25 = 1,875.57 → 1,876; rounding each week
 *   first would give 1,875);
 * - three lines into one Personal Category, which must be rounded **each** and
 *   then added (125.74 + 62.74 + 62.83 → 126 + 63 + 63 = 252; rounding the sum
 *   would give 251);
 * - two fixed items with the same merchant, different `sequenceId`s and different
 *   envelope ids, one mapped and one not;
 * - a fixed item with no charge at all, which is blank by definition and is not an
 *   unmapped row;
 * - a tracked category RiseUp holds but nothing was spent in, which is *not
 *   recorded* rather than 0;
 * - an excluded transaction, which reaches no total;
 * - credits inside an expense row and inside variable income, which are reported
 *   and change no figure until Phase 31 records a disposition;
 * - the savings category and the RiseUp goal, silenced by `never-write`;
 * - the salary charge, and the predicted salary that is never substituted for it.
 */

const MAPPING: RiseUpMapping = {
  person: "fixture",
  server: "riseup-fixture",
  incomeCategory: "הכנסות",
  variableCategory: "משתנות",
  categoryRules: [
    { riseupCategory: "כלכלה", personalCategory: "סופר" },
    { riseupCategory: "מנויים", personalCategory: "מנויים" },
    { riseupCategory: "מתנות", personalCategory: "מתנות" },
    { riseupCategory: "בריאות", personalCategory: "בריאות" },
  ],
  fixedItemRules: [
    { sequenceId: "seq-salary", merchant: "משכורת", personalCategory: "הכנסות" },
    { sequenceId: "seq-stream-a", merchant: "מנוי א", personalCategory: "מנויים" },
    { sequenceId: "seq-stream-b", merchant: "מנוי ב", personalCategory: "מנויים" },
    { sequenceId: "seq-line-1", merchant: "חברת תקשורת", personalCategory: "אינטרנט" },
  ],
  labelRules: [],
  dispositions: [
    { action: "never-write", riseupCategory: "__saving-hidden-category__" },
    { action: "never-write", riseupGoals: true },
    { action: "hand-typed", personalCategory: "שכ\"ד" },
  ],
};

const UPDATED = "2026-10-20T06:00:00.000Z";

function charge(id: string, businessName: string, amount: number, sequenceId?: string) {
  return {
    transactionId: id,
    transactionDate: "2026-10-05",
    billingDate: "2026-10-05",
    businessName,
    isIncome: false,
    billingAmount: amount,
    incomeAmount: null,
    ...(sequenceId === undefined ? {} : { sequenceId }),
  };
}

function receipt(id: string, businessName: string, amount: number, sequenceId?: string) {
  return {
    transactionId: id,
    transactionDate: "2026-10-07",
    billingDate: "2026-10-07",
    businessName,
    isIncome: true,
    billingAmount: null,
    incomeAmount: amount,
    ...(sequenceId === undefined ? {} : { sequenceId }),
  };
}

function weekly(name: string, index: number, amount: number) {
  return {
    id: `env-week-${index}`,
    type: "trackingCategory",
    originalAmount: 700,
    balanceDate: "2026-10-12",
    sequenceCustomerComment: "",
    details: {
      trackingCategory: { name, trackingCategoryType: "custom", frequency: "weekly" },
      startDate: "2026-10-01",
      endDate: "2026-10-08",
      weeklyIndex: index,
    },
    actuals: [charge(`tx-week-${index}`, "מכולת", amount)],
  };
}

function monthlyCategory(name: string, actuals: readonly RiseUpActual[], type = "custom") {
  return {
    id: `env-${name}`,
    type: "trackingCategory",
    originalAmount: 0,
    balanceDate: "2026-11-02",
    sequenceCustomerComment: "",
    details: { trackingCategory: { name, trackingCategoryType: type, frequency: "monthly" } },
    actuals,
  };
}

const MONTH: RiseUpMonth = {
  budgetDate: "2026-10",
  lastUpdatedAt: UPDATED,
  envelopes: [
    // Weekly: one category in the app, so one line here.
    weekly("כלכלה", 0, 600.1),
    weekly("כלכלה", 1, 700.22),
    weekly("כלכלה", 2, 575.25),

    // Three lines into one Personal Category: the category plus two fixed items.
    monthlyCategory("מנויים", [charge("tx-subs", "מנוי שנתי", 125.74)]),
    {
      id: "env-stream-a-october",
      type: "fixed",
      originalAmount: 60,
      balanceDate: "2026-10-18",
      sequenceCustomerComment: "",
      actuals: [charge("tx-stream-a", "מנוי א", 62.74, "seq-stream-a")],
    },
    {
      id: "env-stream-b-october",
      type: "fixed",
      originalAmount: 60,
      balanceDate: "2026-10-18",
      sequenceCustomerComment: "",
      actuals: [charge("tx-stream-b", "מנוי ב", 62.83, "seq-stream-b")],
    },

    // A category RiseUp holds and nothing was spent in.
    monthlyCategory("בריאות", []),

    // An unmapped category: named, and it blocks a write.
    monthlyCategory("חיות", [charge("tx-pets", "חנות חיות", 33.33)]),

    // A charge and a credit in the same row. Without a disposition the credit is
    // reported and the figure stays gross; with `net:` it comes off before the
    // rounding, and these two amounts are chosen so that the two orders disagree:
    // 409.30 − 160.64 = 248.66 → 249, where 409 − 161 would give 248.
    monthlyCategory("מתנות", [
      charge("tx-gift", "חנות מתנות", 409.3),
      receipt("tx-gift-back", "חנות מתנות", 160.64),
    ]),

    // The other-spending bucket, with a credit in it.
    {
      id: "env-variable",
      type: "variable",
      originalAmount: null,
      balanceDate: "2026-11-02",
      sequenceCustomerComment: "",
      actuals: [charge("tx-other", "חנות", 1000.4), receipt("tx-other-back", "חנות", 50)],
    },

    // Money in that is not the salary charge.
    {
      id: "env-variable-income",
      type: "variableIncome",
      originalAmount: null,
      balanceDate: "2026-11-02",
      sequenceCustomerComment: "",
      actuals: [receipt("tx-bit", "העברת כסף", 1560)],
    },

    // The salary. Its prediction (23,000) is never substituted for the charge.
    {
      id: "env-salary-october",
      type: "fixed",
      originalAmount: -23000,
      balanceDate: "2026-10-10",
      sequenceCustomerComment: "",
      actuals: [receipt("tx-salary", "משכורת", 17734.54, "seq-salary")],
    },

    // Two commitments, one merchant, two sequenceIds, two envelope ids. One is
    // mapped; the other nobody has identified, so it is printed and not written.
    {
      id: "env-line-1-october",
      type: "fixed",
      originalAmount: 80,
      balanceDate: "2026-10-15",
      sequenceCustomerComment: "",
      actuals: [charge("tx-line-1", "חברת תקשורת", 83.16, "seq-line-1")],
    },
    {
      id: "env-line-2-october",
      type: "fixed",
      originalAmount: 79,
      balanceDate: "2026-10-15",
      sequenceCustomerComment: "",
      actuals: [charge("tx-line-2", "חברת תקשורת", 79, "seq-line-2")],
    },

    // A fixed item with no charge this month: blank by definition, nothing to map.
    {
      id: "env-insurance-october",
      type: "fixed",
      originalAmount: 412.5,
      balanceDate: "2026-10-09",
      sequenceCustomerComment: "ביטוח",
      actuals: [],
    },

    // Money put aside, which the מאזן records nowhere.
    monthlyCategory("__saving-hidden-category__", [charge("tx-saving", "העברה", 2000)], "saving"),
    {
      id: "env-goal",
      type: "riseupGoal",
      originalAmount: 500,
      balanceDate: "2026-11-02",
      sequenceCustomerComment: "",
      actuals: [charge("tx-goal", "הפקדה", 500)],
    },
  ],
  excluded: [charge("tx-excluded", "רכישה חד פעמית", 9999)],
};

function fold(month: RiseUpMonth = MONTH, mapping: RiseUpMapping = MAPPING): RiseUpFold {
  return foldRiseUpMonth(month, mapping, { currency: "ILS" });
}

function row(result: RiseUpFold, personalCategory: string): FoldedTotal {
  const found = result.totals.find((total) => total.personalCategory === personalCategory);
  if (found === undefined) throw new Error(`no row for ${personalCategory}`);
  return found;
}

function figure(result: RiseUpFold, personalCategory: string): string | null {
  const amount = row(result, personalCategory).amount;
  return amount === null ? null : toDecimalString(amount);
}

describe("roundToShekel", () => {
  it("rounds half away from zero, in both directions", () => {
    expect(toDecimalString(roundToShekel(fromMajorUnits("0.50", "ILS")))).toBe("1.00");
    expect(toDecimalString(roundToShekel(fromMajorUnits("-0.50", "ILS")))).toBe("-1.00");
    expect(toDecimalString(roundToShekel(fromMajorUnits("0.49", "ILS")))).toBe("0.00");
    expect(toDecimalString(roundToShekel(fromMajorUnits("61.52", "ILS")))).toBe("62.00");
  });
});

describe("the month a fold covers", () => {
  it("is the one RiseUp named, not one computed here", () => {
    expect(monthKey(fold().month)).toBe("2026-10");
    expect(fold().budgetDate).toBe("2026-10");
    expect(fold().lastUpdatedAt).toBe(UPDATED);
  });

  it("refuses a response with no budgetDate rather than guessing a month", () => {
    expect(() => fold({ envelopes: [] })).toThrow(/budgetDate/);
  });
});

describe("where the rounding happens", () => {
  it("sums a weekly category and rounds it once", () => {
    const sofer = row(fold(), "סופר");
    expect(sofer.lines).toHaveLength(1);
    expect(toDecimalString(sofer.lines[0]?.exact ?? fromMajorUnits(0, "ILS"))).toBe("1875.57");
    expect(figure(fold(), "סופר")).toBe("1876.00");
  });

  it("rounds each line into one Personal Category before adding them", () => {
    // 126 + 63 + 63. Rounding the sum of 125.74 + 62.74 + 62.83 would give 251.
    const subs = row(fold(), "מנויים");
    expect(subs.lines.map((line) => toDecimalString(line.rounded)).sort()).toEqual([
      "126.00",
      "63.00",
      "63.00",
    ]);
    expect(figure(fold(), "מנויים")).toBe("252.00");
  });
});

describe("a blank is never a zero", () => {
  it("leaves a category RiseUp holds and nothing was spent in not recorded", () => {
    expect(figure(fold(), "בריאות")).toBeNull();
    expect(row(fold(), "בריאות").lines).toHaveLength(0);
  });

  it("leaves a row whose only movement is a credit not recorded, never 0", () => {
    // A refund and nothing else, both on a mapped fixed item and in the bucket.
    // Until a disposition says what became of it there is no figure to print, and
    // 0 would claim that nothing was spent.
    const onlyCredits: RiseUpMonth = {
      ...MONTH,
      envelopes: [
        {
          id: "env-stream-a-october",
          type: "fixed",
          originalAmount: 60,
          balanceDate: "2026-10-18",
          sequenceCustomerComment: "",
          actuals: [receipt("tx-stream-a-refund", "מנוי א", 62.74, "seq-stream-a")],
        },
        {
          id: "env-variable",
          type: "variable",
          originalAmount: null,
          balanceDate: "2026-11-02",
          sequenceCustomerComment: "",
          actuals: [receipt("tx-other-back", "חנות", 50)],
        },
      ],
      excluded: [],
    };
    const result = fold(onlyCredits);
    expect(figure(result, "מנויים")).toBeNull();
    expect(figure(result, "משתנות")).toBeNull();
    expect(result.unresolved.filter((item) => item.kind === "credit-without-disposition")).toHaveLength(2);
  });

  it("prints a row with no RiseUp source at all as hand-typed, not as 0", () => {
    expect(figure(fold(), 'שכ"ד')).toBeNull();
    expect(row(fold(), 'שכ"ד').handTyped).toBe(true);
  });
});

describe("fixed items", () => {
  it("tells two commitments of one merchant apart by the sequenceId on the charge", () => {
    const mapped = row(fold(), "אינטרנט");
    expect(figure(fold(), "אינטרנט")).toBe("83.00");
    expect(mapped.lines[0]?.sequenceId).toBe("seq-line-1");

    const unmapped = fold().unresolved.filter((item) => item.kind === "unmapped-fixed-item");
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]?.sequenceId).toBe("seq-line-2");
    expect(unmapped[0]?.merchant).toBe("חברת תקשורת");
    expect(toDecimalString(unmapped[0]?.amount ?? fromMajorUnits(0, "ILS"))).toBe("79.00");
  });

  it("ignores the envelope's own id, which changes every month", () => {
    const sameMonthDifferentEnvelopeIds: RiseUpMonth = {
      ...MONTH,
      envelopes: (MONTH.envelopes ?? []).map((envelope) => ({ ...envelope, id: `${envelope.id}-renumbered` })),
    };
    expect(figure(fold(sameMonthDifferentEnvelopeIds), "אינטרנט")).toBe("83.00");
    expect(figure(fold(sameMonthDifferentEnvelopeIds), "מנויים")).toBe("252.00");
  });

  it("leaves one with no charge blank, and does not call it an unmapped row", () => {
    const unresolved = fold().unresolved;
    expect(unresolved.some((item) => item.detail === "ביטוח")).toBe(false);
    expect(unresolved.filter((item) => item.kind === "unmapped-fixed-item")).toHaveLength(1);
  });
});

describe("income", () => {
  it("is the salary charge, never the predicted amount", () => {
    expect(figure(fold(), "הכנסות")).toBe("17735.00");
    expect(row(fold(), "הכנסות").type).toBe("income");
  });

  it("is not recorded at all when no salary charge arrived", () => {
    const untidy: RiseUpMonth = {
      ...MONTH,
      envelopes: (MONTH.envelopes ?? []).filter((envelope) => envelope.id !== "env-salary-october"),
    };
    expect(figure(fold(untidy), "הכנסות")).toBeNull();
  });
});

describe("money in that is not salary", () => {
  it("is reported with its merchant, amount and date, and changes no figure", () => {
    const credits = fold().unresolved.filter((item) => item.kind === "credit-without-disposition");
    expect(credits.map((credit) => credit.label).sort()).toEqual([
      "העברת כסף",
      "חנות",
      "חנות מתנות",
    ]);
    expect(credits.every((credit) => credit.date !== undefined && credit.transactionId !== undefined)).toBe(true);

    // Gross, both of them: netting is a decision nobody has recorded yet.
    expect(figure(fold(), "מתנות")).toBe("409.00");
    expect(figure(fold(), "משתנות")).toBe("1000.00");
  });
});

describe("what is never counted", () => {
  it("keeps an excluded transaction out of every total", () => {
    const result = fold();
    const everyFigure = result.totals.flatMap((total) => (total.amount === null ? [] : [total.amount.minorUnits]));
    expect(everyFigure).not.toContain(999900);
    expect(result.excluded.map((item) => toDecimalString(item.amount))).toEqual(["9999.00"]);
  });

  it("silences the savings category and the RiseUp goal", () => {
    const silenced = fold().silenced;
    expect(silenced.map((item) => item.label).sort()).toEqual(["RiseUp goal", "__saving-hidden-category__"]);
    expect(fold().unresolved.some((item) => item.kind === "unmapped-goal")).toBe(false);
    expect(fold().totals.some((total) => total.personalCategory.includes("saving"))).toBe(false);
  });

  it("reports the savings category as unmapped when no disposition says otherwise", () => {
    const withoutDispositions: RiseUpMapping = { ...MAPPING, dispositions: [] };
    const result = fold(MONTH, withoutDispositions);
    expect(result.silenced).toHaveLength(0);
    expect(result.unresolved.some((item) => item.label === "__saving-hidden-category__")).toBe(true);
    expect(result.unresolved.some((item) => item.kind === "unmapped-goal")).toBe(true);
  });
});

describe("what blocks a write", () => {
  it("names every unmapped row and sweeps nothing into משתנות", () => {
    const unmapped = fold().unresolved.filter((item) => item.kind === "unmapped-category");
    expect(unmapped.map((item) => item.label)).toEqual(["חיות"]);
    expect(figure(fold(), "משתנות")).toBe("1000.00");
  });

  it("keeps unresolved expense lines out of the recorded total and still shows them in it", () => {
    const totals = expenseTotals(fold());
    // 1,876 + 252 + 1,000 + 409 + 83 recorded; 79 + 33 still unresolved.
    expect(toDecimalString(totals.recorded)).toBe("3620.00");
    expect(toDecimalString(totals.unresolved)).toBe("112.00");
    expect(toDecimalString(totals.together)).toBe("3732.00");
  });
});

describe("RiseUp has not stopped waiting", () => {
  it("names the envelopes whose charges may still arrive", () => {
    expect(fold().waiting.map((item) => item.label)).toContain("מתנות");
    expect(fold().waiting.every((item) => item.balanceDate > UPDATED.slice(0, 10))).toBe(true);
  });
});

/**
 * Phase 31. Everything below is about the two things Phase 30 left out: what
 * became of money coming in that is not the salary charge, and RiseUp's own label
 * on a charge, which is what splits one RiseUp category across several rows of a
 * grid.
 *
 * The fixtures stay hand-written. `withDispositions` builds a mapping on top of
 * `MAPPING` rather than replacing it, so a test about a disposition cannot
 * quietly change a rule Phase 30 proved.
 */
function withDispositions(
  ...transactionDispositions: readonly TransactionDisposition[]
): RiseUpMapping {
  return { ...MAPPING, transactionDispositions };
}

describe("netting happens first and rounding after", () => {
  it("takes the credit off the line before the line is rounded", () => {
    // 409.30 − 160.64 = 248.66 → 249. Rounding the two apart gives 409 − 161 =
    // 248, which is the figure the sheet does not hold.
    const result = fold(MONTH, withDispositions({ transactionId: "tx-gift-back", action: "net:מתנות" }));
    expect(figure(result, "מתנות")).toBe("249.00");
    const line = row(result, "מתנות").lines[0];
    expect(toDecimalString(line?.gross ?? fromMajorUnits(0, "ILS"))).toBe("409.30");
    expect(toDecimalString(line?.exact ?? fromMajorUnits(0, "ILS"))).toBe("248.66");
    expect(line?.credits.map((credit) => toDecimalString(credit.amount))).toEqual(["160.64"]);
  });

  it("nets a credit into a category it did not come from, which may hold no charge at all", () => {
    // Yuval's October חו"ל: a Bit transfer reimbursing a trip, against a category
    // with nothing in it, which is the one row that comes out negative.
    const result = fold(MONTH, withDispositions({ transactionId: "tx-bit", action: "net:בריאות" }));
    expect(figure(result, "בריאות")).toBe("-1560.00");
    expect(row(result, "בריאות").lines[0]?.kind).toBe("moneyIn");
  });

  it("refuses to guess which of several lines a credit corrects", () => {
    // מנויים is fed by three RiseUp lines. Nothing here can say which one a credit
    // is a correction of, so it is reported and changes no figure.
    const result = fold(MONTH, withDispositions({ transactionId: "tx-bit", action: "net:מנויים" }));
    expect(figure(result, "מנויים")).toBe("252.00");
    const unassignable = result.unresolved.filter((item) => item.kind === "credit-unassignable");
    expect(unassignable).toHaveLength(1);
    expect(unassignable[0]?.transactionId).toBe("tx-bit");
    expect(unassignable[0]?.detail).toMatch(/3 RiseUp lines/);
  });

  it("refuses a `net:` that names no category", () => {
    const result = fold(MONTH, withDispositions({ transactionId: "tx-bit", action: "net:" }));
    expect(result.unresolved.filter((item) => item.kind === "credit-unassignable")).toHaveLength(1);
  });

  it("refuses a `net:` whose category no rule in the mapping file feeds", () => {
    // A near-miss spelling is the live risk: RiseUp writes חו״ל with a gershayim where the
    // grid writes חו"ל, and the two are not equal. Netting into a destination nobody
    // declared would invent a row, leave the real one gross, and report nothing.
    const result = fold(
      MONTH,
      withDispositions({ transactionId: "tx-gift-back", action: "net:מתנות " }),
    );
    const refused = result.unresolved.filter((item) => item.kind === "credit-unassignable");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.detail).toMatch(/no rule in this mapping file/);
    // The real row is untouched and no second one was invented.
    expect(figure(result, "מתנות")).toBe("409.00");
    expect(result.totals.filter((total) => total.personalCategory.trim() === "מתנות")).toHaveLength(1);
  });
});

describe("the four dispositions", () => {
  it("lands `income` in the Person's income category, beside the salary charge", () => {
    // Eden's salary-plus-bonus may arrive outside the salary slot even after she
    // tidies the month. `income` is what makes it writable rather than lost.
    const result = fold(MONTH, withDispositions({ transactionId: "tx-bit", action: "income" }));
    expect(figure(result, "הכנסות")).toBe("19295.00"); // 17,735 + 1,560
    expect(row(result, "הכנסות").lines).toHaveLength(2);
  });

  it("silences an `ignore` and changes no figure", () => {
    const result = fold(
      MONTH,
      withDispositions({ transactionId: "tx-other-back", action: "ignore", note: "reached nothing" }),
    );
    expect(figure(result, "משתנות")).toBe("1000.00");
    expect(result.silenced.some((item) => item.why.startsWith("ignore:"))).toBe(true);
    expect(result.unresolved.some((item) => item.transactionId === "tx-other-back")).toBe(false);
  });

  it("writes a `memo` nowhere at all", () => {
    // מילואים sits beside the sheet's totals and has no Personal Category.
    const result = fold(
      MONTH,
      withDispositions({ transactionId: "tx-bit", action: "memo", note: "reserve pay" }),
    );
    expect(result.memos.map((memo) => toDecimalString(memo.amount))).toEqual(["1560.00"]);
    expect(result.memos[0]?.transactionId).toBe("tx-bit");
    expect(result.memos[0]?.date).toBe("2026-10-07");
    const everyFigure = result.totals.flatMap((total) =>
      total.amount === null ? [] : [total.amount.minorUnits],
    );
    expect(everyFigure).not.toContain(156000);
  });

  it("reports a credit with no disposition, with merchant, amount and date, and nets nothing", () => {
    const credits = fold().unresolved.filter((item) => item.kind === "credit-without-disposition");
    expect(credits).toHaveLength(3);
    expect(credits.every((credit) => credit.label.length > 0)).toBe(true);
    expect(credits.every((credit) => credit.date === "2026-10-07")).toBe(true);
    expect(credits.every((credit) => credit.transactionId !== undefined)).toBe(true);
    expect(figure(fold(), "מתנות")).toBe("409.00");
  });

  it("goes silent about a credit once its disposition is recorded", () => {
    const result = fold(
      MONTH,
      withDispositions(
        { transactionId: "tx-gift-back", action: "net:מתנות" },
        { transactionId: "tx-other-back", action: "ignore" },
        { transactionId: "tx-bit", action: "memo" },
      ),
    );
    expect(result.unresolved.filter((item) => item.kind === "credit-without-disposition")).toHaveLength(0);
  });

  it("leaves the salary charge alone — it is income, not a credit to decide about", () => {
    expect(fold().unresolved.some((item) => item.transactionId === "tx-salary")).toBe(false);
    expect(figure(fold(), "הכנסות")).toBe("17735.00");
  });
});

/**
 * Eden's `חשבונות` in miniature: one RiseUp category holding a rent cheque, a
 * council-tax bill and one charge no label claims. Her labels are her row names,
 * and her file deliberately gives `חשבונות` no category rule, so the leftover is
 * an unresolved row rather than a guess.
 */
const LABELLED: RiseUpMapping = {
  ...MAPPING,
  labelRules: [
    { label: "שיק", personalCategory: 'שכ"ד' },
    { label: "ארנונה", personalCategory: "ארנונה" },
    { label: "גז", personalCategory: "גז" },
  ],
  dispositions: (MAPPING.dispositions ?? []).filter((item) => item.action !== "hand-typed"),
};

function labelled(id: string, businessName: string, amount: number, label: string) {
  return { ...charge(id, businessName, amount), expense: label };
}

const WITH_LABELS: RiseUpMonth = {
  budgetDate: "2026-10",
  lastUpdatedAt: UPDATED,
  envelopes: [
    monthlyCategory("חשבונות", [
      labelled("tx-rent", "שיק", 7000, "שיק"),
      labelled("tx-council", "הרשות המקומית", 333.4, "ארנונה"),
      labelled("tx-stray", "חנות", 12.4, "כללי"),
    ]),
    // A label rule reaches into the bucket too.
    {
      id: "env-variable",
      type: "variable",
      originalAmount: null,
      balanceDate: "2026-11-02",
      sequenceCustomerComment: "",
      actuals: [labelled("tx-gas", "חברת הגז", 495, "גז"), charge("tx-other", "חנות", 1000.4)],
    },
    // A fixed item's own rule is not overridden by a label: a sequenceId is a
    // stronger statement of what that money is than RiseUp's label on it.
    {
      id: "env-stream-a-october",
      type: "fixed",
      originalAmount: 60,
      balanceDate: "2026-10-18",
      sequenceCustomerComment: "",
      actuals: [{ ...labelled("tx-stream-a", "מנוי א", 62.74, "גז"), sequenceId: "seq-stream-a" }],
    },
  ],
  excluded: [],
};

describe("a label rule wins over a category rule", () => {
  it("draws the rent cheque and the council tax out of one category into two rows", () => {
    const result = fold(WITH_LABELS, LABELLED);
    expect(figure(result, 'שכ"ד')).toBe("7000.00");
    expect(figure(result, "ארנונה")).toBe("333.00");
    expect(row(result, 'שכ"ד').lines[0]?.kind).toBe("label");
    expect(row(result, 'שכ"ד').lines[0]?.label).toContain("חשבונות");
  });

  it("applies to a charge in the other-spending bucket as well as to one in a category", () => {
    const result = fold(WITH_LABELS, LABELLED);
    expect(figure(result, "גז")).toBe("495.00");
    expect(figure(result, "משתנות")).toBe("1000.00");
  });

  it("does not override a fixed-item rule, which is identity rather than label", () => {
    const result = fold(WITH_LABELS, LABELLED);
    expect(figure(result, "מנויים")).toBe("63.00");
    expect(row(result, "גז").lines).toHaveLength(1);
  });

  it("names the charge no label claimed, and nothing is swept anywhere", () => {
    const result = fold(WITH_LABELS, LABELLED);
    const unmapped = result.unresolved.filter((item) => item.kind === "unmapped-category");
    expect(unmapped.map((item) => item.label)).toEqual(["חשבונות"]);
    expect(toDecimalString(unmapped[0]?.amount ?? fromMajorUnits(0, "ILS"))).toBe("12.40");
  });

  it("does not call a category unmapped when every charge in it was claimed by a label", () => {
    const allClaimed: RiseUpMonth = {
      ...WITH_LABELS,
      envelopes: [
        monthlyCategory("חשבונות", [
          labelled("tx-rent", "שיק", 7000, "שיק"),
          labelled("tx-council", "הרשות המקומית", 333.4, "ארנונה"),
        ]),
      ],
    };
    expect(fold(allClaimed, LABELLED).unresolved).toHaveLength(0);
  });

  it("leaves a fold with no label rules exactly as Phase 30 left it", () => {
    // Yuval's file carries none, so this phase must not have moved his figures.
    expect(figure(fold(), "סופר")).toBe("1876.00");
    expect(figure(fold(), "מנויים")).toBe("252.00");
    expect(figure(fold(), "משתנות")).toBe("1000.00");
    expect(figure(fold(), "אינטרנט")).toBe("83.00");
    expect(figure(fold(), "הכנסות")).toBe("17735.00");
  });
});

/**
 * An untidied month, taken from Eden's 2026-10 as it stood on 2026-11-13: the
 * salary excluded, the salary slot empty, and the rent cheque sitting in the
 * other-spending bucket. Pinned to the fixture rather than to her account,
 * because her live October stops looking like this the moment she tidies it.
 */
const UNTIDIED: RiseUpMonth = {
  budgetDate: "2026-10",
  lastUpdatedAt: UPDATED,
  envelopes: [
    // The salary slot, predicting 23,805.34 and holding nothing.
    {
      id: "env-salary-october",
      type: "fixed",
      originalAmount: -23805.34,
      balanceDate: "2026-10-10",
      sequenceCustomerComment: "",
      actuals: [],
    },
    {
      id: "env-variable",
      type: "variable",
      originalAmount: null,
      balanceDate: "2026-11-02",
      sequenceCustomerComment: "",
      actuals: [labelled("tx-rent", "שיק", 7000, "שיק"), charge("tx-other", "חנות", 1000.4)],
    },
  ],
  excluded: [receipt("tx-salary-excluded", "משכורת", 60341.69)],
};

describe("an untidied month", () => {
  it("writes no income, and does not substitute the slot's prediction", () => {
    const result = fold(UNTIDIED, LABELLED);
    expect(figure(result, "הכנסות")).toBeNull();
    const everyFigure = result.totals.flatMap((total) =>
      total.amount === null ? [] : [total.amount.minorUnits],
    );
    expect(everyFigure).not.toContain(2380534);
  });

  it("names the excluded salary, which reaches no total", () => {
    const result = fold(UNTIDIED, LABELLED);
    const excludedIn = result.excluded.filter((item) => item.side === "income");
    expect(excludedIn.map((item) => toDecimalString(item.amount))).toEqual(["60341.69"]);
    expect(excludedIn[0]?.label).toBe("משכורת");
  });

  it("still rescues the rent cheque out of the bucket", () => {
    const result = fold(UNTIDIED, LABELLED);
    expect(figure(result, 'שכ"ד')).toBe("7000.00");
    expect(figure(result, "משתנות")).toBe("1000.00");
  });
});
