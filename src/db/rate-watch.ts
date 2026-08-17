import {
  type AnnualItem,
  type AnnualItemCreation,
  type AnnualItems,
  type Renewal,
  type RenewalCorrection,
  type RenewalRecording,
  type RenewalRemoval,
  buildAnnualItems,
} from "@/domain/ledger/annual-items";
import { type Currency, isCurrency, money } from "@/domain/money/money";
import { dateKey, parseDateKey } from "@/domain/time/calendar-date";

import { type TransactionQuery, query, withTransaction } from "./client";

/**
 * Reading and writing פריטים שנתיים and their חידושים. The domain decides what a
 * valid one is (src/domain/ledger/annual-items); this stores it.
 *
 * **Nothing here touches `entries`, and nothing here can.** These two tables hold
 * a breakdown of money the מאזן already counts — the car insurance shekel is
 * already typed into a Personal Category — so a write on this side moves no figure
 * on the grid above the panel. `rate-watch-writes-no-ledger.test.ts` is the guard.
 *
 * Dates are read as `YYYY-MM-DD` text rather than as a `Date`, the same way the
 * category lifespans are: a timestamp crossing a timezone is one of the few ways
 * "the renewal of the 1st" quietly becomes the renewal of the day before — and
 * here the day decides which *year* the figure belongs to.
 */

interface ItemRow extends Record<string, unknown> {
  id: string;
  name: string;
  started_on: string;
  ended_on: string | null;
}

interface RenewalRow extends Record<string, unknown> {
  item_id: string;
  renewed_on: string;
  amount_minor: string;
  currency: string;
}

export class MalformedRateWatchRowError extends Error {
  constructor(id: string, detail: string) {
    super(`Rate watch row ${id} is malformed: ${detail}`);
    this.name = "MalformedRateWatchRowError";
  }
}

function toItem(row: ItemRow): AnnualItem {
  return {
    id: row.id,
    name: row.name,
    startedOn: parseDateKey(row.started_on),
    endedOn: row.ended_on === null ? null : parseDateKey(row.ended_on),
  };
}

function currencyOf(id: string, value: string): Currency {
  if (!isCurrency(value)) {
    throw new MalformedRateWatchRowError(id, `unknown currency ${value}`);
  }
  return value;
}

function toRenewal(row: RenewalRow): Renewal {
  const id = `${row.item_id}@${row.renewed_on}`;
  const minorUnits = Number(row.amount_minor);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new MalformedRateWatchRowError(id, `amount_minor ${row.amount_minor} is not an integer`);
  }
  return {
    itemId: row.item_id,
    renewedOn: parseDateKey(row.renewed_on),
    amount: money(minorUnits, currencyOf(id, row.currency)),
  };
}

/**
 * The whole set. A household holds a handful of these, so there is nothing to
 * page and no partial view to keep consistent — and the panel compares years,
 * which one year's rows cannot answer.
 */
export async function loadAnnualItems(): Promise<AnnualItems> {
  const [items, renewals] = await Promise.all([
    query<ItemRow>(
      `select id, name,
              to_char(started_on, 'YYYY-MM-DD') as started_on,
              to_char(ended_on, 'YYYY-MM-DD')   as ended_on
         from rate_watch_items`,
    ),
    query<RenewalRow>(
      `select item_id, to_char(renewed_on, 'YYYY-MM-DD') as renewed_on, amount_minor, currency
         from rate_watch_renewals`,
    ),
  ]);

  return buildAnnualItems({ items: items.map(toItem), renewals: renewals.map(toRenewal) });
}

/**
 * Write a creation. Both rows in one transaction: an item exists to hold prices,
 * and one landing without its first Renewal would be an item whose `started_on`
 * rests on a figure nobody stored.
 */
export async function insertAnnualItem(creation: AnnualItemCreation): Promise<void> {
  await withTransaction(async (run) => {
    await run(
      `insert into rate_watch_items (id, name, started_on, ended_on)
       values ($1, $2, $3::date, null)`,
      [creation.item.id, creation.item.name, dateKey(creation.item.startedOn)],
    );
    await writeRenewal(run, creation.renewal);
  });
}

/**
 * Record a price. The item's start moves back with it when the price predates the
 * life it was given, so backfilling last year's quote is one operation and never
 * leaves the item claiming to have begun after its own earliest figure.
 */
export async function insertRenewal(recording: RenewalRecording): Promise<void> {
  await withTransaction(async (run) => {
    await moveStart(run, recording.renewal.itemId, recording.startedOn);
    await writeRenewal(run, recording.renewal);
  });
}

/**
 * Correct a price. `renewed_on` is half the primary key, so moving the date moves
 * the row — and with it the year the figure belongs to, which is the whole reason
 * a correction has to be able to change it.
 */
export async function updateRenewal(correction: RenewalCorrection): Promise<void> {
  await withTransaction(async (run) => {
    await moveStart(run, correction.itemId, correction.startedOn);
    await run(
      `update rate_watch_renewals
          set renewed_on = $3::date, amount_minor = $4, currency = $5
        where item_id = $1 and renewed_on = $2::date`,
      [
        correction.itemId,
        dateKey(correction.from),
        dateKey(correction.renewal.renewedOn),
        correction.renewal.amount.minorUnits,
        correction.renewal.amount.currency,
      ],
    );
  });
}

/**
 * Remove one price. The Annual Item itself is never deleted — retirement is a
 * lifespan — so this reaches exactly one renewal row.
 */
export async function deleteRenewal(removal: RenewalRemoval): Promise<void> {
  await query(`delete from rate_watch_renewals where item_id = $1 and renewed_on = $2::date`, [
    removal.itemId,
    dateKey(removal.renewedOn),
  ]);
}

async function writeRenewal(run: TransactionQuery, renewal: Renewal): Promise<void> {
  await run(
    `insert into rate_watch_renewals (item_id, renewed_on, amount_minor, currency)
     values ($1, $2::date, $3, $4)`,
    [renewal.itemId, dateKey(renewal.renewedOn), renewal.amount.minorUnits, renewal.amount.currency],
  );
}

/** Only where the domain said the life has to move. `null` is the ordinary case. */
async function moveStart(
  run: TransactionQuery,
  itemId: string,
  startedOn: RenewalRecording["startedOn"],
): Promise<void> {
  if (startedOn === null) return;
  await run(`update rate_watch_items set started_on = $2::date where id = $1`, [
    itemId,
    dateKey(startedOn),
  ]);
}
