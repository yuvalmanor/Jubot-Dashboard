import { type EnteredEntry, type Ledger, buildLedger } from "@/domain/ledger/ledger";
import { type Money, isCurrency, money } from "@/domain/money/money";
import { type CalendarMonth } from "@/domain/time/calendar-month";

import { query, withTransaction } from "./client";

/**
 * Reading and writing Entries.
 *
 * `entries` is the *entered* producer of ADR 0001. There is no transactions table
 * yet; when there is, it is read here alongside `entries` and handed to
 * `buildLedger`, which is what decides that a category-month has one source. No
 * caller of `readAmount` changes.
 */

interface EntryRow extends Record<string, unknown> {
  personal_category_id: string;
  year: number;
  month: number;
  amount_minor: string;
  currency: string;
}

export class MalformedEntryRowError extends Error {
  constructor(detail: string) {
    super(`Entry row is malformed: ${detail}`);
    this.name = "MalformedEntryRowError";
  }
}

function toEnteredEntry(row: EntryRow): EnteredEntry {
  const minorUnits = Number(row.amount_minor);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new MalformedEntryRowError(`amount_minor ${row.amount_minor} is not an integer`);
  }
  if (!isCurrency(row.currency)) {
    throw new MalformedEntryRowError(`unknown currency ${row.currency}`);
  }
  return {
    personalCategoryId: row.personal_category_id,
    month: { year: Number(row.year), month: Number(row.month) },
    amount: money(minorUnits, row.currency),
  };
}

const SELECT_ENTRIES = `select personal_category_id, year, month, amount_minor, currency from entries`;

/** One month. What the entry screen needs. */
export async function loadLedgerForMonth(month: CalendarMonth): Promise<Ledger> {
  const rows = await query<EntryRow>(`${SELECT_ENTRIES} where year = $1 and month = $2`, [
    month.year,
    month.month,
  ]);
  return buildLedger({ entered: rows.map(toEnteredEntry) });
}

/** Every month ever recorded, as one continuous ledger. */
export async function loadLedger(): Promise<Ledger> {
  const rows = await query<EntryRow>(SELECT_ENTRIES);
  return buildLedger({ entered: rows.map(toEnteredEntry) });
}

/**
 * What one save of one month writes. A category with `amount: null` is being
 * cleared back to *not recorded*, which is not the same as being set to zero —
 * so it deletes the row rather than storing 0.
 */
export interface EntryWrite {
  readonly personalCategoryId: string;
  readonly amount: Money | null;
}

export async function saveMonthEntries(
  month: CalendarMonth,
  writes: readonly EntryWrite[],
): Promise<void> {
  if (writes.length === 0) return;

  await withTransaction(async (run) => {
    for (const write of writes) {
      if (write.amount === null) {
        await run(
          `delete from entries
            where personal_category_id = $1 and year = $2 and month = $3`,
          [write.personalCategoryId, month.year, month.month],
        );
        continue;
      }

      // Correcting a past month is the same operation as recording a new one.
      await run(
        `insert into entries (personal_category_id, year, month, amount_minor, currency)
         values ($1, $2, $3, $4, $5)
         on conflict (personal_category_id, year, month) do update
           set amount_minor = excluded.amount_minor,
               currency     = excluded.currency,
               updated_at   = now()`,
        [
          write.personalCategoryId,
          month.year,
          month.month,
          write.amount.minorUnits,
          write.amount.currency,
        ],
      );
    }
  });
}
