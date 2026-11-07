import { type ShareSlice, type YearGrid } from "@/domain/ledger/year-grid";
import { format } from "@/domain/money/money";

/**
 * Where the year's הוצאות went, as parts of one whole.
 *
 * This was asked for as a pie, and the ring is here because that is the shape
 * the question has: one whole, split. What a ring on its own cannot do is let
 * anyone read the parts — a dozen-odd wedges means the bottom half are slivers,
 * and two wedges of 7% and 8% are indistinguishable by eye at any size. So the
 * ring sits beside a ranked list that carries every name, every share and every
 * figure, and the ring's job is reduced to the one it is good at: showing at a
 * glance how concentrated the year was.
 *
 * Groups are why the chart is readable at all. חשמל, ארנונה, גז, מים, שכ"ד and
 * אינטרנט are six rows in the table and one question here, so a line marked with
 * a Group is drawn as part of its Group's wedge and the wedge opens onto its
 * parts. Nothing is added up twice: `yearGrid` decides the wedges from the very
 * same row totals the table prints, so a wedge and its row cannot disagree.
 *
 * Colour does two jobs and no more. A Group carries an accent, because a Group
 * is an identity the household chose and put a name to. Everything else is one
 * hue, darkest first, because rank is the only thing that distinguishes an
 * ungrouped line from its neighbour — fifteen invented hues would be fifteen
 * identities nobody asked for, and under colour-blindness most of them would be
 * the same hue anyway.
 */

/**
 * The accents a Group may carry, in the order Groups are met.
 *
 * Validated as a categorical set against the light surface: all four clear the
 * lightness band, the chroma floor, 3:1 contrast, and adjacent-pair separation
 * under protanopia, deuteranopia and tritanopia. A fifth Group is not given an
 * invented fifth hue — a generated colour is indistinguishable from one of these
 * under CVD — it falls through to the ranked ramp like any other line, and its
 * name in the list is what identifies it.
 */
const GROUP_ACCENTS = ["#b45309", "#0d9488", "#6d28d9", "#9f1239"] as const;

/**
 * One hue, darkest first: this is a magnitude, and the reader's question of it
 * is "which is biggest", never "which is which". Past the eighth the tail stays
 * at the lightest step — a tail is a tail, and the list beside it is where its
 * names are.
 */
const RANK_RAMP = [
  "#9f1239",
  "#be123c",
  "#e11d48",
  "#f43f5e",
  "#fb7185",
  "#fda4af",
  "#fecdd3",
  "#ffe4e6",
] as const;

/** Degrees of surface left between two wedges, so adjacent fills never touch. */
const WEDGE_GAP = 1.2;

const RADIUS = 56;
const THICKNESS = 20;
const SIZE = (RADIUS + THICKNESS / 2 + 2) * 2;

interface PaintedSlice extends ShareSlice {
  readonly colour: string;
}

/**
 * The accent each Group carries, decided once for the whole screen.
 *
 * The table marks its rows with it and the ring draws its wedges with it, so a
 * Group is one colour everywhere it appears — which is the only thing that makes
 * "the amber rows" and "the amber wedge" the same sentence. Groups are met in
 * size order, so the mapping is stable for as long as the Groups are, and it
 * follows the entity and never its rank: an ungrouped line moving up or down
 * repaints nothing.
 */
export function groupColours(grid: YearGrid): ReadonlyMap<string, string> {
  const accents = new Map<string, string>();
  for (const slice of grid.expenseShares) {
    if (!slice.isGroup) continue;
    const accent = GROUP_ACCENTS[accents.size];
    if (accent !== undefined) accents.set(slice.name, accent);
  }
  return accents;
}

export function ExpenseShares({ grid }: { grid: YearGrid }) {
  const whole = grid.expenses.total.aggregate.total;
  const slices = paint(grid.expenseShares, groupColours(grid));

  if (slices.length === 0) {
    return (
      <section className="rounded-card bg-surface shadow-card p-5">
        <Heading whole={null} />
        <p className="mt-2 text-stone-600">אין הוצאות רשומות בשנה הזו, ואין מה לפלח.</p>
      </section>
    );
  }

  return (
    <section className="rounded-card bg-surface shadow-card p-4 sm:p-5">
      <Heading whole={format(whole, { withMinorUnits: false })} />

      <div className="mt-4 flex flex-col items-center gap-5 sm:flex-row sm:items-start sm:gap-7">
        <Ring slices={slices} />
        <Ranked slices={slices} />
      </div>
    </section>
  );
}

function Heading({ whole }: { whole: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="title text-[15px] font-semibold">לאן הלך הכסף</h2>
      {whole === null ? null : (
        <p className="text-[13px] text-stone-500">
          סך ההוצאות <bdi className="tabular font-medium text-stone-700">{whole}</bdi>
        </p>
      )}
    </div>
  );
}

/** Each slice's colour: a Group's accent, or its place in the ranked ramp. */
function paint(
  slices: readonly ShareSlice[],
  accents: ReadonlyMap<string, string>,
): readonly PaintedSlice[] {
  let rank = 0;
  return slices.map((slice) => {
    const accent = slice.isGroup ? accents.get(slice.name) : undefined;
    if (accent !== undefined) return { ...slice, colour: accent };
    const colour = RANK_RAMP[Math.min(rank, RANK_RAMP.length - 1)] ?? RANK_RAMP[0];
    rank += 1;
    return { ...slice, colour };
  });
}

/**
 * The ring. Drawn as arcs on one circle rather than as filled wedges, so the
 * hole in the middle is a hole and not a white disc painted over the drawing —
 * which matters the moment anything behind it is not white.
 */
function Ring({ slices }: { slices: readonly PaintedSlice[] }) {
  const centre = SIZE / 2;
  let turned = -90;

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="h-40 w-40 shrink-0"
      role="img"
      aria-label="פילוח ההוצאות לפי קטגוריה. הפירוט המלא בטבלה שלצד התרשים."
    >
      <circle cx={centre} cy={centre} r={RADIUS} fill="none" stroke="var(--color-sunken)" strokeWidth={THICKNESS} />

      {slices.map((slice) => {
        const share = slice.share ?? 0;
        const sweep = share * 360;
        // A sliver still has to be visible, and a wedge cannot be given a gap
        // wider than itself or it would draw backwards.
        const drawn = Math.max(0.6, sweep - Math.min(WEDGE_GAP, sweep / 2));
        const from = turned;
        turned += sweep;
        if (share <= 0) return null;

        return (
          <path
            key={slice.key}
            d={arc(centre, RADIUS, from, from + drawn)}
            fill="none"
            stroke={slice.colour}
            strokeWidth={THICKNESS}
          >
            <title>{`${slice.name}: ${percent(slice.share)}`}</title>
          </path>
        );
      })}
    </svg>
  );
}

/** One arc of the ring, as an SVG path. Angles in degrees, clockwise from the top. */
function arc(centre: number, radius: number, from: number, to: number): string {
  const point = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return `${centre + radius * Math.cos(radians)} ${centre + radius * Math.sin(radians)}`;
  };
  const large = to - from > 180 ? 1 : 0;
  return `M ${point(from)} A ${radius} ${radius} 0 ${large} 1 ${point(to)}`;
}

function percent(share: number | null): string {
  if (share === null) return "—";
  const rounded = Math.round(share * 1000) / 10;
  return `${rounded < 0.1 ? "<0.1" : rounded}%`;
}

/**
 * Every part, largest first, with its share and its figure.
 *
 * This is where the chart is actually read. A Group opens onto the lines
 * underneath it, so "what is in חשבונות" is answered here rather than by going
 * back to the table and adding six rows up by hand.
 */
function Ranked({ slices }: { slices: readonly PaintedSlice[] }) {
  return (
    <ol className="w-full min-w-0 columns-1 gap-x-6 sm:columns-2 lg:columns-3">
      {slices.map((slice) => (
        <li key={slice.key} className="mb-1 break-inside-avoid">
          {slice.isGroup && slice.parts.length > 0 ? (
            <details className="rounded-md">
              <summary className="flex cursor-pointer items-baseline gap-2 rounded-md px-1.5 py-1 text-[13px] transition-colors hover:bg-sunken">
                <Row slice={slice} marker />
              </summary>
              <ul className="mb-1 ms-4 border-s border-line ps-2.5">
                {slice.parts.map((part) => (
                  <li
                    key={part.key}
                    className="flex items-baseline gap-2 py-0.5 text-xs text-stone-500"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      <bdi>{part.name}</bdi>
                    </span>
                    <bdi className="tabular">{percent(part.share)}</bdi>
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <div className="flex items-baseline gap-2 px-1.5 py-1 text-[13px]">
              <Row slice={slice} />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function Row({ slice, marker = false }: { slice: PaintedSlice; marker?: boolean }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="mt-1 h-2.5 w-2.5 shrink-0 self-start rounded-[3px]"
        style={{ backgroundColor: slice.colour }}
      />
      <span className="min-w-0 flex-1 truncate">
        <bdi>{slice.name}</bdi>
        {marker ? (
          <span aria-hidden="true" className="ms-1 text-stone-400">
            ▾
          </span>
        ) : null}
      </span>
      <bdi className="tabular font-medium">{percent(slice.share)}</bdi>
      <bdi className="tabular w-20 text-end text-stone-500">
        {format(slice.total, { withSymbol: false, withMinorUnits: false })}
      </bdi>
    </>
  );
}
