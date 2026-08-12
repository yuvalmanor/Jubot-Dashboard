import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { loadCategories } from "@/db/categories";
import { DatabaseNotConfiguredError } from "@/db/client";
import { loadLedger } from "@/db/ledger";
import { type DatedRate, findLatestRate } from "@/db/money-settings";
import { type Person, findPersonByEmail } from "@/db/people";
import { loadFundingPlans, loadPlannedSources, loadScenarios } from "@/db/planning";
import { format } from "@/domain/money/money";
import { type SavingPace, type ScenarioReading, readScenarios } from "@/domain/planning/scenarios";
import { dateOf, formatDate } from "@/domain/time/calendar-date";
import { formatMonth } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { createScenario } from "./actions";
import {
  Field,
  Figure,
  Notices,
  PacePanel,
  RateFigure,
  UnavailablePanel,
  closureReason,
  currentPace,
  monthsText,
  sourcesCount,
} from "./panels";

export const dynamic = "force-dynamic";

/**
 * לוח תכנון — every what-if at once.
 *
 * Nothing on this screen is a stored figure. Each scenario's gap is
 * `needs − Σ(sources)` computed on read, and the months to close it are that gap over
 * the pace the מאזן says the household is currently saving at — so a scenario cannot
 * disagree with its own page, and neither can disagree with the ledger.
 */

interface SearchParams {
  error?: string | string[];
  detail?: string | string[];
  done?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PlanningPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const loaded = await loadPage(email);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="לוח תכנון"
        subtitle="תרחישים ותוכניות מימון — נקראים מהמספרים האמיתיים, ואינם כותבים אליהם דבר"
        back={{ href: "/", label: "חזרה ללוח המחוונים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <Notices error={first(params.error)} detail={first(params.detail)} done={first(params.done)} />

        {loaded.kind === "ok" ? (
          <>
            <PacePanel pace={loaded.pace} />

            {loaded.readings.length === 0 ? (
              <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
                אין עדיין תרחישים. תרחיש הוא מחשבה עם שם — &rdquo;CGM 3 ב־2027&ldquo; — ואפשר להחזיק
                אותה בלי לגעת בשום דבר שנרשם.
              </p>
            ) : (
              <>
                <ul className="space-y-4">
                  {loaded.readings.map((reading) => (
                    <li key={reading.scenario.id}>
                      <ScenarioCard reading={reading} rate={loaded.rate} />
                    </li>
                  ))}
                </ul>

                {loaded.readings.length < 2 ? null : (
                  <p className="text-sm">
                    <Link href="/planning/compare" className="underline underline-offset-4">
                      השוואת שני תרחישים זה מול זה ←
                    </Link>
                  </p>
                )}
              </>
            )}

            <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
              <h2 className="text-sm font-semibold tracking-wide text-stone-500">תרחיש חדש</h2>
              <p className="mt-1 text-sm text-stone-600">
                תרחיש חדש נזרע מהמספרים הרשומים: הכסף הנזיל הפנוי מהמיפוי האחרון נכנס אליו כמקור,
                עם התאריך של אותה קריאה. מה שההשקעה דורשת נרשם אחר כך, בדף התרחיש עצמו.
              </p>

              <form action={createScenario} className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="שם התרחיש">
                  <input
                    name="name"
                    required
                    maxLength={80}
                    placeholder="CGM 3 ב־2027"
                    className="w-full rounded-md border border-stone-300 px-3 py-2"
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
                    יצירת תרחיש
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

// --- loading -----------------------------------------------------------------

type Loaded =
  | {
      kind: "ok";
      person: Person | null;
      readings: readonly ScenarioReading[];
      pace: SavingPace;
      rate: DatedRate | null;
    }
  | { kind: "unavailable"; reason: string };

async function loadPage(email: string): Promise<Loaded> {
  try {
    const [person, scenarios, plans, sources, ledger, categories, rate] = await Promise.all([
      findPersonByEmail(email),
      loadScenarios(),
      loadFundingPlans(),
      loadPlannedSources(),
      loadLedger(),
      loadCategories(),
      findLatestRate("USD", "ILS"),
    ]);

    const pace = currentPace(ledger, categories);
    return {
      kind: "ok",
      person,
      readings: readScenarios({ scenarios, plans, sources, pace, rate }),
      pace,
      rate,
    };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- one scenario in the list -------------------------------------------------

function ScenarioCard({ reading, rate }: { reading: ScenarioReading; rate: DatedRate | null }) {
  const { scenario, plan, gap, closure } = reading;

  return (
    <article className="rounded-lg border border-stone-300 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold">
          <Link href={`/planning/${scenario.id}`} className="underline-offset-4 hover:underline">
            <bdi>{scenario.name}</bdi>
          </Link>
          {scenario.active ? (
            <span className="ms-2 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 align-middle text-xs font-medium text-emerald-900">
              התוכנית שאחריה עוקבים
            </span>
          ) : null}
        </h2>
        <p className="text-sm text-stone-500">
          נוצר ב־{formatDate(scenario.createdOn)}
          {plan === null ? null : <> · נדרש עד {formatDate(plan.neededBy)}</>}
        </p>
      </div>

      {scenario.note === null ? null : (
        <p className="mt-2 text-sm text-stone-600">
          <bdi>{scenario.note}</bdi>
        </p>
      )}

      {plan === null || gap === null ? (
        <p className="mt-3 text-sm text-stone-500">
          עדיין לא נרשם מה ההשקעה דורשת. תרחיש בלי תוכנית מימון הוא שם ומחשבה, וזה מצב תקין.
        </p>
      ) : (
        <>
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <Figure label="דרוש" amount={format(gap.needs)} note={`עד ${formatDate(plan.neededBy)}`} />
            <Figure
              label="מכוסה ממקורות"
              amount={format(gap.covered)}
              note={sourcesCount(reading.sources.length)}
            />
            <Figure
              label={gap.surplus === null ? "פער המימון" : "מעל הדרוש"}
              amount={format(gap.surplus ?? gap.gap)}
              note={gap.closed ? "התוכנית מכוסה" : "דרוש פחות מכוסה"}
              emphasis
            />
          </dl>

          <p className="mt-3 text-sm text-stone-700">
            {closure === null ? null : closure.basis === "already-covered" ? (
              <>{monthsText(0)}.</>
            ) : closure.months === null ? (
              <>{closureReason(closure.basis)}</>
            ) : (
              <>
                {monthsText(closure.months)} סוגרים את הפער
                {closure.closesIn === null ? null : <> — כלומר ב{formatMonth(closure.closesIn)}</>}
                {closure.rate === null ? null : (
                  <>
                    , בשער <RateFigure rate={closure.rate.rate} />
                    {rate === null ? null : <> מ־{formatDate(dateOf(rate.asOf))}</>}
                  </>
                )}
                .
              </>
            )}
          </p>
        </>
      )}

      {gap === null || gap.unreadable.length === 0 ? null : (
        <p className="mt-2 text-xs text-amber-800">
          {gap.unreadable.length === 1 ? "מקור אחד" : `${gap.unreadable.length} מקורות`} במטבע אחר
          ואין שער להמיר בו, ולכן אינם נספרים במכוסה.
        </p>
      )}
    </article>
  );
}
