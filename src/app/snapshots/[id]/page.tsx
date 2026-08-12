import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { BasisNote } from "@/components/basis-note";
import { loadAccounts } from "@/db/accounts";
import { DatabaseNotConfiguredError } from "@/db/client";
import { loadEarmarks, loadPositions } from "@/db/holdings";
import { type Person, findPersonByEmail, listPeople } from "@/db/people";
import { loadRsuRecords } from "@/db/rsu";
import { loadHouseholdSettings } from "@/db/settings";
import { type SnapshotHeader, findSnapshot, findSnapshotHeader, loadSnapshotHeaders } from "@/db/snapshots";
import { type Currency, format, isNegative, toDecimalString } from "@/domain/money/money";
import {
  formatSharePrice,
  readPosition,
  sharePriceToDecimalString,
} from "@/domain/rsu/rsu-position";
import { type RsuLineReading, readRsuLine } from "@/domain/snapshot/rsu-line";
import {
  type AccountEarmarks,
  type Earmark,
  type FreeLiquid,
  type Position,
  earmarkFunding,
  freeLiquid,
  positionsIn,
} from "@/domain/snapshot/holdings";
import {
  type Account,
  type ConvertedReading,
  type CurrencyTable,
  type RollupDimension,
  type RollupLine,
  type Snapshot,
  type SnapshotReading,
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABELS,
  VALUE_BASIS_LABELS,
  accountsMissingFrom,
  basisSplitOf,
  canConvertWithin,
  completenessOf,
  convertedReadings,
  currencyTable,
  hasRateWithin,
  isAssetCategory,
  rateWithin,
  readingsIn,
  rollupBy,
  snapshotReadings,
  snapshotTotal,
} from "@/domain/snapshot/snapshot";
import { type CalendarDate, compareDates, formatDate } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

import { fillMissingAccounts, restateSnapshot } from "../actions";
import { Notices, UnavailablePanel } from "../panels";

export const dynamic = "force-dynamic";

/**
 * One snapshot: every account open on its date, in the currency each is held in,
 * with the figure that was recorded and whether anybody measured it that day.
 *
 * Every converted figure on this page goes through the snapshot's own rate. There
 * is no path from here to today's rate, which is what makes re-reading a 2024
 * snapshot produce the numbers it produced in 2024.
 */

const READING_CURRENCY = "ILS" as const;

interface SearchParams {
  error?: string | string[];
  detail?: string | string[];
  done?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SnapshotPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const email = await requireHouseholdEmail();
  const { id } = await params;
  const query = await searchParams;
  const loaded = await loadPage(email, id);

  if (loaded.kind === "missing") notFound();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title={loaded.kind === "ok" ? formatDate(loaded.snapshot.takenOn) : "צילום"}
        subtitle={
          loaded.kind === "ok" && loaded.note !== null ? loaded.note : "מיפוי — כל החשבונות ביום אחד"
        }
        back={{ href: "/snapshots", label: "חזרה לרשימת הצילומים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <Notices error={first(query.error)} detail={first(query.detail)} done={first(query.done)} />

        {loaded.kind === "ok" ? (
          <>
            <NeighbourNav snapshot={loaded.snapshot} history={loaded.history} />
            <SnapshotView
              snapshot={loaded.snapshot}
              accounts={loaded.accounts}
              people={loaded.people}
              positions={loaded.positions}
              earmarks={loaded.earmarks}
              rsu={loaded.rsu}
            />
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
      snapshot: Snapshot;
      note: string | null;
      /** Every snapshot's date, so this one can be read as part of a history rather than alone. */
      history: readonly SnapshotHeader[];
      positions: readonly Position[];
      earmarks: readonly Earmark[];
      /** The RSU account's line as the position and this snapshot's price say it must be. */
      rsu: RsuLineReading;
    }
  | { kind: "missing" }
  | { kind: "unavailable"; reason: string };

async function loadPage(email: string, id: string): Promise<Loaded> {
  try {
    const person = await findPersonByEmail(email);
    if (person === null) {
      return {
        kind: "unavailable",
        reason: `הכתובת ${email} אינה משויכת לאף אדם בטבלת people. יש לעדכן את שתי הכתובות במסד (ראו README).`,
      };
    }
    const [people, accounts, snapshot, header, history, positions, earmarks, settings, records] =
      await Promise.all([
        listPeople(),
        loadAccounts(),
        findSnapshot(id),
        findSnapshotHeader(id),
        loadSnapshotHeaders(),
        loadPositions(),
        loadEarmarks(),
        loadHouseholdSettings(),
        loadRsuRecords(),
      ]);
    if (snapshot === null) return { kind: "missing" };
    return {
      kind: "ok",
      person,
      people,
      accounts,
      snapshot,
      note: header?.note ?? null,
      history,
      positions,
      earmarks,
      // The position as of *this snapshot's* date, never today's: a sale made in
      // March cannot reach back and reduce January's reading.
      rsu: readRsuLine({
        snapshot,
        accounts,
        accountId: settings.rsuAccountId,
        position: readPosition({ ...records, asOf: snapshot.takenOn }),
        price: header?.rsuPrice ?? null,
      }),
    };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- browsing the history by date --------------------------------------------

/**
 * The snapshot before and after this one by date. A snapshot is a reading in a
 * series, so the series is walkable from inside it — and the comparison with the
 * previous one is one click from here rather than a form to fill in.
 */
function NeighbourNav({
  snapshot,
  history,
}: {
  snapshot: Snapshot;
  history: readonly SnapshotHeader[];
}) {
  const earlier = history.filter((header) => compareDates(header.takenOn, snapshot.takenOn) < 0);
  const later = history.filter((header) => compareDates(header.takenOn, snapshot.takenOn) > 0);
  // `history` is newest first, so the nearest neighbour on each side is the last
  // of the earlier ones and the last of the later ones.
  const previous = earlier[0] ?? null;
  const next = later[later.length - 1] ?? null;

  return (
    <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" aria-label="ניווט בין צילומים">
      {previous === null ? (
        <span className="text-stone-400">אין צילום קודם</span>
      ) : (
        <Link href={`/snapshots/${previous.id}` as Route} className="underline-offset-4 hover:underline">
          <span aria-hidden="true">→ </span>הצילום הקודם, {formatDate(previous.takenOn)}
        </Link>
      )}

      {next === null ? (
        <span className="text-stone-400">זה הצילום האחרון</span>
      ) : (
        <Link href={`/snapshots/${next.id}` as Route} className="underline-offset-4 hover:underline">
          הצילום הבא, {formatDate(next.takenOn)}
          <span aria-hidden="true"> ←</span>
        </Link>
      )}

      {previous === null ? null : (
        <Link
          href={`/snapshots/compare?from=${previous.id}&to=${snapshot.id}` as Route}
          className="font-medium underline-offset-4 hover:underline"
        >
          השוואה לצילום הקודם
        </Link>
      )}
    </nav>
  );
}

// --- the snapshot ------------------------------------------------------------

function SnapshotView({
  snapshot,
  accounts,
  people,
  positions,
  earmarks,
  rsu,
}: {
  snapshot: Snapshot;
  accounts: readonly Account[];
  people: readonly Person[];
  positions: readonly Position[];
  earmarks: readonly Earmark[];
  rsu: RsuLineReading;
}) {
  // Every screen figure is converted at the snapshot's own rate, so a snapshot
  // without one is readable in native currencies and rolls up to nothing. Taking
  // a snapshot always records a rate; this is the shape, not the usual case.
  const convertible = canConvertWithin(snapshot, "USD", READING_CURRENCY);
  const missing = accountsMissingFrom(snapshot, accounts);

  return (
    <div className="space-y-6">
      <SummaryPanel snapshot={snapshot} accounts={accounts} convertible={convertible} />

      {missing.length === 0 ? null : (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4" role="status">
          <p className="font-medium text-amber-900">
            <bdi className="tabular">{missing.length}</bdi> חשבונות הוגדרו אחרי שהצילום הזה נלקח, ולכן
            אינם בו
          </p>
          <p className="mt-1 text-sm text-amber-800">
            {missing.map((account) => account.name).join(" · ")} — הוספה תכניס אותם כשורות שלא נמדדו
            מעולם, לא כאפסים שמישהו קבע.
          </p>
          <form action={fillMissingAccounts} className="mt-3">
            <input type="hidden" name="snapshotId" value={snapshot.id} />
            <button
              type="submit"
              className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-sm font-medium hover:bg-amber-100"
            >
              הוספת החשבונות החסרים
            </button>
          </form>
        </div>
      )}

      {convertible ? (
        <CurrencyTables
          shekels={currencyTable(snapshot, accounts, "ILS")}
          dollars={currencyTable(snapshot, accounts, "USD")}
        />
      ) : null}

      {convertible ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <RollupPanel
            title="לפי קטגוריה"
            note="נזילות, השקעות, פנסיה, נדל״ן — הריכוזים שהמשק חושב בהם"
            readings={convertedReadings(snapshot, accounts, READING_CURRENCY)}
            lines={rollupBy(snapshot, accounts, READING_CURRENCY, "category")}
            dimension="category"
          />
          <RollupPanel
            title="לפי סוג נכס"
            note="החלוקה הדקה יותר, במילים של המשק"
            readings={convertedReadings(snapshot, accounts, READING_CURRENCY)}
            lines={rollupBy(snapshot, accounts, READING_CURRENCY, "assetKind")}
            dimension="assetKind"
          />
        </div>
      ) : (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            לצילום הזה אין שער <bdi>USD/ILS</bdi>, ולכן אין דרך לרכז אותו לשקלים. כל סכום נקרא למטה
            במטבע שלו.
          </p>
        </div>
      )}

      <RsuHoldingPanel rsu={rsu} snapshot={snapshot} />

      <EarmarksPanel funding={earmarkFunding({ snapshot, accounts, earmarks })} />

      {convertible ? (
        <FreeLiquidPanel free={freeLiquid({ snapshot, accounts, earmarks, currency: READING_CURRENCY })} />
      ) : null}

      <RestateForm
        readings={snapshotReadings(snapshot, accounts)}
        snapshotId={snapshot.id}
        people={people}
        positions={positions}
        rsu={rsu}
        takenOn={snapshot.takenOn}
      />
    </div>
  );
}

function SummaryPanel({
  snapshot,
  accounts,
  convertible,
}: {
  snapshot: Snapshot;
  accounts: readonly Account[];
  convertible: boolean;
}) {
  const completeness = completenessOf(snapshot);

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <p className="text-sm font-semibold tracking-wide text-stone-500">סך הכול</p>
          <bdi className="tabular block text-3xl font-semibold">
            {convertible ? format(snapshotTotal(snapshot, accounts, READING_CURRENCY)) : "—"}
          </bdi>
          {convertible ? (
            <BasisNote
              className="mt-1"
              split={basisSplitOf(convertedReadings(snapshot, accounts, READING_CURRENCY), READING_CURRENCY)}
            />
          ) : null}
        </div>
        <div>
          <p className="text-sm font-semibold tracking-wide text-stone-500">
            שער <bdi>USD/ILS</bdi> בצילום
          </p>
          <bdi className="tabular block text-2xl">
            {/* The stored quote itself, which is why this reads the pair as it was written. */}
            {hasRateWithin(snapshot, "USD", "ILS") ? rateWithin(snapshot, "USD", "ILS").rate : "—"}
          </bdi>
        </div>
        <div>
          <p className="text-sm font-semibold tracking-wide text-stone-500">נמדדו בתאריך הזה</p>
          <bdi className="tabular block text-2xl">
            {completeness.entered}/{completeness.total}
          </bdi>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {completeness.carried === 0 ? (
          <p className="inline-flex flex-wrap items-center gap-x-2 rounded-md bg-emerald-50 px-3 py-1.5 text-sm text-emerald-900">
            <span className="font-medium">כל השורות נמדדו בתאריך הצילום</span>
          </p>
        ) : (
          <p
            className="inline-flex flex-wrap items-center gap-x-2 rounded-md bg-amber-50 px-3 py-1.5 text-sm text-amber-900"
            role="status"
          >
            <span className="font-medium">
              <bdi className="tabular">{completeness.carried}</bdi> שורות נגררו
            </span>
            <span>
              — הערך שלהן הובא מצילום קודם ואיש לא מדד אותן ביום הזה
              {completeness.unmeasured === 0 ? null : (
                <>
                  , ומתוכן <bdi className="tabular">{completeness.unmeasured}</bdi> מעולם לא נמדדו
                </>
              )}
            </span>
          </p>
        )}
        <p className="text-sm text-stone-500">
          הצילום שלם מעצם בנייתו: יש בו שורה לכל חשבון שהיה פתוח ב־{formatDate(snapshot.takenOn)}. כל
          המרה בעמוד הזה נעשית בשער השמור על הצילום, לא בשער של היום.
        </p>
      </div>
    </section>
  );
}

// --- the שקל and דולר tables -------------------------------------------------

const CURRENCY_TITLES: Record<Currency, { title: string; note: string }> = {
  ILS: { title: "טבלת שקל", note: "כל חשבון, מוצג בשקלים" },
  USD: { title: "טבלת דולר", note: "אותם חשבונות, מוצגים בדולרים" },
};

/**
 * The two tables the sheet maintained by hand, computed. Neither is stored and
 * neither has an input in it: they are the same lines read through the same rate,
 * so an account cannot read 519,088 in one and 450,376 in the other.
 */
function CurrencyTables({ shekels, dollars }: { shekels: CurrencyTable; dollars: CurrencyTable }) {
  return (
    <section className="space-y-3">
      <p className="text-sm text-stone-600">
        שתי הטבלאות מחושבות מאותן שורות ובאותו שער של הצילום — הן אינן נשמרות ואי אפשר לערוך אף אחת
        מהן בנפרד. תיקון נעשה פעם אחת בלבד, בטופס שלמטה, במטבע שהחשבון מוחזק בו.
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <CurrencyTablePanel table={shekels} />
        <CurrencyTablePanel table={dollars} />
      </div>
    </section>
  );
}

function CurrencyTablePanel({ table }: { table: CurrencyTable }) {
  const { title, note } = CURRENCY_TITLES[table.currency];

  return (
    <section className="rounded-lg border border-stone-300 bg-white">
      <div className="border-b border-stone-200 px-5 py-3">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">{title}</h2>
        <p className="text-xs text-stone-500">{note}</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-stone-500">
            <tr className="border-b border-stone-200">
              <th scope="col" className="px-5 py-2 text-start font-medium">
                חשבון
              </th>
              <th scope="col" className="px-5 py-2 text-start font-medium">
                בסיס השווי
              </th>
              <th scope="col" className="px-5 py-2 text-end font-medium">
                <bdi>{table.currency}</bdi>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {table.rows.map((row) => (
              <tr key={row.account.id}>
                <th scope="row" className="px-5 py-2 text-start font-normal">
                  <bdi>{row.account.name}</bdi>
                  {row.line.source === "carried" ? (
                    <span className="ms-2 text-xs text-amber-800">נגרר</span>
                  ) : null}
                </th>
                <td className="px-5 py-2 text-stone-500">{VALUE_BASIS_LABELS[row.account.valueBasis]}</td>
                <td className="px-5 py-2 text-end">
                  <bdi className="tabular">{format(row.converted)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-stone-200 font-medium">
              <th scope="row" colSpan={2} className="px-5 py-2 text-start">
                סך הכול
              </th>
              <td className="px-5 py-2 text-end">
                <bdi className="tabular">{format(table.total)}</bdi>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <BasisNote split={table.basis} className="border-t border-stone-200 px-5 py-3" />
    </section>
  );
}

// --- rollups -----------------------------------------------------------------

function labelFor(dimension: RollupDimension, key: string): string {
  if (dimension === "category" && isAssetCategory(key)) return ASSET_CATEGORY_LABELS[key];
  return key;
}

function RollupPanel({
  title,
  note,
  readings,
  lines,
  dimension,
}: {
  title: string;
  note: string;
  readings: readonly ConvertedReading[];
  lines: readonly RollupLine[];
  dimension: RollupDimension;
}) {
  if (lines.length === 0) return null;

  return (
    <section className="rounded-lg border border-stone-300 bg-white">
      <div className="border-b border-stone-200 px-5 py-3">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">{title}</h2>
        <p className="text-xs text-stone-500">{note}</p>
      </div>

      <ul className="divide-y divide-stone-200">
        {lines.map((line) => {
          // The bucket's readings, used for both the drill-down and the split, so
          // a total, its parts and what it is made of cannot disagree.
          const inBucket = readingsIn(readings, dimension, line.key);

          return (
            <li key={line.key}>
              <details className="group">
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                  <span className="min-w-0 flex-1 font-medium">
                    <span aria-hidden="true" className="text-stone-400 group-open:hidden">
                      ▸{" "}
                    </span>
                    <span aria-hidden="true" className="hidden text-stone-400 group-open:inline">
                      ▾{" "}
                    </span>
                    <bdi>{labelFor(dimension, line.key)}</bdi>
                  </span>
                  <div className="text-end">
                    <bdi className="tabular font-medium">{format(line.total)}</bdi>
                    <BasisNote split={basisSplitOf(inBucket, line.total.currency)} />
                  </div>
                  {line.carriedCount === 0 ? null : (
                    <span className="w-full text-xs text-amber-800 sm:w-auto">
                      <bdi className="tabular">{line.carriedCount}</bdi> נגררו
                    </span>
                  )}
                </summary>

                <ul className="divide-y divide-stone-100 border-t border-stone-100 bg-stone-50/60">
                  {inBucket.map((reading) => (
                    <li
                      key={reading.account.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2 ps-9"
                    >
                      <span className="min-w-0 flex-1 text-sm">
                        <bdi>{reading.account.name}</bdi>
                      </span>
                      <NativeAndConverted reading={reading} />
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A foreign figure reads in its own currency first — that is what was recorded. */
function NativeAndConverted({ reading }: { reading: ConvertedReading }) {
  if (reading.account.currency === READING_CURRENCY) {
    return <bdi className="tabular text-sm">{format(reading.native)}</bdi>;
  }
  return (
    <span className="text-sm">
      <bdi className="tabular font-medium">{format(reading.native)}</bdi>
      <span className="text-stone-500">
        {" ≈ "}
        <bdi className="tabular">{format(reading.converted)}</bdi>
      </span>
    </span>
  );
}

// --- the RSU holding ---------------------------------------------------------

/**
 * The one line on this screen nobody typed. Its share count comes from the
 * recorded grants, vests and sales as of this snapshot's own date; its price is
 * the one stored on the snapshot, the way the exchange rate is; and if the account
 * is not held in dollars, the conversion is the snapshot's own rate and can be
 * nothing else.
 *
 * The panel shows the arithmetic rather than only its answer, so the household can
 * check the figure instead of trusting it — and reports a recorded figure that has
 * fallen out of step rather than quietly rewriting it.
 */
function RsuHoldingPanel({ rsu, snapshot }: { rsu: RsuLineReading; snapshot: Snapshot }) {
  if (rsu.kind === "unnamed") return null;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">
        החזקת ה־<bdi>RSU</bdi> במיפוי — נגזרת
      </h2>

      {rsu.kind === "unknown" ? (
        <p className="mt-2 text-sm text-amber-800">
          ההגדרות מפנות לחשבון <bdi>{rsu.accountId}</bdi> שאינו קיים.{" "}
          <Link href="/settings" className="underline underline-offset-4">
            בחירת חשבון
          </Link>
        </p>
      ) : rsu.kind === "not-open" ? (
        <p className="mt-2 text-sm text-stone-600">
          <bdi className="font-medium">{rsu.account.name}</bdi> נפתח אחרי {formatDate(snapshot.takenOn)},
          ולכן אין בצילום הזה שורה שלו ואין לתוכה מה לגזור.
        </p>
      ) : rsu.kind === "unpriced" ? (
        <p className="mt-2 text-sm text-amber-800">
          לצילום הזה לא נרשם מחיר למניה, ולכן אין ממה לגזור את היתרה של{" "}
          <bdi className="font-medium">{rsu.account.name}</bdi>. מוחזקות{" "}
          <bdi className="tabular">{rsu.shares}</bdi> מניות; הסכום הרשום כרגע נשאר כפי שהוא ולא מאופס.
          המחיר נרשם בטופס שלמטה.
        </p>
      ) : rsu.kind === "unconvertible" ? (
        <p className="mt-2 text-sm text-amber-800">
          ההחזקה היא <bdi className="tabular">{format(rsu.holding.value)}</bdi>, אך הצילום הזה אינו
          נושא שער שממיר <bdi>{rsu.holding.value.currency}</bdi> ל־<bdi>{rsu.account.currency}</bdi>.
          המרה בשער אחר תהיה שער שאיש לא נקב בו, ולכן אין המרה.
        </p>
      ) : (
        <>
          <p className="mt-2 text-2xl font-semibold">
            <bdi className="tabular">{format(rsu.balance)}</bdi>
          </p>
          <p className="mt-1 text-sm text-stone-600">
            <bdi className="tabular">{rsu.holding.shares}</bdi> מניות מוחזקות ב־
            {formatDate(rsu.holding.asOf)} × <bdi className="tabular">{formatSharePrice(rsu.holding.price)}</bdi>{" "}
            = <bdi className="tabular">{format(rsu.holding.value)}</bdi>
            {rsu.account.currency === rsu.holding.value.currency ? null : (
              <>
                , בשער של הצילום —{" "}
                <bdi className="tabular">
                  {hasRateWithin(snapshot, "USD", "ILS") ? rateWithin(snapshot, "USD", "ILS").rate : "—"}
                </bdi>
              </>
            )}
            .
          </p>
          <p className="mt-1 text-sm text-stone-600">
            מספר המניות אינו מוקלד בשום מקום — הוא נגזר מההקצאות, ההבשלות והמכירות הרשומות ב־
            <Link href="/rsu" className="underline underline-offset-4">
              מחשבון RSU
            </Link>
            . לכן ההחזקה אינה מתוחזקת בשני מקומות ואינה יכולה להיפרד מעצמה.
          </p>

          {rsu.recorded === null ? (
            <p className="mt-3 text-sm text-amber-800">
              הצילום עדיין אינו נושא שורה לחשבון הזה. שמירת הטופס למטה תכתוב אותה.
            </p>
          ) : rsu.agrees ? (
            <p className="mt-3 text-sm font-medium text-emerald-800">
              זה בדיוק מה שרשום בצילום.
            </p>
          ) : (
            <p className="mt-3 text-sm text-amber-800">
              בצילום רשום כרגע <bdi className="tabular">{format(rsu.recorded)}</bdi> — הפרש של{" "}
              <bdi className="tabular font-medium">
                {rsu.difference === null ? "—" : format(rsu.difference)}
              </bdi>
              . המצב הרשום השתנה מאז; שמירת הטופס למטה תגזור מחדש.
            </p>
          )}
        </>
      )}
    </section>
  );
}

// --- ייעודים -----------------------------------------------------------------

const STATUS_STYLES = {
  funded: { box: "border-emerald-300 bg-emerald-50", text: "text-emerald-900", label: "מכוסה" },
  underfunded: { box: "border-red-300 bg-red-50", text: "text-red-900", label: "חסר כיסוי" },
  unmeasured: { box: "border-stone-300 bg-stone-50", text: "text-stone-700", label: "לא נמדד" },
} as const;

/**
 * What the money is promised to, read against this snapshot's own figures. The
 * unit is the account rather than the claim because claims on the same money
 * compete for it — nothing here invents an order that would make one of them whole
 * at another's expense.
 */
function EarmarksPanel({ funding }: { funding: readonly AccountEarmarks[] }) {
  if (funding.length === 0) return null;

  return (
    <section className="rounded-lg border border-stone-300 bg-white">
      <div className="border-b border-stone-200 px-5 py-3">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">ייעודים</h2>
        <p className="text-xs text-stone-500">
          כמה מהכסף כבר מובטח, ואם יש מאחוריו כיסוי. ההשוואה נעשית במטבע של החשבון עצמו, כך שאף שער
          לא יכול להפוך חוסר לעודף.
        </p>
      </div>

      <ul className="divide-y divide-stone-200">
        {funding.map((entry) => {
          const style = STATUS_STYLES[entry.status];
          return (
            <li key={entry.account.id} className={`border-s-4 px-5 py-3 ${style.box}`}>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="min-w-0 flex-1 font-medium">
                  <bdi>{entry.account.name}</bdi>
                </span>
                <span className={`text-xs font-medium ${style.text}`}>{style.label}</span>
              </div>

              <p className="mt-1 text-sm text-stone-600">
                מובטח <bdi className="tabular font-medium">{format(entry.claimed)}</bdi> · בחשבון{" "}
                <bdi className="tabular font-medium">{format(entry.backing)}</bdi>
              </p>

              {entry.shortfall === null ? null : (
                <p className={`mt-1 text-sm font-medium ${style.text}`}>
                  חסרים <bdi className="tabular">{format(entry.shortfall)}</bdi> — ההבטחה לא קטנה, הכיסוי
                  שלה ירד
                </p>
              )}
              {entry.free === null ? null : (
                <p className="mt-1 text-sm text-stone-600">
                  פנוי בחשבון הזה <bdi className="tabular">{format(entry.free)}</bdi>
                </p>
              )}
              {entry.status === "unmeasured" ? (
                <p className="mt-1 text-sm text-stone-600">
                  איש לא מדד את החשבון הזה מעולם, ולכן אין מול מה למדוד את ההבטחה. זה לא חוסר כיסוי —
                  זו העדר מדידה.
                </p>
              ) : null}

              <ul className="mt-2 space-y-1">
                {entry.earmarks.map((earmark) => (
                  <li key={earmark.id} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                    <span className="min-w-0 flex-1 text-stone-700">
                      <bdi>{earmark.name}</bdi>
                    </span>
                    <bdi className="tabular">{format(earmark.claim)}</bdi>
                  </li>
                ))}
              </ul>

              {entry.earmarks.length > 1 ? (
                <p className="mt-1 text-xs text-stone-500">
                  שני ייעודים ומעלה על אותו חשבון מתחרים על אותו כסף, ולכן הם נמדדים יחד.
                </p>
              ) : null}
              {entry.carried && entry.status !== "unmeasured" ? (
                <p className="mt-1 text-xs text-amber-800">
                  היתרה נגררה
                  {entry.measuredOn === null ? null : <> — נמדדה לאחרונה ב־{formatDate(entry.measuredOn)}</>}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * What is genuinely available. נזילות less what is promised out of it — a claim on
 * an account in another bucket is spoken for out of *that* bucket and does not
 * reduce this figure.
 */
function FreeLiquidPanel({ free }: { free: FreeLiquid }) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">כסף נזיל פנוי</h2>
      <p className="mt-1 text-xs text-stone-500">
        נזילות פחות מה שכבר מובטח מתוכה. ייעוד על חשבון בקטגוריה אחרת נלקח מאותה קטגוריה ואינו מקטין
        את המספר הזה.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs text-stone-500">נזילות</p>
          <bdi className="tabular block text-2xl">{format(free.holdings)}</bdi>
        </div>
        <div>
          <p className="text-xs text-stone-500">מובטח</p>
          <bdi className="tabular block text-2xl">{format(free.earmarked)}</bdi>
        </div>
        <div>
          <p className="text-xs text-stone-500">פנוי</p>
          <bdi
            className={`tabular block text-3xl font-semibold ${isNegative(free.free) ? "text-red-800" : ""}`}
          >
            {format(free.free)}
          </bdi>
        </div>
      </div>

      <div className="mt-3 space-y-1">
        {isNegative(free.free) ? (
          <p className="text-sm font-medium text-red-800">
            מובטח יותר ממה שיש. המספר נשאר שלילי ולא מתאפס — הבטחה בלי כיסוי היא עובדה, לא אפס.
          </p>
        ) : null}
        {free.shortfall.minorUnits === 0 ? null : (
          <p className="text-sm text-red-800">
            מתוך המובטח, <bdi className="tabular font-medium">{format(free.shortfall)}</bdi> אין מאחוריו
            כיסוי בחשבון שהובטח ממנו. הסכום המובטח יורד מהנזילות במלואו, והחלק הלא־מכוסה נאמר כאן ולא
            נמחק בשקט.
          </p>
        )}
        {free.unmeasuredAccounts === 0 ? null : (
          <p className="text-sm text-amber-800">
            <bdi className="tabular">{free.unmeasuredAccounts}</bdi> חשבונות נזילים לא נמדדו מעולם,
            והמספרים כאן נשענים על מציין המקום שלהם.
          </p>
        )}
      </div>
    </section>
  );
}

// --- restating ---------------------------------------------------------------

function RestateForm({
  readings,
  snapshotId,
  people,
  positions,
  rsu,
  takenOn,
}: {
  readings: readonly SnapshotReading[];
  snapshotId: string;
  people: readonly Person[];
  positions: readonly Position[];
  rsu: RsuLineReading;
  takenOn: CalendarDate;
}) {
  const nameOf = (personId: string) =>
    people.find((person) => person.id === personId)?.displayName ?? personId;

  // The one account with no amount field on this form. Everything about its
  // balance is derived, so offering a box to type it in would be offering a way
  // to disagree with the records.
  const derivedAccountId =
    rsu.kind === "derived" || rsu.kind === "unpriced" || rsu.kind === "unconvertible"
      ? rsu.account.id
      : null;

  return (
    <form action={restateSnapshot} className="space-y-6">
      <input type="hidden" name="snapshotId" value={snapshotId} />

      <p className="text-sm text-stone-600">
        עדכון הצילום הוא תיקון של מה שהשתנה, לא הקלדה מחדש. סכום ששונה נרשם כנמדד בתאריך הצילום; סכום
        שנשלח כמו שהוא נשאר גרור — אלא אם סימנתם <span className="font-medium">נמדד</span>, שזו הדרך
        להגיד ״הסתכלתי, וזה באמת הערך״.
      </p>

      <RsuPriceField rsu={rsu} takenOn={takenOn} />

      {/* Grouped from the readings themselves, so the form renders with no rate at all. */}
      {ASSET_CATEGORIES.flatMap((category) => {
        const inBucket = readingsIn(readings, "category", category);
        if (inBucket.length === 0) return [];

        return (
        <section key={category} className="rounded-lg border border-stone-300 bg-white">
          <h2 className="border-b border-stone-200 px-5 py-3 text-sm font-semibold tracking-wide text-stone-500">
            {ASSET_CATEGORY_LABELS[category]}
          </h2>

          <ul className="divide-y divide-stone-200">
            {inBucket.map((reading) => (
              <li key={reading.account.id} className="px-5 py-4">
                <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
                  <div className="min-w-48 flex-1">
                    <p className="font-medium">
                      <bdi>{reading.account.name}</bdi>
                    </p>
                    <p className="text-xs text-stone-500">
                      {nameOf(reading.account.personId)} · <bdi>{reading.account.assetKind}</bdi> ·{" "}
                      {VALUE_BASIS_LABELS[reading.account.valueBasis]}
                    </p>
                    <PositionsLine positions={positionsIn(positions, reading.account.id)} />
                    <SourceBadge reading={reading} />
                  </div>

                  {reading.account.id === derivedAccountId ? (
                    <div className="pb-2">
                      <p className="text-xs text-stone-500">
                        יתרה ב־<bdi>{reading.account.currency}</bdi>
                      </p>
                      <p className="tabular mt-1 text-lg font-medium">
                        <bdi>{format(reading.native)}</bdi>
                      </p>
                      <p className="text-xs text-stone-500">
                        נגזרת מהמצב הרשום ומהמחיר שלמעלה — אין כאן מה להקליד
                      </p>
                    </div>
                  ) : (
                    <>
                      <label className="block">
                        <span className="block text-xs text-stone-500">
                          יתרה ב־<bdi>{reading.account.currency}</bdi>
                        </span>
                        {/* The exact decimal goes back in, so a row nobody touches
                            round-trips to the same minor units and stays carried. */}
                        <input
                          name={`amount:${reading.account.id}`}
                          defaultValue={toDecimalString(reading.native)}
                          inputMode="decimal"
                          dir="ltr"
                          className="tabular mt-1 w-40 rounded-md border border-stone-300 px-3 py-2 text-end"
                        />
                      </label>

                      <label className="flex items-center gap-2 pb-2 text-sm">
                        <input
                          type="checkbox"
                          name={`measured:${reading.account.id}`}
                          className="size-4 rounded border-stone-300"
                        />
                        <span>נמדד</span>
                      </label>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
        );
      })}

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          className="rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
        >
          שמירת הצילום
        </button>
        <Link href="/accounts" className="text-sm text-stone-600 underline-offset-4 hover:underline">
          חסר חשבון? הגדרתו כאן
        </Link>
      </div>
    </form>
  );
}

/**
 * The share price this reading was taken at — the only thing about the RSU
 * holding anybody states, because nothing in this system reads a market. It sits
 * on the snapshot beside its exchange rate, so correcting it here corrects this
 * reading and no other, and a snapshot from last year keeps the price it was read
 * at.
 */
function RsuPriceField({ rsu, takenOn }: { rsu: RsuLineReading; takenOn: CalendarDate }) {
  if (rsu.kind === "unnamed" || rsu.kind === "unknown" || rsu.kind === "not-open") return null;

  const current = rsu.kind === "unpriced" ? null : rsu.holding.price;

  return (
    <section className="rounded-lg border border-stone-300 bg-white px-5 py-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <label className="block">
          <span className="block text-sm font-medium text-stone-700">
            מחיר מניית <bdi>RSU</bdi> בתאריך הצילום
          </span>
          <span className="block text-xs text-stone-500">
            דולרים למניה — ריק פירושו שאיש לא נקב במחיר
          </span>
          <input
            name="sharePrice"
            inputMode="decimal"
            dir="ltr"
            defaultValue={current === null ? "" : sharePriceToDecimalString(current)}
            className="tabular mt-1 w-40 rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </label>

        <p className="max-w-lg text-sm text-stone-600">
          היתרה של <bdi className="font-medium">{rsu.account.name}</bdi> נגזרת ממנו וממספר המניות
          המוחזק ב־{formatDate(takenOn)}. שמירת הטופס גוזרת אותה מחדש — גם אחרי שנרשמה הבשלה או
          מכירה.
        </p>
      </div>
    </section>
  );
}

/**
 * What the account is invested in, beside the figure being restated. No amount is
 * shown per position: the account's balance is the measured fact, and splitting it
 * between instruments would be a figure nobody stated.
 */
function PositionsLine({ positions }: { positions: readonly Position[] }) {
  if (positions.length === 0) return null;

  return (
    <p className="text-xs text-stone-500">
      מושקע ב־
      {positions.map((position, index) => (
        <span key={position.id}>
          {index === 0 ? null : <span aria-hidden="true"> · </span>}
          <bdi>{position.securityId === null ? position.name : `${position.securityId} ${position.name}`}</bdi>
        </span>
      ))}
    </p>
  );
}

function SourceBadge({ reading }: { reading: SnapshotReading }) {
  const { line } = reading;

  if (line.source === "entered") {
    return (
      <p className="mt-1 inline-flex items-center rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-900">
        נמדד בתאריך הצילום
      </p>
    );
  }

  if (line.measuredOn === null) {
    return (
      <p className="mt-1 inline-flex items-center rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-700">
        לא נמדד מעולם — הסכום הוא מציין מקום ולא מדידה
      </p>
    );
  }

  return (
    <p className="mt-1 inline-flex items-center rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-900">
      נגרר — נמדד לאחרונה ב־{formatDate(line.measuredOn)}
    </p>
  );
}
