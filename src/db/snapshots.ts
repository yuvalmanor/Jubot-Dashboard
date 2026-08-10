import { type ExchangeRate, exchangeRate, isCurrency, money } from "@/domain/money/money";
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
  select id, to_char(taken_on, 'YYYY-MM-DD') as taken_on, note
    from snapshots`;

function toHeader(row: SnapshotRow): SnapshotHeader {
  return { id: row.id, takenOn: parseDateKey(row.taken_on), note: row.note };
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
export async function insertSnapshot(snapshot: Snapshot, note: string | null): Promise<void> {
  await withTransaction(async (run) => {
    await run(`insert into snapshots (id, taken_on, note) values ($1, $2::date, $3)`, [
      snapshot.id,
      dateKey(snapshot.takenOn),
      note,
    ]);

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
