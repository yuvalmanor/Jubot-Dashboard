/**
 * Proposing a Person's mapping file, and the Personal Categories it needs.
 *
 * The monthly run refuses a RiseUp row nobody has placed. This is where that
 * refusal is answered: one month (or several) of folded RiseUp rows and the
 * grid's own Personal Categories go in, and out come **proposals** — what the
 * file would say, which Personal Category would be created, and what nobody has
 * decided yet. Nothing here writes anything: `scripts/riseup-fill.ts` serialises
 * the file and `insertPersonalCategory` creates a category, both only against an
 * approval token this module produced.
 *
 * Framework-free per ADR 0004: folded rows, a mapping file and a `Categories`
 * snapshot in, plain data out. No network, no database, no `pg`.
 *
 * The rules it carries, from the plan's header and from Phase 34's criteria:
 *
 * - **It reads what the fold left unresolved**, never the envelopes again. So a
 *   row that already has a rule, Eden's deliberately rule-less `חשבונות` whose
 *   every charge a label claims, the savings category, a RiseUp goal and the
 *   salary slot are all absent from the proposal by construction — which is also
 *   what makes a re-run on an unchanged account propose nothing.
 * - **A fixed item is never matched by merchant.** It has no name; it is keyed by
 *   the `sequenceId` on its charge, and which row it belongs to is a question for
 *   the Person. Yuval's two Partner commitments are the case: two envelopes both
 *   reading `חברת פרטנר תקשורת בע`, told apart only by `sequenceId`, and the
 *   sheet's two months imply opposite answers about which is which. So every
 *   fixed item is **undecided** until an answer comes, and the proposal prints
 *   each month's charge beside its id.
 * - **A near-match states its reason.** RiseUp's `חו״ל` carries a gershayim and
 *   the grid's `חו"ל` a straight quote: they are not equal under
 *   `normaliseCategoryName`, and a proposal that cannot say *why* it thinks they
 *   are one row is a guess. Each reason is one of a small named set.
 * - **A RiseUp category the grid lacks is proposed as a new Personal Category**,
 *   with the Household Category it would join named — created only on approval,
 *   and never by the monthly run in any mode.
 * - **`hand-typed` is computed last and held while anything is undecided.** A row
 *   has no RiseUp source only once every RiseUp row has a destination: computed
 *   before the Partner answer, Yuval's אינטרנט and טלפון 012 would be marked
 *   sourceless and silenced for good.
 * - **Nothing is written while anything is undecided**, the same posture as the
 *   write: a half-answered file would look complete, and the file the caller is
 *   handed back in that case is the one it already had.
 * - **A fixed item that charged nothing in the months surveyed is invisible**, by
 *   the header's own rule: no charge, no `sequenceId`, nothing to identify. So a
 *   row of the grid fed *only* by such an item would read as having no RiseUp
 *   source and be proposed as `hand-typed`. Surveying two months is the answer,
 *   the proposal says so, and a `hand-typed` disposition is one line to delete.
 * - **No amount ever reaches the file.** Charges are printed so a Person can
 *   recognise a row; what is written is rules and identities.
 */

import {
  type Categories,
  type CategoryType,
  type CreatePersonalCategoryRequest,
  type HouseholdCategory,
  type PersonalCategory,
  householdCategoriesFor,
  isRetired,
  normaliseCategoryName,
  personalCategoriesFor,
} from "@/domain/categories/categories";
import {
  type CategoryRule,
  type FixedItemRule,
  type RiseUpMapping,
  type RowDisposition,
  type Unresolved,
} from "@/domain/import/riseup-fold";
import { RISEUP_AUTHORITY_FROM, isRiseUpAuthority } from "@/domain/import/riseup-cutover";
import { digestLines } from "@/domain/import/riseup-write";
import { type Money, toDecimalString } from "@/domain/money/money";
import { type CalendarMonth, compareMonths, monthKey } from "@/domain/time/calendar-month";

/**
 * Where the *other spending* bucket lands when a file is being born and nobody
 * has said. Both People's grids hold this row; it is a default to be overridden,
 * not an assumption to be relied on, and a Person who has no such row is told to
 * name one rather than having one invented.
 */
export const DEFAULT_VARIABLE_CATEGORY = "משתנות";

// --- what goes in ------------------------------------------------------------

/**
 * One folded month, narrowed to what a proposal reads. `RiseUpFold` satisfies it,
 * so the script hands folds straight in and the tests hand in rows by hand.
 */
export interface MappedMonth {
  readonly month: CalendarMonth;
  readonly unresolved: readonly Unresolved[];
}

/** One of that Person's Personal Categories, numbered so an answer can name it. */
export interface Candidate {
  readonly number: number;
  readonly personalCategory: string;
  readonly type: CategoryType;
  readonly id: string;
  readonly retired: boolean;
}

/** One Household Category a new Personal Category could join, numbered likewise. */
export interface HouseholdOption {
  readonly number: number;
  readonly name: string;
  readonly type: CategoryType;
  readonly id: string;
}

/**
 * The answers, by the numbers the proposal printed. Numbers rather than names
 * because `חו"ל` and `שכ"ד` both carry a double quote, and a quote in a shell
 * argument is exactly what `/balance/import`'s own comment records going wrong.
 */
export interface MapAnswers {
  /** Proposal number → candidate number: this RiseUp row feeds that row of the grid. */
  readonly assign?: ReadonlyMap<number, number>;
  /**
   * Proposal number → the Household Category number a **new** Personal Category
   * joins, or `null` for one of its own name. Creating a row is never the default:
   * Eden's `חשבונות` is proposed here the moment one charge in it carries a label
   * no rule claims, and a new row is the wrong answer there. So a new-category
   * proposal is undecided until this says otherwise.
   */
  readonly create?: ReadonlyMap<number, number | null>;
  /** Proposal numbers the Person does not want. */
  readonly declined?: readonly number[];
}

export interface MapInput {
  /** The database's own person id — `yuval`, `eden`. */
  readonly person: string;
  readonly server: string;
  readonly months: readonly MappedMonth[];
  /** The committed file, or `null` for a file being born. */
  readonly mapping: RiseUpMapping | null;
  readonly categories: Categories;
  readonly answers?: MapAnswers;
  /** For a birth, where the income and the bucket go, when nothing can be derived. */
  readonly incomeCategory?: string;
  readonly variableCategory?: string;
}

// --- what comes out ----------------------------------------------------------

export type MapPile = "exact" | "near" | "fixed-item" | "new-category" | "sourceless";

export interface MonthCharge {
  readonly month: string;
  readonly amount: Money;
  /** True when RiseUp held the row that month but nothing was charged in it. */
  readonly empty: boolean;
}

export type HouseholdProposal =
  | { readonly kind: "new"; readonly name: string }
  | { readonly kind: "existing"; readonly id: string; readonly name: string };

export interface MapProposal {
  /** 1-based, and what `--assign`, `--create` and `--decline` name. */
  readonly index: number;
  readonly pile: MapPile;
  /** What RiseUp calls the row — a category name, or a fixed item's merchant. */
  readonly riseupRow: string;
  /** Why this destination is proposed, printed with it. Never "it looked close". */
  readonly reason: string;
  /** `null` while nobody has said where it goes. */
  readonly personalCategory: string | null;
  readonly type: CategoryType;
  readonly sequenceId?: string;
  readonly merchant?: string;
  readonly detail?: string;
  readonly charges: readonly MonthCharge[];
  /** The rows a near-match or an unidentified fixed item could plausibly be. */
  readonly plausible: readonly Candidate[];
  readonly household?: HouseholdProposal;
  readonly state: "proposed" | "undecided" | "declined";
  /** What is missing, or what a decline leaves behind. Printed under the row. */
  readonly why?: string;
}

/** A RiseUp row with nothing to key a rule on. Reported, never proposed. */
export interface NotMappableRow {
  readonly label: string;
  readonly amount: Money;
  readonly detail: string;
  readonly kind: Unresolved["kind"];
  readonly id?: string;
}

export interface RiseUpMapPlan {
  readonly person: string;
  readonly months: readonly string[];
  /** The earliest month surveyed: what a new Personal Category is active from. */
  readonly activeFrom: CalendarMonth;
  readonly candidates: readonly Candidate[];
  readonly households: readonly HouseholdOption[];
  readonly proposals: readonly MapProposal[];
  readonly piles: Readonly<Record<MapPile, readonly MapProposal[]>>;
  /** Sourceless rows while something else is undecided: named, not yet proposed. */
  readonly heldSourceless: readonly string[];
  /** How many rules the file already carries, so a quiet run says why it is quiet. */
  readonly alreadyMapped: number;
  readonly notMappable: readonly NotMappableRow[];
  /** Every reason nothing may be written. Non-empty means nothing is written. */
  readonly refusals: readonly string[];
  /** True only when the missing approval is the last thing in the way. */
  readonly awaitingApproval: boolean;
  readonly token: string;
  /** The file as it would be written. Identical to the input when nothing changed. */
  readonly mapping: RiseUpMapping;
  /** False when the proposal would leave the file as it is. */
  readonly changed: boolean;
  /** The Personal Categories to create, for `planPersonalCategoryCreation`. */
  readonly creations: readonly CreatePersonalCategoryRequest[];
  readonly writable: boolean;
}

// --- names, and how close two of them are ------------------------------------

/**
 * Gershayim, geresh and the curly quotes folded onto the straight ones. RiseUp
 * writes `חו״ל` with U+05F4 and the grid writes `חו"ל` with U+0022: one row, two
 * spellings, and the difference is invisible on screen.
 */
function foldQuotes(name: string): string {
  return name.replace(/[״“”]/g, '"').replace(/[׳‘’]/g, "'");
}

function stripPunctuation(name: string): string {
  return foldQuotes(name)
    .replace(/["'`.,\-_/\\+()[\]]/g, "")
    .replace(/\s+/g, "");
}

const key = (name: string) => normaliseCategoryName(name);

/** Byte-equal once whitespace is collapsed. Nothing is being inferred here. */
function isExact(riseup: string, candidate: string): boolean {
  return key(riseup) === key(candidate);
}

/**
 * Why these two might be one row, or `null` when nothing honest can be said. The
 * reason is printed with the proposal, so each one is a sentence a Person can
 * agree or disagree with rather than a similarity score.
 *
 * `weak` separates *the same name, spelled differently* from *one name inside
 * another*, which is a different claim and a weaker one: Eden's
 * `אוכל בחוץ - קפה` contains `אוכל בחוץ`, and her file sends it to `בתי קפה`.
 * A weak match is shown with its reason and left **undecided**, so it is a
 * suggestion to answer rather than a destination to approve.
 */
export interface Nearness {
  readonly reason: string;
  readonly weak: boolean;
}

export function nearReason(riseup: string, candidate: string): Nearness | null {
  const left = key(riseup);
  const right = key(candidate);
  if (left === right) return null;
  if (foldQuotes(left) === foldQuotes(right)) {
    return {
      reason:
        "the same name in different quote characters — RiseUp's gershayim (U+05F4) against the grid's straight quote",
      weak: false,
    };
  }
  if (left.toLocaleLowerCase() === right.toLocaleLowerCase()) {
    return { reason: "the same name in different letter case", weak: false };
  }
  if (stripPunctuation(left).toLocaleLowerCase() === stripPunctuation(right).toLocaleLowerCase()) {
    return { reason: "the same name once punctuation and spacing are set aside", weak: false };
  }
  const riseupName = stripPunctuation(left).toLocaleLowerCase();
  const gridName = stripPunctuation(right).toLocaleLowerCase();
  if (riseupName.length >= 3 && gridName.length >= 3) {
    if (riseupName.includes(gridName)) {
      return {
        reason:
          `RiseUp's name contains the grid's \`${candidate}\` — which is a weaker claim than ` +
          `one name spelled two ways, so nobody here decides it`,
        weak: true,
      };
    }
    if (gridName.includes(riseupName)) {
      return {
        reason:
          `the grid's \`${candidate}\` contains RiseUp's name — which is a weaker claim than ` +
          `one name spelled two ways, so nobody here decides it`,
        weak: true,
      };
    }
  }
  return null;
}

// --- the RiseUp rows a proposal is about -------------------------------------

/**
 * A file with no rules in it, which is what a birth folds with: every RiseUp row
 * comes back unresolved and therefore proposable, the salary slot included.
 */
export function skeletonMapping(person: string, server: string): RiseUpMapping {
  return {
    person,
    server,
    incomeCategory: "",
    variableCategory: "",
    categoryRules: [],
    fixedItemRules: [],
    labelRules: [],
    dispositions: [],
    transactionDispositions: [],
  };
}

/** Every Personal Category some rule in this file already feeds or silences. */
function targetsOf(mapping: RiseUpMapping): Set<string> {
  return new Set<string>([
    mapping.incomeCategory,
    mapping.variableCategory,
    ...mapping.categoryRules.map((rule) => rule.personalCategory),
    ...mapping.fixedItemRules.map((rule) => rule.personalCategory),
    ...(mapping.labelRules ?? []).map((rule) => rule.personalCategory),
    ...(mapping.dispositions ?? []).flatMap((row) =>
      row.action === "hand-typed" && typeof row.personalCategory === "string"
        ? [row.personalCategory]
        : [],
    ),
  ]);
}

interface RiseUpRow {
  readonly identity: string;
  readonly kind: "category" | "fixed-item";
  readonly name: string;
  readonly merchant?: string;
  readonly sequenceId?: string;
  readonly detail?: string;
  readonly side: "income" | "expense";
  readonly charges: MonthCharge[];
}

/**
 * The unresolved rows of every month surveyed, merged by identity — which is what
 * puts both Partner months' charges on one line (criterion 6). A row RiseUp held
 * with no charge that month is kept and marked empty rather than dropped.
 */
function rowsOf(months: readonly MappedMonth[]): {
  readonly rows: readonly RiseUpRow[];
  readonly notMappable: readonly NotMappableRow[];
} {
  const rows = new Map<string, RiseUpRow>();
  const notMappable: NotMappableRow[] = [];
  const seen = new Set<string>();

  for (const month of months) {
    const label = monthKey(month.month);
    for (const row of month.unresolved) {
      const charge: MonthCharge = {
        month: label,
        amount: row.amount,
        empty: row.amount.minorUnits === 0,
      };

      const mappable =
        row.kind === "unmapped-category" && typeof row.riseupCategory === "string"
          ? { identity: `category:${key(row.riseupCategory)}`, kind: "category" as const }
          : row.kind === "unmapped-fixed-item" && typeof row.sequenceId === "string"
            ? { identity: `fixed:${row.sequenceId}`, kind: "fixed-item" as const }
            : null;

      if (mappable !== null) {
        const already = rows.get(mappable.identity);
        if (already !== undefined) {
          already.charges.push(charge);
          continue;
        }
        rows.set(mappable.identity, {
          identity: mappable.identity,
          kind: mappable.kind,
          name: mappable.kind === "category" ? (row.riseupCategory as string) : (row.merchant ?? row.label),
          ...(row.merchant === undefined ? {} : { merchant: row.merchant }),
          ...(row.sequenceId === undefined ? {} : { sequenceId: row.sequenceId }),
          ...(row.detail === undefined ? {} : { detail: row.detail }),
          side: row.side,
          charges: [charge],
        });
        continue;
      }

      // Everything else has nothing to key a rule on: a tracked category with no
      // name, a fixed item whose charge carries no `sequenceId`, an envelope of
      // an unknown type — and the credits, which are decided by `transactionId`
      // in the file's own `transactionDispositions` and are not a row's mapping.
      const id = row.sequenceId ?? row.transactionId ?? row.envelopeId;
      const identity = `${row.kind}:${id ?? row.label}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      notMappable.push({
        label: row.label,
        amount: row.amount,
        kind: row.kind,
        detail:
          row.kind === "credit-without-disposition" || row.kind === "credit-unassignable"
            ? "money in: decided by `transactionId` in this file's own transactionDispositions, which is not a row's mapping"
            : (row.detail ?? "nothing on this row can key a rule"),
        ...(id === undefined ? {} : { id }),
      });
    }
  }

  return { rows: [...rows.values()], notMappable };
}

// --- the plan ----------------------------------------------------------------

/** A proposal before its number and its state are known. */
interface Draft {
  readonly row: Omit<MapProposal, "index" | "state" | "why">;
  /** True when nothing but a Person's answer can place this row. */
  readonly needsAnswer: boolean;
}

export function planRiseUpMapping(input: MapInput): RiseUpMapPlan {
  if (input.months.length === 0) {
    throw new Error("A mapping proposal needs at least one folded month to read.");
  }

  const months = [...input.months].sort((left, right) => compareMonths(left.month, right.month));
  /**
   * The earliest month surveyed — but never earlier than the cutover. A category
   * active in a month is a **blank** in it until something is recorded, and a
   * month with a blank reads `open` in `month-closure.ts`. A row created active
   * from 2026-09 would therefore re-open a month the sheet importer owns and this
   * feature may not touch, just by existing (ADR 0006).
   */
  const surveyedFrom = (months[0] as MappedMonth).month;
  const activeFrom = isRiseUpAuthority(surveyedFrom) ? surveyedFrom : RISEUP_AUTHORITY_FROM;
  const base = input.mapping ?? skeletonMapping(input.person, input.server);
  const birth = input.mapping === null;

  /**
   * Retired means **retired** — a lifespan with an end on it — and not "not active
   * in the month surveyed". A row created to start next month is live and a rule
   * into it is perfectly ordinary; its own `activeFrom` is what decides which
   * months offer it for entry, and nothing here may take that decision over.
   */
  const everyCategory = personalCategoriesFor(input.categories, input.person);
  const active = everyCategory.filter((category) => !isRetired(category));
  const candidates: Candidate[] = everyCategory.map((category, position) => ({
    number: position + 1,
    personalCategory: category.name,
    type: category.type,
    id: category.id,
    retired: isRetired(category),
  }));
  const households: HouseholdOption[] = householdCategoriesFor(input.categories).map(
    (household: HouseholdCategory, position) => ({
      number: position + 1,
      name: household.name,
      type: household.type,
      id: household.id,
    }),
  );

  /**
   * The file's two named rows. For a birth they are derived — a Person has one
   * הכנסה row and the bucket is `משתנות` — and nothing is invented: a Person
   * with neither is told to settle it in the grid first.
   */
  const income = birth
    ? (input.incomeCategory ??
      (active.filter((category) => category.type === "income").length === 1
        ? (active.find((category) => category.type === "income") as PersonalCategory).name
        : ""))
    : base.incomeCategory;

  const variable = birth
    ? (input.variableCategory ??
      active.find(
        (category) =>
          category.type === "expense" && isExact(category.name, DEFAULT_VARIABLE_CATEGORY),
      )?.name ??
      "")
    : base.variableCategory;

  const answers = input.answers ?? {};
  const assign = answers.assign ?? new Map<number, number>();
  const create = answers.create ?? new Map<number, number | null>();
  const declined = new Set(answers.declined ?? []);

  const refusals: string[] = [];
  if (birth && income === "") {
    refusals.push(
      `${input.person} has no single הכנסה row for RiseUp's salary charge to land in, so a new ` +
        `mapping file cannot name one. Settle it in /balance first.`,
    );
  }
  if (birth && variable === "") {
    refusals.push(
      `${input.person} has no \`${DEFAULT_VARIABLE_CATEGORY}\` row for RiseUp's other-spending ` +
        `bucket to land in, so a new mapping file cannot name one. Create it in /balance first.`,
    );
  }
  const { rows: everyRow, notMappable } = rowsOf(months);
  const live = candidates.filter((candidate) => !candidate.retired);

  /**
   * A row the file already keys is not proposed again, by name for a tracked
   * category and by `sequenceId` for a fixed item. The fold is what ordinarily
   * keeps such a row out of `unresolved` at all; this is the belt beside it, so
   * that "a re-run on an unchanged account proposes no change" holds even if a
   * row ever arrives here twice.
   */
  const keyed = {
    categories: new Set(base.categoryRules.map((rule) => key(rule.riseupCategory))),
    fixedItems: new Set(base.fixedItemRules.map((rule) => rule.sequenceId)),
  };
  const rows = everyRow.filter((row) =>
    row.kind === "category"
      ? !keyed.categories.has(key(row.name))
      : !keyed.fixedItems.has(row.sequenceId ?? ""),
  );

  const exact: Draft[] = [];
  const near: Draft[] = [];
  const fixedItems: Draft[] = [];
  const newCategories: Draft[] = [];

  for (const row of rows) {
    const type: CategoryType = row.side === "income" ? "income" : "expense";
    const common = {
      riseupRow: row.name,
      type,
      ...(row.sequenceId === undefined ? {} : { sequenceId: row.sequenceId }),
      ...(row.merchant === undefined ? {} : { merchant: row.merchant }),
      ...(row.detail === undefined ? {} : { detail: row.detail }),
      charges: row.charges,
    };

    if (row.kind === "fixed-item") {
      // Never matched by merchant, however plainly it reads: a fixed item has no
      // name, and the two Partner commitments are what that rule is for.
      fixedItems.push({
        row: {
          ...common,
          pile: "fixed-item",
          reason: "a fixed item has no name of its own — which row it belongs to is the Person's to say",
          personalCategory: null,
          plausible: live.filter((candidate) => candidate.type === type),
        },
        needsAnswer: true,
      });
      continue;
    }

    const sameType = live.filter((candidate) => candidate.type === type);
    const exactly = sameType.filter((candidate) => isExact(row.name, candidate.personalCategory));
    if (exactly.length === 1) {
      exact.push({
        row: {
          ...common,
          pile: "exact",
          reason: "the RiseUp category and the row of the grid carry the same name",
          personalCategory: (exactly[0] as Candidate).personalCategory,
          plausible: exactly,
        },
        needsAnswer: false,
      });
      continue;
    }

    const nearly = sameType.flatMap((candidate) => {
      const nearness = nearReason(row.name, candidate.personalCategory);
      return nearness === null ? [] : [{ candidate, ...nearness }];
    });
    if (nearly.length === 1) {
      const only = nearly[0] as { candidate: Candidate; reason: string; weak: boolean };
      // A weak match is a suggestion, not a destination: it is shown with the
      // candidate beside it and answered, never approved as it stands.
      near.push({
        row: {
          ...common,
          pile: "near",
          reason: only.reason,
          personalCategory: only.weak ? null : only.candidate.personalCategory,
          plausible: only.weak ? sameType : [only.candidate],
        },
        needsAnswer: only.weak,
      });
      continue;
    }
    if (nearly.length > 1) {
      near.push({
        row: {
          ...common,
          pile: "near",
          reason:
            `${nearly.length} rows of the grid are near this name, so nothing here chooses ` +
            `between them: ${nearly.map((match) => `\`${match.candidate.personalCategory}\``).join(", ")}`,
          personalCategory: null,
          plausible: nearly.map((match) => match.candidate),
        },
        needsAnswer: true,
      });
      continue;
    }

    // A retired row of that very name is not a new category and not a match: a
    // rule into a row the grid no longer offers would write where nobody looks.
    const retired = candidates.find(
      (candidate) =>
        candidate.retired &&
        candidate.type === type &&
        isExact(row.name, candidate.personalCategory),
    );
    if (retired !== undefined) {
      near.push({
        row: {
          ...common,
          pile: "near",
          reason:
            `the grid holds a **retired** row of this name. Un-retire it in /balance, or ` +
            `\`--assign\` this RiseUp row to a live one`,
          personalCategory: null,
          plausible: sameType,
        },
        needsAnswer: true,
      });
      continue;
    }

    // Nothing in the grid is this row. A new Personal Category, with the
    // Household Category it would join — created only on approval, and never by
    // the monthly run.
    const householdByName = households.find(
      (option) => option.type === type && isExact(row.name, option.name),
    );
    newCategories.push({
      row: {
        ...common,
        pile: "new-category",
        reason:
          householdByName === undefined
            ? "RiseUp holds this category and the grid has no row near it, so it would be a new Personal Category and a new Household Category of the same name"
            : `RiseUp holds this category and the grid has no row near it, so it would be a new Personal Category joining the existing Household Category \`${householdByName.name}\``,
        personalCategory: key(row.name),
        plausible: sameType,
        household:
          householdByName === undefined
            ? { kind: "new", name: key(row.name) }
            : { kind: "existing", id: householdByName.id, name: householdByName.name },
      },
      needsAnswer: false,
    });
  }

  // --- the answers -----------------------------------------------------------

  const ordered: readonly Draft[] = [...exact, ...near, ...fixedItems, ...newCategories];
  const decided: MapProposal[] = [];
  const addedCategoryRules: CategoryRule[] = [];
  const addedFixedItems: FixedItemRule[] = [];
  const creations: CreatePersonalCategoryRequest[] = [];
  const settled = new Set<string>();
  let undecided = 0;

  ordered.forEach((draft, position) => {
    const index = position + 1;
    const asked = assign.get(index);
    const given =
      asked === undefined
        ? undefined
        : candidates.find((candidate) => candidate.number === asked);

    if (asked !== undefined && given === undefined) {
      refusals.push(
        `\`--assign ${index}:${asked}\` names no row of ${input.person}'s grid ` +
          `(1–${candidates.length}), so nothing is written.`,
      );
    }
    if (given !== undefined && given.retired) {
      refusals.push(
        `\`${given.personalCategory}\` is retired, so proposal ${index} would feed a row the ` +
          `grid no longer offers. Un-retire it in /balance, or name a live one.`,
      );
    }
    if (given !== undefined && given.type !== draft.row.type) {
      refusals.push(
        `\`${given.personalCategory}\` is a ${given.type === "income" ? "הכנסה" : "הוצאה"} and ` +
          `proposal ${index} is ${draft.row.type === "income" ? "money in" : "money out"}, so it ` +
          `would route one into the other.`,
      );
    }

    // A decline of a RiseUp row says "not that destination". It is never a
    // resolution: the row stays unplaced and the monthly run keeps refusing it,
    // so only an `--assign` settles it.
    if (declined.has(index) && given === undefined) {
      undecided += 1;
      decided.push({
        ...draft.row,
        index,
        state: "declined",
        why:
          `declined, and so still unplaced: the monthly run keeps refusing this row until ` +
          `\`--assign ${index}:<n>\` says which row of the grid it feeds` +
          (draft.row.pile === "fixed-item"
            ? `. A fixed item the מאזן records nowhere has no form in this file at all — that is a header decision, not something to settle here`
            : ""),
      });
      return;
    }

    if (given !== undefined) {
      // An answer turns any pile into a plain rule, which is also how a
      // new-category proposal is redirected into a row the grid already has.
      if (draft.row.pile === "fixed-item") {
        addedFixedItems.push({
          sequenceId: draft.row.sequenceId ?? "",
          ...(draft.row.merchant === undefined ? {} : { merchant: draft.row.merchant }),
          personalCategory: given.personalCategory,
          note: "identified by the Person through --map: the merchant is a label, the sequenceId is the key",
        });
      } else {
        addedCategoryRules.push({
          riseupCategory: draft.row.riseupRow,
          personalCategory: given.personalCategory,
          note: "chosen by the Person through --map",
        });
      }
      settled.add(given.personalCategory);
      decided.push({
        ...draft.row,
        index,
        personalCategory: given.personalCategory,
        reason: `chosen by the Person: \`--assign ${index}:${given.number}\``,
        state: "proposed",
      });
      return;
    }

    if (draft.needsAnswer) {
      undecided += 1;
      decided.push({
        ...draft.row,
        index,
        state: "undecided",
        why: `nobody has said where this goes — \`--assign ${index}:<n>\`, by the numbers of the grid below`,
      });
      return;
    }

    if (draft.row.pile === "new-category") {
      const name = draft.row.personalCategory as string;
      // Creating a row is never the default. Eden's `חשבונות` is proposed here
      // the moment one charge in it carries a label no rule claims, and a new row
      // is the wrong answer to that — a label rule is. So the proposal names the
      // row it *would* create and waits.
      if (!create.has(index)) {
        undecided += 1;
        decided.push({
          ...draft.row,
          index,
          state: "undecided",
          why:
            `a new row is created only on the Person's own say-so: \`--create ${index}\` for ` +
            `one with a Household Category of its own, \`--create ${index}:<h>\` to join an ` +
            `existing one, or \`--assign ${index}:<n>\` if it is a row the grid already has`,
        });
        return;
      }
      const asJoined = create.get(index) ?? null;
      const option =
        asJoined === null
          ? undefined
          : households.find((household) => household.number === asJoined);
      if (asJoined !== null && option === undefined) {
        refusals.push(
          `\`--create ${index}:${asJoined}\` names no Household Category ` +
            `(1–${households.length}), so nothing is written.`,
        );
      }
      if (option !== undefined && option.type !== draft.row.type) {
        refusals.push(
          `\`${option.name}\` is a ${option.type === "income" ? "הכנסה" : "הוצאה"} at the ` +
            `household level and proposal ${index} is ` +
            `${draft.row.type === "income" ? "הכנסה" : "הוצאה"}, so they cannot be joined.`,
        );
      }
      const household: HouseholdProposal =
        option !== undefined
          ? { kind: "existing", id: option.id, name: option.name }
          : (draft.row.household as HouseholdProposal);
      creations.push({
        personId: input.person,
        name,
        type: draft.row.type,
        activeFrom,
        household:
          household.kind === "existing"
            ? { kind: "existing", id: household.id }
            : { kind: "new", name: household.name },
      });
      addedCategoryRules.push({
        riseupCategory: draft.row.riseupRow,
        personalCategory: name,
        note: "a Personal Category created by --map for this RiseUp category",
      });
      settled.add(name);
      decided.push({
        ...draft.row,
        index,
        household,
        reason:
          option === undefined
            ? `a new Personal Category with a Household Category of its own, chosen by the Person: \`--create ${index}\``
            : `a new Personal Category joining the Household Category \`${option.name}\`, chosen by the Person`,
        state: "proposed",
      });
      return;
    }

    const destination = draft.row.personalCategory as string;
    addedCategoryRules.push({
      riseupCategory: draft.row.riseupRow,
      personalCategory: destination,
      note:
        draft.row.pile === "exact"
          ? "an exact name match, proposed by --map"
          : `proposed by --map: ${draft.row.reason}`,
    });
    settled.add(destination);
    decided.push({ ...draft.row, index, state: "proposed" });
  });

  // --- the sourceless rows, last and only once everything else is settled ----

  const targets = targetsOf(base);
  for (const target of settled) targets.add(target);
  // The income row and the bucket are the file's own two named rows. For a birth
  // they are derived rather than read off a file, and a run that forgot that
  // would propose the Person's own משתנות as having no RiseUp source.
  targets.add(income);
  targets.add(variable);

  const sourcelessNames = active.filter((category) => !targets.has(category.name));

  const sourceless: MapProposal[] = [];
  const heldSourceless: string[] = [];
  if (undecided > 0) {
    // Held, not proposed. Computed now, Yuval's אינטרנט and טלפון 012 would be
    // marked hand-typed and silenced for good while their Partner commitments
    // are still waiting for an answer.
    heldSourceless.push(...sourcelessNames.map((category) => category.name));
  } else {
    sourcelessNames.forEach((category, position) => {
      const index = ordered.length + position + 1;
      sourceless.push({
        index,
        pile: "sourceless",
        riseupRow: "—",
        reason:
          "no RiseUp row feeds this row of the grid, so it is typed by hand and never flagged again",
        personalCategory: category.name,
        type: category.type,
        charges: [],
        plausible: [],
        state: declined.has(index) ? "declined" : "proposed",
        ...(declined.has(index)
          ? { why: "declined: no disposition is written for it, so the next --map proposes it again" }
          : {}),
      });
    });
  }

  const addedDispositions: RowDisposition[] = sourceless
    .filter((row) => row.state === "proposed")
    .map((row) => ({
      action: "hand-typed" as const,
      personalCategory: row.personalCategory as string,
      note: "no RiseUp row feeds it: this row of the grid is typed by hand",
    }));

  if (undecided > 0) {
    refusals.push(
      `${undecided} ${undecided === 1 ? "row is" : "rows are"} undecided — so nothing is ` +
        `written at all, not even the rules that are clear, and the rows with no RiseUp source ` +
        `are held rather than marked hand-typed. A row marked hand-typed while another RiseUp ` +
        `line is still unplaced could be the very row that line feeds.`,
    );
  }

  // --- the file as it would be written ---------------------------------------

  /**
   * The file as it would be written — and **only** when nothing is in the way.
   * A proposal that is refused leaves the file exactly as it is, so no caller can
   * take the half of it that was settled and write that: the whole point of the
   * refusal is that a part-written file would look complete.
   */
  const proposed: RiseUpMapping = {
    ...base,
    incomeCategory: income,
    variableCategory: variable,
    categoryRules: [...base.categoryRules, ...addedCategoryRules],
    fixedItemRules: [...base.fixedItemRules, ...addedFixedItems],
    labelRules: base.labelRules ?? [],
    dispositions: [...(base.dispositions ?? []), ...addedDispositions],
    transactionDispositions: base.transactionDispositions ?? [],
  };

  const proposals: readonly MapProposal[] = [...decided, ...sourceless];

  /**
   * An answer naming a proposal that is not there. Silently ignoring one is how a
   * `--decline 8` meant for row 7 writes row 7 anyway: the token covers the
   * proposals, not the answers, so nothing else would catch it. Phase 33's audit
   * found the same class in the write's own `--decline`.
   */
  const numbers = new Set(proposals.map((row) => row.index));
  const byNumber = new Map(proposals.map((row) => [row.index, row]));
  for (const [flag, named] of [
    ["--assign", [...assign.keys()]],
    ["--create", [...create.keys()]],
    ["--decline", [...declined]],
  ] as const) {
    const strangers = named.filter((number) => !numbers.has(number));
    if (strangers.length > 0) {
      refusals.push(
        `${strangers.map((number) => `\`${flag} ${number}\``).join(", ")} ` +
          `${strangers.length === 1 ? "names a proposal" : "name proposals"} this run did not ` +
          `make${proposals.length === 0 ? " (it made none)" : ` (1–${proposals.length})`}, so ` +
          `the answers do not line up with the tables and nothing is written.`,
      );
    }
  }
  for (const number of create.keys()) {
    const row = byNumber.get(number);
    if (row !== undefined && row.pile !== "new-category") {
      refusals.push(
        `\`--create ${number}\` answers a proposal that is not a new Personal Category — ` +
          `${number} is ${row.pile === "sourceless" ? "a row of the grid with no RiseUp source" : `a ${row.pile} proposal`}. ` +
          `A Household Category is only ever chosen for a row being created.`,
      );
    }
  }
  for (const number of assign.keys()) {
    const row = byNumber.get(number);
    if (row !== undefined && row.pile === "sourceless") {
      refusals.push(
        `\`--assign ${number}:…\` answers a row of the grid with no RiseUp source, which has ` +
          `nothing to assign: it is fed by nothing, which is what \`hand-typed\` records. ` +
          `\`--decline ${number}\` is what leaves it unmarked.`,
      );
    }
  }

  // --- the token, and what is in the way -------------------------------------

  // Decided last, after every refusal above: the file handed back when anything
  // is in the way is the file there already was.
  const mapping = refusals.length === 0 ? proposed : base;
  const changed =
    refusals.length === 0 &&
    (birth ||
      addedCategoryRules.length > 0 ||
      addedFixedItems.length > 0 ||
      addedDispositions.length > 0);

  const token = digestLines([
    input.person,
    ...months.map((month) => monthKey(month.month)),
    ...proposals.map(
      (row) =>
        `${row.index}:${row.pile}:${row.riseupRow}:${row.sequenceId ?? ""}>` +
        `${row.state}:${row.personalCategory ?? ""}:` +
        `${row.household?.kind ?? ""}:${row.household?.name ?? ""}`,
    ),
    ...creations.map((creation) => `new:${creation.name}:${creation.household.kind}`),
  ]);

  return {
    person: input.person,
    months: months.map((month) => monthKey(month.month)),
    activeFrom,
    candidates,
    households,
    proposals,
    piles: {
      exact: proposals.filter((row) => row.pile === "exact"),
      near: proposals.filter((row) => row.pile === "near"),
      "fixed-item": proposals.filter((row) => row.pile === "fixed-item"),
      "new-category": proposals.filter((row) => row.pile === "new-category"),
      sourceless: proposals.filter((row) => row.pile === "sourceless"),
    },
    heldSourceless,
    alreadyMapped:
      base.categoryRules.length + base.fixedItemRules.length + (base.labelRules ?? []).length,
    notMappable,
    refusals,
    awaitingApproval: refusals.length === 0 && changed,
    token,
    mapping,
    changed,
    creations: refusals.length === 0 ? creations : [],
    writable: refusals.length === 0 && changed,
  };
}

/**
 * The file, as text. Canonical two-space JSON with a trailing newline and LF
 * endings, so that the only thing a `git diff` ever shows is a changed rule —
 * which is the whole reason the mapping lives in the repository (ADR 0006).
 *
 * Unknown keys survive, because the `_note` paragraphs are the file's own
 * explanation of itself and no writer may drop them.
 */
export function serialiseMapping(mapping: RiseUpMapping): string {
  return `${JSON.stringify(mapping, null, 2)}\n`.replace(/\r\n/g, "\n");
}

/** What `--map` quotes of an amount: a figure to recognise a row by, never written. */
export function chargeLabel(charge: MonthCharge): string {
  return charge.empty ? `${charge.month} —` : `${charge.month} ${toDecimalString(charge.amount)}`;
}
