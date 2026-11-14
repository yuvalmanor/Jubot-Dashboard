/**
 * Folding one RiseUp month into one amount per Personal Category.
 *
 * This is the arithmetic of `/riseup-fill`, and it lives here rather than in the
 * script or in a model because adding up ninety charges by eye is how a wrong
 * figure gets into the מאזן. A RiseUp month and that Person's mapping file go in;
 * one amount per Personal Category comes out, with everything unresolved named.
 *
 * Framework-free per ADR 0004: plain data in, plain data out, no network, no
 * database, no `pg`, no `next`. The fetch is `scripts/riseup-fill.ts`'s job.
 *
 * The rules, settled in the melt of 2026-11-13 and proved against two months the
 * household had already copied by hand (see `plans/riseup-fill.md`):
 *
 * - **Round each RiseUp line to the shekel, then add.** Not the other way round:
 *   Yuval's AIAI is 125.74 + 62.74 + 62.83, which reads 252 in the sheet (126 +
 *   63 + 63) where rounding the sum would give 251. A weekly category is one line
 *   in the app, so its envelopes are summed first and rounded once.
 * - **Use what was charged, never what was predicted.** A fixed item with no
 *   charge this month is blank — not its prediction and not zero.
 * - **Ignore everything RiseUp marks excluded.**
 * - **Weekly envelopes are one month**, which is how `כלכלה` becomes סופר.
 * - **The other-spending bucket becomes משתנות.**
 * - **Income is the salary charge**, written to that Person's single income
 *   category. No charge, no income — the prediction is never substituted.
 * - **A blank is never a zero.** A Personal Category no RiseUp line fed is *not
 *   recorded*, which is a different fact from a figure of zero (ADR 0001).
 * - **Nothing is guessed.** A RiseUp row with no rule is unresolved and named;
 *   money coming in that is not salary is unresolved and named. Neither is swept
 *   into משתנות and neither changes a figure.
 */

import {
  type Currency,
  type Money,
  add,
  fromMajorUnits,
  money,
  subtract,
  sum,
  zero,
} from "@/domain/money/money";
import { type CalendarMonth, parseMonthKey } from "@/domain/time/calendar-month";

// --- what RiseUp hands back ---------------------------------------------------

/**
 * One charge or receipt, as it appears inside an envelope's `actuals` or in the
 * month's `excluded` list. Only the fields the fold reads are named; the response
 * carries more.
 */
export interface RiseUpActual {
  readonly transactionId?: string | null;
  readonly transactionDate?: string | null;
  readonly businessName?: string | null;
  readonly isIncome?: boolean | null;
  readonly billingAmount?: number | null;
  readonly incomeAmount?: number | null;
  /** Stable across months on a fixed item's charge. This is what identifies it. */
  readonly sequenceId?: string | null;
  /** RiseUp's own label on the charge. Phase 31's label rules read it. */
  readonly expense?: string | null;
}

export type RiseUpEnvelopeType =
  | "fixed"
  | "variable"
  | "variableIncome"
  | "trackingCategory"
  | "riseupGoal";

export interface RiseUpEnvelope {
  readonly id?: string | null;
  readonly type?: string | null;
  readonly originalAmount?: number | null;
  readonly balanceDate?: string | null;
  readonly sequenceCustomerComment?: string | null;
  readonly details?: {
    readonly trackingCategory?: {
      readonly name?: string | null;
      readonly trackingCategoryType?: string | null;
      readonly frequency?: string | null;
    } | null;
  } | null;
  readonly actuals?: readonly RiseUpActual[] | null;
}

export interface RiseUpMonth {
  /** The cashflow month this response covers, `YYYY-MM`. It need not start on the 1st. */
  readonly budgetDate?: string | null;
  readonly lastUpdatedAt?: string | null;
  readonly envelopes?: readonly RiseUpEnvelope[] | null;
  readonly excluded?: readonly RiseUpActual[] | null;
}

// --- the mapping file --------------------------------------------------------

/** A RiseUp tracked category, by name, feeds one Personal Category. Several may feed one. */
export interface CategoryRule {
  readonly riseupCategory: string;
  readonly personalCategory: string;
  readonly note?: string;
}

/**
 * A RiseUp fixed item has no name of its own. It is keyed by the `sequenceId` on
 * its charge — stable across months — with the merchant kept beside it as a human
 * label. Not by the envelope's own id, which changes every month, and not by the
 * merchant: Yuval's October held two envelopes both reading `חברת פרטנר תקשורת בע`.
 */
export interface FixedItemRule {
  readonly sequenceId: string;
  readonly merchant?: string;
  readonly personalCategory: string;
  readonly note?: string;
}

/** Phase 31. Declared here so the file's shape does not change under it. */
export interface LabelRule {
  readonly label: string;
  readonly personalCategory: string;
  readonly note?: string;
}

/**
 * What to do with a row rather than with an amount. `never-write` silences a
 * RiseUp row the מאזן records nowhere — the savings category and its goal, which
 * are money moved rather than spent. `hand-typed` marks a Personal Category with
 * no RiseUp source at all, so it is never flagged as missing.
 */
export interface RowDisposition {
  readonly action: "never-write" | "hand-typed";
  readonly riseupCategory?: string;
  /** Every `riseupGoal` envelope, which carries no name to key on. */
  readonly riseupGoals?: boolean;
  readonly personalCategory?: string;
  readonly note?: string;
}

export interface RiseUpMapping {
  readonly person: string;
  /** The MCP server this Person's account is reached through. */
  readonly server: string;
  /** That Person's single income category. */
  readonly incomeCategory: string;
  /** Where the other-spending bucket lands. */
  readonly variableCategory: string;
  readonly categoryRules: readonly CategoryRule[];
  readonly fixedItemRules: readonly FixedItemRule[];
  readonly labelRules?: readonly LabelRule[];
  readonly dispositions?: readonly RowDisposition[];
}

// --- what the fold produces --------------------------------------------------

/** One RiseUp line, rounded on its own before anything is added to anything. */
export interface FoldedLine {
  readonly label: string;
  readonly kind: "trackingCategory" | "fixedItem" | "variableBucket";
  readonly exact: Money;
  readonly rounded: Money;
  readonly sequenceId?: string;
  readonly merchant?: string;
}

export interface FoldedTotal {
  readonly personalCategory: string;
  readonly type: "income" | "expense";
  /** `null` is *not recorded* — no RiseUp line fed this category. Never a zero. */
  readonly amount: Money | null;
  readonly lines: readonly FoldedLine[];
  /** True when the mapping file says this row has no RiseUp source at all. */
  readonly handTyped: boolean;
}

export type UnresolvedKind =
  | "unmapped-category"
  | "unmapped-fixed-item"
  | "unmapped-goal"
  | "credit-without-disposition";

/**
 * Something nobody has decided. Every one of these is printed; none of them
 * changes a figure, and together they are what blocks a write.
 */
export interface Unresolved {
  readonly kind: UnresolvedKind;
  readonly label: string;
  readonly amount: Money;
  readonly side: "income" | "expense";
  readonly sequenceId?: string;
  readonly envelopeId?: string;
  readonly merchant?: string;
  readonly transactionId?: string;
  readonly date?: string;
  readonly detail?: string;
}

/** A RiseUp row the mapping file says the מאזן records nowhere. */
export interface SilencedRow {
  readonly label: string;
  readonly amount: Money;
  readonly why: string;
}

/** An envelope RiseUp has not stopped waiting for. */
export interface WaitingRow {
  readonly label: string;
  readonly balanceDate: string;
}

export interface ExcludedRow {
  readonly label: string;
  readonly amount: Money;
  readonly side: "income" | "expense";
  readonly date?: string;
}

export interface RiseUpFold {
  readonly person: string;
  readonly month: CalendarMonth;
  readonly budgetDate: string;
  readonly lastUpdatedAt: string | null;
  readonly currency: Currency;
  readonly totals: readonly FoldedTotal[];
  readonly unresolved: readonly Unresolved[];
  readonly silenced: readonly SilencedRow[];
  readonly waiting: readonly WaitingRow[];
  readonly excluded: readonly ExcludedRow[];
}

export class RiseUpFoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiseUpFoldError";
  }
}

// --- the rounding rule -------------------------------------------------------

/**
 * To the whole shekel, half away from zero — the unit the app displays and the
 * unit the hand-copy wrote. Applied to one RiseUp line, never to a sum of them.
 */
export function roundToShekel(amount: Money): Money {
  const minor = amount.minorUnits;
  const sign = minor < 0 ? -1 : 1;
  const shekels = Math.floor(Math.abs(minor) / 100 + 0.5);
  return money(sign * shekels * 100, amount.currency);
}

// --- reading the response ----------------------------------------------------

function amountOf(value: number | null | undefined, currency: Currency): Money {
  if (value === null || value === undefined) return zero(currency);
  return fromMajorUnits(value, currency);
}

function isIncomeActual(actual: RiseUpActual): boolean {
  if (actual.isIncome === true) return true;
  if (actual.isIncome === false) return false;
  // Older rows may carry only one of the two amounts.
  return actual.incomeAmount !== null && actual.incomeAmount !== undefined;
}

function chargedIn(actuals: readonly RiseUpActual[], currency: Currency): Money {
  return sum(
    actuals.filter((actual) => !isIncomeActual(actual)).map((a) => amountOf(a.billingAmount, currency)),
    currency,
  );
}

function receivedIn(actuals: readonly RiseUpActual[], currency: Currency): Money {
  return sum(
    actuals.filter(isIncomeActual).map((a) => amountOf(a.incomeAmount, currency)),
    currency,
  );
}

function actualsOf(envelope: RiseUpEnvelope): readonly RiseUpActual[] {
  return envelope.actuals ?? [];
}

function categoryNameOf(envelope: RiseUpEnvelope): string | null {
  const name = envelope.details?.trackingCategory?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** All the charges of a fixed envelope share one `sequenceId`. The first one that has it. */
function sequenceIdOf(envelope: RiseUpEnvelope): string | null {
  for (const actual of actualsOf(envelope)) {
    if (typeof actual.sequenceId === "string" && actual.sequenceId.length > 0) return actual.sequenceId;
  }
  return null;
}

function merchantOf(envelope: RiseUpEnvelope): string | null {
  for (const actual of actualsOf(envelope)) {
    if (typeof actual.businessName === "string" && actual.businessName.length > 0) {
      return actual.businessName;
    }
  }
  return null;
}

function dayOf(moment: string | null | undefined): string | null {
  if (typeof moment !== "string" || moment.length < 10) return null;
  return moment.slice(0, 10);
}

/** RiseUp has not stopped waiting for this envelope's charges yet. */
function stillWaiting(envelope: RiseUpEnvelope, lastUpdatedAt: string | null): boolean {
  const balance = dayOf(envelope.balanceDate);
  const updated = dayOf(lastUpdatedAt);
  if (balance === null || updated === null) return false;
  return balance > updated;
}

// --- the fold ----------------------------------------------------------------

interface Pending {
  readonly label: string;
  readonly kind: FoldedLine["kind"];
  readonly sequenceId?: string;
  readonly merchant?: string;
  exact: Money;
}

export function foldRiseUpMonth(
  response: RiseUpMonth,
  mapping: RiseUpMapping,
  options: { readonly currency?: Currency } = {},
): RiseUpFold {
  const currency = options.currency ?? "ILS";
  const budgetDate = response.budgetDate;
  if (typeof budgetDate !== "string" || budgetDate.length === 0) {
    throw new RiseUpFoldError("The RiseUp response carries no budgetDate, so there is no month to fold.");
  }
  const month = parseMonthKey(budgetDate);
  const lastUpdatedAt = typeof response.lastUpdatedAt === "string" ? response.lastUpdatedAt : null;

  const byCategoryName = new Map(mapping.categoryRules.map((rule) => [rule.riseupCategory, rule]));
  const bySequenceId = new Map(mapping.fixedItemRules.map((rule) => [rule.sequenceId, rule]));
  const dispositions = mapping.dispositions ?? [];
  const silencedCategories = new Set(
    dispositions.flatMap((d) =>
      d.action === "never-write" && typeof d.riseupCategory === "string" ? [d.riseupCategory] : [],
    ),
  );
  const silencedGoals = dispositions.some((d) => d.action === "never-write" && d.riseupGoals === true);
  const handTyped = new Set(
    dispositions.flatMap((d) =>
      d.action === "hand-typed" && typeof d.personalCategory === "string" ? [d.personalCategory] : [],
    ),
  );

  const pendingByCategory = new Map<string, Pending[]>();
  const unresolved: Unresolved[] = [];
  const silenced: SilencedRow[] = [];
  const waiting: WaitingRow[] = [];

  const push = (personalCategory: string, pending: Pending) => {
    const existing = pendingByCategory.get(personalCategory);
    if (existing === undefined) pendingByCategory.set(personalCategory, [pending]);
    else existing.push(pending);
  };

  /**
   * One line's exact amount. Netting happens here, before the rounding: an income
   * destination counts what came in, an expense destination what went out. A
   * receipt inside an expense row is a credit nobody has decided about yet — it is
   * reported and it changes nothing (Phase 31 records the dispositions).
   */
  const exactFor = (personalCategory: string, actuals: readonly RiseUpActual[]): Money =>
    personalCategory === mapping.incomeCategory
      ? subtract(receivedIn(actuals, currency), chargedIn(actuals, currency))
      : chargedIn(actuals, currency);

  const reportCredits = (envelope: RiseUpEnvelope, within: string) => {
    for (const actual of actualsOf(envelope)) {
      if (!isIncomeActual(actual)) continue;
      unresolved.push({
        kind: "credit-without-disposition",
        label: actual.businessName ?? "(no merchant)",
        amount: amountOf(actual.incomeAmount, currency),
        side: "income",
        transactionId: actual.transactionId ?? undefined,
        date: dayOf(actual.transactionDate) ?? undefined,
        detail: `money in, within ${within}`,
      });
    }
  };

  // Weekly envelopes are one category in the app, so they are summed before they
  // are rounded: 1,875.57 becomes 1,876, which is what the sheet says.
  const trackingTotals = new Map<string, { exact: Money; charges: number; credits: RiseUpEnvelope[] }>();

  for (const envelope of response.envelopes ?? []) {
    const type = envelope.type ?? "";
    if (stillWaiting(envelope, lastUpdatedAt)) {
      waiting.push({
        label: categoryNameOf(envelope) ?? merchantOf(envelope) ?? `${type} ${envelope.id ?? ""}`.trim(),
        balanceDate: dayOf(envelope.balanceDate) ?? String(envelope.balanceDate),
      });
    }

    if (type === "riseupGoal") {
      const amount = chargedIn(actualsOf(envelope), currency);
      if (silencedGoals) {
        silenced.push({
          label: "RiseUp goal",
          amount,
          why: "never-write: a goal is money put aside, which the מאזן records nowhere",
        });
      } else {
        unresolved.push({
          kind: "unmapped-goal",
          label: "RiseUp goal",
          amount,
          side: "expense",
          envelopeId: envelope.id ?? undefined,
        });
      }
      continue;
    }

    if (type === "trackingCategory") {
      const name = categoryNameOf(envelope);
      if (name === null) {
        unresolved.push({
          kind: "unmapped-category",
          label: "(a tracked category with no name)",
          amount: chargedIn(actualsOf(envelope), currency),
          side: "expense",
          envelopeId: envelope.id ?? undefined,
        });
        continue;
      }
      if (silencedCategories.has(name)) {
        silenced.push({
          label: name,
          amount: chargedIn(actualsOf(envelope), currency),
          why: "never-write: money put aside rather than spent, which the מאזן records nowhere",
        });
        continue;
      }
      const slot = trackingTotals.get(name) ?? { exact: zero(currency), charges: 0, credits: [] };
      slot.exact = add(slot.exact, chargedIn(actualsOf(envelope), currency));
      slot.charges += actualsOf(envelope).filter((actual) => !isIncomeActual(actual)).length;
      if (actualsOf(envelope).some(isIncomeActual)) slot.credits.push(envelope);
      trackingTotals.set(name, slot);
      continue;
    }

    if (type === "fixed") {
      const actuals = actualsOf(envelope);
      if (actuals.length === 0) {
        // Blank by definition: no charge, no `sequenceId`, nothing to map. Never
        // its prediction and never a zero.
        continue;
      }
      const sequenceId = sequenceIdOf(envelope);
      const merchant = merchantOf(envelope) ?? "(no merchant)";
      const income = actuals.every(isIncomeActual);
      if (sequenceId === null) {
        unresolved.push({
          kind: "unmapped-fixed-item",
          label: merchant,
          amount: income ? receivedIn(actuals, currency) : chargedIn(actuals, currency),
          side: income ? "income" : "expense",
          envelopeId: envelope.id ?? undefined,
          merchant,
          detail: "the charge carries no sequenceId, so this item cannot be identified",
        });
        continue;
      }
      const rule = bySequenceId.get(sequenceId);
      if (rule === undefined) {
        unresolved.push({
          kind: "unmapped-fixed-item",
          label: merchant,
          amount: income ? receivedIn(actuals, currency) : chargedIn(actuals, currency),
          side: income ? "income" : "expense",
          sequenceId,
          envelopeId: envelope.id ?? undefined,
          merchant,
          detail:
            typeof envelope.sequenceCustomerComment === "string" && envelope.sequenceCustomerComment.length > 0
              ? envelope.sequenceCustomerComment
              : undefined,
        });
        continue;
      }
      if (rule.personalCategory !== mapping.incomeCategory) reportCredits(envelope, merchant);
      push(rule.personalCategory, {
        label: rule.merchant ?? merchant,
        kind: "fixedItem",
        sequenceId,
        merchant,
        exact: exactFor(rule.personalCategory, actuals),
      });
      continue;
    }

    if (type === "variable") {
      const actuals = actualsOf(envelope);
      if (actuals.length === 0) continue;
      reportCredits(envelope, "the other-spending bucket");
      push(mapping.variableCategory, {
        label: "other spending",
        kind: "variableBucket",
        exact: chargedIn(actuals, currency),
      });
      continue;
    }

    if (type === "variableIncome") {
      // Money in that is not the salary charge. Each one is a decision — netted
      // against a category, income, ignored, or a memo — and until it is recorded
      // it changes nothing.
      reportCredits(envelope, "variable income");
      const charged = chargedIn(actualsOf(envelope), currency);
      if (charged.minorUnits !== 0) {
        unresolved.push({
          kind: "unmapped-category",
          label: "variable income, with charges in it",
          amount: charged,
          side: "expense",
          envelopeId: envelope.id ?? undefined,
        });
      }
      continue;
    }

    if (actualsOf(envelope).length > 0) {
      unresolved.push({
        kind: "unmapped-category",
        label: `an envelope of an unknown type: ${type}`,
        amount: chargedIn(actualsOf(envelope), currency),
        side: "expense",
        envelopeId: envelope.id ?? undefined,
      });
    }
  }

  for (const [name, slot] of trackingTotals) {
    const rule = byCategoryName.get(name);
    if (rule === undefined) {
      unresolved.push({
        kind: "unmapped-category",
        label: name,
        amount: slot.exact,
        side: "expense",
      });
      continue;
    }
    for (const envelope of slot.credits) reportCredits(envelope, name);
    // No charge, no figure. A tracked category RiseUp holds but nothing was spent
    // in reads *not recorded*, exactly as a fixed item with no charge does — a
    // blank is never a zero (ADR 0001).
    if (slot.charges === 0) continue;
    push(rule.personalCategory, { label: name, kind: "trackingCategory", exact: slot.exact });
  }

  // Every Personal Category the mapping file knows about is printed, so a row no
  // RiseUp line fed reads *not recorded* rather than going missing or reading 0.
  const known: readonly { readonly personalCategory: string; readonly type: "income" | "expense" }[] = [
    { personalCategory: mapping.incomeCategory, type: "income" },
    { personalCategory: mapping.variableCategory, type: "expense" },
    ...mapping.categoryRules.map((rule) => ({
      personalCategory: rule.personalCategory,
      type: "expense" as const,
    })),
    ...mapping.fixedItemRules.map((rule) => ({
      personalCategory: rule.personalCategory,
      type: rule.personalCategory === mapping.incomeCategory ? ("income" as const) : ("expense" as const),
    })),
    ...(mapping.labelRules ?? []).map((rule) => ({
      personalCategory: rule.personalCategory,
      type: "expense" as const,
    })),
    ...[...handTyped].map((personalCategory) => ({ personalCategory, type: "expense" as const })),
  ];

  const totals: FoldedTotal[] = [];
  const seen = new Set<string>();
  for (const row of known) {
    if (seen.has(row.personalCategory)) continue;
    seen.add(row.personalCategory);
    const pending = pendingByCategory.get(row.personalCategory) ?? [];
    const lines: FoldedLine[] = pending.map((line) => ({
      label: line.label,
      kind: line.kind,
      exact: line.exact,
      rounded: roundToShekel(line.exact),
      sequenceId: line.sequenceId,
      merchant: line.merchant,
    }));
    totals.push({
      personalCategory: row.personalCategory,
      type: row.type,
      amount: lines.length === 0 ? null : sum(lines.map((line) => line.rounded), currency),
      lines,
      handTyped: handTyped.has(row.personalCategory),
    });
  }

  const excluded: ExcludedRow[] = (response.excluded ?? []).map((actual) => {
    const income = isIncomeActual(actual);
    return {
      label: actual.businessName ?? "(no merchant)",
      amount: income ? amountOf(actual.incomeAmount, currency) : amountOf(actual.billingAmount, currency),
      side: income ? ("income" as const) : ("expense" as const),
      date: dayOf(actual.transactionDate) ?? undefined,
    };
  });

  return {
    person: mapping.person,
    month,
    budgetDate,
    lastUpdatedAt,
    currency,
    totals,
    unresolved,
    silenced,
    waiting,
    excluded,
  };
}

/** What the expense rows come to, kept apart from what is still unresolved. */
export function expenseTotals(fold: RiseUpFold): {
  readonly recorded: Money;
  readonly unresolved: Money;
  readonly together: Money;
} {
  const recorded = sum(
    fold.totals.flatMap((total) =>
      total.type === "expense" && total.amount !== null ? [total.amount] : [],
    ),
    fold.currency,
  );
  const pending = sum(
    fold.unresolved.flatMap((row) => (row.side === "expense" ? [roundToShekel(row.amount)] : [])),
    fold.currency,
  );
  return { recorded, unresolved: pending, together: add(recorded, pending) };
}
