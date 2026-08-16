import type { Route } from "next";
import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { loadCategories } from "@/db/categories";
import { DatabaseNotConfiguredError } from "@/db/client";
import { loadLedger } from "@/db/ledger";
import { type Person, findPersonByEmail, listPeople } from "@/db/people";
import { type Categories } from "@/domain/categories/categories";
import { type Ledger, recordedYears } from "@/domain/ledger/ledger";
import { type AnalyticsScope, HOUSEHOLD_SCOPE, personScope } from "@/domain/ledger/ledger-analytics";
import { type GridSort, DEFAULT_GRID_SORT, isGridSort, yearGrid } from "@/domain/ledger/year-grid";
import { type CalendarMonth, monthKey, monthOf } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { YearGridTable, YearSummaryStrip } from "./grid-panels";

export const dynamic = "force-dynamic";

/**
 * מאזן הכנסות-הוצאות — a year at a time.
 *
 * The spreadsheet this replaced was read year-first: a grid of categories against
 * months, down a column for a month and across a row for a category. This screen
 * is that grid, with the two things the spreadsheet could not do — every
 * household figure derived from the personal ones on each read, and a blank that
 * means *not recorded* rather than *nought*.
 *
 * It is read-only. The one place a month is written is `/balance/month`, which
 * every cell here is a step away from.
 *
 * Everything the reader can change about the table — the year, whose money, the
 * row order, whether the household rows are opened — is a query parameter and
 * nothing else. So a view of the grid is a URL that can be sent to the other
 * person, and the screen holds no state that a reload could lose.
 */

/** The ledger is kept in shekels. Explicit, never assumed from context. */
const LEDGER_CURRENCY = "ILS" as const;

const HOUSEHOLD_VIEW = "household";

interface SearchParams {
  year?: string | string[];
  view?: string | string[];
  sort?: string | string[];
  expand?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseYear(value: string | undefined): number | null {
  if (value === undefined || !/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  return year >= 2000 && year <= 2100 ? year : null;
}

/** An unrecognised order falls back to the default rather than to no order at all. */
function parseSort(value: string | undefined): GridSort {
  return isGridSort(value) ? value : DEFAULT_GRID_SORT;
}

export default async function BalancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const today = monthOf(new Date());

  // The year defaults to the current one: the question this screen is opened to
  // ask is almost always about the year being lived.
  const year = parseYear(first(params.year)) ?? today.year;
  const loaded = await loadBalance(email);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="מאזן הכנסות-הוצאות"
        subtitle="שנה שלמה — קטגוריות מול חודשים"
        back={{ href: "/", label: "חזרה ללוח המחוונים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        {loaded.kind === "ok" ? (
          <BalanceYear
            year={year}
            today={today}
            people={loaded.people}
            categories={loaded.categories}
            ledger={loaded.ledger}
            view={first(params.view)}
            sort={parseSort(first(params.sort))}
            expanded={first(params.expand) === "1"}
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

/**
 * The whole ledger, not one year of it. Both aggregate columns are clamped to the
 * span the history actually covers, and the year selector offers the years that
 * hold data — neither is answerable from a single year's entries.
 */
async function loadBalance(email: string): Promise<LoadedBalance> {
  try {
    const person = await findPersonByEmail(email);
    if (person === null) {
      return {
        kind: "unavailable",
        reason: `הכתובת ${email} אינה משויכת לאף אדם בטבלת people. יש לעדכן את שתי הכתובות במסד (ראו README).`,
      };
    }
    const [people, categories, ledger] = await Promise.all([listPeople(), loadCategories(), loadLedger()]);
    return { kind: "ok", person, people, categories, ledger };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- the grid ----------------------------------------------------------------

function BalanceYear({
  year,
  today,
  people,
  categories,
  ledger,
  view,
  sort,
  expanded,
}: {
  year: number;
  today: CalendarMonth;
  people: readonly Person[];
  categories: Categories;
  ledger: Ledger;
  view: string | undefined;
  sort: GridSort;
  expanded: boolean;
}) {
  const scope = resolveScope(view, people);
  const grid = yearGrid(ledger, categories, scope, year, LEDGER_CURRENCY, today, { sort });
  const years = recordedYears(ledger);
  const state: GridState = { year, view, sort, expanded };

  return (
    <>
      <YearNavigator state={state} years={years} today={today} />
      <ViewTabs state={state} people={people} />
      <YearSummaryStrip grid={grid} />
      {/* At person level a row is already personal — there is nothing underneath
          it to open, so the toggle is absent rather than present and inert. */}
      <TableControls state={state} expandable={scope.kind === "household"} />
      <YearGridTable
        grid={grid}
        expanded={expanded}
        peopleNames={new Map(people.map((person) => [person.id, person.displayName]))}
      />
    </>
  );
}

/**
 * Which of the three readings. משותף is the default: the question the household
 * opens this screen to ask is the household one.
 */
function resolveScope(requested: string | undefined, people: readonly Person[]): AnalyticsScope {
  const person = people.find((candidate) => candidate.id === requested);
  return person === undefined ? HOUSEHOLD_SCOPE : personScope(person.id);
}

/** Everything the reader has chosen about the table, carried onto every link. */
interface GridState {
  readonly year: number;
  readonly view: string | undefined;
  readonly sort: GridSort;
  readonly expanded: boolean;
}

/**
 * The current view as a URL, with one part replaced. Every control changes one
 * thing and keeps the rest, so choosing an order never resets the year and
 * opening the household rows never sends the reader back to משותף.
 */
function gridHref(state: GridState, change: Partial<GridState> = {}): Route {
  const next = { ...state, ...change };
  const params = new URLSearchParams({ year: String(next.year) });
  if (next.view !== undefined) params.set("view", next.view);
  if (next.sort !== DEFAULT_GRID_SORT) params.set("sort", next.sort);
  if (next.expanded) params.set("expand", "1");
  return `/balance?${params.toString()}` as Route;
}

function ViewTabs({ state, people }: { state: GridState; people: readonly Person[] }) {
  const current = people.some((person) => person.id === state.view) ? state.view : HOUSEHOLD_VIEW;

  const tabs = [
    ...people.map((person) => ({ key: person.id, label: person.displayName })),
    { key: HOUSEHOLD_VIEW, label: "משותף" },
  ];

  return (
    <nav aria-label="רמת קריאה" className="flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const active = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={gridHref(state, { view: tab.key })}
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

/** How the rows are ordered, and whether the household lines are opened. */
function TableControls({ state, expandable }: { state: GridState; expandable: boolean }) {
  const orders = [
    { key: "size" as const, label: "לפי גודל" },
    { key: "name" as const, label: "לפי א״ב" },
  ];

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-300 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-stone-600">סדר השורות</span>
        {orders.map((order) => {
          const active = order.key === state.sort;
          return (
            <Link
              key={order.key}
              href={gridHref(state, { sort: order.key })}
              aria-current={active ? "true" : undefined}
              className={`rounded-md border px-3 py-1 text-sm ${
                active
                  ? "border-stone-900 bg-stone-900 text-white"
                  : "border-stone-300 bg-white hover:bg-stone-50"
              }`}
            >
              {order.label}
            </Link>
          );
        })}
        <span className="text-xs text-stone-500">
          {state.sort === "size"
            ? "הסכום השנתי הגדול ביותר למעלה"
            : "אותה שורה באותו מקום בכל קריאה"}
        </span>
      </div>

      {expandable ? (
        <Link
          href={gridHref(state, { expanded: !state.expanded })}
          className="rounded-md border border-stone-300 bg-white px-3 py-1 text-sm font-medium hover:bg-stone-50"
        >
          {state.expanded ? "סגירת הפירוט האישי" : "פתיחת הפירוט האישי"}
        </Link>
      ) : null}
    </section>
  );
}

function YearNavigator({
  state,
  years,
  today,
}: {
  state: GridState;
  years: readonly number[];
  today: CalendarMonth;
}) {
  const { year, view } = state;

  // The selected year is always among the options, even when the ledger holds
  // nothing for it — a control that could not show its own state would be worse
  // than one offering a year that turns out to be empty.
  const options = years.includes(year) ? years : [...years, year].sort((left, right) => left - right);

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-300 bg-white p-4">
      <form className="flex items-center gap-2" action="/balance" method="get">
        {/* A GET form submits only its own fields, so the rest of the view has to
            travel with it or changing the year would quietly reset the order. */}
        {view === undefined ? null : <input type="hidden" name="view" value={view} />}
        {state.sort === DEFAULT_GRID_SORT ? null : (
          <input type="hidden" name="sort" value={state.sort} />
        )}
        {state.expanded ? <input type="hidden" name="expand" value="1" /> : null}
        <label htmlFor="year-picker" className="text-sm text-stone-600">
          שנה
        </label>
        <select
          id="year-picker"
          name="year"
          defaultValue={String(year)}
          className="tabular rounded-md border border-stone-300 px-2 py-1.5 text-sm"
        >
          {options.map((option) => (
            <option key={option} value={String(option)}>
              {option}
              {years.includes(option) ? "" : " (ריקה)"}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
        >
          הצגה
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-4">
        <Link
          href={`/balance/month?month=${monthKey(today)}` as Route}
          className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800"
        >
          רישום חודשי
        </Link>

        <Link
          href={`/balance/insights?month=${monthKey(today)}` as Route}
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

function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן לקרוא את המאזן</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}
