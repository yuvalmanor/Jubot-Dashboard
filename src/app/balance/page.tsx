import type { Route } from "next";
import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { DatabaseNotConfiguredError } from "@/db/client";
import { loadCategories } from "@/db/categories";
import { loadLedgerForMonth } from "@/db/ledger";
import { type Person, findPersonByEmail } from "@/db/people";
import {
  type Categories,
  type CategoryType,
  type HouseholdCategory,
  householdCategoriesFor,
  householdCategoryOf,
} from "@/domain/categories/categories";
import {
  type CategoryLine,
  type Ledger,
  type MonthSummary,
  personMonthLines,
  personMonthSummary,
} from "@/domain/ledger/ledger";
import { format, toDecimalString } from "@/domain/money/money";
import {
  type CalendarMonth,
  addMonths,
  formatMonth,
  monthKey,
  monthOf,
  tryParseMonthKey,
} from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { type BalanceErrorCode, createCategoryAndSaveMonth, saveMonth } from "./actions";

export const dynamic = "force-dynamic";

const LEDGER_CURRENCY = "ILS" as const;

interface SearchParams {
  month?: string | string[];
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
        <MonthNavigator month={month} />

        <Notices
          saved={first(params.saved) === "1"}
          created={first(params.created)}
          error={first(params.error)}
          detail={first(params.detail)}
        />

        {loaded.kind === "ok" ? (
          <MonthEditor month={month} person={loaded.person} categories={loaded.categories} ledger={loaded.ledger} />
        ) : (
          <UnavailablePanel reason={loaded.reason} />
        )}
      </main>
    </div>
  );
}

// --- loading -----------------------------------------------------------------

type LoadedBalance =
  | { kind: "ok"; person: Person; categories: Categories; ledger: Ledger }
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
    const [categories, ledger] = await Promise.all([loadCategories(), loadLedgerForMonth(month)]);
    return { kind: "ok", person, categories, ledger };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- month navigation --------------------------------------------------------

function MonthNavigator({ month }: { month: CalendarMonth }) {
  const previous = addMonths(month, -1);
  const next = addMonths(month, 1);

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-300 bg-white p-4">
      <div className="flex items-center gap-2">
        {/* In RTL the previous month sits to the right, so the arrows point outward. */}
        <MonthStep href={`/balance?month=${monthKey(next)}`} label={formatMonth(next)} glyph="‹" />
        <h2 className="min-w-40 text-center text-lg font-semibold">{formatMonth(month)}</h2>
        <MonthStep href={`/balance?month=${monthKey(previous)}`} label={formatMonth(previous)} glyph="›" />
      </div>

      {/* Any month in any year — a four-year-old typo is reachable in one step. */}
      <form className="flex items-center gap-2" action="/balance" method="get">
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

// --- the month itself --------------------------------------------------------

function MonthEditor({
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
    <form className="space-y-6">
      <input type="hidden" name="month" value={monthKey(month)} />

      <SavingPanel summary={summary} />

      {income.length + expenses.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
          עדיין אין לך קטגוריות. אפשר ליצור את הראשונה כאן למטה, בלי לצאת מהמסך.
        </p>
      ) : (
        <>
          <CategoryTable title="הכנסות" lines={income} categories={categories} />
          <CategoryTable title="הוצאות" lines={expenses} categories={categories} />

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              formAction={saveMonth}
              className="rounded-md bg-stone-900 px-4 py-2.5 font-medium text-white hover:bg-stone-800"
            >
              שמירת החודש
            </button>
            <p className="text-sm text-stone-500">שדה ריק פירושו שהחודש לא נרשם — אין זה אותו דבר כמו 0.</p>
          </div>
        </>
      )}

      <NewCategoryPanel categories={categories} />
    </form>
  );
}

function SavingPanel({ summary }: { summary: MonthSummary }) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Figure label="הכנסות" value={format(summary.income)} />
        <Figure label="הוצאות" value={format(summary.expenses)} />
        <Figure label="חיסכון" value={format(summary.saving)} emphasis />
      </div>
      <p className="mt-4 text-sm text-stone-500">
        חיסכון = הכנסות − הוצאות, מחושב בכל קריאה ואינו ניתן לעריכה. נרשמו{" "}
        <bdi className="tabular">{summary.recordedCount}</bdi> מתוך{" "}
        <bdi className="tabular">{summary.categoryCount}</bdi> קטגוריות.
      </p>
    </section>
  );
}

function Figure({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div>
      <p className="text-sm font-semibold tracking-wide text-stone-500">{label}</p>
      <bdi className={`tabular block ${emphasis ? "text-3xl font-semibold" : "text-2xl"}`}>{value}</bdi>
    </div>
  );
}

function CategoryTable({
  title,
  lines,
  categories,
}: {
  title: string;
  lines: readonly CategoryLine[];
  categories: Categories;
}) {
  if (lines.length === 0) return null;

  return (
    <section className="rounded-lg border border-stone-300 bg-white">
      <h3 className="border-b border-stone-200 px-5 py-3 text-sm font-semibold tracking-wide text-stone-500">
        {title}
      </h3>
      <ul className="divide-y divide-stone-200">
        {lines.map((line) => (
          <li key={line.category.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                <bdi>{line.category.name}</bdi>
              </p>
              <p className="text-xs text-stone-500">
                משותפת: <bdi>{householdCategoryOf(categories, line.category.id).name}</bdi>
                {line.reading === null ? " · לא נרשם" : null}
              </p>
            </div>
            <input
              aria-label={line.category.name}
              name={`amount:${line.category.id}`}
              type="text"
              inputMode="decimal"
              dir="ltr"
              autoComplete="off"
              placeholder="—"
              defaultValue={line.reading === null ? "" : toDecimalString(line.reading.amount)}
              className="tabular w-36 rounded-md border border-stone-300 px-3 py-1.5 text-left"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- creating a category without leaving the screen --------------------------

function NewCategoryPanel({ categories }: { categories: Categories }) {
  const householdOptions: readonly HouseholdCategory[] = householdCategoriesFor(categories);

  return (
    <details className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <summary className="cursor-pointer font-medium">קטגוריה חדשה</summary>

      <p className="mt-3 text-sm text-stone-500">
        קטגוריה אישית תמיד נכנסת לקטגוריה משותפת — או חדשה, או קיימת. כסף שנרשם אצלך אינו יכול להיעלם
        מהמאזן המשותף. סוג הקטגוריה נקבע כאן פעם אחת ואינו משתנה מחודש לחודש.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="newCategoryName" className="block text-sm font-medium">
            שם הקטגוריה שלי
          </label>
          <input
            id="newCategoryName"
            name="newCategoryName"
            type="text"
            autoComplete="off"
            maxLength={60}
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5"
          />
        </div>

        <fieldset>
          <legend className="block text-sm font-medium">סוג</legend>
          <div className="mt-1 flex gap-4">
            <TypeChoice value="expense" label="הוצאה" defaultChecked />
            <TypeChoice value="income" label="הכנסה" />
          </div>
        </fieldset>

        <div>
          <label htmlFor="newCategoryHousehold" className="block text-sm font-medium">
            קטגוריה משותפת
          </label>
          <select
            id="newCategoryHousehold"
            name="newCategoryHousehold"
            defaultValue="new"
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5"
          >
            <option value="new">חדשה</option>
            {householdOptions.map((household) => (
              <option key={household.id} value={household.id}>
                {household.name} ({household.type === "income" ? "הכנסה" : "הוצאה"})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="newHouseholdName" className="block text-sm font-medium">
            שם הקטגוריה המשותפת החדשה
          </label>
          <input
            id="newHouseholdName"
            name="newHouseholdName"
            type="text"
            autoComplete="off"
            maxLength={60}
            placeholder="ברירת מחדל: אותו שם"
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5"
          />
        </div>
      </div>

      <button
        type="submit"
        formAction={createCategoryAndSaveMonth}
        className="mt-4 rounded-md border border-stone-900 px-4 py-2 font-medium hover:bg-stone-50"
      >
        יצירה והמשך רישום
      </button>
      <p className="mt-2 text-sm text-stone-500">הסכומים שכבר הוקלדו יישמרו יחד עם היצירה.</p>
    </details>
  );
}

function TypeChoice({
  value,
  label,
  defaultChecked = false,
}: {
  value: CategoryType;
  label: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="radio" name="newCategoryType" value={value} defaultChecked={defaultChecked} />
      {label}
    </label>
  );
}
