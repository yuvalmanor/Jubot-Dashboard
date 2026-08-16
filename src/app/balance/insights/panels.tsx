import {
  type Average,
  type AvailableToMove,
  type CategoryDeviation,
  type DeviationBasis,
  type SavingRate,
  type TrendPoint,
  type YearOverYear,
} from "@/domain/ledger/ledger-analytics";
import { type Money, format, isNegative } from "@/domain/money/money";
import { formatMonth } from "@/domain/time/calendar-month";

import { Denominator, monthsPhrase } from "../denominator";

/**
 * Whether a figure is normal — the trend, the deviations, and the same period a
 * year ago.
 *
 * Where the money went is not asked here. That is the grid's question, and the
 * grid answers it across twelve columns rather than one summed line, so a
 * breakdown panel alongside it would only be a second place for the same figure
 * to be stated.
 *
 * One rule runs through every panel that remains: **a figure never appears
 * without what it would take to argue with it.** An average is printed with the
 * months it divided by, a percentage with the amount it is a percentage of, a
 * deviation with the trailing average it deviated from, and a category with no
 * history says so instead of being drawn against a zero it never had.
 *
 * Nothing on these screens is writable. Every number is derived from the entries
 * at read time.
 */

const percentFormatter = new Intl.NumberFormat("he-IL", {
  style: "percent",
  maximumFractionDigits: 1,
});

function formatPercent(value: number | null): string | null {
  return value === null ? null : percentFormatter.format(value);
}

function formatSigned(amount: Money): string {
  return isNegative(amount) ? format(amount) : `+${format(amount)}`;
}

function AverageFigure({ average }: { average: Average }) {
  return (
    <span className="inline-flex flex-col items-start">
      <bdi className="tabular">{average.amount === null ? "—" : format(average.amount)}</bdi>
      <Denominator average={average} />
    </span>
  );
}

/**
 * A period's total with the monthly average underneath it. The two are different
 * questions — "how much over the year" and "how much a month" — and the average
 * is never shown without the months it divided by.
 */
function PeriodTotal({ average }: { average: Average }) {
  return (
    <span className="inline-flex flex-col items-end">
      <bdi className="tabular">{format(average.total)}</bdi>
      <span className="text-xs text-stone-500">
        ממוצע <bdi className="tabular">{average.amount === null ? "—" : format(average.amount)}</bdi>
      </span>
      <Denominator average={average} />
    </span>
  );
}

function Rate({ rate }: { rate: SavingRate }) {
  const share = formatPercent(rate.ratio);
  if (share === null) {
    return <span className="text-sm text-stone-500">אין הכנסה שממנה לחשב אחוז</span>;
  }
  return (
    <span className="text-sm text-stone-600">
      <bdi className="tabular font-medium">{share}</bdi> מתוך הכנסות של{" "}
      <bdi className="tabular">{format(rate.income)}</bdi>
    </span>
  );
}

// --- what is available to move into projects ---------------------------------

export function AvailablePanel({ available, note }: { available: AvailableToMove; note: string }) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">
        חיסכון ב{formatMonth(available.month)} — זמין להעברה לפרוייקטים
      </h2>

      <p className="mt-2">
        <bdi className="tabular text-3xl font-semibold">{format(available.saving)}</bdi>
      </p>

      <div className="mt-2">
        <Rate rate={available.savingRate} />
      </div>

      <p
        className={`mt-4 inline-flex flex-wrap items-center gap-x-2 rounded-md px-3 py-1.5 text-sm ${
          available.completeness === "complete"
            ? "bg-emerald-50 text-emerald-900"
            : "bg-amber-50 text-amber-900"
        }`}
        role={available.completeness === "complete" ? undefined : "status"}
      >
        <span className="font-medium">
          {available.completeness === "complete"
            ? "חודש מלא"
            : available.completeness === "empty"
              ? "חודש ריק"
              : "חודש חלקי"}
        </span>
        <span>
          · נרשמו <bdi className="tabular">{available.recordedCount}</bdi> מתוך{" "}
          <bdi className="tabular">{available.categoryCount}</bdi> קטגוריות
        </span>
        {available.completeness === "complete" ? null : (
          <span>— הסכום שלמעלה אינו התמונה המלאה</span>
        )}
      </p>

      <p className="mt-3 text-sm text-stone-500">{note}</p>
    </section>
  );
}

// --- what is unusual this month ----------------------------------------------

const BASIS_NOTES: Record<DeviationBasis, string> = {
  compared: "",
  "no-history": "אין היסטוריה להשוות אליה — לא מושווה לאפס",
  "not-recorded": "לא נרשם החודש — לא נספר כירידה לאפס",
};

export function DeviationsPanel({
  deviations,
  window,
  monthLabel,
}: {
  deviations: readonly CategoryDeviation[];
  window: number;
  monthLabel: string;
}) {
  return (
    <Panel
      title={`מה חריג ב${monthLabel}`}
      note={`כל קטגוריה מול הממוצע שלה עצמה ב־${window} החודשים שקדמו לחודש, הסטייה הגדולה ביותר ראשונה.`}
    >
      {deviations.length === 0 ? (
        <Empty>אין מה להשוות: אין בחודש הזה קטגוריה עם סכום או עם היסטוריה.</Empty>
      ) : (
        <ul className="divide-y divide-stone-200">
          {deviations.map((deviation) => (
            <li key={deviation.key} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3">
              <span className="min-w-0 flex-1 font-medium">
                <bdi>{deviation.name}</bdi>
                {BASIS_NOTES[deviation.basis] === "" ? null : (
                  <span className="block text-xs font-normal text-stone-500">
                    {BASIS_NOTES[deviation.basis]}
                  </span>
                )}
              </span>

              <span className="w-28 text-end">
                <bdi className="tabular">
                  {deviation.current === null ? (
                    <span className="text-stone-400">לא נרשם</span>
                  ) : (
                    format(deviation.current)
                  )}
                </bdi>
              </span>

              <span className="w-40 text-end text-sm">
                {deviation.trailing.amount === null ? (
                  <span className="text-stone-400">אין ממוצע</span>
                ) : (
                  <>
                    <bdi className="tabular">{format(deviation.trailing.amount)}</bdi>{" "}
                    <Denominator average={deviation.trailing} />
                  </>
                )}
              </span>

              <span className="w-36 text-end">
                {deviation.deviation === null ? (
                  <span className="text-sm text-stone-400">—</span>
                ) : (
                  <bdi
                    className={`tabular font-semibold ${
                      isNegative(deviation.deviation) ? "text-emerald-700" : "text-rose-700"
                    }`}
                  >
                    {formatSigned(deviation.deviation)}
                    {deviation.deviationRatio === null ? null : (
                      <span className="ms-1 text-xs font-normal text-stone-500">
                        ({formatPercent(deviation.deviationRatio)})
                      </span>
                    )}
                  </bdi>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// --- the monthly trend --------------------------------------------------------

export function TrendTable({ points }: { points: readonly TrendPoint[] }) {
  if (points.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <thead>
          <tr className="border-b border-stone-200 text-start text-xs font-semibold tracking-wide text-stone-500">
            <th scope="col" className="px-5 py-2 text-start">
              חודש
            </th>
            <th scope="col" className="px-3 py-2 text-end">
              הכנסות
            </th>
            <th scope="col" className="px-3 py-2 text-end">
              הוצאות
            </th>
            <th scope="col" className="px-3 py-2 text-end">
              חיסכון
            </th>
            <th scope="col" className="px-3 py-2 text-end">
              שיעור חיסכון
            </th>
            <th scope="col" className="px-5 py-2 text-end">
              חיסכון אשתקד
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {points.map((point) => (
            <tr key={`${point.month.year}-${point.month.month}`}>
              <th scope="row" className="px-5 py-2 text-start font-normal">
                {formatMonth(point.month)}
                {point.completeness === "complete" ? null : (
                  <span className="ms-2 text-xs text-amber-700">
                    {point.completeness === "empty" ? "ריק" : "חלקי"}
                  </span>
                )}
              </th>
              <td className="px-3 py-2 text-end">
                <bdi className="tabular">{format(point.income)}</bdi>
              </td>
              <td className="px-3 py-2 text-end">
                <bdi className="tabular">{format(point.expenses)}</bdi>
              </td>
              <td className="px-3 py-2 text-end font-medium">
                <bdi className="tabular">{format(point.saving)}</bdi>
              </td>
              <td className="px-3 py-2 text-end">
                <bdi className="tabular">
                  {formatPercent(point.savingRate.ratio) ?? <span className="text-stone-400">—</span>}
                </bdi>
              </td>
              <td className="px-5 py-2 text-end text-stone-600">
                {point.previous === null ? (
                  <span className="text-stone-400">לא נרשם</span>
                ) : (
                  <bdi className="tabular">{format(point.previous.saving)}</bdi>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- the same period last year -------------------------------------------------

export function YearOverYearPanel({ comparison, title }: { comparison: YearOverYear; title: string }) {
  const current = monthsPhrase(comparison.currentMonths);
  const previous = monthsPhrase(comparison.previousMonths);

  return (
    <Panel
      title={title}
      note={
        current === null || previous === null
          ? `אין חודשים סגורים ב־${comparison.year} להשוות בהם.`
          : `אותם חודשים עצמם בשני הצדדים — ${current} מול ${previous}, ${comparison.months} בכל צד.`
      }
    >
      {comparison.lines.length === 0 ? (
        <Empty>אין קטגוריה עם סכום באף אחת משתי התקופות.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-xs font-semibold tracking-wide text-stone-500">
                <th scope="col" className="px-5 py-2 text-start">
                  קטגוריה
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  <bdi className="tabular">{comparison.year}</bdi>
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  <bdi className="tabular">{comparison.comparisonYear}</bdi>
                </th>
                <th scope="col" className="px-5 py-2 text-end">
                  שינוי
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {comparison.lines.map((line) => (
                <tr key={line.key}>
                  <th scope="row" className="px-5 py-2 text-start font-medium">
                    <bdi>{line.name}</bdi>
                  </th>
                  <td className="px-3 py-2 text-end">
                    <PeriodTotal average={line.current} />
                  </td>
                  <td className="px-3 py-2 text-end">
                    {line.previous === null ? (
                      <span className="text-xs text-stone-500">לא הייתה קיימת</span>
                    ) : (
                      <PeriodTotal average={line.previous} />
                    )}
                  </td>
                  <td className="px-5 py-2 text-end">
                    {line.change === null ? (
                      <span className="text-xs text-stone-500">אין בסיס להשוואה</span>
                    ) : (
                      <bdi
                        className={`tabular font-medium ${
                          isNegative(line.change) ? "text-emerald-700" : "text-rose-700"
                        }`}
                      >
                        {formatSigned(line.change)}
                        {line.changeRatio === null ? null : (
                          <span className="ms-1 text-xs font-normal text-stone-500">
                            ({formatPercent(line.changeRatio)})
                          </span>
                        )}
                      </bdi>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// --- shell --------------------------------------------------------------------

export function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white">
      <div className="border-b border-stone-200 px-5 py-3">
        <h2 className="text-sm font-semibold tracking-wide text-stone-500">{title}</h2>
        {note === undefined ? null : <p className="mt-1 text-sm text-stone-500">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-6 text-stone-600">{children}</p>;
}
