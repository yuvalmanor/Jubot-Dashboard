import {
  type Account,
  type AccountDefinition,
  buildAccount,
  isAssetCategory,
  isValueBasis,
} from "@/domain/snapshot/snapshot";
import { isCurrency } from "@/domain/money/money";
import { type CalendarDate, dateKey, parseDateKey } from "@/domain/time/calendar-date";

import { query } from "./client";

/**
 * Reading and writing Accounts. The domain decides what a valid Account is
 * (src/domain/snapshot); this stores it.
 *
 * Lifespan columns are `date` in Postgres but a CalendarDate in the domain, so
 * they are read as `YYYY-MM-DD` text rather than as a Date — a timestamp crossing
 * a timezone is how "the snapshot of the 31st" quietly becomes the 30th.
 */

interface AccountRow extends Record<string, unknown> {
  id: string;
  person_id: string;
  name: string;
  currency: string;
  value_basis: string;
  category: string;
  asset_kind: string;
  opened_on: string;
  closed_on: string | null;
}

export class MalformedAccountRowError extends Error {
  constructor(id: string, detail: string) {
    super(`Account row ${id} is malformed: ${detail}`);
    this.name = "MalformedAccountRowError";
  }
}

function toAccount(row: AccountRow): Account {
  if (!isCurrency(row.currency)) {
    throw new MalformedAccountRowError(row.id, `unknown currency ${row.currency}`);
  }
  if (!isValueBasis(row.value_basis)) {
    throw new MalformedAccountRowError(row.id, `unknown value basis ${row.value_basis}`);
  }
  if (!isAssetCategory(row.category)) {
    throw new MalformedAccountRowError(row.id, `unknown category ${row.category}`);
  }

  return buildAccount(row.id, {
    personId: row.person_id,
    name: row.name,
    currency: row.currency,
    valueBasis: row.value_basis,
    category: row.category,
    assetKind: row.asset_kind,
    openedOn: parseDateKey(row.opened_on),
    closedOn: row.closed_on === null ? null : parseDateKey(row.closed_on),
  });
}

const SELECT_ACCOUNTS = `
  select id, person_id, name, currency, value_basis, category, asset_kind,
         to_char(opened_on, 'YYYY-MM-DD') as opened_on,
         to_char(closed_on, 'YYYY-MM-DD') as closed_on
    from accounts`;

/**
 * Every Account, open and closed. A closed one still has to resolve for the
 * snapshots it appears in, so there is no filtered read: which are open on a date
 * is the domain's question, and it takes the whole set to answer it.
 */
export async function loadAccounts(): Promise<readonly Account[]> {
  const rows = await query<AccountRow>(SELECT_ACCOUNTS);
  return rows.map(toAccount);
}

export async function insertAccount(id: string, definition: AccountDefinition): Promise<void> {
  const account = buildAccount(id, definition);
  await query(
    `insert into accounts (id, person_id, name, currency, value_basis, category, asset_kind, opened_on, closed_on)
     values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date)`,
    [
      account.id,
      account.personId,
      account.name,
      account.currency,
      account.valueBasis,
      account.category,
      account.assetKind,
      dateKey(account.openedOn),
      account.closedOn === null ? null : dateKey(account.closedOn),
    ],
  );
}

/**
 * Update the definition. The currency is not among the fields: an account's
 * currency is what the account *is*, and changing it would silently re-denominate
 * every figure already recorded against it in every snapshot.
 */
export async function updateAccount(account: Account): Promise<void> {
  await query(
    `update accounts
        set name        = $2,
            value_basis = $3,
            category    = $4,
            asset_kind  = $5,
            opened_on   = $6::date,
            closed_on   = $7::date
      where id = $1`,
    [
      account.id,
      account.name,
      account.valueBasis,
      account.category,
      account.assetKind,
      dateKey(account.openedOn),
      account.closedOn === null ? null : dateKey(account.closedOn),
    ],
  );
}

/** Close an account, or put it back in use. The row itself stays forever. */
export async function setAccountClosure(id: string, closedOn: CalendarDate | null): Promise<void> {
  await query(`update accounts set closed_on = $2::date where id = $1`, [
    id,
    closedOn === null ? null : dateKey(closedOn),
  ]);
}
