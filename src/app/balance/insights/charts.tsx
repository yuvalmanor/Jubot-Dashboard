import { type TrendPoint } from "@/domain/ledger/ledger-analytics";
import { toMajorUnits } from "@/domain/money/money";

/**
 * The two charts of the מאזן's reading half, drawn as inline SVG.
 *
 * No charting library: this is a two-person app on free tiers, and a dependency
 * that ships a hundred kilobytes to draw twelve bars is not worth its weight.
 * Both charts are server-rendered and carry no client JavaScript at all.
 *
 * The time axis runs left to right inside an RTL page, which is the convention
 * every spreadsheet this replaces already used. Each chart states that in words
 * and repeats every figure in the table beneath it, so nothing here is the only
 * place a number can be read.
 */

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 14, right: 10, bottom: 30, left: 10 };
const PLOT_WIDTH = WIDTH - PAD.left - PAD.right;
const PLOT_HEIGHT = HEIGHT - PAD.top - PAD.bottom;

const INCOME = "#059669";
const EXPENSES = "#e11d48";
const SAVING = "#1c1917";
const PREVIOUS = "#a8a29e";

function monthLabel(point: TrendPoint): string {
  return point.month.month === 1 ? String(point.month.year) : String(point.month.month);
}

/**
 * הכנסות, הוצאות and חיסכון per month, with the previous year's חיסכון marked as
 * a tick behind each month's bar — the comparison the sheet could never show.
 */
export function TrendChart({ points, label }: { points: readonly TrendPoint[]; label: string }) {
  if (points.length === 0) return null;

  const values = points.flatMap((point) => [
    toMajorUnits(point.income),
    toMajorUnits(point.expenses),
    toMajorUnits(point.saving),
    ...(point.previous === null ? [] : [toMajorUnits(point.previous.saving)]),
  ]);

  const top = Math.max(0, ...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom || 1;
  const y = (value: number) => PAD.top + ((top - value) / span) * PLOT_HEIGHT;
  const zeroY = y(0);

  const groupWidth = PLOT_WIDTH / points.length;
  const barWidth = Math.max(3, groupWidth * 0.24);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-56 w-full"
        role="img"
        aria-label={label}
        preserveAspectRatio="none"
      >
        <line x1={PAD.left} x2={WIDTH - PAD.right} y1={zeroY} y2={zeroY} stroke="#d6d3d1" strokeWidth={1} />

        {points.map((point, index) => {
          const centre = PAD.left + groupWidth * (index + 0.5);
          const bars = [
            { value: toMajorUnits(point.income), colour: INCOME, offset: -1 },
            { value: toMajorUnits(point.expenses), colour: EXPENSES, offset: 0 },
            { value: toMajorUnits(point.saving), colour: SAVING, offset: 1 },
          ];

          return (
            <g key={`${point.month.year}-${point.month.month}`}>
              {bars.map((bar) => {
                const barY = Math.min(y(bar.value), zeroY);
                const height = Math.max(1, Math.abs(y(bar.value) - zeroY));
                return (
                  <rect
                    key={bar.colour}
                    x={centre + bar.offset * barWidth - barWidth / 2}
                    y={barY}
                    width={barWidth}
                    height={height}
                    fill={bar.colour}
                  />
                );
              })}

              {point.previous === null ? null : (
                <line
                  x1={centre - barWidth * 1.6}
                  x2={centre + barWidth * 1.6}
                  y1={y(toMajorUnits(point.previous.saving))}
                  y2={y(toMajorUnits(point.previous.saving))}
                  stroke={PREVIOUS}
                  strokeWidth={2}
                  strokeDasharray="4 3"
                />
              )}

              <text
                x={centre}
                y={HEIGHT - 10}
                textAnchor="middle"
                fontSize={11}
                fill="#78716c"
                direction="ltr"
              >
                {monthLabel(point)}
              </text>
            </g>
          );
        })}
      </svg>

      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-600">
        <Swatch colour={INCOME} label="הכנסות" />
        <Swatch colour={EXPENSES} label="הוצאות" />
        <Swatch colour={SAVING} label="חיסכון" />
        <Swatch colour={PREVIOUS} label="חיסכון אשתקד" dashed />
        <span className="text-stone-500">ציר הזמן מתקדם משמאל לימין.</span>
      </figcaption>
    </figure>
  );
}

/**
 * חיסכון as a share of income over time. A month with no income has no share to
 * plot, so the line breaks there rather than dropping to zero — the gap is the
 * honest drawing of "there is no percentage here".
 */
export function SavingRateChart({ points, label }: { points: readonly TrendPoint[]; label: string }) {
  if (points.length === 0) return null;

  const ratios = points.map((point) => point.savingRate.ratio);
  const known = ratios.filter((value): value is number => value !== null);
  if (known.length === 0) return null;

  const top = Math.max(1, ...known);
  const bottom = Math.min(0, ...known);
  const span = top - bottom || 1;
  const y = (value: number) => PAD.top + ((top - value) / span) * PLOT_HEIGHT;
  const x = (index: number) => PAD.left + (PLOT_WIDTH / Math.max(1, points.length - 1)) * index;

  // Each run of consecutive known months is its own line; the gaps stay gaps.
  const segments: { index: number; ratio: number }[][] = [];
  let run: { index: number; ratio: number }[] = [];
  ratios.forEach((ratio, index) => {
    if (ratio === null) {
      if (run.length > 0) segments.push(run);
      run = [];
      return;
    }
    run.push({ index, ratio });
  });
  if (run.length > 0) segments.push(run);

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-48 w-full" role="img" aria-label={label}>
        <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(0)} y2={y(0)} stroke="#d6d3d1" strokeWidth={1} />
        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={y(1)}
          y2={y(1)}
          stroke="#e7e5e4"
          strokeWidth={1}
          strokeDasharray="3 4"
        />

        {segments.map((segment) => (
          <g key={segment[0]?.index}>
            <polyline
              points={segment.map((entry) => `${x(entry.index)},${y(entry.ratio)}`).join(" ")}
              fill="none"
              stroke={INCOME}
              strokeWidth={2}
            />
            {segment.map((entry) => (
              <circle key={entry.index} cx={x(entry.index)} cy={y(entry.ratio)} r={3} fill={INCOME} />
            ))}
          </g>
        ))}

        {points.map((point, index) => (
          <text
            key={`${point.month.year}-${point.month.month}`}
            x={x(index)}
            y={HEIGHT - 10}
            textAnchor="middle"
            fontSize={11}
            fill="#78716c"
            direction="ltr"
          >
            {monthLabel(point)}
          </text>
        ))}
      </svg>

      <figcaption className="mt-2 text-xs text-stone-600">
        הקו נקטע בחודש שאין בו הכנסה — אין ממה לחשב אחוז, וזה אינו אפס.
      </figcaption>
    </figure>
  );
}

function Swatch({ colour, label, dashed = false }: { colour: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-4 rounded-sm"
        style={dashed ? { border: `2px dashed ${colour}`, height: 0 } : { backgroundColor: colour }}
      />
      {label}
    </span>
  );
}
