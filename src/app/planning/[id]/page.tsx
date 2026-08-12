import Link from "next/link";
import { notFound } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { loadAccounts } from "@/db/accounts";
import { loadCategories } from "@/db/categories";
import { DatabaseNotConfiguredError } from "@/db/client";
import { loadEarmarks } from "@/db/holdings";
import { loadLedger } from "@/db/ledger";
import { type DatedRate, findLatestRate } from "@/db/money-settings";
import { type Person, findPersonByEmail } from "@/db/people";
import { loadFundingPlans, loadPlannedSources, loadScenarios } from "@/db/planning";
import { loadSnapshots } from "@/db/snapshots";
import { type Currency, type Money, equals, format, subtract, toDecimalString } from "@/domain/money/money";
import {
  type PlannedSource,
  type SavingPace,
  type ScenarioReading,
  findScenario,
  readScenario,
} from "@/domain/planning/scenarios";
import { freeLiquid } from "@/domain/snapshot/holdings";
import { type CalendarDate, dateKey, dateOf, formatDate, monthContaining } from "@/domain/time/calendar-date";
import { compareMonths, formatMonth } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { addSource, editScenario, removeScenario, removeSource, savePlan } from "../actions";
import {
  Field,
  Figure,
  Notices,
  PacePanel,
  RateFigure,
  Select,
  UnavailablePanel,
  closureReason,
  currentPace,
  formatRate,
  monthsText,
} from "../panels";

export const dynamic = "force-dynamic";

/**
 * One scenario: what it needs, where the money would come from, what is missing, and
 * how long saving takes to close it.
 *
 * Nothing on this page is stored except the plan and its sources. The gap is
 * `needs − Σ(sources)` on every read and the months are that gap over the מאזן's own
 * חיסכון, so there is no figure here that can go stale while the reader is looking at
 * it — and no figure here that writes back into anything recorded.
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

export default async function ScenarioPage({
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
        title={loaded.kind === "ok" ? loaded.reading.scenario.name : "תרחיש"}
        subtitle="תרחיש — נקרא מהמספרים האמיתיים, ואינו כותב אליהם דבר"
        back={{ href: "/planning", label: "חזרה ללוח התכנון" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <Notices error={first(query.error)} detail={first(query.detail)} done={first(query.done)} />

        {loaded.kind === "ok" ? (
          <>
            <GapPanel reading={loaded.reading} rate={loaded.rate} />
            <SourcesPanel
              reading={loaded.reading}
              currentFreeLiquid={loaded.currentFreeLiquid}
              measuredOn={loaded.measuredOn}
            />
            <PlanPanel reading={loaded.reading} />
            <PacePanel pace={loaded.pace} />
            <DefinitionPanel reading={loaded.reading} />
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
      reading: ScenarioReading;
      pace: SavingPace;
      rate: DatedRate | null;
      /** Free liquid money as the latest מיפוי reads it now, for holding a seeded line against. */
      currentFreeLiquid: Money | null;
      measuredOn: CalendarDate | null;
    }
  | { kind: "missing" }
  | { kind: "unavailable"; reason: string };

async function loadPage(email: string, id: string): Promise<Loaded> {
  try {
    const scenarios = await loadScenarios();
    const scenario = findScenario(scenarios, id);
    if (scenario === undefined) return { kind: "missing" };

    const [person, plans, sources, ledger, categories, rate, snapshots, accounts, earmarks] =
      await Promise.all([
        findPersonByEmail(email),
        loadFundingPlans(),
        loadPlannedSources(),
        loadLedger(),
        loadCategories(),
        findLatestRate("USD", "ILS"),
        loadSnapshots(),
        loadAccounts(),
        loadEarmarks(),
      ]);

    const pace = currentPace(ledger, categories);
    // Newest first out of the database. A figure that cannot be read is absent
    // rather than approximated: the seeded line then simply states its own date.
    const snapshot = snapshots[0] ?? null;
    let currentFreeLiquid: Money | null = null;
    if (snapshot !== null) {
      try {
        currentFreeLiquid = freeLiquid({ snapshot, accounts, earmarks, currency: "ILS" }).free;
      } catch {
        currentFreeLiquid = null;
      }
    }

    return {
      kind: "ok",
      person,
      reading: readScenario({ scenario, plans, sources, pace, rate }),
      pace,
      rate,
      currentFreeLiquid,
      measuredOn: snapshot?.takenOn ?? null,
    };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- the gap, and how long it takes to close ----------------------------------

function GapPanel({ reading, rate }: { reading: ScenarioReading; rate: DatedRate | null }) {
  const { plan, gap, closure } = reading;

  if (plan === null || gap === null) {
    return (
      <section className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 sm:p-6">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">פער המימון</h2>
        <p className="mt-2 text-sm text-stone-600">
          עדיין לא נרשם מה ההשקעה דורשת, ולכן אין פער. תרחיש בלי תוכנית מימון הוא שם ומחשבה — מצב
          תקין לחלוטין, ולא חסר.
        </p>
      </section>
    );
  }

  const neededByMonth = monthContaining(plan.neededBy);
  const closesIn = closure?.closesIn ?? null;
  const inTime = closesIn === null ? null : compareMonths(closesIn, neededByMonth) <= 0;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">פער המימון</h2>

      <dl className="mt-3 grid gap-4 sm:grid-cols-3">
        <Figure label="ההשקעה דורשת" amount={format(gap.needs)} note={`עד ${formatDate(plan.neededBy)}`} />
        <Figure
          label="מכוסה ממקורות"
          amount={format(gap.covered)}
          note={
            gap.rate === null
              ? "סכום המקורות"
              : `כולל המרה בשער ${formatRate(gap.rate.rate)}${
                  rate === null ? "" : ` מ־${formatDate(dateOf(rate.asOf))}`
                }`
          }
        />
        <Figure
          label={gap.surplus === null ? "חסר" : "מעל הדרוש"}
          amount={format(gap.surplus ?? gap.gap)}
          note={
            gap.surplus === null
              ? "דרוש פחות מכוסה, מחושב בכל קריאה"
              : "מכוסה פחות דרוש, מחושב בכל קריאה"
          }
          emphasis
        />
      </dl>

      {gap.unreadable.length === 0 ? null : (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          המקורות{" "}
          <bdi>{gap.unreadable.map((line) => line.source).join(", ")}</bdi> רשומים במטבע אחר ואין שער
          שמור להמיר בו, ולכן אינם נספרים במכוסה. הפער שלמעלה הוא לכל היותר מה שמכוסה — לא סכום
          שהומר בשער שאיש לא נקב בו.
        </p>
      )}

      <div className="mt-4 border-t border-stone-200 pt-4">
        <h3 className="text-sm font-semibold tracking-wide text-stone-500">בעוד כמה חודשים</h3>

        {closure === null ? null : closure.basis === "already-covered" ? (
          <p className="mt-2 text-lg font-medium">{monthsText(0)}.</p>
        ) : closure.months === null ? (
          <p className="mt-2 text-sm text-stone-600">{closureReason(closure.basis)}</p>
        ) : (
          <>
            <p className="mt-2 text-3xl font-semibold">
              {closure.months}
              <span className="text-base font-normal text-stone-500">
                {" "}
                {closure.months === 1 ? "חודש" : "חודשים"}
              </span>
            </p>
            <p className="mt-1 text-sm text-stone-600">
              <bdi className="tabular">{format(closure.gap)}</bdi> חלקי{" "}
              <bdi className="tabular">{format(closure.monthly ?? closure.gap)}</bdi> לחודש, על פני{" "}
              <bdi className="tabular">{closure.denominator}</bdi>{" "}
              {closure.denominator === 1 ? "חודש שנרשם" : "חודשים שנרשמו"}, מעוגל למעלה: חיסכון מגיע
              בחודשים שלמים, וחודש חלקי אינו סוגר כלום.
              {closure.rate === null ? null : (
                <>
                  {" "}
                  החיסכון הומר לפער בשער <RateFigure rate={closure.rate.rate} />
                  {rate === null ? null : <> מ־{formatDate(dateOf(rate.asOf))}</>}.
                </>
              )}
            </p>

            {closesIn === null ? null : (
              <p
                className={`mt-3 rounded-md border p-3 text-sm ${
                  inTime === true
                    ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                    : "border-amber-300 bg-amber-50 text-amber-900"
                }`}
              >
                בקצב הזה הפער נסגר ב{formatMonth(closesIn)}, וההשקעה נדרשת עד{" "}
                {formatDate(plan.neededBy)} —{" "}
                {inTime === true ? "כלומר בזמן." : "כלומר באיחור, ובקצב הזה לא נספיק."}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// --- the planned sources ------------------------------------------------------

function SourcesPanel({
  reading,
  currentFreeLiquid,
  measuredOn,
}: {
  reading: ScenarioReading;
  currentFreeLiquid: Money | null;
  measuredOn: CalendarDate | null;
}) {
  const { scenario, sources, gap } = reading;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">מקורות המימון המתוכננים</h2>
      <p className="mt-1 text-sm text-stone-600">
        כל מקור שיכסה חלק מההשקעה — אותם עובדות של רגל מימון, בזמן עתיד. אין כאן שער ואין תאריך
        תשלום: המרה עתידית עדיין אין לה שער, ושער שהיה נרשם לפני שהכסף זז היה מספר שאיש לא השתמש בו.
        השערים האמיתיים מגיעים כשהתוכנית מבוצעת והשורות האלה הופכות לרגלי מימון.
      </p>

      {sources.length === 0 ? (
        <p className="mt-3 text-sm text-stone-500">עדיין לא נרשמו מקורות.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-xs text-stone-500">
                <th className="py-2 text-start font-medium">מקור</th>
                <th className="py-2 text-end font-medium">סכום</th>
                <th className="py-2 text-end font-medium">במטבע התוכנית</th>
                <th className="py-2 text-start font-medium">מאיפה המספר</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {sources.map((line) => (
                <SourceRow
                  key={line.id}
                  line={line}
                  scenarioId={scenario.id}
                  inPlanCurrency={
                    gap?.sources.find((covering) => covering.source.id === line.id)?.inPlanCurrency ??
                    null
                  }
                  hasPlan={gap !== null}
                  currentFreeLiquid={currentFreeLiquid}
                  measuredOn={measuredOn}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form action={addSource} className="mt-4 grid gap-3 border-t border-stone-200 pt-4 sm:grid-cols-4">
        <input type="hidden" name="scenarioId" value={scenario.id} />

        <Field label="מקור">
          <input
            name="source"
            required
            maxLength={60}
            placeholder="Apple RSU"
            className="w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <Field label="סכום">
          <input
            name="amount"
            required
            inputMode="decimal"
            dir="ltr"
            className="tabular w-full rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </Field>

        <Field label="מטבע">
          <Select name="currency" defaultValue={reading.plan?.needs.currency ?? "ILS"}>
            {CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex items-end">
          <button
            type="submit"
            className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium hover:bg-stone-50"
          >
            הוספת מקור
          </button>
        </div>
      </form>
    </section>
  );
}

function SourceRow({
  line,
  scenarioId,
  inPlanCurrency,
  hasPlan,
  currentFreeLiquid,
  measuredOn,
}: {
  line: PlannedSource;
  scenarioId: string;
  inPlanCurrency: Money | null;
  /** Without a plan there is no plan currency, which is not the same as a missing rate. */
  hasPlan: boolean;
  currentFreeLiquid: Money | null;
  measuredOn: CalendarDate | null;
}) {
  const converted = inPlanCurrency === null || equals(inPlanCurrency, line.amount) ? null : inPlanCurrency;

  return (
    <tr>
      <td className="py-2">
        <bdi>{line.source}</bdi>
      </td>
      <td className="tabular py-2 text-end">
        <bdi>{format(line.amount)}</bdi>
      </td>
      <td className="tabular py-2 text-end">
        {!hasPlan ? (
          <span className="text-stone-400">—</span>
        ) : inPlanCurrency === null ? (
          <span className="text-amber-800">אין שער</span>
        ) : (
          <bdi>{format(converted ?? line.amount)}</bdi>
        )}
      </td>
      <td className="py-2 text-xs text-stone-600">
        {line.origin.kind === "stated" ? (
          "הוקלד"
        ) : (
          <>
            נזרע מהמיפוי של {formatDate(line.origin.asOf)}
            <SeedDrift line={line} current={currentFreeLiquid} measuredOn={measuredOn} />
          </>
        )}
      </td>
      <td className="py-2 text-end">
        <form action={removeSource}>
          <input type="hidden" name="scenarioId" value={scenarioId} />
          <input type="hidden" name="sourceId" value={line.id} />
          <button
            type="submit"
            className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-50"
          >
            הסרה
          </button>
        </form>
      </td>
    </tr>
  );
}

/**
 * A seeded figure held against what the same figure reads now.
 *
 * The seeded amount is never rewritten behind the reader: a plan is a what-if, and
 * silently moving one of its numbers because מיפוי moved would change a decision
 * somebody already made. So the drift is *stated* and the correction is a person's
 * to make — the same rule the project cost and the RSU line in מיפוי follow.
 */
function SeedDrift({
  line,
  current,
  measuredOn,
}: {
  line: PlannedSource;
  current: Money | null;
  measuredOn: CalendarDate | null;
}) {
  if (line.origin.kind !== "seeded" || current === null || measuredOn === null) return null;
  if (current.currency !== line.amount.currency) return null;
  if (equals(current, line.amount)) {
    return <span className="text-stone-500"> — וכך הוא נקרא גם עכשיו.</span>;
  }

  return (
    <span className="text-amber-800">
      {" "}
      — עכשיו הוא נקרא <bdi className="tabular">{format(current)}</bdi> (מיפוי של{" "}
      {formatDate(measuredOn)}), הפרש של{" "}
      <bdi className="tabular">{format(subtract(current, line.amount))}</bdi>. השורה כאן לא נכתבת
      מחדש מעצמה.
    </span>
  );
}

// --- what the investment needs ------------------------------------------------

function PlanPanel({ reading }: { reading: ScenarioReading }) {
  const { scenario, plan } = reading;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">תוכנית המימון</h2>
      <p className="mt-1 text-sm text-stone-600">
        מה ההשקעה העתידית דורשת, ומתי. זו כוונה של משק הבית ולא מדידה, ולכן היא מוקלדת — לעומת
        המקורות, שנזרעים ממה שרשום.
      </p>

      <form action={savePlan} className="mt-4 grid gap-4 sm:grid-cols-3">
        <input type="hidden" name="scenarioId" value={scenario.id} />

        <Field label="ההשקעה דורשת">
          <input
            name="needs"
            required
            inputMode="decimal"
            dir="ltr"
            defaultValue={plan === null ? "" : toDecimalString(plan.needs)}
            className="tabular w-full rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </Field>

        <Field label="מטבע">
          <Select name="currency" defaultValue={plan?.needs.currency ?? "USD"}>
            {CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="נדרש עד">
          <input
            type="date"
            name="neededBy"
            required
            defaultValue={dateKey(plan?.neededBy ?? dateOf(new Date()))}
            className="w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <div className="sm:col-span-3">
          <button
            type="submit"
            className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium hover:bg-stone-50"
          >
            שמירת תוכנית המימון
          </button>
        </div>
      </form>
    </section>
  );
}

// --- the scenario itself ------------------------------------------------------

function DefinitionPanel({ reading }: { reading: ScenarioReading }) {
  const { scenario } = reading;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">הגדרת התרחיש</h2>

      <form action={editScenario} className="mt-4 grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="scenarioId" value={scenario.id} />

        <Field label="שם התרחיש">
          <input
            name="name"
            defaultValue={scenario.name}
            required
            maxLength={80}
            className="w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <Field label="הערה">
          <input
            name="note"
            defaultValue={scenario.note ?? ""}
            maxLength={400}
            className="w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
          >
            שמירה
          </button>
        </div>
      </form>

      <form action={removeScenario} className="mt-4 border-t border-stone-200 pt-4">
        <input type="hidden" name="scenarioId" value={scenario.id} />
        <button
          type="submit"
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-stone-50"
        >
          הסרת התרחיש
        </button>
        <p className="mt-2 text-xs text-stone-500">
          הסרת תרחיש מוחקת מחשבה ולא עובדה: נמחקים התרחיש, תוכנית המימון שלו והמקורות המתוכננים
          שלו, ושום רישום, צילום, חשבון או פרוייקט אינו נגיש מכאן כדי להימחק איתם.{" "}
          <Link href="/projects" className="underline underline-offset-4">
            הפרוייקטים עצמם
          </Link>
        </p>
      </form>
    </section>
  );
}
