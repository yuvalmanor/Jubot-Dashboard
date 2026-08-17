import Link from "next/link";

import {
  type Categories,
  type CategoryType,
  type HouseholdCategory,
  type PersonalCategory,
  householdCategoriesFor,
  householdCategoryOf,
  isRetired,
  personalCategoriesFor,
  personalCategoriesOf,
} from "@/domain/categories/categories";
import { type CalendarMonth, monthKey } from "@/domain/time/calendar-month";

import {
  createPersonalCategory,
  mergeHouseholds,
  reassignPersonalCategory,
  renameHousehold,
  renamePersonal,
  setLifespan,
  setWatched,
} from "./category-actions";
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
 * Both People administer both columns. A Personal Category is still one Person's
 * own naming, and the panel says whose each one is, but there is no read-only
 * half of this screen any more.
 *
 * Two things are absent by design rather than unbuilt. **Type** cannot be
 * changed: a category does not change direction from month to month, and one
 * that did would make every month before the change unreadable. And nothing is
 * **deleted** — retirement is a lifespan, so a category taken out of use keeps
 * every month it was ever recorded in.
 */

const TYPE_LABELS: Record<CategoryType, string> = { income: "הכנסות", expense: "הוצאות" };

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
      <div className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">ניהול קטגוריות</h2>
          <Link href={links.closeAdmin} className="text-sm text-stone-600 underline-offset-4 hover:underline">
            סגירת הפאנל
          </Link>
        </div>
        <p className="mt-2 text-sm text-stone-600">
          כל פעולה כאן משנה את השמות והשיוכים שמעל הכסף, ולא את הכסף עצמו — הטבלה שלמעלה מציגה את אותם
          סכומים לפני ואחרי. שניכם מנהלים את שני הטורים. סוג הקטגוריה נקבע ביצירה ואינו משתנה, ושום דבר
          כאן אינו מוחק: הוצאה משימוש היא תקופת פעילות, וכל חודש שכבר נרשם ממשיך להיקרא בדיוק כפי שנקרא.
        </p>
      </div>

      <NewCategorySection categories={categories} people={people} links={links} today={today} />
      <HouseholdSection categories={categories} people={people} links={links} />
      {people.map((person) => (
        <PersonSection key={person.id} person={person} categories={categories} links={links} />
      ))}
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
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
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
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5"
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
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5"
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
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5"
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
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5"
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
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5"
          />
        </div>

        <div className="sm:col-span-2">
          <button
            type="submit"
            className="rounded-md bg-stone-900 px-4 py-2 font-medium text-white hover:bg-stone-800"
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

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">קטגוריות משותפות</h3>
        <p className="mt-1 text-sm text-stone-600">
          לקטגוריה משותפת יש שם משלה, שאינו תלוי בשמות האישיים שמזינים אותה. שינוי השם אינו נוגע באף
          קטגוריה אישית, ומיזוג שתי קטגוריות משותפות מעביר את השיוכים בלבד — אף סכום שנרשם אינו זז.
        </p>
      </div>

      {household.length === 0 ? (
        <EmptyPanel>עדיין אין קטגוריות משותפות. הן נוצרות יחד עם הקטגוריה האישית הראשונה.</EmptyPanel>
      ) : (
        <ul className="space-y-4">
          {household.map((category) => (
            <li key={category.id}>
              <HouseholdCard
                category={category}
                contributors={personalCategoriesOf(categories, category.id)}
                mergeTargets={householdCategoriesFor(categories, { type: category.type }).filter(
                  (candidate) => candidate.id !== category.id,
                )}
                people={people}
                links={links}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HouseholdCard({
  category,
  contributors,
  mergeTargets,
  people,
  links,
}: {
  category: HouseholdCategory;
  contributors: readonly PersonalCategory[];
  mergeTargets: readonly HouseholdCategory[];
  people: readonly { readonly id: string; readonly displayName: string }[];
  links: GridLinks;
}) {
  const nameOf = (personId: string) =>
    people.find((person) => person.id === personId)?.displayName ?? personId;

  return (
    <article className="rounded-lg border border-stone-300 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-base font-semibold">
          <bdi>{category.name}</bdi>
          {category.watched ? (
            <span className="ms-2 rounded bg-sky-100 px-2 py-0.5 text-xs font-normal text-sky-900">
              במעקב תעריפים
            </span>
          ) : null}
        </h4>
        <span className="text-xs font-medium tracking-wide text-stone-500">
          {TYPE_LABELS[category.type]}
        </span>
      </div>

      <WatchToggle category={category} links={links} />

      <p className="mt-2 text-sm text-stone-600">
        מוזנת מ־
        {contributors.length === 0 ? (
          <span className="text-stone-400">שום קטגוריה אישית</span>
        ) : (
          contributors.map((contributor, index) => (
            <span key={contributor.id}>
              {index === 0 ? null : ", "}
              <bdi>{contributor.name}</bdi>
              <span className="text-stone-500"> ({nameOf(contributor.personId)})</span>
              {isRetired(contributor) ? <span className="text-stone-400"> · הוצאה משימוש</span> : null}
            </span>
          ))
        )}
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <form action={renameHousehold} className="flex flex-wrap items-end gap-2">
          <ReturnToFields links={links} />
          <input type="hidden" name="householdCategoryId" value={category.id} />
          <div className="min-w-40 flex-1">
            <label htmlFor={`name-${category.id}`} className="block text-sm font-medium">
              שם משותף
            </label>
            <input
              id={`name-${category.id}`}
              name="name"
              type="text"
              defaultValue={category.name}
              maxLength={60}
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5"
            />
          </div>
          <button
            type="submit"
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
          >
            שינוי שם
          </button>
        </form>

        {mergeTargets.length === 0 ? null : (
          <form action={mergeHouseholds} className="flex flex-wrap items-end gap-2">
            <ReturnToFields links={links} />
            <input type="hidden" name="sourceHouseholdCategoryId" value={category.id} />
            <div className="min-w-40 flex-1">
              <label htmlFor={`merge-${category.id}`} className="block text-sm font-medium">
                מיזוג לתוך
              </label>
              <select
                id={`merge-${category.id}`}
                name="targetHouseholdCategoryId"
                className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5"
              >
                {mergeTargets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
            >
              מיזוג
            </button>
          </form>
        )}
      </div>
    </article>
  );
}

/**
 * The one flag that decides what מעקב תעריפים lists.
 *
 * It is on the household card and not on the personal rows because a rate paid
 * half by each Person is one rate, and the panel sums both People automatically.
 * Unticking posts nothing, which is exactly what "not watched" is — so the same
 * form both flags and unflags, and neither is a special case.
 *
 * It writes one boolean. No amount moves, and the table above the panel reads
 * identically before and after.
 */
function WatchToggle({ category, links }: { category: HouseholdCategory; links: GridLinks }) {
  return (
    <form action={setWatched} className="mt-3 flex flex-wrap items-center gap-3">
      <ReturnToFields links={links} />
      <input type="hidden" name="householdCategoryId" value={category.id} />
      {/* An explicit pairing rather than a wrapping label: a bare checkbox whose
          only value is "1" is announced as "1" by anything reading the page. */}
      <input
        id={`watched-${category.id}`}
        type="checkbox"
        name="watched"
        value="1"
        defaultChecked={category.watched}
      />
      <label htmlFor={`watched-${category.id}`} className="-ms-1.5 text-sm">
        מעקב תעריפים
      </label>
      <button
        type="submit"
        className="rounded-md border border-stone-300 bg-white px-3 py-1 text-sm font-medium hover:bg-stone-50"
      >
        שמירת המעקב
      </button>
      <span className="text-xs text-stone-500">
        מוסיף את השורה לפאנל שמתחת לטבלה. אינו מזיז שום סכום.
      </span>
    </form>
  );
}

// --- personal categories -----------------------------------------------------

function PersonSection({
  person,
  categories,
  links,
}: {
  person: { readonly id: string; readonly displayName: string };
  categories: Categories;
  links: GridLinks;
}) {
  const owned = personalCategoriesFor(categories, person.id);

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">
          הקטגוריות של <bdi>{person.displayName}</bdi>
        </h3>
        <p className="mt-1 text-sm text-stone-600">
          השם הוא שלה או שלו, וניתן לתיקון — כתיב שגוי שנגרר מהגיליון אינו גזרת גורל. תקופת פעילות היא
          הדרך להוציא קטגוריה משימוש: היא נעלמת מהחודשים שמחוץ לתקופה, וכל חודש שכבר נרשם בה ממשיך
          להיקרא בדיוק כפי שנקרא.
        </p>
      </div>

      {owned.length === 0 ? (
        <EmptyPanel>
          אין עדיין קטגוריות ל<bdi>{person.displayName}</bdi>. אפשר ליצור אחת למעלה.
        </EmptyPanel>
      ) : (
        <ul className="space-y-3">
          {owned.map((category) => (
            <li key={category.id}>
              <PersonalCard category={category} categories={categories} links={links} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PersonalCard({
  category,
  categories,
  links,
}: {
  category: PersonalCategory;
  categories: Categories;
  links: GridLinks;
}) {
  const household = householdCategoryOf(categories, category.id);
  const targets = householdCategoriesFor(categories, { type: category.type });

  return (
    <article className="rounded-lg border border-stone-300 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-medium">
          <bdi>{category.name}</bdi>
          {category.activeUntil === null ? null : (
            <span className="ms-2 rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-600">
              עד <bdi className="tabular">{monthKey(category.activeUntil)}</bdi>
            </span>
          )}
        </h4>
        <span className="text-xs text-stone-500">
          {TYPE_LABELS[category.type]} · משותפת: <bdi>{household.name}</bdi>
        </span>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <form action={renamePersonal} className="flex flex-wrap items-end gap-2">
          <ReturnToFields links={links} />
          <input type="hidden" name="personalCategoryId" value={category.id} />
          <div className="min-w-40 flex-1">
            <label htmlFor={`personal-name-${category.id}`} className="block text-sm font-medium">
              שם אישי
            </label>
            <input
              id={`personal-name-${category.id}`}
              name="name"
              type="text"
              defaultValue={category.name}
              maxLength={60}
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5"
            />
          </div>
          <button
            type="submit"
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
          >
            שינוי שם
          </button>
        </form>

        <form action={setLifespan} className="flex flex-wrap items-end gap-2">
          <ReturnToFields links={links} />
          <input type="hidden" name="personalCategoryId" value={category.id} />
          <div>
            <label htmlFor={`from-${category.id}`} className="block text-sm font-medium">
              פעילה מחודש
            </label>
            <input
              id={`from-${category.id}`}
              name="activeFrom"
              type="month"
              defaultValue={monthKey(category.activeFrom)}
              min="2000-01"
              max="2100-12"
              className="mt-1 rounded-md border border-stone-300 px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor={`until-${category.id}`} className="block text-sm font-medium">
              עד חודש (כולל)
            </label>
            <input
              id={`until-${category.id}`}
              name="activeUntil"
              type="month"
              defaultValue={category.activeUntil === null ? "" : monthKey(category.activeUntil)}
              min="2000-01"
              max="2100-12"
              className="mt-1 rounded-md border border-stone-300 px-2 py-1.5 text-sm"
            />
          </div>
          <button
            type="submit"
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
          >
            שמירת תקופה
          </button>
        </form>

        <form action={reassignPersonalCategory} className="flex flex-wrap items-end gap-2 lg:col-span-2">
          <ReturnToFields links={links} />
          <input type="hidden" name="personalCategoryId" value={category.id} />
          <div className="min-w-40 flex-1">
            <label htmlFor={`household-${category.id}`} className="block text-sm font-medium">
              שיוך לקטגוריה משותפת
            </label>
            {/* Never "none": the options are the household lines of this type plus
                a new one, so no choice here can leave the category unassigned. */}
            <select
              id={`household-${category.id}`}
              name="householdCategoryId"
              defaultValue={household.id}
              className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5"
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
              <option value="new">חדשה…</option>
            </select>
          </div>
          <div>
            <label htmlFor={`new-household-${category.id}`} className="block text-sm font-medium">
              שם החדשה
            </label>
            <input
              id={`new-household-${category.id}`}
              name="newHouseholdName"
              type="text"
              maxLength={60}
              autoComplete="off"
              placeholder="ברירת מחדל: אותו שם"
              className="mt-1 w-40 rounded-md border border-stone-300 px-3 py-1.5"
            />
          </div>
          <button
            type="submit"
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
          >
            שיוך
          </button>
        </form>
      </div>
    </article>
  );
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
      {children}
    </p>
  );
}
