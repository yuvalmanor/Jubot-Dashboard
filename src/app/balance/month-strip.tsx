import Link from "next/link";

import { type GridCell, type GridMonth, type YearGrid } from "@/domain/ledger/year-grid";
import { format } from "@/domain/money/money";
import { formatMonthName } from "@/domain/time/calendar-month";

import { type GridLinks } from "./grid-links";

/**
 * The year as twelve months, and the way into each of them.
 *
 * Recording a month, which is the one thing this screen exists to make possible,
 * was a single link called "רישום חודשי" that always opened the month being
 * lived: to fill a hole in מאי you had to go there and then walk backwards. So
 * the twelve months are a row of their own, above the table, each saying what it
 * saved and each a way into itself.
 *
 * It used to count what each month was missing, and so did the table's own
 * column headings. That is gone: a month nobody typed a figure into reads as
 * nought now, so there is nothing to be missing and nothing to nag about. A tile
 * says what the month came to and opens it — which is the whole of what a strip
 * of months is for.
 */

export function MonthStrip({
  grid,
  links,
}: {
  grid: YearGrid;
  links: GridLinks;
}) {
  return (
    <section aria-label="החודשים" className="rounded-card bg-surface shadow-card p-3 sm:p-4">
      <ol className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-12">
        {grid.months.map((column, index) => (
          <MonthTile
            key={column.month.month}
            column={column}
            saving={grid.saving.cells[index]}
            links={links}
          />
        ))}
      </ol>
    </section>
  );
}

function MonthTile({
  column,
  saving,
  links,
}: {
  column: GridMonth;
  /** The month's חיסכון, which is the figure a month is judged on. */
  saving: GridCell | undefined;
  links: GridLinks;
}) {
  const name = formatMonthName(column.month);

  // A month nobody has lived through yet is inert here as it is in the table:
  // there is nothing to record and nothing to close.
  if (column.standing === "future") {
    return (
      <li className="rounded-tile bg-sunken/60 px-2.5 py-2">
        <span className="block text-[13px] font-medium text-stone-300">{name}</span>
        <span className="block text-xs text-stone-300">טרם הגיע</span>
      </li>
    );
  }

  const current = column.standing === "current";

  return (
    <li
      className={`rounded-tile transition-colors ${
        current ? "bg-amber-50 ring-1 ring-amber-200" : "bg-sunken hover:bg-stone-200/70"
      }`}
    >
      <Link href={links.month(column.month, null)} prefetch={false} className="block px-2.5 py-2">
        <span className={`block text-[13px] font-medium ${current ? "text-amber-900" : ""}`}>
          {name}
        </span>
        <bdi className="figure block text-[15px] font-semibold">
          {saving === undefined || saving.amount === null
            ? "0"
            : format(saving.amount, { withSymbol: false, withMinorUnits: false })}
        </bdi>
        {current ? (
          <span className="block text-xs text-amber-800">בתהליך</span>
        ) : column.counted ? null : (
          <span className="block text-xs text-stone-400">מחוץ להיסטוריה</span>
        )}
      </Link>
    </li>
  );
}
