import type { Route } from "next";
import Link from "next/link";

import {
  type Categories,
  type CategoryType,
  type HouseholdCategory,
  householdCategoriesFor,
  householdCategoryOf,
  isRetired,
} from "@/domain/categories/categories";
import {
  type CategoryLine,
  type Ledger,
  personMonthLines,
  personMonthSummary,
} from "@/domain/ledger/ledger";
import { personScope } from "@/domain/ledger/ledger-analytics";
import { monthClosure } from "@/domain/ledger/month-closure";
import { toDecimalString } from "@/domain/money/money";
import { type CalendarMonth, formatMonth, monthKey } from "@/domain/time/calendar-month";

import { createCategoryAndSaveMonth, saveMonth } from "./actions";
import { SummaryPanel } from "./month-panels";

/**
 * Writing a month — the two personal views of the three.
 *
 * Either Person may record into either Person's categories: the household needs a
 * complete ledger more than it needs to know whose hand typed a figure. What does
 * not change is whose the categories *are* — the names are the owner's own, and
 * the screen says whose column is open so a figure is never typed into the wrong
 * one by mistake. The משותף view still has no inputs at all: every household
 * figure is derived, and there is nothing there to write to.
 */

const LEDGER_CURRENCY = "ILS" as const;

export function MonthEntry({
  month,
  person,
  isSelf,
  categories,
  ledger,
}: {
  month: CalendarMonth;
  person: { readonly id: string; readonly displayName: string };
  isSelf: boolean;
  categories: Categories;
  ledger: Ledger;
}) {
  const personId = person.id;
  const income = personMonthLines(ledger, categories, personId, month, { type: "income" });
  const expenses = personMonthLines(ledger, categories, personId, month, { type: "expense" });
  const summary = personMonthSummary(ledger, categories, personId, month, LEDGER_CURRENCY);

  return (
    <form className="space-y-6">
      <input type="hidden" name="month" value={monthKey(month)} />
      {/* The tab travels with the write: the save returns here and not to
          whichever column the signed-in Person happens to own. */}
      <input type="hidden" name="view" value={personId} />
      <input type="hidden" name="owner" value={personId} />

      <SummaryPanel
        summary={summary}
        note={
          isSelf
            ? "חיסכון = הכנסות − הוצאות, מחושב בכל קריאה ואינו ניתן לעריכה."
            : `הקטגוריות של ${person.displayName}, בשמות שלה או שלו. שניכם רשאים לרשום בשני הטורים.`
        }
      />

      {income.length + expenses.length === 0 ? (
        <p className="rounded-card bg-surface shadow-card p-5 text-stone-600">
          {isSelf
            ? "עדיין אין לך קטגוריות בחודש הזה. אפשר ליצור אחת כאן למטה, בלי לצאת מהמסך."
            : `אין ל${person.displayName} קטגוריות בחודש הזה. אפשר ליצור אחת כאן למטה.`}
        </p>
      ) : (
        <>
          <EntryTable title="הכנסות" lines={income} categories={categories} />
          <EntryTable title="הוצאות" lines={expenses} categories={categories} />

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              formAction={saveMonth}
              className="rounded-lg bg-stone-900 px-4 py-2.5 font-medium text-white hover:bg-stone-700"
            >
              שמירת החודש
            </button>
            <p className="text-sm text-stone-500">
              שדה שנשאר ריק נקרא במאזן כאפס. אין צורך להקליד 0 בכל שורה שלא קרה בה כלום.
            </p>
          </div>
        </>
      )}

      <NewCategoryPanel categories={categories} owner={person} isSelf={isSelf} />
    </form>
  );
}

function EntryTable({
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
    <section className="rounded-card bg-surface shadow-card">
      <h3 className="border-b border-line px-5 py-3 text-[13px] font-medium text-stone-500">
        {title}
      </h3>
      <ul className="divide-y divide-line">
        {lines.map((line) => (
          <li key={line.category.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                <bdi>{line.category.name}</bdi>
              </p>
              <p className="text-xs text-stone-500">
                משותפת: <bdi>{householdCategoryOf(categories, line.category.id).name}</bdi>
                {line.reading === null ? " · לא נרשם" : null}
                {/* Shown only because it has a figure here; retiring never hides money. */}
                {isRetired(line.category) ? " · הוצאה משימוש" : null}
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
              className="tabular w-36 rounded-lg bg-sunken px-3 py-1.5 text-left"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- creating a category without leaving the screen --------------------------

function NewCategoryPanel({
  categories,
  owner,
  isSelf,
}: {
  categories: Categories;
  owner: { readonly displayName: string };
  isSelf: boolean;
}) {
  const householdOptions: readonly HouseholdCategory[] = householdCategoriesFor(categories);

  return (
    <details className="rounded-card bg-surface shadow-card p-5 sm:p-6">
      <summary className="cursor-pointer font-medium">
        קטגוריה חדשה{isSelf ? "" : ` ל${owner.displayName}`}
      </summary>

      <p className="mt-3 text-sm text-stone-500">
        קטגוריה אישית תמיד נכנסת לקטגוריה משותפת — או חדשה, או קיימת. כסף שנרשם אצלך אינו יכול להיעלם
        מהמאזן המשותף. סוג הקטגוריה נקבע כאן פעם אחת ואינו משתנה מחודש לחודש.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="newCategoryName" className="block text-sm font-medium">
            {isSelf ? "שם הקטגוריה שלי" : `שם הקטגוריה של ${owner.displayName}`}
          </label>
          <input
            id="newCategoryName"
            name="newCategoryName"
            type="text"
            autoComplete="off"
            maxLength={60}
            className="mt-1 w-full rounded-lg bg-sunken px-3 py-1.5"
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
            className="mt-1 w-full rounded-lg bg-sunken px-3 py-1.5"
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
            className="mt-1 w-full rounded-lg bg-sunken px-3 py-1.5"
          />
        </div>
      </div>

      <button
        type="submit"
        formAction={createCategoryAndSaveMonth}
        className="mt-4 rounded-lg bg-stone-900 px-4 py-2 font-medium text-white transition-colors hover:bg-stone-700"
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
