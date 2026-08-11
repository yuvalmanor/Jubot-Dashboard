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
    "ההוצאה גדולה מהיתרה בפוט. פוט סגור אינו יורד מתחת לאפס — הכנסת כסף נוסף היא רגל מימון חדשה.",
  "leg-required":
    "לא ניתן להסיר את רגל המימון: הפוט כבר הוציא כנגדה, ובלעדיה היה מוצא יותר ממה שהוכנס אליו.",
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
  const text = DONE_MESSAGES[verb] ?? "הפרוייקט נשמר";

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
      <p className="font-medium text-amber-900">לא ניתן לקרוא את הפרוייקטים</p>
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
