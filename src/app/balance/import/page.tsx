import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { DatabaseNotConfiguredError } from "@/db/client";
import { SheetExportMissingError, countRecorded } from "@/db/import";
import { type Person, findPersonByEmail } from "@/db/people";
import {
  type ImportFlag,
  type ImportProposal,
  type ProposedCategory,
  type TotalCheck,
  conflictKey,
} from "@/domain/import/sheet-importer";
import { type Money, format } from "@/domain/money/money";
import { formatMonth, monthKey } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { type ImportErrorCode, runImport } from "./actions";
import { loadProposal } from "./proposal";

export const dynamic = "force-dynamic";

/**
 * Reviewing the sheet import before any of it is written.
 *
 * The screen exists because the importer guesses. Which household line a category
 * joins, whether a row that the sheet keeps outside its own totals is really an
 * expense, and which of two overlapping tabs is right about a month are all
 * judgements, and this is where a person makes them. Nothing on this page has
 * been written; the button at the bottom is the only thing that writes.
 *
 * The screen is disposable along with the importer. It is not linked from the
 * dashboard — only from the מאזן — because it is run once, not used.
 */

interface SearchParams {
  error?: string | string[];
  detail?: string | string[];
  done?: string | string[];
  categories?: string | string[];
  entries?: string | string[];
  months?: string | string[];
  from?: string | string[];
  to?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ImportPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const loaded = await load(email);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="ייבוא מהגיליון"
        subtitle="הצעה לבדיקה — שום דבר עדיין לא נכתב"
        back={{ href: "/balance", label: "חזרה למאזן" }}
      />

      <main className="mt-6 space-y-8 sm:mt-8">
        <Notices params={params} />

        {loaded.kind === "ok" ? (
          <ReviewForm
            proposal={loaded.proposal}
            people={loaded.people}
            recorded={loaded.recorded}
          />
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
      proposal: ImportProposal;
      recorded: { categories: number; entries: number };
    }
  | { kind: "unavailable"; reason: string };

async function load(email: string): Promise<Loaded> {
  try {
    const person = await findPersonByEmail(email);
    if (person === null) {
      return {
        kind: "unavailable",
        reason: `הכתובת ${email} אינה משויכת לאף אדם בטבלת people. יש לעדכן את שתי הכתובות במסד (ראו README).`,
      };
    }
    const [{ proposal, people }, recorded] = await Promise.all([loadProposal(), countRecorded()]);
    return { kind: "ok", person, people, proposal, recorded };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    if (error instanceof SheetExportMissingError) {
      return { kind: "unavailable", reason: `קובץ הייצוא של הגיליון לא נמצא בנתיב ${error.path}.` };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- the form ----------------------------------------------------------------

function ReviewForm({
  proposal,
  people,
  recorded,
}: {
  proposal: ImportProposal;
  people: readonly Person[];
  recorded: { categories: number; entries: number };
}) {
  const conflicts = proposal.flags.filter((flag) => flag.kind === "overlap-conflict");
  const disagreeing = proposal.totals.filter((total) => !total.agrees);

  // Fields are numbered by position rather than named after the category: a
  // category name may hold a double quote (שכ"ד, חו"ל), and a quote inside a
  // multipart field name truncates it, losing the field without any error. The
  // counts let the action refuse a form that no longer matches the proposal.
  const numbered = proposal.categories.map((category, index) => ({ category, index }));

  return (
    <form action={runImport} className="space-y-8">
      <input type="hidden" name="categoryCount" value={proposal.categories.length} />
      <input type="hidden" name="conflictCount" value={conflicts.length} />

      <SummaryPanel proposal={proposal} recorded={recorded} />

      <TotalsPanel totals={proposal.totals} disagreeing={disagreeing} people={people} />

      {conflicts.length === 0 ? null : <ConflictsPanel conflicts={conflicts} people={people} />}

      <NotesPanel flags={proposal.flags} />

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">קטגוריות מוצעות</h2>
          <p className="mt-1 text-sm text-stone-600">
            כל שורה כאן היא הצעה. הסימון קובע אם הקטגוריה תיווצר, והשם המשותף קובע לאיזו קטגוריה
            משותפת היא תשויך — שתי קטגוריות אישיות שיקבלו את אותו שם משותף ייקראו כשורה אחת ברמת
            משק הבית. השמות האישיים אינם משתנים.
          </p>
        </div>

        {people.map((person) => (
          <PersonCategories
            key={person.id}
            person={person}
            rows={numbered.filter(({ category }) => category.personId === person.id)}
          />
        ))}
      </section>

      <div className="flex flex-wrap items-center gap-4 border-t border-stone-300 pt-6">
        <button
          type="submit"
          className="rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
        >
          ייבוא הסימון הזה
        </button>
        <p className="text-sm text-stone-600">
          אפשר לייבא שוב אחרי תיקון — ייבוא חוזר מעדכן את אותם רישומים ואינו יוצר כפילויות.
        </p>
      </div>
    </form>
  );
}

function SummaryPanel({
  proposal,
  recorded,
}: {
  proposal: ImportProposal;
  recorded: { categories: number; entries: number };
}) {
  const included = proposal.categories.filter((category) => category.included).length;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5">
      <h2 className="text-lg font-semibold">מה נמצא בגיליון</h2>

      <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact
          label="טווח"
          value={
            proposal.span === null
              ? "אין נתונים"
              : `${formatMonth(proposal.span.from)} – ${formatMonth(proposal.span.to)}`
          }
        />
        <Fact label="קטגוריות מוצעות" value={`${included} מתוך ${proposal.categories.length}`} />
        <Fact label="רישומים" value={String(proposal.entries.length)} />
        <Fact
          label="כבר רשום במערכת"
          value={`${recorded.categories} קטגוריות, ${recorded.entries} רישומים`}
        />
      </dl>

      {recorded.entries === 0 ? null : (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          כבר יש רישומים במערכת. ייבוא יכתוב מחדש כל חודש־קטגוריה שמופיע בגיליון, ולא ייגע בשאר.
        </p>
      )}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-stone-500">{label}</dt>
      <dd className="mt-0.5 font-medium">
        <bdi>{value}</bdi>
      </dd>
    </div>
  );
}

/** The check that says the import is faithful: our arithmetic against the sheet's own. */
function TotalsPanel({
  totals,
  disagreeing,
  people,
}: {
  totals: readonly TotalCheck[];
  disagreeing: readonly TotalCheck[];
  people: readonly Person[];
}) {
  const agreeing = totals.length - disagreeing.length;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">בדיקה מול הסכומים של הגיליון</h2>
        <p className="mt-1 text-sm text-stone-600">
          לכל חודש חושבו ההוצאות מחדש מתוך השורות שייובאו, והושוו לשורת <bdi>סה&quot;כ הוצאות</bdi>{" "}
          של הגיליון עצמו.
        </p>
      </div>

      <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
        {agreeing} מתוך {totals.length} סכומים חודשיים מתאימים לאגורה.
      </p>

      {disagreeing.length === 0 ? null : (
        <div className="overflow-x-auto rounded-lg border border-amber-300 bg-amber-50">
          <table className="w-full min-w-md text-sm">
            <caption className="p-3 text-start text-amber-900">
              החודשים שבהם הגיליון לא מסתדר עם עצמו. הסכום שלנו הוא סכום השורות; ההפרש מוצג כדי
              שאפשר יהיה לתקן ידנית במסך המאזן.
            </caption>
            <thead className="border-y border-amber-300 text-start">
              <tr>
                <Th>חודש</Th>
                <Th>אדם</Th>
                <Th>בגיליון</Th>
                <Th>אצלנו</Th>
                <Th>הפרש</Th>
              </tr>
            </thead>
            <tbody>
              {disagreeing.map((total) => (
                <tr key={`${total.personId}@${monthKey(total.month)}`} className="border-b border-amber-200">
                  <Td>{formatMonth(total.month)}</Td>
                  <Td>{displayName(people, total.personId)}</Td>
                  <Td>
                    <Amount amount={total.stated} />
                  </Td>
                  <Td>
                    <Amount amount={total.recomputed} />
                  </Td>
                  <Td>
                    <Amount amount={total.difference} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Where two tabs give one month two different figures, a person picks. */
function ConflictsPanel({
  conflicts,
  people,
}: {
  conflicts: readonly Extract<ImportFlag, { kind: "overlap-conflict" }>[];
  people: readonly Person[];
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">חודשים ששני לשוניות חלוקות עליהם</h2>
        <p className="mt-1 text-sm text-stone-600">
          ינואר–יוני 2025 מופיעים גם בלשונית 2024 וגם בלשונית 2025. איפה שהן מסכימות נשמר רישום
          אחד בשקט; כאן הן לא מסכימות. ברירת המחדל היא הלשונית שהשנה שלה היא שנת החודש.
        </p>
      </div>

      <ul className="space-y-3">
        {conflicts.map((conflict, index) => {
          const key = conflictKey(conflict.categoryKey, conflict.month);
          return (
            <li key={key} className="rounded-lg border border-stone-300 bg-white p-4">
              <p className="font-medium">
                <bdi>{conflict.label}</bdi>
                <span className="text-stone-500">
                  {" · "}
                  {displayName(people, conflict.personId)}
                  {" · "}
                  {formatMonth(conflict.month)}
                </span>
              </p>

              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                <Choice
                  name={`conflict:${index}`}
                  value={conflict.kept.minorUnits}
                  defaultChecked
                  amount={conflict.kept}
                  source={conflict.keptFrom}
                />
                <Choice
                  name={`conflict:${index}`}
                  value={conflict.discarded.minorUnits}
                  defaultChecked={false}
                  amount={conflict.discarded}
                  source={conflict.discardedFrom}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Choice({
  name,
  value,
  defaultChecked,
  amount,
  source,
}: {
  name: string;
  value: number;
  defaultChecked: boolean;
  amount: Money;
  source: string;
}) {
  const id = `${name}#${value}`;
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="size-4"
      />
      <span>
        <Amount amount={amount} />
        <span className="text-stone-500">
          {" · "}
          <bdi>{source}</bdi>
        </span>
      </span>
    </label>
  );
}

/** Everything the importer decided not to read, with the reason it did not. */
function NotesPanel({ flags }: { flags: readonly ImportFlag[] }) {
  const notes = flags.filter((flag) => flag.kind !== "overlap-conflict").map(describe);
  if (notes.length === 0) return null;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">מה לא נקרא, ולמה</h2>
        <p className="mt-1 text-sm text-stone-600">
          כל דבר שהייבוא לא קרא מופיע כאן עם הסיבה, במקום פשוט להיעדר.
        </p>
      </div>

      <ul className="space-y-2">
        {notes.map((note, index) => (
          <li
            key={`${note}#${index}`}
            className="rounded-md border border-stone-300 bg-white p-3 text-sm text-stone-700"
          >
            <bdi>{note}</bdi>
          </li>
        ))}
      </ul>
    </section>
  );
}

function describe(flag: ImportFlag): string {
  switch (flag.kind) {
    case "error-cell":
      return `שגיאת נוסחה ${flag.text} אצל ${flag.owner}, בשורה "${flag.label}" בחודש ${formatMonth(flag.month)}. התא לא יובא, והחודש הזה יסומן כלא־רשום עד שיתוקן ידנית.`;
    case "unreadable-cell":
      return `בשורה "${flag.label}" אצל ${flag.owner} יש טקסט במקום סכום בחודש ${formatMonth(flag.month)}: "${flag.text}". התא לא יובא.`;
    case "derived-block-skipped":
      return `הבלוק "${flag.banner}" לא יובא. ${flag.reason}`;
    case "unknown-owner":
      return `הבלוק "${flag.banner}" שייך ל"${flag.owner}", שאינו אחד משני האנשים במשק הבית. לא יובא.`;
    case "unrecorded-tail":
      return `בבלוק "${flag.banner}" אין נתונים מ־${formatMonth(flag.from)} והלאה. אפסים של נוסחה בחודשים שטרם הגיעו אינם רישום של אפס, ולכן לא יובאו.`;
    case "similar-names":
      return `השמות "${flag.left}" ו"${flag.right}" כמעט זהים ולא אוחדו. אם זו אותה קטגוריה, אפשר לתת לשתיהן את אותו שם משותף כאן.`;
    default:
      return "";
  }
}

// --- the categories ----------------------------------------------------------

function PersonCategories({
  person,
  rows,
}: {
  person: Person;
  rows: readonly { category: ProposedCategory; index: number }[];
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
        לא נמצאו שורות עבור <bdi>{person.displayName}</bdi> בגיליון.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <h3 className="font-semibold">
        השורות של <bdi>{person.displayName}</bdi>
      </h3>

      <div className="overflow-x-auto rounded-lg border border-stone-300 bg-white">
        <table className="w-full min-w-2xl text-sm">
          <thead className="border-b border-stone-300">
            <tr>
              <Th>ייבוא</Th>
              <Th>שם אישי</Th>
              <Th>סוג</Th>
              <Th>חודשים</Th>
              <Th>תקופה</Th>
              <Th>שם משותף</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ category, index }) => (
              <tr key={category.key} className="border-b border-stone-200 last:border-b-0 align-top">
                <Td>
                  <input
                    id={`include-${index}`}
                    type="checkbox"
                    name={`include:${index}`}
                    value="1"
                    defaultChecked={category.included}
                    className="size-4"
                  />
                </Td>
                <Td>
                  <label htmlFor={`include-${index}`} className="font-medium">
                    <bdi>{category.name}</bdi>
                  </label>
                  {category.excludedReason === null ? null : (
                    <p className="mt-1 max-w-md text-xs text-stone-500">{category.excludedReason}</p>
                  )}
                  {category.name === category.sheetLabel ? null : (
                    <p className="mt-1 text-xs text-stone-500">
                      מהשורה <bdi>{category.sheetLabel}</bdi>
                    </p>
                  )}
                </Td>
                <Td>{category.type === "income" ? "הכנסה" : "הוצאה"}</Td>
                <Td className="tabular">{category.entryCount}</Td>
                <Td className="tabular whitespace-nowrap">
                  {monthKey(category.activeFrom)}
                  {category.activeUntil === null ? " →" : ` – ${monthKey(category.activeUntil)}`}
                </Td>
                <Td>
                  <input
                    type="text"
                    name={`household:${index}`}
                    defaultValue={category.householdName}
                    maxLength={60}
                    autoComplete="off"
                    aria-label={`שם משותף עבור ${category.name}`}
                    className="w-44 rounded-md border border-stone-300 px-2 py-1"
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- small pieces ------------------------------------------------------------

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-start font-medium text-stone-600">{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}

function Amount({ amount }: { amount: Money }) {
  return <bdi className="tabular">{format(amount)}</bdi>;
}

function displayName(people: readonly Person[], personId: string): string {
  return people.find((person) => person.id === personId)?.displayName ?? personId;
}

// --- notices -----------------------------------------------------------------

const ERROR_MESSAGES: Record<ImportErrorCode, string> = {
  "no-person": "הכתובת שאיתה נכנסת אינה משויכת לאף אדם בטבלת people.",
  "no-export": "קובץ הייצוא של הגיליון לא נמצא.",
  "nothing-selected": "לא נבחרה אף קטגוריה, ולכן לא נכתב דבר.",
  "no-database": "משתנה הסביבה DATABASE_URL אינו מוגדר.",
  "stale-form": "הטופס נשלח מהצעה ישנה יותר מזו שבקובץ. שום דבר לא נכתב — יש לרענן ולסמן שוב.",
  failed: "הייבוא נכשל. שום דבר לא נכתב — הכול רץ בטרנזקציה אחת.",
};

function isErrorCode(value: string | undefined): value is ImportErrorCode {
  return value !== undefined && value in ERROR_MESSAGES;
}

function Notices({ params }: { params: SearchParams }) {
  const error = first(params.error);
  if (isErrorCode(error)) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-4" role="alert">
        <p className="font-medium text-red-900">{ERROR_MESSAGES[error]}</p>
        {first(params.detail) === undefined ? null : (
          <p className="mt-1 text-sm text-red-800">
            <bdi>{first(params.detail)}</bdi>
          </p>
        )}
      </div>
    );
  }

  if (first(params.done) !== "1") return null;

  const from = first(params.from);
  const to = first(params.to);

  return (
    <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4" role="status">
      <p className="font-medium text-emerald-900">הייבוא הושלם.</p>
      <p className="mt-1 text-sm text-emerald-800">
        נכתבו <bdi className="tabular">{first(params.entries)}</bdi> רישומים על פני{" "}
        <bdi className="tabular">{first(params.months)}</bdi> חודשים, ב־
        <bdi className="tabular">{first(params.categories)}</bdi> קטגוריות
        {from === undefined || to === undefined ? "" : ` (${from} – ${to})`}.
      </p>
      <p className="mt-2 text-sm">
        <Link href="/balance" className="text-emerald-900 underline underline-offset-4">
          קריאת החודשים במאזן
        </Link>
      </p>
    </div>
  );
}

function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן להכין את הייבוא</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}
