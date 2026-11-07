import type { Route } from "next";
import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { loadCategories } from "@/db/categories";
import { DatabaseNotConfiguredError } from "@/db/client";
import { loadLedger } from "@/db/ledger";
import { type Person, findPersonByEmail, listPeople } from "@/db/people";
import { loadAnnualItems } from "@/db/rate-watch";
import { type Categories } from "@/domain/categories/categories";
import { type AnnualItems } from "@/domain/ledger/annual-items";
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
import { OverflowMenu, PrimaryAction, Segmented, type SegmentedOption } from "./chrome";
import { type GridLinks, OPEN_CELL_ID, cellKey } from "./grid-links";
import { YearGridTable } from "./grid-panels";
import { YearHeadline } from "./headline";
import { MonthStrip } from "./month-strip";
import { type RateErrorCode } from "./rate-actions";
import { RATE_PANEL_ID, RateWatchPanel } from "./rate-watch-panel";
import { ExpenseShares, groupColours } from "./shares";

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
 * It is laid out as the questions a person opens it with, in the order they ask
 * them, and nothing else is given a band of its own:
 *
 * 1. **Which year, whose money, and what now** — one bar of chrome, sticky, every
 *    control on it a link. It used to be four separate cards, two of which cost a
 *    form submission to change one thing.
 * 2. **How is the year going** — הכנסות, הוצאות and חיסכון as three cards, each
 *    carrying the total, the same months a year earlier, twelve bars and the
 *    monthly average. The trend used to be a screen away; a year's shape is not
 *    an advanced question.
 * 3. **Where it went** — the year's הוצאות as parts of one whole, with the lines
 *    the household marked as one kind drawn as one wedge.
 * 4. **Which months to record** — the twelve months as twelve tiles, each saying
 *    what it saved and each a way into that month. Filling a hole in מאי no
 *    longer means opening the current month and walking back.
 * 5. **Every category, month by month** — the grid: pinned headings, pinned
 *    totals, and a cell that opens where it sits. A month nobody typed a figure
 *    into reads as nought here, greyed, rather than as a blank to be chased.
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
  /** `1` while מעקב תעריפים's own forms are open. */
  rateEdit?: string | string[];
  /** Which Annual Item's price history is open for correction. */
  rateItem?: string | string[];
  /** Which cell is open for entry, as `${personalCategoryId}@${YYYY-MM}`. */
  cell?: string | string[];
  error?: string | string[];
  detail?: string | string[];
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

      <main className="mt-5 space-y-4 sm:mt-6 sm:space-y-5">
        {loaded.kind === "ok" ? (
          <BalanceYear
            year={year}
            today={today}
            people={loaded.people}
            categories={loaded.categories}
            ledger={loaded.ledger}
            items={loaded.items}
            view={first(params.view)}
            sort={parseSort(first(params.sort))}
            expanded={first(params.expand) === "1"}
            admin={first(params.admin) === "1"}
            rateEdit={first(params.rateEdit) === "1"}
            rateItem={first(params.rateItem) ?? null}
            openCell={first(params.cell) ?? null}
            notices={
              <Notices
                error={first(params.error)}
                detail={first(params.detail)}
                done={first(params.done)}
              />
            }
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
  | {
      kind: "ok";
      person: Person;
      people: readonly Person[];
      categories: Categories;
      ledger: Ledger;
      /** מעקב תעריפים's typed half. It holds no ledger data and feeds no total of one. */
      items: AnnualItems;
    }
  | { kind: "unavailable"; reason: string };

/**
 * The whole ledger, not one year of it. Both aggregate columns are clamped to the
 * span the history actually covers, the year selector offers the years that hold
 * data, and the comparison reaches a year back — none of the three is answerable
 * from a single year's entries.
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
    const [people, categories, ledger, items] = await Promise.all([
      listPeople(),
      loadCategories(),
      loadLedger(),
      loadAnnualItems(),
    ]);
    return { kind: "ok", person, people, categories, ledger, items };
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
  items,
  view,
  sort,
  expanded,
  admin,
  rateEdit,
  rateItem,
  openCell,
  notices,
}: {
  year: number;
  today: CalendarMonth;
  people: readonly Person[];
  categories: Categories;
  ledger: Ledger;
  items: AnnualItems;
  view: string | undefined;
  sort: GridSort;
  expanded: boolean;
  admin: boolean;
  rateEdit: boolean;
  rateItem: string | null;
  openCell: string | null;
  notices: React.ReactNode;
}) {
  const scope = resolveScope(view, people);
  const grid = yearGrid(ledger, categories, scope, year, LEDGER_CURRENCY, today, { sort });
  // The same year and the same clock as the grid, so the panel's monthly figures
  // divide by exactly the months the aggregate column above it divides by. The
  // typed items travel with them and touch nothing the grid reads.
  const watch = rateWatch(ledger, categories, items, year, LEDGER_CURRENCY, today);
  const years = recordedYears(ledger);
  const state: GridState = { year, view, sort, expanded, admin, rateEdit, rateItem };
  const links = linksFor(state);
  const peopleNames = new Map(people.map((person) => [person.id, person.displayName]));
  // Decided once: the chart draws its wedges in these colours and the table marks
  // its rows with them, so a Group is one colour everywhere on the screen.
  const colours = groupColours(grid);

  return (
    <>
      <Toolbar state={state} years={years} people={people} today={today} />

      {notices}

      <YearHeadline grid={grid} />

      <ExpenseShares grid={grid} />

      <MonthStrip grid={grid} links={links} />

      <YearGridTable
        grid={grid}
        expanded={expanded}
        peopleNames={peopleNames}
        openCell={openCell}
        links={links}
        // At person level a row is already personal — there is nothing underneath
        // it to open, so the toggle is absent rather than present and inert.
        controls={<TableControls state={state} expandable={scope.kind === "household"} />}
        groupColours={colours}
      />

      {/* Directly beneath the table and never behind a link. Both of the sheet's
          attempts at this question died of being somewhere nobody went, and at a
          dozen rows there is nothing here to hide. It reads at household level
          whatever tab the grid is on: a rate paid half by each Person is one rate.
          Its own forms are behind `?rateEdit=1`, so the panel reads clean by
          default — but the figures never are. */}
      <RateWatchPanel
        watch={watch}
        items={items}
        links={links}
        editing={rateEdit}
        openItem={rateItem}
      />

      {/* Beneath the table, so a rename or a merge is made with the rows it
          affects in view. Closed by default: it is a screenful of forms, and the
          question this screen is opened to ask is about the money. */}
      {admin ? (
        <CategoryAdminPanel
          categories={categories}
          people={people}
          links={links}
          today={today}
        />
      ) : (
        <p className="px-1 text-sm text-stone-500">
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
  /** מעקב תעריפים's forms, in the same idiom as `admin`: a panel that stays open. */
  readonly rateEdit: boolean;
  readonly rateItem: string | null;
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
  if (state.rateEdit) params.set("rateEdit", "1");
  if (state.rateItem !== null) params.set("rateItem", state.rateItem);
  return params;
}

/**
 * The same grid with one cell opened on top of it.
 *
 * That is transient rather than part of the view, so it is not carried by the
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
    // which a fresh URL would otherwise have left above the fold. Only the
    // no-script path takes it: with scripts the cell opens where it sits.
    openCell: (categoryId, month) =>
      `${withParam("cell", cellKey(categoryId, month))}#${OPEN_CELL_ID}` as Route,
    cancel: base,
    openAdmin: adminHref(state),
    closeAdmin: gridHref(state, { admin: false }),
    // The rate panel's own links land on the panel, the way the category one
    // lands on its. Closing the forms closes the open item with them: an item's
    // history is a thing inside the forms, and leaving it named in a URL whose
    // forms are shut would be state nobody can see.
    openRates: ratesHref(state, { rateEdit: true }),
    closeRates: gridHref(state, { rateEdit: false, rateItem: null }),
    openRateItem: (itemId) => ratesHref(state, { rateEdit: true, rateItem: itemId }),
    closeRateItem: ratesHref(state, { rateItem: null }),
    returnTo: {
      year: String(state.year),
      view: state.view ?? "",
      sort: state.sort,
      expand: state.expanded ? "1" : "",
      admin: state.admin ? "1" : "",
      rateEdit: state.rateEdit ? "1" : "",
      rateItem: state.rateItem ?? "",
    },
  };
}

/** The grid with מעקב תעריפים changed in one way, scrolled to the panel. */
function ratesHref(state: GridState, change: Partial<GridState>): Route {
  return `${gridHref(state, change)}#${RATE_PANEL_ID}` as Route;
}

// --- the one bar of chrome ----------------------------------------------------

/**
 * Which year, whose money, and the one thing to do next.
 *
 * Sticky, because the table below it is taller than a screen and the year a
 * figure belongs to is the one thing a reader must never have to scroll to
 * recover. Everything on it is a link: the year used to be a `<select>` and a
 * submit button, which is two actions and a round trip to answer "and 2025?".
 */
function Toolbar({
  state,
  years,
  people,
  today,
}: {
  state: GridState;
  years: readonly number[];
  people: readonly Person[];
  today: CalendarMonth;
}) {
  // The selected year is always among the options, even when the ledger holds
  // nothing for it — a control that could not show its own state would be worse
  // than one offering a year that turns out to be empty.
  const options = years.includes(state.year)
    ? years
    : [...years, state.year].sort((left, right) => left - right);

  const yearOptions: readonly SegmentedOption[] = options.map((option) => ({
    key: String(option),
    label: String(option),
    href: gridHref(state, { year: option }),
    muted: !years.includes(option),
  }));

  const current = people.some((person) => person.id === state.view) ? state.view : HOUSEHOLD_VIEW;
  const scopeOptions: readonly SegmentedOption[] = [
    ...people.map((person) => ({
      key: person.id,
      label: person.displayName,
      href: gridHref(state, { view: person.id }),
    })),
    { key: HOUSEHOLD_VIEW, label: "משותף", href: gridHref(state, { view: HOUSEHOLD_VIEW }) },
  ];

  const monthHref = `/balance/month?month=${monthKey(today)}&view=${state.view ?? HOUSEHOLD_VIEW}` as Route;

  return (
    // Above the table: the grid's own pinned headings sit as high as z-40 inside
    // their window, and the bar has to stay over them as the page scrolls past.
    <div className="sticky top-0 z-50 -mx-4 bg-canvas/85 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6">
      <section className="rounded-card bg-surface shadow-card flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-3 py-2.5 sm:px-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {/* Years read left to right whatever the page's direction, the way the
              months across the table do. */}
          <div dir="ltr">
            <Segmented label="שנה" options={yearOptions} current={String(state.year)} />
          </div>
          <Segmented label="רמת קריאה" options={scopeOptions} current={current ?? HOUSEHOLD_VIEW} />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={`/balance/insights?month=${monthKey(today)}` as Route}
            className="rounded-xl px-3 py-2 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-900/5 hover:text-stone-900"
          >
            מגמות וממוצעים
          </Link>

          <PrimaryAction href={monthHref}>
            <span aria-hidden="true" className="text-base leading-none">
              +
            </span>
            רישום חודשי
          </PrimaryAction>

          <OverflowMenu
            items={[
              {
                href: adminHref(state),
                label: "ניהול קטגוריות",
                note: "שמות, שיוכים ותקופות פעילות, מתחת לטבלה",
              },
              {
                href: "/balance/import" as Route,
                label: "ייבוא מהגיליון",
                note: "רץ פעם אחת. נשמר כאן ואין לו מקום אחר",
              },
            ]}
          />
        </div>
      </section>
    </div>
  );
}

/** How the rows are ordered, and whether the household lines are opened. */
function TableControls({ state, expandable }: { state: GridState; expandable: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        label="סדר השורות"
        size="sm"
        current={state.sort}
        options={[
          { key: "size", label: "לפי גודל", href: gridHref(state, { sort: "size" }) },
          { key: "name", label: "לפי א״ב", href: gridHref(state, { sort: "name" }) },
        ]}
      />

      {expandable ? (
        <Link
          href={gridHref(state, { expanded: !state.expanded })}
          aria-pressed={state.expanded}
          className={`rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
            state.expanded
              ? "bg-stone-900 text-white hover:bg-stone-700"
              : "text-stone-500 hover:bg-stone-900/5 hover:text-stone-900"
          }`}
        >
          פירוט אישי
        </Link>
      ) : null}
    </div>
  );
}

// --- notices -----------------------------------------------------------------

/** All three sets of writes report here: the grid's, the category panel's, and מעקב תעריפים's. */
const ERROR_MESSAGES: Record<GridErrorCode | CategoryErrorCode | RateErrorCode, string> = {
  "no-person": "הכתובת שאיתה נכנסת אינה משויכת לאף אדם בטבלת people, ולכן אין למה לכתוב.",
  "bad-amount": "הסכום שהוקלד אינו מספר, אינו חיובי או אינו בשקלים. שום דבר לא נשמר.",
  "unknown-category": "הקטגוריה שנבחרה אינה קיימת.",
  "bad-name": "שם הקטגוריה ריק או ארוך מדי.",
  "duplicate-name": "כבר קיימת קטגוריה בשם הזה.",
  "type-mismatch": "לא ניתן לשייך הכנסה לקטגוריה משותפת של הוצאה, או להפך.",
  "bad-lifespan": "לא ניתן להוציא קטגוריה משימוש לפני החודש שבו היא מתחילה.",
  "bad-merge": "אין מה למזג — לקטגוריה המשותפת הזו אין קטגוריות אישיות.",
  "bad-group": "שם הקבוצה ארוך מדי. שדה ריק מוציא את השורה מהקבוצה שהייתה בה.",
  "bad-item-name": "שם הפריט השנתי ריק או ארוך מדי.",
  "duplicate-item": "כבר קיים פריט שנתי בשם הזה.",
  "bad-date": "תאריך החידוש חסר או אינו תקין. השנה נגזרת ממנו, ולכן בלעדיו אין מה לרשום.",
  "duplicate-renewal": "כבר רשום חידוש לפריט הזה באותו תאריך. תיקון של הסכום נעשה על השורה הקיימת.",
  "unknown-item": "הפריט השנתי שנבחר אינו קיים.",
  "unknown-renewal": "החידוש שביקשת לתקן אינו קיים יותר.",
  "rate-failed": "הפעולה במעקב התעריפים נכשלה. שום סכום במאזן לא זז.",
  failed: "הפעולה נכשלה.",
};

function isErrorCode(
  value: string | undefined,
): value is GridErrorCode | CategoryErrorCode | RateErrorCode {
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
  grouped: "השורה סומנה כשייכת לקבוצה. שום סכום לא זז — הקבוצה משנה רק איך שורות נקראות יחד.",
  ungrouped: "השורה הוצאה מהקבוצה. שום סכום לא זז.",
  saved: "השינויים נשמרו. שמות, קבוצות, שיוכים ותקופות — ואף סכום שנרשם לא זז.",
  nothing: "לא היה מה לשמור: אף שורה לא השתנתה.",
  unwatched: "הקטגוריה הוסרה ממעקב תעריפים. שום סכום לא זז.",
  "item-created": "נוצר פריט שנתי, יחד עם החידוש הראשון שלו. המאזן שמעל לא השתנה.",
  renewed: "החידוש נרשם. השנה שלו נגזרה מהתאריך, ושום סכום במאזן לא זז.",
  "renewal-corrected": "החידוש תוקן. אם התאריך זז, הסכום עבר איתו לשנה שהוא נופל בה.",
  "renewal-removed": "החידוש הוסר. הפריט עצמו נשאר, עם שאר ההיסטוריה שלו.",
};

function Notice({
  tone,
  role,
  title,
  detail,
}: {
  tone: "bad" | "good";
  role: "alert" | "status";
  title: React.ReactNode;
  detail?: React.ReactNode;
}) {
  const colours =
    tone === "bad"
      ? { surface: "bg-rose-50", dot: "bg-rose-600", head: "text-rose-900", body: "text-rose-800" }
      : {
          surface: "bg-emerald-50",
          dot: "bg-emerald-600",
          head: "text-emerald-900",
          body: "text-emerald-800",
        };

  return (
    <div className={`rounded-card ${colours.surface} flex gap-3 p-4`} role={role}>
      <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${colours.dot}`} />
      <div className="min-w-0">
        <p className={`font-medium ${colours.head}`}>{title}</p>
        {detail === undefined ? null : <p className={`mt-1 text-sm ${colours.body}`}>{detail}</p>}
      </div>
    </div>
  );
}

function Notices({
  error,
  detail,
  done,
}: {
  error: string | undefined;
  detail: string | undefined;
  done: string | undefined;
}) {
  if (isErrorCode(error)) {
    return (
      <Notice
        tone="bad"
        role="alert"
        title={ERROR_MESSAGES[error]}
        detail={detail === undefined ? undefined : <bdi>{detail}</bdi>}
      />
    );
  }

  if (done === undefined) return null;

  const separator = done.indexOf(":");
  const kind = separator < 0 ? done : done.slice(0, separator);
  const message = DONE_MESSAGES[kind];
  if (message === undefined) return null;
  const named = separator < 0 ? "" : done.slice(separator + 1);
  // A bulk save reports a count; everything else reports the name it acted on.
  const subject = kind === "saved" ? `${named} שינויים` : named;

  return (
    <Notice
      tone="good"
      role="status"
      title={message}
      detail={subject.length === 0 ? undefined : <bdi>{subject}</bdi>}
    />
  );
}

function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="rounded-card bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן לקרוא את המאזן</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}
