import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { loadAnnualReviews } from "@/db/annual";
import { loadCategories } from "@/db/categories";
import { DatabaseNotConfiguredError } from "@/db/client";
import { loadLedger } from "@/db/ledger";
import { type Person, findPersonByEmail } from "@/db/people";
import {
  type AnnualReviewReading,
  readAnnualReview,
  reviewsInReadingOrder,
} from "@/domain/annual/annual-review";
import { formatDate } from "@/domain/time/calendar-date";
import { monthOf } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { createAnnualReview } from "./actions";
import {
  FROZEN_FACT_LABELS,
  Field,
  Notices,
  StatedFigure,
  UnavailablePanel,
  monthsRecorded,
} from "./panels";
import { REVIEW_CURRENCY } from "./reading";

export const dynamic = "force-dynamic";

/**
 * סיכום שנתי — every year the household has closed.
 *
 * The figures on this list are the מאזן's own, recomputed here on every request
 * (ADR 0002). Nothing on it was copied out of the ledger when the review was
 * written, which is why a correction to an old month shows up on the list as
 * readily as on the year's own page.
 */

interface SearchParams {
  error?: string | string[];
  detail?: string | string[];
  done?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AnnualPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const loaded = await loadPage(email);
  const lastClosedYear = new Date().getFullYear() - 1;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="סיכום שנתי"
        subtitle="היכן הסתיימה השנה — מאזן, מיפוי, פרוייקטים ו־RSU בעמוד אחד"
        back={{ href: "/", label: "חזרה ללוח המחוונים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <Notices error={first(params.error)} detail={first(params.detail)} done={first(params.done)} />

        {loaded.kind === "ok" ? (
          <>
            <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
              <h2 className="text-sm font-semibold tracking-wide text-stone-500">
                מה נשמר ומה מחושב מחדש
              </h2>
              <p className="mt-2 text-sm text-stone-600">
                סיכום שנתי מקפיא רק את מה שאי אפשר לשחזר: שער הדולר בסגירה, מחיר המניה, וההערכות
                שניתנו לפרוייקטי הנדל&rdquo;ן. הכנסות, הוצאות וחיסכון נקראים מהמאזן בכל פתיחה של
                הדף — תיקון של רישום ישן זורם פנימה במקום להשאיר מספר קפוא שגוי. כל סכום על המסך
                אומר על מה הוא נשען.
              </p>
            </section>

            {loaded.readings.length === 0 ? (
              <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
                עדיין אין סיכום שנתי. סיכום נפתח לשנה שהסתיימה, ומרכז במקום אחד את מה שחמישה מסכים
                אומרים בנפרד.
              </p>
            ) : (
              <>
                <ul className="space-y-4">
                  {loaded.readings.map((reading) => (
                    <li key={reading.review.year}>
                      <ReviewCard reading={reading} />
                    </li>
                  ))}
                </ul>

                {loaded.readings.length < 2 ? null : (
                  <p className="text-sm">
                    <Link href="/annual/compare" className="underline underline-offset-4">
                      השוואת שתי שנים זו מול זו ←
                    </Link>
                  </p>
                )}
              </>
            )}

            <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
              <h2 className="text-sm font-semibold tracking-wide text-stone-500">סיכום שנתי חדש</h2>
              <p className="mt-1 text-sm text-stone-600">
                העובדות שהוקפאו נזרעות מהמיפוי האחרון שנלקח עד 31 בדצמבר של אותה שנה — השער ומחיר
                המניה של אותה קריאה. כולן ניתנות לתיקון אחר כך, ומה שלא נמצא נשאר ריק ומסומן כחסר
                במקום להתמלא בניחוש.
              </p>

              <form action={createAnnualReview} className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="שנה">
                  <input
                    name="year"
                    type="number"
                    required
                    min={2000}
                    max={2100}
                    defaultValue={lastClosedYear}
                    className="tabular w-full rounded-md border border-stone-300 px-3 py-2"
                  />
                </Field>

                <Field label="הערה" note="לא חייבת. במילים שלכם">
                  <input
                    name="note"
                    maxLength={400}
                    className="w-full rounded-md border border-stone-300 px-3 py-2"
                  />
                </Field>

                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    className="rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
                  >
                    יצירת סיכום
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <UnavailablePanel reason={loaded.reason} />
        )}
      </main>
    </div>
  );
}

// --- loading ------------------------------------------------------------------

type Loaded =
  | { kind: "ok"; person: Person | null; readings: readonly AnnualReviewReading[] }
  | { kind: "unavailable"; reason: string };

/**
 * The list reads the ledger once and hands it to the same `readAnnualReview` the
 * year's own page uses, with the heavier records left out. One function, so a year
 * cannot read one way here and another way there.
 */
async function loadPage(email: string): Promise<Loaded> {
  try {
    const [person, reviews, ledger, categories] = await Promise.all([
      findPersonByEmail(email),
      loadAnnualReviews(),
      loadLedger(),
      loadCategories(),
    ]);

    const today = monthOf(new Date());
    return {
      kind: "ok",
      person,
      readings: reviewsInReadingOrder(reviews).map((review) =>
        readAnnualReview({ review, ledger, categories, currency: REVIEW_CURRENCY, today }),
      ),
    };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- one year in the list ------------------------------------------------------

function ReviewCard({ reading }: { reading: AnnualReviewReading }) {
  const { review, balance } = reading;

  return (
    <article className="rounded-lg border border-stone-300 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold">
          <Link href={`/annual/${review.year}`} className="underline-offset-4 hover:underline">
            <bdi className="tabular">{review.year}</bdi>
          </Link>
        </h2>
        <p className="text-sm text-stone-500">נכתב ב־{formatDate(review.recordedOn)}</p>
      </div>

      {review.note === null ? null : (
        <p className="mt-2 text-sm text-stone-600">
          <bdi>{review.note}</bdi>
        </p>
      )}

      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <StatedFigure label="הכנסות" figure={balance.income} />
        <StatedFigure label="הוצאות" figure={balance.expenses} />
        <StatedFigure
          label="חיסכון"
          figure={balance.saving}
          note={monthsRecorded(balance.recordedMonths)}
          emphasis
        />
      </dl>

      {reading.missing.length === 0 ? null : (
        <p className="mt-3 text-xs text-amber-800">
          חסרות עובדות שרק יום הסגירה יכול לספק:{" "}
          <bdi>{reading.missing.map((fact) => FROZEN_FACT_LABELS[fact]).join(", ")}</bdi>.
        </p>
      )}
    </article>
  );
}
