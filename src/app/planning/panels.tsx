import Link from "next/link";

import { type Categories } from "@/domain/categories/categories";
import { type Ledger, recordedMonths } from "@/domain/ledger/ledger";
import { format } from "@/domain/money/money";
import { type ClosureBasis, type SavingPace, savingPace } from "@/domain/planning/scenarios";
import { formatMonth, monthOf } from "@/domain/time/calendar-month";

import { type PlanningErrorCode } from "./actions";

/**
 * The pieces both לוח תכנון screens share. The list and one scenario are written by
 * the same actions and read by the same functions, so they report the same failures
 * in the same words and cannot disagree about the household's saving pace.
 */

const ERROR_MESSAGES: Record<PlanningErrorCode, string> = {
  "no-person": "הכתובת שאיתה נכנסת אינה משויכת לאף אדם בטבלת people.",
  "bad-scenario": "פרטי התרחיש אינם תקינים.",
  "duplicate-name": "כבר קיים תרחיש בשם הזה.",
  "unknown-scenario": "התרחיש אינו קיים.",
  "bad-plan": "פרטי תוכנית המימון אינם תקינים.",
  "bad-source": "פרטי המקור אינם תקינים.",
  "duplicate-source": "כבר קיים מקור בשם הזה בתרחיש.",
  failed: "הפעולה נכשלה.",
};

const DONE_MESSAGES: Record<string, string> = {
  created: "נוצר תרחיש",
  "created-seeded": "נוצר תרחיש, ונזרע מהמספרים הרשומים",
  saved: "התרחיש נשמר",
  removed: "התרחיש הוסר",
  "plan-saved": "תוכנית המימון נשמרה",
  "source-added": "נוסף מקור",
  "source-removed": "המקור הוסר",
};

function isErrorCode(value: string | undefined): value is PlanningErrorCode {
  return value !== undefined && value in ERROR_MESSAGES;
}

export function Notices({
  error,
  detail,
  done,
}: {
  error: string | undefined;
  detail: string | undefined;
  done: string | undefined;
}) {
  if (isErrorCode(error)) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-4" role="alert">
        <p className="font-medium text-red-900">{ERROR_MESSAGES[error]}</p>
        {detail === undefined ? null : (
          <p className="mt-1 text-sm text-red-800">
            <bdi>{detail}</bdi>
          </p>
        )}
      </div>
    );
  }

  if (done === undefined) return null;

  const [verb = "", name = ""] = done.split(":");
  const text = DONE_MESSAGES[verb] ?? "התרחיש נשמר";

  return (
    <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4" role="status">
      <p className="font-medium text-emerald-900">
        {text}
        {name.length === 0 ? null : (
          <>
            : <bdi>{name}</bdi>
          </>
        )}
      </p>
    </div>
  );
}

export function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן לקרוא את לוח התכנון</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}

export function Field({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-stone-700">{label}</span>
      {note === undefined ? null : <span className="block text-xs text-stone-500">{note}</span>}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

export function Select({
  name,
  defaultValue,
  children,
}: {
  name: string;
  defaultValue: string;
  children: React.ReactNode;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue}
      className="w-full rounded-md border border-stone-300 bg-white px-3 py-2"
    >
      {children}
    </select>
  );
}

export function Figure({
  label,
  amount,
  note,
  emphasis = false,
}: {
  label: string;
  amount: string;
  note?: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className={`tabular mt-1 ${emphasis ? "text-xl font-semibold" : "text-lg"}`}>
        <bdi>{amount}</bdi>
      </dd>
      {note === undefined ? null : <p className="text-xs text-stone-500">{note}</p>}
    </div>
  );
}

const RATE = new Intl.NumberFormat("he-IL", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/** A rate always reads to four places, the same way it does on a project. */
export function formatRate(rate: number): string {
  return RATE.format(rate);
}

export function RateFigure({ rate }: { rate: number }) {
  return <bdi className="tabular">{formatRate(rate)}</bdi>;
}

/**
 * A number of months, said the way Hebrew says it. Nought is "already covered" and
 * not "0 months", and one month is not a plural of nothing.
 */
export function monthsText(months: number): string {
  if (months === 0) return "אין מה לחסוך — המקורות מכסים את התוכנית";
  if (months === 1) return "חודש אחד של חיסכון";
  if (months === 2) return "חודשיים של חיסכון";
  return `${months} חודשי חיסכון`;
}

/** Hebrew counts one thing differently from several, and none differently again. */
export function sourcesCount(count: number): string {
  if (count === 0) return "אין מקורות";
  if (count === 1) return "מקור אחד";
  return `${count} מקורות`;
}

/** Why there is no month count. Each one is a real state, and none of them is nought. */
export function closureReason(basis: ClosureBasis): string {
  switch (basis) {
    case "no-pace":
      return "אין חודש רשום שממנו למדוד קצב חיסכון, ולכן אין מספר חודשים.";
    case "not-saving":
      return "בקצב הנוכחי לא נחסך כלום, ולכן הפער הזה אינו נסגר מחיסכון — כל מספר חודשים כאן היה המצאה.";
    case "no-rate":
      return "הפער והחיסכון במטבעות שונים ואין שער שמור להמיר ביניהם, ולכן אין מה להשוות.";
    default:
      return "";
  }
}

/**
 * The pace, anchored on the last month the מאזן holds anything for.
 *
 * Anchoring on the calendar month instead would read the current month before it has
 * been entered and report a pace short by however much of it is missing. The ledger's
 * own last month is what "currently" means to data that arrives monthly — and the
 * panel below names the months it used, so the figure is never ambiguous about what
 * it covers.
 */
export function currentPace(ledger: Ledger, categories: Categories): SavingPace {
  const months = recordedMonths(ledger);
  return savingPace({
    ledger,
    categories,
    endingWith: months[months.length - 1] ?? monthOf(new Date()),
    currency: "ILS",
  });
}

/** What the household is currently saving a month, with its denominator beside it. */
export function PacePanel({ pace }: { pace: SavingPace }) {
  const from = pace.window[0]?.month;
  const to = pace.window[pace.window.length - 1]?.month;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">קצב החיסכון הנוכחי</h2>

      {pace.monthly === null ? (
        <p className="mt-2 text-sm text-stone-600">
          אין חודש רשום בחלון שנבדק, ולכן אין קצב חיסכון למדוד לפיו. בלי קצב אין תשובה לשאלה
          &rdquo;בעוד כמה חודשים&ldquo; — וטוב שאין, כי כל מספר כאן היה מומצא.
        </p>
      ) : (
        <>
          <p className="mt-2 text-3xl font-semibold">
            <bdi className="tabular">{format(pace.monthly)}</bdi>
            <span className="text-base font-normal text-stone-500"> לחודש</span>
          </p>
          <p className="mt-1 text-sm text-stone-600">
            <bdi className="tabular">{format(pace.total)}</bdi> חיסכון על פני{" "}
            <bdi className="tabular">{pace.denominator}</bdi>{" "}
            {pace.denominator === 1 ? "חודש שנרשם" : "חודשים שנרשמו"}
            {from === undefined || to === undefined ? null : (
              <>
                , בחלון {formatMonth(from)} — {formatMonth(to)}
              </>
            )}
            .
          </p>
        </>
      )}

      {pace.incomplete.length === 0 ? null : (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          חודשים שנרשמו רק בחלקם:{" "}
          <bdi>{pace.incomplete.map((month) => formatMonth(month)).join(", ")}</bdi>. חודש לא גמור
          מציג חיסכון קטן מהאמיתי, ולכן הקצב שלמעלה נמוך מהאמת ולא גבוה ממנה.
        </p>
      )}

      {pace.missing.length === 0 ? null : (
        <p className="mt-2 text-xs text-stone-500">
          חודשים שלא נרשמו כלל אינם במכנה:{" "}
          <bdi>{pace.missing.map((month) => formatMonth(month)).join(", ")}</bdi>. המאזן אומר שחודש
          חסר לא נרשם, ולא שנרשם כאפס.
        </p>
      )}

      <p className="mt-3 text-xs text-stone-500">
        הקצב נגזר מהמאזן דרך אותו נתיב קריאה שכל מסכי המאזן קוראים בו, ואינו נשמר בשום מקום.{" "}
        <Link href="/balance/insights" className="underline underline-offset-4">
          מגמות המאזן
        </Link>
      </p>
    </section>
  );
}
