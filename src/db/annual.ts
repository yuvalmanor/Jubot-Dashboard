import {
  type AnnualReview,
  type AnnualReviewDefinition,
  type ProjectValuation,
  buildAnnualReview,
} from "@/domain/annual/annual-review";
import { type Currency, exchangeRate, isCurrency, money } from "@/domain/money/money";
import { type SharePrice, sharePrice } from "@/domain/rsu/rsu-position";
import { dateKey, parseDateKey } from "@/domain/time/calendar-date";

import { query, withTransaction } from "./client";

/**
 * Reading and writing Annual Reviews. The domain decides what a valid one is
 * (src/domain/annual); this stores it.
 *
 * There is deliberately no column here for הכנסות, הוצאות, חיסכון, a net-worth
 * total or a share count. Every one of them is recomputed on read from records
 * that still exist (ADR 0002), so there is no copy that can go stale behind a
 * correction. What is stored is what the closing day alone could supply: the rate,
 * the share price, and the valuations placed on the projects.
 */

interface ReviewRow extends Record<string, unknown> {
  year: number;
  note: string | null;
  recorded_on: string;
  closing_snapshot_id: string | null;
  closing_usd_ils_rate: string | null;
  closing_share_price_ten_thousandths: string | null;
  closing_share_price_currency: string | null;
}

interface ValuationRow extends Record<string, unknown> {
  year: number;
  project_id: string;
  amount_minor: string;
  currency: string;
}

export class MalformedAnnualReviewRowError extends Error {
  constructor(year: number, detail: string) {
    super(`Annual review ${year} is malformed: ${detail}`);
    this.name = "MalformedAnnualReviewRowError";
  }
}

function currencyOf(year: number, value: string): Currency {
  if (!isCurrency(value)) {
    throw new MalformedAnnualReviewRowError(year, `unknown currency ${value}`);
  }
  return value;
}

function minorUnitsOf(year: number, value: string): number {
  const minorUnits = Number(value);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new MalformedAnnualReviewRowError(year, `amount ${value} is not an integer`);
  }
  return minorUnits;
}

function toSharePrice(row: ReviewRow): SharePrice | null {
  if (row.closing_share_price_ten_thousandths === null || row.closing_share_price_currency === null) {
    return null;
  }
  const tenThousandths = Number(row.closing_share_price_ten_thousandths);
  if (!Number.isSafeInteger(tenThousandths)) {
    throw new MalformedAnnualReviewRowError(
      row.year,
      `share price ${row.closing_share_price_ten_thousandths} is not an integer`,
    );
  }
  return sharePrice(tenThousandths, currencyOf(row.year, row.closing_share_price_currency));
}

function toValuation(row: ValuationRow): ProjectValuation {
  return {
    projectId: row.project_id,
    amount: money(minorUnitsOf(row.year, row.amount_minor), currencyOf(row.year, row.currency)),
  };
}

function toReview(row: ReviewRow, valuations: readonly ValuationRow[]): AnnualReview {
  return buildAnnualReview({
    year: Number(row.year),
    note: row.note,
    recordedOn: parseDateKey(row.recorded_on),
    closingSnapshotId: row.closing_snapshot_id,
    // Quoted USD/ILS in both directions, so one stored number can never read as two.
    closingRate:
      row.closing_usd_ils_rate === null
        ? null
        : exchangeRate("USD", "ILS", Number(row.closing_usd_ils_rate)),
    closingSharePrice: toSharePrice(row),
    valuations: valuations.filter((valuation) => valuation.year === row.year).map(toValuation),
  });
}

const SELECT_REVIEWS = `
  select year, note, to_char(recorded_on, 'YYYY-MM-DD') as recorded_on, closing_snapshot_id,
         closing_usd_ils_rate, closing_share_price_ten_thousandths, closing_share_price_currency
    from annual_reviews`;

const SELECT_VALUATIONS = `select year, project_id, amount_minor, currency from annual_review_valuations`;

export async function loadAnnualReviews(): Promise<readonly AnnualReview[]> {
  const [rows, valuations] = await Promise.all([
    query<ReviewRow>(`${SELECT_REVIEWS} order by year desc`),
    query<ValuationRow>(SELECT_VALUATIONS),
  ]);
  return rows.map((row) => toReview(row, valuations));
}

export async function findAnnualReviewFor(year: number): Promise<AnnualReview | null> {
  const [rows, valuations] = await Promise.all([
    query<ReviewRow>(`${SELECT_REVIEWS} where year = $1`, [year]),
    query<ValuationRow>(`${SELECT_VALUATIONS} where year = $1`, [year]),
  ]);
  const row = rows[0];
  return row === undefined ? null : toReview(row, valuations);
}

const FROZEN_COLUMNS = [
  "note",
  "closing_snapshot_id",
  "closing_usd_ils_rate",
  "closing_share_price_ten_thousandths",
  "closing_share_price_currency",
] as const;

function frozenValues(review: AnnualReview): readonly unknown[] {
  return [
    review.note,
    review.closingSnapshotId,
    review.closingRate === null ? null : review.closingRate.rate,
    review.closingSharePrice === null ? null : review.closingSharePrice.tenThousandths,
    review.closingSharePrice === null ? null : review.closingSharePrice.currency,
  ];
}

export async function insertAnnualReview(
  definition: AnnualReviewDefinition,
): Promise<AnnualReview> {
  const review = buildAnnualReview(definition);

  await withTransaction(async (run) => {
    await run(
      `insert into annual_reviews (year, recorded_on, ${FROZEN_COLUMNS.join(", ")})
       values ($1, $2::date, $3, $4, $5, $6, $7)`,
      [review.year, dateKey(review.recordedOn), ...frozenValues(review)],
    );
    for (const valuation of review.valuations) {
      await run(
        `insert into annual_review_valuations (year, project_id, amount_minor, currency)
         values ($1, $2, $3, $4)`,
        [review.year, valuation.projectId, valuation.amount.minorUnits, valuation.amount.currency],
      );
    }
  });

  return review;
}

/**
 * Correct the frozen facts. The valuations are written one at a time below, so a
 * review that names a project's worth does not have to restate the rate to do it.
 */
export async function saveAnnualReview(review: AnnualReview): Promise<void> {
  await query(
    `update annual_reviews
        set note                                = $2,
            closing_snapshot_id                 = $3,
            closing_usd_ils_rate                = $4,
            closing_share_price_ten_thousandths = $5,
            closing_share_price_currency        = $6
      where year = $1`,
    [review.year, ...frozenValues(review)],
  );
}

/** One project's frozen worth at the close. At most one per project per year. */
export async function saveProjectValuation(
  year: number,
  valuation: ProjectValuation,
): Promise<void> {
  await query(
    `insert into annual_review_valuations (year, project_id, amount_minor, currency)
     values ($1, $2, $3, $4)
     on conflict (year, project_id) do update
       set amount_minor = excluded.amount_minor,
           currency     = excluded.currency`,
    [year, valuation.projectId, valuation.amount.minorUnits, valuation.amount.currency],
  );
}

/** Withdraw a judgement. The project reads as unvalued again, which is a real state. */
export async function deleteProjectValuation(year: number, projectId: string): Promise<void> {
  await query(`delete from annual_review_valuations where year = $1 and project_id = $2`, [
    year,
    projectId,
  ]);
}

/**
 * Drop a review. It takes its valuations with it and nothing else: every other
 * figure on the page was read out of records this cannot reach.
 */
export async function deleteAnnualReview(year: number): Promise<void> {
  await query(`delete from annual_reviews where year = $1`, [year]);
}
