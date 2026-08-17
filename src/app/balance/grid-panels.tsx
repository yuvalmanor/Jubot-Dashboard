import Link from "next/link";

import {
  type GridBand,
  type GridCell,
  type GridMonth,
  type GridRow,
  type GridSummaryRow,
  type YearGrid,
} from "@/domain/ledger/year-grid";
import { format, toDecimalString } from "@/domain/money/money";
import { formatMonth, formatMonthName, monthKey } from "@/domain/time/calendar-month";

import { closeMonthFromGrid, saveCell } from "./actions";
import { Denominator, monthsPhrase } from "./denominator";
import { type GridLinks, OPEN_CELL_ID, cellKey } from "./grid-links";

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
 * Fifteen columns and a year of categories is a lot of table, so four things make
 * it navigable:
 *
 * - **It is read through a window half a screen tall rather than printed at full
 *   height.** The table scrolls inside itself, on both axes, which keeps the rest
 *   of the screen — the year, the tabs, the category panel — a scroll of the page
 *   away instead of a screenful of rows away.
 * - **קטגוריה pins to the start edge, both aggregates to the end, the month
 *   headings to the top and חיסכון to the foot**, so moving about inside the window
 *   never loses the row you are on, the month you are in, or the totals you are
 *   comparing against. One table on every device; there is no second mobile layout
 *   to keep in sync with this one.
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
 *
 * And the grid is where the holes get filled, so a cell leads to wherever its
 * figure can be written. One affordance per cell, because at 5.25rem a phone
 * column holds a figure and nothing beside it: a cell that is one category-month
 * **opens in place**, and a משותף cell summing two People — which is what the
 * screen opens on — **links to `/balance/month`**, the one screen that can say
 * whose money it was. A subtotal and חיסכון lead nowhere at all: the reading gives
 * them nothing to write to.
 */

/** Twelve months, the category column, and the two aggregates. */
const COLUMN_COUNT = 15;

/**
 * How tall the window over the table is.
 *
 * A year of categories is a screenful and a half of table, and it was printed at
 * its full height: the reader scrolled the *page* to reach הוצאות, which took the
 * month headings off the screen and pushed everything below the grid — the
 * category panel, the notices — out past the end of a very long page. Half the
 * screen instead, scrolled inside itself, with the headings and חיסכון pinned to
 * its edges so what a figure means stays visible however far down the rows go.
 *
 * `svh` rather than `vh`: on a phone `vh` is the height the viewport has *without*
 * the browser's toolbars, so a `vh` box is taller than what can be seen until the
 * toolbars retract.
 */
const TABLE_VIEWPORT = "max-h-[55svh]";

/** The legend, referred to by the table it no longer sits inside. */
const TABLE_LEGEND_ID = "year-grid-legend";

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

/**
 * The four edges of the window, and the layering between them.
 *
 * The side-pinned columns sit at `z-20`, the row pinned to the top and the row
 * pinned to the bottom above them at `z-30` — a body cell that stayed above the
 * headings would paint over them on the way past — and the cells pinned in both
 * directions at `z-40`, above both. The class lists are kept whole rather than
 * composed at the call site: `sticky start-0 z-20` and `sticky top-0 z-30` written
 * side by side would leave two z-indexes on one cell and let the stylesheet's
 * order decide which won.
 */

/** The start edge — קטגוריה, and the band headings that sit in its column. */
const PINNED_START = "sticky start-0 z-20";
/** The end edge — the two aggregates. Each carries its own offset. */
const PINNED_END = "sticky z-20";
/** The top — the month headings. */
const PINNED_TOP = "sticky top-0 z-30";
const PINNED_TOP_START = "sticky start-0 top-0 z-40";
const PINNED_TOP_END = "sticky top-0 z-40";
/** The foot — חיסכון. */
const PINNED_BOTTOM = "sticky bottom-0 z-30";
const PINNED_BOTTOM_START = "sticky start-0 bottom-0 z-40";
const PINNED_BOTTOM_END = "sticky bottom-0 z-40";

export function YearGridTable({
  grid,
  expanded,
  peopleNames,
  openCell,
  links,
}: {
  grid: YearGrid;
  expanded: boolean;
  peopleNames: ReadonlyMap<string, string>;
  /** Which cell is open for entry, as `${personalCategoryId}@${YYYY-MM}`. */
  openCell: string | null;
  links: GridLinks;
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
    <section className="overflow-hidden rounded-lg border border-stone-300 bg-white">
      {/* The legend was a <caption>, which put it inside the window: as wide as the
          table, so it scrolled sideways with the months, and gone as soon as the
          rows moved — in a window this short it would also cost two of the rows it
          explains. It stays above the window and the table points at it. */}
      <p id={TABLE_LEGEND_ID} className="px-4 py-3 text-start text-sm text-stone-500">
        כל הסכומים בשקלים. <span className="text-stone-400">—</span> פירושו שהחודש לא נרשם; 0 פירושו
        שנרשם אפס. סימון בתא פירושו חריגה מהממוצע של אותה שורה. לחיצה על תא פותחת אותו לרישום, או
        מובילה לחודש עצמו כששורה משותפת מסכמת את שני בני הבית.
      </p>

      {/* The window: both axes scroll here, and it is the containing block every
          pinned cell in the table resolves against. */}
      <div className={`${TABLE_VIEWPORT} overflow-auto`}>
        {/* border-separate, not collapse: a collapsed border belongs to the table
            rather than to the cell, and does not travel with a pinned column. */}
        <table
          aria-describedby={TABLE_LEGEND_ID}
          className={`w-full table-fixed border-separate border-spacing-0 text-xs sm:text-sm ${COLUMN_WIDTHS}`}
          style={{ minWidth: TABLE_WIDTH }}
        >
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
                className={`${PINNED_TOP_START} ${CATEGORY_PADDING} border-b border-stone-300 bg-white py-2 text-start font-semibold`}
              >
                קטגוריה
              </th>
              {grid.months.map((column) => (
                <MonthHeader key={column.month.month} column={column} links={links} />
              ))}
              <th
                scope="col"
                className={`${PINNED_TOP_END} ${AGGREGATE_PADDING} border-b border-s border-stone-300 bg-white py-2 text-end font-semibold`}
                style={{ insetInlineEnd: AGGREGATE_WIDTH }}
              >
                סכום שנתי
              </th>
              <th
                scope="col"
                className={`${PINNED_TOP_END} ${AGGREGATE_PADDING} border-b border-stone-300 bg-white py-2 text-end font-semibold`}
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
            openCell={openCell}
            links={links}
          />
          <Band
            band={grid.expenses}
            title="הוצאות"
            subtotal="סה״כ הוצאות"
            expanded={expanded}
            peopleNames={peopleNames}
            openCell={openCell}
            links={links}
          />

          {/* Pinned to the foot of the window. הכנסות − הוצאות is the line the
              year is read for, and in a window this short it would otherwise be
              the one line only a scroll to the very bottom could show. */}
          <tfoot>
            <tr>
              <th
                scope="row"
                className={`${PINNED_BOTTOM_START} ${CATEGORY_PADDING} border-t-2 border-stone-300 bg-stone-50 py-2 text-start font-semibold`}
              >
                חיסכון
                <span className="block text-xs font-normal text-stone-500">
                  הכנסות − הוצאות, מחושב בקריאה
                </span>
              </th>
              <SummaryCells
                summary={grid.saving}
                tone="bg-stone-50"
                top="border-t-2 border-stone-300"
                pinned
              />
            </tr>
          </tfoot>
        </table>
      </div>
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

function MonthHeader({ column, links }: { column: GridMonth; links: GridLinks }) {
  const name = formatMonthName(column.month);

  if (column.standing === "future") {
    return (
      <th scope="col" className={`${PINNED_TOP} ${CELL_PADDING} border-b border-stone-300 bg-stone-50 py-2 text-end font-medium text-stone-300`}>
        {name}
        <span className="block text-xs font-normal">טרם הגיע</span>
      </th>
    );
  }

  // The heading is the way to the month itself — the one screen that records a
  // whole one.
  const heading = (
    <Link href={links.month(column.month, null)} prefetch={false} className="hover:underline">
      {name}
    </Link>
  );

  if (column.standing === "current") {
    return (
      <th scope="col" className={`${PINNED_TOP} ${CELL_PADDING} border-b border-stone-300 bg-amber-50 py-2 text-end font-semibold text-amber-900`}>
        {heading}
        <span className="block text-xs font-normal text-amber-800">בתהליך</span>
      </th>
    );
  }

  return (
    <th scope="col" className={`${PINNED_TOP} ${CELL_PADDING} border-b border-stone-300 bg-white py-2 text-end font-medium`}>
      {heading}
      {column.counted ? (
        <ClosingNote column={column} links={links} />
      ) : (
        <span className="block text-xs font-normal text-stone-400">מחוץ להיסטוריה</span>
      )}
    </th>
  );
}

/**
 * Whether a closed calendar month is also a *closed* month — one where every
 * category active in it holds a figure.
 *
 * Both answers are printed, not only the unhappy one. A mark that appears only
 * when something is wrong teaches nobody that it is being checked, and a blank
 * column heading would leave "nothing missing" and "nothing checked" looking
 * identical. It is stated for the months the aggregates count and no others: a
 * month the history does not reach has no blanks to fill, and the month being
 * lived is not over.
 */
function ClosingNote({ column, links }: { column: GridMonth; links: GridLinks }) {
  const { closure } = column;

  if (closure.state === "empty") return null;

  if (closure.state === "closed") {
    return <span className="block text-xs font-normal text-stone-400">מלא</span>;
  }

  return (
    <Link
      href={links.closing(column.month)}
      prefetch={false}
      className="block text-xs font-normal text-amber-700 underline-offset-2 hover:underline"
    >
      חסרים <bdi className="tabular">{closure.blanks.length}</bdi>
    </Link>
  );
}

function Band({
  band,
  title,
  subtotal,
  expanded,
  peopleNames,
  openCell,
  links,
}: {
  band: GridBand;
  title: string;
  subtotal: string;
  expanded: boolean;
  peopleNames: ReadonlyMap<string, string>;
  openCell: string | null;
  links: GridLinks;
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
        <CategoryRow
          key={line.key}
          line={line}
          expanded={expanded}
          peopleNames={peopleNames}
          openCell={openCell}
          links={links}
        />
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
  openCell,
  links,
}: {
  line: GridRow;
  expanded: boolean;
  peopleNames: ReadonlyMap<string, string>;
  openCell: string | null;
  links: GridLinks;
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
          <Cell
            key={cell.month.month}
            cell={cell}
            top="border-t border-stone-100"
            entry={entryFor(line, cell, openCell, links)}
          />
        ))}

        <AggregateCells aggregate={line.aggregate} tone="bg-white" top="border-t border-stone-100" />
      </tr>

      {showContributions
        ? line.contributions.map((contribution) => (
            <ContributionRow
              key={contribution.key}
              line={contribution}
              peopleNames={peopleNames}
              openCell={openCell}
              links={links}
            />
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
  openCell,
  links,
}: {
  line: GridRow;
  peopleNames: ReadonlyMap<string, string>;
  openCell: string | null;
  links: GridLinks;
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
          entry={entryFor(line, cell, openCell, links)}
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

/**
 * The twelve cells and the two aggregates of a subtotal or of חיסכון.
 *
 * `pinned` is חיסכון, held at the foot of the window. A pinned row has the rest of
 * the table sliding underneath it, so its cells have to carry the row's own
 * background — a subtotal in the middle of the scroll can leave a past month
 * transparent over the table's white, and this row cannot.
 */
function SummaryCells({
  summary,
  tone,
  top,
  pinned = false,
}: {
  summary: GridSummaryRow;
  tone: string;
  top: string;
  pinned?: boolean;
}) {
  return (
    <>
      {summary.cells.map((cell) => (
        <Cell
          key={cell.month.month}
          cell={cell}
          top={top}
          tone={pinned ? tone : ""}
          pinBottom={pinned}
          emphasis
        />
      ))}
      <AggregateCells
        aggregate={summary.aggregate}
        tone={tone}
        top={top}
        pinBottom={pinned}
        emphasis
      />
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
  pinBottom = false,
}: {
  aggregate: GridRow["aggregate"];
  tone: string;
  top: string;
  emphasis?: boolean;
  muted?: boolean;
  /** On חיסכון, where these two are pinned to the end edge *and* to the foot. */
  pinBottom?: boolean;
}) {
  const weight = emphasis ? "font-semibold" : "";
  const size = muted ? "py-1.5 text-xs text-stone-600" : "py-2";
  const pin = pinBottom ? PINNED_BOTTOM_END : PINNED_END;

  return (
    <>
      <td
        className={`${pin} ${AGGREGATE_PADDING} ${top} ${tone} ${weight} ${size} border-s border-stone-200 text-end`}
        style={{ insetInlineEnd: AGGREGATE_WIDTH }}
      >
        <bdi className="tabular">{format(aggregate.total, { withSymbol: false })}</bdi>
      </td>
      <td
        className={`${pin} ${AGGREGATE_PADDING} ${top} ${tone} ${weight} ${size} text-end`}
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

/**
 * What a cell of a category row leads to, and whether it is the one currently
 * open. A subtotal and חיסכון are given none of this, so they cannot acquire an
 * input by accident.
 */
interface CellEntry {
  readonly links: GridLinks;
  /** The row's own name, so an opened field says what it is a figure for. */
  readonly label: string;
  /** Whose tab the month link opens. `null` on a משותף row summing two People. */
  readonly personId: string | null;
  readonly open: boolean;
}

function entryFor(
  line: GridRow,
  cell: GridCell,
  openCell: string | null,
  links: GridLinks,
): CellEntry {
  return {
    links,
    label: line.name,
    personId: line.personId,
    open: cell.writesTo !== null && cellKey(cell.writesTo, cell.month) === openCell,
  };
}

function Cell({
  cell,
  top,
  tone = "",
  emphasis = false,
  muted = false,
  pinBottom = false,
  entry,
}: {
  cell: GridCell;
  top: string;
  /** The row's background, for a row that has to have one. See `SummaryCells`. */
  tone?: string;
  emphasis?: boolean;
  muted?: boolean;
  pinBottom?: boolean;
  entry?: CellEntry;
}) {
  // Opaque throughout: these cells sit beside pinned columns, and a translucent
  // background would let a scrolled month show through the one pinned over it.
  const tint =
    cell.standing === "current"
      ? "bg-amber-50"
      : cell.standing === "future" || muted
        ? "bg-stone-50"
        : tone;
  const size = muted ? "py-1.5 text-xs text-stone-600" : "py-2";
  const pin = pinBottom ? PINNED_BOTTOM : "";
  const className = `${pin} ${CELL_PADDING} ${top} ${tint} ${size} text-end ${emphasis ? "font-semibold" : ""}`;
  const mark = cell.deviation === null ? null : DEVIATION_MARK[cell.deviation];

  if (entry !== undefined && entry.open && cell.writesTo !== null) {
    // The id the link that opened it pointed at, so the window over the table is
    // scrolled to the field rather than to the top of the year.
    return (
      <td id={OPEN_CELL_ID} className={className}>
        <CellEntryForm cell={cell} entry={entry} categoryId={cell.writesTo} />
      </td>
    );
  }

  const figure =
    cell.amount === null ? (
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
    );

  return <td className={className}>{withDestination(figure, cell, entry)}</td>;
}

/**
 * The one affordance a cell gets. A cell that is a single category-month opens in
 * place — "I forgot חו"ל in May" should not cost a form of twenty-two fields — and
 * one that is not goes to the month, which is the only screen that can say whose
 * money it was. A month that has not arrived leads nowhere; it is inert, blanks
 * and all.
 *
 * `prefetch={false}` on all of them: three hundred cells prefetching a route each
 * would fetch the whole ledger a hundred times over to save a click that has not
 * happened.
 */
function withDestination(
  figure: React.ReactNode,
  cell: GridCell,
  entry: CellEntry | undefined,
): React.ReactNode {
  if (entry === undefined || cell.standing === "future") return figure;

  const href =
    cell.writesTo === null
      ? entry.links.month(cell.month, entry.personId)
      : entry.links.openCell(cell.writesTo, cell.month);

  return (
    <Link href={href} prefetch={false} className="block hover:underline">
      {figure}
    </Link>
  );
}

/** One cell, opened. Saving writes one category-month and returns to this view. */
function CellEntryForm({
  cell,
  entry,
  categoryId,
}: {
  cell: GridCell;
  entry: CellEntry;
  categoryId: string;
}) {
  return (
    <form action={saveCell} className="flex flex-col items-stretch gap-1">
      <ReturnToFields links={entry.links} />
      <input type="hidden" name="month" value={monthKey(cell.month)} />
      <input type="hidden" name="cell" value={categoryId} />

      <input
        // A blank field clears the figure back to *not recorded*, which is not a
        // zero — the same rule the month form's fields follow, because it is the
        // same write.
        name="amount"
        type="text"
        inputMode="decimal"
        dir="ltr"
        autoComplete="off"
        autoFocus
        aria-label={`${entry.label}, ${formatMonth(cell.month)}`}
        placeholder="—"
        defaultValue={cell.amount === null ? "" : toDecimalString(cell.amount)}
        className="tabular w-full rounded-sm border border-stone-400 bg-white px-1 py-0.5 text-left text-xs"
      />

      <div className="flex items-center justify-between gap-1">
        <button
          type="submit"
          className="rounded-sm bg-stone-900 px-1.5 py-0.5 text-[0.65rem] font-medium text-white hover:bg-stone-800"
        >
          שמירה
        </button>
        <Link href={entry.links.cancel} className="text-[0.65rem] text-stone-500 hover:underline">
          ביטול
        </Link>
      </div>
    </form>
  );
}

/** What a write carries so that it comes back to the exact view it was made from. */
export function ReturnToFields({ links }: { links: GridLinks }) {
  return (
    <>
      {Object.entries(links.returnTo).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/**
 * Closing one month, with its blanks listed before anything is written.
 *
 * The list is the point. Imported history is full of the same ambiguity a fresh
 * month has — a blank might be an unfinished entry or a month in which the thing
 * did not happen — and the only thing that can resolve it is a person looking at
 * the names. So this is a month at a time and there is deliberately no bulk path:
 * rewriting two years of history in one click is the sort of irreversible mass
 * edit that should not have a button.
 */
export function ClosingPanel({
  column,
  links,
  peopleNames,
}: {
  column: GridMonth;
  links: GridLinks;
  peopleNames: ReadonlyMap<string, string>;
}) {
  const { closure } = column;

  if (closure.state !== "open") {
    return (
      <section className="rounded-lg border border-stone-300 bg-white p-5" role="status">
        <p className="font-medium">{formatMonth(column.month)}</p>
        <p className="mt-1 text-sm text-stone-600">
          {closure.state === "closed"
            ? "לכל קטגוריה שהייתה פעילה בחודש הזה יש רישום. החודש סגור."
            : "אף קטגוריה לא הייתה פעילה בחודש הזה, ואין מה לסגור."}
        </p>
        <Link
          href={links.cancel}
          className="mt-3 inline-block rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
        >
          חזרה לטבלה
        </Link>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50 p-5">
      <h2 className="font-semibold text-amber-900">סגירת {formatMonth(column.month)}</h2>

      <p className="mt-1 text-sm text-amber-900">
        <bdi className="tabular">{closure.blanks.length}</bdi> קטגוריות פעילות ללא רישום. סגירת החודש
        תרשום בהן אפס — ולא תיגע בשום סכום שכבר נרשם.
      </p>

      <ul className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-sm text-amber-900">
        {closure.blanks.map((category) => (
          <li key={category.id} className="rounded-sm bg-white/70 px-2 py-0.5">
            <bdi>{category.name}</bdi>
            <span className="text-amber-700">
              {" · "}
              <bdi>{peopleNames.get(category.personId) ?? category.personId}</bdi>
            </span>
          </li>
        ))}
      </ul>

      <form action={closeMonthFromGrid} className="mt-4 flex flex-wrap items-center gap-3">
        <ReturnToFields links={links} />
        <input type="hidden" name="month" value={monthKey(column.month)} />
        {closure.blanks.map((category) => (
          <input key={category.id} type="hidden" name="blank" value={category.id} />
        ))}

        <button
          type="submit"
          className="rounded-md bg-stone-900 px-4 py-2 font-medium text-white hover:bg-stone-800"
        >
          רישום <bdi className="tabular">{closure.blanks.length}</bdi> הקטגוריות כאפס
        </button>

        <Link
          href={links.cancel}
          className="rounded-md border border-stone-300 bg-white px-4 py-2 font-medium hover:bg-stone-50"
        >
          ביטול
        </Link>
      </form>

      <p className="mt-3 text-xs text-amber-800">
        חודש אחד בכל פעם. אין בשום מקום פעולה שסוגרת יותר מחודש אחד.
      </p>
    </section>
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
