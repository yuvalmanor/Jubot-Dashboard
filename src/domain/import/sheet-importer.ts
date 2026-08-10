/**
 * SheetImporter — turning the exported מאזן into Personal Categories and Entries.
 *
 * Framework-free per ADR 0004, and isolated and disposable by design: nothing
 * else imports this module, and deleting it once the history is in would leave
 * the rest of the system untouched.
 *
 * It **proposes**. Every category, every household grouping and every row it
 * declines to read is a proposal carrying the reason for it, and `planWrites`
 * turns proposals into writes only for what a person has confirmed. The sheet's
 * own guesses are the thing being replaced, so this module does not get to make
 * new ones silently.
 *
 * Three facts about the source shape the design:
 *
 * - **The tabs overlap.** Jan–Jun 2025 appears in both the 2024 and the 2025 tab.
 *   Where the two agree, the month resolves to one entry. Where they disagree,
 *   the tab whose own year owns the month wins and the disagreement is reported
 *   rather than averaged away.
 * - **Not every row is a category.** `סה"כ הוצאות` and `חיסכון` are computed by
 *   the sheet; importing them would double-count the first and contradict the
 *   invariant behind the second, which is that חיסכון is `הכנסות − הוצאות` and is
 *   never stored. `הפקדות לחיסכון` is money moved rather than spent — the sheet
 *   leaves it out of its own expense total, and the household records no
 *   transfers at all.
 * - **The sheet keeps income as a monthly total only.** There are no per-category
 *   income rows to import, so `סה"כ הכנסות` becomes one income category per
 *   Person. That is the granularity the history actually has; pretending to more
 *   would be inventing it.
 */

import {
  type CategoryType,
  normaliseCategoryName,
} from "@/domain/categories/categories";
import {
  type SheetBlock,
  type SheetExport,
  type SheetRow,
} from "@/domain/import/sheet-export";
import {
  type Currency,
  type Money,
  add,
  equals,
  isZero,
  money,
  subtract,
  sum,
  zero,
} from "@/domain/money/money";
import { type CalendarMonth, compareMonths, monthKey, monthsEqual } from "@/domain/time/calendar-month";

/** What a row of the sheet is, which decides whether it can become a category. */
export type RowRole =
  /** An ordinary expense category. */
  | "expense"
  /** `סה"כ הכנסות` — the sheet's only record of income. */
  | "income-total"
  /** `סה"כ הוצאות` — computed by the sheet. Kept, but only to check ours against. */
  | "expense-total"
  /** `חיסכון` — `הכנסות − הוצאות`, which this system computes and never stores. */
  | "saving"
  /** Money moved rather than spent. Outside the sheet's own expense total. */
  | "transfer"
  /** A note beside the totals rather than a line inside them. */
  | "memo"
  /** Any other row the sheet derives from its own figures. */
  | "derived";

const ROW_ROLES: ReadonlyMap<string, RowRole> = new Map([
  ['סה"כ הוצאות', "expense-total"],
  ['סה"כ הכנסות', "income-total"],
  ["חיסכון", "saving"],
  ["הפקדות לחיסכון", "transfer"],
  ["מילואים", "memo"],
  ['הוצאות ללא EPP', "derived"],
]);

/** The household name a Person's income total joins. Both People's feed one line. */
const INCOME_CATEGORY_NAME = "הכנסות";

/**
 * Personal names the household has confirmed are one real-world spend under two
 * vocabularies. `EPP` is Apple's employee food benefit, not ESPP — recorded
 * during the melt (docs/prd/jubot.md, *Further Notes*) and the canonical example
 * of two Personal Categories sharing one Household Category.
 *
 * This is the only place the importer pairs names it is told about rather than
 * names that match. Everything else it merely notices and reports.
 */
const KNOWN_PAIRS: readonly { readonly names: readonly string[]; readonly household: string }[] = [
  { names: ["אוכל APPLE", "העברות EPP"], household: "אוכל APPLE" },
];

export interface ImportPerson {
  readonly id: string;
  /** How the sheet's banner names them: `יובל`, `עדן`. */
  readonly sheetName: string;
}

export interface ImportOptions {
  readonly currency: Currency;
  readonly people: readonly ImportPerson[];
}

export interface ProposedCategory {
  /** Stable across re-runs: the same export always proposes the same keys. */
  readonly key: string;
  readonly personId: string;
  readonly name: string;
  readonly type: CategoryType;
  readonly activeFrom: CalendarMonth;
  /** Set when the row stopped appearing on later tabs — retirement, not deletion. */
  readonly activeUntil: CalendarMonth | null;
  /** The row label it came from, so a proposal can always be traced to the sheet. */
  readonly sheetLabel: string;
  readonly role: RowRole;
  readonly entryCount: number;
  /** The Household Category this would join. A proposal; the reviewer may change it. */
  readonly householdName: string;
  /** Whether the importer proposes writing it. Never a decision it makes alone. */
  readonly included: boolean;
  /** Why it is proposed as excluded, or `null` when it is proposed as included. */
  readonly excludedReason: string | null;
}

export interface ProposedEntry {
  readonly categoryKey: string;
  readonly month: CalendarMonth;
  readonly amount: Money;
}

/**
 * The sheet's own `סה"כ הוצאות` against the same month recomputed from the rows
 * this importer would write. This is the check that says the import is faithful,
 * and it is reported per month rather than as a single verdict.
 */
export interface TotalCheck {
  readonly personId: string;
  readonly month: CalendarMonth;
  readonly stated: Money;
  readonly recomputed: Money;
  readonly difference: Money;
  readonly agrees: boolean;
}

export type ImportFlag =
  /** `#REF!`, `#DIV/0!` — flagged for correction, never imported as a value. */
  | { readonly kind: "error-cell"; readonly owner: string; readonly label: string; readonly month: CalendarMonth; readonly text: string }
  /** Text where an amount belongs. Not read as a number and not silently dropped. */
  | { readonly kind: "unreadable-cell"; readonly owner: string; readonly label: string; readonly month: CalendarMonth; readonly text: string }
  /** The same category-month given two different values by two overlapping tabs. */
  | {
      readonly kind: "overlap-conflict";
      readonly categoryKey: string;
      readonly personId: string;
      readonly label: string;
      readonly month: CalendarMonth;
      readonly kept: Money;
      readonly keptFrom: string;
      readonly discarded: Money;
      readonly discardedFrom: string;
    }
  /** A block of household figures the sheet derives. Derived here too, never imported. */
  | { readonly kind: "derived-block-skipped"; readonly banner: string; readonly reason: string }
  /** A block whose banner names nobody the caller knows about. */
  | { readonly kind: "unknown-owner"; readonly banner: string; readonly owner: string }
  /** Month columns past the last one holding any figure — not yet recorded, not zero. */
  | { readonly kind: "unrecorded-tail"; readonly banner: string; readonly from: CalendarMonth }
  /** Two personal names one character apart, left ungrouped for a person to judge. */
  | { readonly kind: "similar-names"; readonly left: string; readonly right: string };

export interface ImportProposal {
  readonly categories: readonly ProposedCategory[];
  readonly entries: readonly ProposedEntry[];
  readonly totals: readonly TotalCheck[];
  readonly flags: readonly ImportFlag[];
  /** The span the import actually covers, or `null` when nothing was read. */
  readonly span: { readonly from: CalendarMonth; readonly to: CalendarMonth } | null;
  readonly currency: Currency;
}

// --- reading one block -------------------------------------------------------

function roleOf(label: string): RowRole {
  return ROW_ROLES.get(normaliseCategoryName(label)) ?? "expense";
}

function categoryKey(personId: string, name: string): string {
  return `${personId}:${name}`;
}

/**
 * The last month column of a block holding any figure at all.
 *
 * The current year's tab carries formula zeros for months that have not happened
 * yet. A zero is a real fact — a month recorded as costing nothing — so these
 * cannot be imported as zeros and cannot be told apart from real ones by their
 * value. The boundary is where the block stops saying anything, and everything
 * past it is treated as not yet recorded and reported as such.
 */
function lastRecordedIndex(block: SheetBlock): number {
  let last = -1;
  for (const row of block.rows) {
    if (roleOf(row.label) === "saving") continue;
    row.cells.forEach((cell, index) => {
      if (cell.kind === "amount" && !isZero(cell.amount)) last = Math.max(last, index);
      if (cell.kind === "error") last = Math.max(last, index);
    });
  }
  return last;
}

/** The category name a row becomes. Income is the one row the sheet keeps as a total. */
function categoryNameFor(row: SheetRow, role: RowRole): string {
  return role === "income-total" ? INCOME_CATEGORY_NAME : normaliseCategoryName(row.label);
}

function typeFor(role: RowRole): CategoryType {
  return role === "income-total" || role === "memo" ? "income" : "expense";
}

/**
 * Why a proposal defaults to excluded. Each one is a judgement the household may
 * disagree with, which is why the reason travels with it to the review screen
 * instead of the row simply going missing.
 */
const EXCLUSION_REASONS: Partial<Record<RowRole, string>> = {
  transfer:
    'הגיליון עצמו אינו סופר את השורה הזו בתוך "סה"כ הוצאות" — זו העברה לחיסכון ולא הוצאה, ובמאזן הזה אין העברות.',
  memo: 'השורה יושבת מחוץ ל"סה"כ הכנסות" של הגיליון, כך שייבוא שלה עלול לספור את אותו כסף פעמיים.',
};

const EMPTY_ROW_REASON = "לשורה הזו אין סכום באף חודש בגיליון.";

interface RowSource {
  readonly block: SheetBlock;
  readonly personId: string;
  readonly row: SheetRow;
  readonly role: RowRole;
  readonly name: string;
}

// --- proposing ---------------------------------------------------------------

interface Accumulated {
  readonly key: string;
  readonly personId: string;
  readonly name: string;
  readonly type: CategoryType;
  readonly role: RowRole;
  readonly sheetLabel: string;
  /** Every block the row appeared in, which is what a lifespan is read from. */
  blocks: SheetBlock[];
  /** Keyed by month, with the block it came from, so a conflict can name both. */
  readings: Map<string, { month: CalendarMonth; amount: Money; block: SheetBlock }>;
}

/** A block's own year — the one whose months it is the authority on. */
function primaryYear(block: SheetBlock): number {
  return block.months[0]?.year ?? 0;
}

function blockName(block: SheetBlock): string {
  const first = block.months[0];
  return first === undefined ? block.banner : `${block.banner} (${first.year})`;
}

/**
 * Which of two blocks owns a month they both carry. The tab whose own year is the
 * month's year is the authority on it: Jan–Jun 2025 belongs to the 2025 tab even
 * though the 2024 tab also carries it. Where that does not decide it, the later
 * tab wins, because it was written later.
 */
function ownsMonth(candidate: SheetBlock, incumbent: SheetBlock, month: CalendarMonth): boolean {
  const candidateOwns = primaryYear(candidate) === month.year;
  const incumbentOwns = primaryYear(incumbent) === month.year;
  if (candidateOwns !== incumbentOwns) return candidateOwns;
  return primaryYear(candidate) >= primaryYear(incumbent);
}

function levenshteinWithin(left: string, right: string, limit: number): boolean {
  if (Math.abs(left.length - right.length) > limit) return false;

  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return (previous[right.length] ?? limit + 1) <= limit;
}

function proposedHouseholdName(name: string, role: RowRole): string {
  if (role === "income-total") return INCOME_CATEGORY_NAME;
  const pair = KNOWN_PAIRS.find((candidate) =>
    candidate.names.some((member) => normaliseCategoryName(member) === name),
  );
  return pair?.household ?? name;
}

/**
 * Read the export into proposals.
 *
 * Nothing here writes and nothing here decides: the result is a set of proposals
 * with a reason attached to every omission, for `planWrites` to turn into writes
 * once a person has confirmed them.
 */
export function planSheetImport(sheet: SheetExport, options: ImportOptions): ImportProposal {
  const flags: ImportFlag[] = [];
  const personBySheetName = new Map(options.people.map((person) => [person.sheetName, person.id]));

  const sources: RowSource[] = [];
  const statedTotals: { personId: string; month: CalendarMonth; amount: Money }[] = [];

  const blocks = [...sheet.blocks].sort((left, right) => primaryYear(left) - primaryYear(right));

  for (const block of blocks) {
    const personId = personBySheetName.get(block.owner);
    if (personId === undefined) {
      flags.push(
        block.owner === "משותף"
          ? {
              kind: "derived-block-skipped",
              banner: blockName(block),
              reason:
                "כל מספר משותף נגזר מהקטגוריות האישיות בזמן הקריאה. אין מאזן משותף שנכתב אליו.",
            }
          : { kind: "unknown-owner", banner: blockName(block), owner: block.owner },
      );
      continue;
    }

    const lastIndex = lastRecordedIndex(block);
    const firstUnrecorded = block.months[lastIndex + 1];
    if (firstUnrecorded !== undefined) {
      flags.push({ kind: "unrecorded-tail", banner: blockName(block), from: firstUnrecorded });
    }

    for (const row of block.rows) {
      const role = roleOf(row.label);
      if (role === "saving" || role === "derived") continue;

      // Error and unreadable cells are reported wherever they sit, including on
      // rows that are not imported — a broken formula is worth knowing about.
      row.cells.forEach((cell, index) => {
        const month = block.months[index];
        if (month === undefined || index > lastIndex) return;
        if (cell.kind === "error") {
          flags.push({ kind: "error-cell", owner: block.owner, label: row.label, month, text: cell.text });
        }
        if (cell.kind === "text") {
          flags.push({ kind: "unreadable-cell", owner: block.owner, label: row.label, month, text: cell.text });
        }
      });

      if (role === "expense-total") {
        row.cells.forEach((cell, index) => {
          const month = block.months[index];
          if (month === undefined || index > lastIndex || cell.kind !== "amount") return;
          statedTotals.push({ personId, month, amount: cell.amount });
        });
        continue;
      }

      sources.push({ block, personId, row, role, name: categoryNameFor(row, role) });
    }
  }

  const accumulated = accumulate(sources, flags);
  const categories = toCategories(accumulated, blocks, personBySheetName);
  const entries = toEntries(accumulated);

  flags.push(...similarNameFlags(categories));

  return {
    categories,
    entries,
    totals: checkTotals(statedTotals, categories, entries, options.currency),
    flags,
    span: spanOf(entries),
    currency: options.currency,
  };
}

function accumulate(sources: readonly RowSource[], flags: ImportFlag[]): Map<string, Accumulated> {
  const byKey = new Map<string, Accumulated>();

  for (const source of sources) {
    const key = categoryKey(source.personId, source.name);
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = {
        key,
        personId: source.personId,
        name: source.name,
        type: typeFor(source.role),
        role: source.role,
        sheetLabel: source.row.label,
        blocks: [],
        readings: new Map(),
      };
      byKey.set(key, entry);
    }
    if (!entry.blocks.includes(source.block)) entry.blocks.push(source.block);

    const lastIndex = lastRecordedIndex(source.block);
    source.row.cells.forEach((cell, index) => {
      const month = source.block.months[index];
      if (month === undefined || index > lastIndex || cell.kind !== "amount") return;

      const slot = monthKey(month);
      const existing = entry.readings.get(slot);
      if (existing === undefined) {
        entry.readings.set(slot, { month, amount: cell.amount, block: source.block });
        return;
      }

      // The overlapping months. Agreement collapses to one entry silently;
      // disagreement keeps the owning tab's figure and reports the other.
      const keepNew = ownsMonth(source.block, existing.block, month);
      if (!equals(existing.amount, cell.amount)) {
        flags.push({
          kind: "overlap-conflict",
          categoryKey: key,
          personId: source.personId,
          label: source.name,
          month,
          kept: keepNew ? cell.amount : existing.amount,
          keptFrom: blockName(keepNew ? source.block : existing.block),
          discarded: keepNew ? existing.amount : cell.amount,
          discardedFrom: blockName(keepNew ? existing.block : source.block),
        });
      }
      if (keepNew) {
        entry.readings.set(slot, { month, amount: cell.amount, block: source.block });
      }
    });
  }

  return byKey;
}

function toCategories(
  accumulated: ReadonlyMap<string, Accumulated>,
  blocks: readonly SheetBlock[],
  personBySheetName: ReadonlyMap<string, string>,
): ProposedCategory[] {
  /** The last tab each Person has. A row missing from it is a row they stopped using. */
  const latestBlockByPerson = new Map<string, SheetBlock>();
  for (const block of blocks) {
    const personId = personBySheetName.get(block.owner);
    if (personId === undefined) continue;
    const current = latestBlockByPerson.get(personId);
    if (current === undefined || primaryYear(block) > primaryYear(current)) {
      latestBlockByPerson.set(personId, block);
    }
  }

  return [...accumulated.values()]
    .map((entry) => {
      const appearances = [...entry.blocks].sort((left, right) => primaryYear(left) - primaryYear(right));
      const first = appearances[0];
      const last = appearances[appearances.length - 1];
      if (first === undefined || last === undefined) {
        throw new Error(`Category ${entry.key} was accumulated from no block`);
      }

      const activeFrom = first.months[0];
      const lastMonth = last.months[last.months.length - 1];
      if (activeFrom === undefined || lastMonth === undefined) {
        throw new Error(`Block for ${entry.key} has no months`);
      }

      const latest = latestBlockByPerson.get(entry.personId);
      const stillListed = latest !== undefined && appearances.includes(latest);
      const excludedReason =
        EXCLUSION_REASONS[entry.role] ?? (entry.readings.size === 0 ? EMPTY_ROW_REASON : null);

      return {
        key: entry.key,
        personId: entry.personId,
        name: entry.name,
        type: entry.type,
        activeFrom,
        activeUntil: stillListed ? null : lastMonth,
        sheetLabel: entry.sheetLabel,
        role: entry.role,
        entryCount: entry.readings.size,
        householdName: proposedHouseholdName(entry.name, entry.role),
        included: excludedReason === null,
        excludedReason,
      };
    })
    .sort(
      (left, right) =>
        left.personId.localeCompare(right.personId) || left.name.localeCompare(right.name, "he"),
    );
}

function toEntries(accumulated: ReadonlyMap<string, Accumulated>): ProposedEntry[] {
  const entries: ProposedEntry[] = [];
  for (const category of accumulated.values()) {
    for (const reading of category.readings.values()) {
      entries.push({ categoryKey: category.key, month: reading.month, amount: reading.amount });
    }
  }
  return entries.sort(
    (left, right) =>
      compareMonths(left.month, right.month) || left.categoryKey.localeCompare(right.categoryKey),
  );
}

function similarNameFlags(categories: readonly ProposedCategory[]): ImportFlag[] {
  const flags: ImportFlag[] = [];

  for (let i = 0; i < categories.length; i += 1) {
    for (let j = i + 1; j < categories.length; j += 1) {
      const left = categories[i];
      const right = categories[j];
      if (left === undefined || right === undefined) continue;
      if (left.personId === right.personId) continue;
      if (left.householdName === right.householdName) continue;
      if (left.name.length < 4 || right.name.length < 4) continue;
      if (!levenshteinWithin(left.name, right.name, 1)) continue;

      flags.push({ kind: "similar-names", left: left.name, right: right.name });
    }
  }

  return flags;
}

/**
 * Recompute each month's expenses from the rows that would be written and compare
 * against the figure the sheet states for itself. Only included expense rows
 * count: a row the importer proposes to leave out is left out of both sides, or
 * the check would be measuring the decision instead of the arithmetic.
 */
function checkTotals(
  stated: readonly { personId: string; month: CalendarMonth; amount: Money }[],
  categories: readonly ProposedCategory[],
  entries: readonly ProposedEntry[],
  currency: Currency,
): TotalCheck[] {
  const included = new Map(
    categories
      .filter((category) => category.included && category.type === "expense")
      .map((category) => [category.key, category]),
  );

  const recomputed = new Map<string, Money>();
  for (const entry of entries) {
    const category = included.get(entry.categoryKey);
    if (category === undefined) continue;
    const slot = `${category.personId}@${monthKey(entry.month)}`;
    recomputed.set(slot, add(recomputed.get(slot) ?? zero(currency), entry.amount));
  }

  return stated
    .map((row) => {
      const total = recomputed.get(`${row.personId}@${monthKey(row.month)}`) ?? zero(currency);
      const difference = subtract(total, row.amount);
      return {
        personId: row.personId,
        month: row.month,
        stated: row.amount,
        recomputed: total,
        difference,
        agrees: isZero(difference),
      };
    })
    .sort(
      (left, right) =>
        compareMonths(left.month, right.month) || left.personId.localeCompare(right.personId),
    );
}

function spanOf(entries: readonly ProposedEntry[]): { from: CalendarMonth; to: CalendarMonth } | null {
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) return null;
  return { from: first.month, to: last.month };
}

// --- confirming --------------------------------------------------------------

/**
 * What a person confirmed on the review screen. A category not named here is not
 * written: the default is always to leave the sheet's guess out.
 */
export interface ImportSelection {
  readonly includedKeys: ReadonlySet<string>;
  /** The Household Category each included category joins, by category key. */
  readonly householdNames: ReadonlyMap<string, string>;
  /**
   * How a reported overlap conflict was settled, keyed by `conflictKey`, in minor
   * units. Absent means the importer's own choice stands — the tab whose year owns
   * the month. The 2025 tab's income row is why this is worth offering: it repeats
   * the previous half-year's figures, and only a person can see that.
   */
  readonly conflictChoices?: ReadonlyMap<string, number>;
}

/** Identifies one reported conflict, so a screen can offer both figures back. */
export function conflictKey(categoryKey: string, month: CalendarMonth): string {
  return `${categoryKey}@${monthKey(month)}`;
}

export interface PlannedHousehold {
  readonly key: string;
  readonly name: string;
  readonly type: CategoryType;
}

export interface PlannedCategory {
  readonly key: string;
  readonly householdKey: string;
  readonly personId: string;
  readonly name: string;
  readonly type: CategoryType;
  readonly activeFrom: CalendarMonth;
  readonly activeUntil: CalendarMonth | null;
}

export interface PlannedEntry {
  readonly categoryKey: string;
  readonly month: CalendarMonth;
  readonly amount: Money;
}

/**
 * The writes. Keys are the domain's own; real ids are the database's business.
 *
 * Every planned category carries a household key, so the rule that no Personal
 * Category is ever unassigned holds in the import path exactly as it does when a
 * category is created by hand.
 */
export interface ImportPlan {
  readonly households: readonly PlannedHousehold[];
  readonly categories: readonly PlannedCategory[];
  readonly entries: readonly PlannedEntry[];
}

/** What the review screen starts from: the importer's own proposal. */
export function defaultSelection(proposal: ImportProposal): ImportSelection {
  return {
    includedKeys: new Set(
      proposal.categories.filter((category) => category.included).map((category) => category.key),
    ),
    householdNames: new Map(
      proposal.categories.map((category) => [category.key, category.householdName]),
    ),
  };
}

function householdKeyOf(name: string, type: CategoryType): string {
  return `${type}:${normaliseCategoryName(name).toLocaleLowerCase()}`;
}

/**
 * Turn confirmed proposals into writes. Categories the reviewer left out take
 * their entries with them, so a row that is not imported cannot leave amounts
 * behind pointing at nothing.
 */
export function planWrites(proposal: ImportProposal, selection: ImportSelection): ImportPlan {
  const categories = proposal.categories.filter((category) => selection.includedKeys.has(category.key));

  const households = new Map<string, PlannedHousehold>();
  const planned = categories.map((category) => {
    const requested = selection.householdNames.get(category.key) ?? category.householdName;
    const name = normaliseCategoryName(requested).length === 0 ? category.name : requested;
    const key = householdKeyOf(name, category.type);

    if (!households.has(key)) {
      households.set(key, { key, name: normaliseCategoryName(name), type: category.type });
    }

    return {
      key: category.key,
      householdKey: key,
      personId: category.personId,
      name: category.name,
      type: category.type,
      activeFrom: category.activeFrom,
      activeUntil: category.activeUntil,
    };
  });

  const kept = new Set(planned.map((category) => category.key));
  const choices = selection.conflictChoices ?? new Map<string, number>();

  return {
    households: [...households.values()],
    categories: planned,
    entries: proposal.entries
      .filter((entry) => kept.has(entry.categoryKey))
      .map((entry) => {
        const chosen = choices.get(conflictKey(entry.categoryKey, entry.month));
        return chosen === undefined
          ? entry
          : { ...entry, amount: money(chosen, entry.amount.currency) };
      }),
  };
}

/** How many months the plan covers, for the review screen to state before writing. */
export function planSummary(plan: ImportPlan): {
  readonly months: number;
  readonly from: CalendarMonth | null;
  readonly to: CalendarMonth | null;
} {
  const months = [...new Map(plan.entries.map((entry) => [monthKey(entry.month), entry.month])).values()].sort(
    compareMonths,
  );
  const from = months[0] ?? null;
  const to = months[months.length - 1] ?? null;
  return { months: months.length, from, to };
}

/** Every month in the plan, ascending — what the review screen lists. */
export function plannedMonths(plan: ImportPlan): CalendarMonth[] {
  return [...new Map(plan.entries.map((entry) => [monthKey(entry.month), entry.month])).values()].sort(
    compareMonths,
  );
}

/** Convenience for the review screen: the totals that did not agree. */
export function disagreements(proposal: ImportProposal): TotalCheck[] {
  return proposal.totals.filter((total) => !total.agrees);
}

/** The sum of a plan's entries for one month, for a person or for the household. */
export function plannedMonthTotal(
  plan: ImportPlan,
  month: CalendarMonth,
  type: CategoryType,
  currency: Currency,
): Money {
  const keys = new Set(
    plan.categories.filter((category) => category.type === type).map((category) => category.key),
  );
  return sum(
    plan.entries
      .filter((entry) => keys.has(entry.categoryKey) && monthsEqual(entry.month, month))
      .map((entry) => entry.amount),
    currency,
  );
}
