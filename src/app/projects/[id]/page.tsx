import Link from "next/link";
import { notFound } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { loadAccounts } from "@/db/accounts";
import { DatabaseNotConfiguredError } from "@/db/client";
import { type DatedRate, findLatestRate } from "@/db/money-settings";
import { type Person, findPersonByEmail } from "@/db/people";
import {
  loadDealTerms,
  loadFundingLegs,
  loadProjectExpenses,
  loadProjects,
} from "@/db/projects";
import { loadSnapshots } from "@/db/snapshots";
import { type Currency, type Money, equals, format, subtract } from "@/domain/money/money";
import {
  type DealTerms,
  type FundingLeg,
  type Project,
  type ProjectExpense,
  type ProjectReading,
  againstToday,
  expenseInPotCurrency,
  findProject,
  legInPotCurrency,
  readProject,
  statesAnything,
} from "@/domain/projects/projects";
import {
  type Account,
  type Snapshot,
  canConvertWithin,
  convertWithin,
  findLine,
  isUnmeasured,
} from "@/domain/snapshot/snapshot";
import { dateKey, dateOf, formatDate } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

import {
  addExpense,
  addFundingLeg,
  editProject,
  removeExpense,
  removeFundingLeg,
  saveTerms,
} from "../actions";
import { Field, Notices, RateFigure, Select, UnavailablePanel, readsAsSameRate } from "../panels";

export const dynamic = "force-dynamic";

/**
 * One project: its funding legs, its running expense ledger, its יתרה, the rate it
 * was actually funded at, and the terms its sponsor stated.
 *
 * Nothing on this page is a stored total. `יתרה` is `Σ(legs) − Σ(expenses)` on
 * every read, and the only two ways it moves are a leg going in and an expense
 * coming out — which is why an expense larger than the pot is refused rather than
 * allowed to overdraw it.
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

export default async function ProjectPage({
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
        title={loaded.kind === "ok" ? loaded.reading.project.name : "פרוייקט"}
        subtitle="פוט סגור — רגלי מימון ממלאות, הוצאות נמשכות"
        back={{ href: "/projects", label: "חזרה לרשימת הפרוייקטים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <Notices error={first(query.error)} detail={first(query.detail)} done={first(query.done)} />

        {loaded.kind === "ok" ? (
          <>
            <PotPanel reading={loaded.reading} />
            <RatePanel reading={loaded.reading} today={loaded.rate} />
            <LegsPanel reading={loaded.reading} />
            <ExpensesPanel reading={loaded.reading} />
            <SnapshotValuePanel
              reading={loaded.reading}
              accounts={loaded.accounts}
              snapshot={loaded.snapshot}
            />
            <TermsPanel reading={loaded.reading} />
            <DefinitionPanel reading={loaded.reading} accounts={loaded.accounts} />
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
      reading: ProjectReading;
      accounts: readonly Account[];
      /** The most recent snapshot, for reading the project's account against its cost. */
      snapshot: Snapshot | null;
      rate: DatedRate | null;
    }
  | { kind: "missing" }
  | { kind: "unavailable"; reason: string };

async function loadPage(email: string, id: string): Promise<Loaded> {
  try {
    const projects = await loadProjects();
    const project = findProject(projects, id);
    if (project === undefined) return { kind: "missing" };

    const [person, legs, expenses, terms, accounts, snapshots, rate] = await Promise.all([
      findPersonByEmail(email),
      loadFundingLegs(projects),
      loadProjectExpenses(projects),
      loadDealTerms(),
      loadAccounts(),
      loadSnapshots(),
      findLatestRate("USD", "ILS"),
    ]);

    return {
      kind: "ok",
      person,
      reading: readProject({ project, legs, expenses, terms }),
      accounts,
      // Newest first out of the database.
      snapshot: snapshots[0] ?? null,
      rate,
    };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- the pot -----------------------------------------------------------------

function PotPanel({ reading }: { reading: ProjectReading }) {
  const { pot } = reading;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">הפוט</h2>

      <dl className="mt-3 grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-stone-500">סך רגלי המימון</dt>
          <dd className="tabular mt-1 text-lg">
            <bdi>{format(pot.funded)}</bdi>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">פחות סך ההוצאות</dt>
          <dd className="tabular mt-1 text-lg">
            <bdi>{format(pot.spent)}</bdi>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">יתרה — הון שטרם הושקע</dt>
          <dd className="tabular mt-1 text-2xl font-semibold">
            <bdi>{format(pot.balance)}</bdi>
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-xs text-stone-500">
        היתרה מחושבת בכל קריאה כ־<bdi className="tabular">Σ(רגלי מימון) − Σ(הוצאות)</bdi> ואינה נשמרת
        בשום מקום, ולכן אין רצף פעולות שיכול להשאיר אותה חלוקה על השורות שמתחתיה. הוצאה גדולה מהיתרה
        נדחית: הכנסת כסף נוסף לפוט היא רגל מימון חדשה, ולא הוצאה גדולה יותר.
      </p>
    </section>
  );
}

// --- the rate the money actually went in at ----------------------------------

function RatePanel({ reading, today }: { reading: ProjectReading; today: DatedRate | null }) {
  const { effective, project } = reading;
  const standing = today === null ? null : againstToday(effective, today);

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">שער אפקטיבי</h2>

      {effective.rate === null ? (
        <p className="mt-2 text-sm text-stone-600">
          שום כסף בפרוייקט הזה לא החליף מטבע, ולכן אין לו שער אפקטיבי. שער שהיה נרשם כאן היה מספר
          שאיש לא השתמש בו.
        </p>
      ) : (
        <>
          <p className="mt-2 text-3xl font-semibold">
            <RateFigure rate={effective.rate} />
          </p>
          <p className="mt-1 text-sm text-stone-600">
            <bdi className="tabular">{format(effective.ils)}</bdi> מול{" "}
            <bdi className="tabular">{format(effective.usd)}</bdi>, על פני{" "}
            <bdi className="tabular">{effective.legCount}</bdi>{" "}
            {effective.legCount === 1 ? "רגל שהמירה מטבע" : "רגליים שהמירו מטבע"}.
          </p>

          {standing === null ? (
            <p className="mt-3 text-sm text-stone-500">אין שער שמור להיום, ולכן אין מול מה להשוות.</p>
          ) : (
            <p className="mt-3 text-sm text-stone-700">
              היום השער הוא <RateFigure rate={standing.today.rate} />
              {standing.standing === "same" || readsAsSameRate(standing.difference) ? (
                <> — אותו שער שבו הומר הכסף, עד לספרה שמוצגת כאן.</>
              ) : effective.direction?.to === "ILS" ? (
                // Dollars were sold for shekels, so more shekels per dollar is the
                // good end of the trade. Which end that is depends entirely on the
                // direction, which is why the domain says only "above" or "below".
                <>
                  , כלומר{" "}
                  <span className="font-medium">
                    קיבלנו {standing.standing === "above" ? "יותר" : "פחות"} שקלים לדולר
                  </span>{" "}
                  ממה שהיינו מקבלים היום, בהפרש של <RateFigure rate={Math.abs(standing.difference)} />.
                </>
              ) : (
                <>
                  , כלומר{" "}
                  <span className="font-medium">
                    שילמנו {standing.standing === "above" ? "יותר" : "פחות"} שקלים לדולר
                  </span>{" "}
                  ממה שהיינו משלמים היום, בהפרש של <RateFigure rate={Math.abs(standing.difference)} />.
                </>
              )}
            </p>
          )}
        </>
      )}

      <p className="mt-3 text-xs text-stone-500">
        השער נגזר מהסכומים שנרשמו ולא ממוצע של שדות השער, ולכן חלוקת השקלים בדולרים מחזירה בדיוק את
        סכום השקלים. רגל שכבר הייתה ב־<bdi>{project.currency}</bdi> לא המירה דבר ואינה נכללת בו.
      </p>
    </section>
  );
}

// --- funding legs ------------------------------------------------------------

function LegsPanel({ reading }: { reading: ProjectReading }) {
  const { project, legs } = reading;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">רגלי מימון</h2>
      <p className="mt-1 text-sm text-stone-600">
        כל מקור שמימן את הפרוייקט, במטבע שבו שולם בפועל. הוספת כסף לפוט היא הוספת רגל — אין דרך אחרת,
        וזה מה שמונע מהפוט להתמלא בלי שיהיה כתוב מאיפה.
      </p>

      {legs.length === 0 ? (
        <p className="mt-3 text-sm text-stone-500">אין עדיין רגלי מימון.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-start text-xs text-stone-500">
                <th className="py-2 text-start font-medium">מקור</th>
                <th className="py-2 text-start font-medium">תאריך</th>
                <th className="py-2 text-end font-medium">כפי ששולם</th>
                <th className="py-2 text-end font-medium">שער</th>
                <th className="py-2 text-end font-medium">בפוט</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {legs.map((leg) => (
                <LegRow key={leg.id} leg={leg} project={project} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <MovementForm
        action={addFundingLeg}
        project={project}
        nameField={{ name: "source", label: "מקור", placeholder: "Apple RSU" }}
        submit="הוספת רגל מימון"
      />
    </section>
  );
}

function LegRow({ leg, project }: { leg: FundingLeg; project: Project }) {
  const converted = leg.amount.currency === project.currency ? null : legInPotCurrency(leg, project);

  return (
    <tr>
      <td className="py-2">
        <bdi>{leg.source}</bdi>
      </td>
      <td className="py-2 text-stone-600">{formatDate(leg.paidOn)}</td>
      <td className="tabular py-2 text-end">
        <bdi>{format(leg.amount)}</bdi>
      </td>
      <td className="tabular py-2 text-end text-stone-600">
        {leg.rate === null ? <span className="text-stone-400">—</span> : <RateFigure rate={leg.rate.rate} />}
      </td>
      <td className="tabular py-2 text-end">
        <bdi>{format(converted ?? leg.amount)}</bdi>
      </td>
      <td className="py-2 text-end">
        <form action={removeFundingLeg}>
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="legId" value={leg.id} />
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

// --- the expense ledger ------------------------------------------------------

function ExpensesPanel({ reading }: { reading: ProjectReading }) {
  const { project, expenses, pot } = reading;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">ספר ההוצאות</h2>
      <p className="mt-1 text-sm text-stone-600">
        מה הוצא ועל מה. הוצאה נמשכת <span className="font-medium">מתוך</span> הפוט ולעולם לא מוסיפה לו,
        ולכן היתרה יורדת בדיוק בסכום שנרשם. נשארו <bdi className="tabular">{format(pot.balance)}</bdi>{" "}
        להוציא.
      </p>

      {expenses.length === 0 ? (
        <p className="mt-3 text-sm text-stone-500">עדיין לא נרשמו הוצאות.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-xs text-stone-500">
                <th className="py-2 text-start font-medium">על מה</th>
                <th className="py-2 text-start font-medium">תאריך</th>
                <th className="py-2 text-end font-medium">כפי ששולם</th>
                <th className="py-2 text-end font-medium">שער</th>
                <th className="py-2 text-end font-medium">מהפוט</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {expenses.map((expense) => (
                <ExpenseRow key={expense.id} expense={expense} project={project} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <MovementForm
        action={addExpense}
        project={project}
        nameField={{ name: "description", label: "על מה", placeholder: "רכישת הקרקע" }}
        submit="רישום הוצאה"
      />
    </section>
  );
}

function ExpenseRow({ expense, project }: { expense: ProjectExpense; project: Project }) {
  const converted =
    expense.amount.currency === project.currency ? null : expenseInPotCurrency(expense, project);

  return (
    <tr>
      <td className="py-2">
        <bdi>{expense.description}</bdi>
      </td>
      <td className="py-2 text-stone-600">{formatDate(expense.paidOn)}</td>
      <td className="tabular py-2 text-end">
        <bdi>{format(expense.amount)}</bdi>
      </td>
      <td className="tabular py-2 text-end text-stone-600">
        {expense.rate === null ? (
          <span className="text-stone-400">—</span>
        ) : (
          <RateFigure rate={expense.rate.rate} />
        )}
      </td>
      <td className="tabular py-2 text-end">
        <bdi>{format(converted ?? expense.amount)}</bdi>
      </td>
      <td className="py-2 text-end">
        <form action={removeExpense}>
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="expenseId" value={expense.id} />
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
 * The form both ledgers share. A leg and an expense are the same four facts —
 * what it was, how much, in which currency, and at which rate — moving in
 * opposite directions.
 */
function MovementForm({
  action,
  project,
  nameField,
  submit,
}: {
  action: (form: FormData) => Promise<void>;
  project: Project;
  nameField: { name: string; label: string; placeholder: string };
  submit: string;
}) {
  return (
    <form action={action} className="mt-4 grid gap-3 border-t border-stone-200 pt-4 sm:grid-cols-5">
      <input type="hidden" name="projectId" value={project.id} />

      <Field label={nameField.label}>
        <input
          name={nameField.name}
          required
          maxLength={120}
          placeholder={nameField.placeholder}
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
        <Select name="currency" defaultValue={project.currency}>
          {CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="שער USD/ILS" note={`רק אם המטבע אינו ${project.currency}`}>
        <input
          name="rate"
          inputMode="decimal"
          dir="ltr"
          placeholder="3.65"
          className="tabular w-full rounded-md border border-stone-300 px-3 py-2 text-end"
        />
      </Field>

      <Field label="תאריך">
        <input
          type="date"
          name="paidOn"
          defaultValue={dateKey(dateOf(new Date()))}
          className="w-full rounded-md border border-stone-300 px-3 py-2"
        />
      </Field>

      <div className="sm:col-span-5">
        <button
          type="submit"
          className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium hover:bg-stone-50"
        >
          {submit}
        </button>
      </div>
    </form>
  );
}

// --- what מיפוי should read --------------------------------------------------

/**
 * The cost, and what the linked account actually holds in the latest snapshot.
 *
 * Per ADR 0003 the cost does not fall as the expense ledger is spent down:
 * converting cash into property moves money inside the pot, and the pot cost what
 * it cost. Nothing here writes into the snapshot — a project's value is a figure
 * someone states in מיפוי, and this screen says which figure that should be.
 */
function SnapshotValuePanel({
  reading,
  accounts,
  snapshot,
}: {
  reading: ProjectReading;
  accounts: readonly Account[];
  snapshot: Snapshot | null;
}) {
  const { project, cost, pot } = reading;
  const account = accounts.find((candidate) => candidate.id === project.accountId) ?? null;
  const line = account === null || snapshot === null ? undefined : findLine(snapshot, account.id);

  const expected: Money | null =
    account === null
      ? null
      : snapshot === null || canConvertWithin(snapshot, cost.currency, account.currency)
        ? snapshot === null
          ? cost
          : convertWithin(snapshot, cost, account.currency)
        : null;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">שווי במיפוי</h2>

      <p className="mt-2 text-2xl font-semibold">
        <bdi className="tabular">{format(cost)}</bdi>
      </p>
      <p className="mt-1 text-sm text-stone-600">
        סך העלות — סכום רגלי המימון. הוא אינו יורד ככל שספר ההוצאות נמשך: כרגע הוצאו{" "}
        <bdi className="tabular">{format(pot.spent)}</bdi> מתוכו, והשווי במיפוי נשאר{" "}
        <bdi className="tabular">{format(cost)}</bdi>. המרת מזומן לנכס אינה הפסד.
      </p>

      {account === null ? (
        <p className="mt-3 text-sm text-stone-500">
          לא נבחר חשבון במיפוי שנושא את הפרוייקט הזה. אפשר לבחור אותו למטה, ואז השווי שלמעלה יהיה
          הסכום שיש להזין באותו חשבון.
        </p>
      ) : (
        <div className="mt-3 rounded-md border border-stone-200 bg-stone-50/60 p-4 text-sm">
          <p>
            החשבון במיפוי: <bdi className="font-medium">{account.name}</bdi> (
            <bdi>{account.currency}</bdi>)
          </p>

          {snapshot === null ? (
            <p className="mt-1 text-stone-600">עדיין לא נלקח שום צילום.</p>
          ) : line === undefined ? (
            <p className="mt-1 text-stone-600">
              החשבון אינו מופיע בצילום האחרון ({formatDate(snapshot.takenOn)}).
            </p>
          ) : isUnmeasured(line) ? (
            <p className="mt-1 text-stone-600">
              בצילום של {formatDate(snapshot.takenOn)} החשבון עדיין לא נמדד מעולם.
            </p>
          ) : expected === null ? (
            <p className="mt-1 text-stone-600">
              הצילום של {formatDate(snapshot.takenOn)} אינו נושא שער שממיר{" "}
              <bdi>{cost.currency}</bdi> ל־<bdi>{account.currency}</bdi>, ולכן אין להשוות.
            </p>
          ) : (
            <p className="mt-1 text-stone-600">
              בצילום של {formatDate(snapshot.takenOn)} רשום <bdi className="tabular">{format(line.balance)}</bdi>{" "}
              {equals(line.balance, expected) ? (
                <span className="font-medium text-emerald-800">— בדיוק העלות.</span>
              ) : (
                <>
                  — העלות באותו שער היא <bdi className="tabular">{format(expected)}</bdi>, כלומר הפרש של{" "}
                  <bdi className="tabular font-medium">{format(subtract(line.balance, expected))}</bdi>.
                  הצילום נכתב ביד; המספר הזה אינו נכתב לתוכו אוטומטית.
                </>
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// --- deal terms --------------------------------------------------------------

function TermsPanel({ reading }: { reading: ProjectReading }) {
  const { project, terms } = reading;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">תנאי העסקה</h2>
      <p className="mt-1 text-sm text-stone-600">
        מה שהיזם הצהיר שהפרוייקט יחזיר, נרשם מהמסמכים שלו ומוקלד ביד. זו הבטחה ולא מדידה: שום מספר
        במערכת אינו נגזר ממנה, והיא נקראת רק בתרחישים — שם אפשר גם לדרוס אותה.
      </p>

      <form action={saveTerms} className="mt-4 grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="projectId" value={project.id} />

        <Field label="תשואת יעד (%)" note="נשמרת בנקודות בסיס שלמות">
          <input
            name="targetReturnPercent"
            inputMode="decimal"
            dir="ltr"
            defaultValue={
              terms?.targetReturnBasisPoints == null ? "" : String(terms.targetReturnBasisPoints / 100)
            }
            className="tabular w-full rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </Field>

        <Field label="תקופת החזקה (חודשים)">
          <input
            name="holdMonths"
            inputMode="numeric"
            dir="ltr"
            defaultValue={terms?.holdMonths == null ? "" : String(terms.holdMonths)}
            className="tabular w-full rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </Field>

        <Field label="דפוס חלוקות" note="במילים של היזם">
          <input
            name="distribution"
            maxLength={200}
            defaultValue={terms?.distribution ?? ""}
            className="w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <Field label="מקור" note="איזה מסמך נקרא">
          <input
            name="source"
            maxLength={120}
            defaultValue={terms?.source ?? ""}
            className="w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <Field label="תאריך הרישום">
          <input
            type="date"
            name="recordedOn"
            defaultValue={dateKey(terms?.recordedOn ?? dateOf(new Date()))}
            className="w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <div className="flex items-end">
          <button
            type="submit"
            className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium hover:bg-stone-50"
          >
            שמירת תנאי העסקה
          </button>
        </div>
      </form>

      <TermsSummary terms={terms} />
    </section>
  );
}

function TermsSummary({ terms }: { terms: DealTerms | null }) {
  if (terms === null || !statesAnything(terms)) {
    return <p className="mt-3 text-xs text-stone-500">עדיין לא נרשם דבר. שורה של ריקים אינה הבטחה.</p>;
  }
  return (
    <p className="mt-3 text-xs text-stone-500">
      נרשם ב־{formatDate(terms.recordedOn)}
      {terms.source === null ? null : (
        <>
          {" "}
          מתוך <bdi>{terms.source}</bdi>
        </>
      )}
      .
    </p>
  );
}

// --- the definition ----------------------------------------------------------

function DefinitionPanel({
  reading,
  accounts,
}: {
  reading: ProjectReading;
  accounts: readonly Account[];
}) {
  const { project } = reading;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">הגדרת הפרוייקט</h2>

      <form action={editProject} className="mt-4 grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="projectId" value={project.id} />

        <Field label="שם הפרוייקט">
          <input
            name="name"
            defaultValue={project.name}
            required
            maxLength={60}
            className="w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <Field label="תאריך פתיחה">
          <input
            type="date"
            name="startedOn"
            defaultValue={dateKey(project.startedOn)}
            required
            className="w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <Field label="החשבון במיפוי">
          <Select name="accountId" defaultValue={project.accountId ?? ""}>
            <option value="">— לא נבחר —</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex items-end">
          <button
            type="submit"
            className="rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
          >
            שמירה
          </button>
        </div>
      </form>

      <p className="mt-3 text-xs text-stone-500">
        מטבע הפוט (<bdi>{project.currency}</bdi>) אינו ניתן לשינוי — שינוי שלו היה משנה את המטבע של כל
        רגל וכל הוצאה שכבר נרשמו בו, ואת המשמעות של השער הרשום לצידן.{" "}
        <Link href="/accounts" className="underline underline-offset-4">
          ניהול החשבונות
        </Link>
      </p>
    </section>
  );
}
