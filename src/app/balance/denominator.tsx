import { type Average } from "@/domain/ledger/ledger-analytics";
import {
  type CalendarMonth,
  formatMonthRange,
  monthsAreContiguous,
} from "@/domain/time/calendar-month";

/**
 * How the מאזן prints a denominator.
 *
 * Every average on every מאזן screen states what it divided by and which months
 * those were — "÷7" without "ינואר–יולי" is exactly the ambiguity the denominator
 * was introduced to remove. The grid and the trends screen share this so the two
 * cannot describe the same divisor in two different ways.
 */

/** Hebrew counts one, two and many differently, and a denominator is read aloud. */
export function denominatorPhrase(count: number): string {
  if (count === 1) return "חלוקה בחודש אחד";
  if (count === 2) return "חלוקה בחודשיים";
  return `חלוקה ב־${count} חודשים`;
}

/**
 * Which months a denominator counted, as a phrase.
 *
 * A run of months reads as itself. A set drawn out of a longer window — a
 * trailing average over the two of six months that hold a figure — reads as what
 * it was drawn *from*, so two months are never presented as six months' evidence.
 */
export function monthsPhrase(months: readonly CalendarMonth[]): string | null {
  const first = months[0];
  const last = months[months.length - 1];
  if (first === undefined || last === undefined) return null;

  const range = formatMonthRange(first, last);
  return monthsAreContiguous(months) ? range : `מתוך ${range}`;
}

/** The months an average divided by, stated on the average itself. Never implied. */
export function Denominator({ average }: { average: Average }) {
  if (average.denominator === 0) {
    return <span className="text-xs text-stone-500">אין חודשים לחלק בהם</span>;
  }

  const span = monthsPhrase(average.months);

  return (
    <span className="text-xs text-stone-500">
      <bdi>{denominatorPhrase(average.denominator)}</bdi>
      {span === null ? null : (
        <>
          {" "}
          <bdi>({span})</bdi>
        </>
      )}
      {average.recordedMonths === average.denominator ? null : (
        <>
          {" "}
          · נרשמו <bdi className="tabular">{average.recordedMonths}</bdi>
        </>
      )}
    </span>
  );
}
