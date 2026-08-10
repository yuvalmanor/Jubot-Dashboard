import { isCurrency, money } from "@/domain/money/money";
import {
  type Earmark,
  type EarmarkDefinition,
  type Position,
  type PositionDefinition,
  buildEarmark,
  buildPosition,
} from "@/domain/snapshot/holdings";
import { type CalendarDate, dateKey, parseDateKey } from "@/domain/time/calendar-date";

import { query } from "./client";

/**
 * Reading and writing Positions and Earmarks. The domain decides what a valid one
 * is (src/domain/snapshot/holdings); this stores it.
 *
 * Both are held against an Account and neither is held against a snapshot: a
 * position says what the account is invested in, and an earmark says what its
 * money is promised to. How much is in the account on a given day stays the
 * snapshot's fact, and is never copied here.
 */

interface PositionRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  security_id: string | null;
  name: string;
}

interface EarmarkRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  name: string;
  amount_minor: string;
  currency: string;
  declared_on: string;
  released_on: string | null;
}

export class MalformedHoldingRowError extends Error {
  constructor(id: string, detail: string) {
    super(`Holding row ${id} is malformed: ${detail}`);
    this.name = "MalformedHoldingRowError";
  }
}

function toPosition(row: PositionRow): Position {
  return buildPosition(row.id, {
    accountId: row.account_id,
    securityId: row.security_id,
    name: row.name,
  });
}

function toEarmark(row: EarmarkRow): Earmark {
  const minorUnits = Number(row.amount_minor);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new MalformedHoldingRowError(row.id, `amount_minor ${row.amount_minor} is not an integer`);
  }
  if (!isCurrency(row.currency)) {
    throw new MalformedHoldingRowError(row.id, `unknown currency ${row.currency}`);
  }

  return buildEarmark(row.id, {
    accountId: row.account_id,
    name: row.name,
    claim: money(minorUnits, row.currency),
    declaredOn: parseDateKey(row.declared_on),
    releasedOn: row.released_on === null ? null : parseDateKey(row.released_on),
  });
}

/** Every position. Which account each belongs to is the domain's question to answer. */
export async function loadPositions(): Promise<readonly Position[]> {
  const rows = await query<PositionRow>(
    `select id, account_id, security_id, name from positions`,
  );
  return rows.map(toPosition);
}

export async function insertPosition(id: string, definition: PositionDefinition): Promise<void> {
  const position = buildPosition(id, definition);
  await query(
    `insert into positions (id, account_id, security_id, name) values ($1, $2, $3, $4)`,
    [position.id, position.accountId, position.securityId, position.name],
  );
}

/**
 * Remove a position. Unlike an earmark this is a delete rather than a lifespan:
 * a position is a statement of what an account holds now, nothing dated is
 * recorded against it, and no past reading changes when one goes.
 */
export async function deletePosition(id: string): Promise<void> {
  await query(`delete from positions where id = $1`, [id]);
}

/**
 * Every earmark, released ones included. Which claims stood on a given date is the
 * domain's question, and it takes the whole set to answer it.
 */
export async function loadEarmarks(): Promise<readonly Earmark[]> {
  const rows = await query<EarmarkRow>(
    `select id, account_id, name, amount_minor, currency,
            to_char(declared_on, 'YYYY-MM-DD') as declared_on,
            to_char(released_on, 'YYYY-MM-DD') as released_on
       from earmarks`,
  );
  return rows.map(toEarmark);
}

export async function insertEarmark(id: string, definition: EarmarkDefinition): Promise<void> {
  const earmark = buildEarmark(id, definition);
  await query(
    `insert into earmarks (id, account_id, name, amount_minor, currency, declared_on, released_on)
     values ($1, $2, $3, $4, $5, $6::date, $7::date)`,
    [
      earmark.id,
      earmark.accountId,
      earmark.name,
      earmark.claim.minorUnits,
      earmark.claim.currency,
      dateKey(earmark.declaredOn),
      earmark.releasedOn === null ? null : dateKey(earmark.releasedOn),
    ],
  );
}

/**
 * Correct a claim. The account is not among the fields: an earmark is a claim on
 * *that* money, and moving it elsewhere is releasing one promise and making
 * another.
 */
export async function updateEarmark(earmark: Earmark): Promise<void> {
  await query(
    `update earmarks
        set name         = $2,
            amount_minor = $3,
            currency     = $4,
            declared_on  = $5::date,
            released_on  = $6::date
      where id = $1`,
    [
      earmark.id,
      earmark.name,
      earmark.claim.minorUnits,
      earmark.claim.currency,
      dateKey(earmark.declaredOn),
      earmark.releasedOn === null ? null : dateKey(earmark.releasedOn),
    ],
  );
}

/** Release a claim, or reinstate it. The row itself stays forever. */
export async function setEarmarkRelease(id: string, releasedOn: CalendarDate | null): Promise<void> {
  await query(`update earmarks set released_on = $2::date where id = $1`, [
    id,
    releasedOn === null ? null : dateKey(releasedOn),
  ]);
}
