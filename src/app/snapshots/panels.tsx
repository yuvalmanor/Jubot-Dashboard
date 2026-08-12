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
  "bad-share-price":
    "מחיר המניה אינו תקין. מחיר נרשם כמספר דולרים למניה; שדה ריק פירושו שאיש לא נקב במחיר.",
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

export function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן לקרוא את המיפוי</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}
