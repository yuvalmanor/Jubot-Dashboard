import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { loadCategories } from "@/db/categories";
import { DatabaseNotConfiguredError } from "@/db/client";
import { loadLedger } from "@/db/ledger";
import { findLatestRate } from "@/db/money-settings";
import { type Person, findPersonByEmail } from "@/db/people";
import {
  loadAllocations,
  loadFundingPlans,
  loadPatterns,
  loadPlannedSources,
  loadScenarioTerms,
  loadScenarios,
} from "@/db/planning";
import { loadDealTerms, loadProjects } from "@/db/projects";
import { format } from "@/domain/money/money";
import { projectAllocations } from "@/domain/planning/allocations";
import {
  type ComparableScenario,
  type ComparisonKey,
  type ComparisonRow,
  type ScenarioComparison,
  compareScenarios,
} from "@/domain/planning/comparison";
import { effectiveTerms, patternFor, projectPattern } from "@/domain/planning/patterns";
import {
  type Scenario,
  findScenario,
  readInto,
  readScenario,
  scenariosInReadingOrder,
} from "@/domain/planning/scenarios";
import { formatMonth, monthOf } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { Select, UnavailablePanel, currentPace, monthsCount } from "../panels";
import { ALLOCATION_HORIZON_MONTHS } from "../[id]/scenario-panels";

export const dynamic = "force-dynamic";

/**
 * שני תרחישים זה מול זה — "Meteor או עוד CGM" כהשוואה ולא כתחושה.
 *
 * Every figure here is one each scenario already shows on its own page, read
 * through the same functions, so a scenario cannot say one thing alone and another
 * beside its rival. A difference is stated only where the two are the same question:
 * a dollar plan against a shekel plan has none, and the screen says so rather than
 * subtracting two numbers that are not comparable.
 */

const LABELS: Record<ComparisonKey, string> = {
  needs: "ההשקעה דורשת",
  covered: "מכוסה ממקורות",
  gap: "פער המימון",
  "months-to-close": "חודשי חיסכון לסגירת הפער",
  "closes-in": "הפער נסגר ב",
  "allocated-monthly": "מוקצה מהחיסכון לחודש",
  "pattern-commitment": "סך ההתחייבות של הדפוס החוזר",
  "pattern-funded": "השקעות בדפוס שממומנות",
};

interface SearchParams {
  a?: string | string[];
  b?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const email = await requireHouseholdEmail();
  const query = await searchParams;
  const loaded = await loadPage(email, first(query.a), first(query.b));

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="השוואת תרחישים"
        subtitle="שני מה־אם זה מול זה — אותם מספרים שכל אחד מהם מציג לבדו"
        back={{ href: "/planning", label: "חזרה ללוח התכנון" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        {loaded.kind === "ok" ? (
          <>
            <Picker scenarios={loaded.scenarios} left={loaded.leftId} right={loaded.rightId} />
            {loaded.comparison === null ? (
              <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
                {loaded.scenarios.length < 2
                  ? "צריך שני תרחישים כדי להשוות. תרחיש אחד לבדו הוא מחשבה, ולא בחירה בין שתיים."
                  : "יש לבחור שני תרחישים שונים."}
              </p>
            ) : (
              <ComparisonTable comparison={loaded.comparison} />
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
      person: Person | null;
      scenarios: readonly Scenario[];
      leftId: string | null;
      rightId: string | null;
      comparison: ScenarioComparison | null;
    }
  | { kind: "unavailable"; reason: string };

async function loadPage(
  email: string,
  a: string | undefined,
  b: string | undefined,
): Promise<Loaded> {
  try {
    const [
      person,
      scenarios,
      plans,
      sources,
      ledger,
      categories,
      rate,
      allocations,
      patterns,
      overrides,
      projects,
      dealTerms,
    ] = await Promise.all([
      findPersonByEmail(email),
      loadScenarios(),
      loadFundingPlans(),
      loadPlannedSources(),
      loadLedger(),
      loadCategories(),
      findLatestRate("USD", "ILS"),
      loadAllocations(),
      loadPatterns(),
      loadScenarioTerms(),
      loadProjects(),
      loadDealTerms(),
    ]);

    const ordered = scenariosInReadingOrder(scenarios);
    // Two named ones, or the two most recent — a comparison screen reached with no
    // arguments should still be a comparison.
    const leftId = a ?? ordered[0]?.id ?? null;
    const rightId = b ?? ordered[1]?.id ?? null;

    const pace = currentPace(ledger, categories);
    const from = monthOf(new Date());

    function assemble(id: string | null): ComparableScenario | null {
      const scenario = id === null ? undefined : findScenario(scenarios, id);
      if (scenario === undefined) return null;

      const reading = readScenario({ scenario, plans, sources, pace, rate });
      const own = allocations.filter((allocation) => allocation.scenarioId === scenario.id);
      const pattern = patternFor(patterns, scenario.id);
      const terms =
        pattern === null || pattern.modelledOn === null
          ? null
          : effectiveTerms({
              scenarioId: scenario.id,
              projectId: pattern.modelledOn,
              recorded: dealTerms,
              overrides,
            });

      return {
        reading,
        allocations:
          own.length === 0
            ? null
            : projectAllocations({
                allocations: own,
                scenarioId: scenario.id,
                from,
                months: ALLOCATION_HORIZON_MONTHS,
                pace: pace.monthly,
                rate,
              }),
        pattern:
          pattern === null
            ? null
            : projectPattern({
                pattern,
                terms,
                from,
                monthly:
                  pace.monthly === null ? null : readInto(pace.monthly, pattern.amount.currency, rate),
                opening:
                  reading.gap === null
                    ? null
                    : readInto(reading.gap.covered, pattern.amount.currency, rate),
              }),
      };
    }

    const left = assemble(leftId);
    const right = assemble(rightId);

    return {
      kind: "ok",
      person,
      scenarios: ordered,
      leftId,
      rightId,
      comparison:
        left === null || right === null || leftId === rightId
          ? null
          : compareScenarios(left, right),
    };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- choosing the two ---------------------------------------------------------

function Picker({
  scenarios,
  left,
  right,
}: {
  scenarios: readonly Scenario[];
  left: string | null;
  right: string | null;
}) {
  return (
    <form method="get" className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">איזה מול איזה</h2>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="block text-sm font-medium text-stone-700">תרחיש א׳</span>
          <span className="mt-1 block">
            <Select name="a" defaultValue={left ?? ""}>
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.name}
                </option>
              ))}
            </Select>
          </span>
        </label>

        <label className="block">
          <span className="block text-sm font-medium text-stone-700">תרחיש ב׳</span>
          <span className="mt-1 block">
            <Select name="b" defaultValue={right ?? ""}>
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.name}
                </option>
              ))}
            </Select>
          </span>
        </label>

        <div className="flex items-end">
          <button
            type="submit"
            className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium hover:bg-stone-50"
          >
            השוואה
          </button>
        </div>
      </div>
    </form>
  );
}

// --- the two, side by side -----------------------------------------------------

function ComparisonTable({ comparison }: { comparison: ScenarioComparison }) {
  const left = comparison.left.reading.scenario;
  const right = comparison.right.reading.scenario;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-b border-stone-200 text-xs text-stone-500">
              <th className="py-2 text-start font-medium" />
              <th className="py-2 text-end font-medium">
                <Link href={`/planning/${left.id}`} className="underline-offset-4 hover:underline">
                  <bdi>{left.name}</bdi>
                </Link>
                {left.active ? <span className="text-emerald-700"> · פעילה</span> : null}
              </th>
              <th className="py-2 text-end font-medium">
                <Link href={`/planning/${right.id}`} className="underline-offset-4 hover:underline">
                  <bdi>{right.name}</bdi>
                </Link>
                {right.active ? <span className="text-emerald-700"> · פעילה</span> : null}
              </th>
              <th className="py-2 text-end font-medium">הפרש</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {comparison.rows.map((row) => (
              <Row key={row.key} row={row} />
            ))}
          </tbody>
        </table>
      </div>

      {comparison.sameCurrency ? null : (
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          התוכניות של שני התרחישים אינן באותו מטבע
          {comparison.currencies.left === null || comparison.currencies.right === null
            ? " — לאחד מהם עדיין לא נרשם מה ההשקעה דורשת"
            : ` (${comparison.currencies.left} מול ${comparison.currencies.right})`}
          , ולכן שורות הכסף מציגות את שני המספרים בלי הפרש ביניהם. הפרש בין שני מטבעות הוא חיסור של
          שני דברים שאינם אותה שאלה.
        </p>
      )}

      <p className="mt-3 text-xs text-stone-500">
        ההפרש הוא תרחיש ב׳ פחות תרחיש א׳, והעמודה אומרת רק מי הקטן — לא מי הטוב. פחות חודשים זה טוב
        ודרישה קטנה יותר איננה טובה ולא רעה, וההחלטה הזו היא של מי שקורא.
      </p>
    </section>
  );
}

function Row({ row }: { row: ComparisonRow }) {
  return (
    <tr>
      <td className="py-2 text-stone-700">{LABELS[row.key]}</td>
      <td className="tabular py-2 text-end">
        <Cell row={row} side="left" />
      </td>
      <td className="tabular py-2 text-end">
        <Cell row={row} side="right" />
      </td>
      <td className="tabular py-2 text-end">
        {row.difference === null ? (
          <span className="text-xs text-stone-400">
            {row.left === null || row.right === null ? "—" : "מטבעות שונים"}
          </span>
        ) : row.kind === "money" ? (
          <bdi>{format(row.difference)}</bdi>
        ) : row.kind === "count" ? (
          <bdi>{row.difference > 0 ? `+${row.difference}` : row.difference}</bdi>
        ) : (
          <bdi>
            {row.difference === 0
              ? "אותו חודש"
              : `${row.difference > 0 ? "+" : "−"}${monthsCount(Math.abs(row.difference))}`}
          </bdi>
        )}
      </td>
    </tr>
  );
}

function Cell({ row, side }: { row: ComparisonRow; side: "left" | "right" }) {
  // The smaller of the two reads heavier. Which of them that is good news for
  // depends on the row, and the note under the table says so.
  const emphasis = row.smaller === side ? "font-medium" : "";
  const missing = <span className="text-stone-400">—</span>;

  switch (row.kind) {
    case "money": {
      const value = side === "left" ? row.left : row.right;
      return value === null ? missing : <bdi className={emphasis}>{format(value)}</bdi>;
    }
    case "count": {
      const value = side === "left" ? row.left : row.right;
      return value === null ? missing : <bdi className={emphasis}>{value}</bdi>;
    }
    default: {
      const value = side === "left" ? row.left : row.right;
      return value === null ? missing : <bdi className={emphasis}>{formatMonth(value)}</bdi>;
    }
  }
}
