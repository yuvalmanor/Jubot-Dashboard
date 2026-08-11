import {
  type GpWindow,
  type GrantPrice,
  formatSharePrice,
  isEstimated,
  isStaleEstimate,
} from "@/domain/rsu/rsu-position";

import { type RsuErrorCode } from "./actions";

/**
 * The pieces the RSU screen shares. The GP badge is the load-bearing one: an
 * estimated figure must never be able to reach the screen looking like a measured
 * one, so there is exactly one component that prints a GP and it always says which
 * kind it is.
 */

const ERROR_MESSAGES: Record<RsuErrorCode, string> = {
  "no-person": "הכתובת שאיתה נכנסת אינה משויכת לאף אדם בטבלת people.",
  "bad-grant": "פרטי ההקצאה אינם תקינים.",
  "duplicate-reference": "כבר קיימת הקצאה עם מזהה המסמך הזה.",
  "unknown-grant": "ההקצאה אינה קיימת.",
  "bad-vest": "פרטי ההבשלה אינם תקינים.",
  oversubscribed:
    "ההבשלות תובעות יחד יותר מניות ממה שההקצאה העניקה. שני המספרים מגיעים מאותו מסמך, ולכן אחד מהם שגוי.",
  "bad-sale": "פרטי המכירה אינם תקינים.",
  oversold: "המכירה גדולה ממה שנשאר במנה. מנה אינה יורדת מתחת לאפס.",
  "bad-price": "המחיר אינו תקין. מחיר נרשם כמספר דולרים למניה.",
  "bad-closes": "לא ניתן לקרוא את הסגירות שהודבקו. כל שורה היא תאריך YYYY-MM-DD ומחיר לצידו.",
  "no-closes": "אף אחת מהסגירות שהודבקו אינה בתוך החלון, ולכן אין ממה לחשב אומדן.",
  "bad-window": "חלון ה־GP אינו תקין.",
  failed: "הפעולה נכשלה.",
};

const DONE_MESSAGES: Record<string, string> = {
  "grant-added": "נוספה הקצאה",
  "grant-removed": "ההקצאה הוסרה",
  "gp-stated": "ה־GP נרשם מהמסמך",
  "gp-estimated": "ה־GP נאמד מהסגירות",
  "gp-cleared": "ה־GP נמחק",
  "vest-added": "נרשמה הבשלה",
  "vest-removed": "ההבשלה הוסרה",
  "sale-recorded": "נרשמה מכירה",
  "sale-removed": "המכירה הוסרה",
};

function isErrorCode(value: string | undefined): value is RsuErrorCode {
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
  const text = DONE_MESSAGES[verb];
  if (text === undefined) return null;

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
      <p className="font-medium text-amber-900">לא ניתן לקרוא את מצב ה־RSU</p>
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

const SHARES = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 });

/** A share count. Whole, always — a fractional share is not a thing Apple grants. */
export function Shares({ count }: { count: number }) {
  return <bdi className="tabular">{SHARES.format(count)}</bdi>;
}

/** How a window reads in words, so what an estimate rests on is legible on the screen. */
export function windowInWords(window: GpWindow): string {
  const basis = window.basis === "trading" ? "ימי מסחר" : "ימי לוח";
  const parts: string[] = [];
  if (window.before > 0) parts.push(`${window.before} ${basis} לפני ההקצאה`);
  if (window.includesGrantDay) parts.push("יום ההקצאה עצמו");
  if (window.after > 0) parts.push(`${window.after} ${basis} אחריה`);
  return parts.join(", ");
}

/**
 * The only thing on the screen that prints a GP. A stated figure came off a
 * document and reads plainly; an estimated one is flagged, names the window and
 * the sample behind it, and says so again when the household has since changed the
 * window it was taken under — an estimate is not a measurement and must never be
 * able to look like one.
 */
export function GrantPriceFigure({
  grantPrice,
  window,
}: {
  grantPrice: GrantPrice | null;
  window: GpWindow;
}) {
  if (grantPrice === null) {
    return <span className="text-sm text-stone-500">לא נרשם GP — לא מהמסמך ולא כאומדן.</span>;
  }

  const stale = isStaleEstimate(grantPrice, window);

  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <bdi className="tabular font-medium">{formatSharePrice(grantPrice.price)}</bdi>

      {isEstimated(grantPrice) ? (
        <>
          <span className="rounded-sm border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900">
            אומדן
          </span>
          <span className="text-xs text-stone-500">
            ממוצע של {grantPrice.sampleCount} סגירות
            {grantPrice.window === null ? null : <> · {windowInWords(grantPrice.window)}</>}
          </span>
          {stale ? (
            <span className="text-xs font-medium text-amber-800">
              — נלקח בחלון אחר מזה שמוגדר כעת. חישוב מחדש יעדכן אותו.
            </span>
          ) : null}
        </>
      ) : (
        <span className="rounded-sm border border-stone-300 bg-stone-50 px-1.5 py-0.5 text-xs font-medium text-stone-700">
          מהמסמך
        </span>
      )}
    </span>
  );
}

export function SubmitButton({ label, subtle = false }: { label: string; subtle?: boolean }) {
  return (
    <button
      type="submit"
      className={
        subtle
          ? "rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
          : "rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
      }
    >
      {label}
    </button>
  );
}
