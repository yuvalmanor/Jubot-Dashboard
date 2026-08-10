import type { Route } from "next";
import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { loadAccounts } from "@/db/accounts";
import { DatabaseNotConfiguredError } from "@/db/client";
import { findLatestRate } from "@/db/money-settings";
import { type Person, findPersonByEmail } from "@/db/people";
import { loadSnapshots } from "@/db/snapshots";
import { format } from "@/domain/money/money";
import {
  type Account,
  type Snapshot,
  accountsOpenOn,
  completenessOf,
  hasRateWithin,
  rateWithin,
  snapshotTotal,
} from "@/domain/snapshot/snapshot";
import { dateKey, dateOf, formatDate } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

import { takeSnapshot } from "./actions";
import { Notices, UnavailablePanel } from "./panels";

export const dynamic = "force-dynamic";

/**
 * מיפוי — the snapshot history, and the button that takes the next one.
 *
 * The totals in this list are each computed with that snapshot's own rate, which
 * is why a row from 2024 keeps reading as it did in 2024 even though today's rate
 * has moved since.
 */

/** Totals are read in shekels. Explicit, never assumed from context. */
const READING_CURRENCY = "ILS" as const;

interface SearchParams {
  error?: string | string[];
  detail?: string | string[];
  done?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SnapshotsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const loaded = await loadPage(email);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="מיפוי"
        subtitle="צילום מלא ומתוארך של כל החשבונות"
        back={{ href: "/", label: "חזרה ללוח המחוונים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <Notices error={first(params.error)} detail={first(params.detail)} done={first(params.done)} />

        {loaded.kind === "ok" ? (
          <>
            <TakePanel
              accounts={loaded.accounts}
              latest={loaded.snapshots[0] ?? null}
              defaultRate={loaded.defaultRate}
            />

            {loaded.snapshots.length === 0 ? (
              <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
                אין עדיין צילומים. הראשון יכלול שורה לכל חשבון פתוח, וכל שורה בו תמתין למדידה.
              </p>
            ) : (
              <HistoryTable snapshots={loaded.snapshots} accounts={loaded.accounts} />
            )}
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
      accounts: readonly Account[];
      snapshots: readonly Snapshot[];
      defaultRate: number;
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
    const [accounts, snapshots, rate] = await Promise.all([
      loadAccounts(),
      loadSnapshots(),
      findLatestRate("USD", "ILS"),
    ]);
    return { kind: "ok", person, accounts, snapshots, defaultRate: rate?.rate ?? 3.65 };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- taking one --------------------------------------------------------------

function TakePanel({
  accounts,
  latest,
  defaultRate,
}: {
  accounts: readonly Account[];
  latest: Snapshot | null;
  defaultRate: number;
}) {
  const today = dateOf(new Date());
  const openToday = accountsOpenOn(accounts, today);

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">צילום חדש</h2>
        <Link href="/accounts" className="text-sm text-stone-600 underline-offset-4 hover:underline">
          ניהול חשבונות
        </Link>
      </div>

      {openToday.length === 0 ? (
        <p className="mt-3 text-stone-600">
          אין חשבונות פתוחים.{" "}
          <Link href="/accounts" className="underline underline-offset-4">
            הגדרת חשבון
          </Link>{" "}
          היא הצעד הראשון — צילום נבנה משורה לכל חשבון פתוח.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-stone-600">
            הצילום ייפתח עם שורה לכל אחד מ־<bdi className="tabular">{openToday.length}</bdi> החשבונות
            הפתוחים
            {latest === null ? (
              ", כולן ממתינות למדידה ראשונה."
            ) : (
              <>
                , כל אחת עם הערך מהצילום של {formatDate(latest.takenOn)}. הצילום נלקח מתי שרוצים — אין
                תדירות כפויה.
              </>
            )}
          </p>

          <form action={takeSnapshot} className="mt-4 grid gap-4 sm:grid-cols-4">
            <label className="block">
              <span className="block text-sm font-medium text-stone-700">תאריך</span>
              <input
                type="date"
                name="takenOn"
                required
                defaultValue={dateKey(today)}
                className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
              />
            </label>

            <label className="block">
              <span className="block text-sm font-medium text-stone-700">
                שער <bdi>USD/ILS</bdi>
              </span>
              <span className="block text-xs text-stone-500">נשמר על הצילום ולא ישתנה אחר כך</span>
              <input
                type="number"
                name="usdIls"
                step="0.0001"
                min="0.0001"
                required
                defaultValue={defaultRate}
                className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
              />
            </label>

            <label className="block sm:col-span-2">
              <span className="block text-sm font-medium text-stone-700">הערה</span>
              <input
                name="note"
                maxLength={200}
                className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
              />
            </label>

            <div>
              <button
                type="submit"
                className="rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
              >
                לקיחת צילום
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}

// --- the history -------------------------------------------------------------

function HistoryTable({
  snapshots,
  accounts,
}: {
  snapshots: readonly Snapshot[];
  accounts: readonly Account[];
}) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white">
      <h2 className="border-b border-stone-200 px-5 py-3 text-sm font-semibold tracking-wide text-stone-500">
        היסטוריית צילומים
      </h2>

      <ul className="divide-y divide-stone-200">
        {snapshots.map((snapshot) => {
          const completeness = completenessOf(snapshot);
          const convertible = hasRateWithin(snapshot, "USD", READING_CURRENCY);

          return (
            <li key={snapshot.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
              <Link
                href={`/snapshots/${snapshot.id}` as Route}
                className="min-w-0 flex-1 font-medium underline-offset-4 hover:underline"
              >
                {formatDate(snapshot.takenOn)}
              </Link>

              <bdi className="tabular font-medium">
                {convertible ? (
                  format(snapshotTotal(snapshot, accounts, READING_CURRENCY))
                ) : (
                  <span className="text-stone-400">אין שער בצילום</span>
                )}
              </bdi>

              <span className="text-xs text-stone-500 sm:min-w-40 sm:text-end">
                <bdi className="tabular">{completeness.entered}</bdi>/
                <bdi className="tabular">{completeness.total}</bdi> נמדדו בתאריך הזה
              </span>

              <span className="text-xs text-stone-500 sm:min-w-24 sm:text-end">
                {convertible ? (
                  <>
                    שער <bdi className="tabular">{rateWithin(snapshot, "USD", "ILS").rate}</bdi>
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="border-t border-stone-200 px-5 py-3 text-sm text-stone-500">
        כל סכום כאן מומר בשער של הצילום שלו. צילום ישן נקרא היום בדיוק כפי שנקרא ביום שנלקח.
      </p>
    </section>
  );
}

