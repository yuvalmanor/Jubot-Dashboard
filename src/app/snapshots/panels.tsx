import { format, ratio } from "@/domain/money/money";
import { type BasisSplit, VALUE_BASES, VALUE_BASIS_LABELS } from "@/domain/snapshot/snapshot";

import { type SnapshotsErrorCode } from "./actions";

/**
 * The notices both מיפוי screens share. The list and one snapshot are written by
 * the same three actions, so they report the same failures in the same words.
 */

const ERROR_MESSAGES: Record<SnapshotsErrorCode, string> = {
  "no-person": "הכתובת שאיתה נכנסת אינה משויכת לאף אדם בטבלת people.",
  "no-accounts": "אין חשבונות פתוחים בתאריך הזה, ולכן אין ממה לבנות צילום.",
  "bad-date": "התאריך אינו תקין.",
  "bad-rate": "שער החליפין אינו תקין.",
  "bad-amount": "אחד הסכומים אינו מספר. שום דבר לא נשמר.",
  "out-of-order": "צילום חייב להילקח אחרי הצילום הקודם.",
  "duplicate-date": "כבר קיים צילום בתאריך הזה. תיקון נעשה בתוך הצילום הקיים.",
  "unknown-snapshot": "הצילום אינו קיים.",
  failed: "הפעולה נכשלה.",
};

function isErrorCode(value: string | undefined): value is SnapshotsErrorCode {
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

  const text =
    done === "taken"
      ? "הצילום נלקח. כל שורה נושאת את הערך מהצילום הקודם עד שתימדד."
      : done === "filled"
        ? "החשבונות החסרים נוספו לצילום, ללא מדידה."
        : "הצילום נשמר.";

  return (
    <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4" role="status">
      <p className="font-medium text-emerald-900">{text}</p>
    </div>
  );
}

/**
 * What a total is made of. Per ADR 0003 a cost-held asset is never re-valued, so
 * a total that does not say how much of itself is cost is claiming to know more
 * than it does. Every total on these screens carries this line.
 */
export function BasisNote({ split, className = "" }: { split: BasisSplit; className?: string }) {
  const parts = VALUE_BASES.filter((basis) => split.byBasis[basis].minorUnits !== 0);

  if (parts.length === 0) {
    return <p className={`text-xs text-stone-500 ${className}`}>אין סכום שאפשר לפרק לפי בסיס שווי</p>;
  }

  if (parts.length === 1 && parts[0] === "market") {
    return <p className={`text-xs text-stone-500 ${className}`}>כל הסכום נמדד בשווי שוק</p>;
  }

  return (
    <p className={`text-xs text-stone-500 ${className}`}>
      {parts.map((basis, index) => (
        <span key={basis}>
          {index === 0 ? null : <span aria-hidden="true"> · </span>}
          {VALUE_BASIS_LABELS[basis]}{" "}
          <bdi className="tabular">{format(split.byBasis[basis])}</bdi>
          <SharePart share={ratio(split.byBasis[basis], split.total)} />
        </span>
      ))}
    </p>
  );
}

const PERCENT = new Intl.NumberFormat("he-IL", { style: "percent", maximumFractionDigits: 0 });

function SharePart({ share }: { share: number | null }) {
  // A share of nothing is not 0% — a total of zero has no percentages in it.
  if (share === null) return null;
  return (
    <>
      {" ("}
      <bdi className="tabular">{PERCENT.format(share)}</bdi>
      {")"}
    </>
  );
}

export function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן לקרוא את המיפוי</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}
