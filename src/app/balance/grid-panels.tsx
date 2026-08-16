import {
  type GridBand,
  type GridCell,
  type GridMonth,
  type GridRow,
  type GridSummaryRow,
  type YearGrid,
} from "@/domain/ledger/year-grid";
import { format } from "@/domain/money/money";
import { formatMonthName } from "@/domain/time/calendar-month";

import { Denominator, monthsPhrase } from "./denominator";

/**
 * The year on screen: categories down, months across, at household or person
 * level. This is the shape the household read the spreadsheet in.
 *
 * Nothing here computes anything. Every figure arrives from `yearGrid` already
 * decided — including which months the two aggregate columns counted — so the
 * table cannot disagree with the reading it renders, and חיסכון cannot be
 * anything but הכנסות − הוצאות.
 *
 * Two distinctions the markup has to keep:
 *
 * - **`0` and `—` are different facts.** A month recorded as nought prints as a
 *   figure; a month never recorded prints as a muted dash that says so to a
 *   screen reader too.
 * - **A month that has not arrived is not an empty month.** It is greyed and
 *   labelled, so its blanks read as *not yet* rather than as *not recorded*.
 */

/** Twelve months, the category column, and the two aggregates. */
const COLUMN_COUNT = 15;

export function YearGridTable({ grid }: { grid: YearGrid }) {
  const empty = grid.income.rows.length + grid.expenses.rows.length === 0;

  if (empty) {
    return (
      <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
        אין קטגוריות ואין רישומים בשנה הזו.
      </p>
    );
  }

  return (
    <section className="overflow-x-auto rounded-lg border border-stone-300 bg-white">
      <table className="w-full min-w-[70rem] border-collapse text-sm">
        <caption className="px-4 py-3 text-start text-sm text-stone-500">
          כל הסכומים בשקלים. <span className="text-stone-400">—</span> פירושו שהחודש לא נרשם; 0 פירושו
          שנרשם אפס.
        </caption>

        <thead>
          <tr className="border-b border-stone-300">
            <th scope="col" className="px-3 py-2 text-start font-semibold">
              קטגוריה
            </th>
            {grid.months.map((column) => (
              <MonthHeader key={column.month.month} column={column} />
            ))}
            <th scope="col" className="border-s border-stone-200 px-3 py-2 text-end font-semibold">
              סכום שנתי
            </th>
            <th scope="col" className="px-3 py-2 text-end font-semibold">
              ממוצע חודשי
              <span className="block text-xs font-normal text-stone-500">
                <DivisorNote grid={grid} />
              </span>
            </th>
          </tr>
        </thead>

        <Band band={grid.income} title="הכנסות" subtotal="סה״כ הכנסות" />
        <Band band={grid.expenses} title="הוצאות" subtotal="סה״כ הוצאות" />

        <tfoot className="border-t-2 border-stone-300">
          <tr className="bg-stone-50">
            <th scope="row" className="px-3 py-2 text-start font-semibold">
              חיסכון
              <span className="block text-xs font-normal text-stone-500">
                הכנסות − הוצאות, מחושב בקריאה
              </span>
            </th>
            <SummaryCells summary={grid.saving} />
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

/** The divisor and the months it counted, printed on the column that uses it. */
function DivisorNote({ grid }: { grid: YearGrid }) {
  if (grid.denominatorMonths.length === 0) {
    return <>אין חודשים סגורים לחלק בהם</>;
  }
  const span = monthsPhrase(grid.denominatorMonths);
  return (
    <>
      <bdi>÷{grid.denominatorMonths.length}</bdi>
      {span === null ? null : <> ({span})</>}
    </>
  );
}

function MonthHeader({ column }: { column: GridMonth }) {
  const name = formatMonthName(column.month);

  if (column.standing === "future") {
    return (
      <th scope="col" className="bg-stone-50 px-2 py-2 text-end font-medium text-stone-300">
        {name}
        <span className="block text-xs font-normal">טרם הגיע</span>
      </th>
    );
  }

  if (column.standing === "current") {
    return (
      <th scope="col" className="bg-amber-50 px-2 py-2 text-end font-semibold text-amber-900">
        {name}
        <span className="block text-xs font-normal text-amber-800">בתהליך</span>
      </th>
    );
  }

  return (
    <th scope="col" className="px-2 py-2 text-end font-medium">
      {name}
      {column.counted ? null : <span className="block text-xs font-normal text-stone-400">מחוץ להיסטוריה</span>}
    </th>
  );
}

function Band({ band, title, subtotal }: { band: GridBand; title: string; subtotal: string }) {
  return (
    <tbody className="border-t border-stone-300">
      <tr className="bg-stone-100">
        <th scope="colgroup" colSpan={COLUMN_COUNT} className="px-3 py-1.5 text-start text-xs font-semibold tracking-wide text-stone-600">
          {title}
        </th>
      </tr>

      {band.rows.map((line) => (
        <CategoryRow key={line.key} line={line} />
      ))}

      <tr className="border-t border-stone-200 bg-stone-50">
        <th scope="row" className="px-3 py-2 text-start font-semibold">
          {subtotal}
        </th>
        <SummaryCells summary={band.total} />
      </tr>
    </tbody>
  );
}

function CategoryRow({ line }: { line: GridRow }) {
  return (
    <tr className="border-t border-stone-100">
      <th scope="row" className="px-3 py-2 text-start font-normal">
        <bdi>{line.name}</bdi>
        {line.retired ? (
          <span className="ms-2 rounded-sm bg-stone-100 px-1.5 py-0.5 text-xs text-stone-500">
            הוצאה משימוש
          </span>
        ) : null}
      </th>

      {line.cells.map((cell) => (
        <Cell key={cell.month.month} cell={cell} />
      ))}

      <td className="border-s border-stone-200 px-3 py-2 text-end">
        <bdi className="tabular">{format(line.aggregate.total, { withSymbol: false })}</bdi>
      </td>
      <td className="px-3 py-2 text-end">
        <bdi className="tabular">
          {line.aggregate.amount === null ? "—" : format(line.aggregate.amount, { withSymbol: false })}
        </bdi>
      </td>
    </tr>
  );
}

/** The twelve cells and the two aggregates of a subtotal or of חיסכון. */
function SummaryCells({ summary }: { summary: GridSummaryRow }) {
  return (
    <>
      {summary.cells.map((cell) => (
        <Cell key={cell.month.month} cell={cell} emphasis />
      ))}
      <td className="border-s border-stone-200 px-3 py-2 text-end font-semibold">
        <bdi className="tabular">{format(summary.aggregate.total, { withSymbol: false })}</bdi>
      </td>
      <td className="px-3 py-2 text-end font-semibold">
        <bdi className="tabular">
          {summary.aggregate.amount === null ? "—" : format(summary.aggregate.amount, { withSymbol: false })}
        </bdi>
      </td>
    </>
  );
}

function Cell({ cell, emphasis = false }: { cell: GridCell; emphasis?: boolean }) {
  const tint =
    cell.standing === "current" ? "bg-amber-50" : cell.standing === "future" ? "bg-stone-50" : "";

  return (
    <td className={`px-2 py-2 text-end ${tint} ${emphasis ? "font-semibold" : ""}`}>
      {cell.amount === null ? (
        <span className="text-stone-300" aria-label={cell.standing === "future" ? "טרם הגיע" : "לא נרשם"}>
          —
        </span>
      ) : (
        <bdi className="tabular">{format(cell.amount, { withSymbol: false })}</bdi>
      )}
    </td>
  );
}

/** The three averages, above the table, each stating what it divided by. */
export function YearSummaryStrip({ grid }: { grid: YearGrid }) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <AverageFigure label="ממוצע הכנסות" summary={grid.income.total} />
        <AverageFigure label="ממוצע הוצאות" summary={grid.expenses.total} />
        <AverageFigure label="ממוצע חיסכון" summary={grid.saving} emphasis />
      </div>

      <p className="mt-4 text-sm text-stone-500">
        הממוצע מחלק בחודשים הסגורים של השנה, כפי שההיסטוריה מגיעה אליהם. החודש הנוכחי מוצג בטור שלו
        ואינו נכנס לא לסכום ולא לממוצע.
      </p>
    </section>
  );
}

function AverageFigure({
  label,
  summary,
  emphasis = false,
}: {
  label: string;
  summary: GridSummaryRow;
  emphasis?: boolean;
}) {
  return (
    <div>
      <p className="text-sm font-semibold tracking-wide text-stone-500">{label}</p>
      <bdi className={`tabular block ${emphasis ? "text-3xl font-semibold" : "text-2xl"}`}>
        {summary.aggregate.amount === null ? "—" : format(summary.aggregate.amount)}
      </bdi>
      <Denominator average={summary.aggregate} />
    </div>
  );
}
