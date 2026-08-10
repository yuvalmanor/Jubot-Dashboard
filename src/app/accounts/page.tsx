import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { loadAccounts } from "@/db/accounts";
import { DatabaseNotConfiguredError } from "@/db/client";
import { type Person, findPersonByEmail, listPeople } from "@/db/people";
import { type Currency } from "@/domain/money/money";
import {
  type Account,
  type AssetCategory,
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABELS,
  VALUE_BASES,
  VALUE_BASIS_LABELS,
} from "@/domain/snapshot/snapshot";
import { dateKey, dateOf, formatDate } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

import { type AccountsErrorCode, createAccount, editAccount, setAccountLifespan } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Where value is held. This screen defines accounts and nothing else — no balance
 * is entered here, because how much is in an account is a fact with a date on it,
 * and that is what a Snapshot is for.
 */

const CURRENCIES: readonly Currency[] = ["ILS", "USD"];

interface SearchParams {
  error?: string | string[];
  detail?: string | string[];
  done?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AccountsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const loaded = await loadPage(email);
  const today = dateOf(new Date());

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="חשבונות"
        subtitle="הגדרת החשבונות שהמיפוי קורא מהם"
        back={{ href: "/snapshots", label: "חזרה למיפוי" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <Notices error={first(params.error)} detail={first(params.detail)} done={first(params.done)} />

        {loaded.kind === "ok" ? (
          <>
            <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
              <h2 className="text-sm font-semibold tracking-wide text-stone-500">חשבון חדש</h2>
              <p className="mt-1 text-sm text-stone-600">
                כל חשבון שייך לאדם, מוחזק במטבע משלו, ומחויב בבסיס שווי — שווי שוק, עלות או הערכה.
                אין ברירת מחדל: סכום שלא ידוע איך הגיעו אליו הוא בדיוק מה שהמערכת הזאת קיימת כדי למנוע.
              </p>

              <form action={createAccount} className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="שם החשבון">
                  <input
                    name="name"
                    required
                    maxLength={60}
                    className="w-full rounded-md border border-stone-300 px-3 py-2"
                  />
                </Field>

                <Field label="אדם">
                  <Select name="personId" defaultValue={loaded.person.id}>
                    {loaded.people.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.displayName}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="מטבע" note="לא ניתן לשינוי אחר כך — זה מה שהחשבון הוא">
                  <Select name="currency" defaultValue="ILS">
                    {CURRENCIES.map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="בסיס שווי">
                  <Select name="valueBasis" defaultValue="market">
                    {VALUE_BASES.map((basis) => (
                      <option key={basis} value={basis}>
                        {VALUE_BASIS_LABELS[basis]}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="קטגוריה" note="לפיה נעשים הריכוזים">
                  <Select name="category" defaultValue="liquid">
                    {ASSET_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {ASSET_CATEGORY_LABELS[category]}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="סוג נכס" note="במילים שלכם — עובר ושב, קרן כספית, פנסיה">
                  <input
                    name="assetKind"
                    required
                    maxLength={60}
                    list="asset-kinds"
                    className="w-full rounded-md border border-stone-300 px-3 py-2"
                  />
                  <datalist id="asset-kinds">
                    {loaded.assetKinds.map((kind) => (
                      <option key={kind} value={kind} />
                    ))}
                  </datalist>
                </Field>

                <Field label="תאריך פתיחה">
                  <input
                    type="date"
                    name="openedOn"
                    defaultValue={dateKey(today)}
                    required
                    className="w-full rounded-md border border-stone-300 px-3 py-2"
                  />
                </Field>

                <div className="flex items-end">
                  <button
                    type="submit"
                    className="rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
                  >
                    יצירת חשבון
                  </button>
                </div>
              </form>
            </section>

            {loaded.accounts.length === 0 ? (
              <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
                אין עדיין חשבונות. צילום ראשון יכלול כל חשבון שיוגדר כאן.
              </p>
            ) : (
              ASSET_CATEGORIES.map((category) => (
                <CategorySection
                  key={category}
                  category={category}
                  accounts={loaded.accounts.filter((account) => account.category === category)}
                  people={loaded.people}
                  assetKinds={loaded.assetKinds}
                />
              ))
            )}

            <p className="text-sm text-stone-500">
              סגירת חשבון היא סוף תקופה ולא מחיקה: הצילומים שהחשבון מופיע בהם ממשיכים להיקרא בדיוק כפי
              שנקראו.{" "}
              <Link href="/snapshots" className="underline underline-offset-4">
                מעבר למיפוי
              </Link>
            </p>
          </>
        ) : (
          <UnavailablePanel reason={loaded.reason} />
        )}
      </main>
    </div>
  );
}

// --- loading -----------------------------------------------------------------

type Loaded =
  | {
      kind: "ok";
      person: Person;
      people: readonly Person[];
      accounts: readonly Account[];
      assetKinds: readonly string[];
    }
  | { kind: "unavailable"; reason: string };

async function loadPage(email: string): Promise<Loaded> {
  try {
    const person = await findPersonByEmail(email);
    if (person === null) {
      return {
        kind: "unavailable",
        reason: `הכתובת ${email} אינה משויכת לאף אדם בטבלת people. יש לעדכן את שתי הכתובות במסד (ראו README).`,
      };
    }
    const [people, accounts] = await Promise.all([listPeople(), loadAccounts()]);
    const assetKinds = [...new Set(accounts.map((account) => account.assetKind))].sort((left, right) =>
      left.localeCompare(right, "he"),
    );
    return { kind: "ok", person, people, accounts, assetKinds };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- the list ----------------------------------------------------------------

function CategorySection({
  category,
  accounts,
  people,
  assetKinds,
}: {
  category: AssetCategory;
  accounts: readonly Account[];
  people: readonly Person[];
  assetKinds: readonly string[];
}) {
  if (accounts.length === 0) return null;

  return (
    <section className="rounded-lg border border-stone-300 bg-white">
      <h2 className="border-b border-stone-200 px-5 py-3 text-sm font-semibold tracking-wide text-stone-500">
        {ASSET_CATEGORY_LABELS[category]}
      </h2>
      <ul className="divide-y divide-stone-200">
        {accounts.map((account) => (
          <li key={account.id}>
            <AccountRow account={account} people={people} assetKinds={assetKinds} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function AccountRow({
  account,
  people,
  assetKinds,
}: {
  account: Account;
  people: readonly Person[];
  assetKinds: readonly string[];
}) {
  const owner = people.find((person) => person.id === account.personId)?.displayName ?? account.personId;

  return (
    <details className="group">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
        <span className="min-w-0 flex-1 font-medium">
          <span aria-hidden="true" className="text-stone-400 group-open:hidden">
            ▸{" "}
          </span>
          <span aria-hidden="true" className="hidden text-stone-400 group-open:inline">
            ▾{" "}
          </span>
          <bdi>{account.name}</bdi>
          {account.closedOn === null ? null : (
            <span className="ms-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">
              נסגר ב־{formatDate(account.closedOn)}
            </span>
          )}
        </span>
        <span className="text-sm text-stone-600">{owner}</span>
        <span className="text-sm text-stone-600">
          <bdi>{account.currency}</bdi>
        </span>
        <span className="text-sm text-stone-600">{VALUE_BASIS_LABELS[account.valueBasis]}</span>
        <span className="text-sm text-stone-500">
          <bdi>{account.assetKind}</bdi>
        </span>
      </summary>

      <div className="border-t border-stone-100 bg-stone-50/60 px-5 py-4">
        <form action={editAccount} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="accountId" value={account.id} />
          <input type="hidden" name="currency" value={account.currency} />

          <Field label="שם החשבון">
            <input
              name="name"
              defaultValue={account.name}
              required
              maxLength={60}
              className="w-full rounded-md border border-stone-300 px-3 py-2"
            />
          </Field>

          <Field label="בסיס שווי">
            <Select name="valueBasis" defaultValue={account.valueBasis}>
              {VALUE_BASES.map((basis) => (
                <option key={basis} value={basis}>
                  {VALUE_BASIS_LABELS[basis]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="קטגוריה">
            <Select name="category" defaultValue={account.category}>
              {ASSET_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {ASSET_CATEGORY_LABELS[category]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="סוג נכס">
            <input
              name="assetKind"
              defaultValue={account.assetKind}
              required
              maxLength={60}
              list="asset-kinds-existing"
              className="w-full rounded-md border border-stone-300 px-3 py-2"
            />
            <datalist id="asset-kinds-existing">
              {assetKinds.map((kind) => (
                <option key={kind} value={kind} />
              ))}
            </datalist>
          </Field>

          <Field label="תאריך פתיחה">
            <input
              type="date"
              name="openedOn"
              defaultValue={dateKey(account.openedOn)}
              required
              className="w-full rounded-md border border-stone-300 px-3 py-2"
            />
          </Field>

          <Field label="תאריך סגירה" note="ריק — החשבון בשימוש">
            <input
              type="date"
              name="closedOn"
              defaultValue={account.closedOn === null ? "" : dateKey(account.closedOn)}
              className="w-full rounded-md border border-stone-300 px-3 py-2"
            />
          </Field>

          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
            >
              שמירה
            </button>
          </div>
        </form>

        {account.closedOn === null ? null : (
          <form action={setAccountLifespan} className="mt-3">
            <input type="hidden" name="accountId" value={account.id} />
            <input type="hidden" name="intent" value="reopen" />
            <button
              type="submit"
              className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
            >
              החזרה לשימוש
            </button>
          </form>
        )}

        <p className="mt-3 text-xs text-stone-500">
          המטבע (<bdi>{account.currency}</bdi>) אינו ניתן לשינוי — שינוי שלו היה משנה את המטבע של כל סכום
          שכבר נרשם לחשבון הזה בכל צילום.
        </p>
      </div>
    </details>
  );
}

// --- small pieces ------------------------------------------------------------

function Field({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-stone-700">{label}</span>
      {note === undefined ? null : <span className="block text-xs text-stone-500">{note}</span>}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function Select({
  name,
  defaultValue,
  children,
}: {
  name: string;
  defaultValue: string;
  children: React.ReactNode;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue}
      className="w-full rounded-md border border-stone-300 bg-white px-3 py-2"
    >
      {children}
    </select>
  );
}

const ERROR_MESSAGES: Record<AccountsErrorCode, string> = {
  "no-person": "הכתובת שאיתה נכנסת אינה משויכת לאף אדם בטבלת people.",
  "bad-account": "פרטי החשבון אינם תקינים.",
  "duplicate-name": "לאדם הזה כבר יש חשבון בשם הזה.",
  "unknown-account": "החשבון אינו קיים.",
  failed: "הפעולה נכשלה.",
};

function isErrorCode(value: string | undefined): value is AccountsErrorCode {
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

  const [verb, name = ""] = done.split(":");
  const text =
    verb === "created" ? "נוצר חשבון" : verb === "reopened" ? "החשבון חזר לשימוש" : "החשבון נשמר";

  return (
    <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4" role="status">
      <p className="font-medium text-emerald-900">
        {text}: <bdi>{name}</bdi>
      </p>
    </div>
  );
}

function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן לקרוא את החשבונות</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}
