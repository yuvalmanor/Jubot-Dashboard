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
import { toDecimalString } from "@/domain/money/money";
import { type CalendarMonth, monthKey } from "@/domain/time/calendar-month";

import { createCategoryAndSaveMonth, saveMonth } from "./actions";
import { SummaryPanel } from "./month-panels";

/**
 * Writing a month — the one view of the three that has inputs, and only ever for
 * the signed-in Person's own categories.
 */

const LEDGER_CURRENCY = "ILS" as const;

export function MonthEntry({
  month,
  personId,
  categories,
  ledger,
}: {
  month: CalendarMonth;
  personId: string;
  categories: Categories;
  ledger: Ledger;
}) {
  const income = personMonthLines(ledger, categories, personId, month, { type: "income" });
  const expenses = personMonthLines(ledger, categories, personId, month, { type: "expense" });
  const summary = personMonthSummary(ledger, categories, personId, month, LEDGER_CURRENCY);

  return (
    <form className="space-y-6">
      <input type="hidden" name="month" value={monthKey(month)} />

      <SummaryPanel
        summary={summary}
        note="חיסכון = הכנסות − הוצאות, מחושב בכל קריאה ואינו ניתן לעריכה."
      />

      {income.length + expenses.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
          עדיין אין לך קטגוריות בחודש הזה. אפשר ליצור אחת כאן למטה, בלי לצאת מהמסך.
        </p>
      ) : (
        <>
          <EntryTable title="הכנסות" lines={income} categories={categories} />
          <EntryTable title="הוצאות" lines={expenses} categories={categories} />

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
