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
import { rateWatch } from "@/domain/ledger/rate-watch";
import { type GridSort, DEFAULT_GRID_SORT, isGridSort, yearGrid } from "@/domain/ledger/year-grid";
import {
  type CalendarMonth,
  formatMonth,
  monthKey,
  monthOf,
  tryParseMonthKey,
} from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { type GridErrorCode } from "./actions";
import { type CategoryErrorCode } from "./category-actions";
import { CATEGORY_PANEL_ID, CategoryAdminPanel } from "./category-panels";
import { type GridLinks, OPEN_CELL_ID, cellKey } from "./grid-links";
import { ClosingPanel, YearGridTable, YearSummaryStrip } from "./grid-panels";
import { RateWatchPanel } from "./rate-watch-panel";

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
 * It is also where the holes get filled. A cell leads to wherever its figure can
 * be written — opened in place when the cell is one category-month, and on
 * `/balance/month` when it is a משותף line summing two People — and a past month
 * that is missing figures says so on its own column heading, with the closing of
 * it one click away.
 *
 * Beneath the table sits מעקב תעריפים, which answers the question the grid does
 * not: whether a price somebody set has moved. It is always on screen — both of
 * the spreadsheet's attempts at it died of being somewhere nobody went — and every
 * figure in it is a breakdown of money the table above already counts.
 *
 * And it is where the categories themselves are administered. That used to be a
 * route of its own, which meant every rename and every merge was made on a screen
 * with no figures on it; the panel is beneath the table now, so the consequences
 * of a change are visible above it.
 *
 * Everything the reader can change about the table — the year, whose money, the
 * row order, whether the household rows are opened, which cell is open, which
 * month is being closed, whether the category panel is out — is a query parameter
 * and nothing else. So a view of the grid is a URL that can be sent to the other
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
  /** `1` while the category panel below the grid is open. */
  admin?: string | string[];
  /** Which cell is open for entry, as `${personalCategoryId}@${YYYY-MM}`. */
  cell?: string | string[];
  /** Which month's closing is being confirmed, as `YYYY-MM`. */
  close?: string | string[];
  error?: string | string[];
  detail?: string | string[];
  /** The month a closing just wrote into, and how many zeros it wrote. */
  closed?: string | string[];
  zeros?: string | string[];
  /** What the category panel just did, as `<kind>:<subject>`. */
  done?: string | string[];
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
        <Notices
          error={first(params.error)}
          detail={first(params.detail)}
          closed={first(params.closed)}
          zeros={first(params.zeros)}
          done={first(params.done)}
        />

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
            admin={first(params.admin) === "1"}
            openCell={first(params.cell) ?? null}
            closing={tryParseMonthKey(first(params.close))}
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
  admin,
  openCell,
  closing,
}: {
  year: number;
  today: CalendarMonth;
  people: readonly Person[];
  categories: Categories;
  ledger: Ledger;
  view: string | undefined;
  sort: GridSort;
  expanded: boolean;
  admin: boolean;
  openCell: string | null;
  closing: CalendarMonth | null;
}) {
  const scope = resolveScope(view, people);
  const grid = yearGrid(ledger, categories, scope, year, LEDGER_CURRENCY, today, { sort });
  // The same year and the same clock as the grid, so the panel's monthly figures
  // divide by exactly the months the aggregate column above it divides by.
  const watch = rateWatch(ledger, categories, year, LEDGER_CURRENCY, today);
  const years = recordedYears(ledger);
  const state: GridState = { year, view, sort, expanded, admin };
  const peopleNames = new Map(people.map((person) => [person.id, person.displayName]));

  // The month whose closing is being confirmed, read off the grid itself rather
  // than computed again: the panel below the table and the column heading above it
  // must be describing the same blanks.
  const closingMonth =
    closing === null
      ? undefined
      : grid.months.find((column) => monthKey(column.month) === monthKey(closing));

  return (
    <>
      <YearNavigator state={state} years={years} today={today} />
      <ViewTabs state={state} people={people} />
      <YearSummaryStrip grid={grid} />
      {/* At person level a row is already personal — there is nothing underneath
          it to open, so the toggle is absent rather than present and inert. */}
      <TableControls state={state} expandable={scope.kind === "household"} />
      {closingMonth === undefined ? null : (
        <ClosingPanel column={closingMonth} links={linksFor(state)} peopleNames={peopleNames} />
      )}
      <YearGridTable
        grid={grid}
        expanded={expanded}
        peopleNames={peopleNames}
        openCell={openCell}
        links={linksFor(state)}
      />
      {/* Directly beneath the table and never behind a link. Both of the sheet's
          attempts at this question died of being somewhere nobody went, and at a
          dozen rows there is nothing here to hide. It reads at household level
          whatever tab the grid is on: a rate paid half by each Person is one rate. */}
      <RateWatchPanel watch={watch} links={linksFor(state)} />
      {/* Beneath the table, so a rename or a merge is made with the rows it
          affects in view. Closed by default: it is a screenful of forms, and the
          question this screen is opened to ask is about the money. */}
      {admin ? (
        <CategoryAdminPanel
          categories={categories}
          people={people}
          links={linksFor(state)}
          today={today}
        />
      ) : (
        <p className="text-sm text-stone-600">
          <Link href={adminHref(state)} className="underline-offset-4 hover:underline">
            ניהול קטגוריות
          </Link>{" "}
          — שמות, שיוכים, תקופות פעילות ויצירת קטגוריה חדשה, מתחת לטבלה.
        </p>
      )}
    </>
  );
}

/** The grid with the panel out, scrolled to it. */
function adminHref(state: GridState): Route {
  return `${gridHref(state, { admin: true })}#${CATEGORY_PANEL_ID}` as Route;
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
  readonly admin: boolean;
}

/**
 * The current view as a URL, with one part replaced. Every control changes one
 * thing and keeps the rest, so choosing an order never resets the year and
 * opening the household rows never sends the reader back to משותף.
 */
function gridHref(state: GridState, change: Partial<GridState> = {}): Route {
  return `/balance?${gridParams({ ...state, ...change }).toString()}` as Route;
}

function gridParams(state: GridState): URLSearchParams {
  const params = new URLSearchParams({ year: String(state.year) });
  if (state.view !== undefined) params.set("view", state.view);
  if (state.sort !== DEFAULT_GRID_SORT) params.set("sort", state.sort);
  if (state.expanded) params.set("expand", "1");
  if (state.admin) params.set("admin", "1");
  return params;
}

/**
 * The same grid with one thing opened on top of it: a cell, or a month's closing.
 *
 * Both are transient rather than part of the view, so they are not carried by the
 * ordinary controls — choosing an order or a year puts the table back to being a
 * table. Everything else about the view *is* carried, through every link and
 * through every write, so nothing a person chose is lost to a save.
 */
function linksFor(state: GridState): GridLinks {
  const base = gridHref(state);

  const withParam = (key: string, value: string): Route => {
    const params = gridParams(state);
    params.set(key, value);
    return `/balance?${params.toString()}` as Route;
  };

  return {
    // A row that belongs to a Person opens that Person's tab; anything else opens
    // the tab the grid is already being read at.
    month: (month, personId) =>
      `/balance/month?month=${monthKey(month)}&view=${personId ?? state.view ?? HOUSEHOLD_VIEW}` as Route,
    // The fragment scrolls the window over the table to the cell that was clicked,
    // which a fresh URL would otherwise have left above the fold.
    openCell: (categoryId, month) =>
      `${withParam("cell", cellKey(categoryId, month))}#${OPEN_CELL_ID}` as Route,
    closing: (month) => withParam("close", monthKey(month)),
    cancel: base,
    openAdmin: adminHref(state),
    closeAdmin: gridHref(state, { admin: false }),
    returnTo: {
      year: String(state.year),
      view: state.view ?? "",
      sort: state.sort,
      expand: state.expanded ? "1" : "",
      admin: state.admin ? "1" : "",
    },
  };
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
        {state.admin ? <input type="hidden" name="admin" value="1" /> : null}
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

        {/* Not a route any more: the panel is on this page, below the table. */}
        <Link href={adminHref(state)} className="text-sm text-stone-600 underline-offset-4 hover:underline">
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

// --- notices -----------------------------------------------------------------

/** Both sets of writes report here: the grid's, and the category panel's. */
const ERROR_MESSAGES: Record<GridErrorCode | CategoryErrorCode, string> = {
  "no-person": "הכתובת שאיתה נכנסת אינה משויכת לאף אדם בטבלת people, ולכן אין למה לכתוב.",
  "bad-amount": "הסכום שהוקלד אינו מספר. שום דבר לא נשמר.",
  "unknown-category": "הקטגוריה שנבחרה אינה קיימת.",
  "bad-name": "שם הקטגוריה ריק או ארוך מדי.",
  "duplicate-name": "כבר קיימת קטגוריה בשם הזה.",
  "type-mismatch": "לא ניתן לשייך הכנסה לקטגוריה משותפת של הוצאה, או להפך.",
  "bad-lifespan": "לא ניתן להוציא קטגוריה משימוש לפני החודש שבו היא מתחילה.",
  "bad-merge": "אין מה למזג — לקטגוריה המשותפת הזו אין קטגוריות אישיות.",
  failed: "הפעולה נכשלה.",
};

function isErrorCode(value: string | undefined): value is GridErrorCode | CategoryErrorCode {
  return value !== undefined && value in ERROR_MESSAGES;
}

/** What the category panel just did. The subject is the name it did it to. */
const DONE_MESSAGES: Readonly<Record<string, string>> = {
  created: "נוצרה קטגוריה אישית חדשה, יחד עם השיוך שלה לקטגוריה משותפת.",
  "personal-renamed": "השם האישי שונה. אף קטגוריה משותפת, שיוך או סכום לא זזו.",
  renamed: "שם הקטגוריה המשותפת שונה. אף קטגוריה אישית לא השתנתה.",
  merged: "השיוך עודכן. כל הרישומים נשמרו כפי שהיו — אותו כסף תחת כותרת אחרת.",
  lifespan: "תקופת הפעילות עודכנה. חודשים שכבר נרשמו ממשיכים להיקרא כרגיל.",
  watched: "הקטגוריה נוספה למעקב תעריפים. שום סכום לא זז — הפאנל קורא את אותם רישומים.",
  unwatched: "הקטגוריה הוסרה ממעקב תעריפים. שום סכום לא זז.",
};

function Notices({
  error,
  detail,
  closed,
  zeros,
  done,
}: {
  error: string | undefined;
  detail: string | undefined;
  closed: string | undefined;
  zeros: string | undefined;
  done: string | undefined;
}) {
  if (isErrorCode(error)) {
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

  const month = tryParseMonthKey(closed);
  if (month !== null) {
    return (
      <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4" role="status">
        <p className="font-medium text-emerald-900">
          {formatMonth(month)}: נרשמו <bdi className="tabular">{zeros ?? "0"}</bdi> קטגוריות כאפס, והחודש
          סגור.
        </p>
        <p className="mt-1 text-sm text-emerald-800">כל סכום שכבר היה רשום נשאר כפי שהיה.</p>
      </div>
    );
  }

  if (done === undefined) return null;

  const separator = done.indexOf(":");
  const message = DONE_MESSAGES[separator < 0 ? done : done.slice(0, separator)];
  if (message === undefined) return null;
  const subject = separator < 0 ? "" : done.slice(separator + 1);

  return (
    <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4" role="status">
      <p className="font-medium text-emerald-900">{message}</p>
      {subject.length === 0 ? null : (
        <p className="mt-1 text-sm text-emerald-800">
          <bdi>{subject}</bdi>
        </p>
      )}
    </div>
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
