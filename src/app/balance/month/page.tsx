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
import { BlanksOffer, MonthEntry } from "./month-entry";
import { HouseholdReadingTable, SummaryPanel } from "./month-panels";

export const dynamic = "force-dynamic";

/**
 * Recording a month — the only screen in the application that writes a whole
 * month of the מאזן. The year grid at `/balance` reads the same entries and links
 * back here, one month or one cell at a time.
 *
 * Both personal tabs are writable: either Person records into either Person's
 * categories, because the household needs a complete ledger more than it needs to
 * know whose hand typed a figure. The משותף tab still has nothing to write to —
 * every household figure is derived from the personal ones on each read.
 *
 * Saving is also where a month gets *closed*. A blank is ambiguous — an unfinished
 * month, or a month in which the thing did not happen — and the screen resolves it
 * by naming the blanks and offering them as zero rather than by guessing.
 */

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
  /** How many blanks the last closing wrote as zero. */
  zeros?: string | string[];
  /** The offer was declined: the blanks were left unrecorded, deliberately. */
  left?: string | string[];
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
        title="רישום חודשי"
        subtitle="מאזן הכנסות-הוצאות, חודש אחד לפי קטגוריות"
        back={{ href: "/balance", label: "חזרה למאזן השנתי" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <MonthNavigator month={month} view={first(params.view)} />

        <Notices
          saved={first(params.saved) === "1"}
          created={first(params.created)}
          error={first(params.error)}
          detail={first(params.detail)}
          zeros={first(params.zeros)}
        />

        {loaded.kind === "ok" ? (
          <MonthBody
            month={month}
            loaded={loaded}
            requested={first(params.view)}
            saved={first(params.saved) === "1"}
            declined={first(params.left) === "1"}
          />
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

/**
 * The tabs, what a save left unfinished, and the month itself. The view is
 * resolved once here so the offer and the form can never be about two different
 * people's columns.
 */
function MonthBody({
  month,
  loaded,
  requested,
  saved,
  declined,
}: {
  month: CalendarMonth;
  loaded: Extract<LoadedBalance, { kind: "ok" }>;
  requested: string | undefined;
  saved: boolean;
  declined: boolean;
}) {
  const view = resolveView(requested, loaded.person, loaded.people);

  return (
    <>
      <ViewTabs
        month={month}
        people={loaded.people}
        signedInPersonId={loaded.person.id}
        selected={requested}
      />

      {view.kind === "person" ? (
        <BlanksOffer
          month={month}
          person={view.person}
          categories={loaded.categories}
          ledger={loaded.ledger}
          saved={saved}
          declined={declined}
        />
      ) : null}

      <MonthView
        month={month}
        view={view}
        signedInPersonId={loaded.person.id}
        people={loaded.people}
        categories={loaded.categories}
        ledger={loaded.ledger}
      />
    </>
  );
}

function balanceHref(month: CalendarMonth, view: string | undefined): Route {
  const params = new URLSearchParams({ month: monthKey(month) });
  if (view !== undefined) params.set("view", view);
  return `/balance/month?${params.toString()}` as Route;
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

  // Both personal tabs write. Whose column it is still shows on the screen — the
  // names are the owner's own — but neither of them is read-only any more.
  return (
    <MonthEntry
      month={month}
      person={view.person}
      isSelf={view.person.id === signedInPersonId}
      categories={categories}
      ledger={ledger}
    />
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
        <form className="flex items-center gap-2" action="/balance/month" method="get">
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

        <Link
          href={`/balance/insights?month=${monthKey(month)}` as Route}
          className="text-sm text-stone-600 underline-offset-4 hover:underline"
        >
          מגמות וממוצעים
        </Link>

        <Link href="/balance/categories" className="text-sm text-stone-600 underline-offset-4 hover:underline">
          ניהול קטגוריות
        </Link>

        {/* Run once, not used. Reachable from the מאזן and from nowhere else. */}
        <Link href="/balance/import" className="text-sm text-stone-600 underline-offset-4 hover:underline">
          ייבוא מהגיליון
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
  zeros,
}: {
  saved: boolean;
  created: string | undefined;
  error: string | undefined;
  detail: string | undefined;
  zeros: string | undefined;
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

  if (zeros !== undefined) {
    return (
      <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4" role="status">
        <p className="font-medium text-emerald-900">
          נרשמו <bdi className="tabular">{zeros}</bdi> קטגוריות כאפס. החודש סגור.
        </p>
        <p className="mt-1 text-sm text-emerald-800">
          כל סכום שכבר היה רשום נשאר כפי שהיה.
        </p>
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
