import { type ProjectsErrorCode } from "./actions";

/**
 * The pieces both פרוייקטים screens share. The list and one project are written by
 * the same actions, so they report the same failures in the same words.
 */

const ERROR_MESSAGES: Record<ProjectsErrorCode, string> = {
  "no-person": "הכתובת שאיתה נכנסת אינה משויכת לאף אדם בטבלת people.",
  "bad-project": "פרטי הפרוייקט אינם תקינים.",
  "duplicate-name": "כבר קיים פרוייקט בשם הזה.",
  "unknown-project": "הפרוייקט אינו קיים.",
  "bad-leg": "פרטי רגל המימון אינם תקינים.",
  "bad-expense": "פרטי ההוצאה אינם תקינים.",
  "bad-rate": "השער אינו תקין. שער נרשם כמספר שקלים לדולר.",
  overdrawn:
    "ההוצאה גדולה מהיתרה בקופה. קופה סגורה אינה יורדת מתחת לאפס — הכנסת כסף נוסף היא רגל מימון חדשה.",
  "leg-required":
    "לא ניתן להסיר את רגל המימון: הקופה כבר הוציאה כנגדה, ובלעדיה הייתה מוציאה יותר ממה שהוכנס אליה.",
  "bad-distribution": "פרטי החלוקה אינם תקינים.",
  "rate-unwanted":
    "הסכום כבר במטבע של הקופה, ולכן לא בוצעה המרה ואין שער לרשום. השאירו את שדה השער ריק.",
  "rate-missing": "הסכום אינו במטבע של הקופה, ולכן צריך לרשום את השער שבו הומר בפועל.",
  "rate-wrong-pair": "השער שנרשם אינו בין שני המטבעות האלה.",
  "distribution-required":
    "לא ניתן להסיר את החלוקה: היא גולגלה בחזרה לקופה והקופה כבר הוציאה כנגדה.",
  "bad-valuation": "פרטי עדכון השווי אינם תקינים. עדכון שווי חייב סכום, בסיס ומקור.",
  "bad-terms": "תנאי העסקה אינם תקינים.",
  failed: "הפעולה נכשלה.",
};

const DONE_MESSAGES: Record<string, string> = {
  created: "נוצר פרוייקט",
  saved: "הפרוייקט נשמר",
  "leg-added": "נוספה רגל מימון",
  "leg-removed": "רגל המימון הוסרה",
  "expense-added": "נרשמה הוצאה",
  "expense-removed": "ההוצאה הוסרה",
  "distribution-added": "נרשמה חלוקה",
  "distribution-removed": "החלוקה הוסרה",
  "valuation-added": "נרשם עדכון שווי",
  "valuation-removed": "עדכון השווי הוסר",
  "terms-saved": "תנאי העסקה נשמרו",
};

function isErrorCode(value: string | undefined): value is ProjectsErrorCode {
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
      <div className="rounded-card bg-surface shadow-card p-4 sm:p-5" role="alert">
        <p className="font-medium text-red-800">{ERROR_MESSAGES[error]}</p>
        {detail === undefined ? null : (
          <p className="mt-1 text-sm text-stone-600">
            <bdi>{detail}</bdi>
          </p>
        )}
      </div>
    );
  }

  if (done === undefined) return null;

  const [verb = "", name = ""] = done.split(":");
  const text = DONE_MESSAGES[verb] ?? "הפרוייקט נשמר";

  return (
    <div className="rounded-card bg-surface shadow-card p-4 sm:p-5" role="status">
      <p className="text-sm font-medium text-emerald-800">
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
    <div className="rounded-card bg-surface shadow-card p-5 sm:p-6">
      <p className="font-medium text-amber-800">לא ניתן לקרוא את הפרוייקטים</p>
      <p className="mt-1 text-sm text-stone-600">{reason}</p>
    </div>
  );
}

/**
 * A filled field rather than an outlined one.
 *
 * An outline draws a rectangle around something that is already a rectangle. A
 * tint says "you type here" with no line at all, and a row of them reads as one
 * surface instead of as a row of boxes.
 */
export const FIELD =
  "bg-sunken w-full rounded-lg px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 transition-colors hover:bg-stone-200/60";

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
      <span className="block text-[13px] font-medium text-stone-700">{label}</span>
      {note === undefined ? null : <span className="block text-xs text-stone-500">{note}</span>}
      <span className="mt-1.5 block">{children}</span>
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
    <select name={name} defaultValue={defaultValue} className={FIELD}>
      {children}
    </select>
  );
}

/** The one filled button. Dark, quiet, and the only solid thing on the screen. */
export const PRIMARY_BUTTON =
  "rounded-lg bg-stone-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-700";

/** Everything else: a tint on hover and no border at rest. */
export const QUIET_BUTTON =
  "rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-stone-600 transition-colors hover:bg-stone-900/5 hover:text-stone-900";

const RATE_PLACES = 4;

const RATE = new Intl.NumberFormat("he-IL", {
  minimumFractionDigits: RATE_PLACES,
  maximumFractionDigits: RATE_PLACES,
});

/** A rate always reads to four places, so two of them can be compared at a glance. */
export function RateFigure({ rate }: { rate: number }) {
  return <bdi className="tabular">{RATE.format(rate)}</bdi>;
}

/**
 * Whether a difference between two rates is smaller than the figures shown for
 * them. The effective rate is derived from amounts that were rounded to the
 * agora, so it can sit a fraction of a ten-thousandth away from the rate that
 * produced it. Calling that "we paid more" and then printing 0.0000 beside it
 * would be the screen contradicting itself in the same sentence.
 */
export function readsAsSameRate(difference: number): boolean {
  return Math.abs(difference) < 0.5 / 10 ** RATE_PLACES;
}
