import { loadAccounts } from "@/db/accounts";
import { loadCategories } from "@/db/categories";
import { loadLedger } from "@/db/ledger";
import { loadFundingLegs, loadProjectExpenses, loadProjects } from "@/db/projects";
import { loadRsuRecords } from "@/db/rsu";
import { type SnapshotHeader, findSnapshot, loadSnapshotHeaders } from "@/db/snapshots";
import {
  type AnnualReview,
  type AnnualReviewReading,
  closesOn,
  readAnnualReview,
} from "@/domain/annual/annual-review";
import { type Currency } from "@/domain/money/money";
import { type Project } from "@/domain/projects/projects";
import { readPosition } from "@/domain/rsu/rsu-position";
import { monthOf } from "@/domain/time/calendar-month";

/**
 * Everything one סיכום שנתי reads, gathered at the edge and handed to the domain
 * (ADR 0004). Both the review page and the comparison go through here, so the two
 * screens cannot disagree about a year.
 *
 * The position is read **as of the closing date**, never as of today: what the
 * review answers is where the year ended, and a lot sold the following March is
 * not part of that. The domain refuses a position read on any other day.
 */

export const REVIEW_CURRENCY: Currency = "ILS";

export async function readReviewOf(review: AnnualReview): Promise<AnnualReviewReading> {
  const closing = closesOn(review.year);

  const [ledger, categories, accounts, projects, records] = await Promise.all([
    loadLedger(),
    loadCategories(),
    loadAccounts(),
    loadProjects(),
    loadRsuRecords(),
  ]);

  const [legs, expenses, snapshot] = await Promise.all([
    loadFundingLegs(projects),
    loadProjectExpenses(projects),
    review.closingSnapshotId === null ? null : findSnapshot(review.closingSnapshotId),
  ]);

  return readAnnualReview({
    review,
    ledger,
    categories,
    currency: REVIEW_CURRENCY,
    today: monthOf(new Date()),
    snapshot,
    accounts,
    projects,
    legs,
    expenses,
    // A household with no grants recorded has no position to report, which is
    // silence rather than a holding of nought.
    position:
      records.grants.length === 0
        ? null
        : readPosition({ ...records, asOf: closing }),
  });
}

export interface ReviewContext {
  readonly reading: AnnualReviewReading;
  /** For the valuation forms: a judgement is placed on a project by name. */
  readonly projects: readonly Project[];
  /** For choosing which reading the year closed on. */
  readonly snapshots: readonly SnapshotHeader[];
}

export async function contextFor(review: AnnualReview): Promise<ReviewContext> {
  const [reading, projects, snapshots] = await Promise.all([
    readReviewOf(review),
    loadProjects(),
    loadSnapshotHeaders(),
  ]);
  return { reading, projects, snapshots };
}
