import Link from "next/link";

import { type GridCell, type GridMonth, type YearGrid } from "@/domain/ledger/year-grid";
import { format } from "@/domain/money/money";
import { formatMonthName } from "@/domain/time/calendar-month";

import { type GridLinks } from "./grid-links";

/**
 * The year as twelve months, and the way into each of them.
 *
 * The grid says where the holes are — a column heading reading "חסרים 3" — but a
 * column heading is five hundred pixels of table away from the reader's eye and
 * only readable once they have found the column. Recording a month, which is the
 * one thing this screen exists to make possible, was a single link called "רישום
 * חודשי" that always opened the month being lived: to fill a hole in מאי you had
 * to go there and then walk backwards.
 *
 * So the twelve months are a row of their own, above the table, each saying three
 * things at once: **what the month saved**, **whether it is finished**, and
 * **that it can be opened**. A month that is short of figures says how many, and
 * that figure is the link to closing it — which is the other half of finishing a
 * month and used to be reachable only from the table's own heading.
 *
 * Every state is printed, not only the unhappy one. A strip that marked only what
 * was wrong would leave "nothing missing" and "nothing checked" looking the same.
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
      className={`rounded-tile px-2.5 py-2 transition-colors ${
        current ? "bg-amber-50 ring-1 ring-amber-200" : "bg-sunken hover:bg-stone-200/70"
      }`}
    >
      <Link href={links.month(column.month, null)} prefetch={false} className="block">
        <span className={`block text-[13px] font-medium ${current ? "text-amber-900" : ""}`}>
          {name}
        </span>
        <bdi className="figure block text-[15px] font-semibold">
          {saving === undefined || saving.amount === null ? (
            <span className="text-stone-300">—</span>
          ) : (
            format(saving.amount, { withSymbol: false, withMinorUnits: false })
          )}
        </bdi>
      </Link>

      <Standing column={column} links={links} />
    </li>
  );
}

/**
 * What is left to do to this month, and the way to do it.
 *
 * The blank count is the link to the closing confirmation — the panel that names
 * the categories before it writes a single nought — rather than a second button
 * beside it. One tile, one thing to read, and the thing to read is the thing to
 * press.
 */
function Standing({ column, links }: { column: GridMonth; links: GridLinks }) {
  const { closure } = column;

  if (closure.state === "empty") {
    return <span className="block text-xs text-stone-400">אין קטגוריות</span>;
  }

  if (closure.state === "closed") {
    return (
      <span className="block text-xs text-stone-400">
        <span aria-hidden="true">✓ </span>מלא
      </span>
    );
  }

  if (column.standing === "current") {
    return (
      <span className="block text-xs text-amber-800">
        בתהליך · חסרים <bdi className="tabular">{closure.blanks.length}</bdi>
      </span>
    );
  }

  return (
    <Link
      href={links.closing(column.month)}
      prefetch={false}
      className="block text-xs font-medium text-amber-700 underline-offset-2 hover:underline"
    >
      חסרים <bdi className="tabular">{closure.blanks.length}</bdi>
    </Link>
  );
}
