import type { Route } from "next";
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
  loadProjectDistributions,
  loadProjectExpenses,
  loadProjectValuations,
  loadProjects,
} from "@/db/projects";
import { loadSnapshots } from "@/db/snapshots";
import {
  type Currency,
  type Money,
  equals,
  format,
  isNegative,
  ratio,
  subtract,
} from "@/domain/money/money";
import {
  type DealTerms,
  type MovementKind,
  type Project,
  type ProjectMovement,
  type ProjectReading,
  type ProjectValuation,
  againstToday,
  findProject,
  readProject,
  statesAnything,
} from "@/domain/projects/projects";
import {
  type Account,
  type Snapshot,
  VALUE_BASIS_LABELS,
  canConvertWithin,
  convertWithin,
  findLine,
  isUnmeasured,
} from "@/domain/snapshot/snapshot";
import { dateKey, dateOf, formatDate } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

import {
  addMovement,
  addValuation,
  editProject,
  removeDistribution,
  removeExpense,
  removeFundingLeg,
  removeValuation,
  saveTerms,
} from "../actions";
import {
  FIELD,
  Field,
  Notices,
  PRIMARY_BUTTON,
  RateFigure,
  Select,
  UnavailablePanel,
  readsAsSameRate,
} from "../panels";

export const dynamic = "force-dynamic";

/**
 * One project, as one screen: a head of five figures, and two bands of rows
 * beneath it.
 *
 * תנועות is everything that ever moved — what filled the pot, what drained it and
 * what it returned — in one table with the kind as a column, because that is one
 * history and three tables made it read as three. עדכוני שווי is separate because
 * it is not a movement at all: nothing in it moves money, and nothing sums it.
 *
 * Each band's last row is where you type, in the band's own columns, so recording
 * anything never means scrolling past what is already there.
 *
 * Every rule this screen enforces is stated once, in the legend, rather than in a
 * paragraph above each band. They were all true and all worth saying — said in
 * eight places at the weight of a figure, they made the screen read as an argument
 * instead of a position.
 *
 * Nothing here is a stored total. `יתרה` is `Σ(legs) + Σ(rolled) − Σ(expenses)` on
 * every read, and `שווי אחרון` is the latest recorded עדכון שווי or the cost where
 * none exists — never a figure interpolated between two of them.
 */

const CURRENCIES: readonly Currency[] = ["ILS", "USD"];

// Whole percent, the same as the list's: the deployed share is a reading and not
// an accounting figure, and two screens printing 79% and 78.6% of one project read
// as a disagreement. The exact amounts are on the line beneath it.
const PERCENT = new Intl.NumberFormat("he-IL", { style: "percent", maximumFractionDigits: 0 });

const SIGNED_PERCENT = new Intl.NumberFormat("he-IL", {
  style: "percent",
  maximumFractionDigits: 1,
  signDisplay: "always",
});

interface SearchParams {
  error?: string | string[];
  detail?: string | string[];
  done?: string | string[];
  settings?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const SETTINGS_ID = "project-settings";

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

  const settings = first(query.settings) === "1";

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title={loaded.kind === "ok" ? loaded.reading.project.name : "פרוייקט"}
        subtitle={
          loaded.kind === "ok"
            ? `קופה סגורה ב־${loaded.reading.project.currency} · נפתחה ב־${formatDate(loaded.reading.project.startedOn)}`
            : "קופה סגורה"
        }
        back={{ href: "/projects", label: "חזרה לרשימת הפרוייקטים" }}
      />

      <main className="mt-7 space-y-5 sm:mt-9">
        <Notices error={first(query.error)} detail={first(query.detail)} done={first(query.done)} />

        {loaded.kind === "ok" ? (
          <>
            <Head reading={loaded.reading} today={loaded.rate} />

            <div className="rounded-card bg-surface shadow-card divide-line divide-y">
              <MovementsBand reading={loaded.reading} accounts={loaded.accounts} />
              <ValuationsBand reading={loaded.reading} />
            </div>

            <div className="space-y-2 px-1">
              <MappingLine
                reading={loaded.reading}
                accounts={loaded.accounts}
                snapshot={loaded.snapshot}
              />
              <Legend />
            </div>

            <SettingsSection
              reading={loaded.reading}
              accounts={loaded.accounts}
              open={settings}
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
      person: Person | null;
      reading: ProjectReading;
      accounts: readonly Account[];
      /** The most recent snapshot, for reading the project's account against it. */
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

    const [person, legs, expenses, distributions, valuations, terms, accounts, snapshots, rate] =
      await Promise.all([
        findPersonByEmail(email),
        loadFundingLegs(projects),
        loadProjectExpenses(projects),
        loadProjectDistributions(projects),
        loadProjectValuations(projects),
        loadDealTerms(),
        loadAccounts(),
        loadSnapshots(),
        findLatestRate("USD", "ILS"),
      ]);

    return {
      kind: "ok",
      person,
      reading: readProject({ project, legs, expenses, distributions, valuations, terms }),
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

// --- the head ----------------------------------------------------------------

/**
 * Five figures and one bar.
 *
 * The bar is deployed against the capital in the pot, which is the one thing the
 * old three stat cards were circling without saying: a project is 79% deployed
 * with $21,188 still waiting. Each figure answers one question and none stands in
 * for another — גויס is outside capital, יתרה is what is left to deploy, חולק
 * החוצה is what actually reached the household.
 */
function Head({ reading, today }: { reading: ProjectReading; today: DatedRate | null }) {
  const { pot, value, growth } = reading;
  const deployed = ratio(pot.spent, value.cost);

  return (
    <section className="rounded-card bg-surface shadow-card p-5 sm:p-7">
      {/* The lead figure is on its own line and twice the size of the rest. One
          number to land on, and the four that explain it underneath — rather than
          five of equal weight, which is a row of numbers and not an answer. */}
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div>
          <p className="text-[13px] text-stone-500">יתרה — טרם הושקע</p>
          <p className="figure mt-1 text-[40px] leading-none font-semibold sm:text-[46px]">
            <bdi>{format(pot.balance)}</bdi>
          </p>
        </div>

        <div className="min-w-[14rem] flex-1">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-stone-900/8"
            role="img"
            aria-label={
              deployed === null
                ? "טרם הוכנס הון לפרוייקט"
                : `${PERCENT.format(deployed)} מההון שבפרוייקט הושקע`
            }
          >
            <div
              className="h-full rounded-full bg-stone-900"
              style={{ inlineSize: `${Math.min(100, Math.max(0, (deployed ?? 0) * 100))}%` }}
            />
          </div>
          <p className="mt-2 text-[13px] text-stone-500">
            {deployed === null ? (
              "טרם הוכנס הון לפרוייקט."
            ) : (
              <>
                <span className="font-medium text-stone-900">{PERCENT.format(deployed)}</span> מההון
                שבקופה הושקע, מתוך <bdi className="tabular">{format(value.cost)}</bdi>
              </>
            )}
          </p>
        </div>
      </div>

      <dl className="mt-7 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <Figure label="גויס" amount={pot.funded} note="רגלי מימון" />
        <Figure label="הושקע" amount={pot.spent} note="הוצאות" />
        <Figure label="חולק החוצה" amount={pot.paidOut} note="הגיע לחשבונות" />
        <Figure
          label="שווי אחרון"
          amount={value.amount}
          note={
            value.valuation === null
              ? "בעלות — לא נרשם עדכון"
              : `${VALUE_BASIS_LABELS[value.basis]} · ${formatDate(value.valuation.statedOn)}`
          }
        />
      </dl>

      <div className="border-line mt-6 space-y-1.5 border-t pt-4 text-[13px] text-stone-500">
        <RateLine reading={reading} today={today} />
        {growth === null ? null : (
          <p>
            <span>תשואה עד כה: </span>
            <span
              className={`font-medium ${isNegative(growth.gain) ? "text-red-700" : "text-emerald-700"}`}
            >
              {growth.ratio === null ? format(growth.gain) : SIGNED_PERCENT.format(growth.ratio)}
            </span>{" "}
            — <bdi className="tabular">{format(growth.value)}</bdi> שווי ועוד{" "}
            <bdi className="tabular">{format(growth.paidOut)}</bdi> שחולקו, מול{" "}
            <bdi className="tabular">{format(growth.cost)}</bdi> שבתוכו. על פי{" "}
            <bdi>{growth.valuation.source}</bdi> ({VALUE_BASIS_LABELS[growth.valuation.basis]},{" "}
            {formatDate(growth.valuation.statedOn)}).
          </p>
        )}
      </div>
    </section>
  );
}

function Figure({ label, amount, note }: { label: string; amount: Money; note: string }) {
  return (
    <div>
      <dt className="text-[13px] text-stone-500">{label}</dt>
      <dd className="figure mt-0.5 text-[19px] font-medium">
        <bdi>{format(amount)}</bdi>
      </dd>
      <p className="mt-0.5 text-xs text-stone-400">{note}</p>
    </div>
  );
}

/** The effective rate and today's, in one line. The arithmetic is in the legend. */
function RateLine({ reading, today }: { reading: ProjectReading; today: DatedRate | null }) {
  const { effective } = reading;
  const standing = today === null ? null : againstToday(effective, today);

  if (effective.rate === null) {
    return <p className="text-stone-500">בפרוייקט הזה לא הומר מטבע, ולכן אין לו שער אפקטיבי.</p>;
  }

  return (
    <p>
      <span className="text-stone-500">שער אפקטיבי: </span>
      <RateFigure rate={effective.rate} />
      {standing === null ? (
        <> — אין שער שמור להיום להשוואה.</>
      ) : standing.standing === "same" || readsAsSameRate(standing.difference) ? (
        <>
          {" "}
          — זהה לשער היום (<RateFigure rate={standing.today.rate} />
          ).
        </>
      ) : (
        <>
          {" "}
          מול <RateFigure rate={standing.today.rate} /> היום, כלומר{" "}
          <span className="font-medium">
            {effective.direction?.to === "ILS"
              ? `קיבלנו ${standing.standing === "above" ? "יותר" : "פחות"} שקלים לדולר`
              : `שילמנו ${standing.standing === "above" ? "יותר" : "פחות"} שקלים לדולר`}
          </span>{" "}
          בהפרש של <RateFigure rate={Math.abs(standing.difference)} />.
        </>
      )}
    </p>
  );
}

/**
 * The one line that holds this screen against מיפוי: what the linked Account says
 * in the latest Snapshot, against what this project is worth.
 *
 * Nothing is written into the snapshot from here. A snapshot is taken by hand, and
 * this says which figure the hand should be writing.
 */
function MappingLine({
  reading,
  accounts,
  snapshot,
}: {
  reading: ProjectReading;
  accounts: readonly Account[];
  snapshot: Snapshot | null;
}) {
  const { project, value } = reading;
  const account = accounts.find((candidate) => candidate.id === project.accountId) ?? null;

  if (account === null) {
    return (
      <p className="text-[13px] text-stone-500">
        לא נבחר חשבון במיפוי שנושא את הפרוייקט הזה.{" "}
        <SettingsLink projectId={project.id}>בחירת חשבון</SettingsLink>
      </p>
    );
  }

  const line = snapshot === null ? undefined : findLine(snapshot, account.id);
  const expected: Money | null =
    snapshot === null
      ? value.amount
      : canConvertWithin(snapshot, value.amount.currency, account.currency)
        ? convertWithin(snapshot, value.amount, account.currency)
        : null;

  const head = (
    <>
      במיפוי: <bdi className="font-medium">{account.name}</bdi>
    </>
  );

  return (
    <p className="text-[13px] text-stone-500">
      <span>{head} — </span>
      {snapshot === null ? (
        <>עדיין לא נלקח שום צילום.</>
      ) : line === undefined ? (
        <>החשבון אינו מופיע בצילום של {formatDate(snapshot.takenOn)}.</>
      ) : isUnmeasured(line) ? (
        <>בצילום של {formatDate(snapshot.takenOn)} החשבון עדיין לא נמדד.</>
      ) : expected === null ? (
        <>
          הצילום של {formatDate(snapshot.takenOn)} אינו נושא שער שממיר{" "}
          <bdi>{value.amount.currency}</bdi> ל־<bdi>{account.currency}</bdi>.
        </>
      ) : equals(line.balance, expected) ? (
        <>
          בצילום של {formatDate(snapshot.takenOn)} רשום{" "}
          <bdi className="tabular">{format(line.balance)}</bdi> —{" "}
          <span className="font-medium text-emerald-800">בדיוק השווי.</span>
        </>
      ) : (
        <>
          בצילום של {formatDate(snapshot.takenOn)} רשום{" "}
          <bdi className="tabular">{format(line.balance)}</bdi>, והשווי באותו שער הוא{" "}
          <bdi className="tabular">{format(expected)}</bdi> — הפרש של{" "}
          <bdi className="tabular font-medium">{format(subtract(line.balance, expected))}</bdi>.
        </>
      )}
    </p>
  );
}

// --- the legend --------------------------------------------------------------

/**
 * Everything this screen used to argue, in one place and closed by default.
 *
 * Each of these was a paragraph above a band. They are the rules that make the
 * figures mean what they say, and they are worth reading once — which is exactly
 * why they are not printed four times beside the numbers they describe.
 */
function Legend() {
  return (
    <details className="group">
      <summary className="cursor-pointer text-[13px] text-stone-500 transition-colors hover:text-stone-900">
        <span className="inline-block transition-transform group-open:rotate-90" aria-hidden="true">
          ‹
        </span>{" "}
        איך המספרים האלה מחושבים
      </summary>
      <ul className="mt-3 max-w-prose space-y-2.5 text-[13px] leading-relaxed text-stone-500">
        <li>
          <span className="font-medium">יתרה</span> היא{" "}
          <bdi className="tabular">Σ(רגלי מימון) + Σ(חלוקות שגולגלו) − Σ(הוצאות)</bdi>, מחושבת בכל
          קריאה ואינה נשמרת בשום מקום. הוצאה גדולה מהיתרה נדחית: הכנסת כסף נוסף לקופה היא רגל מימון
          חדשה, ולא הוצאה גדולה יותר.
        </li>
        <li>
          <span className="font-medium">גויס</span> הוא הון מבחוץ בלבד. חלוקה שגולגלה בחזרה מגדילה
          את היתרה אבל אינה רגל מימון — רווח שהפרוייקט הפיק אינו הון שהוכנס, וספירתו כרגל הייתה
          מנפחת את מה שהבית שם בפנים.
        </li>
        <li>
          <span className="font-medium">בעמודת «לקופה»</span> חלוקה שיצאה מסומנת במקף ולא באפס. אפס
          היה אומר שהיא לא הזיזה כלום; המקף אומר שהכסף פשוט אינו בקופה אלא בחשבון שלצידה, שמיפוי
          כבר סופר אותו.
        </li>
        <li>
          <span className="font-medium">שער אפקטיבי</span> נגזר מהסכומים שנרשמו ולא ממוצע של שדות
          השער, ולכן חלוקת השקלים בדולרים מחזירה בדיוק את סכום השקלים. רגל שכבר הייתה במטבע הקופה לא
          המירה דבר ואינה נכללת בו — ושער שנרשם לצידה היה מספר שאיש לא השתמש בו.
        </li>
        <li>
          <span className="font-medium">העלות אינה יורדת</span> ככל שספר ההוצאות נמשך: המרת מזומן
          לנכס מזיזה כסף בתוך הקופה, והקופה עלתה מה שעלתה. עלות היא{" "}
          <bdi className="tabular">הושקע + יתרה</bdi>.
        </li>
        <li>
          <span className="font-medium">שווי אחרון</span> הוא עדכון השווי האחרון שנרשם, או העלות אם
          לא נרשם אף אחד. עדכון שווי הוא אירוע ולא קצב: שום דבר אינו מחשב בין שני עדכונים ושום דבר
          אינו ממשיך צמיחה שדווחה אל השנה הבאה.
        </li>
      </ul>
    </details>
  );
}

// --- the bands ---------------------------------------------------------------

/**
 * The frame all four bands share: a title, a figure beside it, and a table whose
 * `tfoot` is the add-row.
 *
 * The add-row's controls are associated with a form by `id` rather than nested
 * inside one, because a `<form>` cannot be a child of `<tbody>`. The browser
 * submits form-associated controls from wherever they sit, so the row types where
 * it reads — in the table's own columns, under the rows it is adding to.
 */
function Band({
  title,
  figure,
  columns,
  children,
}: {
  title: string;
  figure?: React.ReactNode;
  columns: readonly { label: string; align?: "end" | "start" }[];
  children: React.ReactNode;
}) {
  return (
    <section className="p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[13px] font-medium text-stone-500">{title}</h2>
        {figure === undefined ? null : <p className="text-[13px] text-stone-400">{figure}</p>}
      </div>

      {/* The gutter between columns is on the table rather than on each cell, so
          a narrow column's right-aligned header cannot end up touching the next
          column's left-aligned one. */}
      <div className="-mx-2 mt-3 overflow-x-auto px-2">
        <table className="w-full min-w-[42rem] text-sm [&_:is(td,th)]:px-3 [&_:is(td,th):first-child]:ps-0 [&_:is(td,th):last-child]:pe-0">
          <thead>
            {/* No rule under the header and no bold: the column labels are
                signposts, and a heavy header row competes with the figures it is
                labelling. */}
            <tr className="text-xs text-stone-400">
              {columns.map((column) => (
                <th
                  key={column.label}
                  className={`pb-2 font-normal ${column.align === "end" ? "text-end" : "text-start"}`}
                >
                  {column.label}
                </th>
              ))}
              <th className="pb-2" />
            </tr>
          </thead>
          {children}
        </table>
      </div>
    </section>
  );
}

/** An empty row, said in the table rather than in a paragraph beside it. */
function NoRows({ span, children }: { span: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={span + 1} className="py-4 text-stone-400">
        {children}
      </td>
    </tr>
  );
}

/**
 * The add-row's cells. Its fields carry the tint rather than the row: shading a
 * whole row says "these values are of a different kind", and what is actually
 * different here is that you can type into them.
 */
const CELL = "py-2";
const INPUT =
  "bg-sunken w-full rounded-lg px-2.5 py-1.5 text-sm text-stone-900 placeholder:text-stone-400 transition-colors hover:bg-stone-200/70";

function AddButton({ form, label }: { form: string; label: string }) {
  return (
    <button
      type="submit"
      form={form}
      aria-label={label}
      title={label}
      className="rounded-lg bg-stone-900 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-stone-700"
    >
      הוספה
    </button>
  );
}

/**
 * Shown on hover, and always on a touch screen.
 *
 * A הסרה button on every row is a column of buttons down the side of the table,
 * which is more ink than the figures carry. It appears when the pointer is on the
 * row it belongs to — and where there is no pointer, it is simply there.
 */
function RemoveButton({
  action,
  projectId,
  field,
  id,
}: {
  action: (form: FormData) => Promise<void>;
  projectId: string;
  field: string;
  id: string;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name={field} value={id} />
      <button
        type="submit"
        className="rounded-lg px-2 py-1 text-xs text-stone-400 opacity-100 transition group-hover/row:opacity-100 hover:bg-stone-900/5 hover:text-stone-900 focus-visible:opacity-100 [@media(hover:hover)]:opacity-0"
      >
        הסרה
      </button>
    </form>
  );
}

/** The amount and its currency, which are one fact and so are one field. */
function AmountCell({ form, currency, label }: { form: string; currency: Currency; label: string }) {
  return (
    <div className="bg-sunken flex items-center gap-1 rounded-lg ps-1 transition-colors hover:bg-stone-200/70">
      <select
        name="currency"
        form={form}
        defaultValue={currency}
        aria-label="מטבע"
        className="rounded-lg bg-transparent py-1.5 text-xs text-stone-500"
      >
        {CURRENCIES.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <input
        name="amount"
        form={form}
        required
        inputMode="decimal"
        dir="ltr"
        aria-label={label}
        className="tabular w-full rounded-lg bg-transparent px-2 py-1.5 text-end text-sm"
      />
    </div>
  );
}

/**
 * The rate field. Empty is the right answer whenever the money was already in the
 * pot's currency, which is most of the time — so the placeholder says so rather
 * than inviting a number nobody used.
 */
function RateCell({ form, currency }: { form: string; currency: Currency }) {
  return (
    <input
      name="rate"
      form={form}
      inputMode="decimal"
      dir="ltr"
      placeholder={`ריק אם ${currency}`}
      aria-label={`שער USD/ILS — רק אם המטבע אינו ${currency}`}
      className={`tabular ${INPUT} text-end placeholder:text-xs`}
    />
  );
}

function DateCell({ form, name = "paidOn", label }: { form: string; name?: string; label: string }) {
  return (
    <input
      type="date"
      name={name}
      form={form}
      defaultValue={dateKey(dateOf(new Date()))}
      aria-label={label}
      className={INPUT}
    />
  );
}

/** The form the add-row's controls belong to. Holds nothing but the project. */
function AddForm({
  id,
  action,
  projectId,
}: {
  id: string;
  action: (form: FormData) => Promise<void>;
  projectId: string;
}) {
  return (
    <form id={id} action={action} className="hidden">
      <input type="hidden" name="projectId" value={projectId} />
    </form>
  );
}

// --- the three ledgers, as one band ------------------------------------------

const MOVEMENT_FORM = "add-movement";

const KIND_LABELS: Record<MovementKind, string> = {
  leg: "מימון",
  expense: "הוצאה",
  distribution: "חלוקה",
};

/**
 * A 6px dot, and no chip.
 *
 * The kind has to be scannable down twenty rows, and a filled badge per row is a
 * column of colour running beside figures that carry none. A dot is the least ink
 * that still lets the eye group them.
 */
const KIND_DOTS: Record<MovementKind, string> = {
  leg: "bg-emerald-500",
  expense: "bg-amber-500",
  distribution: "bg-sky-500",
};

const REMOVE: Record<MovementKind, { action: (form: FormData) => Promise<void>; field: string }> = {
  leg: { action: removeFundingLeg, field: "legId" },
  expense: { action: removeExpense, field: "expenseId" },
  distribution: { action: removeDistribution, field: "distributionId" },
};

/**
 * Everything that ever moved in this project, oldest first, in one table.
 *
 * Three ledgers with three forms under them made three places to look and three
 * places to type for what is one history. The kind became a column, and the one
 * entry row's first field is the kind — so recording anything is the same
 * gesture, and the rows read as the story they are.
 *
 * Nothing about the three rules merged with the tables. A leg is still the only
 * way outside money gets in, an expense is still refused when the pot cannot pay
 * for it, and a distribution still writes nothing into the Account it names.
 */
function MovementsBand({
  reading,
  accounts,
}: {
  reading: ProjectReading;
  accounts: readonly Account[];
}) {
  const { project, movements } = reading;
  const nameOf = (id: string) => accounts.find((account) => account.id === id)?.name ?? id;

  return (
    <>
      <Band
        title="תנועות"
        figure={
          movements.length === 0 ? null : (
            <>
              {movements.length} שורות · יתרה{" "}
              <bdi className="tabular font-medium">{format(reading.pot.balance)}</bdi>
            </>
          )
        }
        columns={[
          { label: "סוג" },
          { label: "מה" },
          { label: "תאריך" },
          { label: "כפי ששולם", align: "end" },
          { label: "שער", align: "end" },
          { label: "לקופה", align: "end" },
        ]}
      >
        <tbody className="divide-line divide-y">
          {movements.length === 0 ? (
            <NoRows span={6}>
              עדיין לא נרשמה שום תנועה. כל כסף שנכנס לקופה הוא רגל מימון עם מקור.
            </NoRows>
          ) : (
            movements.map((movement) => (
              <MovementRow
                key={movement.id}
                movement={movement}
                project={project}
                accountName={
                  movement.destination?.kind === "out"
                    ? nameOf(movement.destination.accountId)
                    : null
                }
              />
            ))
          )}
        </tbody>
        <tfoot className="border-line border-t">
          <tr>
            <td className={CELL}>
              <select
                name="kind"
                form={MOVEMENT_FORM}
                defaultValue="leg"
                aria-label="סוג התנועה"
                className={INPUT}
              >
                <option value="leg">מימון</option>
                <option value="expense">הוצאה</option>
                {/* The destination rides inside the kind: "a חלוקה" is not a
                    complete answer, and a field for it would sit dead on the
                    screen for two choices out of three. */}
                <optgroup label="חלוקה">
                  <option value="distribution:rolled">גולגלה בחזרה לקופה</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={`distribution:out:${account.id}`}>
                      יצאה אל {account.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </td>
            <td className={CELL}>
              <input
                name="description"
                form={MOVEMENT_FORM}
                required
                maxLength={120}
                placeholder="Apple RSU / רכישת הקרקע"
                aria-label="מה"
                className={INPUT}
              />
            </td>
            <td className={CELL}>
              <DateCell form={MOVEMENT_FORM} label="תאריך" />
            </td>
            <td className={CELL}>
              <AmountCell form={MOVEMENT_FORM} currency={project.currency} label="סכום" />
            </td>
            <td className={CELL}>
              <RateCell form={MOVEMENT_FORM} currency={project.currency} />
            </td>
            <td className={CELL} />
            <td className={`${CELL} text-end`}>
              <AddButton form={MOVEMENT_FORM} label="רישום תנועה" />
            </td>
          </tr>
        </tfoot>
      </Band>
      <AddForm id={MOVEMENT_FORM} action={addMovement} projectId={project.id} />
    </>
  );
}

function MovementRow({
  movement,
  project,
  accountName,
}: {
  movement: ProjectMovement;
  project: Project;
  accountName: string | null;
}) {
  const remove = REMOVE[movement.kind];

  return (
    <tr className="group/row">
      <td className="py-2.5 whitespace-nowrap">
        <span
          className={`me-2 inline-block size-1.5 rounded-full align-middle ${KIND_DOTS[movement.kind]}`}
          aria-hidden="true"
        />
        <span className="text-stone-500">{KIND_LABELS[movement.kind]}</span>
        {movement.destination === null ? null : (
          <span className="text-stone-400">
            {accountName === null ? (
              " ↩ בחזרה לקופה"
            ) : (
              <>
                {" ← "}
                <bdi>{accountName}</bdi>
              </>
            )}
          </span>
        )}
      </td>
      <td className="py-2.5">
        <bdi>{movement.description}</bdi>
      </td>
      <td className="py-2.5 whitespace-nowrap text-stone-500">{formatDate(movement.paidOn)}</td>
      <td className="tabular py-2.5 text-end">
        <bdi>{format(movement.amount)}</bdi>
      </td>
      <td className="tabular py-2.5 text-end text-stone-400">
        {movement.rate === null ? <span>—</span> : <RateFigure rate={movement.rate.rate} />}
      </td>
      <td className="tabular py-2.5 text-end">
        <PotEffect effect={movement.effect} />
      </td>
      <td className="py-2.5 text-end">
        <RemoveButton
          action={remove.action}
          projectId={project.id}
          field={remove.field}
          id={movement.id}
        />
      </td>
    </tr>
  );
}

/**
 * What the row did to the balance. A distribution that was taken shows a dash and
 * not a zero: zero would say it moved nothing, and the truth is that the balance
 * is not where that money is — it is in the Account named beside it, which מיפוי
 * already counts.
 */
function PotEffect({ effect }: { effect: Money | null }) {
  if (effect === null) return <span className="text-stone-300">—</span>;
  // Monochrome, both directions. The sign says which way it went; colouring it as
  // well would be saying it twice, in the loudest way a table has.
  return <bdi>{format(effect, { withSign: true })}</bdi>;
}

// --- valuations --------------------------------------------------------------

const VALUATION_FORM = "add-valuation";

/**
 * What the project is said to be worth, newest first — the opposite of the three
 * ledgers above, because only the first row is read and the rest are its history.
 *
 * Nothing sums this band. These are statements, not movements.
 */
function ValuationsBand({ reading }: { reading: ProjectReading }) {
  const { project, valuations, value } = reading;

  return (
    <>
      <Band
        title="עדכוני שווי"
        figure={
          value.valuation === null ? (
            <>נקרא בעלות</>
          ) : (
            <>
              נקרא <bdi className="tabular font-medium">{format(value.amount)}</bdi>
            </>
          )
        }
        columns={[
          { label: "שווי", align: "end" },
          { label: "תאריך" },
          { label: "בסיס" },
          { label: "מקור" },
        ]}
      >
        <tbody className="divide-line divide-y">
          {valuations.length === 0 ? (
            <NoRows span={4}>
              לא נרשם עדכון שווי, ולכן הפרוייקט נקרא בעלות — <bdi className="tabular">{format(value.cost)}</bdi>.
            </NoRows>
          ) : (
            valuations.map((valuation, index) => (
              <ValuationRow
                key={valuation.id}
                valuation={valuation}
                project={project}
                inForce={index === 0}
              />
            ))
          )}
        </tbody>
        <tfoot className="border-line border-t">
          <tr>
            <td className={CELL}>
              <input
                name="amount"
                form={VALUATION_FORM}
                required
                inputMode="decimal"
                dir="ltr"
                aria-label={`שווי ב־${project.currency}`}
                className={`tabular ${INPUT} text-end`}
              />
            </td>
            <td className={CELL}>
              <DateCell form={VALUATION_FORM} name="statedOn" label="תאריך ההצהרה" />
            </td>
            <td className={CELL}>
              <select
                name="basis"
                form={VALUATION_FORM}
                defaultValue="market"
                aria-label="בסיס השווי"
                className={INPUT}
              >
                <option value="market">{VALUE_BASIS_LABELS.market}</option>
                <option value="estimate">{VALUE_BASIS_LABELS.estimate}</option>
              </select>
            </td>
            <td className={CELL}>
              <input
                name="source"
                form={VALUATION_FORM}
                required
                maxLength={160}
                placeholder="שמאות / דוח היזם"
                aria-label="מקור — איזה מסמך או מי אמר"
                className={INPUT}
              />
            </td>
            <td className={`${CELL} text-end`}>
              <AddButton form={VALUATION_FORM} label="רישום עדכון שווי" />
            </td>
          </tr>
        </tfoot>
      </Band>
      <AddForm id={VALUATION_FORM} action={addValuation} projectId={project.id} />
    </>
  );
}

function ValuationRow({
  valuation,
  project,
  inForce,
}: {
  valuation: ProjectValuation;
  project: Project;
  inForce: boolean;
}) {
  return (
    <tr className={`group/row ${inForce ? "" : "text-stone-400"}`}>
      <td className="tabular py-2.5 text-end">
        <bdi className={inForce ? "font-medium" : undefined}>{format(valuation.amount)}</bdi>
      </td>
      <td className="py-2.5 whitespace-nowrap">
        <span className={inForce ? "text-stone-500" : undefined}>
          {formatDate(valuation.statedOn)}
        </span>
        {inForce ? <span className="ms-2 text-xs text-stone-400">נקרא כעת</span> : null}
      </td>
      <td className={`py-2.5 ${inForce ? "text-stone-500" : ""}`}>
        {VALUE_BASIS_LABELS[valuation.basis]}
      </td>
      <td className={`py-2.5 ${inForce ? "text-stone-500" : ""}`}>
        <bdi>{valuation.source}</bdi>
      </td>
      <td className="py-2.5 text-end">
        <RemoveButton
          action={removeValuation}
          projectId={project.id}
          field="valuationId"
          id={valuation.id}
        />
      </td>
    </tr>
  );
}

// --- settings ----------------------------------------------------------------

function settingsHref(projectId: string): Route {
  return `/projects/${projectId}?settings=1#${SETTINGS_ID}` as Route;
}

function SettingsLink({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  return (
    <Link href={settingsHref(projectId)} className="underline underline-offset-4">
      {children}
    </Link>
  );
}

/**
 * תנאי העסקה and הגדרת הפרוייקט, behind a toggle — as ניהול קטגוריות is in מאזן.
 *
 * Both are set once a project and read rarely, and both are forms rather than
 * figures. Open by default they were two screenfuls between the person and the
 * rows they came to read.
 */
function SettingsSection({
  reading,
  accounts,
  open,
}: {
  reading: ProjectReading;
  accounts: readonly Account[];
  open: boolean;
}) {
  const { project, terms } = reading;

  if (!open) {
    return (
      <p className="text-sm text-stone-600" id={SETTINGS_ID}>
        <SettingsLink projectId={project.id}>תנאי העסקה והגדרת הפרוייקט</SettingsLink> —{" "}
        {terms === null || !statesAnything(terms)
          ? "לא נרשמו תנאי עסקה."
          : `תנאי העסקה נרשמו ב־${formatDate(terms.recordedOn)}.`}{" "}
        שם הפרוייקט, תאריך הפתיחה והחשבון במיפוי נקבעים שם גם כן.
      </p>
    );
  }

  return (
    <div className="space-y-6" id={SETTINGS_ID}>
      <div className="flex justify-end">
        <Link
          href={`/projects/${project.id}` as Route}
          className="text-sm text-stone-600 underline underline-offset-4"
        >
          סגירת ההגדרות
        </Link>
      </div>
      <TermsPanel reading={reading} />
      <DefinitionPanel reading={reading} accounts={accounts} />
    </div>
  );
}

function TermsPanel({ reading }: { reading: ProjectReading }) {
  const { project, terms } = reading;

  return (
    <section className="rounded-card bg-surface shadow-card p-5 sm:p-6">
      <h2 className="text-[13px] font-medium text-stone-500">תנאי העסקה</h2>
      <p className="mt-1 text-sm text-stone-600">
        מה שהיזם הצהיר שהפרוייקט יחזיר, נרשם מהמסמכים שלו. הבטחה ולא מדידה: שום מספר במערכת אינו
        נגזר ממנה, והיא נקראת רק בתרחישים.
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
            className={`tabular ${FIELD} text-end`}
          />
        </Field>

        <Field label="תקופת החזקה (חודשים)">
          <input
            name="holdMonths"
            inputMode="numeric"
            dir="ltr"
            defaultValue={terms?.holdMonths == null ? "" : String(terms.holdMonths)}
            className={`tabular ${FIELD} text-end`}
          />
        </Field>

        <Field label="דפוס חלוקות" note="במילים של היזם">
          <input
            name="distribution"
            maxLength={200}
            defaultValue={terms?.distribution ?? ""}
            className={FIELD}
          />
        </Field>

        <Field label="מקור" note="איזה מסמך נקרא">
          <input
            name="source"
            maxLength={120}
            defaultValue={terms?.source ?? ""}
            className={FIELD}
          />
        </Field>

        <Field label="תאריך הרישום">
          <input
            type="date"
            name="recordedOn"
            defaultValue={dateKey(terms?.recordedOn ?? dateOf(new Date()))}
            className={FIELD}
          />
        </Field>

        <div className="flex items-end">
          <button
            type="submit"
            className={PRIMARY_BUTTON}
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

function DefinitionPanel({
  reading,
  accounts,
}: {
  reading: ProjectReading;
  accounts: readonly Account[];
}) {
  const { project } = reading;

  return (
    <section className="rounded-card bg-surface shadow-card p-5 sm:p-6">
      <h2 className="text-[13px] font-medium text-stone-500">הגדרת הפרוייקט</h2>

      <form action={editProject} className="mt-4 grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="projectId" value={project.id} />

        <Field label="שם הפרוייקט">
          <input
            name="name"
            defaultValue={project.name}
            required
            maxLength={60}
            className={FIELD}
          />
        </Field>

        <Field label="תאריך פתיחה">
          <input
            type="date"
            name="startedOn"
            defaultValue={dateKey(project.startedOn)}
            required
            className={FIELD}
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
            className={PRIMARY_BUTTON}
          >
            שמירה
          </button>
        </div>
      </form>

      <p className="mt-3 text-xs text-stone-500">
        מטבע הקופה (<bdi>{project.currency}</bdi>) אינו ניתן לשינוי — שינוי שלו היה משנה את המטבע של
        כל רגל וכל הוצאה שכבר נרשמו בו, ואת המשמעות של השער הרשום לצידן.{" "}
        <Link href="/accounts" className="underline underline-offset-4">
          ניהול החשבונות
        </Link>
      </p>
    </section>
  );
}
