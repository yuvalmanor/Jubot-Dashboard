import type { Route } from "next";
import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { loadAccounts } from "@/db/accounts";
import { DatabaseNotConfiguredError } from "@/db/client";
import { type Person, findPersonByEmail } from "@/db/people";
import {
  loadDealTerms,
  loadFundingLegs,
  loadProjectDistributions,
  loadProjectExpenses,
  loadProjectValuations,
  loadProjects,
} from "@/db/projects";
import { type Currency, format, ratio } from "@/domain/money/money";
import { type ProjectReading, readProjects } from "@/domain/projects/projects";
import { type Account, VALUE_BASIS_LABELS } from "@/domain/snapshot/snapshot";
import { dateKey, dateOf, formatDate } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

import { createProject } from "./actions";
import { FIELD, Field, Notices, PRIMARY_BUTTON, Select, UnavailablePanel } from "./panels";

export const dynamic = "force-dynamic";

/**
 * נכסים ופרוייקטים — one line per closed pot.
 *
 * A line and not a card: the question this screen is opened to ask is which
 * project has capital waiting in it, and five figures in a row answer that where
 * five stacked cards made it a scroll. Everything else about a project is on the
 * project's own screen.
 *
 * Nothing here is stored. Each line comes out of the same `readProjects` the
 * project page reads, so the two cannot disagree about what a pot holds.
 */

const CURRENCIES: readonly Currency[] = ["ILS", "USD"];

const PERCENT = new Intl.NumberFormat("he-IL", { style: "percent", maximumFractionDigits: 0 });

const NEW_PROJECT_ID = "new-project";

interface SearchParams {
  error?: string | string[];
  detail?: string | string[];
  done?: string | string[];
  settings?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const loaded = await loadPage(email);
  const open = first(params.settings) === "1";

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="נכסים ופרוייקטים"
        subtitle="כל פרוייקט הוא קופה סגורה: רגלי מימון ממלאות אותה, הוצאות נמשכות ממנה"
        back={{ href: "/", label: "חזרה ללוח המחוונים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <Notices error={first(params.error)} detail={first(params.detail)} done={first(params.done)} />

        {loaded.kind === "ok" ? (
          <>
            {loaded.readings.length === 0 ? (
              <p className="rounded-card bg-surface shadow-card p-6 text-stone-500">
                אין עדיין פרוייקטים. פרוייקט נפתח כאן, וכל הכסף שנכנס אליו נרשם כרגל מימון עם מקור.
              </p>
            ) : (
              <ProjectsTable readings={loaded.readings} />
            )}

            <NewProjectSection accounts={loaded.accounts} open={open} />
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
    }
  | { kind: "unavailable"; reason: string };

async function loadPage(email: string): Promise<Loaded> {
  try {
    const [person, projects, terms, accounts] = await Promise.all([
      findPersonByEmail(email),
      loadProjects(),
      loadDealTerms(),
      loadAccounts(),
    ]);
    const [legs, expenses, distributions, valuations] = await Promise.all([
      loadFundingLegs(projects),
      loadProjectExpenses(projects),
      loadProjectDistributions(projects),
      loadProjectValuations(projects),
    ]);

    return {
      kind: "ok",
      person,
      readings: readProjects({ projects, legs, expenses, distributions, valuations, terms }),
      accounts,
    };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- the table ---------------------------------------------------------------

/**
 * One row per project, and no total row: the pots are denominated in different
 * currencies and a column of mixed money has no sum. What the household holds
 * across all of them is a question for מיפוי, which converts at a snapshot's own
 * rate and says so.
 */
function ProjectsTable({ readings }: { readings: readonly ProjectReading[] }) {
  return (
    <div className="rounded-card bg-surface shadow-card overflow-x-auto p-2 sm:p-3">
      <table className="w-full min-w-[46rem] text-sm">
        <thead>
          <tr className="text-xs text-stone-400">
            <th className="px-4 py-2.5 text-start font-normal">פרוייקט</th>
            <th className="px-4 py-2.5 text-start font-normal">הושקע</th>
            <th className="px-4 py-2.5 text-end font-normal">גויס</th>
            <th className="px-4 py-2.5 text-end font-normal">יתרה</th>
            <th className="px-4 py-2.5 text-end font-normal">חולק החוצה</th>
            <th className="px-4 py-2.5 text-end font-normal">שווי אחרון</th>
          </tr>
        </thead>
        <tbody className="divide-line divide-y">
          {readings.map((reading) => (
            <ProjectRow key={reading.project.id} reading={reading} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProjectRow({ reading }: { reading: ProjectReading }) {
  const { project, pot, value } = reading;
  const deployed = ratio(pot.spent, value.cost);

  return (
    <tr className="transition-colors hover:bg-stone-900/[0.02]">
      <td className="rounded-s-lg px-4 py-3">
        <Link href={`/projects/${project.id}` as Route} className="font-medium">
          <bdi>{project.name}</bdi>
        </Link>
        <p className="text-xs text-stone-400">
          <bdi>{project.currency}</bdi> · {formatDate(project.startedOn)}
        </p>
      </td>

      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-stone-900/8">
            <div
              className="h-full rounded-full bg-stone-900"
              style={{ inlineSize: `${Math.min(100, Math.max(0, (deployed ?? 0) * 100))}%` }}
            />
          </div>
          <span className="tabular text-xs text-stone-500">
            {deployed === null ? "—" : PERCENT.format(deployed)}
          </span>
        </div>
      </td>

      <td className="tabular px-4 py-3 text-end text-stone-600">
        <bdi>{format(pot.funded)}</bdi>
      </td>
      <td className="figure px-4 py-3 text-end font-medium">
        <bdi>{format(pot.balance)}</bdi>
      </td>
      <td className="tabular px-4 py-3 text-end text-stone-600">
        <bdi>{format(pot.paidOut)}</bdi>
      </td>
      <td className="px-4 py-3 text-end">
        <bdi className="tabular">{format(value.amount)}</bdi>
        <p className="text-xs text-stone-400">
          {value.valuation === null ? "בעלות" : VALUE_BASIS_LABELS[value.basis]}
        </p>
      </td>
    </tr>
  );
}

// --- a new project -----------------------------------------------------------

/**
 * Behind a toggle, as the project screen's own settings are. A project is opened
 * once in a while and the list is read often, so the form is a link until it is
 * wanted.
 */
function NewProjectSection({ accounts, open }: { accounts: readonly Account[]; open: boolean }) {
  if (!open) {
    return (
      <p className="text-sm text-stone-600" id={NEW_PROJECT_ID}>
        <Link
          href={`/projects?settings=1#${NEW_PROJECT_ID}` as Route}
          className="underline underline-offset-4"
        >
          פתיחת פרוייקט חדש
        </Link>{" "}
        — שם, מטבע הקופה, תאריך פתיחה והחשבון במיפוי.
      </p>
    );
  }

  return (
    <section
      className="rounded-card bg-surface shadow-card p-5 sm:p-6"
      id={NEW_PROJECT_ID}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 className="text-[13px] font-medium text-stone-500">פרוייקט חדש</h2>
        <Link href="/projects" className="text-sm text-stone-600 underline underline-offset-4">
          סגירה
        </Link>
      </div>
      <p className="mt-1 text-sm text-stone-600">
        מטבע הקופה אינו ניתן לשינוי אחר כך: שינוי שלו היה משנה את המטבע של כל רגל וכל הוצאה שכבר
        נרשמו בו.
      </p>

      <form action={createProject} className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="שם הפרוייקט">
          <input
            name="name"
            required
            maxLength={60}
            placeholder="CGM 3"
            className={FIELD}
          />
        </Field>

        <Field label="מטבע הקופה" note="לא ניתן לשינוי אחר כך">
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
            defaultValue={dateKey(dateOf(new Date()))}
            required
            className={FIELD}
          />
        </Field>

        <Field label="החשבון במיפוי" note="איזה חשבון נושא את שווי הפרוייקט. אפשר גם אחר כך">
          <Select name="accountId" defaultValue="">
            <option value="">— לא נבחר —</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="sm:col-span-2">
          <button
            type="submit"
            className={PRIMARY_BUTTON}
          >
            יצירת פרוייקט
          </button>
        </div>
      </form>
    </section>
  );
}
