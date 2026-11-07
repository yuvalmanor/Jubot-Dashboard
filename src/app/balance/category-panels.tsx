import Link from "next/link";

import {
  type Categories,
  type CategoryType,
  type HouseholdCategory,
  type PersonalCategory,
  householdCategoriesFor,
  householdCategoryOf,
  householdGroups,
  isRetired,
  personalCategoriesFor,
  personalCategoriesOf,
} from "@/domain/categories/categories";
import { type CalendarMonth, monthKey } from "@/domain/time/calendar-month";

import { createPersonalCategory, saveHouseholdCategories, savePersonalCategories } from "./category-actions";
import { SaveButton } from "./chrome";
import { type GridLinks } from "./grid-links";
import { ReturnToFields } from "./grid-panels";

/**
 * Category administration, beneath the grid it administers.
 *
 * It used to be a route of its own, which meant every change was made on a
 * screen with no figures on it. Here the table is directly above: rename a
 * household line and the row it names is in view, merge two and the money lands
 * in a row you can see. Nothing in this panel touches an Entry — a rename is one
 * name column, a merge moves assignments, a lifespan is two dates — so every
 * figure in the table above reads identically before and after.
 *
 * It is **two tables and two buttons**, not thirty-five cards with six buttons
 * each. A card per category meant renaming four lines was four page loads, and
 * any edit typed into another card was discarded by the one that got saved —
 * which is the wrong shape for work that arrives in batches. Change as many
 * rows as you like and press once; only what differs from what is stored is
 * written.
 *
 * Both People administer both columns. A Personal Category is still one Person's
 * own naming, and the table says whose each one is, but there is no read-only
 * half of this screen any more.
 *
 * Two things are absent by design rather than unbuilt. **Type** cannot be
 * changed: a category does not change direction from month to month, and one
 * that did would make every month before the change unreadable. And nothing is
 * **deleted** — retirement is a lifespan, so a category taken out of use keeps
 * every month it was ever recorded in.
 */

const TYPE_LABELS: Record<CategoryType, string> = { income: "הכנסות", expense: "הוצאות" };

/**
 * The Groups a line may be put into.
 *
 * A `<select>` and no longer a free field. A Group is created by being written
 * on a line and has no table behind it, so a text box was the honest control —
 * but it is also how `הלוואות` and `הלווואות` came to exist side by side in this
 * very ledger, and a taxonomy that invites that is not worth the flexibility. A
 * new name is made once, in the row below the table.
 */
const SUGGESTED_GROUPS = ["הוצאות קבועות", "חשבונות"] as const;

function groupOptions(categories: Categories): readonly string[] {
  return [...new Set([...SUGGESTED_GROUPS, ...householdGroups(categories)])];
}

/** One table's save, pinned to the foot of it so it is reachable from any row. */
function SaveBar({ children, note }: { children: React.ReactNode; note: string }) {
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur">
      <SaveButton>{children}</SaveButton>
      <span className="text-xs text-stone-500">{note}</span>
    </div>
  );
}

/** The head of a table column. Quiet: the rows are what is being read. */
function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`border-b border-line-strong px-2.5 py-2 text-start text-xs font-medium text-stone-500 ${className}`}
    >
      {children}
    </th>
  );
}

const FIELD = "w-full rounded-lg bg-sunken px-2.5 py-1.5 text-sm";

/** The anchor the "ניהול קטגוריות" link lands on, so opening the panel scrolls to it. */
export const CATEGORY_PANEL_ID = "categories";

export function CategoryAdminPanel({
  categories,
  people,
  links,
  today,
}: {
  categories: Categories;
  people: readonly { readonly id: string; readonly displayName: string }[];
  links: GridLinks;
  /** What a new category's lifespan starts at unless the person says otherwise. */
  today: CalendarMonth;
}) {
  return (
    <section id={CATEGORY_PANEL_ID} className="space-y-6 scroll-mt-4">
      <div className="rounded-card bg-surface shadow-card p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="title text-lg font-semibold">ניהול קטגוריות</h2>
          <Link href={links.closeAdmin} className="text-sm text-stone-600 underline-offset-4 hover:underline">
            סגירת הפאנל
          </Link>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-stone-600">
          כל פעולה כאן משנה את השמות והשיוכים שמעל הכסף, ולא את הכסף עצמו — הטבלה שלמעלה מציגה את אותם
          סכומים לפני ואחרי. שניכם מנהלים את שני הטורים. סוג הקטגוריה נקבע ביצירה ואינו משתנה, ושום דבר
          כאן אינו מוחק: יציאה משימוש היא תקופת פעילות, וכל חודש שכבר נרשם ממשיך להיקרא בדיוק כפי שנקרא.
          בכל טבלה אפשר לשנות כמה שורות ולשמור פעם אחת.
        </p>
      </div>

      <NewCategorySection categories={categories} people={people} links={links} today={today} />
      <HouseholdSection categories={categories} people={people} links={links} />
      <PersonSection categories={categories} people={people} links={links} />
    </section>
  );
}

// --- creating ----------------------------------------------------------------

/**
 * Creating a category, which until this phase lived only on the month form — so
 * making one always required going somewhere you did not want to be.
 *
 * The household target is not optional. A Personal Category always creates or
 * joins a Household Category in one indivisible operation, so money recorded
 * personally cannot go missing from the household reading.
 */
function NewCategorySection({
  categories,
  people,
  links,
  today,
}: {
  categories: Categories;
  people: readonly { readonly id: string; readonly displayName: string }[];
  links: GridLinks;
  today: CalendarMonth;
}) {
  const households = householdCategoriesFor(categories);

  return (
    <section className="rounded-card bg-surface shadow-card p-5 sm:p-6">
      <h3 className="text-base font-semibold">קטגוריה חדשה</h3>
      <p className="mt-1 text-sm text-stone-600">
        קטגוריה אישית תמיד נכנסת לקטגוריה משותפת — או חדשה, או קיימת. אפשר להתחיל אותה בחודש מוקדם יותר
        כדי לרשום בה חודשים שכבר עברו.
      </p>

      <form action={createPersonalCategory} className="mt-4 grid gap-4 sm:grid-cols-2">
        <ReturnToFields links={links} />

        <div>
          <label htmlFor="new-person" className="block text-sm font-medium">
            של מי
          </label>
          <select
            id="new-person"
            name="personId"
            className="mt-1 w-full rounded-lg bg-sunken px-3 py-1.5"
          >
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.displayName}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="new-name" className="block text-sm font-medium">
            שם הקטגוריה האישית
          </label>
          <input
            id="new-name"
            name="name"
            type="text"
            autoComplete="off"
            maxLength={60}
            className="mt-1 w-full rounded-lg bg-sunken px-3 py-1.5"
          />
        </div>

        <fieldset>
          <legend className="block text-sm font-medium">סוג</legend>
          <div className="mt-2 flex gap-4">
            <TypeChoice value="expense" label="הוצאה" defaultChecked />
            <TypeChoice value="income" label="הכנסה" />
          </div>
          <p className="mt-1 text-xs text-stone-500">נקבע כאן פעם אחת ואינו ניתן לשינוי אחר כך.</p>
        </fieldset>

        <div>
          <label htmlFor="new-active-from" className="block text-sm font-medium">
            פעילה מחודש
          </label>
          <input
            id="new-active-from"
            name="activeFrom"
            type="month"
            defaultValue={monthKey(today)}
            min="2000-01"
            max="2100-12"
            className="mt-1 w-full rounded-lg bg-sunken px-3 py-1.5"
          />
        </div>

        <div>
          <label htmlFor="new-household" className="block text-sm font-medium">
            קטגוריה משותפת
          </label>
          <select
            id="new-household"
            name="householdCategoryId"
            defaultValue="new"
            className="mt-1 w-full rounded-lg bg-sunken px-3 py-1.5"
          >
            <option value="new">חדשה</option>
            {households.map((household) => (
              <option key={household.id} value={household.id}>
                {household.name} ({TYPE_LABELS[household.type]})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="new-household-name" className="block text-sm font-medium">
            שם הקטגוריה המשותפת החדשה
          </label>
          <input
            id="new-household-name"
            name="newHouseholdName"
            type="text"
            autoComplete="off"
            maxLength={60}
            placeholder="ברירת מחדל: אותו שם"
            className="mt-1 w-full rounded-lg bg-sunken px-3 py-1.5"
          />
        </div>

        <div className="sm:col-span-2">
          <button
            type="submit"
            className="rounded-lg bg-stone-900 px-4 py-2 font-medium text-white hover:bg-stone-700"
          >
            יצירת הקטגוריה
          </button>
        </div>
      </form>
    </section>
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
      <input type="radio" name="type" value={value} defaultChecked={defaultChecked} />
      {label}
    </label>
  );
}

// --- household categories ----------------------------------------------------

/**
 * Every household line as one row, and one button under the lot.
 *
 * The columns are the four things that are actually administered — what the line
 * is called, which Group it is in, whether מעקב תעריפים lists it, and what it
 * should be merged into — with what feeds it printed alongside, because a name
 * on its own does not say whose spending it is.
 *
 * Merging stays a per-row choice rather than a checkbox-and-target, because a
 * merge is the one irreversible-looking thing here and naming its destination on
 * the row being emptied is what makes it readable: "this one goes into that one".
 */
function HouseholdSection({
  categories,
  people,
  links,
}: {
  categories: Categories;
  people: readonly { readonly id: string; readonly displayName: string }[];
  links: GridLinks;
}) {
  const household = householdCategoriesFor(categories);
  const groups = groupOptions(categories);
  const nameOf = (personId: string) =>
    people.find((person) => person.id === personId)?.displayName ?? personId;

  if (household.length === 0) {
    return (
      <section className="space-y-3">
        <SectionHeading
          title="קטגוריות משותפות"
          note="לקטגוריה משותפת יש שם משלה, שאינו תלוי בשמות האישיים שמזינים אותה."
        />
        <EmptyPanel>עדיין אין קטגוריות משותפות. הן נוצרות יחד עם הקטגוריה האישית הראשונה.</EmptyPanel>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <SectionHeading
        title="קטגוריות משותפות"
        note="שינוי השם אינו נוגע באף קטגוריה אישית, קבוצה היא סימון בלבד, ומיזוג מעביר שיוכים — אף סכום שנרשם אינו זז. אפשר לשנות כמה שורות ולשמור פעם אחת."
      />

      <form action={saveHouseholdCategories} className="overflow-hidden rounded-card bg-surface shadow-card">
        <ReturnToFields links={links} />

        <div className="max-h-[60svh] overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr>
                <Th className="min-w-44">שם משותף</Th>
                <Th className="min-w-36">קבוצה</Th>
                <Th className="min-w-40">מיזוג לתוך</Th>
                <Th>מעקב</Th>
                <Th className="min-w-48">מוזנת מ־</Th>
              </tr>
            </thead>
            <tbody>
              {household.map((category) => (
                <HouseholdRow
                  key={category.id}
                  category={category}
                  groups={groups}
                  targets={householdCategoriesFor(categories, { type: category.type }).filter(
                    (candidate) => candidate.id !== category.id,
                  )}
                  contributors={personalCategoriesOf(categories, category.id)}
                  nameOf={nameOf}
                />
              ))}
            </tbody>
          </table>
        </div>

        <SaveBar note="רק מה שהשתנה נכתב. מיזוגים מבוצעים אחרונים.">שמירת השינויים</SaveBar>
      </form>
    </section>
  );
}

function HouseholdRow({
  category,
  groups,
  targets,
  contributors,
  nameOf,
}: {
  category: HouseholdCategory;
  groups: readonly string[];
  targets: readonly HouseholdCategory[];
  contributors: readonly PersonalCategory[];
  nameOf: (personId: string) => string;
}) {
  const id = category.id;

  return (
    <tr className="border-t border-stone-100 align-top [&>td]:border-t [&>td]:border-stone-100 [&>td]:px-2.5 [&>td]:py-2">
      {/* The id travels on the row rather than in a list at the top: a row that
          is on the form is a row the save looks at, and there is no second place
          that could disagree about which those are. */}
      <td>
        <input type="hidden" name="id" value={id} />
        <input
          name={`name:${id}`}
          type="text"
          defaultValue={category.name}
          maxLength={60}
          autoComplete="off"
          aria-label={`שם משותף — ${category.name}`}
          className={FIELD}
        />
        <span className="mt-0.5 block text-[11px] text-stone-400">{TYPE_LABELS[category.type]}</span>
      </td>

      <td>
        <select
          name={`group:${id}`}
          defaultValue={category.group ?? ""}
          aria-label={`קבוצה — ${category.name}`}
          className={FIELD}
        >
          <option value="">ללא</option>
          {groups.map((group) => (
            <option key={group} value={group}>
              {group}
            </option>
          ))}
          {/* A Group that was typed before the list became a list still has to be
              selectable, or saving an untouched row would quietly clear it. */}
          {category.group !== null && !groups.includes(category.group) ? (
            <option value={category.group}>{category.group}</option>
          ) : null}
        </select>
      </td>

      <td>
        <select
          name={`merge:${id}`}
          defaultValue=""
          aria-label={`מיזוג לתוך — ${category.name}`}
          className={FIELD}
        >
          <option value="">— לא למזג —</option>
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.name}
            </option>
          ))}
        </select>
      </td>

      <td className="text-center">
        <input
          type="checkbox"
          name={`watched:${id}`}
          value="1"
          defaultChecked={category.watched}
          aria-label={`מעקב תעריפים — ${category.name}`}
          className="mt-2"
        />
      </td>

      <td className="text-xs text-stone-500">
        {contributors.length === 0 ? (
          <span className="text-stone-400">שום קטגוריה אישית</span>
        ) : (
          contributors.map((contributor, index) => (
            <span key={contributor.id}>
              {index === 0 ? null : ", "}
              <bdi>{contributor.name}</bdi>
              <span className="text-stone-400"> ({nameOf(contributor.personId)})</span>
              {isRetired(contributor) ? <span className="text-stone-400"> · יצאה משימוש</span> : null}
            </span>
          ))
        )}
      </td>
    </tr>
  );
}

// --- personal categories -----------------------------------------------------

/**
 * Both People's categories in one table, with whose each is a column rather than
 * a heading over a section of its own.
 *
 * One table and not two, because the questions asked of this screen cut across
 * the pair — "which of these is still active", "which of them feed חשבונות" —
 * and two tables means asking each of them twice. The owner is a column, and the
 * rows are ordered by it so each Person's own set still reads as a block.
 */
function PersonSection({
  categories,
  people,
  links,
}: {
  categories: Categories;
  people: readonly { readonly id: string; readonly displayName: string }[];
  links: GridLinks;
}) {
  const owned = people.flatMap((person) =>
    personalCategoriesFor(categories, person.id).map((category) => ({ person, category })),
  );

  if (owned.length === 0) {
    return (
      <section className="space-y-3">
        <SectionHeading title="קטגוריות אישיות" note="כל קטגוריה שייכת לאדם אחד ונקראת בשמו." />
        <EmptyPanel>אין עדיין קטגוריות אישיות. אפשר ליצור אחת למעלה.</EmptyPanel>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <SectionHeading
        title="קטגוריות אישיות"
        note="השם הוא שלה או שלו, וניתן לתיקון — כתיב שגוי שנגרר מהגיליון אינו גזרת גורל. תקופת פעילות היא הדרך להוציא קטגוריה משימוש: כל חודש שכבר נרשם בה ממשיך להיקרא בדיוק כפי שנקרא."
      />

      <form action={savePersonalCategories} className="overflow-hidden rounded-card bg-surface shadow-card">
        <ReturnToFields links={links} />

        <div className="max-h-[60svh] overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr>
                <Th className="min-w-44">שם אישי</Th>
                <Th>של מי</Th>
                <Th className="min-w-40">קטגוריה משותפת</Th>
                <Th>פעילה מ־</Th>
                <Th>עד (כולל)</Th>
              </tr>
            </thead>
            <tbody>
              {owned.map(({ person, category }) => (
                <PersonalRow
                  key={category.id}
                  category={category}
                  owner={person.displayName}
                  household={householdCategoryOf(categories, category.id)}
                  targets={householdCategoriesFor(categories, { type: category.type })}
                />
              ))}
            </tbody>
          </table>
        </div>

        <SaveBar note="רק מה שהשתנה נכתב. שינוי שיוך מבוצע אחרון.">שמירת השינויים</SaveBar>
      </form>
    </section>
  );
}

function PersonalRow({
  category,
  owner,
  household,
  targets,
}: {
  category: PersonalCategory;
  owner: string;
  household: HouseholdCategory;
  targets: readonly HouseholdCategory[];
}) {
  const id = category.id;

  return (
    <tr className="align-top [&>td]:border-t [&>td]:border-stone-100 [&>td]:px-2.5 [&>td]:py-2">
      <td>
        <input type="hidden" name="id" value={id} />
        <input
          name={`name:${id}`}
          type="text"
          defaultValue={category.name}
          maxLength={60}
          autoComplete="off"
          aria-label={`שם אישי — ${category.name}`}
          className={FIELD}
        />
        <span className="mt-0.5 block text-[11px] text-stone-400">{TYPE_LABELS[category.type]}</span>
      </td>

      <td className="py-3 text-xs text-stone-500">
        <bdi>{owner}</bdi>
      </td>

      <td>
        {/* Never "none": the options are the household lines of this type plus a
            new one, so no choice here can leave the category unassigned. */}
        <select
          name={`household:${id}`}
          defaultValue={household.id}
          aria-label={`קטגוריה משותפת — ${category.name}`}
          className={FIELD}
        >
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.name}
            </option>
          ))}
          <option value="new">חדשה, בשם הזה</option>
        </select>
      </td>

      <td>
        <input
          name={`from:${id}`}
          type="month"
          defaultValue={monthKey(category.activeFrom)}
          min="2000-01"
          max="2100-12"
          aria-label={`פעילה מחודש — ${category.name}`}
          className={FIELD}
        />
      </td>

      <td>
        <input
          name={`until:${id}`}
          type="month"
          defaultValue={category.activeUntil === null ? "" : monthKey(category.activeUntil)}
          min="2000-01"
          max="2100-12"
          aria-label={`פעילה עד חודש — ${category.name}`}
          className={FIELD}
        />
      </td>
    </tr>
  );
}

function SectionHeading({ title, note }: { title: string; note: string }) {
  return (
    <div className="px-1">
      <h3 className="title text-base font-semibold">{title}</h3>
      <p className="mt-1 max-w-3xl text-sm text-stone-600">{note}</p>
    </div>
  );
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-card bg-surface shadow-card p-5 text-stone-600">
      {children}
    </p>
  );
}
