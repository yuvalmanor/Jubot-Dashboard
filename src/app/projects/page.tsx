import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { loadAccounts } from "@/db/accounts";
import { DatabaseNotConfiguredError } from "@/db/client";
import { type DatedRate, findLatestRate } from "@/db/money-settings";
import { type Person, findPersonByEmail } from "@/db/people";
import {
  loadDealTerms,
  loadFundingLegs,
  loadProjectExpenses,
  loadProjects,
} from "@/db/projects";
import { type Currency, format, isZero } from "@/domain/money/money";
import {
  type ProjectReading,
  againstToday,
  readProjects,
  statesAnything,
} from "@/domain/projects/projects";
import { type Account } from "@/domain/snapshot/snapshot";
import { dateKey, dateOf, formatDate } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

import { createProject } from "./actions";
import { Field, Notices, RateFigure, Select, UnavailablePanel, readsAsSameRate } from "./panels";

export const dynamic = "force-dynamic";

/**
 * נכסים ופרוייקטים — every closed pot at once.
 *
 * Each row is `Σ(legs) − Σ(expenses)` computed on read. Nothing on this screen is
 * stored, so a project's line here and its own page cannot disagree about what it
 * holds: both come out of the same `readProjects`.
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

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const loaded = await loadPage(email);
  const today = dateOf(new Date());

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="נכסים ופרוייקטים"
        subtitle="כל פרוייקט הוא פוט סגור: רגלי מימון ממלאות אותו, הוצאות נמשכות ממנו"
        back={{ href: "/", label: "חזרה ללוח המחוונים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <Notices error={first(params.error)} detail={first(params.detail)} done={first(params.done)} />

        {loaded.kind === "ok" ? (
          <>
            {loaded.readings.length === 0 ? (
              <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
                אין עדיין פרוייקטים. פרוייקט נפתח כאן, וכל הכסף שנכנס אליו נרשם כרגל מימון עם מקור.
              </p>
            ) : (
              <ul className="space-y-4">
                {loaded.readings.map((reading) => (
                  <li key={reading.project.id}>
                    <ProjectCard reading={reading} today={loaded.rate} />
                  </li>
                ))}
              </ul>
            )}

            <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
              <h2 className="text-sm font-semibold tracking-wide text-stone-500">פרוייקט חדש</h2>
              <p className="mt-1 text-sm text-stone-600">
                מטבע הפוט הוא מה שהפרוייקט מתנהל בו, ואינו ניתן לשינוי אחר כך: שינוי שלו היה משנה את
                המטבע של כל רגל וכל הוצאה שכבר נרשמו בו.
              </p>

              <form action={createProject} className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="שם הפרוייקט">
                  <input
                    name="name"
                    required
                    maxLength={60}
                    placeholder="CGM 3"
                    className="w-full rounded-md border border-stone-300 px-3 py-2"
                  />
                </Field>

                <Field label="מטבע הפוט" note="לא ניתן לשינוי אחר כך">
                  <Select name="currency" defaultValue="USD">
                    {CURRENCIES.map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="תאריך פתיחה">
                  <input
                    type="date"
                    name="startedOn"
                    defaultValue={dateKey(today)}
                    required
                    className="w-full rounded-md border border-stone-300 px-3 py-2"
                  />
                </Field>

                <Field label="החשבון במיפוי" note="איזה חשבון נושא את שווי הפרוייקט. אפשר גם אחר כך">
                  <Select name="accountId" defaultValue="">
                    <option value="">— לא נבחר —</option>
                    {loaded.accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </Select>
                </Field>

                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    className="rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
                  >
                    יצירת פרוייקט
                  </button>
                </div>
              </form>
            </section>
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
      person: Person | null;
      readings: readonly ProjectReading[];
      accounts: readonly Account[];
      rate: DatedRate | null;
    }
  | { kind: "unavailable"; reason: string };

async function loadPage(email: string): Promise<Loaded> {
  try {
    const [person, projects, terms, accounts, rate] = await Promise.all([
      findPersonByEmail(email),
      loadProjects(),
      loadDealTerms(),
      loadAccounts(),
      findLatestRate("USD", "ILS"),
    ]);
    const [legs, expenses] = await Promise.all([
      loadFundingLegs(projects),
      loadProjectExpenses(projects),
    ]);

    return {
      kind: "ok",
      person,
      readings: readProjects({ projects, legs, expenses, terms }),
      accounts,
      rate,
    };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- one card ----------------------------------------------------------------

function ProjectCard({ reading, today }: { reading: ProjectReading; today: DatedRate | null }) {
  const { project, pot, effective, terms } = reading;
  const standing = today === null ? null : againstToday(effective, today);

  return (
    <article className="rounded-lg border border-stone-300 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold">
          <Link href={`/projects/${project.id}`} className="underline-offset-4 hover:underline">
            <bdi>{project.name}</bdi>
          </Link>
        </h2>
        <p className="text-sm text-stone-500">
          נפתח ב־{formatDate(project.startedOn)} · פוט ב־<bdi>{project.currency}</bdi>
        </p>
      </div>

      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <Figure label="סך רגלי המימון" amount={format(pot.funded)} note={counted(pot.legCount, "רגל מימון אחת", "רגליים")} />
        <Figure label="סך ההוצאות" amount={format(pot.spent)} note={counted(pot.expenseCount, "הוצאה אחת", "הוצאות")} />
        <Figure
          label="יתרה — הון שטרם הושקע"
          amount={format(pot.balance)}
          note="רגלי מימון פחות הוצאות"
          emphasis
        />
      </dl>

      <p className="mt-4 text-sm text-stone-600">
        {effective.rate === null ? (
          <>לא בוצעה בפרוייקט הזה שום המרת מטבע, ולכן אין לו שער אפקטיבי.</>
        ) : standing === null ? (
          <>
            שער אפקטיבי <RateFigure rate={effective.rate} /> — אין שער שמור להיום להשוואה.
          </>
        ) : (
          <>
            שער אפקטיבי <RateFigure rate={standing.effective} />, מול{" "}
            <RateFigure rate={standing.today.rate} /> היום
            {standing.standing === "same" || readsAsSameRate(standing.difference) ? (
              <> — זהה.</>
            ) : (
              <>
                {" "}
                — <span className="font-medium">{standing.standing === "above" ? "גבוה" : "נמוך"}</span>{" "}
                בכ־
                <RateFigure rate={Math.abs(standing.difference)} />.
              </>
            )}
          </>
        )}
      </p>

      <p className="mt-1 text-xs text-stone-500">
        {terms === null || !statesAnything(terms)
          ? "לא נרשמו תנאי עסקה."
          : "תנאי העסקה נרשמו מהמסמכים של היזם."}
        {isZero(pot.balance) ? " כל ההון הופעל." : null}
      </p>
    </article>
  );
}

/** Hebrew counts one thing differently from several. `0` reads as none, not as a plural of nothing. */
function counted(count: number, one: string, many: string): string {
  if (count === 0) return `אין ${many}`;
  if (count === 1) return one;
  return `${count} ${many}`;
}

function Figure({
  label,
  amount,
  note,
  emphasis = false,
}: {
  label: string;
  amount: string;
  note: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className={`tabular mt-1 ${emphasis ? "text-xl font-semibold" : "text-lg"}`}>
        <bdi>{amount}</bdi>
      </dd>
      <p className="text-xs text-stone-500">{note}</p>
    </div>
  );
}
