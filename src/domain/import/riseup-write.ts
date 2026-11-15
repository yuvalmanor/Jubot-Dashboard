/**
 * Turning an approved side-by-side into the Entries a write would make.
 *
 * The comparison says what would change; this says what is *allowed* to change,
 * and refuses rather than narrowing when anything is off. Framework-free per
 * ADR 0004: the comparison and the Personal Category ids go in as plain data,
 * the writes come out as plain data, and nothing here knows a database exists —
 * `scripts/riseup-fill.ts` hands the result to `saveMonthEntries`, which is the
 * only way into `entries` (ADR 0006).
 *
 * The rules it carries, every one of them from the plan's header:
 *
 * - **Nothing is written without approval**, and the approval is of *these
 *   lines*. A run prints a token over the figures it is offering; a write happens
 *   only when that same token comes back. RiseUp keeps revising a month, so an
 *   approval of 1,846 must not write 1,912 half an hour later — the token moves
 *   with the figures and a stale one refuses.
 * - **A line the household declines is not written**, and is reported as skipped
 *   rather than dropped silently.
 * - **Anything unresolved stops the whole write**, not just the line it touches.
 *   An unmapped row is money RiseUp holds that reached no Personal Category, so
 *   the table drawn over it is incomplete by an amount nobody has placed, and a
 *   row reading *left alone* beside it may be left alone only because its RiseUp
 *   line has no rule yet. `comparison.approvable` carries both that count and
 *   the figures with nowhere to land.
 * - **Only a changed or new line is ever written.** *Left alone* and *blank* rows
 *   are not offered at all, which is how a blank stays a blank: no `amount: null`
 *   is ever produced, so nothing here can clear an Entry, and a category RiseUp
 *   was silent about is untouched — `monthClosure` reads the month exactly as it
 *   did before the run.
 * - **Whole shekels only.** The fold rounds each RiseUp line to the shekel; an
 *   amount carrying agorot means something upstream stopped rounding, and that is
 *   a refusal rather than a figure to write.
 * - **The monthly run never creates a Personal Category.** A line whose category
 *   the database does not hold refuses; `--map` proposes one and a person answers.
 * - **RiseUp is the authority from 2026-10** (ADR 0006). An earlier month is
 *   refused here as well as at the comparison, so no flag combination reaches a
 *   write.
 */

import { type RiseUpComparison } from "@/domain/import/riseup-compare";
import { RISEUP_AUTHORITY_FROM, isRiseUpAuthority } from "@/domain/import/riseup-cutover";
import { type Money, toDecimalString } from "@/domain/money/money";
import { type CalendarMonth, monthKey } from "@/domain/time/calendar-month";

/** One line a run is offering, numbered as the report prints it. */
export interface OfferedLine {
  /** 1-based, and what `--decline` names. A number survives a shell; `חו"ל` does not. */
  readonly index: number;
  readonly personalCategory: string;
  readonly type: "income" | "expense";
  /** What the מאזן holds. `null` is *not recorded* — this line is new. */
  readonly jubot: Money | null;
  /** What RiseUp says. Never `null`: only a changed or new line is offered. */
  readonly riseUp: Money;
  readonly difference: Money | null;
}

/** One Entry a write would make. */
export interface PlannedEntryWrite {
  readonly personalCategoryId: string;
  readonly personalCategory: string;
  readonly type: "income" | "expense";
  /** Never `null`. A null would delete an Entry, and nothing here clears one. */
  readonly amount: Money;
}

export interface RiseUpWriteRequest {
  /** The token the household passed back, if they passed one. */
  readonly approve?: string;
  /** The numbers of the lines they declined. */
  readonly declined?: readonly number[];
  /** Personal Category id by `CATEGORY_KEY`, as the database holds them. */
  readonly ids: ReadonlyMap<string, string>;
}

export interface RiseUpWritePlan {
  readonly month: CalendarMonth;
  /** The token that approves exactly the lines below. */
  readonly token: string;
  readonly offered: readonly OfferedLine[];
  readonly approved: readonly PlannedEntryWrite[];
  readonly declined: readonly OfferedLine[];
  /**
   * Every reason the write is refused. Non-empty means **nothing is written** —
   * not even the lines that are clear.
   */
  readonly refusals: readonly string[];
  /** True when a write may proceed. It may still have nothing to write. */
  readonly writable: boolean;
  /**
   * The one refusal a run is *supposed* to end on: these lines are fit to write
   * and nobody has confirmed them yet. True only when that is the sole reason —
   * so a report that prints the approval command cannot print it over an
   * unmapped row.
   */
  readonly awaitingApproval: boolean;
}

/** How a Personal Category is keyed where a name alone would not be unique. */
export function categoryKey(personalCategory: string, type: "income" | "expense"): string {
  return `${type}:${personalCategory}`;
}

// --- the token ---------------------------------------------------------------

/**
 * A short digest of the lines being offered, so that an approval is an approval
 * of *those figures*.
 *
 * Not a cryptographic hash and not trying to be: nobody is forging a token, and
 * what it has to catch is a month that moved between the run that printed it and
 * the run that writes. Two 32-bit FNV-1a lanes with different seeds, printed as
 * twelve characters — far more than enough to notice a changed shekel, and it
 * keeps this module free of `node:crypto` and of every other import (ADR 0004).
 */
function digest(text: string): string {
  const PRIME = 0x01000193;
  let a = 0x811c9dc5;
  let b = 0x7f4a7c15;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, PRIME) >>> 0;
    b = Math.imul(b ^ (code + index), PRIME) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`.slice(0, 12);
}

/**
 * A token over any list of statements, so that an approval is an approval of
 * *those* statements. Exported because `--map` approves a proposal the same way
 * a write approves figures (Phase 34) and one implementation of this is enough.
 */
export function digestLines(parts: readonly string[]): string {
  return digest(parts.join("|"));
}

/**
 * The approval token for one month of one Person. It covers the Person, the
 * month and every offered line's category, type and both figures — so a figure
 * RiseUp revised, a line that appeared, and a line that went away all change it.
 */
export function approvalToken(person: string, comparison: RiseUpComparison): string {
  const lines = offeredLines(comparison).map(
    (line) =>
      `${line.type}:${line.personalCategory}=${toDecimalString(line.riseUp)}` +
      `<${line.jubot === null ? "" : toDecimalString(line.jubot)}`,
  );
  return digestLines([person, monthKey(comparison.month), ...lines]);
}

// --- the plan ----------------------------------------------------------------

/**
 * The lines a run offers: the comparison's own `differs` and `new` rows, in the
 * order the report prints them, numbered from 1.
 *
 * A *left alone* or *blank* row is not here, which is the whole of "no blank is
 * ever written as a zero": there is no path from such a row to a write.
 */
export function offeredLines(comparison: RiseUpComparison): OfferedLine[] {
  return comparison.changes.flatMap((row, position) =>
    // `differs` and `new` both carry a RiseUp figure; the guard is here so that
    // the type below is earned rather than asserted.
    row.riseUp === null
      ? []
      : [
          {
            index: position + 1,
            personalCategory: row.personalCategory,
            type: row.type,
            jubot: row.jubot,
            riseUp: row.riseUp,
            difference: row.difference,
          },
        ],
  );
}

/**
 * What this run may write, and every reason it may not.
 *
 * Refusals are collected rather than thrown one at a time, so that a run states
 * everything wrong with it in one pass — and so that a caller cannot write half
 * a month by handling one of them.
 */
export function planRiseUpWrite(
  person: string,
  comparison: RiseUpComparison,
  request: RiseUpWriteRequest,
): RiseUpWritePlan {
  const token = approvalToken(person, comparison);
  const offered = offeredLines(comparison);
  const refusals: string[] = [];

  // The cutover, again. The comparison already refused an earlier month, so this
  // is unreachable through the script — which is the point: "no month before
  // 2026-10 can be written, by any flag combination" is a property of the write,
  // not of the route to it.
  if (!isRiseUpAuthority(comparison.month)) {
    refusals.push(
      `${monthKey(comparison.month)} is before ${monthKey(RISEUP_AUTHORITY_FROM)}: the sheet ` +
        `importer owns it and nothing here writes it (ADR 0006).`,
    );
  }

  if (!comparison.approvable) {
    const parts = [
      comparison.unresolved > 0
        ? `${comparison.unresolved} unresolved ${comparison.unresolved === 1 ? "row" : "rows"}`
        : null,
      comparison.blocked.length > 0
        ? `${comparison.blocked.length} ${comparison.blocked.length === 1 ? "figure" : "figures"} with no Personal Category to land in`
        : null,
    ].filter((part) => part !== null);
    refusals.push(
      `${parts.join(" and ")} — so nothing is written at all, not even the lines that are ` +
        `clear. Money RiseUp holds that reached no Personal Category is money this month is ` +
        `short by, and a part-written month would look complete.`,
    );
  }

  const declinedNumbers = new Set(request.declined ?? []);
  const unknown = [...declinedNumbers].filter(
    (number) => !offered.some((line) => line.index === number),
  );
  if (unknown.length > 0) {
    refusals.push(
      `${unknown.join(", ")} ${unknown.length === 1 ? "is not a line" : "are not lines"} this ` +
        `run offered${offered.length === 0 ? " (it offered none)" : ` (1–${offered.length})`}, ` +
        `so the declines do not line up with the table and nothing is written.`,
    );
  }

  const declined = offered.filter((line) => declinedNumbers.has(line.index));
  const accepted = offered.filter((line) => !declinedNumbers.has(line.index));

  /** True while the missing confirmation is the only thing in the way. */
  let awaitingApproval = false;

  // A month with no line to offer needs no approval and is not refused: it has
  // nothing to write, which is a different fact from being stopped. This is the
  // ordinary second run of a month — the one that must write nothing and say so
  // — and a token from the run before it is beside the point here, so it is not
  // reported as a mismatch.
  if (offered.length === 0) {
    // Nothing to add.
  } else if (request.approve === undefined) {
    awaitingApproval = refusals.length === 0;
    refusals.push(
      `The ${offered.length === 1 ? "line above was" : "lines above were"} not confirmed. A write ` +
        `takes the token this run printed: --write --approve ${token}`,
    );
  } else if (request.approve !== token) {
    refusals.push(
      `\`${request.approve}\` approves different figures from the ones above, whose token is ` +
        `\`${token}\`. RiseUp keeps revising a month, so an approval is an approval of the ` +
        `lines it was printed with — read this run's table and approve it, rather than ` +
        `carrying a token across runs.`,
    );
  }

  const approved: PlannedEntryWrite[] = [];
  for (const line of accepted) {
    if (line.riseUp.minorUnits % 100 !== 0) {
      refusals.push(
        `${line.personalCategory} reads ${toDecimalString(line.riseUp)}, which is not a whole ` +
          `number of shekels. Every RiseUp line is rounded to the shekel before it is added, ` +
          `so agorot here mean the rounding stopped happening somewhere above.`,
      );
      continue;
    }
    const id = request.ids.get(categoryKey(line.personalCategory, line.type));
    if (id === undefined) {
      refusals.push(
        `${person} has no Personal Category \`${line.personalCategory}\` ` +
          `(${line.type === "income" ? "הכנסה" : "הוצאה"}), so ${toDecimalString(line.riseUp)} ` +
          `has nowhere to land. The monthly run never creates one — \`--map\` proposes it and ` +
          `a person answers.`,
      );
      continue;
    }
    approved.push({
      personalCategoryId: id,
      personalCategory: line.personalCategory,
      type: line.type,
      amount: line.riseUp,
    });
  }

  return {
    month: comparison.month,
    token,
    offered,
    approved: refusals.length === 0 ? approved : [],
    declined,
    refusals,
    writable: refusals.length === 0,
    // Only when the missing confirmation is the whole of what is in the way: a
    // second refusal below it means these lines are not fit to write yet.
    awaitingApproval: awaitingApproval && refusals.length === 1,
  };
}
