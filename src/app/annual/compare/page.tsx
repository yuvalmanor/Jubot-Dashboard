import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { loadAnnualReviews } from "@/db/annual";
import { DatabaseNotConfiguredError } from "@/db/client";
import { type Person, findPersonByEmail } from "@/db/people";
import {
  type AnnualReview,
  type AnnualReviewComparison,
  type ReviewComparisonKey,
  type ReviewComparisonRow,
  compareAnnualReviews,
  reviewsInReadingOrder,
} from "@/domain/annual/annual-review";
import { type Money, format, isNegative, negate } from "@/domain/money/money";
import { requireHouseholdEmail } from "@/session";

import {
  BasisBadge,
  Field,
  UnavailablePanel,
  formatRate,
  monthsCounted,
  monthsRecorded,
} from "../panels";
import { readReviewOf } from "../reading";

export const dynamic = "force-dynamic";

/**
 * Two years side by side.
 *
 * The earlier year is always on the right-hand column of the pair and the later on
 * the other, whichever way round they were picked, so "the difference" always
 * means the later year less the earlier one — progress reads forwards.
 *
 * Every figure is one each year already shows on its own page, read through the
 * same functions, and each row carries its basis: a rise in a frozen valuation is
 * a rise in somebody's judgement, and it must never read like a rise in a measured
 * figure.
 */

const ROW_LABELS: Record<ReviewComparisonKey, string> = {
  income: "הכנסות",
  expenses: "הוצאות",
  saving: "חיסכון",
  "net-worth": "שווי המיפוי בסגירה",
  "project-cost": "עלות הפרוייקטים",
  "project-valuation": "הערכות הפרוייקטים",
  "rsu-shares": "מניות מוחזקות",
  "rsu-value": "שווי החזקת ה־RSU",
};

interface SearchParams {
  left?: string | string[];
  right?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CompareAnnualReviewsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const loaded = await loadPage(email, first(params.left), first(params.right));

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "unavailable" ? null : loaded.person}
        title="השוואת שנים"
        subtitle="שני סיכומים שנתיים זה מול זה — ההפרש הוא תמיד השנה המאוחרת פחות המוקדמת"
        back={{ href: "/annual", label: "חזרה לסיכומים השנתיים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        {loaded.kind === "unavailable" ? (
          <UnavailablePanel reason={loaded.reason} />
        ) : (
          <>
            <ChooserPanel reviews={loaded.reviews} left={loaded.leftYear} right={loaded.rightYear} />

            {loaded.kind === "compared" ? (
              <ComparisonPanel comparison={loaded.comparison} />
            ) : (
              <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
                {loaded.reviews.length < 2
                  ? "צריך שני סיכומים שנתיים כדי להשוות. אחד לבדו אינו השוואה."
                  : "בחרו שתי שנים שונות. שנה מול עצמה אינה עונה על כלום."}
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// --- loading -------------------------------------------------------------------

type Loaded =
  | {
      kind: "compared";
      person: Person | null;
      reviews: readonly AnnualReview[];
      leftYear: number;
      rightYear: number;
      comparison: AnnualReviewComparison;
    }
  | {
      kind: "choose";
      person: Person | null;
      reviews: readonly AnnualReview[];
      leftYear: number | null;
      rightYear: number | null;
    }
  | { kind: "unavailable"; reason: string };

function yearOf(reviews: readonly AnnualReview[], text: string | undefined): number | null {
  const year = Number((text ?? "").trim());
  if (!Number.isInteger(year)) return null;
  return reviews.some((review) => review.year === year) ? year : null;
}

async function loadPage(
  email: string,
  left: string | undefined,
  right: string | undefined,
): Promise<Loaded> {
  try {
    const [person, stored] = await Promise.all([findPersonByEmail(email), loadAnnualReviews()]);
    const reviews = reviewsInReadingOrder(stored);

    // The two most recent years are what a household compares by default; naming
    // years in the query overrides it.
    const leftYear = yearOf(reviews, left) ?? reviews[1]?.year ?? null;
    const rightYear = yearOf(reviews, right) ?? reviews[0]?.year ?? null;

    const leftReview = reviews.find((review) => review.year === leftYear);
    const rightReview = reviews.find((review) => review.year === rightYear);

    if (leftReview === undefined || rightReview === undefined || leftYear === rightYear) {
      return { kind: "choose", person, reviews, leftYear, rightYear };
    }

    const [leftReading, rightReading] = await Promise.all([
      readReviewOf(leftReview),
      readReviewOf(rightReview),
    ]);

    return {
      kind: "compared",
      person,
      reviews,
      leftYear: leftReview.year,
      rightYear: rightReview.year,
      comparison: compareAnnualReviews(leftReading, rightReading),
    };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- choosing the two years -------------------------------------------------------

function ChooserPanel({
  reviews,
  left,
  right,
}: {
  reviews: readonly AnnualReview[];
  left: number | null;
  right: number | null;
}) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">אילו שנים</h2>

      <form method="get" className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="שנה">
          <YearSelect name="left" reviews={reviews} selected={left} />
        </Field>
        <Field label="מול שנה">
          <YearSelect name="right" reviews={reviews} selected={right} />
        </Field>
        <div className="flex items-end">
          <button
            type="submit"
            className="rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
          >
            השוואה
          </button>
        </div>
      </form>
    </section>
  );
}

function YearSelect({
  name,
  reviews,
  selected,
}: {
  name: string;
  reviews: readonly AnnualReview[];
  selected: number | null;
}) {
  return (
    <select
      name={name}
      defaultValue={selected === null ? "" : String(selected)}
      className="tabular w-full rounded-md border border-stone-300 bg-white px-3 py-2"
    >
      <option value="">— בחירה —</option>
      {reviews.map((review) => (
        <option key={review.year} value={review.year}>
          {review.year}
        </option>
      ))}
    </select>
  );
}

// --- the comparison itself ---------------------------------------------------------

function ComparisonPanel({ comparison }: { comparison: AnnualReviewComparison }) {
  const { earlier, later } = comparison;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">
          <bdi className="tabular">{earlier.review.year}</bdi> מול{" "}
          <bdi className="tabular">{later.review.year}</bdi>
        </h2>
        <p className="text-sm">
          <Link
            href={`/annual/${earlier.review.year}`}
            className="underline underline-offset-4 text-stone-700"
          >
            {earlier.review.year} ←
          </Link>
          <span className="mx-2 text-stone-400">·</span>
          <Link
            href={`/annual/${later.review.year}`}
            className="underline underline-offset-4 text-stone-700"
          >
            {later.review.year} ←
          </Link>
        </p>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-b border-stone-200 text-right text-xs text-stone-500">
              <th className="py-2 font-medium">מה</th>
              <th className="tabular py-2 font-medium">{earlier.review.year}</th>
              <th className="tabular py-2 font-medium">{later.review.year}</th>
              <th className="py-2 font-medium">הפרש</th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row) => (
              <Row key={row.key} row={row} />
            ))}
          </tbody>
        </table>
      </div>

      <RatePanel comparison={comparison} />
      <CoveragePanel comparison={comparison} />

      <p className="mt-4 text-xs text-stone-500">
        כל שורה נושאת את מה שהיא נשענת עליו. עלייה בשורה קפואה היא עלייה בשיפוט של אדם, ועלייה
        בשורה חיה היא עלייה במה שהרישומים אומרים — שני דברים שונים, ולכן הם אינם נראים אותו דבר.
      </p>
    </section>
  );
}

/**
 * Two years that froze two different rates.
 *
 * A row read at each year's own frozen rate moves when the rate moves, even where
 * nothing was bought or sold — the costs below are the same funding legs on both
 * sides. So where the rates differ it is said, beside the two of them, rather than
 * leaving a rate move to read as growth.
 */
function RatePanel({ comparison }: { comparison: AnnualReviewComparison }) {
  const converted = comparison.rows.some((row) => row.basis === "live-at-frozen");
  const { earlier, later } = comparison.rates;
  if (comparison.sameRate || !converted || earlier === null || later === null) return null;

  return (
    <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      השנים הוקפאו בשערים שונים —{" "}
      <bdi className="tabular">{formatRate(earlier.rate)}</bdi> מול{" "}
      <bdi className="tabular">{formatRate(later.rate)}</bdi>. בשורות המסומנות &rdquo;חי, לפי עובדה
      שהוקפאה&ldquo; חלק מההפרש הוא תזוזת השער ולא תזוזת כסף: אותן רגלי מימון עצמן נקראות כאן
      בשני שערים.
    </p>
  );
}

/**
 * How much of each year the מאזן actually holds.
 *
 * A year recorded in part is a smaller year, and set beside a full one it reads as
 * a fall that never happened. The comparison does not trim the two sides to the
 * same span — a review is about a whole year — so the coverage is stated instead,
 * and said out loud where the two differ.
 */
function CoveragePanel({ comparison }: { comparison: AnnualReviewComparison }) {
  const { earlier, later } = comparison;
  const same = earlier.balance.recordedMonths === later.balance.recordedMonths;
  const earlierSpan = monthsCounted(earlier.balance.months);
  const laterSpan = monthsCounted(later.balance.months);

  return (
    <p className={`mt-4 text-sm ${same ? "text-stone-600" : "text-amber-900"}`}>
      <bdi className="tabular">{earlier.review.year}</bdi>:{" "}
      {monthsRecorded(earlier.balance.recordedMonths)} מתוך{" "}
      <bdi className="tabular">{earlier.balance.denominator}</bdi>
      {earlierSpan === null ? null : <bdi> ({earlierSpan})</bdi>}
      <span className="mx-2 text-stone-400">·</span>
      <bdi className="tabular">{later.review.year}</bdi>:{" "}
      {monthsRecorded(later.balance.recordedMonths)} מתוך{" "}
      <bdi className="tabular">{later.balance.denominator}</bdi>
      {laterSpan === null ? null : <bdi> ({laterSpan})</bdi>}
      {same ? null : (
        <>
          {" "}
          — שנה שנרשמה בחלקה מוצגת כאן מול שנה שנרשמה יותר, ולכן ההפרש כולל גם את מה שלא נרשם
          ולא רק את מה שהשתנה.
        </>
      )}
    </p>
  );
}

function Row({ row }: { row: ReviewComparisonRow }) {
  return (
    <tr className="border-b border-stone-100">
      <td className="py-3">
        {ROW_LABELS[row.key]}
        <BasisBadge basis={row.basis} />
      </td>
      <td className="tabular py-3">
        <Value row={row} side="earlier" />
      </td>
      <td className="tabular py-3">
        <Value row={row} side="later" />
      </td>
      <td className="tabular py-3">
        <Difference row={row} />
      </td>
    </tr>
  );
}

function Value({ row, side }: { row: ReviewComparisonRow; side: "earlier" | "later" }) {
  if (row.kind === "money") {
    const amount: Money | null = row[side];
    return amount === null ? (
      <span className="text-xs text-stone-500">אין נתון</span>
    ) : (
      <bdi>{format(amount)}</bdi>
    );
  }

  const count: number | null = row[side];
  return count === null ? (
    <span className="text-xs text-stone-500">אין נתון</span>
  ) : (
    <bdi>{count.toLocaleString("he-IL")}</bdi>
  );
}

function Difference({ row }: { row: ReviewComparisonRow }) {
  if (row.difference === null) {
    return (
      <span className="text-xs text-stone-500">
        {row.earlier === null || row.later === null ? "רק לשנה אחת יש נתון" : "מטבעות שונים"}
      </span>
    );
  }

  if (row.kind === "count") {
    const rose = row.difference > 0;
    return (
      <bdi className={rose ? "text-emerald-800" : row.difference === 0 ? "" : "text-amber-900"}>
        {rose ? "+" : ""}
        {row.difference.toLocaleString("he-IL")}
      </bdi>
    );
  }

  const rose = row.difference.minorUnits > 0;
  const magnitude = isNegative(row.difference) ? negate(row.difference) : row.difference;
  return (
    <bdi className={rose ? "text-emerald-800" : row.difference.minorUnits === 0 ? "" : "text-amber-900"}>
      {rose ? "עלייה של " : row.difference.minorUnits === 0 ? "" : "ירידה של "}
      {format(magnitude)}
    </bdi>
  );
}
