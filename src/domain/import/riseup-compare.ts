/**
 * Lining a folded RiseUp month up against what the מאזן already holds.
 *
 * The fold says what RiseUp read; this says what would change. One line per
 * Personal Category, both figures and the difference — which is the side-by-side
 * ADR 0006 makes the precondition of every write: "nothing is written without a
 * person approving it, line by line, against a side-by-side with what the
 * database already holds".
 *
 * Framework-free per ADR 0004: the Entries go in as plain data. Reading them is
 * `scripts/riseup-fill.ts`'s job, and nothing here knows that a database exists.
 *
 * The rules it carries:
 *
 * - **A row Jubot holds and RiseUp says nothing about is *left alone*.** Not a
 *   proposed zero and not a difference. Each Person's grid holds rows the other
 *   one actually pays — Yuval's שכ"ד, Eden's Tello/Skype — and the sheet typed a
 *   literal 0 into three of his, which RiseUp cannot tell from a blank. None of
 *   them is this feature's business.
 * - **A row RiseUp has and Jubot never recorded is *new*.** That is the ordinary
 *   case of a month arriving.
 * - **Both blank is nothing at all**, and says so rather than proposing a zero
 *   (ADR 0001's distinction, which nothing here is allowed to blur).
 * - **A figure RiseUp holds for a Personal Category the database does not have
 *   blocks.** The monthly run never creates a category — that is `--map`'s job
 *   and a person's answer — so a fold total with nowhere to land is named, not
 *   invented.
 * - **RiseUp is the authority from 2026-10 inclusive** (ADR 0006). Earlier months
 *   belong to the sheet importer, and this comparison refuses them: two producers
 *   writing one category-month is the thing that must not happen. Folding an
 *   earlier month and printing its totals is still allowed — it is how the months
 *   the household had already copied by hand were used to prove the rules.
 */

import { type Money, equals, subtract } from "@/domain/money/money";
import { type CalendarMonth, compareMonths, monthKey } from "@/domain/time/calendar-month";

/**
 * The cutover of ADR 0006. RiseUp owns this month and everything after it; the
 * sheet importer owns everything before.
 */
export const RISEUP_AUTHORITY_FROM: CalendarMonth = { year: 2026, month: 10 };

export class RiseUpCutoverError extends Error {
  readonly month: CalendarMonth;

  constructor(month: CalendarMonth) {
    super(
      `${monthKey(month)} is before ${monthKey(RISEUP_AUTHORITY_FROM)}, the month RiseUp becomes ` +
        `the authority for the מאזן's totals (ADR 0006). Everything earlier was recorded from ` +
        `the sheet and is correct, and the sheet importer is the only thing that writes it — so ` +
        `nothing here reads the database for such a month and nothing here will write one. ` +
        `Folding it and printing its totals is allowed and is what just happened above.`,
    );
    this.name = "RiseUpCutoverError";
    this.month = month;
  }
}

/** True when RiseUp is the authority for this month. */
export function isRiseUpAuthority(month: CalendarMonth): boolean {
  return compareMonths(month, RISEUP_AUTHORITY_FROM) >= 0;
}

/** Stops a comparison dead for a month the sheet importer owns. */
export function assertRiseUpAuthority(month: CalendarMonth): void {
  if (!isRiseUpAuthority(month)) throw new RiseUpCutoverError(month);
}

// --- what goes in ------------------------------------------------------------

/**
 * One of that Person's Personal Categories as the database has it. `amount` is
 * what `entries` holds for the month being compared — `null` for a month not
 * recorded, which is not a zero.
 */
export interface HeldCategory {
  readonly personalCategory: string;
  readonly type: "income" | "expense";
  readonly amount: Money | null;
  /** Retired categories still resolve for history, and are flagged rather than hidden. */
  readonly retired?: boolean;
}

/** The part of a fold this comparison reads. `RiseUpFold["totals"]` satisfies it. */
export interface FoldedAmount {
  readonly personalCategory: string;
  readonly type: "income" | "expense";
  readonly amount: Money | null;
  readonly handTyped?: boolean;
}

// --- what comes out ----------------------------------------------------------

export type ComparisonState =
  /** Both figures present and identical. Nothing to approve. */
  | "same"
  /** Both present and apart. This is the line a person approves or declines. */
  | "differs"
  /** RiseUp has it, Jubot never recorded it. */
  | "new"
  /** Jubot holds it, RiseUp said nothing. Never a proposed zero. */
  | "left-alone"
  /** Neither has it. Still a row, still not a zero. */
  | "blank"
  /** RiseUp has a figure for a Personal Category the database does not hold. */
  | "no-such-category";

export interface ComparisonRow {
  readonly personalCategory: string;
  readonly type: "income" | "expense";
  readonly state: ComparisonState;
  /** What the מאזן holds for this month. `null` is *not recorded*. */
  readonly jubot: Money | null;
  /** What this run read out of RiseUp. `null` is *no RiseUp line fed it*. */
  readonly riseUp: Money | null;
  /** `riseUp − jubot`, only where both are present. */
  readonly difference: Money | null;
  /** The mapping file says this row has no RiseUp source at all. */
  readonly handTyped: boolean;
  readonly retired: boolean;
}

export interface RiseUpComparison {
  readonly month: CalendarMonth;
  readonly rows: readonly ComparisonRow[];
  /** `differs` and `new` together: the lines a write would touch, in print order. */
  readonly changes: readonly ComparisonRow[];
  /** A figure with no Personal Category to land in. Blocks, and is never created here. */
  readonly blocked: readonly ComparisonRow[];
  readonly counts: Readonly<Record<ComparisonState, number>>;
  /** Nothing to approve: no `differs`, no `new`, nothing blocked. */
  readonly identical: boolean;
}

// --- the comparison ----------------------------------------------------------

const KEY = (category: string, type: "income" | "expense") => `${type}:${category}`;

/**
 * Print order: income first, then expenses, each by the state that wants reading
 * — what would change, then what blocks, then what is already right, then what is
 * being left alone, then the blanks.
 */
const STATE_ORDER: readonly ComparisonState[] = [
  "differs",
  "new",
  "no-such-category",
  "same",
  "left-alone",
  "blank",
];

function classify(
  jubot: Money | null,
  riseUp: Money | null,
  knownToDatabase: boolean,
): ComparisonState {
  if (riseUp !== null && !knownToDatabase) return "no-such-category";
  if (riseUp === null && jubot === null) return "blank";
  if (riseUp === null) return "left-alone";
  if (jubot === null) return "new";
  return equals(jubot, riseUp) ? "same" : "differs";
}

/**
 * One line per Personal Category, over the union of what the fold produced and
 * what the database holds for that Person.
 *
 * `held` is every Personal Category of that Person — not only the ones with an
 * Entry this month — because "does this category exist at all" is what separates
 * *new* from a figure with nowhere to go.
 */
export function compareWithLedger(
  totals: readonly FoldedAmount[],
  held: readonly HeldCategory[],
  month: CalendarMonth,
): RiseUpComparison {
  assertRiseUpAuthority(month);

  const byKey = new Map<string, HeldCategory>();
  for (const category of held) byKey.set(KEY(category.personalCategory, category.type), category);

  const folded = new Map<string, FoldedAmount>();
  for (const total of totals) folded.set(KEY(total.personalCategory, total.type), total);

  const keys = [...new Set([...byKey.keys(), ...folded.keys()])];

  const rows: ComparisonRow[] = keys.map((key) => {
    const fold = folded.get(key);
    const stored = byKey.get(key);
    const riseUp = fold?.amount ?? null;
    const jubot = stored?.amount ?? null;
    const state = classify(jubot, riseUp, stored !== undefined);
    return {
      personalCategory: (fold ?? stored)?.personalCategory ?? key,
      type: (fold ?? stored)?.type ?? "expense",
      state,
      jubot,
      riseUp,
      difference: state === "differs" ? subtract(riseUp as Money, jubot as Money) : null,
      handTyped: fold?.handTyped === true,
      retired: stored?.retired === true,
    };
  });

  rows.sort((left, right) => {
    if (left.type !== right.type) return left.type === "income" ? -1 : 1;
    const byState = STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state);
    if (byState !== 0) return byState;
    return left.personalCategory.localeCompare(right.personalCategory, "he");
  });

  const counts = Object.fromEntries(
    STATE_ORDER.map((state) => [state, rows.filter((row) => row.state === state).length]),
  ) as Record<ComparisonState, number>;

  const changes = rows.filter((row) => row.state === "differs" || row.state === "new");
  const blocked = rows.filter((row) => row.state === "no-such-category");

  return {
    month,
    rows,
    changes,
    blocked,
    counts,
    identical: changes.length === 0 && blocked.length === 0,
  };
}
