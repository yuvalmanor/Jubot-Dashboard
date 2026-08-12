import Link from "next/link";

import { type DatedRate } from "@/db/money-settings";
import { type Currency, type Money, format, toDecimalString } from "@/domain/money/money";
import { type AllocationPlan, type SavingAllocation } from "@/domain/planning/allocations";
import { type ExecutionPreview, type PlanExecution } from "@/domain/planning/execution";
import {
  type EffectiveTerms,
  type InvestmentPattern,
  type PatternProjection,
} from "@/domain/planning/patterns";
import { type Scenario } from "@/domain/planning/scenarios";
import { type Project } from "@/domain/projects/projects";
import { dateKey, dateOf, formatDate } from "@/domain/time/calendar-date";
import { formatMonth } from "@/domain/time/calendar-month";

import {
  addAllocation,
  executePlan,
  markActivePlan,
  removeAllocation,
  removeInvestmentPattern,
  saveInvestmentPattern,
  saveTermsOverride,
} from "../actions";
import { Field, Figure, Select, formatBasisPoints, formatRate, monthsCount } from "../panels";

/**
 * The four panels Phase 16 adds to a scenario: where each month's saving is
 * promised, what a repeating pattern leads to, which deal terms it runs on, and
 * executing the plan into a real project.
 *
 * Only the last of those writes anything recorded, and it is the only one that
 * asks twice.
 */

const CURRENCIES: readonly Currency[] = ["ILS", "USD"];

/** Long enough to reach a household's targets, short enough to read. Stated on screen. */
export const ALLOCATION_HORIZON_MONTHS = 36;

const INPUT = "w-full rounded-md border border-stone-300 px-3 py-2";
const NUMBER = `tabular ${INPUT} text-end`;
const BUTTON = "rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium hover:bg-stone-50";
const PRIMARY =
  "rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800";

// --- the monthly saving allocations -------------------------------------------

export function AllocationsPanel({
  scenario,
  allocations,
  plan,
  currency,
}: {
  scenario: Scenario;
  allocations: readonly SavingAllocation[];
  plan: AllocationPlan | null;
  currency: Currency;
}) {
  // Milestones rather than every row: thirty-six lines of the same two numbers
  // teach nothing that four of them do not.
  const milestones =
    plan === null
      ? []
      : plan.months.filter(
          (_month, index) => (index + 1) % 6 === 0 || index === plan.months.length - 1,
        );

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">הקצאות חיסכון חודשיות</h2>
      <p className="mt-1 text-sm text-stone-600">
        לאן הולך החיסכון של כל חודש — 5,000 לקרן חירום ו־10,000 לנדל&quot;ן. כל ייעוד נצבר מהיום
        והלאה, בלי מה שכבר נצבר בו: מה שכבר יש נמדד במיפוי, וכאן נרשמת רק הכוונה קדימה.
      </p>

      {allocations.length === 0 ? (
        <p className="mt-3 text-sm text-stone-500">עדיין לא נרשמו הקצאות.</p>
      ) : (
        <>
          {plan === null ? null : <CommitmentAgainstPace plan={plan} />}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-xs text-stone-500">
                  <th className="py-2 text-start font-medium">ייעוד</th>
                  <th className="py-2 text-end font-medium">לחודש</th>
                  <th className="py-2 text-end font-medium">יעד</th>
                  <th className="py-2 text-start font-medium">
                    מתי מגיע ליעד · אחרי {monthsCount(ALLOCATION_HORIZON_MONTHS)}
                  </th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {(plan?.goals ?? []).map((outcome) => (
                  <tr key={outcome.allocation.id}>
                    <td className="py-2">
                      <bdi>{outcome.allocation.goal}</bdi>
                    </td>
                    <td className="tabular py-2 text-end">
                      <bdi>{format(outcome.allocation.monthly)}</bdi>
                    </td>
                    <td className="tabular py-2 text-end">
                      {outcome.allocation.target === null ? (
                        <span className="text-stone-400">אין יעד</span>
                      ) : (
                        <bdi>{format(outcome.allocation.target)}</bdi>
                      )}
                    </td>
                    <td className="py-2 text-xs text-stone-600">
                      {outcome.reachesIn !== null ? (
                        <span className="text-emerald-800">
                          {formatMonth(outcome.reachesIn)} — אחרי{" "}
                          {monthsCount(outcome.monthsToTarget ?? 0)}
                        </span>
                      ) : outcome.shortOfTarget !== null ? (
                        <span className="text-amber-800">
                          לא מגיע בטווח הזה, חסרים{" "}
                          <bdi className="tabular">{format(outcome.shortOfTarget)}</bdi>
                        </span>
                      ) : (
                        <span className="text-stone-500">אין יעד להגיע אליו</span>
                      )}
                      {" · "}
                      <bdi className="tabular">{format(outcome.ending)}</bdi>
                    </td>
                    <td className="py-2 text-end">
                      <form action={removeAllocation}>
                        <input type="hidden" name="scenarioId" value={scenario.id} />
                        <input type="hidden" name="allocationId" value={outcome.allocation.id} />
                        <button type="submit" className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-50">
                          הסרה
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {milestones.length === 0 ? null : (
            <div className="mt-4 border-t border-stone-200 pt-4">
              <h3 className="text-xs font-semibold tracking-wide text-stone-500">
                נצבר לאורך הזמן, בציוני דרך של חצי שנה
              </h3>
              <ul className="mt-2 grid gap-2 sm:grid-cols-3">
                {milestones.map((month) => (
                  <li key={formatMonth(month.month)} className="rounded-md border border-stone-200 p-2">
                    <p className="text-xs text-stone-500">{formatMonth(month.month)}</p>
                    <p className="tabular text-base font-medium">
                      <bdi>{format(month.cumulative)}</bdi>
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <form action={addAllocation} className="mt-4 grid gap-3 border-t border-stone-200 pt-4 sm:grid-cols-5">
        <input type="hidden" name="scenarioId" value={scenario.id} />

        <Field label="ייעוד">
          <input name="goal" required maxLength={60} placeholder="קרן חירום" className={INPUT} />
        </Field>

        <Field label="לחודש">
          <input name="monthly" required inputMode="decimal" dir="ltr" className={NUMBER} />
        </Field>

        <Field label="יעד" note="לא חייב">
          <input name="target" inputMode="decimal" dir="ltr" className={NUMBER} />
        </Field>

        <Field label="מטבע">
          <Select name="currency" defaultValue={currency}>
            {CURRENCIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex items-end">
          <button type="submit" className={BUTTON}>
            הוספת הקצאה
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * What is promised against what is actually saved. Deliberately not damped: a
 * household promising more than it saves should see the promise it made and the gap
 * beside it, not a quietly reduced number that hides which of the two is wrong.
 */
function CommitmentAgainstPace({ plan }: { plan: AllocationPlan }) {
  if (plan.paceStanding !== "computed" || plan.pace === null) {
    return (
      <p className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
        {plan.paceStanding === "no-pace"
          ? "אין חודש רשום במאזן שממנו למדוד קצב חיסכון, ולכן ההקצאות למטה אינן נמדדות מול כלום."
          : "ההקצאות והחיסכון במטבעות שונים ואין שער שמור להמיר ביניהם, ולכן אין מה להשוות."}
      </p>
    );
  }

  if (plan.over !== null) {
    return (
      <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
        ההקצאות מבטיחות <bdi className="tabular">{format(plan.committed)}</bdi> בחודש, והמאזן אומר
        שנחסכים <bdi className="tabular">{format(plan.pace)}</bdi> —{" "}
        <bdi className="tabular font-medium">{format(plan.over)}</bdi> יותר ממה שיש. הטבלה למטה
        מציגה את ההבטחה כפי שנרשמה, ולא גרסה מוקטנת שלה.
      </p>
    );
  }

  return (
    <p className="mt-3 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
      ההקצאות מבטיחות <bdi className="tabular">{format(plan.committed)}</bdi> בחודש מתוך{" "}
      <bdi className="tabular">{format(plan.pace)}</bdi> שנחסכים
      {plan.unallocated === null ? (
        <> — בדיוק הכול.</>
      ) : (
        <>
          , ונשארים <bdi className="tabular">{format(plan.unallocated)}</bdi> שלא הובטחו לשום ייעוד.
        </>
      )}
    </p>
  );
}

// --- the repeating pattern ----------------------------------------------------

export function PatternPanel({
  scenario,
  pattern,
  projection,
  projects,
  opening,
  monthly,
}: {
  scenario: Scenario;
  pattern: InvestmentPattern | null;
  projection: PatternProjection | null;
  projects: readonly Project[];
  opening: Money | null;
  monthly: Money | null;
}) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">דפוס חוזר</h2>
      <p className="mt-1 text-sm text-stone-600">
        אסטרטגיה שאפשר לומר במשפט אחד — &rdquo;CGM כל שנה, עשר שנים&ldquo; — נרשמת כאן כנתון, ומשוחקת
        קדימה: החיסכון נצבר, כל השקעה משולמת ממה שנצבר, ומה שחוזר מהשקעה קודמת עוזר לממן את הבאה.
      </p>

      {projection === null || pattern === null ? (
        <p className="mt-3 text-sm text-stone-500">עדיין לא נרשם דפוס חוזר בתרחיש הזה.</p>
      ) : (
        <PatternReading
          pattern={pattern}
          projection={projection}
          opening={opening}
          monthly={monthly}
          projects={projects}
        />
      )}

      <form action={saveInvestmentPattern} className="mt-4 grid gap-3 border-t border-stone-200 pt-4 sm:grid-cols-3">
        <input type="hidden" name="scenarioId" value={scenario.id} />

        <Field label="כל השקעה דורשת">
          <input
            name="amount"
            required
            inputMode="decimal"
            dir="ltr"
            defaultValue={pattern === null ? "" : toDecimalString(pattern.amount)}
            className={NUMBER}
          />
        </Field>

        <Field label="מטבע">
          <Select name="currency" defaultValue={pattern?.amount.currency ?? "USD"}>
            {CURRENCIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="הראשונה בתאריך">
          <input
            type="date"
            name="firstOn"
            required
            defaultValue={dateKey(pattern?.firstOn ?? dateOf(new Date()))}
            className={INPUT}
          />
        </Field>

        <Field label="כל כמה חודשים" note="12 היא פעם בשנה">
          <input
            name="everyMonths"
            required
            inputMode="numeric"
            dir="ltr"
            defaultValue={pattern?.everyMonths ?? 12}
            className={NUMBER}
          />
        </Field>

        <Field label="כמה פעמים">
          <input
            name="occurrences"
            required
            inputMode="numeric"
            dir="ltr"
            defaultValue={pattern?.occurrences ?? 10}
            className={NUMBER}
          />
        </Field>

        <Field label="לפי תנאי העסקה של" note="קובע מה חוזר ומתי">
          <Select name="modelledOn" defaultValue={pattern?.modelledOn ?? ""}>
            <option value="">אף פרוייקט — לא חוזר כלום</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="sm:col-span-3 flex flex-wrap items-center gap-3">
          <button type="submit" className={BUTTON}>
            שמירת הדפוס
          </button>
        </div>
      </form>

      {pattern === null ? null : (
        <form action={removeInvestmentPattern} className="mt-3">
          <input type="hidden" name="scenarioId" value={scenario.id} />
          <button type="submit" className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-stone-50">
            הסרת הדפוס
          </button>
        </form>
      )}
    </section>
  );
}

function PatternReading({
  pattern,
  projection,
  opening,
  monthly,
  projects,
}: {
  pattern: InvestmentPattern;
  projection: PatternProjection;
  opening: Money | null;
  monthly: Money | null;
  projects: readonly Project[];
}) {
  const modelled = projects.find((project) => project.id === pattern.modelledOn) ?? null;

  return (
    <>
      <dl className="mt-4 grid gap-4 sm:grid-cols-4">
        <Figure
          label="הושקע בפועל"
          amount={format(projection.invested)}
          note={`${projection.fundedCount} מתוך ${pattern.occurrences}`}
          emphasis
        />
        <Figure label="חזר בטווח" amount={format(projection.distributed)} note="הון ותשואה יחד" />
        <Figure label="עדיין בחוץ" amount={format(projection.outstanding)} note="הון שטרם חזר" />
        <Figure
          label="מזומן בסוף"
          amount={format(projection.ending)}
          note={`${formatMonth(projection.from)} — ${formatMonth(projection.to)}`}
        />
      </dl>

      <TermsInForce terms={projection.terms} projectName={modelled?.name ?? null} />

      <p className="mt-3 text-xs text-stone-500">
        נצבר מ־
        <bdi className="tabular">{monthly === null ? "אין קצב" : format(monthly)}</bdi> לחודש
        {opening === null ? null : (
          <>
            , על פתיחה של <bdi className="tabular">{format(opening)}</bdi> ממקורות התוכנית
          </>
        )}
        . השקעה שהכסף לא הספיק לה מסומנת כהוחמצה ואינה נדחית קדימה — דחייה הייתה ממציאה לוח זמנים
        שאיש לא בחר.
      </p>

      {projection.firstMissed === null ? (
        <p className="mt-3 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
          בקצב הזה כל {pattern.occurrences} ההשקעות בדפוס ממומנות.
        </p>
      ) : (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
          ההשקעה ה־{projection.firstMissed} בדפוס היא המקום שבו הכסף נגמר.
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead>
            <tr className="border-b border-stone-200 text-xs text-stone-500">
              <th className="py-2 text-start font-medium">#</th>
              <th className="py-2 text-start font-medium">מתי</th>
              <th className="py-2 text-end font-medium">דורשת</th>
              <th className="py-2 text-end font-medium">היה בקופה</th>
              <th className="py-2 text-start font-medium">מומנה</th>
              <th className="py-2 text-start font-medium">חוזר</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {projection.investments.map((investment) => (
              <tr key={investment.index}>
                <td className="tabular py-2">{investment.index}</td>
                <td className="py-2">{formatDate(investment.on)}</td>
                <td className="tabular py-2 text-end">
                  <bdi>{format(investment.amount)}</bdi>
                </td>
                <td className="tabular py-2 text-end">
                  <bdi>{format(investment.available)}</bdi>
                </td>
                <td className="py-2 text-xs">
                  {investment.funded ? (
                    <span className="text-emerald-800">כן</span>
                  ) : (
                    <span className="text-amber-800">
                      לא, חסרים{" "}
                      <bdi className="tabular">{format(investment.shortfall ?? investment.amount)}</bdi>
                    </span>
                  )}
                </td>
                <td className="py-2 text-xs text-stone-600">
                  {investment.returns === null || investment.returnsIn === null ? (
                    <span className="text-stone-400">—</span>
                  ) : (
                    <>
                      <bdi className="tabular">{format(investment.returns)}</bdi> ב
                      {formatMonth(investment.returnsIn)}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Which terms the projection ran on, and where each figure came from. The reading
 * of the return is stated because the document does not state it: a percentage
 * beside a hold period says nothing about compounding, so nothing here invents any.
 */
function TermsInForce({
  terms,
  projectName,
}: {
  terms: EffectiveTerms | null;
  projectName: string | null;
}) {
  if (terms === null) {
    return (
      <p className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
        הדפוס אינו מודל על אף פרוייקט, ולכן לא חוזר ממנו כלום — התחזית היא הוצאות בלבד. זו עמדה
        לגיטימית, ולא נתון חסר.
      </p>
    );
  }

  return (
    <p
      className={`mt-3 rounded-md border p-3 text-sm ${
        terms.basis === "overridden"
          ? "border-sky-300 bg-sky-50 text-sky-900"
          : "border-stone-200 bg-stone-50 text-stone-700"
      }`}
    >
      {terms.basis === "none" ? (
        <>
          אין תנאי עסקה רשומים ל<bdi>{projectName ?? terms.projectId}</bdi>, ולכן לא חוזר כלום.
        </>
      ) : (
        <>
          תשואה{" "}
          <bdi className="tabular font-medium">
            {terms.targetReturnBasisPoints === null
              ? "לא נרשמה"
              : formatBasisPoints(terms.targetReturnBasisPoints)}
          </bdi>{" "}
          על פני{" "}
          <bdi className="tabular font-medium">
            {terms.holdMonths === null ? "אין תקופה" : monthsCount(terms.holdMonths)}
          </bdi>
          , לפי <bdi>{projectName ?? terms.projectId}</bdi>{" "}
          {terms.basis === "overridden" ? (
            <>
              — כאשר התרחיש הזה דורס את{" "}
              {terms.overridden
                .map((field) => (field === "target-return" ? "התשואה" : "תקופת ההחזקה"))
                .join(" ו")}
              {terms.recorded === null ? null : (
                <>
                  {" "}
                  (במסמך:{" "}
                  {terms.recorded.targetReturnBasisPoints === null
                    ? "אין תשואה"
                    : formatBasisPoints(terms.recorded.targetReturnBasisPoints)}
                  {terms.recorded.holdMonths === null
                    ? ""
                    : ` על פני ${monthsCount(terms.recorded.holdMonths)}`}
                  )
                </>
              )}
              . מה שרשום במסמך לא השתנה.
            </>
          ) : (
            <>— כפי שנרשם מהמסמך.</>
          )}{" "}
          התשואה נקראת כתשואה כוללת על פני התקופה, ולא כתשואה שנתית: המסמך אינו אומר דבר על ריבית
          דריבית, וכאן לא ממציאים אחת.
        </>
      )}
    </p>
  );
}

// --- the deal terms this scenario disagrees with ------------------------------

export function TermsOverridePanel({
  scenario,
  terms,
  projectName,
}: {
  scenario: Scenario;
  terms: EffectiveTerms;
  projectName: string;
}) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">
        תנאי העסקה בתוך התרחיש
      </h2>
      <p className="mt-1 text-sm text-stone-600">
        מה התרחיש הזה אומר במקום מה שהמסמך של <bdi>{projectName}</bdi> אומר. הבטחה של יזם שווה
        בדיקה — &rdquo;ומה אם זה יחזיר 8% במקום 18%&ldquo; — והתשובה לשאלה הזו אסור לה לדרוס את מה
        שהמסמך באמת אמר. שדה ריק אינו דריסה: הוא אומר שלתרחיש אין דעה עליו, והתנאי הרשום נשאר בתוקף.
      </p>

      <form action={saveTermsOverride} className="mt-4 grid gap-3 sm:grid-cols-3">
        <input type="hidden" name="scenarioId" value={scenario.id} />
        <input type="hidden" name="projectId" value={terms.projectId} />

        <Field label="תשואה כוללת" note="באחוזים. ריק — כמו במסמך">
          <input
            name="targetReturnPercent"
            inputMode="decimal"
            dir="ltr"
            defaultValue={
              terms.overridden.includes("target-return") && terms.targetReturnBasisPoints !== null
                ? String(terms.targetReturnBasisPoints / 100)
                : ""
            }
            placeholder={
              terms.recorded?.targetReturnBasisPoints === null ||
              terms.recorded?.targetReturnBasisPoints === undefined
                ? "אין במסמך"
                : String(terms.recorded.targetReturnBasisPoints / 100)
            }
            className={NUMBER}
          />
        </Field>

        <Field label="תקופת החזקה" note="בחודשים. ריק — כמו במסמך">
          <input
            name="holdMonths"
            inputMode="numeric"
            dir="ltr"
            defaultValue={
              terms.overridden.includes("hold-period") && terms.holdMonths !== null
                ? String(terms.holdMonths)
                : ""
            }
            placeholder={
              terms.recorded?.holdMonths === null || terms.recorded?.holdMonths === undefined
                ? "אין במסמך"
                : String(terms.recorded.holdMonths)
            }
            className={NUMBER}
          />
        </Field>

        <div className="flex items-end">
          <button type="submit" className={BUTTON}>
            שמירה
          </button>
        </div>
      </form>

      <p className="mt-3 text-xs text-stone-500">
        שני השדות ריקים מוחקים את הדריסה והתרחיש חוזר לתנאים הרשומים.{" "}
        <Link href="/projects" className="underline underline-offset-4">
          התנאים הרשומים עצמם
        </Link>
      </p>
    </section>
  );
}

// --- marking the plan being followed ------------------------------------------

export function ActivePlanControl({ scenario }: { scenario: Scenario }) {
  return (
    <form action={markActivePlan} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="scenarioId" value={scenario.id} />
      <input type="hidden" name="active" value={scenario.active ? "no" : "yes"} />
      <button type="submit" className={scenario.active ? BUTTON : PRIMARY}>
        {scenario.active ? "ביטול סימון כתוכנית פעילה" : "סימון כתוכנית שאחריה עוקבים"}
      </button>
      <span className="text-xs text-stone-500">
        {scenario.active
          ? "לוח המחוונים מודד את משק הבית מול התרחיש הזה."
          : "תרחיש אחד לכל היותר יכול להיות התוכנית הפעילה, ואפשר גם אף אחד."}
      </span>
    </form>
  );
}

// --- executing the plan --------------------------------------------------------

export function ExecutionPanel({
  scenario,
  projects,
  executed,
  preview,
  rate,
}: {
  scenario: Scenario;
  projects: readonly Project[];
  executed: PlanExecution | null;
  preview: ExecutionPreview | null;
  rate: DatedRate | null;
}) {
  const project =
    executed === null ? null : projects.find((candidate) => candidate.id === executed.projectId);

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">ביצוע תוכנית המימון</h2>
      <p className="mt-1 text-sm text-stone-600">
        הרגע שבו התוכנית מפסיקה להיות מחשבה: כל מקור מתוכנן הופך לרגל מימון בפרוייקט, בשער שבו הכסף
        באמת הומר. זו הפעולה היחידה בלוח התכנון שכותבת משהו שנרשם — ולכן היא נשאלת פעמיים, ומה
        שנכתב הוא בדיוק מה שמוצג כאן לפני האישור.
      </p>

      {executed !== null ? (
        <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-medium">התוכנית בוצעה ב־{formatDate(executed.executedOn)}.</p>
          <p className="mt-1">
            נרשמו {executed.legCount === 1 ? "רגל מימון אחת" : `${executed.legCount} רגלי מימון`}{" "}
            בפרוייקט <bdi>{project?.name ?? executed.projectId}</bdi>
            {executed.rate === null ? (
              <>, בלי המרת מטבע.</>
            ) : (
              <>
                , בשער <bdi className="tabular">{formatRate(executed.rate.rate)}</bdi>.
              </>
            )}
          </p>
          <p className="mt-2">
            <Link
              href={project === undefined || project === null ? "/projects" : `/projects/${project.id}`}
              className="underline underline-offset-4"
            >
              הפרוייקט ורגלי המימון שלו ←
            </Link>
          </p>
          <p className="mt-2 text-xs">
            מכאן והלאה התוכנית והמקורות שלה הם רישום של מה שקרה ואינם ניתנים לעריכה, והתרחיש אינו
            נמחק. תיקון של רגל מימון נעשה במסך הפרוייקט, במקום שבו הרגל באמת חיה.
          </p>
        </div>
      ) : (
        <>
          {preview === null ? null : <ExecutionPreviewPanel scenario={scenario} preview={preview} />}

          <form method="get" className="mt-4 grid gap-3 border-t border-stone-200 pt-4 sm:grid-cols-4">
            <input type="hidden" name="execute" value="1" />

            <Field label="לתוך הפרוייקט">
              <Select name="projectId" defaultValue={preview?.project.id ?? projects[0]?.id ?? ""}>
                {projects.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} ({candidate.currency})
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="ביום">
              <input
                type="date"
                name="paidOn"
                required
                defaultValue={dateKey(preview?.paidOn ?? dateOf(new Date()))}
                className={INPUT}
              />
            </Field>

            <Field label="בשער USD/ILS" note="רק אם משהו מומר">
              <input
                name="rate"
                inputMode="decimal"
                dir="ltr"
                defaultValue={
                  preview?.rate === null || preview?.rate === undefined
                    ? (rate?.rate ?? "")
                    : preview.rate.rate
                }
                className={NUMBER}
              />
            </Field>

            <div className="flex items-end">
              <button type="submit" className={BUTTON}>
                הצגת מה ייכתב
              </button>
            </div>
          </form>

          {projects.length === 0 ? (
            <p className="mt-3 text-xs text-amber-800">
              אין עדיין פרוייקטים לבצע לתוכם. ביצוע יוצר רגלי מימון בקופה קיימת.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Exactly what would be written, before anything is. */
function ExecutionPreviewPanel({
  scenario,
  preview,
}: {
  scenario: Scenario;
  preview: ExecutionPreview;
}) {
  if (!preview.executable) {
    return (
      <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="alert">
        <p className="font-medium">לא ניתן לבצע את התוכנית, ולכן לא נכתב דבר.</p>
        <p className="mt-1">
          <bdi>{preview.refusal?.detail ?? ""}</bdi>
        </p>
        <p className="mt-2 text-xs">
          ביצוע הוא הכול או כלום: שורה אחת שאי אפשר לסמוך עליה פוסלת את כולן, כי חצי תוכנית בקופה
          גרועה מאף אחת — הקופה הייתה נקראת כממומנת בסכום שאיש לא החליט עליו.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-md border border-stone-300 bg-stone-50 p-4">
      <h3 className="text-sm font-semibold text-stone-700">
        מה ייכתב לפרוייקט <bdi>{preview.project.name}</bdi>
      </h3>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-b border-stone-200 text-xs text-stone-500">
              <th className="py-2 text-start font-medium">מקור</th>
              <th className="py-2 text-end font-medium">סכום</th>
              <th className="py-2 text-start font-medium">שער</th>
              <th className="py-2 text-end font-medium">בקופה</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {preview.lines.map((line) => (
              <tr key={line.source.id}>
                <td className="py-2">
                  <bdi>{line.definition.source}</bdi>
                </td>
                <td className="tabular py-2 text-end">
                  <bdi>{format(line.definition.amount)}</bdi>
                </td>
                <td className="tabular py-2 text-xs">
                  {line.leg.rate === null ? (
                    <span className="text-stone-500">לא הומר</span>
                  ) : (
                    formatRate(line.leg.rate.rate)
                  )}
                </td>
                <td className="tabular py-2 text-end">
                  <bdi>{format(line.inPotCurrency)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-sm text-stone-700">
        סך הכול <bdi className="tabular font-medium">{format(preview.total)}</bdi>
        {preview.needs === null ? (
          <>. אין שער לקרוא בו את מה שהתוכנית דרשה, ולכן אין השוואה.</>
        ) : preview.difference === null || preview.difference.minorUnits === 0 ? (
          <> — בדיוק מה שהתוכנית דרשה.</>
        ) : preview.difference.minorUnits > 0 ? (
          <>
            , כלומר <bdi className="tabular">{format(preview.difference)}</bdi> מעל מה שהתוכנית דרשה
            (<bdi className="tabular">{format(preview.needs)}</bdi>).
          </>
        ) : (
          <>
            , כלומר פחות ממה שהתוכנית דרשה (
            <bdi className="tabular">{format(preview.needs)}</bdi>). הפרוייקט ימומן בסכום הזה; זו
            עובדה שנרשמת ולא סיבה לסרב.
          </>
        )}
      </p>

      <form action={executePlan} className="mt-4 flex flex-wrap items-center gap-3">
        <input type="hidden" name="scenarioId" value={scenario.id} />
        <input type="hidden" name="projectId" value={preview.project.id} />
        <input type="hidden" name="paidOn" value={dateKey(preview.paidOn)} />
        <input type="hidden" name="rate" value={preview.rate === null ? "" : preview.rate.rate} />
        <button type="submit" className={PRIMARY}>
          ביצוע — כתיבת רגלי המימון
        </button>
        <span className="text-xs text-stone-500">
          פעולה חד־פעמית. אחריה התוכנית היא רישום של מה שקרה.
        </span>
      </form>
    </div>
  );
}
