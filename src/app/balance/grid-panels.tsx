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
 * decided — including which months the two aggregate columns counted, which rows
 * come first, and which cells are worth a second look — so the table cannot
 * disagree with the reading it renders, and חיסכון cannot be anything but
 * הכנסות − הוצאות.
 *
 * Fifteen columns is a lot of table, so three things make it navigable:
 *
 * - **קטגוריה pins to the start edge and both aggregates to the end**, so
 *   swiping through months on a phone never loses the row you are on or the
 *   totals you are comparing against. One table on every device; there is no
 *   second mobile layout to keep in sync with this one.
 * - **A cell is marked only against its own row.** Not a heatmap: tinting three
 *   hundred cells by magnitude would mostly report that rent is larger than bus
 *   fare.
 * - **A משותף row opens onto the two People underneath it**, which is what makes
 *   a surprising household figure traceable without changing tabs.
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

/**
 * The column widths, as custom properties on the table, because the pinned
 * columns' offsets are derived from them: סכום שנתי parks exactly one aggregate
 * column in from the end edge, so a width and an offset that disagreed would
 * overlap on scroll. Declaring them once means the offset cannot drift from the
 * width, at either size.
 *
 * They narrow on a phone rather than the table becoming a different table. Three
 * pinned columns at their desktop widths would fill a 375px screen on their own
 * and leave no month visible at all; at these widths one month sits between the
 * category and the totals, and swiping moves through the year one at a time.
 */
const COLUMN_WIDTHS = [
  "[--grid-category:5rem] [--grid-month:5.25rem] [--grid-aggregate:5.5rem]",
  "sm:[--grid-category:11rem] sm:[--grid-month:5.5rem] sm:[--grid-aggregate:8rem]",
].join(" ");

const CATEGORY_WIDTH = "var(--grid-category)";
const MONTH_WIDTH = "var(--grid-month)";
const AGGREGATE_WIDTH = "var(--grid-aggregate)";
const TABLE_WIDTH = `calc(${CATEGORY_WIDTH} + 12 * ${MONTH_WIDTH} + 2 * ${AGGREGATE_WIDTH})`;

/** Tighter padding and a smaller figure on a phone; the desktop table is unchanged. */
const CATEGORY_PADDING = "px-1.5 sm:px-3";
const CELL_PADDING = "px-1 sm:px-2";
const AGGREGATE_PADDING = "px-1.5 sm:px-3";

/** Pinned to the start edge — קטגוריה, and the band headings that sit in its column. */
const PINNED_START = "sticky start-0 z-20";
/** Pinned to the end edge — the two aggregates. Each carries its own offset. */
const PINNED_END = "sticky z-20";

export function YearGridTable({
  grid,
  expanded,
  peopleNames,
}: {
  grid: YearGrid;
  expanded: boolean;
  peopleNames: ReadonlyMap<string, string>;
}) {
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
      {/* border-separate, not collapse: a collapsed border belongs to the table
          rather than to the cell, and does not travel with a pinned column. */}
      <table
        className={`w-full table-fixed border-separate border-spacing-0 text-xs sm:text-sm ${COLUMN_WIDTHS}`}
        style={{ minWidth: TABLE_WIDTH }}
      >
        <caption className="px-4 py-3 text-start text-sm text-stone-500">
          כל הסכומים בשקלים. <span className="text-stone-400">—</span> פירושו שהחודש לא נרשם; 0 פירושו
          שנרשם אפס. סימון בתא פירושו חריגה מהממוצע של אותה שורה.
        </caption>

        <colgroup>
          <col style={{ width: CATEGORY_WIDTH }} />
          {grid.months.map((column) => (
            <col key={column.month.month} style={{ width: MONTH_WIDTH }} />
          ))}
          <col style={{ width: AGGREGATE_WIDTH }} />
          <col style={{ width: AGGREGATE_WIDTH }} />
        </colgroup>

        <thead>
          <tr>
            <th
              scope="col"
              className={`${PINNED_START} ${CATEGORY_PADDING} border-b border-stone-300 bg-white py-2 text-start font-semibold`}
            >
              קטגוריה
            </th>
            {grid.months.map((column) => (
              <MonthHeader key={column.month.month} column={column} />
            ))}
            <th
              scope="col"
              className={`${PINNED_END} ${AGGREGATE_PADDING} border-b border-s border-stone-300 bg-white py-2 text-end font-semibold`}
              style={{ insetInlineEnd: AGGREGATE_WIDTH }}
            >
              סכום שנתי
            </th>
            <th
              scope="col"
              className={`${PINNED_END} ${AGGREGATE_PADDING} border-b border-stone-300 bg-white py-2 text-end font-semibold`}
              style={{ insetInlineEnd: 0 }}
            >
              ממוצע חודשי
              <span className="block text-xs font-normal text-stone-500">
                <DivisorNote grid={grid} />
              </span>
            </th>
          </tr>
        </thead>

        <Band
          band={grid.income}
          title="הכנסות"
          subtotal="סה״כ הכנסות"
          expanded={expanded}
          peopleNames={peopleNames}
        />
        <Band
          band={grid.expenses}
          title="הוצאות"
          subtotal="סה״כ הוצאות"
          expanded={expanded}
          peopleNames={peopleNames}
        />

        <tfoot>
          <tr>
            <th
              scope="row"
              className={`${PINNED_START} ${CATEGORY_PADDING} border-t-2 border-stone-300 bg-stone-50 py-2 text-start font-semibold`}
            >
              חיסכון
              <span className="block text-xs font-normal text-stone-500">
                הכנסות − הוצאות, מחושב בקריאה
              </span>
            </th>
            <SummaryCells summary={grid.saving} tone="bg-stone-50" top="border-t-2 border-stone-300" />
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
      <th scope="col" className={`${CELL_PADDING} border-b border-stone-300 bg-stone-50 py-2 text-end font-medium text-stone-300`}>
        {name}
        <span className="block text-xs font-normal">טרם הגיע</span>
      </th>
    );
  }

  if (column.standing === "current") {
    return (
      <th scope="col" className={`${CELL_PADDING} border-b border-stone-300 bg-amber-50 py-2 text-end font-semibold text-amber-900`}>
        {name}
        <span className="block text-xs font-normal text-amber-800">בתהליך</span>
      </th>
    );
  }

  return (
    <th scope="col" className={`${CELL_PADDING} border-b border-stone-300 bg-white py-2 text-end font-medium`}>
      {name}
      {column.counted ? null : <span className="block text-xs font-normal text-stone-400">מחוץ להיסטוריה</span>}
    </th>
  );
}

function Band({
  band,
  title,
  subtotal,
  expanded,
  peopleNames,
}: {
  band: GridBand;
  title: string;
  subtotal: string;
  expanded: boolean;
  peopleNames: ReadonlyMap<string, string>;
}) {
  return (
    <tbody>
      <tr>
        {/* The heading lives in the pinned column so it stays legible while the
            months scroll; the rest of the row is a plain filler. */}
        <th
          scope="colgroup"
          className={`${PINNED_START} ${CATEGORY_PADDING} border-t border-stone-300 bg-stone-100 py-1.5 text-start text-xs font-semibold tracking-wide text-stone-600`}
        >
          {title}
        </th>
        <td colSpan={COLUMN_COUNT - 1} className="border-t border-stone-300 bg-stone-100" />
      </tr>

      {band.rows.map((line) => (
        <CategoryRow key={line.key} line={line} expanded={expanded} peopleNames={peopleNames} />
      ))}

      <tr>
        <th
          scope="row"
          className={`${PINNED_START} ${CATEGORY_PADDING} border-t border-stone-200 bg-stone-50 py-2 text-start font-semibold`}
        >
          {subtotal}
        </th>
        <SummaryCells summary={band.total} tone="bg-stone-50" top="border-t border-stone-200" />
      </tr>
    </tbody>
  );
}

function CategoryRow({
  line,
  expanded,
  peopleNames,
}: {
  line: GridRow;
  expanded: boolean;
  peopleNames: ReadonlyMap<string, string>;
}) {
  const showContributions = expanded && line.contributions.length > 0;

  return (
    <>
      <tr>
        <th
          scope="row"
          className={`${PINNED_START} ${CATEGORY_PADDING} border-t border-stone-100 bg-white py-2 text-start font-normal`}
        >
          <bdi>{line.name}</bdi>
          {line.retired ? (
            /* Its own line on a phone, where the category column is 5rem wide and
               a badge beside the name would push the name out of its cell. */
            <span className="mt-0.5 block w-fit rounded-sm bg-stone-100 px-1.5 py-0.5 text-[0.65rem] text-stone-500 sm:mt-0 sm:ms-2 sm:inline sm:text-xs">
              הוצאה משימוש
            </span>
          ) : null}
        </th>

        {line.cells.map((cell) => (
          <Cell key={cell.month.month} cell={cell} top="border-t border-stone-100" />
        ))}

        <AggregateCells aggregate={line.aggregate} tone="bg-white" top="border-t border-stone-100" />
      </tr>

      {showContributions
        ? line.contributions.map((contribution) => (
            <ContributionRow key={contribution.key} line={contribution} peopleNames={peopleNames} />
          ))
        : null}
    </>
  );
}

/**
 * One Person's share of the household row above. Indented, muted, and never a
 * total.
 *
 * The owner's name is what makes it readable: both People may name a category
 * the same thing — ארנונה under ארנונה — and two identical labels one above the
 * other say nothing about whose money the line is.
 */
function ContributionRow({
  line,
  peopleNames,
}: {
  line: GridRow;
  peopleNames: ReadonlyMap<string, string>;
}) {
  const owner = line.personId === null ? null : (peopleNames.get(line.personId) ?? line.personId);

  return (
    <tr>
      <th
        scope="row"
        className={`${PINNED_START} ${CATEGORY_PADDING} border-t border-stone-100 bg-stone-50 py-1.5 ps-4 sm:ps-7 text-start text-[0.7rem] sm:text-xs font-normal text-stone-600`}
      >
        <bdi>{line.name}</bdi>
        {owner === null ? null : (
          <span className="block text-stone-400">
            <bdi>{owner}</bdi>
          </span>
        )}
      </th>

      {line.cells.map((cell) => (
        <Cell
          key={cell.month.month}
          cell={cell}
          top="border-t border-stone-100"
          muted
        />
      ))}

      <AggregateCells
        aggregate={line.aggregate}
        tone="bg-stone-50"
        top="border-t border-stone-100"
        muted
      />
    </tr>
  );
}

/** The twelve cells and the two aggregates of a subtotal or of חיסכון. */
function SummaryCells({
  summary,
  tone,
  top,
}: {
  summary: GridSummaryRow;
  tone: string;
  top: string;
}) {
  return (
    <>
      {summary.cells.map((cell) => (
        <Cell key={cell.month.month} cell={cell} top={top} emphasis />
      ))}
      <AggregateCells aggregate={summary.aggregate} tone={tone} top={top} emphasis />
    </>
  );
}

/**
 * סכום שנתי and ממוצע חודשי, pinned to the end edge.
 *
 * The average prints in whole shekels. `divide` rounds at the agora, so an
 * average carrying its agorot could be multiplied by the divisor beside it and
 * fail to return the total beside that — an arithmetic the two columns invite
 * and cannot honour. Stated to the shekel it is exact at the precision shown.
 */
function AggregateCells({
  aggregate,
  tone,
  top,
  emphasis = false,
  muted = false,
}: {
  aggregate: GridRow["aggregate"];
  tone: string;
  top: string;
  emphasis?: boolean;
  muted?: boolean;
}) {
  const weight = emphasis ? "font-semibold" : "";
  const size = muted ? "py-1.5 text-xs text-stone-600" : "py-2";

  return (
    <>
      <td
        className={`${PINNED_END} ${AGGREGATE_PADDING} ${top} ${tone} ${weight} ${size} border-s border-stone-200 text-end`}
        style={{ insetInlineEnd: AGGREGATE_WIDTH }}
      >
        <bdi className="tabular">{format(aggregate.total, { withSymbol: false })}</bdi>
      </td>
      <td
        className={`${PINNED_END} ${AGGREGATE_PADDING} ${top} ${tone} ${weight} ${size} text-end`}
        style={{ insetInlineEnd: 0 }}
      >
        <bdi className="tabular">
          {aggregate.amount === null
            ? "—"
            : format(aggregate.amount, { withSymbol: false, withMinorUnits: false })}
        </bdi>
      </td>
    </>
  );
}

/** How a cell that departed from its own row's average is marked, and told. */
const DEVIATION_MARK = {
  above: { glyph: "▲", tone: "text-rose-700", label: "חריגה מעל הממוצע של השורה" },
  below: { glyph: "▼", tone: "text-emerald-700", label: "חריגה מתחת לממוצע של השורה" },
} as const;

function Cell({
  cell,
  top,
  emphasis = false,
  muted = false,
}: {
  cell: GridCell;
  top: string;
  emphasis?: boolean;
  muted?: boolean;
}) {
  // Opaque throughout: these cells sit beside pinned columns, and a translucent
  // background would let a scrolled month show through the one pinned over it.
  const tint =
    cell.standing === "current"
      ? "bg-amber-50"
      : cell.standing === "future" || muted
        ? "bg-stone-50"
        : "";
  const size = muted ? "py-1.5 text-xs text-stone-600" : "py-2";
  const mark = cell.deviation === null ? null : DEVIATION_MARK[cell.deviation];

  return (
    <td className={`${CELL_PADDING} ${top} ${tint} ${size} text-end ${emphasis ? "font-semibold" : ""}`}>
      {cell.amount === null ? (
        <span className="text-stone-300" aria-label={cell.standing === "future" ? "טרם הגיע" : "לא נרשם"}>
          —
        </span>
      ) : (
        <>
          {mark === null ? null : (
            <span className={`me-1 text-[0.6rem] ${mark.tone}`} role="img" aria-label={mark.label}>
              {mark.glyph}
            </span>
          )}
          <bdi className={`tabular ${mark === null ? "" : "font-medium"}`}>
            {format(cell.amount, { withSymbol: false })}
          </bdi>
        </>
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
        {/* The same figure as the ממוצע חודשי column of the subtotal row below,
            printed at the same precision, so the two can never look like two
            different numbers. */}
        {summary.aggregate.amount === null ? "—" : format(summary.aggregate.amount, { withMinorUnits: false })}
      </bdi>
      <Denominator average={summary.aggregate} />
    </div>
  );
}
