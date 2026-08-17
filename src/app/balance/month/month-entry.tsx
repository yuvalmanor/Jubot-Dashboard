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

import { createCategoryAndSaveMonth, recordBlanksAsZero, saveMonth } from "./actions";
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
        <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
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
              className="rounded-md bg-stone-900 px-4 py-2.5 font-medium text-white hover:bg-stone-800"
            >
              שמירת החודש
            </button>
            <p className="text-sm text-stone-500">שדה ריק פירושו שהחודש לא נרשם — אין זה אותו דבר כמו 0.</p>
          </div>
        </>
      )}

      <NewCategoryPanel categories={categories} owner={person} isSelf={isSelf} />
    </form>
  );
}

/**
 * What a save left blank, named — and the offer to record those months as nought.
 *
 * This is where the ambiguity in a blank cell is resolved, and it is resolved by a
 * person rather than by arithmetic. A blank might be an unfinished month or a
 * month in which the thing simply did not happen, and nothing in the ledger can
 * tell those apart. So the categories are listed by name, with the list in view,
 * and accepting writes real zeros — which is exactly the deliberate act the
 * null/zero distinction exists to permit.
 *
 * Nothing here is pre-accepted and nothing is implicit: the offer is a button that
 * has to be pressed, declining is a button too, and doing neither leaves the month
 * exactly as the save left it.
 */
export function BlanksOffer({
  month,
  person,
  categories,
  ledger,
  saved,
  declined,
}: {
  month: CalendarMonth;
  person: { readonly id: string; readonly displayName: string };
  categories: Categories;
  ledger: Ledger;
  saved: boolean;
  declined: boolean;
}) {
  const closure = monthClosure(ledger, categories, personScope(person.id), month);
  if (closure.state !== "open" || !(saved || declined)) return null;

  const count = closure.blanks.length;
  const back = `/balance/month?month=${monthKey(month)}&view=${person.id}&left=1`;

  if (declined) {
    return (
      <section className="rounded-lg border border-stone-300 bg-white p-5" role="status">
        <p className="font-medium">
          <bdi className="tabular">{count}</bdi> קטגוריות נותרו ללא רישום ב{formatMonth(month)}.
        </p>
        <p className="mt-1 text-sm text-stone-500">
          לא נכתב דבר. חודש שלא נרשם אינו חודש של אפס, והמאזן ימשיך להציג אותו כחסר.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50 p-5" role="status">
      <p className="font-medium text-amber-900">
        נותרו <bdi className="tabular">{count}</bdi> קטגוריות ללא רישום ב{formatMonth(month)}:
      </p>

      <ul className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-sm text-amber-900">
        {closure.blanks.map((category) => (
          <li key={category.id} className="rounded-sm bg-white/70 px-2 py-0.5">
            <bdi>{category.name}</bdi>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-sm text-amber-800">
        אם באמת לא היה בהן כלום החודש — אפשר לרשום אותן כאפס, וזה יסגור את החודש. אפס שנרשם כך זהה
        לחלוטין לאפס שהוקלד ביד, כי זה בדיוק מה שהוא.
      </p>

      <form className="mt-4 flex flex-wrap items-center gap-3">
        <input type="hidden" name="month" value={monthKey(month)} />
        <input type="hidden" name="view" value={person.id} />
        {closure.blanks.map((category) => (
          <input key={category.id} type="hidden" name="blank" value={category.id} />
        ))}

        <button
          type="submit"
          formAction={recordBlanksAsZero}
          className="rounded-md bg-stone-900 px-4 py-2 font-medium text-white hover:bg-stone-800"
        >
          רישום <bdi className="tabular">{count}</bdi> הקטגוריות כאפס
        </button>

        <Link
          href={back as Route}
          className="rounded-md border border-stone-300 bg-white px-4 py-2 font-medium hover:bg-stone-50"
        >
          השארה ריקה
        </Link>
      </form>
    </section>
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
    <details className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
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
