import { type FigureBasis, type FrozenFact, type Stated } from "@/domain/annual/annual-review";
import { type Money, format } from "@/domain/money/money";
import { type CalendarMonth, formatMonthRange } from "@/domain/time/calendar-month";

import { type AnnualErrorCode } from "./actions";

/**
 * The pieces every סיכום שנתי screen shares.
 *
 * The one that matters is `BasisBadge`. ADR 0002 accepts that two prints of one
 * review can disagree — the correction is the point — but only if the reader can
 * see which figures move. Every amount on these screens is rendered through
 * `StatedFigure`, which cannot be handed a bare `Money`: it takes the domain's
 * `Stated`, so there is no path by which a frozen figure prints without saying it
 * is frozen, or a live one without saying it is live.
 */

const ERROR_MESSAGES: Record<AnnualErrorCode, string> = {
  "no-person": "הכתובת שאיתה נכנסת אינה משויכת לאף אדם בטבלת people.",
  "bad-review": "פרטי הסיכום אינם תקינים.",
  "duplicate-year": "כבר קיים סיכום שנתי לשנה הזו.",
  "unknown-review": "אין סיכום שנתי לשנה הזו.",
  "bad-valuation": "ההערכה שהוזנה אינה תקינה.",
  "unknown-project": "הפרוייקט אינו קיים.",
  failed: "הפעולה נכשלה.",
};

const DONE_MESSAGES: Record<string, string> = {
  created: "נוצר סיכום שנתי",
  "facts-saved": "העובדות שהוקפאו נשמרו",
  "valuation-saved": "ההערכה נשמרה",
  "valuation-removed": "ההערכה הוסרה",
  removed: "הסיכום השנתי הוסר",
};

function isErrorCode(value: string | undefined): value is AnnualErrorCode {
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
  const text = DONE_MESSAGES[verb] ?? "הסיכום נשמר";

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
      <p className="font-medium text-amber-900">לא ניתן לקרוא את הסיכום השנתי</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}

// --- live against frozen, said on every figure --------------------------------

const BASIS_LABELS: Record<FigureBasis, string> = {
  live: "חי",
  frozen: "קפוא",
  "live-at-frozen": "חי, לפי עובדה שהוקפאה",
};

const BASIS_EXPLANATIONS: Record<FigureBasis, string> = {
  live: "מחושב מחדש מהרישומים בכל קריאה. תיקון של רישום מאותה שנה יזיז אותו — וזו המטרה.",
  frozen:
    "נרשם על הסיכום ביום הסגירה. אין ממה לשחזר אותו אחר כך, ולכן הוא נשמר ואינו מחושב.",
  "live-at-frozen":
    "כמות שמחושבת מחדש מהרישומים, מוכפלת בעובדה שהוקפאה — מניות שמוחזקות היום, במחיר שבו נסגרה השנה.",
};

const BASIS_CLASSES: Record<FigureBasis, string> = {
  live: "border-emerald-300 bg-emerald-50 text-emerald-900",
  frozen: "border-sky-300 bg-sky-50 text-sky-900",
  "live-at-frozen": "border-violet-300 bg-violet-50 text-violet-900",
};

export function BasisBadge({ basis }: { basis: FigureBasis }) {
  return (
    <span
      title={BASIS_EXPLANATIONS[basis]}
      className={`ms-2 rounded-full border px-2 py-0.5 align-middle text-xs font-medium ${BASIS_CLASSES[basis]}`}
    >
      {BASIS_LABELS[basis]}
    </span>
  );
}

export function basisLabel(basis: FigureBasis): string {
  return BASIS_LABELS[basis];
}

/**
 * One figure, its label and what it rests on. A `Stated` is the only thing this
 * accepts, so a figure without its basis cannot reach the screen.
 */
export function StatedFigure({
  label,
  figure,
  note,
  emphasis = false,
}: {
  label: string;
  figure: Stated<Money> | null;
  note?: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-stone-500">
        {label}
        {figure === null ? null : <BasisBadge basis={figure.basis} />}
      </dt>
      <dd className={`tabular mt-1 ${emphasis ? "text-xl font-semibold" : "text-lg"}`}>
        {figure === null ? (
          <span className="text-base font-normal text-stone-500">אין נתון</span>
        ) : (
          <bdi>{format(figure.value)}</bdi>
        )}
      </dd>
      {note === undefined ? null : <p className="text-xs text-stone-500">{note}</p>}
    </div>
  );
}

export function CountFigure({
  label,
  figure,
  note,
}: {
  label: string;
  figure: Stated<number> | null;
  note?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-stone-500">
        {label}
        {figure === null ? null : <BasisBadge basis={figure.basis} />}
      </dt>
      <dd className="tabular mt-1 text-lg">
        {figure === null ? (
          <span className="text-base font-normal text-stone-500">אין נתון</span>
        ) : (
          <bdi>{figure.value.toLocaleString("he-IL")}</bdi>
        )}
      </dd>
      {note === undefined ? null : <p className="text-xs text-stone-500">{note}</p>}
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

export function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">{title}</h2>
        {subtitle === undefined ? null : <p className="text-xs text-stone-500">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

const RATE = new Intl.NumberFormat("he-IL", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

export function formatRate(rate: number): string {
  return RATE.format(rate);
}

/** What a missing frozen fact is, in the household's own words. */
export const FROZEN_FACT_LABELS: Record<FrozenFact, string> = {
  "closing-snapshot": "המיפוי שעליו נסגרה השנה",
  "closing-rate": "שער הדולר בסגירה",
  "closing-share-price": "מחיר המניה בסגירה",
};

/** Hebrew counts one thing differently from several, and none differently again. */
export function monthsRecorded(count: number): string {
  if (count === 0) return "לא נרשם אף חודש";
  if (count === 1) return "חודש אחד נרשם";
  if (count === 2) return "חודשיים נרשמו";
  return `${count} חודשים נרשמו`;
}

/**
 * The months a year's figures were divided by, named.
 *
 * The denominator is the year's closed months as far as the ledger's history
 * reaches, so it is not always twelve — and "2" without "ינואר–פברואר" would read
 * as a year fully recorded rather than a year barely begun.
 */
export function monthsCounted(months: readonly CalendarMonth[]): string | null {
  const first = months[0];
  const last = months[months.length - 1];
  if (first === undefined || last === undefined) return null;
  return formatMonthRange(first, last);
}
