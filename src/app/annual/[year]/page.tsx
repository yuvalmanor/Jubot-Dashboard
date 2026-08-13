import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { BasisNote } from "@/components/basis-note";
import { findAnnualReviewFor } from "@/db/annual";
import { DatabaseNotConfiguredError } from "@/db/client";
import { type Person, findPersonByEmail } from "@/db/people";
import {
  type AnnualReviewReading,
  type ProjectLine,
} from "@/domain/annual/annual-review";
import { format, toDecimalString } from "@/domain/money/money";
import { formatSharePrice, sharePriceToDecimalString } from "@/domain/rsu/rsu-position";
import { formatDate } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

import { removeAnnualReview, saveFrozenFacts, saveValuation } from "../actions";
import {
  BasisBadge,
  CountFigure,
  FROZEN_FACT_LABELS,
  Field,
  Notices,
  Section,
  StatedFigure,
  UnavailablePanel,
  formatRate,
  monthsRecorded,
} from "../panels";
import { type ReviewContext, contextFor } from "../reading";

export const dynamic = "force-dynamic";

/**
 * One year, across every feature at once — the מאזן bottom line, the closing
 * מיפוי, the projects and the RSU position — rather than five screens.
 *
 * Every amount here is rendered through `StatedFigure`, which takes the domain's
 * `Stated` and nothing else, so each one arrives with the basis it rests on. That
 * is what makes ADR 0002's consequence safe: two prints of this page months apart
 * can disagree on חיסכון, and the reader can see at a glance that חיסכון was never
 * a stored number to begin with.
 */

interface SearchParams {
  error?: string | string[];
  detail?: string | string[];
  done?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AnnualReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ year: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const email = await requireHouseholdEmail();
  const { year } = await params;
  const search = await searchParams;
  const loaded = await loadPage(email, Number(year));

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "unavailable" ? null : loaded.person}
        title={`סיכום שנתי ${year}`}
        subtitle={
          loaded.kind === "ok"
            ? `היכן הסתיימה השנה, נכון ל־${formatDate(loaded.context.reading.closesOn)}`
            : "היכן הסתיימה השנה"
        }
        back={{ href: "/annual", label: "חזרה לסיכומים השנתיים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <Notices error={first(search.error)} detail={first(search.detail)} done={first(search.done)} />

        {loaded.kind === "unavailable" ? (
          <UnavailablePanel reason={loaded.reason} />
        ) : loaded.kind === "missing" ? (
          <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
            אין סיכום שנתי לשנת <bdi className="tabular">{year}</bdi>.{" "}
            <Link href="/annual" className="underline underline-offset-4">
              פתיחת סיכום חדש
            </Link>
          </p>
        ) : (
          <ReviewBody context={loaded.context} />
        )}
      </main>
    </div>
  );
}

// --- loading -------------------------------------------------------------------

type Loaded =
  | { kind: "ok"; person: Person | null; context: ReviewContext }
  | { kind: "missing"; person: Person | null }
  | { kind: "unavailable"; reason: string };

async function loadPage(email: string, year: number): Promise<Loaded> {
  try {
    const person = await findPersonByEmail(email);
    if (!Number.isInteger(year)) return { kind: "missing", person };

    const review = await findAnnualReviewFor(year);
    if (review === null) return { kind: "missing", person };

    return { kind: "ok", person, context: await contextFor(review) };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- the page ------------------------------------------------------------------

function ReviewBody({ context }: { context: ReviewContext }) {
  const { reading } = context;

  return (
    <>
      {reading.review.note === null ? null : (
        <p className="rounded-lg border border-stone-300 bg-white p-5 text-sm text-stone-700">
          <bdi>{reading.review.note}</bdi>
        </p>
      )}

      <BalancePanel reading={reading} />
      <NetWorthPanel reading={reading} />
      <ProjectsPanel context={context} />
      <RsuPanel reading={reading} />
      <FrozenFactsPanel context={context} />
      <RemovePanel reading={reading} />
    </>
  );
}

// --- מאזן, live ----------------------------------------------------------------

function BalancePanel({ reading }: { reading: AnnualReviewReading }) {
  const { balance } = reading;

  return (
    <Section title="מאזן הכנסות-הוצאות" subtitle={`שנת ${balance.year}`}>
      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <StatedFigure label="הכנסות" figure={balance.income} />
        <StatedFigure label="הוצאות" figure={balance.expenses} />
        <StatedFigure label="חיסכון" figure={balance.saving} emphasis />
      </dl>

      <p className="mt-3 text-sm text-stone-600">
        {monthsRecorded(balance.recordedMonths)} מתוך{" "}
        <bdi className="tabular">{balance.denominator}</bdi> בשנה.{" "}
        {balance.recordedMonths < balance.denominator
          ? "שנה שנרשמה רק בחלקה נראית זולה יותר משהייתה, ולכן המכנה נאמר כאן ולא מוסתר."
          : "השנה נרשמה במלואה."}
      </p>

      <p className="mt-3 text-xs text-stone-500">
        שלושת הסכומים האלה אינם שמורים בשום מקום: הם נקראים מהמאזן דרך אותו נתיב שכל מסכי המאזן
        קוראים בו, בכל פתיחה של הדף. תיקון של חודש מהשנה הזו ישנה אותם — וזו הסיבה שהם אינם
        קפואים.{" "}
        <Link href="/balance/insights" className="underline underline-offset-4">
          מגמות המאזן
        </Link>
      </p>
    </Section>
  );
}

// --- מיפוי ----------------------------------------------------------------------

function NetWorthPanel({ reading }: { reading: AnnualReviewReading }) {
  const { netWorth } = reading;

  return (
    <Section
      title="מיפוי הסגירה"
      subtitle={netWorth === null ? undefined : `נלקח ב־${formatDate(netWorth.takenOn)}`}
    >
      {netWorth === null ? (
        <p className="mt-2 text-sm text-stone-600">
          לא נבחר מיפוי שעליו נסגרה השנה. בלי קריאה אין שווי לסגירה, וזה מצב תקין —{" "}
          {FROZEN_FACT_LABELS["closing-snapshot"]} נבחר למטה.
        </p>
      ) : (
        <>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <StatedFigure
              label="סך הכל"
              figure={netWorth.total}
              note={`${netWorth.accountCount} חשבונות בקריאה`}
              emphasis
            />
            <div>
              <dt className="text-xs text-stone-500">הקריאה עצמה</dt>
              <dd className="mt-1 text-lg">
                <Link
                  href={`/snapshots/${netWorth.snapshotId}`}
                  className="underline underline-offset-4"
                >
                  {formatDate(netWorth.takenOn)} ←
                </Link>
              </dd>
            </div>
          </dl>

          {netWorth.split === null ? (
            <p className="mt-3 text-sm text-amber-800">
              המיפוי אינו נושא שער למטבע שהוא מחזיק, ולכן אין לו סך הכל בשקלים. סכום שהשמיט את
              חשבונות הדולר, או המיר אותם בשער של היום, היה גרוע מהיעדר סכום.
            </p>
          ) : (
            <BasisNote split={netWorth.split} className="mt-3" />
          )}

          {netWorth.withinYear ? null : (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              הקריאה הזו נלקחה ב־{formatDate(netWorth.takenOn)}, כלומר לא בתוך השנה שהיא סוגרת.
            </p>
          )}

          <p className="mt-3 text-xs text-stone-500">
            הסכום מומר בשער של המיפוי עצמו ולא בשער שהוקפא כאן: קריאה ממשיכה להיקרא כפי שנקראה
            ביום שנלקחה.
          </p>
        </>
      )}
    </Section>
  );
}

// --- נכסים ופרוייקטים ------------------------------------------------------------

function ProjectsPanel({ context }: { context: ReviewContext }) {
  const { reading, projects } = context;
  const { lines, cost, valuation, unreadable, unvalued } = reading.projects;

  return (
    <Section title="נכסים ופרוייקטים" subtitle={`${lines.length} פרוייקטים`}>
      {lines.length === 0 ? (
        <p className="mt-2 text-sm text-stone-600">לא נרשמו פרוייקטים.</p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-right text-xs text-stone-500">
                  <th className="py-2 font-medium">פרוייקט</th>
                  <th className="py-2 font-medium">
                    עלות
                    <BasisBadge basis="live" />
                  </th>
                  <th className="py-2 font-medium">הוצא</th>
                  <th className="py-2 font-medium">יתרה</th>
                  <th className="py-2 font-medium">
                    הערכה בסגירה
                    <BasisBadge basis="frozen" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <ProjectRow key={line.project.id} line={line} year={reading.review.year} />
                ))}
              </tbody>
            </table>
          </div>

          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <StatedFigure label="סך העלויות" figure={cost} />
            <StatedFigure label="סך ההערכות" figure={valuation} />
          </dl>

          {unreadable.length === 0 ? null : (
            <p className="mt-3 text-xs text-amber-800">
              אין סך כולל: {unreadable.length === 1 ? "פרוייקט אחד" : `${unreadable.length} פרוייקטים`}{" "}
              במטבע אחר ולא הוקפא שער להמיר בו. סכום שהיה משמיט אותם היה מספר קטן שמוצג כשלם.
            </p>
          )}

          {unvalued.length === 0 ? null : (
            <p className="mt-2 text-xs text-stone-500">
              פרוייקטים שלא ניתנה להם הערכה נספרים בעלות בלבד. הערכה היא שיפוט של אדם, והיעדרה
              אינו שווי של אפס.
            </p>
          )}

          <p className="mt-3 text-xs text-stone-500">
            ההערכה נשמרת על הסיכום בלבד. לפי ADR 0003 נכס לא נזיל מוחזק בעלות ואינו מוערך מחדש,
            ולכן שום דבר כאן אינו נכתב לתוך המיפוי — ההערכה יושבת לצד העלות, וההפרש נאמר.
          </p>
        </>
      )}

      {projects.length === 0 ? null : (
        <p className="mt-4 text-xs text-stone-500">
          <Link href="/projects" className="underline underline-offset-4">
            נכסים ופרוייקטים ←
          </Link>
        </p>
      )}
    </Section>
  );
}

function ProjectRow({ line, year }: { line: ProjectLine; year: number }) {
  const { project, valuation, aboveCost } = line;

  return (
    <tr className="border-b border-stone-100 align-top">
      <td className="py-3">
        <Link href={`/projects/${project.id}`} className="underline-offset-4 hover:underline">
          <bdi>{project.name}</bdi>
        </Link>
        <p className="text-xs text-stone-500">{project.currency}</p>
      </td>
      <td className="tabular py-3">
        <bdi>{format(line.cost.value)}</bdi>
      </td>
      <td className="tabular py-3">
        <bdi>{format(line.spent.value)}</bdi>
      </td>
      <td className="tabular py-3">
        <bdi>{format(line.balance.value)}</bdi>
      </td>
      <td className="py-3">
        <form action={saveValuation} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="year" value={year} />
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="currency" value={valuation?.value.currency ?? project.currency} />
          <input
            name="amount"
            inputMode="decimal"
            defaultValue={valuation === null ? "" : toDecimalString(valuation.value)}
            placeholder="ריק = אין הערכה"
            className="tabular w-32 rounded-md border border-stone-300 px-2 py-1"
          />
          <button
            type="submit"
            className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-medium hover:bg-stone-50"
          >
            שמירה
          </button>
        </form>
        {aboveCost === null ? (
          valuation === null ? null : (
            <p className="mt-1 text-xs text-stone-500">ההערכה במטבע אחר מהעלות — אין הפרש להציג.</p>
          )
        ) : (
          <p className="tabular mt-1 text-xs text-stone-500">
            {aboveCost.minorUnits >= 0 ? "מעל העלות" : "מתחת לעלות"}:{" "}
            <bdi>{format(aboveCost)}</bdi>
          </p>
        )}
      </td>
    </tr>
  );
}

// --- מחשבון RSU ------------------------------------------------------------------

function RsuPanel({ reading }: { reading: AnnualReviewReading }) {
  const { rsu } = reading;

  return (
    <Section
      title="מחשבון RSU"
      subtitle={rsu === null ? undefined : `הפוזיציה ל־${formatDate(rsu.asOf)}`}
    >
      {rsu === null ? (
        <p className="mt-2 text-sm text-stone-600">
          לא נרשמו מענקים, ולכן אין פוזיציה לדווח עליה. זו שתיקה ולא החזקה של אפס.
        </p>
      ) : (
        <>
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <CountFigure label="מניות מוחזקות" figure={rsu.shares} />
            <CountFigure label="אחרי התקופה" figure={rsu.qualifiedShares} />
            <CountFigure label="לפני התקופה" figure={rsu.unqualifiedShares} />
          </dl>

          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-stone-500">
                מחיר המניה בסגירה
                {rsu.price === null ? null : <BasisBadge basis={rsu.price.basis} />}
              </dt>
              <dd className="tabular mt-1 text-lg">
                {rsu.price === null ? (
                  <span className="text-base font-normal text-stone-500">לא הוקפא מחיר</span>
                ) : (
                  <bdi>{formatSharePrice(rsu.price.value)}</bdi>
                )}
              </dd>
            </div>
            <StatedFigure label="שווי ההחזקה" figure={rsu.value} />
            <StatedFigure label="שווי בשקלים" figure={rsu.valueInCurrency} emphasis />
          </dl>

          <p className="mt-3 text-xs text-stone-500">
            ספירת המניות נגזרת מהמענקים, ההבשלות והמכירות נכון ל־{formatDate(rsu.asOf)} ואינה
            נשמרת כאן; המחיר והשער הם עובדות של יום הסגירה ונשמרים. לכן השווי אינו חי ואינו קפוא
            אלא שילוב של השניים, והוא אומר זאת.{" "}
            <Link href="/rsu" className="underline underline-offset-4">
              מחשבון RSU
            </Link>
          </p>
        </>
      )}
    </Section>
  );
}

// --- the frozen facts themselves --------------------------------------------------

function FrozenFactsPanel({ context }: { context: ReviewContext }) {
  const { reading, snapshots } = context;
  const { review } = reading;

  return (
    <Section title="עובדות שהוקפאו" subtitle={`נכתב ב־${formatDate(review.recordedOn)}`}>
      <p className="mt-2 text-sm text-stone-600">
        רק מה שאי אפשר לשחזר נשמר כאן. השאר בעמוד הזה מחושב מחדש מהרישומים בכל קריאה, ולכן אינו
        יכול להתיישן מאחורי תיקון.
      </p>

      {reading.missing.length === 0 ? null : (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          חסר: <bdi>{reading.missing.map((fact) => FROZEN_FACT_LABELS[fact]).join(", ")}</bdi>. מה
          שלא נרשם ביום הסגירה לא ניתן לשחזור, ולכן הוא נאמר כחסר ולא מומצא.
        </p>
      )}

      <form action={saveFrozenFacts} className="mt-4 grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="year" value={review.year} />

        <Field label={FROZEN_FACT_LABELS["closing-snapshot"]}>
          <select
            name="closingSnapshotId"
            defaultValue={review.closingSnapshotId ?? ""}
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2"
          >
            <option value="">— לא נבחר —</option>
            {snapshots.map((snapshot) => (
              <option key={snapshot.id} value={snapshot.id}>
                {formatDate(snapshot.takenOn)}
              </option>
            ))}
          </select>
        </Field>

        <Field label={FROZEN_FACT_LABELS["closing-rate"]} note="USD/ILS. ריק = לא ידוע">
          <input
            name="closingRate"
            inputMode="decimal"
            defaultValue={review.closingRate === null ? "" : String(review.closingRate.rate)}
            placeholder="3.6500"
            className="tabular w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <Field label={FROZEN_FACT_LABELS["closing-share-price"]} note="ריק = לא ידוע">
          <input
            name="closingSharePrice"
            inputMode="decimal"
            defaultValue={
              review.closingSharePrice === null
                ? ""
                : sharePriceToDecimalString(review.closingSharePrice)
            }
            placeholder="280.0000"
            className="tabular w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <Field label="מטבע המחיר">
          <select
            name="sharePriceCurrency"
            defaultValue={review.closingSharePrice?.currency ?? "USD"}
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2"
          >
            <option value="USD">USD</option>
            <option value="ILS">ILS</option>
          </select>
        </Field>

        <Field label="הערה" note="לא חייבת">
          <input
            name="note"
            maxLength={400}
            defaultValue={review.note ?? ""}
            className="w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <div className="sm:col-span-2">
          <button
            type="submit"
            className="rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
          >
            שמירת העובדות
          </button>
        </div>
      </form>

      {review.closingRate === null ? null : (
        <p className="mt-3 text-xs text-stone-500">
          השער שהוקפא — <bdi className="tabular">{formatRate(review.closingRate.rate)}</bdi> — משמש
          רק את הסכומים שהסיכום מחשב בעצמו. המיפוי ממשיך להמיר בשער שלו.
        </p>
      )}
    </Section>
  );
}

function RemovePanel({ reading }: { reading: AnnualReviewReading }) {
  return (
    <section className="rounded-lg border border-stone-200 bg-white/60 p-5">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">הסרת הסיכום</h2>
      <p className="mt-1 text-sm text-stone-600">
        הסרה מוחקת את העובדות שהוקפאו ואת ההערכות, ולא נוגעת בשום רישום אחר: המאזן, המיפוי,
        הפרוייקטים והמענקים נשארים כפי שהם.
      </p>
      <form action={removeAnnualReview} className="mt-3">
        <input type="hidden" name="year" value={reading.review.year} />
        <button
          type="submit"
          className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-900 hover:bg-red-50"
        >
          הסרת הסיכום של {reading.review.year}
        </button>
      </form>
    </section>
  );
}
