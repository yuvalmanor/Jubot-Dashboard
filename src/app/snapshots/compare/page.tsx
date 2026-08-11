import type { Route } from "next";
import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { BasisNote } from "@/components/basis-note";
import { loadAccounts } from "@/db/accounts";
import { DatabaseNotConfiguredError } from "@/db/client";
import { type Person, findPersonByEmail } from "@/db/people";
import { type SnapshotHeader, findSnapshot, loadSnapshotHeaders } from "@/db/snapshots";
import { format, isZero } from "@/domain/money/money";
import {
  type Account,
  type ComparisonRow,
  type Snapshot,
  type SnapshotComparison,
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABELS,
  basisSplitOf,
  canConvertWithin,
  compareSnapshots,
  comparisonTotals,
  convertedReadings,
} from "@/domain/snapshot/snapshot";
import { formatDate } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

import { UnavailablePanel } from "../panels";

export const dynamic = "force-dynamic";

/**
 * Two snapshots side by side.
 *
 * Every per-account difference here is in the account's own currency, so no rate
 * touches it. Restating a change across two snapshots taken at different rates
 * would mix what the money did with what the shekel did; separating those is the
 * decomposition's work on `/net-worth`, which this screen links to. Here the
 * question is what moved and, just as importantly, which rows nobody measured.
 */

const READING_CURRENCY = "ILS" as const;

interface SearchParams {
  from?: string | string[];
  to?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ComparePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const loaded = await loadPage(email, first(params.from), first(params.to));

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "unavailable" ? null : loaded.person}
        title="השוואת צילומים"
        subtitle="שני צילומים זה מול זה, חשבון מול חשבון"
        back={{ href: "/snapshots", label: "חזרה לרשימת הצילומים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        {loaded.kind === "unavailable" ? (
          <UnavailablePanel reason={loaded.reason} />
        ) : (
          <>
            <ChoicePanel
              history={loaded.history}
              from={loaded.kind === "ready" ? loaded.comparison.earlier.id : undefined}
              to={loaded.kind === "ready" ? loaded.comparison.later.id : undefined}
            />

            {loaded.kind === "ready" ? (
              <Comparison comparison={loaded.comparison} accounts={loaded.accounts} />
            ) : (
              <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
                {loaded.hint}
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// --- loading -----------------------------------------------------------------

type Loaded =
  | {
      kind: "ready";
      person: Person;
      history: readonly SnapshotHeader[];
      accounts: readonly Account[];
      comparison: SnapshotComparison;
    }
  | { kind: "choose"; person: Person; history: readonly SnapshotHeader[]; hint: string }
  | { kind: "unavailable"; reason: string };

async function loadPage(email: string, from: string | undefined, to: string | undefined): Promise<Loaded> {
  try {
    const person = await findPersonByEmail(email);
    if (person === null) {
      return {
        kind: "unavailable",
        reason: `הכתובת ${email} אינה משויכת לאף אדם בטבלת people. יש לעדכן את שתי הכתובות במסד (ראו README).`,
      };
    }

    const [history, accounts] = await Promise.all([loadSnapshotHeaders(), loadAccounts()]);

    if (history.length < 2) {
      return { kind: "choose", person, history, hint: "צריך שני צילומים לפחות כדי להשוות." };
    }
    if (from === undefined || to === undefined) {
      return { kind: "choose", person, history, hint: "בחרו שני צילומים להשוואה." };
    }
    if (from === to) {
      return { kind: "choose", person, history, hint: "שני הצילומים זהים — בחרו שני תאריכים שונים." };
    }

    const [earlier, later] = await Promise.all([findSnapshot(from), findSnapshot(to)]);
    if (earlier === null || later === null) {
      return { kind: "choose", person, history, hint: "אחד הצילומים שנבחרו אינו קיים." };
    }

    return {
      kind: "ready",
      person,
      history,
      accounts,
      comparison: compareSnapshots({ earlier, later, accounts }),
    };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- choosing the two --------------------------------------------------------

function ChoicePanel({
  history,
  from,
  to,
}: {
  history: readonly SnapshotHeader[];
  from: string | undefined;
  to: string | undefined;
}) {
  // A plain GET form: choosing what to read is not a write, so the choice lives
  // in the address and the page can be linked to and reloaded.
  return (
    <form
      method="get"
      action="/snapshots/compare"
      className="grid gap-4 rounded-lg border border-stone-300 bg-white p-5 sm:grid-cols-3 sm:p-6"
    >
      <SnapshotSelect name="from" label="צילום ראשון" history={history} selected={from} />
      <SnapshotSelect name="to" label="צילום שני" history={history} selected={to} />
      <div className="flex items-end">
        <button
          type="submit"
          className="rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
        >
          השוואה
        </button>
      </div>
    </form>
  );
}

function SnapshotSelect({
  name,
  label,
  history,
  selected,
}: {
  name: string;
  label: string;
  history: readonly SnapshotHeader[];
  selected: string | undefined;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-stone-700">{label}</span>
      <select
        name={name}
        defaultValue={selected ?? ""}
        className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2"
      >
        <option value="">— בחירת תאריך —</option>
        {history.map((header) => (
          <option key={header.id} value={header.id}>
            {formatDate(header.takenOn)}
          </option>
        ))}
      </select>
    </label>
  );
}

// --- the comparison ----------------------------------------------------------

function Comparison({
  comparison,
  accounts,
}: {
  comparison: SnapshotComparison;
  accounts: readonly Account[];
}) {
  const { earlier, later, counts } = comparison;

  return (
    <div className="space-y-6">
      <TotalsPanel comparison={comparison} accounts={accounts} />

      <section className="rounded-lg border border-stone-300 bg-white">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-stone-200 px-5 py-3">
          <h2 className="text-sm font-semibold tracking-wide text-stone-500">חשבון מול חשבון</h2>
          <p className="text-xs text-stone-500">
            <bdi className="tabular">{counts.changed}</bdi> שורות השתנו ·{" "}
            <bdi className="tabular">{counts.carried}</bdi> נגררו בצילום השני
            {counts.unmeasured === 0 ? null : (
              <>
                {" · "}
                <bdi className="tabular">{counts.unmeasured}</bdi> לא נמדדו באחד הצדדים
              </>
            )}
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              הפרש לכל חשבון בין {formatDate(earlier.takenOn)} ל־{formatDate(later.takenOn)}
            </caption>
            <thead className="text-xs text-stone-500">
              <tr className="border-b border-stone-200">
                <th scope="col" className="px-5 py-2 text-start font-medium">
                  חשבון
                </th>
                <th scope="col" className="px-5 py-2 text-end font-medium">
                  {formatDate(earlier.takenOn)}
                </th>
                <th scope="col" className="px-5 py-2 text-end font-medium">
                  {formatDate(later.takenOn)}
                </th>
                <th scope="col" className="px-5 py-2 text-end font-medium">
                  הפרש
                </th>
                <th scope="col" className="px-5 py-2 text-start font-medium">
                  מה זה אומר
                </th>
              </tr>
            </thead>

            {ASSET_CATEGORIES.flatMap((category) => {
              const rows = comparison.rows.filter((row) => row.account.category === category);
              if (rows.length === 0) return [];

              return (
                <tbody key={category} className="divide-y divide-stone-100 border-b border-stone-200">
                  <tr className="bg-stone-50/60">
                    <th scope="colgroup" colSpan={5} className="px-5 py-2 text-start text-xs text-stone-500">
                      {ASSET_CATEGORY_LABELS[category]}
                    </th>
                  </tr>
                  {rows.map((row) => (
                    <ComparisonTableRow key={row.account.id} row={row} />
                  ))}
                </tbody>
              );
            })}
          </table>
        </div>

        <p className="border-t border-stone-200 px-5 py-3 text-xs text-stone-500">
          כל הפרש כאן הוא במטבע שהחשבון מוחזק בו, כדי ששינוי בשער לא ייראה כמו כסף שזז.
        </p>
      </section>
    </div>
  );
}

function TotalsPanel({
  comparison,
  accounts,
}: {
  comparison: SnapshotComparison;
  accounts: readonly Account[];
}) {
  const { earlier, later } = comparison;
  const convertible =
    canConvertWithin(earlier, "USD", READING_CURRENCY) && canConvertWithin(later, "USD", READING_CURRENCY);

  if (!convertible) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
        <p className="text-sm text-amber-900">
          לאחד הצילומים אין שער <bdi>USD/ILS</bdi>, ולכן אין דרך לרכז את שניהם לשקלים. ההפרשים לכל
          חשבון למטה נקראים במטבע שלהם.
        </p>
      </div>
    );
  }

  const totals = comparisonTotals(comparison, accounts, READING_CURRENCY);

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <TotalColumn label={formatDate(earlier.takenOn)} snapshot={earlier} accounts={accounts} />
        <TotalColumn label={formatDate(later.takenOn)} snapshot={later} accounts={accounts} />
        <div>
          <p className="text-sm font-semibold tracking-wide text-stone-500">הפרש</p>
          <bdi className="tabular block text-2xl font-semibold">{format(totals.change)}</bdi>
          {totals.rateChanged ? (
            <p className="mt-1 text-xs text-amber-800">
              שער הצילומים אינו זהה, ולכן ההפרש הזה מערבב תנועה של כסף עם תנועה של שער.{" "}
              <Link
                href={`/net-worth?snapshot=${later.id}&from=${earlier.id}` as Route}
                className="underline underline-offset-4"
              >
                פירוק השינוי
              </Link>{" "}
              הוא מה שמפריד ביניהן.
            </p>
          ) : (
            <p className="mt-1 text-xs text-stone-500">שני הצילומים נקראים באותו שער.</p>
          )}
        </div>
      </div>
    </section>
  );
}

/** Each side read at its own snapshot's rate — a historical snapshot never re-converts. */
function TotalColumn({
  label,
  snapshot,
  accounts,
}: {
  label: string;
  snapshot: Snapshot;
  accounts: readonly Account[];
}) {
  const split = basisSplitOf(convertedReadings(snapshot, accounts, READING_CURRENCY), READING_CURRENCY);

  return (
    <div>
      <p className="text-sm font-semibold tracking-wide text-stone-500">
        <Link href={`/snapshots/${snapshot.id}` as Route} className="underline-offset-4 hover:underline">
          {label}
        </Link>
      </p>
      <bdi className="tabular block text-2xl font-semibold">{format(split.total)}</bdi>
      <BasisNote split={split} className="mt-1" />
    </div>
  );
}

// --- one row -----------------------------------------------------------------

/**
 * What a row's difference means, in the household's words. A row that carried is
 * never presented as a measurement, whether or not its figure moved.
 */
function meaningOf(row: ComparisonRow): { text: string; tone: string } {
  switch (row.kind) {
    case "measured":
      return row.changed
        ? { text: "נמדד בצילום השני והשתנה", tone: "text-emerald-800" }
        : { text: "נמדד בצילום השני ולא השתנה", tone: "text-emerald-800" };
    case "carried": {
      const measuredOn = row.after?.measuredOn ?? null;
      return {
        text:
          measuredOn === null
            ? "נגרר — איש לא מדד אותו"
            : `נגרר — נמדד לאחרונה ב־${formatDate(measuredOn)}`,
        tone: "text-amber-800",
      };
    }
    case "unmeasured":
      return { text: "לא נמדד מעולם באחד הצדדים — אין מה להחסיר", tone: "text-stone-500" };
    case "opened":
      return { text: "אינו בצילום הראשון", tone: "text-stone-500" };
    case "closed":
      return { text: "אינו בצילום השני", tone: "text-stone-500" };
  }
}

function ComparisonTableRow({ row }: { row: ComparisonRow }) {
  const meaning = meaningOf(row);

  return (
    <tr>
      <th scope="row" className="px-5 py-2 text-start font-normal">
        <bdi>{row.account.name}</bdi>
      </th>
      <td className="px-5 py-2 text-end">
        <bdi className="tabular">{row.before === null ? "—" : format(row.before.balance)}</bdi>
      </td>
      <td className="px-5 py-2 text-end">
        <bdi className="tabular">{row.after === null ? "—" : format(row.after.balance)}</bdi>
      </td>
      <td className="px-5 py-2 text-end">
        {row.change === null ? (
          <span className="text-stone-400">—</span>
        ) : isZero(row.change) ? (
          <span className="text-stone-400">ללא שינוי</span>
        ) : (
          <bdi className={`tabular font-medium ${row.change.minorUnits < 0 ? "text-red-800" : ""}`}>
            {row.change.minorUnits > 0 ? "+" : ""}
            {format(row.change)}
          </bdi>
        )}
      </td>
      <td className={`px-5 py-2 text-start text-xs ${meaning.tone}`}>{meaning.text}</td>
    </tr>
  );
}
