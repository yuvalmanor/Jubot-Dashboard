import { type Currency, isCurrency } from "@/domain/money/money";
import {
  type Grant,
  type GrantDefinition,
  type GrantPrice,
  type Sale,
  type SaleDefinition,
  type SharePrice,
  type Vest,
  type VestDefinition,
  buildGrant,
  buildSale,
  buildVest,
  gpWindowKey,
  parseGpWindow,
  sharePrice,
} from "@/domain/rsu/rsu-position";
import { dateKey, parseDateKey } from "@/domain/time/calendar-date";

import { query } from "./client";

/**
 * Reading and writing RSU Grants, their Vests and the Sales against each lot. The
 * domain decides what a valid one is (src/domain/rsu); this stores it.
 *
 * Nothing here stores a qualification, a remaining share count or a position:
 * every one of those is derived on read from the rows below, so there is no state
 * that can quietly disagree with what it is made of — and the 24-month boundary
 * moves with the calendar rather than with whatever last swept a flag.
 *
 * A price per share is stored as integer ten-thousandths with its own currency,
 * for the same reason money is stored in minor units: 149.4219 is exact that way
 * and is a float any other way.
 */

interface PricedRow extends Record<string, unknown> {
  id: string;
  price_ten_thousandths: string;
  price_currency: string;
}

interface GrantRow extends Record<string, unknown> {
  id: string;
  person_id: string;
  reference: string;
  granted_on: string;
  total_shares: number;
  grant_price_ten_thousandths: string | null;
  grant_price_currency: string | null;
  grant_price_source: string | null;
  grant_price_window: string | null;
  grant_price_samples: number | null;
}

interface VestRow extends PricedRow {
  grant_id: string;
  vested_on: string;
  shares: number;
}

interface SaleRow extends PricedRow {
  vest_id: string;
  sold_on: string;
  shares: number;
}

export class MalformedRsuRowError extends Error {
  constructor(id: string, detail: string) {
    super(`RSU row ${id} is malformed: ${detail}`);
    this.name = "MalformedRsuRowError";
  }
}

function currencyOf(id: string, value: string): Currency {
  if (!isCurrency(value)) {
    throw new MalformedRsuRowError(id, `unknown currency ${value}`);
  }
  return value;
}

function priceOf(id: string, tenThousandths: string, currency: string): SharePrice {
  const units = Number(tenThousandths);
  if (!Number.isSafeInteger(units)) {
    throw new MalformedRsuRowError(id, `price ${tenThousandths} is not an integer`);
  }
  return sharePrice(units, currencyOf(id, currency));
}

// --- grants ------------------------------------------------------------------

/**
 * The stored GP, with the provenance it was written with. A `stated` price carries
 * no window because none produced it; an `estimated` one carries the window and the
 * sample it was taken over, so a household that later changes the setting can be
 * told which figures were taken under the old one.
 */
function grantPriceOf(row: GrantRow): GrantPrice | null {
  if (row.grant_price_ten_thousandths === null || row.grant_price_currency === null) return null;

  const price = priceOf(row.id, row.grant_price_ten_thousandths, row.grant_price_currency);

  if (row.grant_price_source === "stated") {
    return { price, source: "stated", window: null, sampleCount: null };
  }
  if (row.grant_price_source === "estimated") {
    if (row.grant_price_window === null || row.grant_price_samples === null) {
      throw new MalformedRsuRowError(row.id, "an estimated GP with no window or no sample behind it");
    }
    return {
      price,
      source: "estimated",
      window: parseGpWindow(row.grant_price_window),
      sampleCount: row.grant_price_samples,
    };
  }
  throw new MalformedRsuRowError(row.id, `unknown grant price source ${String(row.grant_price_source)}`);
}

function toGrant(row: GrantRow): Grant {
  return buildGrant(row.id, {
    personId: row.person_id,
    reference: row.reference,
    grantedOn: parseDateKey(row.granted_on),
    totalShares: row.total_shares,
    grantPrice: grantPriceOf(row),
  });
}

const GRANT_COLUMNS = `id, person_id, reference, to_char(granted_on, 'YYYY-MM-DD') as granted_on,
                       total_shares, grant_price_ten_thousandths, grant_price_currency,
                       grant_price_source, grant_price_window, grant_price_samples`;

export async function loadGrants(): Promise<readonly Grant[]> {
  const rows = await query<GrantRow>(`select ${GRANT_COLUMNS} from rsu_grants`);
  return rows.map(toGrant);
}

/** The columns a GP occupies, spread flat so both writers agree on their order. */
function grantPriceValues(grantPrice: GrantPrice | null): readonly unknown[] {
  if (grantPrice === null) return [null, null, null, null, null];
  return [
    grantPrice.price.tenThousandths,
    grantPrice.price.currency,
    grantPrice.source,
    grantPrice.window === null ? null : gpWindowKey(grantPrice.window),
    grantPrice.sampleCount,
  ];
}

export async function insertGrant(id: string, definition: GrantDefinition): Promise<Grant> {
  const grant = buildGrant(id, definition);
  await query(
    `insert into rsu_grants (id, person_id, reference, granted_on, total_shares,
                             grant_price_ten_thousandths, grant_price_currency,
                             grant_price_source, grant_price_window, grant_price_samples)
     values ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10)`,
    [
      grant.id,
      grant.personId,
      grant.reference,
      dateKey(grant.grantedOn),
      grant.totalShares,
      ...grantPriceValues(grant.grantPrice),
    ],
  );
  return grant;
}

/**
 * Correct a grant. The person is not among the fields: whose grant it is decides
 * whose position every vest under it belongs to, and moving it would move history.
 */
export async function updateGrant(grant: Grant): Promise<void> {
  await query(
    `update rsu_grants
        set reference                   = $2,
            granted_on                  = $3::date,
            total_shares                = $4,
            grant_price_ten_thousandths = $5,
            grant_price_currency        = $6,
            grant_price_source          = $7,
            grant_price_window          = $8,
            grant_price_samples         = $9
      where id = $1`,
    [
      grant.id,
      grant.reference,
      dateKey(grant.grantedOn),
      grant.totalShares,
      ...grantPriceValues(grant.grantPrice),
    ],
  );
}

/** Removing a grant takes its vests and their sales with it — they are its parts. */
export async function deleteGrant(id: string): Promise<void> {
  await query(`delete from rsu_grants where id = $1`, [id]);
}

// --- vests -------------------------------------------------------------------

function toVest(row: VestRow, grants: readonly Grant[]): Vest {
  const grant = grants.find((candidate) => candidate.id === row.grant_id);
  if (grant === undefined) {
    throw new MalformedRsuRowError(row.id, `no grant ${row.grant_id}`);
  }
  return buildVest(
    row.id,
    {
      grantId: row.grant_id,
      vestedOn: parseDateKey(row.vested_on),
      shares: row.shares,
      priceAtVest: priceOf(row.id, row.price_ten_thousandths, row.price_currency),
    },
    grant,
  );
}

/**
 * Every vest, with the grants beside them: a vest is only valid against the grant
 * it came out of, because whether its date is possible is a question about the
 * grant's own date.
 */
export async function loadVests(grants: readonly Grant[]): Promise<readonly Vest[]> {
  const rows = await query<VestRow>(
    `select id, grant_id, to_char(vested_on, 'YYYY-MM-DD') as vested_on, shares,
            price_ten_thousandths, price_currency
       from rsu_vests`,
  );
  return rows.map((row) => toVest(row, grants));
}

export async function insertVest(
  id: string,
  definition: VestDefinition,
  grant: Grant,
): Promise<Vest> {
  const vest = buildVest(id, definition, grant);
  await query(
    `insert into rsu_vests (id, grant_id, vested_on, shares, price_ten_thousandths, price_currency)
     values ($1, $2, $3::date, $4, $5, $6)`,
    [
      vest.id,
      vest.grantId,
      dateKey(vest.vestedOn),
      vest.shares,
      vest.priceAtVest.tenThousandths,
      vest.priceAtVest.currency,
    ],
  );
  return vest;
}

/** Removing a vest takes the sales against it with it: they were sales of that lot. */
export async function deleteVest(id: string): Promise<void> {
  await query(`delete from rsu_vests where id = $1`, [id]);
}

// --- sales -------------------------------------------------------------------

function toSale(row: SaleRow, vests: readonly Vest[]): Sale {
  const vest = vests.find((candidate) => candidate.id === row.vest_id);
  if (vest === undefined) {
    throw new MalformedRsuRowError(row.id, `no vest ${row.vest_id}`);
  }
  return buildSale(
    row.id,
    {
      vestId: row.vest_id,
      soldOn: parseDateKey(row.sold_on),
      shares: row.shares,
      price: priceOf(row.id, row.price_ten_thousandths, row.price_currency),
    },
    vest,
  );
}

export async function loadSales(vests: readonly Vest[]): Promise<readonly Sale[]> {
  const rows = await query<SaleRow>(
    `select id, vest_id, to_char(sold_on, 'YYYY-MM-DD') as sold_on, shares,
            price_ten_thousandths, price_currency
       from rsu_sales`,
  );
  return rows.map((row) => toSale(row, vests));
}

export async function insertSale(id: string, definition: SaleDefinition, vest: Vest): Promise<Sale> {
  const sale = buildSale(id, definition, vest);
  await query(
    `insert into rsu_sales (id, vest_id, sold_on, shares, price_ten_thousandths, price_currency)
     values ($1, $2, $3::date, $4, $5, $6)`,
    [
      sale.id,
      sale.vestId,
      dateKey(sale.soldOn),
      sale.shares,
      sale.price.tenThousandths,
      sale.price.currency,
    ],
  );
  return sale;
}

/** Remove a sale. Always safe: taking one out can only put shares back in the lot. */
export async function deleteSale(id: string): Promise<void> {
  await query(`delete from rsu_sales where id = $1`, [id]);
}

// --- the whole thing, in one read --------------------------------------------

export interface RsuRecords {
  readonly grants: readonly Grant[];
  readonly vests: readonly Vest[];
  readonly sales: readonly Sale[];
}

/**
 * Everything the position is made of. Loaded in order rather than in parallel
 * because each layer validates against the one above it — a vest against its
 * grant's date, a sale against its vest's.
 */
export async function loadRsuRecords(): Promise<RsuRecords> {
  const grants = await loadGrants();
  const vests = await loadVests(grants);
  const sales = await loadSales(vests);
  return { grants, vests, sales };
}
