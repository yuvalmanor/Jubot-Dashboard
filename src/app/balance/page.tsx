import type { Route } from "next";
import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { DatabaseNotConfiguredError } from "@/db/client";
import { loadCategories } from "@/db/categories";
import { loadLedgerForMonth } from "@/db/ledger";
import { type Person, findPersonByEmail, listPeople } from "@/db/people";
import { type Categories } from "@/domain/categories/categories";
import {
  type Ledger,
  householdCategoryLines,
  householdMonthSummary,
  personMonthLines,
  personMonthSummary,
} from "@/domain/ledger/ledger";
import {
  type CalendarMonth,
  addMonths,
  formatMonth,
  monthKey,
  monthOf,
  tryParseMonthKey,
} from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { type BalanceErrorCode } from "./actions";
import { MonthEntry } from "./month-entry";
import { HouseholdReadingTable, PersonReadingTable, SummaryPanel } from "./month-panels";

export const dynamic = "force-dynamic";

/** The ledger is kept in shekels. Explicit, never assumed from context. */
const LEDGER_CURRENCY = "ILS" as const;

const HOUSEHOLD_VIEW = "household";

interface SearchParams {
  month?: string | string[];
  view?: string | string[];
  saved?: string | string[];
  created?: string | string[];
  error?: string | string[];
  detail?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function BalancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const month = tryParseMonthKey(first(params.month)) ?? monthOf(new Date());

  const loaded = await loadBalance(month, email);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="מאזן הכנסות-הוצאות"
        subtitle="רישום חודשי לפי קטגוריות"
        back={{ href: "/", label: "חזרה ללוח המחוונים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <MonthNavigator month={month} view={first(params.view)} />

        <Notices
          saved={first(params.saved) === "1"}
          created={first(params.created)}
          error={first(params.error)}
          detail={first(params.detail)}
        />

        {loaded.kind === "ok" ? (
          <>
            <ViewTabs
              month={month}
              people={loaded.people}
              signedInPersonId={loaded.person.id}
              selected={first(params.view)}
            />
            <MonthView
              month={month}
              view={resolveView(first(params.view), loaded.person, loaded.people)}
              signedInPersonId={loaded.person.id}
              people={loaded.people}
              categories={loaded.categories}
              ledger={loaded.ledger}
            />
          </>
        ) : (
          <UnavailablePanel reason={loaded.reason} />
        )}
      </main>
    </div>
  );
}

// --- loading -----------------------------------------------------------------

type LoadedBalance =
  | { kind: "ok"; person: Person; people: readonly Person[]; categories: Categories; ledger: Ledger }
  | { kind: "unavailable"; reason: string };

async function loadBalance(month: CalendarMonth, email: string): Promise<LoadedBalance> {
  try {
    const person = await findPersonByEmail(email);
    if (person === null) {
      return {
        kind: "unavailable",
        reason: `הכתובת ${email} אינה משויכת לאף אדם בטבלת people. יש לעדכן את שתי הכתובות במסד (ראו README).`,
      };
    }
    const [people, categories, ledger] = await Promise.all([
      listPeople(),
      loadCategories(),
      loadLedgerForMonth(month),
    ]);
    return { kind: "ok", person, people, categories, ledger };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- which of the three readings ---------------------------------------------

type View = { kind: "person"; person: Person } | { kind: "household" };

function resolveView(
  requested: string | undefined,
  signedIn: Person,
  people: readonly Person[],
): View {
  if (requested === HOUSEHOLD_VIEW) return { kind: "household" };
  const person = people.find((candidate) => candidate.id === requested);
  return { kind: "person", person: person ?? signedIn };
}

function balanceHref(month: CalendarMonth, view: string | undefined): Route {
  const params = new URLSearchParams({ month: monthKey(month) });
  if (view !== undefined) params.set("view", view);
  return `/balance?${params.toString()}` as Route;
}

function ViewTabs({
  month,
  people,
  signedInPersonId,
  selected,
}: {
  month: CalendarMonth;
  people: readonly Person[];
  signedInPersonId: string;
  selected: string | undefined;
}) {
  const current = selected === HOUSEHOLD_VIEW ? HOUSEHOLD_VIEW : (selected ?? signedInPersonId);

  const tabs = [
    ...people.map((person) => ({
      key: person.id,
      label: person.id === signedInPersonId ? `${person.displayName} (אני)` : person.displayName,
    })),
    { key: HOUSEHOLD_VIEW, label: "משותף" },
  ];

  return (
    <nav aria-label="רמת קריאה" className="flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const active = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={balanceHref(month, tab.key)}
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
  );
}

function MonthView({
  month,
  view,
  signedInPersonId,
  people,
  categories,
  ledger,
}: {
  month: CalendarMonth;
  view: View;
  signedInPersonId: string;
  people: readonly Person[];
  categories: Categories;
  ledger: Ledger;
}) {
  if (view.kind === "household") {
    return <HouseholdMonth month={month} people={people} categories={categories} ledger={ledger} />;
  }

  if (view.person.id === signedInPersonId) {
    return <MonthEntry month={month} personId={signedInPersonId} categories={categories} ledger={ledger} />;
  }

  return <OtherPersonMonth month={month} person={view.person} categories={categories} ledger={ledger} />;
}

/**
 * The other Person's month. Readable, never writable: a Person records their own
 * spending under their own names, and reading each other's is what the household
 * view is for.
 */
function OtherPersonMonth({
  month,
  person,
  categories,
  ledger,
}: {
  month: CalendarMonth;
  person: Person;
  categories: Categories;
  ledger: Ledger;
}) {
  const income = personMonthLines(ledger, categories, person.id, month, { type: "income" });
  const expenses = personMonthLines(ledger, categories, person.id, month, { type: "expense" });
  const summary = personMonthSummary(ledger, categories, person.id, month, LEDGER_CURRENCY);

  return (
    <div className="space-y-6">
      <SummaryPanel summary={summary} note={`הקטגוריות של ${person.displayName}, לקריאה בלבד.`} />

      {income.length + expenses.length === 0 ? (
        <EmptyPanel>אין ל{person.displayName} קטגוריות בחודש הזה.</EmptyPanel>
      ) : (
        <>
          <PersonReadingTable title="הכנסות" lines={income} />
          <PersonReadingTable title="הוצאות" lines={expenses} />
        </>
      )}
    </div>
  );
}

/**
 * The household's month. Every figure here is derived from the personal ones at
 * read time — there is no household ledger to write to, and nothing on this
 * screen accepts input.
 */
function HouseholdMonth({
  month,
  people,
  categories,
  ledger,
}: {
  month: CalendarMonth;
  people: readonly Person[];
  categories: Categories;
  ledger: Ledger;
}) {
  const summary = householdMonthSummary(ledger, categories, month, LEDGER_CURRENCY);
  const income = householdCategoryLines(ledger, categories, month, LEDGER_CURRENCY, { type: "income" });
  const expenses = householdCategoryLines(ledger, categories, month, LEDGER_CURRENCY, { type: "expense" });

  return (
    <div className="space-y-6">
      <SummaryPanel
        summary={summary}
        note="כל מספר כאן נגזר מהקטגוריות האישיות בזמן הקריאה. אין מאזן משותף שנכתב אליו."
      />

      {income.length + expenses.length === 0 ? (
        <EmptyPanel>אין קטגוריות משותפות בחודש הזה.</EmptyPanel>
      ) : (
        <>
          <HouseholdReadingTable title="הכנסות" lines={income} total={summary.income} people={people} />
          <HouseholdReadingTable title="הוצאות" lines={expenses} total={summary.expenses} people={people} />
          <p className="text-sm text-stone-500">
            פתיחת שורה משותפת מציגה את הקטגוריות האישיות שמרכיבות אותה ואת הסכום של כל אחת.
          </p>
        </>
      )}
    </div>
  );
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
      {children}
    </p>
  );
}

// --- month navigation --------------------------------------------------------

function MonthNavigator({ month, view }: { month: CalendarMonth; view: string | undefined }) {
  const previous = addMonths(month, -1);
  const next = addMonths(month, 1);

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-300 bg-white p-4">
      <div className="flex items-center gap-2">
        {/* In RTL the previous month sits to the right, so the arrows point outward. */}
        <MonthStep href={balanceHref(next, view)} label={formatMonth(next)} glyph="‹" />
        <h2 className="min-w-40 text-center text-lg font-semibold">{formatMonth(month)}</h2>
        <MonthStep href={balanceHref(previous, view)} label={formatMonth(previous)} glyph="›" />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {/* Any month in any year — a four-year-old typo is reachable in one step. */}
        <form className="flex items-center gap-2" action="/balance" method="get">
          {view === undefined ? null : <input type="hidden" name="view" value={view} />}
          <label htmlFor="month-picker" className="text-sm text-stone-600">
            מעבר לחודש
          </label>
          <input
            id="month-picker"
            type="month"
            name="month"
            defaultValue={monthKey(month)}
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

        <Link href="/balance/categories" className="text-sm text-stone-600 underline-offset-4 hover:underline">
          ניהול קטגוריות
        </Link>
      </div>
    </section>
  );
}

function MonthStep({ href, label, glyph }: { href: Route; label: string; glyph: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-lg leading-none hover:bg-stone-50"
    >
      <span aria-hidden="true">{glyph}</span>
    </Link>
  );
}

// --- notices -----------------------------------------------------------------

const ERROR_MESSAGES: Record<BalanceErrorCode, string> = {
  "no-person": "הכתובת שאיתה נכנסת אינה משויכת לאף אדם בטבלת people, ולכן אין ממה לקרוא או למה לכתוב.",
  "bad-amount": "אחד הסכומים אינו מספר. שום דבר לא נשמר.",
  "bad-name": "שם הקטגוריה ריק או ארוך מדי.",
  "duplicate-name": "כבר קיימת קטגוריה בשם הזה.",
  "type-mismatch": "לא ניתן לשייך קטגוריית הכנסה לקטגוריה משותפת של הוצאה, או להפך.",
  "unknown-household": "הקטגוריה המשותפת שנבחרה אינה קיימת.",
  failed: "הפעולה נכשלה.",
};

function isBalanceErrorCode(value: string | undefined): value is BalanceErrorCode {
  return value !== undefined && value in ERROR_MESSAGES;
}

function Notices({
  saved,
  created,
  error,
  detail,
}: {
  saved: boolean;
  created: string | undefined;
  error: string | undefined;
  detail: string | undefined;
}) {
  if (isBalanceErrorCode(error)) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-4" role="alert">
        <p className="font-medium text-red-900">{ERROR_MESSAGES[error]}</p>
        {detail === undefined ? null : (
          <p className="mt-1 text-sm text-red-800">
            <bdi>{detail}</bdi>
          </p>
        )}
      </div>
    );
  }

  if (created !== undefined) {
    return (
      <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4" role="status">
        <p className="font-medium text-emerald-900">
          נוצרה קטגוריה חדשה: <bdi>{created}</bdi>
        </p>
        <p className="mt-1 text-sm text-emerald-800">הסכומים שכבר הוקלדו נשמרו.</p>
      </div>
    );
  }

  if (saved) {
    return (
      <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4" role="status">
        <p className="font-medium text-emerald-900">החודש נשמר.</p>
      </div>
    );
  }

  return null;
}

function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן לקרוא את המאזן</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}
