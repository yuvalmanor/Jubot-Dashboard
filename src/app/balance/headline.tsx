import { type GridCell, type GridSummaryRow, type YearBefore, type YearGrid } from "@/domain/ledger/year-grid";
import { type Money, format, isZero, ratio, subtract, toMajorUnits } from "@/domain/money/money";
import { formatMonthName } from "@/domain/time/calendar-month";

import { monthsPhrase } from "./denominator";

/**
 * The three figures the year is read for, at the top of the screen and shaped.
 *
 * What stood here was three averages and a sentence. It answered "how much a
 * month" and nothing else: not how much in all, not whether that is more or less
 * than last year, and not what the year looked like on the way through. All three
 * of those were a screen away, on `/balance/insights`, which is a long way to go
 * to learn whether a year is going well.
 *
 * So each card now carries four readings of one figure, in the order a person
 * asks for them: **how much** (the year's total, as the headline), **against
 * what** (the same months a year earlier), **what shape** (twelve bars), and
 * **how much a month** (the average, with its divisor). Nothing here is computed
 * — every figure arrives from `yearGrid` already decided, including which months
 * it counted — so these cards and the table beneath them cannot disagree.
 *
 * One scale carries all three charts. Drawn to their own maxima the three would
 * each fill their card and הוצאות would look the size of הכנסות; on one scale the
 * shape of the year is visible at a glance, which is the only reason to draw bars
 * at all.
 */

const BAR_COUNT = 12;

/** Which way is the good way, for a figure that moved. There is no neutral third. */
type Direction = "up" | "down";

export function YearHeadline({ grid }: { grid: YearGrid }) {
  // One scale for the three charts. Saving can be negative, so the floor is the
  // lowest figure on the screen or nought, whichever is lower — a bar below the
  // line has to have somewhere to go.
  const everyAmount = [grid.income.total, grid.expenses.total, grid.saving].flatMap((summary) =>
    summary.cells.flatMap((cell) => (cell.amount === null ? [] : [toMajorUnits(cell.amount)])),
  );
  const scale = {
    top: Math.max(0, ...everyAmount),
    bottom: Math.min(0, ...everyAmount),
  };

  return (
    <section aria-label="סיכום השנה" className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3 sm:gap-4">
        <FigureCard
          label="הכנסות"
          tone="income"
          better="up"
          summary={grid.income.total}
          before={grid.before}
          previous={grid.before.income}
          scale={scale}
        />
        <FigureCard
          label="הוצאות"
          tone="expense"
          better="down"
          summary={grid.expenses.total}
          before={grid.before}
          previous={grid.before.expenses}
          scale={scale}
        />
        <FigureCard
          label="חיסכון"
          tone="saving"
          better="up"
          summary={grid.saving}
          before={grid.before}
          previous={grid.before.saving}
          scale={scale}
          share={grid.income.total.aggregate.total}
          lead
        />
      </div>

      <DenominatorNote grid={grid} />
    </section>
  );
}

/**
 * The divisor, said once for the three cards rather than three times.
 *
 * All three divide by the same months — the year's closed ones, as far as the
 * ledger's own history reaches — so repeating it on each card would be three
 * copies of one fact and no reader would read the third.
 */
function DenominatorNote({ grid }: { grid: YearGrid }) {
  const { denominatorMonths } = grid;

  if (denominatorMonths.length === 0) {
    return (
      <p className="px-1 text-[13px] text-stone-500">
        אין בשנה הזו חודש סגור לחלק בו, ולכן אין ממוצע ואין סכום שנתי.
      </p>
    );
  }

  const span = monthsPhrase(denominatorMonths);
  const current = grid.months.find((column) => column.standing === "current");

  return (
    <p className="px-1 text-[13px] text-stone-500">
      הסכומים והממוצעים נקראים על <bdi className="tabular">{denominatorMonths.length}</bdi> החודשים
      הסגורים של השנה
      {span === null ? null : <> ({span})</>}.
      {current === undefined ? null : (
        <> {formatMonthName(current.month)} בתהליך — מוצג בגרף ובטבלה, ואינו נספר.</>
      )}
    </p>
  );
}

const TONES = {
  income: { fill: "var(--color-income)", dot: "bg-income", text: "text-income" },
  expense: { fill: "var(--color-expense)", dot: "bg-expense", text: "text-expense" },
  saving: { fill: "var(--color-saving)", dot: "bg-saving", text: "text-saving" },
} as const;

function FigureCard({
  label,
  tone,
  better,
  summary,
  before,
  previous,
  scale,
  share,
  lead = false,
}: {
  label: string;
  tone: keyof typeof TONES;
  better: Direction;
  summary: GridSummaryRow;
  before: YearBefore;
  /** The same months a year earlier, for this one figure. */
  previous: Money;
  scale: { readonly top: number; readonly bottom: number };
  /** חיסכון is also read as a share of the income it came out of. */
  share?: Money;
  /** חיסכון: the line the year is read for, and the one given the heavier card. */
  lead?: boolean;
}) {
  const { aggregate } = summary;

  return (
    <article
      className={`rounded-card bg-surface shadow-card flex flex-col gap-3 p-4 sm:p-5 ${
        lead ? "ring-1 ring-line-strong" : ""
      }`}
    >
      <div>
        <h3 className="flex items-center gap-2 text-[13px] font-medium text-stone-500">
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${TONES[tone].dot}`} />
          {label}
        </h3>

        <p className="figure mt-1.5 text-[26px] font-semibold sm:text-[30px]">
          <bdi>{format(aggregate.total, { withMinorUnits: false })}</bdi>
        </p>

        <Change current={aggregate.total} previous={previous} before={before} better={better} />
      </div>

      <MiniBars cells={summary.cells} scale={scale} fill={TONES[tone].fill} label={label} />

      <p className="text-[13px] text-stone-500">
        ממוצע{" "}
        <bdi className="tabular font-medium text-stone-700">
          {aggregate.amount === null
            ? "—"
            : format(aggregate.amount, { withMinorUnits: false })}
        </bdi>{" "}
        לחודש
        {share === undefined ? null : <SavingShare saving={aggregate.total} income={share} />}
      </p>
    </article>
  );
}

/** חיסכון as a share of the הכנסות it came out of. No income, no share — not 0%. */
function SavingShare({ saving, income }: { saving: Money; income: Money }) {
  const share = ratio(saving, income);
  if (share === null) return null;
  return (
    <>
      {" · "}
      <bdi className="tabular font-medium text-stone-700">{Math.round(share * 100)}%</bdi>{" "}
      מההכנסות
    </>
  );
}

/**
 * The same months a year earlier.
 *
 * It is stated as money and not only as a percentage: 6% of a figure nobody has
 * in their head is not a reading. And a year the history does not reach behind
 * says so, rather than comparing against a zero that was never written down —
 * which would report every first year as infinite growth.
 */
function Change({
  current,
  previous,
  before,
  better,
}: {
  current: Money;
  previous: Money;
  before: YearBefore;
  better: Direction;
}) {
  if (before.recordedMonths === 0) {
    return (
      <p className="mt-1 text-[13px] text-stone-400">
        אין נתונים מ־<bdi className="tabular">{before.year}</bdi> להשוות אליהם
      </p>
    );
  }

  const change = subtract(current, previous);
  const moved = ratio(change, previous);
  const rose = change.minorUnits > 0;
  const flat = isZero(change);
  const good = flat ? null : rose === (better === "up");

  return (
    <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
      <span
        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium ${
          good === null
            ? "bg-sunken text-stone-500"
            : good
              ? "bg-emerald-50 text-emerald-800"
              : "bg-rose-50 text-rose-800"
        }`}
      >
        <span aria-hidden="true">{flat ? "=" : rose ? "▲" : "▼"}</span>
        <bdi className="tabular">
          {moved === null
            ? format(change, { withMinorUnits: false, withSign: true })
            : `${Math.abs(Math.round(moved * 1000) / 10)}%`}
        </bdi>
        <span className="sr-only">{flat ? "ללא שינוי" : rose ? "עלייה" : "ירידה"}</span>
      </span>

      <span className="text-stone-500">
        מול <bdi className="tabular">{format(previous, { withMinorUnits: false })}</bdi> ב־
        <bdi className="tabular">{before.year}</bdi>
      </span>
    </p>
  );
}

/**
 * Twelve months as twelve bars, on the scale the three cards share.
 *
 * The three rules the table follows hold here too, because they are the same
 * three facts. A month never recorded draws nothing — not a bar of nought. A
 * month that has not arrived draws nothing either, and is not a month of no
 * spending. And the month being lived is drawn faintly: its figure is real but
 * the month is half over, which is exactly why neither aggregate counts it.
 *
 * The year runs right to left, the way the strip of months under these cards and
 * the columns of the table under that one do. The trends screen draws its charts
 * the other way about — the direction every spreadsheet this replaced used — and
 * that is defensible on a screen of its own; here the same twelve months are
 * drawn three times within one screenful, and two of them disagreeing about which
 * end the year starts at would make the third unreadable.
 */
function MiniBars({
  cells,
  scale,
  fill,
  label,
}: {
  cells: readonly GridCell[];
  scale: { readonly top: number; readonly bottom: number };
  fill: string;
  label: string;
}) {
  const WIDTH = 240;
  const HEIGHT = 56;
  const slot = WIDTH / BAR_COUNT;
  const width = slot * 0.56;

  const span = scale.top - scale.bottom || 1;
  const y = (value: number) => ((scale.top - value) / span) * HEIGHT;
  const zero = y(0);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-14 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label} לפי חודש, מימין ינואר ועד דצמבר משמאל`}
    >
      {/* The one rule on the chart: where nought is. Everything else is a bar. */}
      <line x1={0} x2={WIDTH} y1={zero} y2={zero} stroke="rgba(28,25,23,0.12)" strokeWidth={1} />

      {cells.map((cell, index) => {
        if (cell.amount === null || cell.standing === "future") return null;

        const value = toMajorUnits(cell.amount);
        const top = Math.min(y(value), zero);
        const height = Math.max(1.5, Math.abs(y(value) - zero));

        return (
          <rect
            key={cell.month.month}
            x={slot * (BAR_COUNT - 1 - index) + (slot - width) / 2}
            y={top}
            width={width}
            height={height}
            rx={1.5}
            fill={fill}
            // Half-lived, and therefore in neither aggregate. The grid's own
            // column heading says the same thing in words.
            opacity={cell.standing === "current" ? 0.3 : 1}
          >
            <title>{`${formatMonthName(cell.month)}: ${format(cell.amount, { withMinorUnits: false })}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
