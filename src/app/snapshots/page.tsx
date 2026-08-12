import type { Route } from "next";
import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { loadAccounts } from "@/db/accounts";
import { DatabaseNotConfiguredError } from "@/db/client";
import { findLatestRate } from "@/db/money-settings";
import { type Person, findPersonByEmail } from "@/db/people";
import { loadRsuRecords } from "@/db/rsu";
import { loadHouseholdSettings } from "@/db/settings";
import { loadSnapshots } from "@/db/snapshots";
import { format } from "@/domain/money/money";
import { sharePriceToDecimalString } from "@/domain/rsu/rsu-position";
import {
  type Account,
  type Snapshot,
  accountsOpenOn,
  canConvertWithin,
  completenessOf,
  hasRateWithin,
  rateWithin,
  snapshotTotal,
} from "@/domain/snapshot/snapshot";
import { dateKey, dateOf, formatDate } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

import { type KnownPrice, latestKnownPrice } from "../rsu/known-price";
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
              rsuAccount={loaded.rsuAccount}
              knownPrice={loaded.knownPrice}
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
      /** The account whose balance is derived from the RSU position, where one is named. */
      rsuAccount: Account | null;
      /** The last price anybody recorded, offered as a default. Not a market price. */
      knownPrice: KnownPrice | null;
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
    const [accounts, snapshots, rate, settings, records] = await Promise.all([
      loadAccounts(),
      loadSnapshots(),
      findLatestRate("USD", "ILS"),
      loadHouseholdSettings(),
      loadRsuRecords(),
    ]);
    return {
      kind: "ok",
      person,
      accounts,
      snapshots,
      defaultRate: rate?.rate ?? 3.65,
      rsuAccount: accounts.find((account) => account.id === settings.rsuAccountId) ?? null,
      knownPrice: latestKnownPrice(records),
    };
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
  rsuAccount,
  knownPrice,
}: {
  accounts: readonly Account[];
  latest: Snapshot | null;
  defaultRate: number;
  rsuAccount: Account | null;
  knownPrice: KnownPrice | null;
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

          {rsuAccount === null ? null : (
            <p className="mt-2 text-sm text-stone-600">
              היתרה של <bdi className="font-medium">{rsuAccount.name}</bdi> לא תוקלד: היא תיגזר ממספר
              המניות המוחזק בתאריך הזה ומהמחיר שלמטה, וההמרה תיעשה בשער של הצילום.
            </p>
          )}

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

            {rsuAccount === null ? null : (
              <label className="block">
                <span className="block text-sm font-medium text-stone-700">
                  מחיר מניית <bdi>RSU</bdi>
                </span>
                <span className="block text-xs text-stone-500">
                  דולרים למניה — נשמר על הצילום כמו השער
                </span>
                <input
                  name="sharePrice"
                  inputMode="decimal"
                  dir="ltr"
                  defaultValue={knownPrice === null ? "" : sharePriceToDecimalString(knownPrice.price)}
                  className="tabular mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-end"
                />
              </label>
            )}

            <label className={`block ${rsuAccount === null ? "sm:col-span-2" : ""}`}>
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
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-stone-200 px-5 py-3">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">
          היסטוריית צילומים — <bdi className="tabular">{snapshots.length}</bdi> במלואם, מהחדש לישן
        </h2>
        {snapshots.length < 2 ? null : (
          <Link href="/snapshots/compare" className="text-sm underline-offset-4 hover:underline">
            השוואה בין שני צילומים
          </Link>
        )}
      </div>

      <ul className="divide-y divide-stone-200">
        {snapshots.map((snapshot, index) => {
          const completeness = completenessOf(snapshot);
          const convertible = canConvertWithin(snapshot, "USD", READING_CURRENCY);
          // The list is newest first, so the next row down is the previous reading.
          const previous = snapshots[index + 1] ?? null;

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
                {hasRateWithin(snapshot, "USD", "ILS") ? (
                  <>
                    שער <bdi className="tabular">{rateWithin(snapshot, "USD", "ILS").rate}</bdi>
                  </>
                ) : null}
              </span>

              <span className="text-xs sm:min-w-28 sm:text-end">
                {previous === null ? (
                  <span className="text-stone-400">הצילום הראשון</span>
                ) : (
                  <Link
                    href={`/snapshots/compare?from=${previous.id}&to=${snapshot.id}` as Route}
                    className="text-stone-600 underline-offset-4 hover:underline"
                  >
                    השוואה לקודם
                  </Link>
                )}
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

