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
 * The rules, settled in the melt of 2026-11-13 and proved against the months the
 * household had already copied by hand (see `plans/riseup-fill.md`):
 *
 * - **Round each RiseUp line to the shekel, then add.** Not the other way round:
 *   Yuval's AIAI is 125.74 + 62.74 + 62.83, which reads 252 in the sheet (126 +
 *   63 + 63) where rounding the sum would give 251. A weekly category is one line
 *   in the app, so its envelopes are summed first and rounded once.
 * - **Netting happens first, rounding after.** A credit a disposition nets into a
 *   category is part of that category's line, not a line of its own: Eden's
 *   ביגוד והנעלה is 409.30 − 160.64 = 248.66, which reads **249**, where rounding
 *   the two apart would give 409 − 161 = 248.
 * - **Use what was charged, never what was predicted.** A fixed item with no
 *   charge this month is blank — not its prediction and not zero.
 * - **Ignore everything RiseUp marks excluded.**
 * - **Weekly envelopes are one month**, which is how `כלכלה` becomes סופר.
 * - **The other-spending bucket becomes משתנות**, unless a label rule claims a
 *   charge out of it.
 * - **A label rule wins over a category rule.** Every charge carries RiseUp's own
 *   label, and for Eden those labels are her row names: `שיק`, `ארנונה`, `מים`,
 *   `חשמל`, `גז` are what split her one `חשבונות` category across five rows of
 *   her grid, and what rescue a rent cheque that landed in the bucket.
 * - **Income is the salary charge**, written to that Person's single income
 *   category. No charge, no income — the prediction is never substituted.
 * - **Money in that is not the salary charge is a decision**, recorded by
 *   `transactionId`: netted against a category, counted as income, ignored, or a
 *   memo written nowhere. Undecided, it is reported and it changes no figure.
 * - **A blank is never a zero.** A Personal Category no RiseUp line fed is *not
 *   recorded*, which is a different fact from a figure of zero (ADR 0001).
 * - **Nothing is guessed.** A RiseUp row with no rule is unresolved and named.
 *   Nothing is swept into משתנות and nothing changes a figure.
 */

import {
  type Currency,
  type Money,
  add,
  fromMajorUnits,
  money,
  negate,
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
  /** RiseUp's own label on the charge. This is what a label rule reads. */
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

/**
 * RiseUp's own label on a charge routes it, and this wins over the category rule
 * of the envelope the charge sits in — including the other-spending bucket, which
 * is how October's 7,000 rent cheque reaches שכ"ד rather than משתנות.
 *
 * It does **not** override a fixed-item rule. A fixed item is identified one by
 * one by the `sequenceId` on its charge, which is a stronger statement of what
 * that money is than RiseUp's label on it, and the household made it deliberately.
 */
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

/**
 * What became of one payment in that is not the salary charge, keyed by the
 * `transactionId` RiseUp gave it so that a re-run is silent about it and the
 * reason stays on the record.
 *
 * - `net:<Personal Category>` — netted against that category, before rounding.
 *   This is what the sheet already did: Eden's ביגוד והנעלה reads 249, which is
 *   409.30 of charges less a 160.64 credit from the same clothes shop.
 * - `income` — a real earning, into that Person's income category. The
 *   disposition for a salary that arrives outside the salary slot.
 * - `ignore` — it reached nothing, like the 375₪ Bit transfer in Yuval's October.
 * - `memo` — written nowhere at all: `מילואים` sits beside the sheet's totals and
 *   has no Personal Category, and reserve pay must not reach one.
 */
export type MoneyInAction = `net:${string}` | "income" | "ignore" | "memo";

export interface TransactionDisposition {
  readonly transactionId: string;
  readonly action: MoneyInAction;
  /** Kept beside the id as a human label. Never read as an identity. */
  readonly merchant?: string;
  readonly date?: string;
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
  /** The refund and transfer-in decisions, keyed by `transactionId`. */
  readonly transactionDispositions?: readonly TransactionDisposition[];
}

// --- what the fold produces --------------------------------------------------

/** A payment in that a disposition nets against the line it is a correction of. */
export interface NettedCredit {
  readonly merchant: string;
  readonly amount: Money;
  readonly transactionId?: string;
  readonly date?: string;
}

/**
 * One RiseUp line, netted and then rounded on its own, before anything is added
 * to anything.
 */
export interface FoldedLine {
  readonly label: string;
  readonly kind: "trackingCategory" | "fixedItem" | "variableBucket" | "label" | "moneyIn";
  /** What the charges came to before any credit was netted against them. */
  readonly gross: Money;
  /** Net of the credits below. This is the figure the shekel rule rounds. */
  readonly exact: Money;
  readonly rounded: Money;
  readonly credits: readonly NettedCredit[];
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
  | "credit-without-disposition"
  | "credit-unassignable";

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

/**
 * Money the household tracks beside the מאזן's totals and nowhere inside them —
 * reserve pay, which has no Personal Category at all.
 */
export interface MemoRow {
  readonly label: string;
  readonly amount: Money;
  readonly transactionId?: string;
  readonly date?: string;
  readonly note?: string;
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
  readonly memos: readonly MemoRow[];
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
 * unit the hand-copy wrote. Applied to one RiseUp line, never to a sum of them,
 * and applied after any credit has been netted into that line.
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

function labelOf(actual: RiseUpActual): string | null {
  const label = actual.expense;
  return typeof label === "string" && label.length > 0 ? label : null;
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
  /** This line's identity inside its destination, so charges accumulate into it. */
  readonly key: string;
  readonly sequenceId?: string;
  readonly merchant?: string;
  exact: Money;
  credits: NettedCredit[];
}

/** One payment in, waiting on the disposition that says what became of it. */
interface MoneyIn {
  readonly transactionId: string | null;
  readonly merchant: string;
  readonly amount: Money;
  readonly date: string | null;
  readonly within: string;
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
  const byLabel = new Map((mapping.labelRules ?? []).map((rule) => [rule.label, rule]));
  const byTransactionId = new Map(
    (mapping.transactionDispositions ?? []).map((decision) => [decision.transactionId, decision]),
  );
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

  /**
   * Every Personal Category this mapping file names. A `net:` disposition may
   * only name one of these: a destination nobody declared is a typo, not a row —
   * `net:חו״ל` with RiseUp's gershayim against a grid that writes `חו"ל` would
   * otherwise invent a second row, leave the real one gross, and report nothing.
   */
  const knownCategories = new Set<string>([
    mapping.incomeCategory,
    mapping.variableCategory,
    ...mapping.categoryRules.map((rule) => rule.personalCategory),
    ...mapping.fixedItemRules.map((rule) => rule.personalCategory),
    ...(mapping.labelRules ?? []).map((rule) => rule.personalCategory),
    ...handTyped,
  ]);

  const pendingByCategory = new Map<string, Pending[]>();
  const unresolved: Unresolved[] = [];
  const silenced: SilencedRow[] = [];
  const memos: MemoRow[] = [];
  const waiting: WaitingRow[] = [];
  const moneyIn: MoneyIn[] = [];
  /** Destinations a `net:` disposition names, so their rows print even with no charge. */
  const nettedInto = new Map<string, MoneyIn[]>();

  /** Accumulate into the destination's line of that identity, or start it. */
  const push = (personalCategory: string, line: Omit<Pending, "credits">) => {
    const lines = pendingByCategory.get(personalCategory);
    if (lines === undefined) {
      pendingByCategory.set(personalCategory, [{ ...line, credits: [] }]);
      return;
    }
    const existing = lines.find((candidate) => candidate.key === line.key);
    if (existing === undefined) lines.push({ ...line, credits: [] });
    else existing.exact = add(existing.exact, line.exact);
  };

  const noteMoneyIn = (actual: RiseUpActual, within: string) => {
    moneyIn.push({
      transactionId: actual.transactionId ?? null,
      merchant: actual.businessName ?? "(no merchant)",
      amount: amountOf(actual.incomeAmount, currency),
      date: dayOf(actual.transactionDate),
      within,
    });
  };

  /**
   * Every charge of an envelope that a label rule may claim: a label rule wins
   * over the envelope's own category rule, so a labelled charge leaves its
   * category and becomes a line of its own in the destination the label names.
   * What is left over is returned for the envelope's own rule to place.
   */
  const routeByLabel = (
    actuals: readonly RiseUpActual[],
    within: string,
  ): readonly RiseUpActual[] => {
    const leftOver: RiseUpActual[] = [];
    for (const actual of actuals) {
      const label = labelOf(actual);
      const rule = label === null ? undefined : byLabel.get(label);
      if (rule === undefined) {
        leftOver.push(actual);
        continue;
      }
      push(rule.personalCategory, {
        label: `${label} (out of ${within})`,
        kind: "label",
        key: `label:${label ?? ""}`,
        exact: amountOf(actual.billingAmount, currency),
      });
    }
    return leftOver;
  };

  // Weekly envelopes are one category in the app, so they are summed before they
  // are rounded: 1,875.57 becomes 1,876, which is what the sheet says.
  const trackingTotals = new Map<
    string,
    { exact: Money; charges: number; chargesBeforeLabels: number }
  >();

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
      for (const actual of actualsOf(envelope)) {
        if (isIncomeActual(actual)) noteMoneyIn(actual, name);
      }
      const own = actualsOf(envelope).filter((actual) => !isIncomeActual(actual));
      const charges = routeByLabel(own, name);
      const slot =
        trackingTotals.get(name) ?? { exact: zero(currency), charges: 0, chargesBeforeLabels: 0 };
      slot.exact = add(slot.exact, chargedIn(charges, currency));
      slot.charges += charges.length;
      slot.chargesBeforeLabels += own.length;
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
      const toIncome = rule.personalCategory === mapping.incomeCategory;
      if (toIncome) {
        // The salary slot. Its receipt is the income figure, not a credit anybody
        // has to decide about.
        const exact = subtract(receivedIn(actuals, currency), chargedIn(actuals, currency));
        if (actuals.some(isIncomeActual)) {
          push(rule.personalCategory, {
            label: rule.merchant ?? merchant,
            kind: "fixedItem",
            key: `fixed:${sequenceId}`,
            sequenceId,
            merchant,
            exact,
          });
        }
        continue;
      }
      for (const actual of actuals) if (isIncomeActual(actual)) noteMoneyIn(actual, merchant);
      const charges = actuals.filter((actual) => !isIncomeActual(actual));
      if (charges.length === 0) continue;
      push(rule.personalCategory, {
        label: rule.merchant ?? merchant,
        kind: "fixedItem",
        key: `fixed:${sequenceId}`,
        sequenceId,
        merchant,
        exact: chargedIn(charges, currency),
      });
      continue;
    }

    if (type === "variable") {
      const actuals = actualsOf(envelope);
      if (actuals.length === 0) continue;
      for (const actual of actuals) {
        if (isIncomeActual(actual)) noteMoneyIn(actual, "the other-spending bucket");
      }
      // A label rule reaches into the bucket too, which is how October's 7,000
      // rent cheque gets out of משתנות and into שכ"ד.
      const charges = routeByLabel(
        actuals.filter((actual) => !isIncomeActual(actual)),
        "the other-spending bucket",
      );
      if (charges.length === 0) continue;
      push(mapping.variableCategory, {
        label: "other spending",
        kind: "variableBucket",
        key: "variable",
        exact: chargedIn(charges, currency),
      });
      continue;
    }

    if (type === "variableIncome") {
      // Money in that is not the salary charge. Each one is a decision — netted
      // against a category, income, ignored, or a memo — and until it is recorded
      // it changes nothing.
      for (const actual of actualsOf(envelope)) {
        if (isIncomeActual(actual)) noteMoneyIn(actual, "variable income");
      }
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
      // A category whose every charge a label rule claimed needs no rule of its
      // own: Eden's `חשבונות` exists in RiseUp only to be split across five rows
      // of her grid, and nothing of it is left unplaced.
      const placedEntirelyByLabels = slot.chargesBeforeLabels > 0 && slot.charges === 0;
      if (placedEntirelyByLabels) continue;
      // Otherwise it is named even when empty: a live RiseUp row nobody has
      // placed is exactly what `--map` exists to settle, and an empty one today
      // may hold a charge tomorrow. Eden's `רפואי ופארם` is the live case.
      unresolved.push({
        kind: "unmapped-category",
        label: name,
        amount: slot.exact,
        side: "expense",
        detail:
          slot.chargesBeforeLabels === 0
            ? "a RiseUp category with no rule and no charge this month"
            : undefined,
      });
      continue;
    }
    // No charge, no figure. A tracked category RiseUp holds but nothing was spent
    // in reads *not recorded*, exactly as a fixed item with no charge does — a
    // blank is never a zero (ADR 0001).
    if (slot.charges === 0) continue;
    push(rule.personalCategory, {
      label: name,
      kind: "trackingCategory",
      key: `category:${name}`,
      exact: slot.exact,
    });
  }

  // --- what became of every payment in ---------------------------------------

  for (const payment of moneyIn) {
    const decision = payment.transactionId === null ? undefined : byTransactionId.get(payment.transactionId);
    if (decision === undefined) {
      unresolved.push({
        kind: "credit-without-disposition",
        label: payment.merchant,
        amount: payment.amount,
        side: "income",
        transactionId: payment.transactionId ?? undefined,
        date: payment.date ?? undefined,
        detail: `money in, within ${payment.within}`,
      });
      continue;
    }
    if (decision.action === "ignore") {
      silenced.push({
        label: payment.merchant,
        amount: payment.amount,
        why: `ignore: ${decision.note ?? "money in that reached nothing the מאזן records"}`,
      });
      continue;
    }
    if (decision.action === "memo") {
      memos.push({
        label: payment.merchant,
        amount: payment.amount,
        transactionId: payment.transactionId ?? undefined,
        date: payment.date ?? undefined,
        note: decision.note,
      });
      continue;
    }
    if (decision.action === "income") {
      push(mapping.incomeCategory, {
        label: `${payment.merchant} (money in, counted as income)`,
        kind: "moneyIn",
        key: `moneyIn:${payment.transactionId ?? payment.merchant}`,
        exact: payment.amount,
      });
      continue;
    }
    const destination = decision.action.slice("net:".length);
    if (destination.length === 0 || !knownCategories.has(destination)) {
      unresolved.push({
        kind: "credit-unassignable",
        label: payment.merchant,
        amount: payment.amount,
        side: "income",
        transactionId: payment.transactionId ?? undefined,
        date: payment.date ?? undefined,
        detail:
          destination.length === 0
            ? "`net:` names no Personal Category, so there is nothing to net it against"
            : `\`net:${destination}\` names a Personal Category no rule in this mapping file ` +
              `feeds, so it would invent a row rather than correct one`,
      });
      continue;
    }
    const waitingToNet = nettedInto.get(destination);
    if (waitingToNet === undefined) nettedInto.set(destination, [payment]);
    else waitingToNet.push(payment);
  }

  /**
   * Netting happens first and rounding after, which is why a credit is folded
   * into the line it corrects rather than rounded on its own: Eden's
   * ביגוד והנעלה is 409.30 − 160.64 = 248.66 → **249**, where 409 − 161 = 248.
   *
   * With one line in the destination that is unambiguous. With none, the credit
   * stands alone and is rounded on its own — Yuval's October חו"ל, −1,560, whose
   * category held no charge at all. With several, nothing here can say which line
   * the credit corrects, so it is reported as unassignable and changes no figure.
   */
  for (const [destination, credits] of nettedInto) {
    const lines = pendingByCategory.get(destination) ?? [];
    const total = sum(
      credits.map((credit) => credit.amount),
      currency,
    );
    const asCredits: NettedCredit[] = credits.map((credit) => ({
      merchant: credit.merchant,
      amount: credit.amount,
      transactionId: credit.transactionId ?? undefined,
      date: credit.date ?? undefined,
    }));
    if (lines.length === 1) {
      const line = lines[0] as Pending;
      line.exact = subtract(line.exact, total);
      line.credits.push(...asCredits);
      continue;
    }
    if (lines.length === 0) {
      pendingByCategory.set(destination, [
        {
          label: credits.length === 1 ? (credits[0] as MoneyIn).merchant : "credits, netted",
          kind: "moneyIn",
          key: "netted",
          exact: negate(total),
          credits: asCredits,
        },
      ]);
      continue;
    }
    for (const credit of credits) {
      unresolved.push({
        kind: "credit-unassignable",
        label: credit.merchant,
        amount: credit.amount,
        side: "income",
        transactionId: credit.transactionId ?? undefined,
        date: credit.date ?? undefined,
        detail:
          `\`net:${destination}\` is owed to a category fed by ${lines.length} RiseUp lines, and ` +
          `nothing here can say which of them this credit corrects`,
      });
    }
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
    ...[...nettedInto.keys()].map((personalCategory) => ({
      personalCategory,
      type: "expense" as const,
    })),
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
      gross: line.credits.reduce(
        (running, credit) => add(running, credit.amount),
        line.exact,
      ),
      exact: line.exact,
      rounded: roundToShekel(line.exact),
      credits: line.credits,
      sequenceId: line.sequenceId,
      merchant: line.merchant,
    }));
    totals.push({
      personalCategory: row.personalCategory,
      type: row.type,
      amount:
        lines.length === 0
          ? null
          : sum(
              lines.map((line) => line.rounded),
              currency,
            ),
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
    memos,
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
