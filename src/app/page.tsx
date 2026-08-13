import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { MoneyFigure } from "@/components/money-figure";
import { loadAccounts } from "@/db/accounts";
import { loadCategories } from "@/db/categories";
import { DatabaseNotConfiguredError } from "@/db/client";
import { loadLedger } from "@/db/ledger";
import { type DatedRate, type StoredAmount, findLatestRate, findStoredAmount } from "@/db/money-settings";
import { findPersonByEmail } from "@/db/people";
import {
  loadAllocations,
  loadFundingPlans,
  loadPlannedSources,
  loadScenarios,
} from "@/db/planning";
import { loadHouseholdSettings } from "@/db/settings";
import { loadSnapshots } from "@/db/snapshots";
import { format, isNegative, negate } from "@/domain/money/money";
import {
  type Reconciliation,
  decomposeChange,
  reconcileMoneyAdded,
} from "@/domain/networth/net-worth-analytics";
import { type AllocationPlan, projectAllocations } from "@/domain/planning/allocations";
import {
  type Scenario,
  type ScenarioReading,
  activeScenario,
  readScenario,
} from "@/domain/planning/scenarios";
import {
  type Account,
  type Snapshot,
  canConvertWithin,
  snapshotReadings,
} from "@/domain/snapshot/snapshot";
import { formatDate, monthContaining } from "@/domain/time/calendar-date";
import { compareMonths, formatMonth, monthOf } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { currentPace } from "./planning/panels";

// Reads a live database on every request; nothing here is prerendered at build.
export const dynamic = "force-dynamic";

/** Every area of the system, each one now built and reachable. */
const AREAS = [
  { title: "מאזן הכנסות-הוצאות", note: "רישום חודשי, קטגוריות, מגמות", href: "/balance" },
  { title: "מיפוי", note: "צילום מלא של כל החשבונות", href: "/snapshots" },
  { title: "שווי נטו", note: "מסלול, חשיפה למט״ח, הקצאה", href: "/net-worth" },
  { title: "נכסים ופרוייקטים", note: "רגלי מימון, הוצאות, יתרה", href: "/projects" },
  { title: "מחשבון RSU", note: "מניות לפני ואחרי התקופה, מס", href: "/rsu" },
  { title: "לוח תכנון", note: "תרחישים, פער מימון, בעוד כמה חודשים", href: "/planning" },
  { title: "סיכום שנתי", note: "היכן הסתיימה השנה", href: "/annual" },
  { title: "הגדרות", note: "הנחות ויעדים של משק הבית", href: "/settings" },
] as const;

export default async function DashboardPage() {
  const email = await requireHouseholdEmail();
  const person = await findPersonByEmail(email).catch(() => null);

  const tracer = await readTracerAmount();
  const reconciliation = await readReconciliation();
  const activePlan = await readActivePlan();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={person}
        title="Jubot"
        subtitle="לוח מחוונים פיננסי של משק הבית"
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        {reconciliation === null ? null : <ReconciliationBanner reconciliation={reconciliation} />}
        {activePlan === null ? null : <ActivePlanBanner plan={activePlan} />}

        <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
          <h2 className="text-sm font-semibold tracking-wide text-stone-500">סכום לדוגמה מהמסד</h2>

          {tracer.kind === "ok" ? (
            <div className="mt-3">
              <p className="text-base font-medium text-stone-700">{tracer.amount.labelHe}</p>
              <div className="mt-2">
                <MoneyFigure amount={tracer.amount.amount} rate={tracer.rate} />
              </div>
              <p className="mt-4 text-sm text-stone-500">
                נשמר כ־
                <bdi className="tabular">{tracer.amount.amount.minorUnits.toLocaleString("he-IL")}</bdi>{" "}
                יחידות מִשְׁנֶה שלמות עם קוד מטבע <bdi>{tracer.amount.amount.currency}</bdi>
              </p>
            </div>
          ) : (
            <UnavailablePanel reason={tracer.reason} />
          )}
        </section>

        <section aria-labelledby="areas-heading">
          <h2 id="areas-heading" className="text-sm font-semibold tracking-wide text-stone-500">
            אזורים
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {AREAS.map((area) => (
              <li key={area.title}>
                <Link
                  href={area.href}
                  className="block h-full rounded-lg border border-stone-300 bg-white p-4 hover:bg-stone-50"
                >
                  <p className="font-medium text-stone-900">{area.title}</p>
                  <p className="mt-1 text-sm text-stone-500">{area.note}</p>
                  <p className="mt-2 text-xs font-medium tracking-wide text-stone-600">פתיחה ←</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

// --- the plan the household says it is following ------------------------------

interface ActivePlanReading {
  readonly scenario: Scenario;
  readonly reading: ScenarioReading;
  readonly allocations: AllocationPlan | null;
}

/**
 * The one scenario marked as the plan being followed, and the household measured
 * against it.
 *
 * A plan nobody is held to is a thought. This is where the holding happens: the
 * gap it still has, whether saving closes it before the date it is needed by, and —
 * where the plan allocates its saving across goals — whether the household is
 * actually saving what it promised. Every figure is computed on read out of the
 * same functions the לוח תכנון screens use, so the dashboard cannot disagree with
 * the scenario's own page.
 *
 * Marking none is a legitimate state, and it is silence here rather than a panel
 * asking to be filled in.
 */
async function readActivePlan(): Promise<ActivePlanReading | null> {
  try {
    const scenarios = await loadScenarios();
    const scenario = activeScenario(scenarios);
    if (scenario === null) return null;

    const [plans, sources, ledger, categories, rate, allocations] = await Promise.all([
      loadFundingPlans(),
      loadPlannedSources(),
      loadLedger(),
      loadCategories(),
      findLatestRate("USD", "ILS"),
      loadAllocations(),
    ]);

    const pace = currentPace(ledger, categories);
    const own = allocations.filter((allocation) => allocation.scenarioId === scenario.id);

    return {
      scenario,
      reading: readScenario({ scenario, plans, sources, pace, rate }),
      allocations:
        own.length === 0
          ? null
          : projectAllocations({
              allocations: own,
              scenarioId: scenario.id,
              from: monthOf(new Date()),
              months: 12,
              pace: pace.monthly,
              rate,
            }),
    };
  } catch {
    return null;
  }
}

function ActivePlanBanner({ plan }: { plan: ActivePlanReading }) {
  const { reading, allocations } = plan;
  const { gap, closure } = reading;
  const neededBy = reading.plan === null ? null : monthContaining(reading.plan.neededBy);
  const closesIn = closure?.closesIn ?? null;
  const inTime =
    closesIn === null || neededBy === null ? null : compareMonths(closesIn, neededBy) <= 0;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">
          התוכנית שאחריה עוקבים
        </h2>
        <p className="text-sm">
          <Link
            href={`/planning/${plan.scenario.id}`}
            className="underline underline-offset-4 text-stone-700"
          >
            <bdi>{plan.scenario.name}</bdi> ←
          </Link>
        </p>
      </div>

      {gap === null || reading.plan === null ? (
        <p className="mt-2 text-sm text-stone-600">
          לתוכנית הזו עדיין לא נרשם מה ההשקעה דורשת, ולכן אין מול מה למדוד. זה מצב תקין — שם
          ומחשבה.
        </p>
      ) : (
        <>
          <dl className="mt-3 grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-stone-500">דרוש עד {formatDate(reading.plan.neededBy)}</dt>
              <dd className="tabular mt-1 text-lg">
                <bdi>{format(gap.needs)}</bdi>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-stone-500">מכוסה ממקורות</dt>
              <dd className="tabular mt-1 text-lg">
                <bdi>{format(gap.covered)}</bdi>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-stone-500">{gap.closed ? "מעל הדרוש" : "חסר"}</dt>
              <dd className="tabular mt-1 text-xl font-semibold">
                <bdi>{format(gap.surplus ?? gap.gap)}</bdi>
              </dd>
            </div>
          </dl>

          {closesIn === null || inTime === null ? null : (
            <p
              className={`mt-3 rounded-md border p-3 text-sm ${
                inTime
                  ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                  : "border-amber-300 bg-amber-50 text-amber-900"
              }`}
              role={inTime ? "status" : "alert"}
            >
              בקצב החיסכון הנוכחי הפער נסגר ב{formatMonth(closesIn)}, וההשקעה נדרשת עד{" "}
              {formatDate(reading.plan.neededBy)} — {inTime ? "כלומר בזמן." : "כלומר באיחור."}
            </p>
          )}
        </>
      )}

      {allocations === null || allocations.paceStanding !== "computed" || allocations.pace === null ? null : (
        <p
          className={`mt-3 text-sm ${allocations.over === null ? "text-stone-600" : "text-amber-900"}`}
        >
          התוכנית מקצה <bdi className="tabular">{format(allocations.committed)}</bdi> בחודש בין{" "}
          {allocations.goals.length === 1 ? "ייעוד אחד" : `${allocations.goals.length} ייעודים`},
          והמאזן אומר שנחסכים <bdi className="tabular">{format(allocations.pace)}</bdi>
          {allocations.over === null ? (
            <> — כלומר ההקצאות מכוסות.</>
          ) : (
            <>
              {" "}
              — כלומר <bdi className="tabular font-medium">{format(allocations.over)}</bdi> יותר
              ממה שיש.
            </>
          )}
        </p>
      )}
    </section>
  );
}

// --- the reconciliation, where it will be seen --------------------------------

/**
 * The מאזן and the מיפוי, held against each other on the way in. A discrepancy
 * that only appears on a detail screen is a discrepancy nobody finds, so the two
 * latest readings are reconciled here — and the panel says just as plainly when
 * they agree, because a check that is only visible when it fails teaches nobody
 * that it is running.
 */
function ReconciliationBanner({ reconciliation }: { reconciliation: Reconciliation }) {
  const { residual } = reconciliation;
  if (residual === null) return null;

  return (
    <section
      className={`rounded-lg border p-5 ${
        reconciliation.holds ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"
      }`}
      role={reconciliation.holds ? "status" : "alert"}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2
          className={`text-sm font-semibold tracking-wide ${reconciliation.holds ? "text-emerald-900" : "text-amber-900"}`}
        >
          התאמה מול המאזן
        </h2>
        <p className={`text-xs ${reconciliation.holds ? "text-emerald-800" : "text-amber-800"}`}>
          {formatDate(reconciliation.from)} — {formatDate(reconciliation.to)}
        </p>
      </div>

      <p className={`mt-2 text-sm ${reconciliation.holds ? "text-emerald-900" : "text-amber-900"}`}>
        {reconciliation.holds ? (
          <>
            מה שהגיע לחשבונות הוא בדיוק החיסכון שהמאזן רשם —{" "}
            <bdi className="tabular font-medium">{format(reconciliation.moneyAdded)}</bdi>.
          </>
        ) : (
          <>
            פער של{" "}
            <bdi className="tabular font-medium">
              {format(isNegative(residual) ? negate(residual) : residual)}
            </bdi>{" "}
            בין מה שהגיע לחשבונות (
            <bdi className="tabular">{format(reconciliation.moneyAdded)}</bdi>) לבין החיסכון שבמאזן
            (<bdi className="tabular">{format(reconciliation.saving ?? residual)}</bdi>).
          </>
        )}
      </p>

      <p className="mt-2 text-sm">
        <Link
          href="/net-worth"
          className={`underline underline-offset-4 ${reconciliation.holds ? "text-emerald-900" : "text-amber-900"}`}
        >
          פירוק השינוי ←
        </Link>
      </p>
    </section>
  );
}

/**
 * The latest reading, reconciled against the nearest earlier one the מאזן can
 * answer for.
 *
 * The מאזן records months, so two readings ten days apart have no month to be
 * compared against. Walking back to the nearest reading that does leaves the check
 * running whatever cadence the household takes snapshots at — the panel names the
 * period it used, so the figure is never ambiguous about what it covers.
 *
 * Anything missing — one reading, a reading with no rate, no whole month anywhere
 * in the history — is silence rather than a panel.
 */
async function readReconciliation(): Promise<Reconciliation | null> {
  try {
    const [accounts, snapshots, settings, ledger, categories] = await Promise.all([
      loadAccounts(),
      loadSnapshots(),
      loadHouseholdSettings(),
      loadLedger(),
      loadCategories(),
    ]);

    // Newest first out of the database, so the candidates run nearest first.
    const later = snapshots[0];
    if (later === undefined || !restatable(later, accounts)) return null;

    for (const earlier of snapshots.slice(1)) {
      if (!restatable(earlier, accounts)) continue;

      const reconciliation = reconcileMoneyAdded({
        decomposition: decomposeChange({
          earlier,
          later,
          accounts,
          marketMovingAccountIds: settings.marketMovingAccountIds,
          currency: "ILS",
        }),
        ledger,
        categories,
      });

      if (reconciliation.residual !== null) return reconciliation;
    }

    return null;
  } catch {
    // The tracer panel below already reports a database that cannot be read; this
    // one has nothing of its own to add.
    return null;
  }
}

function restatable(snapshot: Snapshot, accounts: readonly Account[]): boolean {
  return snapshotReadings(snapshot, accounts).every((reading) =>
    canConvertWithin(snapshot, reading.account.currency, "ILS"),
  );
}

function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן לקרוא את הסכום מהמסד</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}

type TracerRead =
  | { kind: "ok"; amount: StoredAmount; rate: DatedRate | null }
  | { kind: "unavailable"; reason: string };

async function readTracerAmount(): Promise<TracerRead> {
  try {
    const amount = await findStoredAmount("cgm1_usd_funding_leg");
    if (amount === null) {
      return { kind: "unavailable", reason: "המסד מחובר אך אין בו שורה בשם cgm1_usd_funding_leg. יש להריץ את db/seed.sql." };
    }
    const rate = amount.amount.currency === "ILS" ? null : await findLatestRate(amount.amount.currency, "ILS");
    return { kind: "ok", amount, rate };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}
