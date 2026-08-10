import { AppHeader } from "@/components/app-header";
import { loadCategories } from "@/db/categories";
import { DatabaseNotConfiguredError } from "@/db/client";
import { type Person, findPersonByEmail, listPeople } from "@/db/people";
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
import { monthKey } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import {
  type CategoriesErrorCode,
  mergeHouseholds,
  reassignPersonalCategory,
  renameHousehold,
  setLifespan,
} from "./actions";

export const dynamic = "force-dynamic";

/**
 * Category administration: the household names, which personal categories feed
 * them, and each category's lifespan.
 *
 * Household lines belong to both People, so either may rename or merge them.
 * A personal category is one Person's own naming, so only its owner may move or
 * retire it — the other person sees it and cannot change it.
 */

interface SearchParams {
  error?: string | string[];
  detail?: string | string[];
  done?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const TYPE_LABELS: Record<CategoryType, string> = { income: "הכנסות", expense: "הוצאות" };

export default async function CategoriesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const loaded = await loadAdmin(email);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="ניהול קטגוריות"
        subtitle="שמות משותפים, שיוך קטגוריות, ותקופת פעילות"
        back={{ href: "/balance", label: "חזרה למאזן" }}
      />

      <main className="mt-6 space-y-8 sm:mt-8">
        <Notices error={first(params.error)} detail={first(params.detail)} done={first(params.done)} />

        {loaded.kind === "ok" ? (
          <>
            <HouseholdSection categories={loaded.categories} people={loaded.people} />
            {loaded.people.map((person) => (
              <PersonSection
                key={person.id}
                person={person}
                editable={person.id === loaded.person.id}
                categories={loaded.categories}
              />
            ))}
          </>
        ) : (
          <UnavailablePanel reason={loaded.reason} />
        )}
      </main>
    </div>
  );
}

// --- loading -----------------------------------------------------------------

type LoadedAdmin =
  | { kind: "ok"; person: Person; people: readonly Person[]; categories: Categories }
  | { kind: "unavailable"; reason: string };

async function loadAdmin(email: string): Promise<LoadedAdmin> {
  try {
    const person = await findPersonByEmail(email);
    if (person === null) {
      return {
        kind: "unavailable",
        reason: `הכתובת ${email} אינה משויכת לאף אדם בטבלת people. יש לעדכן את שתי הכתובות במסד (ראו README).`,
      };
    }
    const [people, categories] = await Promise.all([listPeople(), loadCategories()]);
    return { kind: "ok", person, people, categories };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- household categories ----------------------------------------------------

function HouseholdSection({
  categories,
  people,
}: {
  categories: Categories;
  people: readonly Person[];
}) {
  const household = householdCategoriesFor(categories);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">קטגוריות משותפות</h2>
        <p className="mt-1 text-sm text-stone-600">
          לקטגוריה משותפת יש שם משלה, שאינו תלוי בשמות האישיים שמזינים אותה. שינוי השם אינו נוגע באף
          קטגוריה אישית, ומיזוג שתי קטגוריות משותפות מעביר את השיוכים בלבד — אף סכום שנרשם אינו זז.
        </p>
      </div>

      {household.length === 0 ? (
        <EmptyPanel>עדיין אין קטגוריות. אפשר ליצור את הראשונה במסך המאזן.</EmptyPanel>
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
}: {
  category: HouseholdCategory;
  contributors: readonly PersonalCategory[];
  mergeTargets: readonly HouseholdCategory[];
  people: readonly Person[];
}) {
  const nameOf = (personId: string) =>
    people.find((person) => person.id === personId)?.displayName ?? personId;

  return (
    <article className="rounded-lg border border-stone-300 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">
          <bdi>{category.name}</bdi>
        </h3>
        <span className="text-xs font-medium tracking-wide text-stone-500">
          {TYPE_LABELS[category.type]}
        </span>
      </div>

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
          <input type="hidden" name="householdCategoryId" value={category.id} />
          <div className="min-w-40 flex-1">
            <label htmlFor={`name-${category.id}`} className="block text-sm font-medium">
              שם משותף
            </label>
            <input
              id={`name-${category.id}`}
              name="householdName"
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

// --- personal categories -----------------------------------------------------

function PersonSection({
  person,
  editable,
  categories,
}: {
  person: Person;
  editable: boolean;
  categories: Categories;
}) {
  const owned = personalCategoriesFor(categories, person.id);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">
          הקטגוריות של <bdi>{person.displayName}</bdi>
        </h2>
        <p className="mt-1 text-sm text-stone-600">
          {editable
            ? "תקופת פעילות היא הדרך להוציא קטגוריה משימוש: היא נעלמת מהחודשים שמחוץ לתקופה, וכל חודש שכבר נרשם בה ממשיך להיקרא בדיוק כפי שנקרא."
            : "קטגוריות של האדם השני — לקריאה בלבד. כל אחד מנהל את השמות של עצמו."}
        </p>
      </div>

      {owned.length === 0 ? (
        <EmptyPanel>אין עדיין קטגוריות.</EmptyPanel>
      ) : (
        <ul className="space-y-3">
          {owned.map((category) => (
            <li key={category.id}>
              <PersonalCard category={category} editable={editable} categories={categories} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PersonalCard({
  category,
  editable,
  categories,
}: {
  category: PersonalCategory;
  editable: boolean;
  categories: Categories;
}) {
  const household = householdCategoryOf(categories, category.id);
  const targets = householdCategoriesFor(categories, { type: category.type });
  const retiredAt = category.activeUntil;

  return (
    <article className="rounded-lg border border-stone-300 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">
          <bdi>{category.name}</bdi>
          {retiredAt === null ? null : (
            <span className="ms-2 rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-600">
              עד <bdi className="tabular">{monthKey(retiredAt)}</bdi>
            </span>
          )}
        </h3>
        <span className="text-xs text-stone-500">
          {TYPE_LABELS[category.type]} · משותפת: <bdi>{household.name}</bdi>
        </span>
      </div>

      {!editable ? (
        <p className="mt-2 text-sm text-stone-500">
          פעילה מ־<bdi className="tabular">{monthKey(category.activeFrom)}</bdi>
          {category.activeUntil === null ? "" : ` עד ${monthKey(category.activeUntil)}`}
        </p>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <form action={setLifespan} className="flex flex-wrap items-end gap-2">
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

          <form action={reassignPersonalCategory} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="personalCategoryId" value={category.id} />
            <div className="min-w-40 flex-1">
              <label htmlFor={`household-${category.id}`} className="block text-sm font-medium">
                שיוך לקטגוריה משותפת
              </label>
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
      )}
    </article>
  );
}

// --- notices -----------------------------------------------------------------

const ERROR_MESSAGES: Record<CategoriesErrorCode, string> = {
  "no-person": "הכתובת שאיתה נכנסת אינה משויכת לאף אדם בטבלת people.",
  "not-yours": "אפשר לשנות רק קטגוריות אישיות שלך.",
  "bad-name": "השם ריק או ארוך מדי.",
  "duplicate-name": "כבר קיימת קטגוריה משותפת בשם הזה.",
  "type-mismatch": "לא ניתן לשייך הכנסה לקטגוריה משותפת של הוצאה, או להפך.",
  "unknown-category": "הקטגוריה שנבחרה אינה קיימת.",
  "bad-lifespan": "לא ניתן להוציא קטגוריה משימוש לפני החודש שבו היא מתחילה.",
  "bad-merge": "אין מה למזג — לקטגוריה המשותפת הזו אין קטגוריות אישיות.",
  failed: "הפעולה נכשלה.",
};

function isErrorCode(value: string | undefined): value is CategoriesErrorCode {
  return value !== undefined && value in ERROR_MESSAGES;
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

  if (done === undefined) return null;

  const [kind = "", subject = ""] = [done.slice(0, done.indexOf(":")), done.slice(done.indexOf(":") + 1)];
  const message =
    kind === "renamed"
      ? "שם הקטגוריה המשותפת שונה. אף קטגוריה אישית לא השתנתה."
      : kind === "merged"
        ? "השיוך עודכן. כל הרישומים נשמרו כפי שהיו."
        : "תקופת הפעילות עודכנה. חודשים שכבר נרשמו ממשיכים להיקרא כרגיל.";

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

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
      {children}
    </p>
  );
}

function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן לקרוא את הקטגוריות</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}
