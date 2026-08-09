import {
  type Currency,
  type ExchangeRate,
  type Money,
  exchangeRate,
  isCurrency,
  money,
} from "@/domain/money/money";

import { query } from "./client";

/**
 * Reading money out of Postgres. `bigint` and `numeric` come back as strings from
 * pg, which is what we want: the value is parsed once, here, and validated into a
 * Money before anything else sees it.
 */

export interface StoredAmount {
  readonly key: string;
  readonly labelHe: string;
  readonly amount: Money;
}

export interface DatedRate extends ExchangeRate {
  readonly asOf: Date;
}

interface MoneySettingRow extends Record<string, unknown> {
  key: string;
  label_he: string;
  amount_minor: string;
  currency: string;
}

interface FxRateRow extends Record<string, unknown> {
  base: string;
  quote: string;
  rate: string;
  as_of: Date;
}

export class MalformedStoredAmountError extends Error {
  constructor(key: string, detail: string) {
    super(`Stored amount "${key}" is malformed: ${detail}`);
    this.name = "MalformedStoredAmountError";
  }
}

function toStoredAmount(row: MoneySettingRow): StoredAmount {
  const minorUnits = Number(row.amount_minor);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new MalformedStoredAmountError(row.key, `amount_minor ${row.amount_minor} is not an integer`);
  }
  if (!isCurrency(row.currency)) {
    throw new MalformedStoredAmountError(row.key, `unknown currency ${row.currency}`);
  }
  return {
    key: row.key,
    labelHe: row.label_he,
    amount: money(minorUnits, row.currency),
  };
}

export async function findStoredAmount(key: string): Promise<StoredAmount | null> {
  const rows = await query<MoneySettingRow>(
    `select key, label_he, amount_minor, currency
       from money_settings
      where key = $1`,
    [key],
  );
  const row = rows[0];
  return row === undefined ? null : toStoredAmount(row);
}

/** The most recent rate for a pair. A conversion always states the rate it used. */
export async function findLatestRate(base: Currency, quote: Currency): Promise<DatedRate | null> {
  const rows = await query<FxRateRow>(
    `select base, quote, rate, as_of
       from fx_rates
      where base = $1 and quote = $2
      order by as_of desc
      limit 1`,
    [base, quote],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { ...exchangeRate(base, quote, Number(row.rate)), asOf: row.as_of };
}
