import type { Route } from "next";
import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { BasisNote } from "@/components/basis-note";
import { loadAccounts } from "@/db/accounts";
import { loadCategories } from "@/db/categories";
import { DatabaseNotConfiguredError } from "@/db/client";
import { loadLedger } from "@/db/ledger";
import { type Person, findPersonByEmail } from "@/db/people";
import { type HouseholdSettings, loadHouseholdSettings } from "@/db/settings";
import { loadSnapshots } from "@/db/snapshots";
import { type Categories } from "@/domain/categories/categories";
import { type Ledger } from "@/domain/ledger/ledger";
import { type Money, format, isNegative, isZero, negate } from "@/domain/money/money";
import {
  type Allocation,
  type AllocationLine,
  type AppreciationRange,
  type ChangeDecomposition,
  type Concentration,
  type CurrencyExposure,
  type MovementAttribution,
  type NetWorthPoint,
  type Reconciliation,
  allocation,
  appreciationRange,
  concentrationOf,
  currencyExposure,
  decomposeChange,
  netWorthTrajectory,
  reconcileMoneyAdded,
} from "@/domain/networth/net-worth-analytics";
import {
  type Account,
  type ConvertedReading,
  type Snapshot,
  ASSET_CATEGORY_LABELS,
  VALUE_BASIS_LABELS,
  canConvertWithin,
  convertedReadings,
  previousSnapshot,
  snapshotReadings,
} from "@/domain/snapshot/snapshot";
import { compareDates, formatDate } from "@/domain/time/calendar-date";
import { formatMonth } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { TrajectoryChart } from "./charts";

export const dynamic = "force-dynamic";

/**
 * שווי נטו — the derived view over מיפוי.
 *
 * Nothing here is writable and no figure on this screen is stored. The trajectory
 * reads every snapshot at its own rate; exposure, allocation and concentration all
 * read one snapshot, named at the top, so no figure is ambiguous about which
 * reading it belongs to.
 *
 * Per ADR 0003 the recorded total holds cost-held assets at cost. The one panel
 * that grows them says which assumption it grew them by, and links to where that
 * assumption is set.
 */

const READING_CURRENCY = "ILS" as const;

const PERCENT = new Intl.NumberFormat("he-IL", { style: "percent", maximumFractionDigits: 1 });

interface SearchParams {
  snapshot?: string | string[];
  /** The opening reading of the decomposition. Defaults to the one before `snapshot`. */
  from?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function NetWorthPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const loaded = await loadPage(email, first(params.snapshot));

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="שווי נטו"
        subtitle="מסלול, חשיפה למט״ח, הקצאה וריכוזיות — הכול נגזר מהמיפוי"
        back={{ href: "/", label: "חזרה ללוח המחוונים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        {loaded.kind === "ok" ? (
          <NetWorthView loaded={loaded} openingId={first(params.from)} />
        ) : (
          <UnavailablePanel reason={loaded.reason} />
        )}
      </main>
    </div>
  );
}

// --- loading -----------------------------------------------------------------

interface LoadedOk {
  kind: "ok";
  person: Person;
  accounts: readonly Account[];
  snapshots: readonly Snapshot[];
  /** The snapshot everything but the trajectory is read against. */
  current: Snapshot | null;
  settings: HouseholdSettings;
  /** The מאזן, for the one panel that holds the two halves of the system against each other. */
  ledger: Ledger;
  categories: Categories;
}

type Loaded = LoadedOk | { kind: "unavailable"; reason: string };

async function loadPage(email: string, wanted: string | undefined): Promise<Loaded> {
  try {
    const person = await findPersonByEmail(email);
    if (person === null) {
      return {
        kind: "unavailable",
        reason: `הכתובת ${email} אינה משויכת לאף אדם בטבלת people. יש לעדכן את שתי הכתובות במסד (ראו README).`,
      };
    }
    const [accounts, snapshots, settings, ledger, categories] = await Promise.all([
      loadAccounts(),
      loadSnapshots(),
      loadHouseholdSettings(),
      loadLedger(),
      loadCategories(),
    ]);

    // Newest first out of the database; the newest is what the household means by
    // "where we are" unless they asked for another.
    const current =
      snapshots.find((snapshot) => snapshot.id === wanted) ?? snapshots[0] ?? null;

    return { kind: "ok", person, accounts, snapshots, current, settings, ledger, categories };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- the screen ---------------------------------------------------------------

function NetWorthView({ loaded, openingId }: { loaded: LoadedOk; openingId: string | undefined }) {
  const { accounts, snapshots, current, settings } = loaded;

  if (current === null) {
    return (
      <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
        אין עדיין צילומים, ולכן אין ממה לגזור שווי נטו.{" "}
        <Link href="/snapshots" className="underline underline-offset-4">
          לקיחת הצילום הראשון
        </Link>{" "}
        היא הצעד הראשון.
      </p>
    );
  }

  const trajectory = netWorthTrajectory({ snapshots, accounts, currency: READING_CURRENCY });
  const readable = canRestate(current, accounts);
  const readings = readable ? convertedReadings(current, accounts, READING_CURRENCY) : [];

  // A change is between two readings, so this panel is the one thing on the screen
  // that is about a period rather than a moment. It runs from the reading before
  // this one unless another opening reading was named.
  const named = snapshots.find((snapshot) => snapshot.id === openingId) ?? null;
  const earlier =
    named !== null && compareDates(named.takenOn, current.takenOn) < 0
      ? named
      : previousSnapshot(snapshots, current.takenOn);
  const decomposition =
    earlier === null || !readable || !canRestate(earlier, accounts)
      ? null
      : decomposeChange({
          earlier,
          later: current,
          accounts,
          marketMovingAccountIds: settings.marketMovingAccountIds,
          currency: READING_CURRENCY,
        });

  return (
    <>
      <SnapshotPicker snapshots={snapshots} current={current} />
      <TrajectoryPanel points={trajectory} currentId={current.id} />

      {decomposition === null ? (
        <NoDecompositionPanel snapshots={snapshots} earlier={earlier} />
      ) : (
        <>
          <ReconciliationPanel
            reconciliation={reconcileMoneyAdded({
              decomposition,
              ledger: loaded.ledger,
              categories: loaded.categories,
            })}
          />
          <DecompositionPanel decomposition={decomposition} />
        </>
      )}

      {readable ? (
        <>
          <ExposurePanel exposure={currencyExposure(readings, READING_CURRENCY)} />
          <AllocationPanel
            result={allocation({ readings, targets: settings.targets, currency: READING_CURRENCY })}
            readings={readings}
          />
          <AppreciationPanel
            range={appreciationRange({
              readings,
              assumption: settings.appreciation,
              asOf: current.takenOn,
              currency: READING_CURRENCY,
            })}
          />
          <ConcentrationPanel
            concentration={concentrationOf({
              readings,
              accountIds: settings.concentrationAccountIds,
              currency: READING_CURRENCY,
            })}
          />
        </>
      ) : (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            לצילום של {formatDate(current.takenOn)} אין שער <bdi>USD/ILS</bdi>, ולכן אין דרך לרכז אותו
            לשקלים. חשיפה, הקצאה וריכוזיות נקראות מצילום אחד — יש לבחור צילום אחר.
          </p>
        </div>
      )}
    </>
  );
}

function canRestate(snapshot: Snapshot, accounts: readonly Account[]): boolean {
  return snapshotReadings(snapshot, accounts).every((reading) =>
    canConvertWithin(snapshot, reading.account.currency, READING_CURRENCY),
  );
}

/** Which reading everything below the trajectory is about. One control, no ambiguity. */
function SnapshotPicker({
  snapshots,
  current,
}: {
  snapshots: readonly Snapshot[];
  current: Snapshot;
}) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white px-5 py-3">
      <p className="text-sm text-stone-600">
        החשיפה, ההקצאה והריכוזיות נקראות מהצילום של{" "}
        <Link href={`/snapshots/${current.id}` as Route} className="font-medium underline-offset-4 hover:underline">
          {formatDate(current.takenOn)}
        </Link>
        . המסלול נקרא מכל ההיסטוריה.
      </p>

      {snapshots.length < 2 ? null : (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {snapshots.map((snapshot) => (
            <li key={snapshot.id}>
              {snapshot.id === current.id ? (
                <span className="font-medium">{formatDate(snapshot.takenOn)}</span>
              ) : (
                <Link
                  href={`/net-worth?snapshot=${snapshot.id}` as Route}
                  className="text-stone-600 underline-offset-4 hover:underline"
                >
                  {formatDate(snapshot.takenOn)}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- the trajectory ------------------------------------------------------------

function TrajectoryPanel({
  points,
  currentId,
}: {
  points: readonly NetWorthPoint[];
  currentId: string;
}) {
  const latest = [...points].reverse().find((point) => point.total !== null) ?? null;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">שווי נטו לאורך זמן</h2>
        <p className="text-xs text-stone-500">
          כל נקודה מחושבת בשער של הצילום שלה, ולכן הקו אינו מצייר את עצמו מחדש כששער היום זז.
        </p>
      </div>

      {latest === null || latest.total === null ? null : (
        <div className="mt-3">
          <bdi className="tabular block text-3xl font-semibold">{format(latest.total)}</bdi>
          <p className="text-xs text-stone-500">הקריאה האחרונה, {formatDate(latest.takenOn)}</p>
          {latest.basis === null ? null : <BasisNote split={latest.basis} className="mt-1" />}
        </div>
      )}

      <div className="mt-4">
        <TrajectoryChart points={points} label="שווי נטו בכל צילום, מהישן לחדש" />
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">שווי נטו בכל צילום</caption>
          <thead className="text-xs text-stone-500">
            <tr className="border-b border-stone-200">
              <th scope="col" className="py-2 text-start font-medium">
                תאריך
              </th>
              <th scope="col" className="py-2 text-end font-medium">
                שווי נטו
              </th>
              <th scope="col" className="py-2 text-end font-medium">
                שינוי
              </th>
              <th scope="col" className="py-2 text-end font-medium">
                נמדדו
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {[...points].reverse().map((point) => (
              <tr key={point.snapshotId} className={point.snapshotId === currentId ? "bg-stone-50" : ""}>
                <th scope="row" className="py-2 text-start font-normal">
                  <Link
                    href={`/net-worth?snapshot=${point.snapshotId}` as Route}
                    className="underline-offset-4 hover:underline"
                  >
                    {formatDate(point.takenOn)}
                  </Link>
                </th>
                <td className="py-2 text-end">
                  {point.total === null ? (
                    <span className="text-stone-400">אין שער בצילום</span>
                  ) : (
                    <bdi className="tabular">{format(point.total)}</bdi>
                  )}
                </td>
                <td className="py-2 text-end">
                  <ChangeCell point={point} />
                </td>
                <td className="tabular py-2 text-end text-stone-500">
                  {point.measured}/{point.accountCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ChangeCell({ point }: { point: NetWorthPoint }) {
  if (point.change === null) {
    return <span className="text-stone-400">—</span>;
  }
  return (
    <span>
      <bdi className={`tabular ${isNegative(point.change) ? "text-red-800" : ""}`}>
        {format(point.change)}
      </bdi>
      {point.sameRate ? null : (
        <span className="ms-2 text-xs text-amber-800" title="השער השתנה בין שני הצילומים">
          שער שונה
        </span>
      )}
    </span>
  );
}

// --- ההתאמה מול המאזן ------------------------------------------------------------

/**
 * The check the spreadsheet never had: what arrived in the accounts, against what
 * the מאזן says was saved. The residual is displayed whether or not it is nought —
 * a gap that is only shown when somebody goes looking for it is a gap nobody sees.
 */
function ReconciliationPanel({ reconciliation }: { reconciliation: Reconciliation }) {
  const { residual, saving } = reconciliation;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">התאמה מול המאזן</h2>
        <p className="text-xs text-stone-500">
          {formatDate(reconciliation.from)} — {formatDate(reconciliation.to)}
        </p>
      </div>

      {saving === null || residual === null ? (
        <p className="mt-3 text-sm text-stone-600">
          התקופה בין שני הצילומים אינה מכילה אף חודש שלם, והמאזן נרשם בחודשים. אין חודש לקרוא ממנו,
          ולכן אין מול מה להשוות — וזה נאמר במקום להשוות מול חצי חודש שאיש לא רשם.
        </p>
      ) : (
        <>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs text-stone-500">כסף שנוסף — מהצילומים</p>
              <bdi className="tabular block text-2xl font-semibold">
                {format(reconciliation.moneyAdded)}
              </bdi>
            </div>
            <div>
              <p className="text-xs text-stone-500">
                חיסכון — מהמאזן, <bdi className="tabular">{reconciliation.months.length}</bdi> חודשים
              </p>
              <bdi className="tabular block text-2xl">{format(saving)}</bdi>
            </div>
            <div>
              <p className="text-xs text-stone-500">פער</p>
              <bdi
                className={`tabular block text-2xl font-semibold ${reconciliation.holds ? "" : "text-amber-800"}`}
              >
                {format(residual)}
              </bdi>
            </div>
          </div>

          <div
            className={`mt-4 rounded-md border p-4 ${
              reconciliation.holds
                ? "border-emerald-300 bg-emerald-50"
                : "border-amber-300 bg-amber-50"
            }`}
            role={reconciliation.holds ? "status" : "alert"}
          >
            {reconciliation.holds ? (
              <p className="text-sm text-emerald-900">
                שני חצאי המערכת מסתדרים: מה שהגיע לחשבונות הוא בדיוק מה שהמאזן אומר שנחסך.
              </p>
            ) : (
              <p className="text-sm text-amber-900">
                {isNegative(residual) ? (
                  <>
                    לחשבונות הגיעו <bdi className="tabular">{format(negate(residual))}</bdi> פחות ממה
                    שהמאזן אומר שנחסך. כסף שיצא ולא נרשם, חשבון ששכחנו למפות, או חשבון שסומן כנע עם
                    השוק והופקד לתוכו — הפער מוצג ולא נבלע.
                  </>
                ) : (
                  <>
                    לחשבונות הגיעו <bdi className="tabular">{format(residual)}</bdi> יותר ממה שהמאזן
                    אומר שנחסך. הכנסה שלא נרשמה, או תנועת שוק בחשבון שאיש לא סימן ככזה — הפער מוצג
                    ולא נבלע.
                  </>
                )}
              </p>
            )}
          </div>

          <ul className="mt-4 divide-y divide-stone-100 border-t border-stone-200">
            {reconciliation.months.map((month) => (
              <li
                key={`${month.month.year}-${month.month.month}`}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">{formatMonth(month.month)}</span>
                {month.completeness === "complete" ? null : (
                  <span className="text-xs text-amber-800">
                    {month.completeness === "empty" ? "לא נרשם" : "חודש חלקי"}
                  </span>
                )}
                <bdi className={`tabular ${isNegative(month.saving) ? "text-red-800" : ""}`}>
                  {format(month.saving)}
                </bdi>
              </li>
            ))}
          </ul>

          {reconciliation.incomplete.length === 0 ? null : (
            <p className="mt-2 text-sm text-amber-800">
              <bdi className="tabular">{reconciliation.incomplete.length}</bdi> מהחודשים אינם רשומים
              במלואם, ולכן החיסכון שלהם נמוך מהאמת — חלק מהפער עשוי להיות רק מה שטרם הוזן.
            </p>
          )}
        </>
      )}

      {reconciliation.clipped.length === 0 ? null : (
        <p className="mt-2 text-sm text-stone-500">
          התקופה חותכת גם את{" "}
          {reconciliation.clipped.map((month) => formatMonth(month)).join(", ")} — המאזן נרשם
          בחודשים ואין לו דמות של חצי חודש, ולכן החודשים האלה נאמרים ולא נספרים.
        </p>
      )}
    </section>
  );
}

// --- מה הרכיב את השינוי -----------------------------------------------------------

const ATTRIBUTION_LABELS: Record<MovementAttribution, string> = {
  market: "נע עם השוק",
  added: "כסף שנוסף",
  cost: "מוחזק בעלות",
  opened: "נפתח בתקופה",
  closed: "נסגר בתקופה",
};

/**
 * Every change between two readings, split three ways. The three components are
 * consecutive differences of the same position, so they add back to the change
 * exactly — and the panel prints the leftover rather than asserting there is none.
 */
function DecompositionPanel({ decomposition }: { decomposition: ChangeDecomposition }) {
  const { counts } = decomposition;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">ממה מורכב השינוי</h2>
        <p className="text-xs text-stone-500">
          {formatDate(decomposition.earlier.takenOn)} — {formatDate(decomposition.later.takenOn)}
        </p>
      </div>

      <div className="mt-3">
        <p className="text-xs text-stone-500">השינוי בסך הכול</p>
        <bdi
          className={`tabular block text-3xl font-semibold ${isNegative(decomposition.change) ? "text-red-800" : ""}`}
        >
          {format(decomposition.change)}
        </bdi>
        <p className="text-xs text-stone-500">
          מ־<bdi className="tabular">{format(decomposition.openingTotal)}</bdi> ל־
          <bdi className="tabular">{format(decomposition.closingTotal)}</bdi>, כל צד בשער של הצילום
          שלו
        </p>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Component label="כסף שנוסף" amount={decomposition.moneyAdded} note="מה שהופקד או נמשך" />
        <Component
          label="תנועת שוק"
          amount={decomposition.marketMovement}
          note={
            counts.market === 0
              ? "לא סומן אף חשבון כנע עם השוק"
              : `${counts.market} חשבונות שסומנו כנעים עם השוק`
          }
        />
        <Component
          label="תנועת שער"
          amount={decomposition.currencyMovement}
          note="מה שהשער עשה לכסף שכבר היה שם"
        />
      </div>

      <p className="mt-3 text-sm text-stone-600">
        שלושת הרכיבים הם הפרשים עוקבים של אותה החזקה, ולכן הם מסתכמים בדיוק לשינוי: היתרה היא{" "}
        <bdi className="tabular font-medium">{format(decomposition.residual)}</bdi>.
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">פירוק השינוי לפי חשבון</caption>
          <thead className="text-xs text-stone-500">
            <tr className="border-b border-stone-200">
              <th scope="col" className="py-2 text-start font-medium">
                חשבון
              </th>
              <th scope="col" className="py-2 text-end font-medium">
                כסף שנוסף
              </th>
              <th scope="col" className="py-2 text-end font-medium">
                תנועת שוק
              </th>
              <th scope="col" className="py-2 text-end font-medium">
                תנועת שער
              </th>
              <th scope="col" className="py-2 text-end font-medium">
                השינוי
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {decomposition.rows.map((row) => (
              <tr key={row.account.id}>
                <th scope="row" className="py-2 text-start font-normal">
                  <bdi>{row.account.name}</bdi>
                  <span className="ms-2 text-xs text-stone-500">
                    {ATTRIBUTION_LABELS[row.attribution]}
                  </span>
                  {row.unmeasured ? (
                    <span className="ms-2 text-xs text-amber-800">צד שלא נמדד מעולם</span>
                  ) : row.measured ? null : (
                    <span className="ms-2 text-xs text-stone-500">נגרר</span>
                  )}
                  {row.openingNative === null || row.closingNative === null ? null : (
                    <span className="block text-xs text-stone-500">
                      <bdi className="tabular">{format(row.openingNative)}</bdi> →{" "}
                      <bdi className="tabular">{format(row.closingNative)}</bdi>
                    </span>
                  )}
                </th>
                <MoneyCell amount={row.moneyAdded} />
                <MoneyCell amount={row.marketMovement} />
                <MoneyCell amount={row.currencyMovement} />
                <MoneyCell amount={row.change} strong />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-sm text-stone-500">
        שני צילומים רושמים מצב ולא תנועה, ולכן החלוקה בין תנועת שוק לכסף שנוסף אינה נמדדת אלא נקבעת:
        חשבון שלא סומן כנע עם השוק — כל מה שזז בו נקרא כסף שנוסף, וחשבון המוחזק בעלות אינו יכול
        לנוע עם שוק כלל (ADR 0003).{" "}
        <Link href="/settings" className="underline underline-offset-4">
          קביעת הסימון
        </Link>
        {counts.carried === 0 ? null : (
          <>
            {" "}
            · <bdi className="tabular">{counts.carried}</bdi> שורות נגררו ולא נמדדו בתאריך הצילום
          </>
        )}
        {counts.unmeasured === 0 ? null : (
          <>
            {" "}
            · <bdi className="tabular">{counts.unmeasured}</bdi> שורות נשענות על צד שאיש לא מדד
          </>
        )}
      </p>
    </section>
  );
}

function Component({ label, amount, note }: { label: string; amount: Money; note: string }) {
  return (
    <div>
      <p className="text-xs text-stone-500">{label}</p>
      <bdi className={`tabular block text-2xl ${isNegative(amount) ? "text-red-800" : ""}`}>
        {format(amount)}
      </bdi>
      <p className="mt-1 text-xs text-stone-500">{note}</p>
    </div>
  );
}

function MoneyCell({ amount, strong = false }: { amount: Money; strong?: boolean }) {
  return (
    <td className="py-2 text-end">
      {isZero(amount) ? (
        <span className="text-stone-400">—</span>
      ) : (
        <bdi
          className={`tabular ${strong ? "font-medium" : ""} ${isNegative(amount) ? "text-red-800" : ""}`}
        >
          {format(amount)}
        </bdi>
      )}
    </td>
  );
}

/** Why there is no decomposition: one reading, or a reading with no rate to restate it by. */
function NoDecompositionPanel({
  snapshots,
  earlier,
}: {
  snapshots: readonly Snapshot[];
  earlier: Snapshot | null;
}) {
  return (
    <section className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-sm text-stone-600">
      {snapshots.length < 2 || earlier === null ? (
        <>
          שינוי הוא מה שקרה בין שתי קריאות, ולצילום הזה אין קריאה שקדמה לו.{" "}
          <Link href="/snapshots" className="underline underline-offset-4">
            הצילום הבא
          </Link>{" "}
          הוא מה שיהפוך את המסלול הזה לפירוק.
        </>
      ) : (
        <>
          לאחד משני הצילומים — של {formatDate(earlier.takenOn)} או שלאחריו — אין שער לכל מטבע שהוא
          מחזיק, ולכן אין דרך לפרק את השינוי ביניהם בלי לשאול שער מבחוץ. פירוק כזה היה מספר שאיש
          לא מדד.
        </>
      )}
    </section>
  );
}

// --- חשיפה למט"ח ---------------------------------------------------------------

function ExposurePanel({ exposure }: { exposure: CurrencyExposure }) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">חשיפה למט״ח</h2>
      <p className="mt-1 text-sm text-stone-600">
        נגזרת ממה שהנכס <span className="font-medium">הוא</span>, לא ממה שמימן אותו: החזקה דולרית
        חשופה במלואה גם אם שני שלישים מהכסף שקנה אותה התחילו כשקלים.
      </p>

      <ul className="mt-4 divide-y divide-stone-100">
        {exposure.lines.map((line) => (
          <li key={line.currency} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
            <span className="min-w-16 font-medium">
              <bdi>{line.currency}</bdi>
            </span>
            <span className="min-w-0 flex-1 text-xs text-stone-500">
              <bdi className="tabular">{line.accountCount}</bdi> חשבונות · מוחזק{" "}
              <bdi className="tabular">{format(line.native)}</bdi>
            </span>
            <bdi className="tabular font-medium">{format(line.amount)}</bdi>
            <span className="tabular min-w-16 text-end text-stone-600">
              <Share share={line.share} />
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-sm text-stone-600">
        חשיפה למטבע זר:{" "}
        <bdi className="tabular font-medium">{format(exposure.foreign)}</bdi>{" "}
        <span className="text-stone-500">
          (<Share share={exposure.foreignShare} />)
        </span>
      </p>
    </section>
  );
}

// --- הקצאה מול רצוי -------------------------------------------------------------

const STANCE_LABELS: Record<AllocationLine["stance"], string> = {
  over: "מעל היעד",
  under: "מתחת ליעד",
  "on-target": "בדיוק ביעד",
  untargeted: "לא נקבע יעד",
};

function AllocationPanel({
  result,
  readings,
}: {
  result: Allocation;
  readings: readonly ConvertedReading[];
}) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-stone-200 px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-stone-500">הקצאה מול רצוי</h2>
          <p className="text-xs text-stone-500">
            כל קטגוריה מופיעה גם כשאין בה כלום — קטגוריה שיעדה 30% ואין בה דבר היא החריגה הגדולה ביותר
            שיש.
          </p>
        </div>
        <Link href="/settings" className="text-sm text-stone-600 underline-offset-4 hover:underline">
          קביעת היעדים
        </Link>
      </div>

      <ul className="divide-y divide-stone-200">
        {result.lines.map((line) => {
          const inBucket = readings.filter((reading) => reading.account.category === line.category);

          return (
            <li key={line.category}>
              <details className="group">
                <summary className="cursor-pointer px-5 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="min-w-0 flex-1 font-medium">
                      <span aria-hidden="true" className="text-stone-400 group-open:hidden">
                        ▸{" "}
                      </span>
                      <span aria-hidden="true" className="hidden text-stone-400 group-open:inline">
                        ▾{" "}
                      </span>
                      {ASSET_CATEGORY_LABELS[line.category]}
                    </span>
                    <bdi className="tabular font-medium">{format(line.actual)}</bdi>
                    <span className="tabular min-w-16 text-end text-stone-600">
                      <Share share={line.actualShare} />
                    </span>
                    <span className="min-w-24 text-end text-xs text-stone-500">
                      {line.targetBasisPoints === null ? (
                        STANCE_LABELS.untargeted
                      ) : (
                        <>
                          יעד <bdi className="tabular">{line.targetBasisPoints / 100}%</bdi>
                        </>
                      )}
                    </span>
                  </div>

                  <AllocationBar line={line} />

                  {line.drift === null || isZero(line.drift) ? null : (
                    <p
                      className={`mt-1 text-xs ${line.stance === "over" ? "text-amber-800" : "text-sky-900"}`}
                    >
                      {STANCE_LABELS[line.stance]} ב־
                      <bdi className="tabular">{format(sizeOf(line.drift))}</bdi> — היעד הוא{" "}
                      <bdi className="tabular">{format(line.targetAmount ?? line.actual)}</bdi>
                    </p>
                  )}
                  <BasisNote split={line.basis} className="mt-1" />
                </summary>

                <ul className="divide-y divide-stone-100 border-t border-stone-100 bg-stone-50/60">
                  {inBucket.length === 0 ? (
                    <li className="px-5 py-2 ps-9 text-sm text-stone-500">אין חשבונות בקטגוריה הזאת</li>
                  ) : (
                    inBucket.map((reading) => (
                      <li
                        key={reading.account.id}
                        className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2 ps-9 text-sm"
                      >
                        <span className="min-w-0 flex-1">
                          <bdi>{reading.account.name}</bdi>
                          <span className="ms-2 text-xs text-stone-500">
                            {VALUE_BASIS_LABELS[reading.account.valueBasis]}
                          </span>
                        </span>
                        <bdi className="tabular">{format(reading.converted)}</bdi>
                      </li>
                    ))
                  )}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>

      <p className="border-t border-stone-200 px-5 py-3 text-sm text-stone-500">
        {result.targetsTotal === 0 ? (
          <>
            לא נקבעו יעדים, ולכן כל הקטגוריות נקראות ללא יעד.{" "}
            <Link href="/settings" className="underline underline-offset-4">
              קביעתם
            </Link>{" "}
            היא מה שהופך את המסך הזה למדידה מול משהו.
          </>
        ) : (
          <>
            היעדים מסתכמים ל־<bdi className="tabular">{result.targetsTotal / 100}%</bdi>
            {result.targetsTotal === 10_000
              ? "."
              : " — הם נקראים כפי שנקבעו, ואיש אינו משלים אותם ל־100% מאחורי הגב."}
          </>
        )}
      </p>
    </section>
  );
}

/** The drift printed as a size, with over or under said in words beside it. */
function sizeOf(amount: Money): Money {
  return isNegative(amount) ? negate(amount) : amount;
}

/** The bar is decoration over figures that are all printed beside it. */
function AllocationBar({ line }: { line: AllocationLine }) {
  const actual = Math.max(0, Math.min(1, line.actualShare ?? 0));
  const target = line.targetBasisPoints === null ? null : line.targetBasisPoints / 10_000;

  return (
    <div aria-hidden="true" className="relative mt-2 h-2 w-full rounded-full bg-stone-100">
      <div
        className="absolute inset-y-0 start-0 rounded-full bg-stone-700"
        style={{ width: `${actual * 100}%` }}
      />
      {target === null ? null : (
        <div
          className="absolute inset-y-[-3px] w-0.5 bg-sky-700"
          style={{ insetInlineStart: `${Math.min(1, target) * 100}%` }}
        />
      )}
    </div>
  );
}

// --- the appreciation assumption ------------------------------------------------

function AppreciationPanel({ range }: { range: AppreciationRange }) {
  const stated = `${range.assumption.annualBasisPoints / 100}%`;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">שווי נטו כטווח</h2>
        <Link href="/settings" className="text-sm text-stone-600 underline-offset-4 hover:underline">
          שינוי ההנחה
        </Link>
      </div>

      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs text-stone-500">כפי שנרשם — עלות בעלות</p>
          <bdi className="tabular block text-2xl font-semibold">{format(range.recorded)}</bdi>
          <p className="mt-1 text-xs text-stone-500">אין בתוכו שום הנחה</p>
        </div>
        <div>
          <p className="text-xs text-stone-500">ללא נכסים המוחזקים בעלות</p>
          <bdi className="tabular block text-2xl">{format(range.excludingCostHeld)}</bdi>
          <p className="mt-1 text-xs text-stone-500">רק מה שנמדד או הוערך</p>
        </div>
        <div>
          <p className="text-xs text-stone-500">
            בהנחת עלייה של <bdi className="tabular">{stated}</bdi> לשנה
          </p>
          <bdi className="tabular block text-2xl">{format(range.withAssumption)}</bdi>
          <p className="mt-1 text-xs text-stone-500">
            {isZero(range.uplift) ? (
              "ההנחה אינה מוסיפה דבר"
            ) : (
              <>
                מתוכו <bdi className="tabular">{format(range.uplift)}</bdi> הם ההנחה עצמה
              </>
            )}
          </p>
        </div>
      </div>

      <p className="mt-3 text-sm text-stone-600">
        נכס המוחזק בעלות אינו מוערך מחדש במיפוי (ADR 0003). הטווח הזה אינו מדידה: הקצה העליון שלו
        מכפיל את הנכסים שבעלות בשיעור של <bdi className="tabular">{stated}</bdi> לשנה, לכל שנה שלמה
        מאז שנפתחו ועד {formatDate(range.asOf)}.
      </p>

      {range.assets.length === 0 ? (
        <p className="mt-2 text-sm text-stone-500">אין בצילום הזה נכסים המוחזקים בעלות.</p>
      ) : (
        <ul className="mt-3 divide-y divide-stone-100 border-t border-stone-200">
          {range.assets.map((asset) => (
            <li key={asset.account.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <bdi>{asset.account.name}</bdi>
              </span>
              <span className="text-xs text-stone-500">
                <bdi className="tabular">{asset.years}</bdi> שנים שלמות · מקדם{" "}
                <bdi className="tabular">{asset.factor}</bdi>
              </span>
              <bdi className="tabular">{format(asset.recorded)}</bdi>
              <span className="text-stone-400" aria-hidden="true">
                →
              </span>
              <bdi className="tabular font-medium">{format(asset.appreciated)}</bdi>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- ריכוזיות --------------------------------------------------------------------

function ConcentrationPanel({ concentration }: { concentration: Concentration }) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">
          ריכוזיות — <bdi>Apple RSU</bdi>
        </h2>
        <Link href="/settings" className="text-sm text-stone-600 underline-offset-4 hover:underline">
          בחירת החשבונות
        </Link>
      </div>

      {concentration.readings.length === 0 ? (
        <p className="mt-3 text-sm text-stone-600">
          לא סומן אף חשבון כ־<bdi>Apple RSU</bdi>, ולכן אין מה למדוד. זה אינו אפס — זו העדר בחירה.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <div>
              <p className="text-xs text-stone-500">שווי ההחזקה</p>
              <bdi className="tabular block text-2xl font-semibold">{format(concentration.holding)}</bdi>
            </div>
            <div>
              <p className="text-xs text-stone-500">מתוך סך ההון</p>
              <bdi className="tabular block text-2xl">{format(concentration.total)}</bdi>
            </div>
            <div>
              <p className="text-xs text-stone-500">חלק מההון</p>
              <span className="tabular block text-3xl font-semibold">
                <Share share={concentration.share} />
              </span>
            </div>
          </div>

          <ul className="mt-3 divide-y divide-stone-100 border-t border-stone-200">
            {concentration.readings.map((reading) => (
              <li key={reading.account.id} className="flex flex-wrap items-baseline gap-x-4 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <bdi>{reading.account.name}</bdi>
                </span>
                <bdi className="tabular text-stone-500">{format(reading.native)}</bdi>
                <bdi className="tabular font-medium">{format(reading.converted)}</bdi>
              </li>
            ))}
          </ul>
        </>
      )}

      {concentration.missing.length === 0 ? null : (
        <p className="mt-3 text-sm text-amber-800">
          <bdi className="tabular">{concentration.missing.length}</bdi> חשבונות שסומנו למעקב אינם בצילום
          הזה, ולכן אינם נספרים בו — הם לא נקראים כאפס.
        </p>
      )}
    </section>
  );
}

// --- shared ---------------------------------------------------------------------

/** A share of nothing is not 0% — it has no percentage at all, and the screen says so. */
function Share({ share }: { share: number | null }) {
  if (share === null) return <span className="text-stone-400">—</span>;
  return <bdi className="tabular">{PERCENT.format(share)}</bdi>;
}

function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן לקרוא את השווי נטו</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}
