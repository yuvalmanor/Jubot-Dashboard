import { type ExchangeRate, exchangeRate, isCurrency, money } from "@/domain/money/money";
import { type SharePrice, sharePrice } from "@/domain/rsu/rsu-position";
import {
  type Snapshot,
  type SnapshotLine,
  buildSnapshot,
} from "@/domain/snapshot/snapshot";
import { type CalendarDate, dateKey, parseDateKey } from "@/domain/time/calendar-date";

import { query, withTransaction } from "./client";

/**
 * Reading and writing Snapshots.
 *
 * A snapshot is complete by construction, so it is never written a row at a time
 * from outside: `insertSnapshot` writes the whole thing — the date, its rates and
 * one line per open account — in one transaction, and `saveSnapshotLines` only
 * ever restates lines that already exist.
 *
 * Dates are read as `YYYY-MM-DD` text for the same reason the מאזן reads months
 * as `YYYY-MM`: a timestamp crossing a timezone is how a snapshot's date changes
 * by a day without anyone touching it.
 */

interface SnapshotRow extends Record<string, unknown> {
  id: string;
  taken_on: string;
  note: string | null;
  rsu_price_ten_thousandths: string | null;
  rsu_price_currency: string | null;
}

interface RateRow extends Record<string, unknown> {
  snapshot_id: string;
  base: string;
  quote: string;
  rate: string;
}

interface LineRow extends Record<string, unknown> {
  snapshot_id: string;
  account_id: string;
  amount_minor: string;
  currency: string;
  source: string;
  measured_on: string | null;
}

export class MalformedSnapshotRowError extends Error {
  constructor(id: string, detail: string) {
    super(`Snapshot row ${id} is malformed: ${detail}`);
    this.name = "MalformedSnapshotRowError";
  }
}

/** The header alone — the list screen needs no lines to show a date. */
export interface SnapshotHeader {
  readonly id: string;
  readonly takenOn: CalendarDate;
  readonly note: string | null;
  /**
   * The share price this reading was taken at, or `null` where nobody stated one.
   * It sits beside the domain `Snapshot` rather than inside it because a Snapshot
   * is about Accounts and this is a fact about an instrument — but it is stored on
   * the snapshot row, and read from it, for the same reason the exchange rate is:
   * the figure it derives must keep reading as it read on the day.
   */
  readonly rsuPrice: SharePrice | null;
}

function toRate(row: RateRow): ExchangeRate {
  if (!isCurrency(row.base) || !isCurrency(row.quote)) {
    throw new MalformedSnapshotRowError(row.snapshot_id, `unknown currency pair ${row.base}/${row.quote}`);
  }
  return exchangeRate(row.base, row.quote, Number(row.rate));
}

function toLine(row: LineRow): SnapshotLine {
  const minorUnits = Number(row.amount_minor);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new MalformedSnapshotRowError(row.snapshot_id, `amount_minor ${row.amount_minor} is not an integer`);
  }
  if (!isCurrency(row.currency)) {
    throw new MalformedSnapshotRowError(row.snapshot_id, `unknown currency ${row.currency}`);
  }
  if (row.source !== "entered" && row.source !== "carried") {
    throw new MalformedSnapshotRowError(row.snapshot_id, `unknown line source ${row.source}`);
  }

  return {
    accountId: row.account_id,
    balance: money(minorUnits, row.currency),
    source: row.source,
    measuredOn: row.measured_on === null ? null : parseDateKey(row.measured_on),
  };
}

const SELECT_SNAPSHOTS = `
  select id, to_char(taken_on, 'YYYY-MM-DD') as taken_on, note,
         rsu_price_ten_thousandths, rsu_price_currency
    from snapshots`;

function toRsuPrice(row: SnapshotRow): SharePrice | null {
  if (row.rsu_price_ten_thousandths === null || row.rsu_price_currency === null) return null;

  const tenThousandths = Number(row.rsu_price_ten_thousandths);
  if (!Number.isSafeInteger(tenThousandths)) {
    throw new MalformedSnapshotRowError(row.id, `share price ${row.rsu_price_ten_thousandths} is not an integer`);
  }
  if (!isCurrency(row.rsu_price_currency)) {
    throw new MalformedSnapshotRowError(row.id, `unknown currency ${row.rsu_price_currency}`);
  }
  return sharePrice(tenThousandths, row.rsu_price_currency);
}

function toHeader(row: SnapshotRow): SnapshotHeader {
  return {
    id: row.id,
    takenOn: parseDateKey(row.taken_on),
    note: row.note,
    rsuPrice: toRsuPrice(row),
  };
}

/** Every snapshot's header, newest first. */
export async function loadSnapshotHeaders(): Promise<readonly SnapshotHeader[]> {
  const rows = await query<SnapshotRow>(`${SELECT_SNAPSHOTS} order by taken_on desc`);
  return rows.map(toHeader);
}

/**
 * The note beside a snapshot. It is deliberately not part of the domain Snapshot:
 * a remark about why a reading was taken is not one of its figures, and nothing
 * computed from a snapshot may depend on it.
 */
export async function findSnapshotHeader(id: string): Promise<SnapshotHeader | null> {
  const rows = await query<SnapshotRow>(`${SELECT_SNAPSHOTS} where id = $1`, [id]);
  const row = rows[0];
  return row === undefined ? null : toHeader(row);
}

async function hydrate(rows: readonly SnapshotRow[]): Promise<readonly Snapshot[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [rates, lines] = await Promise.all([
    query<RateRow>(`select snapshot_id, base, quote, rate from snapshot_rates where snapshot_id = any($1)`, [ids]),
    query<LineRow>(
      `select snapshot_id, account_id, amount_minor, currency, source,
              to_char(measured_on, 'YYYY-MM-DD') as measured_on
         from snapshot_lines
        where snapshot_id = any($1)`,
      [ids],
    ),
  ]);

  return rows.map((row) =>
    buildSnapshot({
      id: row.id,
      takenOn: parseDateKey(row.taken_on),
      rates: rates.filter((rate) => rate.snapshot_id === row.id).map(toRate),
      lines: lines.filter((line) => line.snapshot_id === row.id).map(toLine),
    }),
  );
}

export async function findSnapshot(id: string): Promise<Snapshot | null> {
  const rows = await query<SnapshotRow>(`${SELECT_SNAPSHOTS} where id = $1`, [id]);
  const hydrated = await hydrate(rows);
  return hydrated[0] ?? null;
}

/**
 * The snapshot immediately before a date — what a new one seeds from. Read here
 * rather than loading the whole history, because seeding needs exactly one.
 */
export async function findSnapshotBefore(date: CalendarDate): Promise<Snapshot | null> {
  const rows = await query<SnapshotRow>(
    `${SELECT_SNAPSHOTS} where taken_on < $1::date order by taken_on desc limit 1`,
    [dateKey(date)],
  );
  const hydrated = await hydrate(rows);
  return hydrated[0] ?? null;
}

export async function loadSnapshots(): Promise<readonly Snapshot[]> {
  const rows = await query<SnapshotRow>(`${SELECT_SNAPSHOTS} order by taken_on desc`);
  return hydrate(rows);
}

/**
 * Write a whole snapshot — header, rates and every line — in one transaction. A
 * snapshot that landed without its lines would be a partial restatement, which is
 * the one thing a snapshot is defined not to be.
 */
export async function insertSnapshot(
  snapshot: Snapshot,
  header: { readonly note: string | null; readonly rsuPrice: SharePrice | null },
): Promise<void> {
  await withTransaction(async (run) => {
    await run(
      `insert into snapshots (id, taken_on, note, rsu_price_ten_thousandths, rsu_price_currency)
       values ($1, $2::date, $3, $4, $5)`,
      [
        snapshot.id,
        dateKey(snapshot.takenOn),
        header.note,
        header.rsuPrice?.tenThousandths ?? null,
        header.rsuPrice?.currency ?? null,
      ],
    );

    for (const rate of snapshot.rates) {
      await run(`insert into snapshot_rates (snapshot_id, base, quote, rate) values ($1, $2, $3, $4)`, [
        snapshot.id,
        rate.from,
        rate.to,
        rate.rate,
      ]);
    }

    for (const line of snapshot.lines) {
      await run(
        `insert into snapshot_lines (snapshot_id, account_id, amount_minor, currency, source, measured_on)
         values ($1, $2, $3, $4, $5, $6::date)`,
        [
          snapshot.id,
          line.accountId,
          line.balance.minorUnits,
          line.balance.currency,
          line.source,
          line.measuredOn === null ? null : dateKey(line.measuredOn),
        ],
      );
    }
  });
}

/**
 * Restate an existing snapshot's lines. Upsert rather than insert, so the same
 * statement writes a correction to a line and fills in a line for an account that
 * was defined after the snapshot was taken.
 *
 * The snapshot's own date and rate are not touched: a snapshot restated at a
 * later rate would no longer be the reading it was when taken.
 */
export async function saveSnapshotLines(snapshot: Snapshot): Promise<void> {
  await withTransaction(async (run) => {
    for (const line of snapshot.lines) {
      await run(
        `insert into snapshot_lines (snapshot_id, account_id, amount_minor, currency, source, measured_on)
         values ($1, $2, $3, $4, $5, $6::date)
         on conflict (snapshot_id, account_id) do update
           set amount_minor = excluded.amount_minor,
               currency     = excluded.currency,
               source       = excluded.source,
               measured_on  = excluded.measured_on`,
        [
          snapshot.id,
          line.accountId,
          line.balance.minorUnits,
          line.balance.currency,
          line.source,
          line.measuredOn === null ? null : dateKey(line.measuredOn),
        ],
      );
    }
  });
}

/**
 * The share price a snapshot was read at. Written apart from the lines because it
 * is a different kind of fact: a price is stated by a person, and the RSU
 * account's line is derived from it and from the position's own share count.
 * Clearing it leaves the derived figure standing as the last one anybody stated,
 * rather than silently zeroing a holding.
 */
export async function saveSnapshotRsuPrice(
  snapshotId: string,
  price: SharePrice | null,
): Promise<void> {
  await query(
    `update snapshots
        set rsu_price_ten_thousandths = $2,
            rsu_price_currency        = $3
      where id = $1`,
    [snapshotId, price?.tenThousandths ?? null, price?.currency ?? null],
  );
}
