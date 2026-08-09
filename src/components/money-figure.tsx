import type { DatedRate } from "@/db/money-settings";
import { type Money, convert, format } from "@/domain/money/money";

/**
 * A foreign-currency amount always reads with its native figure first — that is
 * the recorded fact — and the shekel figure alongside it, together with the rate
 * that produced it. A converted number without its rate is not a fact.
 *
 * Figures sit in <bdi> so they keep their own direction inside Hebrew text.
 */

const HEBREW_DATE = new Intl.DateTimeFormat("he-IL", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

export function MoneyFigure({ amount, rate }: { amount: Money; rate: DatedRate | null }) {
  const conversion =
    rate !== null && rate.from === amount.currency ? { rate, converted: convert(amount, rate) } : null;

  return (
    <div className="space-y-1">
      <bdi className="tabular block text-3xl font-semibold sm:text-4xl">{format(amount)}</bdi>

      {conversion === null ? (
        amount.currency === "ILS" ? null : (
          <p className="text-sm text-stone-500">אין שער חליפין שמור — לא ניתן להציג את הסכום בשקלים</p>
        )
      ) : (
        <p className="text-sm text-stone-600 sm:text-base">
          <span aria-hidden="true">≈ </span>
          <bdi className="tabular font-medium">{format(conversion.converted)}</bdi>
          <span className="text-stone-500">
            {" · לפי שער "}
            <bdi className="tabular">{conversion.rate.rate}</bdi>
            {" מיום "}
            <bdi className="tabular">{HEBREW_DATE.format(conversion.rate.asOf)}</bdi>
          </span>
        </p>
      )}
    </div>
  );
}
