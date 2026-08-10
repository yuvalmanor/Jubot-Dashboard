import type { Route } from "next";
import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { loadCategories } from "@/db/categories";
import { DatabaseNotConfiguredError } from "@/db/client";
import { loadLedger } from "@/db/ledger";
import { type Person, findPersonByEmail, listPeople } from "@/db/people";
import { type Categories } from "@/domain/categories/categories";
import { type Ledger, recordedMonths } from "@/domain/ledger/ledger";
import {
  type AnalyticsScope,
  DEFAULT_TRAILING_WINDOW,
  HOUSEHOLD_SCOPE,
  availableToMove,
  categoryBreakdown,
  monthPeriod,
  monthlyTrend,
  personScope,
  rankCategoryDeviations,
  yearOverYear,
  yearPeriod,
} from "@/domain/ledger/ledger-analytics";
import {
  type CalendarMonth,
  addMonths,
  compareMonths,
  formatMonth,
  monthKey,
  monthOf,
  tryParseMonthKey,
} from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { SavingRateChart, TrendChart } from "./charts";
import {
  AvailablePanel,
  BreakdownPanel,
  DeviationsPanel,
  Panel,
  TrendTable,
  YearOverYearPanel,
} from "./panels";

export const dynamic = "force-dynamic";

/**
 * מגמות, ממוצעים וחריגות — the reading half of the מאזן.
 *
 * The screen is driven by one control, a focus month, so there is never a
 * question of which month a figure belongs to. Everything else follows from it:
 * the trend is the twelve months ending there, the year panels are that month's
 * year, and the deviations are that month against the six before it.
 *
 * Period averages divide by the months elapsed as of *today*, not as of the focus
 * month — a complete past year divides by twelve however far back it is read
 * from. Every average prints that denominator beside itself.
 */

/** The ledger is kept in shekels. Explicit, never assumed from context. */
const LEDGER_CURRENCY = "ILS" as const;

const HOUSEHOLD_VIEW = "household";

/** Twelve months ending at the focus month: a full year of trend, one year of comparison. */
const TREND_MONTHS = 12;

interface SearchParams {
  month?: string | string[];
  view?: string | string[];
  period?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function InsightsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const today = monthOf(new Date());
  const loaded = await loadInsights(email);

  const requestedMonth = tryParseMonthKey(first(params.month));
  const focus =
    requestedMonth ?? (loaded.kind === "ok" ? latestRecordedMonth(loaded.ledger, today) : today);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="מגמות וממוצעים"
        subtitle="מה חריג, לאן הלך הכסף, ומול מה זה נמדד"
        back={{ href: "/balance", label: "חזרה למאזן" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        {loaded.kind === "ok" ? (
          <Insights
            people={loaded.people}
            signedInPersonId={loaded.person.id}
            categories={loaded.categories}
            ledger={loaded.ledger}
            focus={focus}
            today={today}
            view={first(params.view)}
            period={first(params.period) === "month" ? "month" : "year"}
            usingDefaultMonth={requestedMonth === null}
          />
        ) : (
          <UnavailablePanel reason={loaded.reason} />
        )}
      </main>
    </div>
  );
}

// --- loading -------------------------------------------------------------------

type LoadedInsights =
  | { kind: "ok"; person: Person; people: readonly Person[]; categories: Categories; ledger: Ledger }
  | { kind: "unavailable"; reason: string };

async function loadInsights(email: string): Promise<LoadedInsights> {
  try {
    const person = await findPersonByEmail(email);
    if (person === null) {
      return {
        kind: "unavailable",
        reason: `הכתובת ${email} אינה משויכת לאף אדם בטבלת people. יש לעדכן את שתי הכתובות במסד (ראו README).`,
      };
    }
    // The whole ledger: a trend, a trailing average and a year-over-year reading
    // are all questions about months other than the one on screen.
    const [people, categories, ledger] = await Promise.all([listPeople(), loadCategories(), loadLedger()]);
    return { kind: "ok", person, people, categories, ledger };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The last month that holds a figure, at or before today. Opening on an empty
 * current month would make a screen full of history look broken; opening on a
 * future month would be worse. The panel names whichever month it landed on.
 */
function latestRecordedMonth(ledger: Ledger, today: CalendarMonth): CalendarMonth {
  const months = recordedMonths(ledger).filter((month) => compareMonths(month, today) <= 0);
  return months[months.length - 1] ?? today;
}

// --- the reading ----------------------------------------------------------------

function Insights({
  people,
  signedInPersonId,
  categories,
  ledger,
  focus,
  today,
  view,
  period,
  usingDefaultMonth,
}: {
  people: readonly Person[];
  signedInPersonId: string;
  categories: Categories;
  ledger: Ledger;
  focus: CalendarMonth;
  today: CalendarMonth;
  view: string | undefined;
  period: "year" | "month";
  usingDefaultMonth: boolean;
}) {
  const scope = resolveScope(view, people);
  const scopeKey = scope.kind === "household" ? HOUSEHOLD_VIEW : scope.personId;
  const peopleNames = new Map(people.map((person) => [person.id, person.displayName]));
  const scopeName =
    scope.kind === "household" ? "משק הבית" : (peopleNames.get(scope.personId) ?? scope.personId);

  const available = availableToMove(ledger, categories, scope, focus, LEDGER_CURRENCY);
  const trend = monthlyTrend(
    ledger,
    categories,
    scope,
    addMonths(focus, -(TREND_MONTHS - 1)),
    focus,
    LEDGER_CURRENCY,
  );
  const deviations = rankCategoryDeviations(ledger, categories, scope, focus, LEDGER_CURRENCY);
  const breakdown = categoryBreakdown(
    ledger,
    categories,
    scope,
    period === "month" ? monthPeriod(focus) : yearPeriod(focus.year),
    LEDGER_CURRENCY,
    today,
  );
  const comparison = yearOverYear(ledger, categories, scope, focus.year, LEDGER_CURRENCY, today);

  return (
    <>
      <Controls focus={focus} scopeKey={scopeKey} people={people} period={period} />

      {usingDefaultMonth ? (
        <p className="text-sm text-stone-500">
          נפתח על החודש האחרון שנרשם בו משהו. אפשר לבחור כל חודש אחר למעלה.
        </p>
      ) : null}

      <AvailablePanel
        available={available}
        note={
          scope.kind === "household"
            ? `חיסכון = הכנסות − הוצאות, נגזר בזמן הקריאה מהקטגוריות האישיות של שני בני הבית. אין לאן לכתוב אותו.`
            : `הקטגוריות של ${scopeName} בלבד. החיסכון המשותף נמצא בלשונית "משק הבית".`
        }
      />

      <DeviationsPanel
        deviations={deviations}
        window={DEFAULT_TRAILING_WINDOW}
        monthLabel={formatMonth(focus)}
      />

      <Panel
        title={`מגמה חודשית — ${TREND_MONTHS} החודשים עד ${formatMonth(focus)}`}
        note="כל חודש מוצג לצד אותו חודש בשנה שעברה. חודש שלא נרשם בו דבר נשאר ריק ולא מצויר כאפס."
      >
        <div className="px-5 py-4">
          <TrendChart points={trend} label={`הכנסות, הוצאות וחיסכון של ${scopeName} לפי חודש`} />
        </div>
        <TrendTable points={trend} />
      </Panel>

      <Panel
        title="שיעור חיסכון לאורך זמן"
        note="חיסכון כאחוז מההכנסות — האם באמת משתפרים, או רק מרוויחים יותר."
      >
        <div className="px-5 py-4">
          <SavingRateChart points={trend} label={`שיעור החיסכון של ${scopeName} לפי חודש`} />
        </div>
      </Panel>

      <BreakdownPanel
        breakdown={breakdown}
        peopleNames={peopleNames}
        title={
          period === "month" ? `פילוח קטגוריות — ${formatMonth(focus)}` : `פילוח קטגוריות — ${focus.year}`
        }
        note={
          period === "month"
            ? "חודש אחד. הממוצע החודשי זהה לסכום, והמכנה הוא חודש אחד."
            : `שנת ${focus.year}. הממוצע החודשי מחלק בחודשים שחלפו, וכל שורה אומרת במה חילקה.`
        }
      />

      <YearOverYearPanel comparison={comparison} title={`מול אותה תקופה ב־${comparison.comparisonYear}`} />
    </>
  );
}

function resolveScope(requested: string | undefined, people: readonly Person[]): AnalyticsScope {
  const person = people.find((candidate) => candidate.id === requested);
  return person === undefined ? HOUSEHOLD_SCOPE : personScope(person.id);
}

// --- controls --------------------------------------------------------------------

function insightsHref(month: CalendarMonth, scopeKey: string, period: "year" | "month"): Route {
  const params = new URLSearchParams({ month: monthKey(month), view: scopeKey });
  if (period === "month") params.set("period", "month");
  return `/balance/insights?${params.toString()}` as Route;
}

function Controls({
  focus,
  scopeKey,
  people,
  period,
}: {
  focus: CalendarMonth;
  scopeKey: string;
  people: readonly Person[];
  period: "year" | "month";
}) {
  const tabs = [
    ...people.map((person) => ({ key: person.id, label: person.displayName })),
    { key: HOUSEHOLD_VIEW, label: "משק הבית" },
  ];

  return (
    <section className="space-y-3 rounded-lg border border-stone-300 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="רמת קריאה" className="flex flex-wrap gap-2">
          {tabs.map((tab) => {
            const active = tab.key === scopeKey;
            return (
              <Link
                key={tab.key}
                href={insightsHref(focus, tab.key, period)}
                aria-current={active ? "page" : undefined}
                className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                  active
                    ? "border-stone-900 bg-stone-900 text-white"
                    : "border-stone-300 bg-white hover:bg-stone-50"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <form className="flex items-center gap-2" action="/balance/insights" method="get">
          <input type="hidden" name="view" value={scopeKey} />
          {period === "month" ? <input type="hidden" name="period" value="month" /> : null}
          <label htmlFor="focus-month" className="text-sm text-stone-600">
            חודש מוקד
          </label>
          <input
            id="focus-month"
            type="month"
            name="month"
            defaultValue={monthKey(focus)}
            min="2000-01"
            max="2100-12"
            className="rounded-md border border-stone-300 px-2 py-1.5 text-sm"
          />
          <button
            type="submit"
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
          >
            הצגה
          </button>
        </form>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-stone-200 pt-3">
        <span className="text-sm text-stone-600">פילוח לפי</span>
        {(
          [
            { key: "year", label: `שנת ${focus.year}` },
            { key: "month", label: formatMonth(focus) },
          ] as const
        ).map((option) => {
          const active = option.key === period;
          return (
            <Link
              key={option.key}
              href={insightsHref(focus, scopeKey, option.key)}
              aria-current={active ? "true" : undefined}
              className={`rounded-md border px-3 py-1 text-sm ${
                active ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white hover:bg-stone-50"
              }`}
            >
              {option.label}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן לקרוא את המגמות</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}
