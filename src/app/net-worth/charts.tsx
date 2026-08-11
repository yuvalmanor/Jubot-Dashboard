import { type NetWorthPoint } from "@/domain/networth/net-worth-analytics";
import { toMajorUnits } from "@/domain/money/money";

/**
 * The trajectory, drawn as inline SVG. No charting library and no client
 * JavaScript, for the same reason the מאזן's charts have none: a dependency that
 * ships a hundred kilobytes to draw eight points is not worth its weight on a
 * two-person app.
 *
 * The time axis runs left to right inside an RTL page, as every spreadsheet this
 * replaces already did, and every figure in the picture is repeated in the table
 * beneath it — nothing here is the only place a number can be read.
 */

const WIDTH = 720;
const HEIGHT = 240;
const PAD = { top: 16, right: 12, bottom: 30, left: 12 };
const PLOT_WIDTH = WIDTH - PAD.left - PAD.right;
const PLOT_HEIGHT = HEIGHT - PAD.top - PAD.bottom;

const LINE = "#1c1917";
const CARRIED = "#a8a29e";

function pointLabel(point: NetWorthPoint): string {
  return `${point.takenOn.day}/${point.takenOn.month}`;
}

/**
 * Net worth at each snapshot, each at its own rate. A snapshot that could not be
 * restated into the reading currency has no point: the line breaks there rather
 * than dropping to a total nobody could compute.
 */
export function TrajectoryChart({ points, label }: { points: readonly NetWorthPoint[]; label: string }) {
  const plotted = points.flatMap((point, index) =>
    point.total === null ? [] : [{ index, point, value: toMajorUnits(point.total) }],
  );
  if (plotted.length === 0) return null;

  const values = plotted.map((entry) => entry.value);
  const top = Math.max(0, ...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom || 1;
  const y = (value: number) => PAD.top + ((top - value) / span) * PLOT_HEIGHT;
  const x = (index: number) => PAD.left + (PLOT_WIDTH / Math.max(1, points.length - 1)) * index;

  // Each run of consecutive readable snapshots is its own line; the gaps stay gaps.
  const segments: { index: number; value: number }[][] = [];
  let run: { index: number; value: number }[] = [];
  let expected = 0;
  for (const entry of plotted) {
    if (entry.index !== expected && run.length > 0) {
      segments.push(run);
      run = [];
    }
    run.push({ index: entry.index, value: entry.value });
    expected = entry.index + 1;
  }
  if (run.length > 0) segments.push(run);

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-60 w-full" role="img" aria-label={label}>
        <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(0)} y2={y(0)} stroke="#d6d3d1" strokeWidth={1} />

        {segments.map((segment) => (
          <g key={segment[0]?.index}>
            <polyline
              points={segment.map((entry) => `${x(entry.index)},${y(entry.value)}`).join(" ")}
              fill="none"
              stroke={LINE}
              strokeWidth={2}
            />
          </g>
        ))}

        {plotted.map((entry) => (
          <circle
            key={entry.point.snapshotId}
            cx={x(entry.index)}
            cy={y(entry.value)}
            r={4}
            // A point nobody measured on its own date is drawn hollow: the reading
            // is real, but every figure in it was carried forward.
            fill={entry.point.measured === 0 ? "#ffffff" : LINE}
            stroke={entry.point.measured === 0 ? CARRIED : LINE}
            strokeWidth={2}
          />
        ))}

        {points.map((point, index) => (
          <text
            key={`${point.snapshotId}-label`}
            x={x(index)}
            y={HEIGHT - 10}
            textAnchor="middle"
            fontSize={11}
            fill="#78716c"
            direction="ltr"
          >
            {pointLabel(point)}
          </text>
        ))}
      </svg>

      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-600">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-2.5 rounded-full bg-stone-900" />
          נמדד בתאריך הצילום
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-full border-2 border-stone-400 bg-white"
          />
          כל השורות נגררו
        </span>
        <span className="text-stone-500">ציר הזמן מתקדם משמאל לימין. כל נקודה בשער של הצילום שלה.</span>
      </figcaption>
    </figure>
  );
}
